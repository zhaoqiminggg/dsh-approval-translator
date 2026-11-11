/**
 * 审批翻译官 · Host 半（跑在后台的那一半）
 *
 * 职责只有一件事：界面上的「解释这条操作」按钮被点下时，
 * 收到一条待审批操作的标识，去会话记录里把那次工具调用的真实参数翻出来，
 * 让模型翻成大白话，再把结果交回界面。
 *
 * 为什么走「命令」这条路：DSH 的界面（Client）没有直接调用后台（Host）的能力，
 * 官方留的通道是「会话命令」——界面执行一条 `/命令名 {JSON}`，
 * 后台的 handler 直接跑，不经过模型、不打断对话。
 *
 * 三个必须守住的边界：
 * 1. 只读：这里不执行任何被解释的操作，只读会话日志。
 * 2. 不打乱对话：命令不写入用户可见的指令行（recordInput: false，界面侧再隐藏）。
 * 3. 不花钱不耗时：只有用户点按钮才调用模型，同一条操作解释过一次就复用。
 */

export const name = 'dsh-approval-translator'

// commands：注册后台命令；llm：用当前会话正在用的那个模型来生成解释。
export const inject = ['commands', 'llm']

/** 界面与后台之间的内部命令名。 */
const COMMAND = 'dsh-approval-translator-explain'

/** 原始参数最多带多少字进模型（防止一条巨型 JSON 撑爆 prompt）。 */
const MAX_ARGS_CHARS = 6000
/** 用户当时那句话最多带多少字进模型。 */
const MAX_ASK_CHARS = 600
/** 解释很短，但思考过程也要地方，留 2000 足够又不至于太慢。 */
const MAX_OUTPUT_TOKENS = 2000
/** 单次请求最多等多久（空了会自动再来一次，所以总时长最多两倍）。 */
const TIMEOUT_MS = 45_000
/** 解释结果的内存缓存条数（同一个 callId 不重复花钱）。 */
const CACHE_LIMIT = 60

const SYSTEM_PROMPT = `你在给一位「编程零基础、英文不好」的普通用户解释一条电脑操作。

她刚刚在软件里看到弹窗：AI 想在她电脑上做一件事，问她同不同意。
她完全看不懂里面那串东西（命令、路径、JSON 参数），所以来问你。
她不懂这些词：命令行、脚本、路径、目录、数据库、JSON、正则、API、进程。
她理解的是生活里的说法，比如「文件夹」「某个软件的设置」。

你要做的：把这条操作翻译成她听得懂的话，让她能判断「允许还是拒绝」。

硬性要求：
1. 全部用简体中文。不要出现英文单词和编程术语；确实无法回避时（例如软件名），用「某个名字（一个什么软件）」的形式顺带解释一句。
2. 只根据给你的信息解释，不许编造。参数里看不出来的，就直说「这一点看不出来」。
3. 必须讲到这四件事：这条操作想干什么；会碰到哪些文件或哪个软件（把长长的电脑路径翻译成「哪个软件的什么东西」）；会不会修改、删除、新建文件，会不会把内容发到网上；有没有隐私风险（账号、密码、聊天记录、照片、账号数据等）。
4. 语气像家里人给你解释，不像说明书。不吓唬人，也不轻描淡写。
5. bullets 一共 3 到 5 条，每条不超过 60 个字，一条只说一件事，不要编号。
6. risk 只能是「低」「中」「高」其中之一。
7. advice 只能是「建议允许」「建议拒绝」「看你要不要」其中之一。
8. 只输出一个 JSON 对象，不要多余的文字，不要用代码块包起来。

JSON 结构：
{"headline":"这条操作想干什么，24 字以内","bullets":["第一条","第二条","第三条"],"risk":"低","advice":"建议允许","adviceReason":"为什么这么建议，40 字以内"}`

/**
 * 把内部命令从「斜杠命令」列表里藏起来，避免用户和 Agent 看到一堆用不上的命令。
 * 做法与社区里已上线的插件一致：给 commands.list 套一层过滤，卸载时还原。
 */
function hideInternalCommands(commands, names) {
  const descriptor = Object.getOwnPropertyDescriptor(commands, 'list')
  const original = commands.list
  if (typeof original !== 'function') return () => {}

  let active = true
  const filtered = function (agent) {
    const rows = original.call(this, agent)
    return active ? Object.freeze(rows.filter((row) => !names.has(row.name))) : rows
  }
  Object.defineProperty(commands, 'list', { configurable: true, writable: true, value: filtered })

  return () => {
    active = false
    if (Object.getOwnPropertyDescriptor(commands, 'list')?.value !== filtered) return
    if (descriptor) Object.defineProperty(commands, 'list', descriptor)
    else Reflect.deleteProperty(commands, 'list')
  }
}

/** 解析界面传来的 JSON 参数。 */
function parseRequest(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function trimText(value, max) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n……（后面还有 ${text.length - max} 个字，已省略）`
}

/**
 * 从会话日志里找出这次审批对应的工具调用。
 * 有 callId 时只认精确匹配——宁可这次解释不出来，也不能把另一次调用的参数当成这条解释；
 * 只有调用方没给 callId 时，才退而求其次：同名工具优先，其次最近一次工具调用。
 */
function findToolCall(sessions, sessionId, callId, toolName) {
  if (!sessions || !sessionId) return undefined
  let session
  try {
    session = sessions.get(sessionId)
  } catch {
    return undefined
  }
  if (!session || typeof session.snapshotEvents !== 'function') return undefined

  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined

  let latest
  let sameName
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== 'tool/call' || !event.data) continue
    const data = event.data
    if (callId) {
      if (data.callId === callId) return data
      continue
    }
    if (!latest) latest = data
    if (!sameName && (!toolName || data.name === toolName)) sameName = data
  }
  return callId ? undefined : sameName || latest
}

/** 取最近一条真人用户消息，给模型一点上下文（AI 当时在做什么）。 */
function findLastUserAsk(sessions, sessionId) {
  if (!sessions || !sessionId) return ''
  let session
  try {
    session = sessions.get(sessionId)
  } catch {
    return ''
  }
  if (!session || typeof session.snapshotEvents !== 'function') return ''
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return ''
  }
  if (!Array.isArray(events)) return ''

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== 'user/message' || !event.data) continue
    const message = event.data.message ?? event.data
    const text = messageText(message)
    if (text) return trimText(text, MAX_ASK_CHARS)
  }
  return ''
}

/** 消息里的文字可能有多种存法，这里尽量稳妥地取出来。 */
function messageText(message) {
  if (!message) return ''
  if (typeof message.text === 'string' && message.text.trim()) return message.text.trim()
  const blocks = Array.isArray(message.content) ? message.content : Array.isArray(message.blocks) ? message.blocks : []
  const parts = []
  for (const block of blocks) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 当前会话正在用的模型；拿不到就让调用失败，界面会显示原因。 */
function resolveModelRoute(agent) {
  try {
    const config = agent?.session?.requestHeader?.()?.config
    if (
      config &&
      typeof config.provider === 'string' &&
      config.provider &&
      typeof config.model === 'string' &&
      config.model
    ) {
      return { provider: config.provider, model: config.model }
    }
  } catch {
    /* 读不到就往下走 */
  }
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  if (typeof provider === 'string' && provider && typeof model === 'string' && model) {
    return { provider, model }
  }
  return undefined
}

/** 带超时的取消信号：模型卡住时不要让按钮一直转圈。 */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('timeout'))
  }, timeoutMs)
  if (timer && typeof timer.unref === 'function') timer.unref()

  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose() {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * 调一次模型，拿回纯文本。
 *
 * 为什么不是简简单单 `for await (text-delta)`：
 * 有些模型是「先想很久再说话」的，思考过程会吃掉输出额度；额度用光时，
 * 一个字正文都不会有——用户看到的就是「模型没有返回内容」。
 * 所以这里做三件事：
 *   1. 用 prepareCall 把「思考强度」压到该模型支持的最低档；
 *   2. 既收流式文字，也收块结束时给的完整文字（不同适配器给法不同）；
 *   3. 真的空了就自动重试一次，两次都空才报错，并且在报错里说清原因。
 */
async function streamOnce({ llm, route, prompt, signal }) {
  const guard = withTimeout(signal, TIMEOUT_MS)
  let deltaText = ''
  let reasoningText = ''
  const blockTexts = new Map()
  let finish
  let chunkCount = 0
  try {
    let call
    if (typeof llm.prepareCall === 'function') {
      try {
        call = await llm.prepareCall(
          { provider: route.provider, model: route.model, maxTokens: MAX_OUTPUT_TOKENS },
          guard.signal,
          (controls, model) => {
            // 取模型支持的最低一档思考强度：解释这种小事不需要长时间思考。
            const effort = model && model.reasoning && model.reasoning.efforts
              ? model.reasoning.efforts[0] && model.reasoning.efforts[0].id
              : undefined
            return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
          }
        )
      } catch {
        call = undefined
      }
    }

    const base = call && call.config ? call.config : { provider: route.provider, model: route.model }
    const options = {
      ...base,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: base.maxTokens ?? MAX_OUTPUT_TOKENS,
      signal: guard.signal,
    }
    if (!call) options.temperature = 0.2

    const stream = call ? call.stream(options) : llm.stream(options)
    for await (const chunk of stream) {
      chunkCount += 1
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        deltaText += chunk.text
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        reasoningText += chunk.text
      } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
        if (typeof chunk.block.text === 'string') blockTexts.set(chunk.index ?? blockTexts.size, chunk.block.text)
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      }
    }
  } catch (error) {
    if (guard.didTimeout()) throw new Error(`模型超过 ${Math.round(TIMEOUT_MS / 1000)} 秒没有回应`)
    if (signal?.aborted) throw new Error('已经取消')
    throw new Error(`模型调用失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    guard.dispose()
  }

  if (guard.didTimeout()) throw new Error(`模型超过 ${Math.round(TIMEOUT_MS / 1000)} 秒没有回应`)
  if (finish && finish.kind === 'error') {
    throw new Error(`模型调用失败：${finish.failure?.message || '未知原因'}`)
  }
  if (finish && finish.kind === 'aborted') throw new Error('已经取消')

  // 块文本优先（最完整），没有块文本才用流式增量拼。
  const text = blockTexts.size > 0
    ? [...blockTexts.keys()].sort((a, b) => a - b).map((key) => blockTexts.get(key)).join('')
    : deltaText

  return {
    text: text.trim(),
    reasoning: reasoningText.trim(),
    finish: finish && finish.kind ? finish.kind : 'none',
    chunkCount,
  }
}

/** 空回复时说人话。 */
function emptyReplyMessage(result) {
  if (result.finish === 'max-tokens') {
    return '模型这次把额度都用在思考上了，没写出正文'
  }
  if (result.chunkCount === 0) {
    return '模型这次没有返回任何内容'
  }
  return '模型这次没有写出正文'
}

async function streamModel({ llm, agent, prompt, signal }) {
  const route = resolveModelRoute(agent)
  if (!route) throw new Error('读不到当前会话使用的模型，暂时没法解释')
  if (!llm || typeof llm.stream !== 'function') throw new Error('当前环境没有可用的模型服务，暂时没法解释')

  let lastResult
  let lastFailure
  // 空回复重试一次；真正的调用失败也重试一次（网络抖动很常见）。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) throw new Error('已经取消')
    try {
      const result = await streamOnce({ llm, route, prompt, signal })
      lastResult = result
      lastFailure = undefined
      if (result.text) return { text: result.text, route }
      // 正文空、但思考过程里可能已经想出了 JSON，交给上层的解析器兜底。
      if (result.reasoning) {
        const extracted = tryExtractJson(result.reasoning)
        if (extracted) return { text: extracted, route }
      }
    } catch (error) {
      lastFailure = error
      if (signal?.aborted) throw new Error('已经取消')
      // 只有「调用本身失败」（网络抖动、服务端 5xx）才值得再试一次；
      // 超时已经让用户等够久了，直接报错。
      const message = error && error.message ? error.message : ''
      if (!message.startsWith('模型调用失败')) throw error
    }
  }

  if (lastFailure) throw lastFailure
  const reason = lastResult ? emptyReplyMessage(lastResult) : '模型没有返回内容'
  throw new Error(`${reason}（已自动重试一次），请再点一次`)
}

/** 从一段文字里抠出第一个像 JSON 对象的片段。 */
function tryExtractJson(text) {
  const body = String(text ?? '')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  const candidate = body.slice(start, end + 1)
  try {
    const value = JSON.parse(candidate)
    return value && typeof value === 'object' && !Array.isArray(value) ? candidate : undefined
  } catch {
    return undefined
  }
}

/** 模型的回答要当 JSON 解析，但经常裹一层代码块或前缀，这里做容错。 */
function parseModelResult(text) {
  let body = String(text ?? '').trim()
  body = body.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型返回的格式看不懂，请再点一次')
  let value
  try {
    value = JSON.parse(body.slice(start, end + 1))
  } catch {
    throw new Error('模型返回的格式看不懂，请再点一次')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型返回的格式看不懂，请再点一次')
  }

  const headline = typeof value.headline === 'string' ? value.headline.trim().slice(0, 60) : ''
  const bullets = (Array.isArray(value.bullets) ? value.bullets : [])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 6)
    .map((item) => item.slice(0, 200))
  if (!headline && bullets.length === 0) throw new Error('模型没给出可用的解释，请再点一次')

  const risks = new Set(['低', '中', '高'])
  const advices = new Set(['建议允许', '建议拒绝', '看你要不要'])
  return {
    headline: headline || '这条操作需要你判断',
    bullets,
    risk: risks.has(value.risk) ? value.risk : '中',
    advice: advices.has(value.advice) ? value.advice : '看你要不要',
    adviceReason: typeof value.adviceReason === 'string' ? value.adviceReason.trim().slice(0, 120) : '',
  }
}

function buildPrompt({ toolName, title, args, ask }) {
  const lines = [
    `工具名称：${toolName || '未知工具'}`,
    `弹窗标题：${title || '（没有提供）'}`,
    '操作的原始内容（给电脑看的，可能很长）：',
    args ? trimText(args, MAX_ARGS_CHARS) : '（这次没有拿到原始参数，只能根据工具名和标题判断）',
  ]
  if (ask) {
    lines.push('', '用户当时交代 AI 要做的事情：', ask)
  }
  lines.push('', '请按要求只输出那个 JSON 对象。')
  return lines.join('\n')
}

export function apply(ctx) {
  const llm = ctx.get('llm') || ctx.llm
  const commands = ctx.commands
  const sessions = ctx.get('sessions')
  const lifetime = new AbortController()
  const cache = new Map()

  ctx.effect(() => () => {
    try {
      lifetime.abort()
    } catch {
      /* 卸载时的清理 */
    }
  })

  ctx.effect(() => hideInternalCommands(commands, new Set([COMMAND])))

  const remember = (key, value) => {
    if (!key) return
    cache.set(key, value)
    while (cache.size > CACHE_LIMIT) {
      const first = cache.keys().next()
      if (first.done) break
      cache.delete(first.value)
    }
  }

  const explain = async (invocation) => {
    const request = parseRequest(invocation.rawInput)
    const sessionId = invocation.agent?.id
    const callId = typeof request.callId === 'string' ? request.callId : undefined

    if (callId) {
      const cached = cache.get(callId)
      if (cached) return { kind: 'success', text: JSON.stringify({ ok: true, ...cached }) }
    }

    const call = findToolCall(sessions, sessionId, callId, request.toolName)
    const toolName = (call && typeof call.name === 'string' && call.name) || request.toolName || ''
    const args =
      (call && typeof call.arguments === 'string' && call.arguments) ||
      (typeof request.argsRaw === 'string' ? request.argsRaw : '')
    if (!toolName && !args) {
      return { kind: 'error', text: '拿不到这条操作的具体内容，没法解释' }
    }

    const signal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([invocation.signal, lifetime.signal])
        : invocation.signal

    const prompt = buildPrompt({
      toolName,
      title: typeof request.title === 'string' ? request.title : '',
      args,
      ask: findLastUserAsk(sessions, sessionId),
    })

    try {
      const { text } = await streamModel({ llm, agent: invocation.agent, prompt, signal })
      const payload = parseModelResult(text)
      remember(callId, payload)
      return { kind: 'success', text: JSON.stringify({ ok: true, ...payload }) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: message }
    }
  }

  ctx.effect(() =>
    commands.register({
      name: COMMAND,
      description: '内部命令：把一条等待批准的电脑操作翻成大白话（审批弹窗里的「解释」按钮使用）',
      recordInput: false,
      handler: explain,
    })
  )
}
