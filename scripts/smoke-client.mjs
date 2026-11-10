// 离线冒烟测试（Client 半）：不启动浏览器，用假 React + 假 ctx 走一遍渲染逻辑。
import { readFileSync } from 'node:fs'

const clientPath = new URL('../client.js', import.meta.url)
readFileSync(clientPath, 'utf8')

// ---- 迷你 React ----
const hookStates = []
let hookIndex = 0
const FakeReact = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    const merged = { ...(props ?? {}) }
    if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
    return { type, props: merged, children: flat }
  },
  useState(init) {
    const index = hookIndex++
    if (!(index in hookStates)) hookStates[index] = typeof init === 'function' ? init() : init
    return [hookStates[index], (value) => { hookStates[index] = value }]
  },
  useMemo(fn) { return fn() },
  useRef(value) {
    const index = hookIndex++
    if (!(index in hookStates)) hookStates[index] = { current: value }
    return hookStates[index]
  },
  useEffect() {},
  Component: class {
    constructor(props) { this.props = props; this.state = {} }
  },
}

// ---- 假 window.module loader ----
let definition
globalThis.window = { __ModuleLoader__: { load(def) { definition = def } } }

await import(clientPath.href)
if (!definition) throw new Error('client.js 没有调用 __ModuleLoader__.load')

const moduleExports = definition.factory((id) => {
  if (id === 'react') return FakeReact
  throw new Error('unexpected require: ' + id)
})

// ---- 假 ctx ----
const registered = []
const zhDict = {}
const commandCalls = []
const ctx = {
  effect(fn) { const cleanup = fn(); return () => { if (typeof cleanup === 'function') cleanup() } },
  locale: {
    register(ns, dicts) { Object.assign(zhDict, dicts.zh); return () => {} },
    bind() {
      return (key, params) => {
        const raw = zhDict[key] ?? key
        return params ? raw.replace(/\{(\w+)\}/g, (m, k) => params[k] ?? m) : raw
      }
    },
    resolveText(text) { return typeof text === 'string' ? text : (text && (text.zh || text.en)) || undefined },
  },
  get(name) {
    if (name === 'remote') {
      return {
        commands: {
          async execute(sessionId, line) {
            commandCalls.push(line)
            return {
              ok: true,
              value: {
                result: {
                  kind: 'success',
                  text: JSON.stringify({
                    ok: true,
                    headline: '在找一个软件的数据文件夹有多大',
                    bullets: ['会在某个软件的数据文件夹里找文件', '只统计大小，不会打开内容', '不会改动或删除任何东西'],
                    risk: '低',
                    advice: '建议允许',
                    adviceReason: '只是看看谁占地方',
                  }),
                },
              },
            }
          },
        },
      }
    }
    return undefined
  },
  slots: {
    inject(key, callback) { callback(); return () => {} },
    register(options, component) { registered.push({ options, component }); return () => {} },
  },
}

moduleExports.apply(ctx, {})
console.log('registered slots:', registered.map((r) => `${r.options.name} priority=${r.options.priority ?? '-'}`))

const composer = registered.find((r) => r.options.name === 'conversation.composer')
if (!composer) throw new Error('没有注册 conversation.composer')

const pendingApproval = {
  kind: 'approval',
  key: 'approval:1',
  callId: 'call_abc',
  toolName: 'Shell',
  answerable: true,
  answer: (outcome) => console.log('  answer ->', outcome),
}
const select = composer.options.select
console.log('select(approval) =>', select({ pendingInteraction: pendingApproval }) === pendingApproval ? 'matched ✓' : 'null ✗')
console.log('select(question) =>', select({ pendingInteraction: { kind: 'question' } }) === null ? 'null ✓' : 'unexpected ✗')
console.log('select(undefined) =>', select({ pendingInteraction: undefined }) === null ? 'null ✓' : 'unexpected ✗')

// ---- 渲染：把函数组件/类组件展开成一棵可读的树 ----
function expand(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(expand).filter((n) => n !== null)
  if (!node || typeof node !== 'object') return null
  const { type, props, children } = node
  if (type === 'official-card') return { type: 'official-card', props, children: [] }
  if (typeof type === 'function') {
    const isClass = type.prototype && typeof type.prototype.render === 'function'
    if (isClass) {
      const instance = new type(props)
      return expand(instance.render())
    }
    return expand(type({ ...props, children }))
  }
  const expandedChildren = (children ?? []).map(expand).filter((n) => n !== null)
  const propChildren =
    (!children || children.length === 0) && props && props.children !== undefined ? expand(props.children) : null
  return { type, props, children: expandedChildren.length ? expandedChildren : propChildren ? [propChildren].flat() : [] }
}

function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { node.forEach((child) => collectText(child, out)); return out }
  if (node.type === 'official-card') {
    out.push(`[官方卡片 title="${node.props.title}" callId=${node.props.callId}]`)
    return out
  }
  collectText(node.children, out)
  return out
}

function findButtons(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { node.forEach((child) => findButtons(child, out)); return out }
  if (typeof node !== 'object') return out
  if (node.type === 'button') out.push({ node, label: collectText(node.children).join('') })
  findButtons(node.children, out)
  return out
}

const props = {
  matched: pendingApproval,
  sessionId: 'session-1',
  useChat: (selector) =>
    selector({
      nodes: new Map([
        ['n1', {
          kind: 'tool-call',
          data: { root: { callId: 'call_abc', phase: 'start', argsRaw: '{"command":"find /c/Users/you/AppData/Roaming/SomeApp -maxdepth 4"}' } },
        }],
      ]),
    }),
  renderFactorySlot: (name, input) => ({ type: 'official-card', props: input, children: [] }),
  renderSlot: () => null,
}

hookIndex = 0
hookStates.length = 0
const tree = expand(composer.component(props))
console.log('\n--- 初始渲染 ---')
console.log(collectText(tree).join(' | '))
const buttons = findButtons(tree)
console.log('按钮：', buttons.map((b) => b.label).join(' / '))

const explainButton = buttons.find((b) => b.label.includes('解释这条操作'))
if (!explainButton) throw new Error('没找到「解释这条操作」按钮')

// ---- 点「解释」----
await explainButton.node.props.onClick()
console.log('\n命令调用：', commandCalls[0]?.slice(0, 120), '…')

hookIndex = 0
const tree2 = expand(composer.component(props))
console.log('\n--- 点击后渲染 ---')
console.log(collectText(tree2).join(' | '))
console.log('按钮：', findButtons(tree2).map((b) => b.label).join(' / '))
