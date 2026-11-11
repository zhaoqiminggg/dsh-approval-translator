/**
 * 审批翻译官 · Client 半（跑在页面上的那一半）
 *
 * 它做的事：当 DSH 弹出一条「要不要允许」的审批卡片时，在卡片正下方加一行
 * 「解释这条操作」。点一下 → 把这条操作的原始参数交给后台 → 后台让模型翻成
 * 大白话 → 结果展开在这里。
 *
 * 为什么不自己重画整张卡片：卡片本身（拒绝 / 允许一次、回车同意、Esc 拒绝、
 * 焦点与无障碍）是 DSH 官方组件，重画会把风险转嫁给用户。
 * 这里用 DSH 的「工厂插槽」把官方卡片原样渲染出来，只在它下面追加内容，
 * 所以官方卡片的任何行为都不会被改动。
 *
 * 为什么占的是「输入框位置」（conversation.composer）：DSH 的审批卡片就是
 * 通过替换输入框那一块来显示自己，官方用的是同一条通道。选框按顺序试，
 * 前一个匹配到就用它——我们排在「需要回答的问题」后面、官方审批卡片前面，
 * 因此只在「待审批」这一种情况下接管，其他情况原样放行。
 */

window.__ModuleLoader__.load({
  id: 'dsh-approval-translator',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const reactModule = require('react')
    const React =
      reactModule && typeof reactModule.createElement === 'function'
        ? reactModule
        : (reactModule && reactModule.default) || reactModule
    const h = React.createElement

    const NS = 'approval-explainer'
    const COMMAND = 'dsh-approval-translator-explain'
    const STYLE_TAG = 'dsh-approval-translator/Explain.css'
    /** 已解释过的操作缓存，切换/重渲染时不重复调用模型。 */
    const RESULT_CACHE = new Map()
    const RESULT_CACHE_LIMIT = 40

    /** 记住一条解释结果，超出上限就丢掉最早的。 */
    function rememberResult(callId, data) {
      if (!callId) return
      RESULT_CACHE.set(callId, data)
      while (RESULT_CACHE.size > RESULT_CACHE_LIMIT) {
        const first = RESULT_CACHE.keys().next()
        if (first.done) break
        RESULT_CACHE.delete(first.value)
      }
    }

    const zh = {
      'ui.explain': '解释这条操作',
      'ui.explaining': '正在解释…',
      'ui.retry': '重新解释',
      'ui.title': '这条操作在做什么',
      'ui.riskLabel': '风险：{level}',
      'ui.reject': '拒绝',
      'ui.allowOnce': '允许一次',
      'risk.低': '低',
      'risk.中': '中',
      'risk.高': '高',
      'escalation': '工具 {toolName} 请求执行一个需要你同意的操作',
      'error.backend': '后台暂时连不上，没法解释',
      'error.empty': '这条操作没有可解释的内容',
    }

    const en = {
      'ui.explain': 'Explain this action',
      'ui.explaining': 'Explaining…',
      'ui.retry': 'Explain again',
      'ui.title': 'What this action does',
      'ui.riskLabel': 'Risk: {level}',
      'ui.reject': 'Reject',
      'ui.allowOnce': 'Allow once',
      'risk.低': 'Low',
      'risk.中': 'Medium',
      'risk.高': 'High',
      'escalation': 'Tool {toolName} asks to run an action you must approve',
      'error.backend': 'The background service is unreachable, so this cannot be explained',
      'error.empty': 'This action has nothing to explain',
    }

    const css = `
.ae_root{display:flex;flex-direction:column;align-items:stretch;padding-bottom:2px}
.ae_footer{box-sizing:border-box;width:100%;display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 calc(var(--dsh-composer-side-clearance,0px) + 16px) 12px}
.ae_rail{width:100%;max-width:var(--dsh-chat-content-width,780px);display:flex;align-items:center;gap:8px;min-height:28px}
.ae_explain{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,#e3e3e3);background:transparent;color:var(--dsw-alias-label-secondary,#6b6b6b);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background-color .12s,border-color .12s,color .12s}
.ae_explain:disabled{cursor:default;opacity:.7}
@media (hover:hover){.ae_explain:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.045));color:var(--dsw-alias-label-primary,#1a1a1a);border-color:var(--dsw-alias-border-l2,#d0d0d0)}}
.ae_explain:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
.ae_explainGlyph{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none}
.ae_dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:ae-pulse 1s ease-in-out infinite alternate}
@keyframes ae-pulse{0%{opacity:.25}100%{opacity:1}}
.ae_spacer{flex:1 1 auto}
.ae_panel{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,780px);border:1px solid var(--dsw-alias-border-l1,#e8e8e8);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1,#fff);padding:12px 14px;color:var(--dsw-alias-label-secondary,#5c5c5c);font-size:13px;line-height:20px;max-height:280px;overflow-y:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.16))}
.ae_panelHead{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-primary,#1a1a1a);font-size:14px;font-weight:500;line-height:22px}
.ae_panelHeadGlyph{flex:none;margin-top:2px;color:var(--dsw-alias-state-warn-primary,#c27c0e)}
.ae_list{margin:8px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:6px}
.ae_list li{list-style:disc}
.ae_meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l1,#ececec)}
.ae_badge{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;background:var(--dsw-alias-bg-layer-2,#f4f4f4)}
.ae_badge_low{color:var(--dsw-alias-state-success-primary,#12924f)}
.ae_badge_mid{color:var(--dsw-alias-state-warn-primary,#c27c0e)}
.ae_badge_high{color:var(--dsw-alias-state-error-primary,#d92d20)}
.ae_advice{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#1a1a1a)}
.ae_reason{font-size:12px;color:var(--dsw-alias-label-caption,#8a8a8a)}
.ae_error{display:flex;align-items:flex-start;gap:8px;border-color:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-state-error-primary,#d92d20)}
.ae_errorText{flex:1 1 auto;word-break:break-word}
.ae_link{background:none;border:none;padding:0;color:var(--dsw-alias-brand-primary,#4d6bfe);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;flex:none}
.ae_fallback{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width,780px);margin:8px auto 0;border:1px solid var(--dsw-alias-state-warn-primary,#c27c0e);border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-specific-input-major,#fff);padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.ae_fallbackTitle{font-size:15px;line-height:24px;color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:500}
.ae_fallbackActions{display:flex;justify-content:flex-end;gap:8px}
.ae_btn{height:32px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);font:inherit;font-size:13px;cursor:pointer;border:1px solid transparent}
.ae_btnGhost{background:transparent;border-color:var(--dsw-alias-border-l2,#dcdcdc);color:var(--dsw-alias-label-primary,#1a1a1a)}
.ae_btnSolid{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
`

    /** 只在页面上出现一次样式表；插件卸载时移除。 */
    function mountStyle() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`)
      if (existing) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-approval-translator'
      tag.dataset.pluginCss = STYLE_TAG
      tag.textContent = css
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    /** 图标：一个问号泡泡，大小跟随字号。 */
    function ExplainGlyph() {
      return h(
        'span',
        { className: 'ae_explainGlyph', 'aria-hidden': 'true' },
        h(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none' },
          h('path', {
            d: 'M8 1.75c3.45 0 6.25 2.4 6.25 5.36 0 2.96-2.8 5.36-6.25 5.36-.6 0-1.18-.07-1.72-.2l-2.4 1.34a.4.4 0 0 1-.58-.44l.42-2.02C2.29 9.98 1.75 8.6 1.75 7.11 1.75 4.15 4.55 1.75 8 1.75Z',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinejoin: 'round',
          }),
          h('path', {
            d: 'M8 9.4V9c0-.62.42-.95.83-1.27.36-.28.67-.6.67-1.16C9.5 5.7 8.9 5.2 8 5.2c-.78 0-1.33.4-1.5 1.08',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
          }),
          h('circle', { cx: 8, cy: 11.35, r: 0.7, fill: 'currentColor' })
        )
      )
    }

    /** 从对话快照里按 callId 找到那次工具调用的原始参数。 */
    function selectArgs(callId) {
      return (snapshot) => {
        if (!callId || !snapshot || !snapshot.nodes || typeof snapshot.nodes.values !== 'function') {
          return undefined
        }
        for (const node of snapshot.nodes.values()) {
          const root = node && node.kind === 'tool-call' ? node.data && node.data.root : undefined
          if (!root || root.callId !== callId) continue
          if ('kind' in root) continue
          if (root.phase !== 'start') continue
          return typeof root.argsRaw === 'string' ? root.argsRaw : undefined
        }
        return undefined
      }
    }

    /** 后台返回的结果校验一遍，避免脏数据把界面搞崩。 */
    function normalizeResult(value) {
      if (!value || typeof value !== 'object') return undefined
      const bullets = Array.isArray(value.bullets)
        ? value.bullets.filter((item) => typeof item === 'string' && item.trim()).slice(0, 6)
        : []
      const headline = typeof value.headline === 'string' ? value.headline : ''
      if (!headline && bullets.length === 0) return undefined
      return {
        headline,
        bullets,
        risk: value.risk === '低' || value.risk === '高' ? value.risk : '中',
        advice: typeof value.advice === 'string' ? value.advice : '',
        adviceReason: typeof value.adviceReason === 'string' ? value.adviceReason : '',
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }))
      ctx.effect(() => mountStyle())

      const t = ctx.locale.bind(NS)

      const resolveTitle = (props, approval) => {
        const reason = approval && approval.displayReason
        if (reason !== undefined) {
          try {
            const resolved = props.resolveReason ? props.resolveReason(reason) : undefined
            if (typeof resolved === 'string' && resolved.trim()) return resolved
          } catch {
            /* 解析失败就用兜底文案 */
          }
        }
        const toolName = approval && approval.toolName ? approval.toolName : ''
        return t('escalation', { toolName })
      }

      /**
       * 兜底卡片：只有在官方卡片渲染不出来时才出现，
       * 目的只有一个——别让用户卡在「没法批准也没法拒绝」的死角。
       */
      const FallbackCard = ({ title, approval }) =>
        h(
          'div',
          { className: 'ae_fallback' },
          h('div', { className: 'ae_fallbackTitle' }, title),
          h(
            'div',
            { className: 'ae_fallbackActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'ae_btn ae_btnGhost',
                onClick: () => approval.answer('rejected'),
              },
              t('ui.reject')
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ae_btn ae_btnSolid',
                onClick: () => approval.answer('allowed-once'),
              },
              t('ui.allowOnce')
            )
          )
        )

      /** 让「解释」这块附加内容自成一个错误边界：它坏了，官方卡片照样能用。 */
      class AddonBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        componentDidCatch(error) {
          console.error('[approval-explainer] explanation UI failed', error)
        }

        render() {
          return this.state.failed ? null : this.props.children
        }
      }

      /** 真正带状态的卡片内容；用 approval.key 当 key，换一条审批就重置。 */
      const ExplainerBody = (props) => {
        const approval = props.matched
        const sessionId = props.sessionId
        const callId = approval && typeof approval.callId === 'string' ? approval.callId : undefined
        const toolName = approval && typeof approval.toolName === 'string' ? approval.toolName : ''
        const title = resolveTitle(props, approval)

        // 契约上 useChat 一定存在；万一没有，用普通函数顶替，绝不让它把卡片带崩。
        const useChatHook = typeof props.useChat === 'function' ? props.useChat : () => undefined

        const argsRaw = useChatHook(selectArgs(callId))
        const cached = React.useMemo(
          () => (callId ? normalizeResult(RESULT_CACHE.get(callId)) : undefined),
          [callId]
        )
        const [state, setState] = React.useState(() =>
          cached ? { status: 'done', data: cached } : { status: 'idle' }
        )
        const alive = React.useRef(true)
        const running = React.useRef(null)
        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
            if (running.current) {
              try {
                running.current.abort()
              } catch {
                /* 忽略 */
              }
              running.current = null
            }
          }
        }, [])

        const runExplain = async () => {
          if (state.status === 'loading') return
          setState({ status: 'loading' })
          const controller = new AbortController()
          running.current = controller
          try {
            const remote = ctx.get('remote')
            if (!remote || !remote.commands || typeof remote.commands.execute !== 'function') {
              throw new Error(t('error.backend'))
            }
            const payload = {
              callId: callId || '',
              toolName,
              title,
              argsRaw: typeof argsRaw === 'string' ? argsRaw.slice(0, 6000) : '',
            }
            if (!payload.argsRaw && !payload.toolName) throw new Error(t('error.empty'))
            const line = `/${COMMAND} ${JSON.stringify(payload)}`
            const response = await remote.commands.execute(sessionId, line, [], controller.signal)
            if (!response || response.ok !== true) {
              const failure = (response && response.error) || {}
              throw new Error(failure.message || t('error.backend'))
            }
            const result = response.value && response.value.result
            if (!result) throw new Error(t('error.backend'))
            if (result.kind === 'error') throw new Error(result.text || t('error.backend'))
            if (result.kind !== 'success') throw new Error(t('error.backend'))
            let parsed
            try {
              parsed = JSON.parse(result.text || '{}')
            } catch {
              throw new Error(t('error.backend'))
            }
            const data = normalizeResult(parsed)
            if (!data) throw new Error(t('error.backend'))
            rememberResult(callId, data)
            if (!alive.current) return
            setState({ status: 'done', data })
          } catch (error) {
            if (controller.signal.aborted || !alive.current) return
            setState({
              status: 'error',
              message: error instanceof Error && error.message ? error.message : t('error.backend'),
            })
          } finally {
            if (running.current === controller) running.current = null
          }
        }

        const loading = state.status === 'loading'
        const data = state.status === 'done' ? state.data : undefined

        // 官方审批卡片原样交给 DSH 渲染：按钮、回车/Esc、无障碍全部保持不变。
        // 万一这一步出错，就自己画一个最小可用的卡片，保证用户还能做出决定。
        let card = null
        try {
          if (typeof props.renderFactorySlot === 'function') {
            card = props.renderFactorySlot('conversation.approval.card', {
              requestKey: approval.key,
              title,
              ...(callId ? { callId } : {}),
              canAnswer: () => Boolean(approval.answerable),
              onAllow: () => approval.answer('allowed-once'),
              onReject: () => approval.answer('rejected'),
            })
          }
        } catch (error) {
          console.error('[approval-explainer] cannot render the shipped approval card', error)
          card = null
        }
        if (card === null || card === undefined) {
          card = h(AddonBoundary, null, h(FallbackCard, { title, approval }))
        }

        const rail = h(
          'div',
          { className: 'ae_rail' },
          h(
            'button',
            {
              type: 'button',
              className: 'ae_explain',
              onClick: runExplain,
              disabled: loading,
              'aria-busy': loading,
            },
            loading ? h('span', { className: 'ae_dot' }) : h(ExplainGlyph),
            h('span', null, loading ? t('ui.explaining') : data ? t('ui.retry') : t('ui.explain'))
          ),
          h('span', { className: 'ae_spacer' })
        )

        const panel = data
          ? h(
              'div',
              { className: 'ae_panel', role: 'note' },
              h(
                'div',
                { className: 'ae_panelHead' },
                h('span', { className: 'ae_panelHeadGlyph', 'aria-hidden': 'true' }, h(ExplainGlyph)),
                h('span', null, data.headline || t('ui.title'))
              ),
              data.bullets.length > 0
                ? h(
                    'ul',
                    { className: 'ae_list' },
                    data.bullets.map((line, index) => h('li', { key: index }, line))
                  )
                : null,
              h(
                'div',
                { className: 'ae_meta' },
                h(
                  'span',
                  { className: `ae_badge ${riskClass(data.risk)}` },
                  t('ui.riskLabel', { level: t(`risk.${data.risk}`) })
                ),
                data.advice ? h('span', { className: 'ae_advice' }, data.advice) : null,
                data.adviceReason ? h('span', { className: 'ae_reason' }, data.adviceReason) : null
              )
            )
          : null

        const errorPanel =
          state.status === 'error'
            ? h(
                'div',
                { className: 'ae_panel ae_error', role: 'alert' },
                h('span', { className: 'ae_errorText' }, state.message),
                h(
                  'button',
                  { type: 'button', className: 'ae_link', onClick: runExplain },
                  t('ui.retry')
                )
              )
            : null

        return h(
          'div',
          { className: 'ae_root' },
          card,
          h(AddonBoundary, null, h('div', { className: 'ae_footer' }, rail, panel, errorPanel))
        )
      }

      /** 无状态的选举入口：换一条审批时用 key 重建内部状态。 */
      const ApprovalExplainer = (props) => {
        const approval = props.matched
        const key = approval && approval.key !== undefined ? String(approval.key) : 'approval'
        return h(ExplainerBody, { key, ...props })
      }

      ctx.slots.inject('conversation.composer', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer',
            // 官方：子代理只读(-10) → 待回答问题(0) → 待审批(1)。取 0.5 排在审批之前、
            // 问题之后，只接管「待审批」这一种情况。
            priority: 0.5,
            locale: NS,
            select: ({ pendingInteraction }) => {
              // 只接管官方那种「工具审批」：有 answer() 才能替用户做决定，
              // 认不出来就放行，让官方自己的卡片去处理。
              if (!pendingInteraction || pendingInteraction.kind !== 'approval') return null
              if (typeof pendingInteraction.answer !== 'function') return null
              if (typeof pendingInteraction.answerable !== 'boolean') return null
              return pendingInteraction
            },
            inject: () => ({
              resolveReason: (reason) => {
                try {
                  return ctx.locale.resolveText(reason)
                } catch {
                  return undefined
                }
              },
            }),
          },
          ApprovalExplainer
        )
      )

      // 内部命令会在会话里留下一行「指令」记录，这里替换成空渲染，用户看不到。
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register({ name: 'conversation.chat.commandview', key: COMMAND }, () => null)
      )
    }

    function riskClass(risk) {
      if (risk === '低') return 'ae_badge_low'
      if (risk === '高') return 'ae_badge_high'
      return 'ae_badge_mid'
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'remote', 'remote.commands']
    return module.exports
  },
})
