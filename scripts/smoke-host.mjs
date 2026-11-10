// 离线冒烟测试：不给 DSH，用假的 ctx / llm / sessions 直接跑 Host 半的 handler。
import { apply } from '../index.js'

const events = [
  { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '帮我看看某个软件在哪个文件夹里占地方最多' }] } } },
  {
    type: 'tool/call',
    data: {
      callId: 'call_abc',
      name: 'Shell',
      arguments: JSON.stringify({ command: 'find /c/Users/you/AppData/Roaming/SomeApp -maxdepth 4 -type f' }),
    },
  },
]

const GOOD = JSON.stringify({
  headline: '在找一个软件的数据文件夹有多大',
  bullets: ['会在某个软件的数据目录里找文件', '只统计大小，不会打开内容', '不会改动或删除任何东西'],
  risk: '低',
  advice: '建议允许',
  adviceReason: '只是看看谁占地方',
})

function makeLlm({ mode = 'stream', firstEmpty = false } = {}) {
  const stats = { attempts: 0, prepared: 0, efforts: [] }
  const attemptStream = () => {
    stats.attempts += 1
    const empty = firstEmpty && stats.attempts === 1
    return (async function* () {
      if (empty) {
        // 模拟「额度被思考吃光」：只有思考、没有正文
        yield { type: 'reasoning-delta', index: 0, text: '嗯，我要先想想这段命令……' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: GOOD.slice(0, 40) }
      yield { type: 'text-delta', index: 0, text: GOOD.slice(40) }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: GOOD } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }

  const llm = {}
  if (mode === 'stream') llm.stream = () => attemptStream()
  if (mode === 'prepared') {
    llm.stream = () => attemptStream()
    llm.prepareCall = async (config, signal, configure) => {
      stats.prepared += 1
      const model = { provider: 'deepseek', id: 'deepseek-chat', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
      const controls = configure ? configure({}, model) : {}
      stats.efforts.push(controls.reasoningEffort)
      return {
        config: { ...config, ...controls },
        stream: () => attemptStream(),
      }
    }
  }
  return { llm, stats }
}

function makeCtx(llm) {
  const handlers = new Map()
  const commands = {
    register(definition) {
      handlers.set(definition.name, definition)
      return () => handlers.delete(definition.name)
    },
    list() {
      return [...handlers.values()].map((d) => ({ name: d.name }))
    },
  }
  const sessions = {
    get(id) {
      return id === 'session-1' ? { snapshotEvents: () => events } : undefined
    },
  }
  const ctx = {
    commands,
    get(name) {
      if (name === 'llm') return llm
      if (name === 'sessions') return sessions
      return undefined
    },
    effect(fn) {
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
  return { ctx, handlers }
}

async function run({ label, mode, firstEmpty, rawInput }) {
  const { llm, stats } = makeLlm({ mode, firstEmpty })
  const { ctx, handlers } = makeCtx(llm)
  apply(ctx)
  const handler = handlers.get('dsh-approval-explainer-explain').handler
  const result = await handler({
    commandId: 'c1',
    agent: { id: 'session-1', session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }) } },
    rawInput: rawInput ?? JSON.stringify({ callId: 'call_abc', toolName: 'Shell', title: 'Shell 想要执行一个操作' }),
    attachments: [],
    signal: new AbortController().signal,
  })
  console.log(`\n[${label}]`)
  console.log('  调用次数:', stats.attempts, ' prepareCall:', stats.prepared, ' 思考档位:', stats.efforts.join(',') || '-')
  const text = String(result.text ?? '')
  if (result.kind === 'success') {
    const data = JSON.parse(text)
    console.log('  结果: OK |', data.headline, '| 要点', data.bullets.length, '条 | 风险', data.risk, '|', data.advice)
  } else {
    console.log('  结果: 错误 |', text)
  }
  return result
}

await run({ label: '1. 普通流式（没有 prepareCall）', mode: 'stream' })
await run({ label: '2. prepareCall 路径（应选最低思考档）', mode: 'prepared' })
await run({ label: '3. 第一次空回复 → 自动重试成功', mode: 'prepared', firstEmpty: true })
await run({ label: '4. 找不到对应操作（降级）', mode: 'stream', rawInput: JSON.stringify({ callId: 'nope', toolName: 'Unknown' }) })
