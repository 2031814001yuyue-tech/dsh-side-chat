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

#dsh-sidechat-panel{position:fixed;top:0;right:0;bottom:0;width:380px;max-width:92vw;min-width:300px;z-index:1200;pointer-events:auto;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border-left:1px solid var(--dsw-alias-border-l1);box-shadow:-8px 0 24px rgba(0,0,0,.18);font-size:13px;animation:dsh-sc-in .18s ease-out}
.dsh-sc-resizer{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:ew-resize;touch-action:none;z-index:5}
.dsh-sc-resizer:hover{background:var(--dsw-alias-border-l2)}
.dsh-sc-resizer.dragging{background:var(--dsw-alias-brand-primary)}
#dsh-sidechat-panel.dragging{user-select:none}
.dsh-sc-pill{position:fixed;right:12px;bottom:16px;z-index:1200;pointer-events:auto;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:pointer;font-size:12px;font-weight:500;animation:dsh-sc-in .15s ease-out}
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
.dsh-sc-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-overlay)}
.dsh-sc-btn.primary:hover:not(:disabled){filter:brightness(1.08);color:var(--dsw-alias-bg-overlay)}

.dsh-sc-list{max-height:34%;overflow-y:auto;border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px;display:flex;flex-direction:column;gap:2px;flex:none;scrollbar-width:thin}
.dsh-sc-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.dsh-sc-item:hover{background:var(--dsw-alias-bg-layer-1)}
.dsh-sc-item.sel{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.dsh-sc-item-title{flex:1;min-width:0}
.dsh-sc-item-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.dsh-sc-item-preview{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px}

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
.dsh-sc-bubble{padding:7px 11px;border-radius:10px;white-space:pre-wrap;word-break:break-word;line-height:1.5;font-size:13px}
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
.dsh-sc-row.user .dsh-sc-bubble{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-overlay);border-bottom-right-radius:4px}
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
    const timer = ctx.get('timer')
    const slots = ctx.get('slots')
    if (!slots) return
    styles.insert(PANEL_CSS)

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

    // ---- 会话标题栏右侧入口按钮 + openSignal 监听（/side 命令自动开面板） ----
    function SideToggle(props) {
      const { isOpen, isMinimized } = usePanelState()
      const sessionId = props.sessionId
      const lastOpenSignal = React.useRef(0)
      React.useEffect(() => {
        if (!timer) return undefined
        return timer.interval(async () => {
          if (!sessionId) return
          try {
            const res = await host.call('sidechat/state', { mainSessionId: sessionId })
            if (res && typeof res.openSignal === 'number' && res.openSignal > lastOpenSignal.current) {
              lastOpenSignal.current = res.openSignal
              store.setOpen(true)
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
          if (store.getOpen() && !store.getMinimized()) store.setOpen(false)
          else store.setOpen(true)
        },
      }, '⤳')
    }

    // ---- 侧边面板 ----
    function SidePanel(props) {
      const { isOpen, isMinimized } = usePanelState()
      const [chats, setChats] = React.useState([])
      const [selectedId, setSelectedId] = React.useState(null)
      const [messages, setMessages] = React.useState([])
      const [input, setInput] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [bringingBack, setBringingBack] = React.useState(false)
      const msgBoxRef = React.useRef(null)
      const [width, setWidth] = React.useState(380)
      const [dragging, setDragging] = React.useState(false)
      const dragRef = React.useRef(null)
      const sessionId = props.useSessions((s) => s.current)

      const refreshState = React.useCallback(async () => {
        if (!sessionId) return
        try {
          const res = await host.call('sidechat/state', { mainSessionId: sessionId })
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
          setSelectedId((cur) => {
            if (cur && res.chats.some((c) => c.id === cur)) return cur
            return res.chats.length ? res.chats[0].id : null
          })
        } catch (err) {
          console.error('[side-chat] state 失败', err)
        }
      }, [sessionId])

      const refreshEvents = React.useCallback(async () => {
        if (!sessionId || !selectedId) return
        try {
          const res = await host.call('sidechat/events', { mainSessionId: sessionId, id: selectedId })
          if (res && res.ok && Array.isArray(res.messages)) setMessages(res.messages)
        } catch (err) {
          console.error('[side-chat] events 失败', err)
        }
      }, [sessionId, selectedId])

      React.useEffect(() => {
        if (!isOpen) return undefined
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

      // Markdown 渲染（仅在消息变化时解析；B5 修复：key 用消息索引）
      const renderedMessages = React.useMemo(
        () => messages.map((m, index) => ({ role: m.role, time: m.time, blocks: markdown.renderMarkdown(m.text, 'm' + index + '_') })),
        [messages],
      )

      if (!isOpen) return null

      // 最小化态：右侧底部小胶囊（对话继续后台运行，点击恢复）
      if (isMinimized) {
        const runningCount = chats.filter((c) => c.status === 'running').length
        return React.createElement('div', {
          className: 'dsh-sc-pill',
          role: 'button',
          title: '恢复侧边对话',
          onClick: () => store.setMinimized(false),
        },
          React.createElement('span', { className: 'dsh-sc-dot' + (runningCount ? ' running' : '') }),
          React.createElement('span', null, '⤳ 侧边对话'),
          runningCount ? React.createElement('span', { className: 'dsh-sc-pill-count' }, runningCount + ' 运行中') : null,
        )
      }

      const selected = chats.find((c) => c.id === selectedId) || null

      const createChat = async () => {
        if (!sessionId) {
          setNotice('请先打开一个会话')
          return
        }
        setNotice('')
        try {
          const res = await host.call('sidechat/open', { mainSessionId: sessionId })
          if (res && res.ok) {
            setSelectedId(res.id)
            refreshState()
          } else {
            setNotice((res && res.error) || '创建失败')
          }
        } catch (err) {
          setNotice('创建失败：' + String(err))
        }
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
          if (res && !res.ok) setNotice(res.error || '关闭失败')
          refreshState()
        } catch (err) {
          setNotice('关闭失败：' + String(err))
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

      const head = React.createElement('div', { className: 'dsh-sc-head' },
        React.createElement('div', { className: 'dsh-sc-head-title' },
          React.createElement('span', { className: 'dsh-sc-head-name' }, '⤳ 侧边对话'),
          React.createElement('span', { className: 'dsh-sc-head-sub' }, '并行会话 · 独立上下文'),
        ),
        React.createElement('button', { className: 'dsh-sc-btn primary', onClick: createChat }, '＋ 新建'),
        React.createElement('button', {
          className: 'dsh-sc-btn',
          onClick: () => store.setMinimized(true),
          title: '缩小到右侧（对话继续运行）',
        }, '—'),
        React.createElement('button', { className: 'dsh-sc-btn', onClick: () => store.setOpen(false), title: '关闭面板' }, '✕'),
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
              className: 'dsh-sc-item' + (c.id === selectedId ? ' sel' : ''),
              onClick: () => setSelectedId(c.id),
            },
              React.createElement('div', { className: 'dsh-sc-item-title' },
                React.createElement('span', { className: 'dsh-sc-item-name' }, c.title),
                React.createElement('span', { className: 'dsh-sc-item-preview' }, c.lastPreview || (c.status === 'running' ? '正在思考…' : '还没有消息')),
              ),
              chipOf(c),
            )),
      )

      const body = selected
        ? React.createElement('div', { ref: msgBoxRef, className: 'dsh-sc-msg' },
            renderedMessages.length === 0
              ? React.createElement('div', { className: 'dsh-sc-empty' }, '还没有消息\n发一句话开始这段并行对话')
              : renderedMessages.map((m, index) => React.createElement('div', {
                  key: index,
                  className: 'dsh-sc-row ' + m.role,
                },
                  React.createElement('div', { className: 'dsh-sc-meta' },
                    React.createElement('span', null, m.role === 'user' ? '你' : '侧对话助手'),
                    React.createElement('span', null, timeOf(m.time)),
                  ),
                  React.createElement('div', { className: 'dsh-sc-bubble' }, m.blocks),
                )),
          )
        : React.createElement('div', { className: 'dsh-sc-msg' },
            React.createElement('div', { className: 'dsh-sc-empty' }, '从上方列表选择一条侧对话\n或点击「＋ 新建」开一条新的'))

      const foot = selected
        ? React.createElement('div', { className: 'dsh-sc-foot' },
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
                title: '停止该侧对话并归档',
              }, '关闭'),
            ),
            React.createElement('div', { className: 'dsh-sc-input' },
              React.createElement('input', {
                value: input,
                placeholder: '输入消息…',
                onChange: (e) => setInput(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') send()
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

      return React.createElement('div', {
        id: 'dsh-sidechat-panel',
        className: dragging ? 'dragging' : null,
        style: { width: width + 'px' },
      },
        resizer,
        head,
        list,
        noticeBar,
        selectedError,
        body,
        foot,
      )
    }

    // ---- Slot 注册 ----
    slots.inject('conversation.session.header.actions', () => slots.register(
      { name: 'conversation.session.header.actions', id: 'sidechat-toggle', order: 30 },
      SideToggle,
    ))
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'sidechat-panel', order: 100 },
      SidePanel,
    ))
  },
}
