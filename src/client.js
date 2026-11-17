/**
 * DSH Side Chat — Client 半体。
 * 侧边面板 + 会话标题栏右侧入口按钮；1s 轮询 Host 状态；
 * openSignal 变化（/side 命令创建）时自动打开面板。
 *
 * 结构（重构后）：
 *   PANEL_CSS                —— 全部样式（主题变量，尊重 reduced-motion）
 *   createPanelStore()       —— open/minimized 状态发布订阅（toggle 与面板共享）
 *   createMarkdownRenderer() —— 轻量 Markdown 渲染（纯 React 元素，防 XSS，链接协议白名单）
 *   apply()                  —— 装配层：store → 渲染器 → 样式 → 组件 → Slot 注册
 * 本文件即动态 Cordis 插件源码：以函数体格式加载（顶层 return 插件对象）。
 */

const PANEL_CSS = `
#dsh-sidechat-toggle{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;cursor:pointer;background:none;border:none;color:var(--dsw-alias-label-secondary);font-size:14px;border-radius:8px}
#dsh-sidechat-toggle:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
#dsh-sidechat-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

#dsh-sidechat-panel{position:fixed;top:max(12px,var(--dsh-frame-overlay-top,12px));right:12px;bottom:12px;width:380px;max-width:calc(100vw - 24px);min-width:min(300px,calc(100vw - 24px));z-index:1200;pointer-events:auto;-webkit-app-region:no-drag;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);color:var(--dsw-alias-label-primary);border:0;border-radius:var(--dsw-radius-lg);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:13px;animation:dsh-sc-in .18s ease-out}
#dsh-sidechat-panel :is(button,input,a,[role=button]){-webkit-app-region:no-drag}
.dsh-sc-resizer{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize;touch-action:none;z-index:5}
.dsh-sc-resizer:hover{background:var(--dsw-alias-border-l2)}
.dsh-sc-resizer.dragging{background:var(--dsw-alias-brand-primary)}
#dsh-sidechat-panel.dragging{user-select:none}
/* 官方右侧栏里的形态：一列页面，不是浮在页面上的卡片（与右栏自己的底色/字号一致）。 */
.dsh-sc-tabbody{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}
.dsh-sc-tabbody .dsh-sc-head{padding:10px 12px}
.dsh-sc-tabbody .dsh-sc-msg{padding:10px 12px}
.dsh-sc-tabbody .dsh-sc-list{max-height:36%}
.dsh-sc-pill{position:fixed;right:12px;bottom:16px;z-index:1200;pointer-events:auto;-webkit-app-region:no-drag;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);color:var(--dsw-alias-label-primary);border:0;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);cursor:pointer;font-size:12px;font-weight:500;animation:dsh-sc-in .15s ease-out}
.dsh-sc-pill:hover{border-color:var(--dsw-alias-brand-primary)}
.dsh-sc-pill-count{color:var(--dsw-alias-label-secondary);font-weight:400}
@keyframes dsh-sc-in{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
#dsh-sidechat-panel *{box-sizing:border-box}

.dsh-sc-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsh-sc-head-title{font-weight:600;font-size:14px;flex:1;display:flex;flex-direction:column;min-width:0}
.dsh-sc-head-name{display:flex;align-items:center;gap:8px}
.dsh-sc-head-sub{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400;margin-top:1px}

.dsh-sc-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:12px;transition:border-color .12s,color .12s,background .12s}
.dsh-sc-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-sc-btn:disabled{opacity:.45;cursor:default}
.dsh-sc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-sc-select-effort{max-width:92px}
.dsh-sc-think{margin:2px 0 6px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px}
.dsh-sc-think summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;outline:none}
.dsh-sc-think-body{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;line-height:1.5;max-height:240px;overflow-y:auto}
.dsh-sc-listpage{flex:1;min-height:0;overflow-y:auto;padding:2px 2px 8px}
.dsh-sc-back{padding:0 8px;font-size:14px;line-height:24px}
.dsh-sc-head-chat{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-sc-fold{flex:none;margin-left:auto;background:transparent;border:0;padding:0 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer}
.dsh-sc-fold:hover{color:var(--dsw-alias-label-secondary)}
.dsh-sc-folded{max-height:72px;overflow:hidden;color:var(--dsw-alias-label-secondary)}
.dsh-sc-clickable{cursor:pointer}
.dsh-sc-trace-count{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-sc-trace{margin:4px 0 10px;border-left:2px solid var(--dsw-alias-border-l2);padding:4px 0 4px 8px;display:flex;flex-direction:column;gap:3px}
.dsh-sc-trace-head{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-sc-trace-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.dsh-sc-trace-dot.running{background:var(--dsw-alias-label-on-color,#4b8bf5);animation:dsh-sc-pulse 1.2s ease-in-out infinite}
@keyframes dsh-sc-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.dsh-sc-trace-row{display:flex;gap:6px;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.dsh-sc-trace-kind{flex:none;color:var(--dsw-alias-label-tertiary)}
.dsh-sc-trace-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sc-trace-row.result .dsh-sc-trace-text{color:var(--dsw-alias-label-tertiary)}
.dsh-sc-usage{display:flex;gap:10px;justify-content:flex-end;font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}
.dsh-sc-select{flex:none;max-width:120px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:3px 6px;font-size:12px;cursor:pointer;outline:none}
.dsh-sc-select:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-sc-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-color)}
.dsh-sc-btn.primary:hover:not(:disabled){filter:brightness(1.08);color:var(--dsw-alias-label-on-color)}

.dsh-sc-list{max-height:34%;overflow-y:auto;border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px;display:flex;flex-direction:column;gap:2px;flex:none;scrollbar-width:thin}
.dsh-sc-item{display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:10px;cursor:pointer;border:1px solid transparent;transition:background .12s ease,border-color .12s ease}
.dsh-sc-item:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.dsh-sc-item.sel{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.dsh-sc-rename{flex:none;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:0;border-radius:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;cursor:pointer;opacity:0;transition:opacity .12s ease,color .12s ease}
.dsh-sc-item:hover .dsh-sc-rename{opacity:1}
.dsh-sc-rename:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-sc-rename-input{flex:1;min-width:0;font:inherit;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-brand-primary);border-radius:6px;padding:2px 6px;outline:none}
.dsh-sc-item:hover{background:var(--dsw-alias-bg-layer-1)}
.dsh-sc-item.sel{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.dsh-sc-item-title{flex:1;min-width:0}
.dsh-sc-item-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-sc-item-tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:999px;font-size:10px;font-weight:400;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2)}
.dsh-sc-item-preview{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11.5px;margin-top:3px}

.dsh-sc-chip{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 8px}
.dsh-sc-chip.error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-sc-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.dsh-sc-dot.running{background:var(--dsw-alias-brand-primary);animation:dsh-sc-pulse 1.2s ease-in-out infinite}
@keyframes dsh-sc-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}
.dsh-sc-dot.error{background:var(--dsw-alias-state-error-primary)}

.dsh-sc-msg{padding:10px 14px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin}
.dsh-sc-row{display:flex;flex-direction:column;max-width:92%}
.dsh-sc-row.user{align-self:flex-end;align-items:flex-end}
.dsh-sc-row.assistant{align-self:flex-start;align-items:flex-start}
.dsh-sc-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px;padding:0 2px}
.dsh-sc-bubble{padding:8px 12px;border-radius:12px;max-width:94%;white-space:pre-wrap;word-break:break-word;line-height:1.5;font-size:13px}
.dsh-sc-bubble pre{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;overflow-x:auto;font-size:12px;margin:6px 0;line-height:1.45}
.dsh-sc-bubble code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);background:var(--dsw-alias-bg-layer-1);border-radius:4px;padding:1px 4px;font-size:12px}
.dsh-sc-bubble pre code{background:none;border:none;padding:0;font-size:12px}
.dsh-sc-bubble h1,.dsh-sc-bubble h2,.dsh-sc-bubble h3,.dsh-sc-bubble h4,.dsh-sc-bubble h5,.dsh-sc-bubble h6{font-size:14px;margin:8px 0 4px;font-weight:600}
.dsh-sc-bubble p{margin:4px 0}
.dsh-sc-bubble ul,.dsh-sc-bubble ol{margin:4px 0;padding-left:18px}
.dsh-sc-bubble li{margin:2px 0}
.dsh-sc-bubble blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsh-sc-bubble hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0}
.dsh-sc-bubble a{color:var(--dsw-alias-brand-primary)}
.dsh-sc-row.user .dsh-sc-bubble{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-color);border-bottom-right-radius:4px}
.dsh-sc-row.assistant .dsh-sc-bubble{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-bottom-left-radius:4px}

.dsh-sc-empty{color:var(--dsw-alias-label-secondary);text-align:center;margin:auto;padding:0 16px;line-height:1.7;font-size:12px;white-space:pre-line}
.dsh-sc-empty b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-sc-error{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-radius:8px;margin:0 12px 8px;padding:6px 10px;font-size:12px;flex:none}
.dsh-sc-notice{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:8px;margin:0 12px 8px;padding:6px 10px;font-size:12px;flex:none}

.dsh-sc-foot{border-top:1px solid var(--dsw-alias-border-l1);padding:10px 12px;display:flex;flex-direction:column;gap:8px;flex:none}
.dsh-sc-actions{display:flex;gap:8px}
.dsh-sc-actions .dsh-sc-btn{flex:1}
.dsh-sc-input{display:flex;gap:8px;align-items:center}
.dsh-sc-input input{flex:1;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:13px;outline:none;min-width:0}
.dsh-sc-input input:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-sc-input input::placeholder{color:var(--dsw-alias-label-secondary)}
.dsh-sc-hint{font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center}

@media (prefers-reduced-motion:reduce){
  #dsh-sidechat-panel{animation:none}
  .dsh-sc-dot.running{animation:none}
}
`

/**
 * 每主会话已见过的 openSignal（模块级，跨 ⤳ 按钮组件重挂载保持）：
 * 只响应「信号增长」自动开面板；换会话/刷新页面首次挂载只记基线、不弹面板。
 * （配合 Host 按主会话计数，修复「换一个对话面板就自动打开」B6）
 */
const lastOpenSignals = new Map()

/** 面板开关/最小化状态 store（发布订阅），供 toggle 按钮与面板共享。 */
function createPanelStore() {
  let open = false
  let minimized = false
  const listeners = new Set()
  function emit() {
    for (const fn of Array.from(listeners)) {
      try {
        fn()
      } catch (err) {
        console.error('[side-chat] listener 异常', err)
      }
    }
  }
  return {
    getOpen: () => open,
    getMinimized: () => minimized,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setOpen(value) {
      open = value
      if (value) minimized = false
      emit()
    },
    setMinimized(value) {
      if (minimized === value) return
      minimized = value
      if (value) open = true
      emit()
    },
  }
}

/**
 * timer 服务缺失时的回退实现：npm 静态安装路径没有 client 端 timer 服务
 * （cordis-plugin-timer 无 client 半体），动态插件路径有该服务、不会走到这里。
 * 返回的 interval 与 cordis timer 同形：注册回调、返回取消函数。
 */
function createTimerFallback() {
  return {
    interval(callback, ms) {
      const id = setInterval(callback, ms)
      return () => clearInterval(id)
    },
  }
}

/**
 * 轻量 Markdown 渲染器（纯 React 元素，无 innerHTML，防 XSS）。
 * 链接仅允许 http/https/mailto 协议（B1 修复），其余降级为原文。
 * @param {object} React
 */
function createMarkdownRenderer(React) {
  const SAFE_LINK = /^(https?:|mailto:)/i

  function renderInline(text, keyBase) {
    const nodes = []
    const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g
    let last = 0
    let i = 0
    let m
    while ((m = pattern.exec(text))) {
      if (m.index > last) nodes.push(React.createElement('span', { key: keyBase + '-t' + (i++) }, text.slice(last, m.index)))
      if (m[1]) {
        nodes.push(React.createElement('code', { key: keyBase + '-c' + (i++) }, m[1].slice(1, -1)))
      } else if (m[2]) {
        nodes.push(React.createElement('strong', { key: keyBase + '-b' + (i++) }, m[2].slice(2, -2)))
      } else if (m[3]) {
        nodes.push(React.createElement('em', { key: keyBase + '-i' + (i++) }, m[3].slice(1, -1)))
      } else if (m[4]) {
        const mm = m[4].match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
        if (mm && SAFE_LINK.test(mm[2])) {
          nodes.push(React.createElement('a', {
            key: keyBase + '-a' + (i++),
            href: mm[2],
            target: '_blank',
            rel: 'noreferrer',
          }, mm[1]))
        } else if (mm) {
          // 协议不在白名单内：不渲染为可点击链接，按原文显示
          nodes.push(React.createElement('span', { key: keyBase + '-t' + (i++) }, m[4]))
        }
      }
      last = m.index + m[0].length
    }
    if (last < text.length) nodes.push(React.createElement('span', { key: keyBase + '-t' + (i++) }, text.slice(last)))
    return nodes
  }

  function renderMarkdown(text, keyBase) {
    const lines = String(text).split('\n')
    const blocks = []
    let i = 0
    let key = 0
    while (i < lines.length) {
      const line = lines[i]
      const fence = line.match(/^```(\w*)\s*$/)
      if (fence) {
        const buf = []
        i += 1
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i])
          i += 1
        }
        i += 1
        blocks.push(React.createElement('pre', { key: keyBase + '-b' + (key++) },
          React.createElement('code', { className: fence[1] ? 'language-' + fence[1] : null }, buf.join('\n'))))
        continue
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/)
      if (heading) {
        const tag = 'h' + Math.min(heading[1].length, 6)
        blocks.push(React.createElement(tag, { key: keyBase + '-b' + (key++) }, renderInline(heading[2], keyBase + '-b' + key)))
        i += 1
        continue
      }
      if (/^\s*>\s?/.test(line)) {
        const buf = []
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''))
          i += 1
        }
        blocks.push(React.createElement('blockquote', { key: keyBase + '-b' + (key++) }, renderInline(buf.join('\n'), keyBase + '-b' + key)))
        continue
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const items = []
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''))
          i += 1
        }
        blocks.push(React.createElement('ul', { key: keyBase + '-b' + (key++) },
          items.map((item, idx) => React.createElement('li', { key: keyBase + '-l' + idx }, renderInline(item, keyBase + '-l' + idx)))))
        continue
      }
      if (/^\s*-{3,}\s*$/.test(line)) {
        blocks.push(React.createElement('hr', { key: keyBase + '-b' + (key++) }))
        i += 1
        continue
      }
      if (/^\s*$/.test(line)) {
        i += 1
        continue
      }
      const buf = [line]
      i += 1
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        buf.push(lines[i])
        i += 1
      }
      blocks.push(React.createElement('p', { key: keyBase + '-b' + (key++) }, renderInline(buf.join('\n'), keyBase + '-b' + key)))
    }
    return blocks
  }

  return { renderInline, renderMarkdown }
}

return {
  apply(ctx) {
    const store = createPanelStore()
    const markdown = createMarkdownRenderer(React)
    // 动态路径有 cordis timer 服务；npm 静态路径没有，回退到 setInterval 实现
    const timer = ctx.get('timer') || createTimerFallback()
    const slots = ctx.get('slots')
    if (!slots) return
    styles.insert(PANEL_CSS)

    // 官方右侧栏（dsh-client-ui-sidebar-right）。把「侧边对话」注册成一个右栏 tab 类型，
    // 点击 ⤳ 或 /side 时在右栏打开；服务不可用时退回原来的浮层面板。
    const SIDEBAR_TAB_KIND = 'dsh-side-chat'
    let sidebarRightApi = null

    /** 订阅 store 的面板开关/最小化状态。 */
    function usePanelState() {
      const [isOpen, setLocal] = React.useState(store.getOpen())
      const [isMinimized, setMinLocal] = React.useState(store.getMinimized())
      React.useEffect(() => store.subscribe(() => {
        setLocal(store.getOpen())
        setMinLocal(store.getMinimized())
      }), [])
      return { isOpen, isMinimized }
    }

    /**
     * 当前「主视图」会话 id。
     * shell.overlay 的 standardProps 只提供 hooks（没有 sessionId 标准 prop），
     * 因此按 DSH 自身 ui-layout 的做法，从会话列表快照里取 retainedBy.mainView > 0 的那条。
     */
    function useCurrentSessionId(props) {
      return props.useSessions((state) => {
        const byId = (state && state.byId) || {}
        for (const id of Object.keys(byId)) {
          const retain = byId[id] && byId[id].retainedBy
          if (retain && (retain.mainView || 0) > 0) return id
        }
        return undefined
      })
    }

    /**
     * 打开侧边对话：优先在官方右侧栏开 tab（像子智能体对话那样占一列），
     * 右侧栏服务不可用或打开失败时，回退到原来的浮层面板。
     */
    function openSidechat(sessionId) {
      if (sidebarRightApi && sessionId) {
        try {
          sidebarRightApi.openTabIn(sessionId, SIDEBAR_TAB_KIND)
          return true
        } catch (err) {
          console.error('[side-chat] 右侧栏打开失败，回退浮层面板', err)
        }
      }
      return false
    }

    // ---- 会话标题栏右侧入口按钮 + openSignal 监听（/side 命令自动打开） ----
    function SideToggle(props) {
      const { isOpen, isMinimized } = usePanelState()
      const sessionId = props.sessionId || useCurrentSessionId(props)
      React.useEffect(() => {
        if (!timer) return undefined
        return timer.interval(async () => {
          if (!sessionId) return
          try {
            const res = await host.call('sidechat/state', { mainSessionId: sessionId, exclude: readArchivedIds() })
            if (res && typeof res.openSignal === 'number') {
              const prev = lastOpenSignals.get(sessionId)
              if (prev === undefined) {
                // 首次挂载：记录基线，不自动打开（换会话/刷新页面不弹面板）
                lastOpenSignals.set(sessionId, res.openSignal)
                return
              }
              if (res.openSignal > prev) {
                lastOpenSignals.set(sessionId, res.openSignal)
                if (!openSidechat(sessionId)) store.setOpen(true)
              }
            }
          } catch (err) {
            console.error('[side-chat] openSignal 监听失败', err)
          }
        }, 2000)
      }, [timer, sessionId])
      return React.createElement('button', {
        id: 'dsh-sidechat-toggle',
        type: 'button',
        'aria-label': isMinimized ? '恢复侧边对话' : '侧边对话（并行 agent 会话，独立上下文）',
        title: isMinimized ? '恢复侧边对话' : '侧边对话（并行 agent 会话，独立上下文）',
        onClick: () => {
          if (openSidechat(sessionId)) return
          if (store.getOpen() && !store.getMinimized()) store.setOpen(false)
          else store.setOpen(true)
        },
      }, '⤳')
    }

    // ---- 侧边面板（inline=true 时作为官方右侧栏 tab 正文渲染，否则是浮层面板） ----
    function SidePanel(props) {
      const inline = props.inline === true
      const { isOpen, isMinimized } = usePanelState()
      const [chats, setChats] = React.useState([])
      const [selectedId, setSelectedId] = React.useState(null)
      const [messages, setMessages] = React.useState([])
      const [input, setInput] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [bringingBack, setBringingBack] = React.useState(false)
      // 模型：可选目录按 provider 分组；nextSelection 只影响下一条新建的侧对话
      const [models, setModels] = React.useState([])
      const [nextSelection, setNextSelection] = React.useState('')
      // 新建侧对话的上下文来源：none（独立）| recent（最近若干轮）| full（全部对话文字）
      const [nextInherit, setNextInherit] = React.useState('none')
      // 新建时选定的推理强度（空 = 跟随模型默认）
      const [nextEffort, setNextEffort] = React.useState('')
      // 选中侧对话的花费（来自计费插件，取不到时为 null）
      const [usage, setUsage] = React.useState(null)
      // 当前模型信息（reasoning 档位等，按需从宿主精确查询）
      const [modelInfo, setModelInfo] = React.useState(null)
      // 运行中回合的逐步骤进度（伪流式：思考/工具/结果，宿主按会话事件抽取）
      const [trace, setTrace] = React.useState([])
      const [running, setRunning] = React.useState(false)
      // 列表页 / 对话页：默认列表，点某条进入对话（返回即列表）
      const [view, setView] = React.useState('list')
      // 刚新建、state 还没轮询到的对话 id（避免被「选中项不存在」的保护逻辑弹回列表）
      const [pendingChatId, setPendingChatId] = React.useState(null)
      // 折叠：逐条消息手动折叠（超长消息默认折叠）+ 步骤区折叠
      const [collapsedMsgs, setCollapsedMsgs] = React.useState({})
      const [traceCollapsed, setTraceCollapsed] = React.useState(false)
      const msgBoxRef = React.useRef(null)
      const [width, setWidth] = React.useState(380)
      const [dragging, setDragging] = React.useState(false)
      const dragRef = React.useRef(null)
      // 右栏 tab 是 session 作用域席位，直接带 sessionId；浮层只能从会话列表快照里推。
      const sessionId = props.sessionId || useCurrentSessionId(props)

      // 模型选择项 <-> 下拉框值（'provider::model'）
      const keyOfSelection = (sel) => (sel && sel.provider && sel.model ? sel.provider + '::' + sel.model : '')
      const parseSelection = (key) => {
        if (!key) return undefined
        const at = key.indexOf('::')
        if (at <= 0) return undefined
        return { provider: key.slice(0, at), model: key.slice(at + 2) }
      }

      // 已归档的侧对话 id（localStorage）：重启恢复时传给宿主跳过它们
      const readArchivedIds = () => {
        try {
          const raw = window.localStorage && window.localStorage.getItem('dsh-sidechat-archived')
          const list = raw ? JSON.parse(raw) : []
          return Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(-400) : []
        } catch (err) {
          return []
        }
      }
      const rememberArchivedId = (id) => {
        try {
          if (!window.localStorage || typeof id !== 'string') return
          const list = readArchivedIds().filter((x) => x !== id)
          list.push(id)
          window.localStorage.setItem('dsh-sidechat-archived', JSON.stringify(list.slice(-400)))
        } catch (err) {
          // 存不下就算了：最多重启后又恢复出来
        }
      }

      const refreshState = React.useCallback(async () => {
        if (!sessionId) return
        try {
          const res = await host.call('sidechat/state', { mainSessionId: sessionId, exclude: readArchivedIds() })
          if (!res || !Array.isArray(res.chats)) return
          // 内容级比较：无变化时不触发重渲染
          setChats((prev) => {
            if (prev.length === res.chats.length && prev.every((c, i) =>
              c.id === res.chats[i].id &&
              c.status === res.chats[i].status &&
              c.error === res.chats[i].error &&
              c.lastPreview === res.chats[i].lastPreview &&
              c.updatedAt === res.chats[i].updatedAt)) {
              return prev
            }
            return res.chats
          })
          // 不再自动选中第一条：面板默认停在列表页，点哪条进哪条
          setSelectedId((cur) => (cur && res.chats.some((c) => c.id === cur) ? cur : null))
        } catch (err) {
          console.error('[side-chat] state 失败', err)
        }
      }, [sessionId])

      const refreshEvents = React.useCallback(async () => {
        if (!sessionId || !selectedId) return
        try {
          const res = await host.call('sidechat/events', { mainSessionId: sessionId, id: selectedId })
          if (res && res.ok && Array.isArray(res.messages)) setMessages(res.messages)
          if (res && res.ok) {
            setTrace(Array.isArray(res.trace) ? res.trace : [])
            setRunning(res.running === true)
          }
        } catch (err) {
          console.error('[side-chat] events 失败', err)
        }
      }, [sessionId, selectedId])

      // 模型目录只在挂载时取一次；取不到就不显示选择器（不影响已有功能）
      React.useEffect(() => {
        let alive = true
        host.call('sidechat/models')
          .then((res) => {
            if (alive && res && Array.isArray(res.providers)) setModels(res.providers)
          })
          .catch((err) => console.error('[side-chat] 模型目录获取失败', err))
        return () => { alive = false }
      }, [])

      React.useEffect(() => {
        if (!inline && !isOpen) return undefined
        refreshState()
        refreshEvents()
        if (!timer) return undefined
        return timer.interval(() => {
          refreshState()
          refreshEvents()
        }, 1000)
      }, [isOpen, timer, refreshState, refreshEvents])

      React.useEffect(() => {
        if (chats.length === 0) {
          setSelectedId(null)
          setMessages([])
          // 关掉最后一条后不留旧提示（比如「主对话正忙」）
          setNotice('')
        }
      }, [chats])

      // 自动滚动：仅在消息真实变化/切换对话/重新打开/恢复时，且用户接近底部时跟随（B2 修复）
      const scrollAnchorRef = React.useRef(null)
      const prevMinRef = React.useRef(false)
      const prevOpenRef = React.useRef(false)
      React.useEffect(() => {
        const prev = scrollAnchorRef.current
        const selChanged = !prev || prev.sel !== selectedId
        const opened = isOpen && !prevOpenRef.current
        const restored = prevMinRef.current && !isMinimized
        prevOpenRef.current = isOpen
        prevMinRef.current = isMinimized
        scrollAnchorRef.current = { sig: null, sel: selectedId }
        const box = msgBoxRef.current
        if (!box) return
        const last = messages.length ? messages[messages.length - 1] : null
        const sig = messages.length + ':' + (last ? last.time : '') + ':' + (last ? last.text.length : 0)
        const contentChanged = prev ? prev.sig !== sig : true
        scrollAnchorRef.current = { sig, sel: selectedId }
        if (!selChanged && !contentChanged && !opened && !restored) return
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
        if (selChanged || opened || restored || nearBottom) {
          box.scrollTop = box.scrollHeight
        }
      }, [messages, selectedId, isOpen, isMinimized])

      // 对话页但选中项已消失（被归档/关闭）时退回列表；刚新建、状态还没刷新到的 id 先放行
      React.useEffect(() => {
        if (view !== 'chat') return
        if (!selectedId) {
          setView('list')
          return
        }
        if (chats.some((c) => c.id === selectedId)) {
          if (pendingChatId === selectedId) setPendingChatId(null)
          return
        }
        if (pendingChatId !== selectedId) setView('list')
      }, [view, selectedId, chats, pendingChatId])

      // 模型精确信息：只在生效模型变化时查一次
      const infoChat = chats.find((c) => c.id === selectedId) || null
      const routeSelectionForInfo = infoChat ? infoChat.selection : parseSelection(nextSelection)
      const infoProvider = routeSelectionForInfo && routeSelectionForInfo.provider
      const infoModel = routeSelectionForInfo && routeSelectionForInfo.model
      React.useEffect(() => {
        if (!infoProvider || !infoModel) {
          setModelInfo(null)
          return undefined
        }
        let alive = true
        host.call('sidechat/model-info', { provider: infoProvider, model: infoModel })
          .then((res) => { if (alive) setModelInfo(res && res.ok ? res.info : null) })
          .catch(() => { if (alive) setModelInfo(null) })
        return () => { alive = false }
      }, [infoProvider, infoModel])

      // 花费：选中对话或消息更新时问一次计费插件（拿不到就隐藏）
      const lastMessageTime = messages.length ? messages[messages.length - 1].time : 0
      React.useEffect(() => {
        if (!sessionId || !selectedId) {
          setUsage(null)
          return undefined
        }
        let alive = true
        host.call('sidechat/usage', { mainSessionId: sessionId, id: selectedId })
          .then((res) => { if (alive) setUsage(res && res.ok ? res.usage : null) })
          .catch(() => { if (alive) setUsage(null) })
        return () => { alive = false }
      }, [sessionId, selectedId, lastMessageTime])

      // Markdown 渲染（仅在消息变化时解析；B5 修复：key 用消息索引）
      const renderedMessages = React.useMemo(
        () => messages.map((m, index) => ({
          role: m.role,
          time: m.time,
          text: m.text || '',
          thinking: m.thinking || '',
          blocks: markdown.renderMarkdown(m.text, 'm' + index + '_'),
        })),
        [messages],
      )

      if (!inline && !isOpen) return null

      // 最小化态（仅浮层）：右侧底部小胶囊（对话继续后台运行，点击恢复）
      if (!inline && isMinimized) {
        const runningCount = chats.filter((c) => c.status === 'running').length
        return React.createElement('div', {
          className: 'dsh-sc-pill',
          role: 'button',
          title: '恢复侧边对话',
          onClick: () => store.setMinimized(false),
          'data-window-drag-exclude': '',
        },
          React.createElement('span', { className: 'dsh-sc-dot' + (runningCount ? ' running' : '') }),
          React.createElement('span', null, '⤳ 侧边对话'),
          runningCount ? React.createElement('span', { className: 'dsh-sc-pill-count' }, runningCount + ' 运行中') : null,
        )
      }

      const selected = chats.find((c) => c.id === selectedId) || null

      // 当前生效模型（选中对话 / 新建默认）。effort 档位要按模型精确查询，目录里只有名字。
      const routeKey = selected ? keyOfSelection(selected.selection) : nextSelection
      const efforts = modelInfo && modelInfo.reasoning && Array.isArray(modelInfo.reasoning.efforts)
        ? modelInfo.reasoning.efforts
        : []
      const defaultEffort = modelInfo && modelInfo.reasoning ? modelInfo.reasoning.defaultEffort : undefined
      const effortValue = selected
        ? (selected.selection && selected.selection.reasoningEffort) || defaultEffort || ''
        : nextEffort || defaultEffort || ''

      // 改名：列表项上点 ✎ 进入内联编辑，回车/失焦提交，Esc 取消
      const [renamingId, setRenamingId] = React.useState(null)
      const [renameText, setRenameText] = React.useState('')
      const startRename = (c) => {
        setRenamingId(c.id)
        setRenameText(typeof c.title === 'string'
          ? c.title
          : c.title && typeof c.title.title === 'string' ? c.title.title : '')
      }
      const commitRename = async (id) => {
        const title = String(renameText || '').trim()
        setRenamingId(null)
        if (!title) return
        try {
          const res = await host.call('sidechat/rename', { mainSessionId: sessionId, id, title })
          if (res && !res.ok) setNotice(res.error || '改名失败')
          else setChats((prev) => prev.map((c) => (c.id === id ? Object.assign({}, c, { title: (res && res.title) || title }) : c)))
          refreshState()
        } catch (err) {
          setNotice('改名失败：' + String(err))
        }
      }

      const createChat = async () => {
        if (!sessionId) {
          setNotice('请先打开一个会话')
          return
        }
        setNotice('')
        try {
          const chosen = parseSelection(nextSelection)
          if (chosen && nextEffort) chosen.reasoningEffort = nextEffort
          const res = await host.call('sidechat/open', {
            mainSessionId: sessionId,
            selection: chosen,
            inherit: nextInherit === 'none' ? undefined : nextInherit,
          })
          if (res && res.ok) {
            setPendingChatId(res.id)
            setSelectedId(res.id)
            setView('chat')
            if (res.notice) setNotice(res.notice)
            refreshState()
          } else {
            setNotice((res && res.error) || '创建失败')
          }
        } catch (err) {
          setNotice('创建失败：' + String(err))
        }
      }

      // 切换选中侧对话的模型路由（provider/model/effort 一起写，下一轮生效）
      const applyRoute = async (selection, what) => {
        setNotice('正在切换' + what + '…')
        try {
          const res = await host.call('sidechat/select-model', { mainSessionId: sessionId, id: selected.id, selection })
          if (res && res.ok) setNotice('已切换' + what + '，下一轮生效')
          else setNotice((res && res.error) || ('切换' + what + '失败'))
          refreshState()
        } catch (err) {
          setNotice('切换' + what + '失败：' + String(err))
        }
      }
      // 换模型：有选中的侧对话就切它，没有就只记下一条新建用的模型
      const pickModel = async (key) => {
        if (!selected) {
          setNextSelection(key)
          return
        }
        const selection = parseSelection(key)
        if (!selection) return
        if (effortValue) selection.reasoningEffort = effortValue
        await applyRoute(selection, '模型')
      }
      // 换推理强度：同样作用于选中对话；没有选中时记给下一条新建
      const pickEffort = async (effort) => {
        if (!selected) {
          setNextEffort(effort)
          return
        }
        const selection = parseSelection(keyOfSelection(selected.selection))
        if (!selection) return
        if (effort) selection.reasoningEffort = effort
        await applyRoute(selection, '推理强度')
      }

      const send = async () => {
        const text = input.trim()
        if (!text || !selectedId) return
        setInput('')
        setNotice('')
        try {
          const res = await host.call('sidechat/send', { mainSessionId: sessionId, id: selectedId, text })
          if (res && !res.ok) setNotice(res.error || '发送失败')
          refreshEvents()
        } catch (err) {
          setNotice('发送失败：' + String(err))
        }
      }

      const bringBack = async () => {
        if (!selectedId || bringingBack) return
        setBringingBack(true)
        setNotice('正在总结并带回主对话…')
        try {
          const res = await host.call('sidechat/bring-back', { mainSessionId: sessionId, id: selectedId })
          if (res && res.ok) {
            setNotice('已把摘要注入主对话')
          } else if (res && res.error === 'main-busy') {
            setNotice('主对话正忙，请稍后再试')
          } else {
            setNotice((res && res.error) || '带回失败')
          }
          refreshEvents()
        } catch (err) {
          setNotice('带回失败：' + String(err))
        } finally {
          setBringingBack(false)
        }
      }

      const closeChat = async (id) => {
        try {
          const res = await host.call('sidechat/close', { mainSessionId: sessionId, id })
          if (res && !res.ok) setNotice(res.error || '归档失败')
          else {
            rememberArchivedId(id)
            if (id === selectedId) {
              setSelectedId(null)
              setView('list')
            }
          }
          refreshState()
        } catch (err) {
          setNotice('归档失败：' + String(err))
        }
      }

      const timeOf = (ts) => {
        try {
          return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        } catch (err) {
          return ''
        }
      }

      // ---- 面板拖拽调宽（setPointerCapture，无需 document 级监听） ----
      const onResizeDown = (e) => {
        e.preventDefault()
        dragRef.current = { startX: e.clientX, startWidth: width }
        try {
          e.target.setPointerCapture(e.pointerId)
        } catch (err) {
          console.error('[side-chat] 指针捕获失败', err)
        }
        setDragging(true)
      }
      const onResizeMove = (e) => {
        const drag = dragRef.current
        if (!drag) return
        const next = drag.startWidth + drag.startX - e.clientX
        setWidth(Math.min(900, Math.max(300, next)))
      }
      const onResizeUp = () => {
        dragRef.current = null
        setDragging(false)
      }
      const resizer = React.createElement('div', {
        className: 'dsh-sc-resizer' + (dragging ? ' dragging' : ''),
        title: '拖动调整宽度，双击复位',
        onPointerDown: onResizeDown,
        onPointerMove: onResizeMove,
        onPointerUp: onResizeUp,
        onPointerCancel: onResizeUp,
        onDoubleClick: () => setWidth(380),
      })

      const isErrorText = (text) => /失败|错误|上限|正忙|不能为空|未知|缺失|不在线/.test(text)

      // ---- 模型选择器（目录拿不到时不渲染，一切照旧） ----
      const knownModelKeys = new Set()
      for (const group of models) {
        for (const model of group.models) knownModelKeys.add(group.provider + '::' + model.id)
      }
      // 上下文来源只影响「下一条新建」，与当前选中的对话无关：所以始终显示，
      // 否则有对话被自动选中后就再也没有入口改下一次的模式了。
      const inheritPicker = React.createElement('select', {
        className: 'dsh-sc-select',
        'aria-label': '新建侧对话时使用的上下文',
        title: '下一条新建侧对话的上下文：独立 / 继承最近（最近约 20 条对话）/ 继承完整（主对话全部对话文字）——两种继承都不带工具调用，也不影响已建对话',
        value: nextInherit,
        onChange: (e) => setNextInherit(e.target.value),
      },
        React.createElement('option', { value: 'none' }, '独立上下文'),
        React.createElement('option', { value: 'recent' }, '继承最近'),
        React.createElement('option', { value: 'full' }, '继承完整'),
      )
      const pickerValue = selected ? keyOfSelection(selected.selection) : nextSelection
      const picker = models.length === 0 ? null : React.createElement('select', {
        className: 'dsh-sc-select',
        title: selected ? '该侧对话使用的模型（切换后下一轮生效）' : '新建侧对话使用的模型（默认跟随主对话）',
        value: pickerValue,
        onChange: (e) => pickModel(e.target.value),
      },
        selected ? null : React.createElement('option', { value: '' }, '跟随主对话'),
        pickerValue && !knownModelKeys.has(pickerValue)
          ? React.createElement('option', { value: pickerValue },
              ((selected && selected.selection && selected.selection.model) || '当前模型') + '（当前）')
          : null,
        models.map((group) => React.createElement('optgroup', { key: 'provider:' + group.provider, label: group.name },
          group.models.map((model) => React.createElement('option', { key: group.provider + '::' + model.id, value: group.provider + '::' + model.id }, model.name)))),
      )

      // 推理强度：只在该模型声明了 effort 档位时出现
      const effortPicker = efforts.length === 0 ? null : React.createElement('select', {
        className: 'dsh-sc-select dsh-sc-select-effort',
        'aria-label': '推理强度',
        title: selected ? '该侧对话的推理强度（切换后下一轮生效）' : '新建侧对话的推理强度',
        value: effortValue,
        onChange: (e) => pickEffort(e.target.value),
      }, efforts.map((effort) => React.createElement('option', { key: effort.id, value: effort.id }, effort.name || effort.id)))

      // 右侧栏里 tab 条已经写着「侧边对话」，正文头不再重复标题，只留一行说明 + 新建。
      const chatTitle = selected
        ? (typeof selected.title === 'string'
            ? selected.title
            : selected.title && typeof selected.title.title === 'string' ? selected.title.title : '侧对话')
        : '侧边对话'
      const head = React.createElement('div', { className: 'dsh-sc-head' },
        view === 'chat'
          ? React.createElement('button', {
              className: 'dsh-sc-btn dsh-sc-back',
              onClick: () => setView('list'),
              title: '返回对话列表',
            }, '←')
          : null,
        React.createElement('div', { className: 'dsh-sc-head-title' },
          view === 'chat'
            ? React.createElement('span', { className: 'dsh-sc-head-chat' }, chatTitle)
            : inline
              ? React.createElement('span', { className: 'dsh-sc-head-sub' }, '并行会话 · 独立上下文')
              : null,
          inline || view === 'chat'
            ? null
            : React.createElement('span', { className: 'dsh-sc-head-name' }, '⤳ 侧边对话'),
          inline || view === 'chat'
            ? null
            : React.createElement('span', { className: 'dsh-sc-head-sub' }, '并行会话 · 独立上下文'),
        ),
        view === 'chat' ? null : inheritPicker,
        picker,
        effortPicker,
        view === 'chat'
          ? null
          : React.createElement('button', { className: 'dsh-sc-btn primary', onClick: createChat }, '＋ 新建'),
        inline ? null : React.createElement('button', {
          className: 'dsh-sc-btn',
          onClick: () => store.setMinimized(true),
          title: '缩小到右侧（对话继续运行）',
        }, '—'),
        inline ? null : React.createElement('button', { className: 'dsh-sc-btn', onClick: () => store.setOpen(false), title: '关闭面板' }, '✕'),
      )

      const chipOf = (c) => {
        const running = c.status === 'running'
        const failed = Boolean(c.error)
        const label = running ? '运行中' : failed ? '出错' : '空闲'
        return React.createElement('span', {
          className: 'dsh-sc-chip' + (failed ? ' error' : ''),
        },
          React.createElement('span', { className: 'dsh-sc-dot' + (running ? ' running' : failed ? ' error' : '') }),
          label)
      }

      const list = React.createElement('div', { className: 'dsh-sc-list' },
        chats.length === 0
          ? React.createElement('div', { className: 'dsh-sc-empty' }, '还没有侧边对话\n点击「＋ 新建」，开一条不打扰主对话的并行会话')
          : chats.map((c) => React.createElement('div', {
              key: c.id,
              className: 'dsh-sc-item' + (c.id === selectedId && view === 'chat' ? ' sel' : ''),
              onClick: () => {
                setSelectedId(c.id)
                setView('chat')
              },
            },
              React.createElement('div', { className: 'dsh-sc-item-title' },
                renamingId === c.id
                  ? React.createElement('input', {
                      className: 'dsh-sc-rename-input',
                      value: renameText,
                      autoFocus: true,
                      onClick: (e) => e.stopPropagation(),
                      onChange: (e) => setRenameText(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.stopPropagation()
                          commitRename(c.id)
                        } else if (e.key === 'Escape') {
                          e.stopPropagation()
                          setRenamingId(null)
                        }
                      },
                      onBlur: () => commitRename(c.id),
                    })
                  : React.createElement('span', { className: 'dsh-sc-item-name' },
                      typeof c.title === 'string'
                        ? c.title
                        : c.title && typeof c.title === 'object' && typeof c.title.title === 'string'
                          ? c.title.title
                          : '侧对话',
                      c.inheritMode
                        ? React.createElement('span', { className: 'dsh-sc-item-tag' }, c.inheritMode === 'full' ? '继承·完整' : '继承·最近')
                        : null,
                    ),
                renamingId === c.id
                  ? null
                  : React.createElement('button', {
                      className: 'dsh-sc-rename',
                      title: '重命名这条侧对话',
                      onClick: (e) => {
                        e.stopPropagation()
                        startRename(c)
                      },
                    }, '✎'),
                React.createElement('span', { className: 'dsh-sc-item-preview' }, c.lastPreview || (c.status === 'running' ? '正在思考…' : '还没有消息')),
              ),
              chipOf(c),
            )),
      )

      const traceBox = running || trace.length
        ? React.createElement('div', { className: 'dsh-sc-trace' },
            React.createElement('div', {
              className: 'dsh-sc-trace-head dsh-sc-clickable',
              title: traceCollapsed ? '展开步骤' : '折叠步骤',
              onClick: () => setTraceCollapsed((value) => !value),
            },
              running ? React.createElement('span', { className: 'dsh-sc-trace-dot running' }) : null,
              running ? '运行中…' : '本轮步骤',
              React.createElement('span', { className: 'dsh-sc-trace-count' }, traceCollapsed ? '▸' : '▾'),
            ),
            traceCollapsed ? null : trace.slice(-8).map((row, index) => React.createElement('div', {
              key: index,
              className: 'dsh-sc-trace-row ' + (row && row.kind ? row.kind : 'text'),
            },
              React.createElement('span', { className: 'dsh-sc-trace-kind' },
                row && row.kind === 'thinking' ? '思考' : row && row.kind === 'tool' ? '工具' : '结果'),
              React.createElement('span', { className: 'dsh-sc-trace-text' }, String((row && row.text) || '')),
            )),
          )
        : null

      const body = selected
        ? React.createElement('div', { ref: msgBoxRef, className: 'dsh-sc-msg' },
            traceBox,
            renderedMessages.length === 0
              ? React.createElement('div', { className: 'dsh-sc-empty' }, '还没有消息\n发一句话开始这段并行对话')
              : renderedMessages.map((m, index) => {
                  const autoFold = typeof m.text === 'string' && m.text.length > 600
                  const folded = index in collapsedMsgs ? collapsedMsgs[index] : autoFold
                  return React.createElement('div', {
                    key: index,
                    className: 'dsh-sc-row ' + m.role + (folded ? ' folded' : ''),
                  },
                    React.createElement('div', { className: 'dsh-sc-meta' },
                      React.createElement('span', null, m.role === 'user' ? '你' : '侧对话助手'),
                      React.createElement('span', null, timeOf(m.time)),
                      React.createElement('button', {
                        className: 'dsh-sc-fold',
                        title: folded ? '展开这条消息' : '折叠这条消息',
                        onClick: () => setCollapsedMsgs((prev) => Object.assign({}, prev, { [index]: !folded })),
                      }, folded ? '展开' : '折叠'),
                    ),
                    folded
                      ? React.createElement('div', { className: 'dsh-sc-bubble dsh-sc-folded' },
                          String(m.text || '').slice(0, 240) + ((m.text || '').length > 240 ? '…' : ''))
                      : React.createElement('div', { className: 'dsh-sc-bubble' },
                          m.thinking
                            ? React.createElement('details', { className: 'dsh-sc-think' },
                                React.createElement('summary', null, '思考过程'),
                                React.createElement('div', { className: 'dsh-sc-think-body' }, m.thinking),
                              )
                            : null,
                          m.blocks,
                        ),
                  )
                }),
          )
        : React.createElement('div', { className: 'dsh-sc-msg' },
            React.createElement('div', { className: 'dsh-sc-empty' }, '从上方列表选择一条侧对话\n或点击「＋ 新建」开一条新的'))

      const formatTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))
      const usageLine = usage && (usage.costCny !== undefined || usage.input !== undefined)
        ? React.createElement('div', { className: 'dsh-sc-usage' },
            usage.costCny !== undefined
              ? React.createElement('span', null, '费用 ¥' + Number(usage.costCny).toFixed(4))
              : null,
            usage.cacheRead !== undefined ? React.createElement('span', null, '缓存 ' + formatTokens(usage.cacheRead)) : null,
            usage.input !== undefined ? React.createElement('span', null, '入 ' + formatTokens(usage.input)) : null,
            usage.output !== undefined ? React.createElement('span', null, '出 ' + formatTokens(usage.output)) : null,
          )
        : null

      const foot = selected
        ? React.createElement('div', { className: 'dsh-sc-foot' },
            usageLine,
            React.createElement('div', { className: 'dsh-sc-actions' },
              React.createElement('button', {
                className: 'dsh-sc-btn',
                onClick: bringBack,
                disabled: bringingBack,
                title: '让侧对话总结自己的内容，以折叠提示行注入主对话',
              }, bringingBack ? '总结中…' : '带回主对话'),
              React.createElement('button', {
                className: 'dsh-sc-btn',
                onClick: () => closeChat(selected.id),
                title: '归档该侧对话（按 DSH 归档逻辑：停止运行并进归档列表，可在归档里找回）',
              }, '归档'),
            ),
            React.createElement('div', { className: 'dsh-sc-input' },
              React.createElement('input', {
                value: input,
                placeholder: '输入消息…',
                onChange: (e) => setInput(e.target.value),
                onKeyDown: (e) => {
                  // 输入法组词中按 Enter 是上屏候选字，不应发送消息（macOS/Windows IME 同款判断）。
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
                },
              }),
              React.createElement('button', {
                className: 'dsh-sc-btn primary',
                onClick: send,
                disabled: !input.trim() || bringingBack,
              }, '发送'),
            ),
          )
        : null

      const noticeBar = notice
        ? React.createElement('div', { className: isErrorText(notice) ? 'dsh-sc-error' : 'dsh-sc-notice' }, notice)
        : null

      const selectedError = selected && selected.error
        ? React.createElement('div', { className: 'dsh-sc-error' }, '该侧对话出错：' + selected.error)
        : null

      if (inline) {
        return React.createElement('div', { className: 'dsh-sc-tabbody' },
          head,
          view === 'chat' ? null : React.createElement('div', { className: 'dsh-sc-listpage' }, list),
          noticeBar,
          selectedError,
          view === 'chat' ? body : null,
          view === 'chat' ? foot : null,
        )
      }

      return React.createElement('div', {
        id: 'dsh-sidechat-panel',
        className: dragging ? 'dragging' : null,
        style: { width: width + 'px' },
        // macOS 隐藏标题栏：面板常驻在窗口顶部，必须显式声明「不是拖拽区」，
        // 否则点住按钮会变成拖动窗口，按钮永远收不到 click。
        'data-window-drag-exclude': '',
      },
        resizer,
        head,
        view === 'chat' ? null : React.createElement('div', { className: 'dsh-sc-listpage' }, list),
        noticeBar,
        selectedError,
        view === 'chat' ? body : null,
        view === 'chat' ? foot : null,
      )
    }

    /** 官方右侧栏 tab 正文：复用同一套内容，只是不再浮在页面上。 */
    function SideChatTabBody(props) {
      return React.createElement(SidePanel, Object.assign({}, props, { inline: true }))
    }

    /** 右栏「开始」页里的入口框图标（与同排其它条目的 22/26px 描边图标同款）。 */
    function SideChatGlyph(props) {
      const size = (props && props.size) || 22
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 22 22', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round',
        className: props && props.className, 'aria-hidden': 'true', focusable: 'false',
      },
        React.createElement('rect', { x: 2.6, y: 3.6, width: 16.8, height: 14.8, rx: 3.2 }),
        React.createElement('line', { x1: 13.2, y1: 3.6, x2: 13.2, y2: 18.4 }),
        React.createElement('path', { d: 'M15.9 8.6l2 2-2 2' }),
      )
    }

    // ---- Slot 注册 ----
    slots.inject('conversation.session.header.actions', () => slots.register(
      { name: 'conversation.session.header.actions', id: 'sidechat-toggle', order: 30 },
      SideToggle,
    ))
    // 浮层兜底：右栏不可用时仍可用（shell.overlay 的 standardProps 自带 useSessions）。
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'sidechat-panel', order: 100 },
      SidePanel,
    ))

    // ---- 官方右侧栏 tab 类型（ctx.sidebarRightTabs + ctx.sidebarRight）----
    // 右栏服务可能比本插件晚就绪，用 ctx.inject 等它就绪，不阻塞插件启动；
    // 服务缺失时只保留浮层面板。
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
        const right = scope.sidebarRight || (scope.get && scope.get('sidebarRight'))
        const tabs = scope.sidebarRightTabs || (scope.get && scope.get('sidebarRightTabs'))
        if (!right || !tabs) return
        sidebarRightApi = right
        scope.effect(() => tabs.register({
          id: SIDEBAR_TAB_KIND,
          kind: SIDEBAR_TAB_KIND,
          title: () => '侧边对话',
          // 右栏「开始」页里的入口框：点一下就把「开始」换成侧边对话页。
          guide: [{
            id: 'sidechat',
            order: 35,
            title: () => '侧边对话',
            description: () => '并行 agent 会话，独立上下文',
            icon: SideChatGlyph,
          }],
        }), 'side-chat: sidebar tab type')
        slots.inject('sidebar.right.pane.tab', () => slots.register(
          { name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_KIND },
          SideChatTabBody,
        ))
      })
    }
  },
}
