/**
 * DSH Side Chat — Host 半体。
 * 每条侧对话 = 一个真实并行 agent 会话（同 preset、同工作区、独立上下文）。
 * 提供 /side 命令与 6 个 Package-private RPC，供 Client 面板调用。
 *
 * 结构（重构后）：
 *   createSideChatService() —— 业务封装：注册表 + open/send/state/events/bringBack/close
 *                               + 状态监听回调 + disposeAll，不依赖 apply 作用域
 *   apply()                —— 装配层：取服务 → 建服务 → 挂事件 → 注册 RPC/命令 → 清理
 * 本文件即动态 Cordis 插件源码：以函数体格式加载（顶层 return 插件对象）。
 */

const CONFIG = {
  maxSide: 8,
  summaryPrompt: '请用中文把这次侧边对话总结成一段简洁的结论（300 字以内），只输出总结正文，不要任何前缀、标题或客套话。',
}

/**
 * 侧对话业务封装：注册表与全部业务方法，与插件装配解耦。
 * @param {{agents:object, sessions:object, sessionQuery:object, workspaceRegistry:object, agentPresets:object}} services
 * @param {{maxSide:number, summaryPrompt:string}} config
 */
function createSideChatService(services, config) {
  const { agents, sessions, sessionQuery, workspaceRegistry, agentPresets } = services

  /** @type {Map<string, {sideId:string, sessionId:string, mainSessionId:string, title:string, status:string, error:string|null, handle:object, updatedAt:number, bringingBack:boolean, lastPreview:string}>} */
  const sideChats = new Map()
  let counter = 0
  let version = 0
  /** 每主会话的 openSignal（open() 时递增，state() 按主会话返回）：
   *  全局计数会让「换会话」误触发自动打开（新挂载的 ⤳ 按钮基线为 0）。 */
  const openSignals = new Map()

  function bumpVersion() {
    version += 1
  }

  function entryOf(mainSessionId, sideId) {
    const entry = sideChats.get(sideId)
    return entry && entry.mainSessionId === mainSessionId ? entry : undefined
  }

  function textOf(content) {
    if (!Array.isArray(content)) return ''
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
  }

  function previewOf(text) {
    const flat = String(text).replace(/\s+/g, ' ').trim()
    return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
  }

  async function lastAssistantText(sessionId) {
    let snap
    try {
      snap = await sessionQuery.readSession(sessionId)
    } catch (err) {
      console.error('[side-chat] readSession 失败', err)
      return undefined
    }
    const events = snap && Array.isArray(snap.events) ? snap.events : []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (!event || event.type !== 'assistant/message') continue
      const message = event.data && event.data.message
      const text = textOf(message && message.content).trim()
      if (text) return text
    }
    return undefined
  }

  /** 创建一条侧对话：真实 agent 会话，继承主会话组合与模型路由。 */
  async function open(mainSessionId, firstMessage) {
    const mainAgent = agents.get(mainSessionId)
    if (!mainAgent) return { ok: false, error: '主会话不在线' }
    let count = 0
    for (const entry of sideChats.values()) {
      if (entry.mainSessionId === mainSessionId) count += 1
    }
    if (count >= config.maxSide) return { ok: false, error: '侧边对话数量已达上限（' + config.maxSide + '）' }
    counter += 1
    const sideId = 'side-' + Date.now() + '-' + counter
    const title = '侧对话 #' + counter
    // 经 agents.create 创建：注册表以自身真实 ctx 作为 ownerCtx（沙箱 ctx 不暴露 fiber，
    // 不能直接传给 agentLoop.createAgent）；句柄由我们显式 dispose 回收。
    // 组合继承：header.agentPreset 只是创建事实，不会自动挂载组合（实测侧 agent 只有
    // 全局工具）；必须在 setup 里 composeFrom 加入主 agent 的同一 standing 组合
    // （同工具注册、同 prompt 段）。composedPreset 读作用域链，header 可能落后于
    // agent-preset/selected 事件，故实时解析作为回退。
    const effectivePreset = (agentPresets && agentPresets.composedPreset(mainAgent.ctx)) || mainAgent.session.header.agentPreset
    const handle = await agents.create({
      sessionId: sideId,
      meta: {
        cwd: mainAgent.session.header.cwd,
        parentSession: mainSessionId,
        agentPreset: effectivePreset,
      },
      agentOptions: {
        provider: mainAgent.options.provider,
        model: mainAgent.options.model,
        maxTokens: mainAgent.options.maxTokens,
      },
      setup: (agentCtx) => {
        if (!agentPresets) return undefined
        const joined = agentPresets.composeFrom(agentCtx, mainAgent.ctx)
        // 父 agent 未加入任何 preset（无 roster 部署）：退回按 id 挂载
        if (joined === undefined && effectivePreset) {
          return agentPresets.mount(agentCtx, effectivePreset).then(() => undefined)
        }
        return undefined
      },
    })
    const entry = {
      sideId,
      sessionId: sideId,
      mainSessionId,
      title,
      status: 'idle',
      error: null,
      handle,
      updatedAt: Date.now(),
      bringingBack: false,
      lastPreview: '',
    }
    sideChats.set(sideId, entry)
    openSignals.set(mainSessionId, (openSignals.get(mainSessionId) || 0) + 1)
    bumpVersion()
    // 创建即归档：从会话列表/搜索中隐藏（归档只是列表记账，不影响 agent 生命周期）
    if (workspaceRegistry) {
      try {
        await workspaceRegistry.archiveSession(sideId)
      } catch (err) {
        console.error('[side-chat] 归档失败（该会话将出现在会话列表中）', err)
      }
    }
    if (firstMessage) {
      const res = await send(mainSessionId, sideId, firstMessage)
      if (!res.ok) return { ok: false, error: '已创建但首条消息发送失败：' + res.error }
    }
    return { ok: true, id: sideId, title }
  }

  /** 向侧对话注入一条真实用户消息并唤醒侧 agent。 */
  async function send(mainSessionId, sideId, text) {
    const entry = entryOf(mainSessionId, sideId)
    if (!entry) return { ok: false, error: '未知侧对话' }
    const trimmed = String(text || '').trim()
    if (!trimmed) return { ok: false, error: '消息不能为空' }
    const sideAgent = agents.get(entry.sessionId)
    if (!sideAgent) return { ok: false, error: '侧对话 agent 不在线' }
    sideAgent.send({
      id: 'side-msg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
      role: 'user',
      content: [{ type: 'text', text: trimmed }],
      source: { kind: 'user' },
    }, 'next-turn', true)
    entry.updatedAt = Date.now()
    return { ok: true }
  }

  /** 面板轮询状态：侧对话列表 + 版本 + 自动开面板信号。 */
  function state(mainSessionId) {
    const chats = []
    for (const entry of sideChats.values()) {
      if (entry.mainSessionId !== mainSessionId) continue
      chats.push({
        id: entry.sideId,
        title: entry.title,
        status: entry.status,
        error: entry.error,
        lastPreview: entry.lastPreview || '',
        updatedAt: entry.updatedAt,
      })
    }
    chats.sort((a, b) => a.updatedAt - b.updatedAt)
    return { chats, version, openSignal: openSignals.get(mainSessionId) || 0 }
  }

  /** 面板消息流：只保留真实用户输入与助手回复，过滤系统注入与总结请求。 */
  async function events(mainSessionId, sideId) {
    const entry = entryOf(mainSessionId, sideId)
    if (!entry) return { ok: false, error: '未知侧对话' }
    let snap
    try {
      snap = await sessionQuery.readSession(entry.sessionId)
    } catch (err) {
      return { ok: false, error: '读取会话失败' }
    }
    const messages = []
    for (const event of (snap && Array.isArray(snap.events) ? snap.events : [])) {
      if (!event) continue
      if (event.type === 'user/message') {
        // 只保留真实用户输入（source.kind === 'user'）；系统注入
        // （runtime context、技能目录、system-reminder 等 plugin 来源）不进面板；
        // 带回主对话的总结请求（side-sum-*）也隐藏，只显示助手生成的摘要回复
        const source = event.data && event.data.source
        if (!source || source.kind !== 'user') continue
        const msgId = event.data && event.data.id
        if (typeof msgId === 'string' && msgId.indexOf('side-sum-') === 0) continue
        const text = textOf(event.data && event.data.content).trim()
        if (text) messages.push({ role: 'user', text, time: event.time })
      } else if (event.type === 'assistant/message') {
        const message = event.data && event.data.message
        const text = textOf(message && message.content).trim()
        if (text) messages.push({ role: 'assistant', text, time: event.time })
      }
    }
    if (messages.length) {
      entry.updatedAt = messages[messages.length - 1].time
      entry.lastPreview = previewOf(messages[messages.length - 1].text)
    }
    return { ok: true, messages }
  }

  /** 带回主对话：侧 agent 自总结 → notice 折叠行注入主会话（不唤醒主 agent）。 */
  async function bringBack(mainSessionId, sideId) {
    const entry = entryOf(mainSessionId, sideId)
    if (!entry) return { ok: false, error: '未知侧对话' }
    if (entry.bringingBack) return { ok: false, error: '正在带回中，请稍候' }
    const mainAgent = agents.get(mainSessionId)
    if (!mainAgent) return { ok: false, error: '主会话不在线' }
    if (mainAgent.status === 'running') return { ok: false, error: 'main-busy' }
    const sideAgent = agents.get(entry.sessionId)
    if (!sideAgent) return { ok: false, error: '侧对话 agent 不在线' }
    // B3 修复：先置位防重标志，再投递总结请求，消除并发窗口
    entry.status = 'running'
    entry.bringingBack = true
    try {
      sideAgent.send({
        id: 'side-sum-' + Date.now(),
        role: 'user',
        content: [{ type: 'text', text: config.summaryPrompt }],
        source: { kind: 'user' },
      }, 'next-turn', true)
      try {
        await sideAgent.whenIdle()
      } catch (err) {
        console.error('[side-chat] whenIdle 失败', err)
      }
      const sideSession = sessions.get(entry.sessionId)
      if (sideSession) {
        try {
          await sessions.flush(sideSession)
        } catch (err) {
          console.error('[side-chat] flush 失败', err)
        }
      }
      entry.status = 'idle'
      const summary = await lastAssistantText(entry.sessionId)
      if (!summary) return { ok: false, error: '未能生成总结' }
      mainAgent.inject({
        id: 'side-inject-' + Date.now(),
        role: 'user',
        content: [{ type: 'text', text: '【' + entry.title + ' 摘要】\n' + summary }],
        source: {
          kind: 'plugin',
          plugin: 'sidechat',
          form: 'notice',
          summary: entry.title + ' 摘要已注入（点击展开）',
        },
      })
      entry.updatedAt = Date.now()
      return { ok: true, summary }
    } finally {
      entry.bringingBack = false
      if (entry.status === 'running') entry.status = 'idle'
    }
  }

  /** 关闭侧对话：停止 agent、归档会话、移出注册表。 */
  async function close(mainSessionId, sideId) {
    const entry = entryOf(mainSessionId, sideId)
    if (!entry) return { ok: false, error: '未知侧对话' }
    sideChats.delete(sideId)
    try {
      await entry.handle.dispose()
    } catch (err) {
      console.error('[side-chat] dispose 失败', err)
    }
    if (workspaceRegistry) {
      try {
        await workspaceRegistry.archiveSession(entry.sessionId)
      } catch (err) {
        console.error('[side-chat] 归档失败', err)
      }
    }
    bumpVersion()
    return { ok: true }
  }

  /** agent/status 事件回调：同步状态；B4 修复——新一轮开始清除旧错误。 */
  function onAgentStatus(agentId, status) {
    const entry = sideChats.get(agentId)
    if (!entry) return
    entry.status = status
    if (status === 'running') entry.error = null
    entry.updatedAt = Date.now()
  }

  /** agent/error 事件回调：记录错误信息。 */
  function onAgentError(agentId, error) {
    const entry = sideChats.get(agentId)
    if (!entry) return
    entry.error = error && error.message ? String(error.message) : String(error)
    entry.updatedAt = Date.now()
  }

  /** 插件停止时清理所有侧对话。 */
  function disposeAll() {
    for (const entry of sideChats.values()) {
      try {
        entry.handle.dispose()
      } catch (err) {
        console.error('[side-chat] 清理失败', err)
      }
    }
    sideChats.clear()
  }

  return { open, send, state, events, bringBack, close, onAgentStatus, onAgentError, disposeAll }
}

return {
  apply(ctx) {
    const services = {
      agents: ctx.get('agents'),
      sessions: ctx.get('sessions'),
      sessionQuery: ctx.get('sessionQuery'),
      commands: ctx.get('commands'),
      workspaceRegistry: ctx.get('workspaceRegistry'),
      agentPresets: ctx.get('agentPresets'),
    }
    const required = ['agents', 'sessions', 'sessionQuery', 'commands']
    // workspaceRegistry（dsh-workspace）在 web profile 的 host 平面通常存在；
    // 个别组合缺失时降级运行：跳过归档（侧会话会出现在会话列表），插件仍激活。
    for (const name of required) {
      if (!services[name]) {
        console.error('[side-chat] 缺少必需服务：' + name + '，插件未启用')
        return
      }
    }

    const sideChat = createSideChatService(services, CONFIG)

    // ---- 事件监听：状态同步 ----
    ctx.on('agent/status', ({ agent, status }) => sideChat.onAgentStatus(agent.id, status))
    ctx.on('agent/error', ({ agent, error }) => sideChat.onAgentError(agent.id, error))

    // ---- RPC（Client 面板）----
    registerRpc('sidechat/open', (args) => {
      const mainSessionId = strArg(args, 'mainSessionId')
      const firstMessage = args && typeof args.firstMessage === 'string' ? args.firstMessage : ''
      if (!mainSessionId) return { ok: false, error: '缺少主会话 ID' }
      return sideChat.open(mainSessionId, firstMessage)
    })
    registerRpc('sidechat/send', (args) => {
      const mainSessionId = strArg(args, 'mainSessionId')
      const sideId = strArg(args, 'id')
      const text = strArg(args, 'text')
      if (!mainSessionId || !sideId) return { ok: false, error: '参数缺失' }
      return sideChat.send(mainSessionId, sideId, text)
    })
    registerRpc('sidechat/state', (args) => {
      const mainSessionId = strArg(args, 'mainSessionId')
      if (!mainSessionId) return { ok: false, error: '缺少主会话 ID' }
      return sideChat.state(mainSessionId)
    })
    registerRpc('sidechat/events', (args) => {
      const mainSessionId = strArg(args, 'mainSessionId')
      const sideId = strArg(args, 'id')
      if (!mainSessionId || !sideId) return { ok: false, error: '参数缺失' }
      return sideChat.events(mainSessionId, sideId)
    })
    registerRpc('sidechat/bring-back', (args) => {
      const mainSessionId = strArg(args, 'mainSessionId')
      const sideId = strArg(args, 'id')
      if (!mainSessionId || !sideId) return { ok: false, error: '参数缺失' }
      return sideChat.bringBack(mainSessionId, sideId)
    })
    registerRpc('sidechat/close', (args) => {
      const mainSessionId = strArg(args, 'mainSessionId')
      const sideId = strArg(args, 'id')
      if (!mainSessionId || !sideId) return { ok: false, error: '参数缺失' }
      return sideChat.close(mainSessionId, sideId)
    })

    // ---- /side 命令 ----
    services.commands.register({
      name: 'side',
      description: '打开一条并行侧边对话（独立上下文，结果可摘要带回主对话）',
      input: { hint: '首条消息（可选）' },
      handler: async (invocation) => {
        const first = invocation.rawInput.trim()
        try {
          const res = await sideChat.open(invocation.agent.id, first || undefined)
          if (!res.ok) return { kind: 'error', text: res.error }
          return { kind: 'success', text: '已创建' + res.title + '（' + res.id + '）' }
        } catch (err) {
          return { kind: 'error', text: messageOf(err) }
        }
      },
    })

    // ---- 插件停止时清理所有侧对话 ----
    ctx.effect(() => () => sideChat.disposeAll())

    // ---- 内部助手 ----
    function registerRpc(method, handler) {
      harness.handle(method, async (args) => {
        try {
          return await handler(args)
        } catch (err) {
          console.error('[side-chat] ' + method + ' 失败', err)
          return { ok: false, error: messageOf(err) }
        }
      })
    }

    function strArg(args, key) {
      return String((args && args[key]) || '')
    }

    function messageOf(err) {
      return err && err.message ? String(err.message) : String(err)
    }
  },
}
