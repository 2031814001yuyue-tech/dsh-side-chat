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
  /** 已做过「重启后恢复」扫描的主会话（懒执行，一次即可）。 */
  const restoredFor = new Set()
  /** 持久化会话清单缓存（避免每次 state 轮询都全量扫一遍）。 */
  let corpusCache = { at: 0, records: [] }

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

  /** 错误文本（服务层自己用一份；apply() 里也有一份给 RPC 用）。 */
  function messageOf(err) {
    return err && err.message ? String(err.message) : String(err)
  }

  function previewOf(text) {
    const flat = String(text).replace(/\s+/g, ' ').trim()
    return flat.length > 60 ? flat.slice(0, 60) + '…' : flat
  }

  /** 只接受 seq 大于 afterSeq 的 assistant 文本（避免总结回合没产出时回退到旧回复）。 */
  async function lastAssistantTextAfter(sessionId, afterSeq) {
    let snap
    try {
      snap = await sessionQuery.readSession(sessionId)
    } catch (err) {
      return undefined
    }
    const events = snap && Array.isArray(snap.events) ? snap.events : []
    let maxSeq = typeof afterSeq === 'number' ? afterSeq : -1
    for (const event of events) {
      if (event && typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq
    }
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (!event || event.type !== 'assistant/message') continue
      if (typeof afterSeq === 'number' && typeof event.seq === 'number' && event.seq <= afterSeq) break
      const message = event.data && event.data.message
      const text = textOf(message && message.content).trim()
      if (text) return text
    }
    return undefined
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

  /**
   * 重启恢复：DSH 重启后内存注册表是空的，但侧会话本身持久化在磁盘上
   * （header.parentSession 指回主会话、id 以 side- 开头）。
   * 第一次问某个主会话时，扫描持久化清单，把它的侧会话逐个 agents.resume 回来，
   * 重新挂进面板并再次归档（不污染会话列表）。失败的单条只记日志，不影响其它。
   */
  async function restoreFor(mainSessionId, exclude = []) {
    if (!mainSessionId || restoredFor.has(mainSessionId)) return
    // 先占位：并发 RPC（右栏 + 浮层 state）同时进来时只允许一个扫描/恢复，避免同一会话被 resume 两次
    restoredFor.add(mainSessionId)
    const excluded = new Set(exclude.filter((id) => typeof id === 'string'))
    let records = []
    try {
      if (Date.now() - corpusCache.at > 30000) {
        const all = await sessionQuery.listSessions()
        corpusCache = { at: Date.now(), records: Array.isArray(all) ? all : [] }
      }
      records = corpusCache.records.filter((record) => record && record.header
        && record.header.parentSession === mainSessionId
        && typeof record.header.id === 'string'
        && record.header.id.indexOf('side-') === 0)
    } catch (err) {
      // 列举失败回滚占位：清掉缓存，下一次轮询还会重试
      console.error('[side-chat] 列举持久化会话失败', err)
      corpusCache = { at: 0, records: [] }
      restoredFor.delete(mainSessionId)
      return
    }
    for (const record of records) {
      const id = record.header.id
      if (sideChats.has(id)) continue
      try {
        const header = record.header
        // 读一次会话，既用于恢复模型路由（最近一次 request/header），也用于反推继承档位
        let snapshot
        try {
          snapshot = await sessionQuery.readSession(id)
        } catch (err) {
          snapshot = undefined
        }
        const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
        if (excluded.has(id)) continue
        // 路由：优先最近一次 request/header；只有 model/selection 没跑过请求的会话回退到它
        // 路由：request/header 与 model/selection 都记录 seq，取较新的那条
        // （用户切过模型但还没跑下一轮就重启时，model/selection 才是最新的）
        let headerRoute
        let headerSeq = -1
        let recordedSelection
        let selectionSeq = -1
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const event = events[i]
          if (!event) continue
          const seq = typeof event.seq === 'number' ? event.seq : i
          if (event.type === 'request/header' && headerRoute === undefined) {
            const config = event.data && event.data.header && event.data.header.config
            if (config && config.provider && config.model) {
              headerRoute = {
                provider: config.provider,
                model: config.model,
                ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
                ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
              }
              headerSeq = seq
            }
          } else if (event.type === 'model/selection' && recordedSelection === undefined) {
            const selection = event.data
            if (selection && selection.provider && selection.model) {
              recordedSelection = {
                provider: selection.provider,
                model: selection.model,
                ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
              }
              selectionSeq = seq
            }
          }
        }
        const resumeOptions = headerRoute === undefined
          ? recordedSelection
          : recordedSelection === undefined || headerSeq >= selectionSeq
            ? headerRoute
            : recordedSelection
        const handle = await agents.resume({
          resumeSessionId: id,
          ...resumeOptions === undefined ? {} : { agentOptions: resumeOptions },
          setup: (agentCtx) => {
            if (!agentPresets) return undefined
            const mainAgent = agents.get(mainSessionId)
            const joined = mainAgent ? agentPresets.composeFrom(agentCtx, mainAgent.ctx) : undefined
            if (joined === undefined && header.agentPreset) {
              return agentPresets.mount(agentCtx, header.agentPreset).then(() => undefined)
            }
            return undefined
          },
        })
        // readTitle 在不同版本里可能返回字符串或标题快照对象：统一取字符串
        let title
        try {
          const raw = await sessionQuery.readTitle(id)
          const text = typeof raw === 'string' ? raw : raw && typeof raw.title === 'string' ? raw.title : undefined
          title = text ? String(text).slice(0, 120) : undefined
        } catch (err) {
          title = undefined
        }
        // 继承档位没有单独持久化：从创建时注入的 notice 摘要反推。
        // 注意注入可能以 user/message 落盘，也可能在 agent/inbox/spliced 里（未消费的 inbox）。
        let inheritMode = null
        try {
          const noticeText = (message) => {
            const source = message && message.source
            if (!source || source.kind !== 'sidechat') return undefined
            if (typeof source.summary !== 'string' || source.summary.indexOf('继承自主对话的') !== 0) return undefined
            return source.summary
          }
          for (const event of events) {
            if (!event) continue
            const candidates = event.type === 'user/message'
              ? [event.data]
              : event.type === 'agent/inbox/spliced' && event.data && Array.isArray(event.data.inserted)
                ? event.data.inserted
                : []
            const notice = candidates.map(noticeText).find(Boolean)
            if (notice) {
              inheritMode = notice.indexOf('完整') >= 0 ? 'full' : 'recent'
              break
            }
          }
        } catch (err) {
          inheritMode = null
        }
        counter += 1
        sideChats.set(id, {
          sideId: id,
          sessionId: id,
          mainSessionId,
          title: title || ('侧对话 #' + counter),
          status: 'idle',
          error: null,
          handle,
          updatedAt: Date.now(),
          bringingBack: false,
          lastPreview: '',
          selection: undefined,
          inheritMode,
          restored: true,
        })
        if (workspaceRegistry) {
          try {
            await workspaceRegistry.archiveSession(id)
          } catch (err) {
            console.error('[side-chat] 恢复后归档失败', err)
          }
        }
      } catch (err) {
        console.error('[side-chat] 恢复侧对话 ' + id + ' 失败（该会话可能正被其它窗口占用）', err)
      }
    }
    if (records.length) {
      bumpVersion()
      console.log('[side-chat] 已恢复 ' + records.length + ' 条侧对话（主会话 ' + mainSessionId + '）')
    }
  }

  /** 选择项规范化：provider/model 必须都在，reasoningEffort 可选。 */
  function normalizeSelection(value) {
    if (!value || typeof value !== 'object') return undefined
    const provider = typeof value.provider === 'string' ? value.provider : ''
    const model = typeof value.model === 'string' ? value.model : ''
    if (!provider || !model) return undefined
    const out = { provider, model }
    if (typeof value.reasoningEffort === 'string' && value.reasoningEffort) out.reasoningEffort = value.reasoningEffort
    return out
  }

  /** 侧对话当前实际使用的模型：优先问 agent 自己（它会跟随 model/selection 事件）。 */
  function selectionOf(entry) {
    const agent = agents.get(entry.sessionId)
    if (agent && agent.model && typeof agent.model.current === 'function') {
      try {
        const current = agent.model.current()
        if (current && current.provider && current.model) {
          return {
            provider: current.provider,
            model: current.model,
            ...current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort },
          }
        }
      } catch (err) {
        /* 读取失败时回退到创建时记录的选择 */
      }
    }
    return entry.selection || null
  }

  /** 可切换的模型目录：按 provider 分组，拿不到目录的 provider 直接跳过。 */
  async function modelCatalog() {
    const llm = services.llm
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      return { ok: true, providers: [] }
    }
    const providers = []
    for (const provider of llm.listProviders()) {
      if (!provider || !provider.id) continue
      try {
        const models = await llm.listModels(provider.id)
        providers.push({
          provider: provider.id,
          name: provider.name || provider.id,
          models: (Array.isArray(models) ? models : []).map((model) => ({
            id: model.id,
            name: model.name || model.id,
            ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
          })),
        })
      } catch (err) {
        // 未配置/不可发现的 provider：跳过，不影响其它 provider
      }
    }
    return { ok: true, providers }
  }

  /** 单个模型的精确信息（含 reasoning 档位）：目录里只有名字，effort 必须按模型精确查询。 */
  async function modelInfo(provider, model) {
    const llm = services.llm
    if (!llm || typeof llm.resolveModelInfo !== 'function' || !provider || !model) {
      return { ok: true, info: null }
    }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      if (!info) return { ok: true, info: null }
      return {
        ok: true,
        info: {
          provider: info.provider || provider,
          id: info.id || model,
          reasoning: info.reasoning || null,
          ...info.contextWindow === undefined ? {} : { contextWindow: info.contextWindow },
        },
      }
    } catch (err) {
      return { ok: false, error: '读取模型信息失败：' + messageOf(err) }
    }
  }

  /** 切换一条侧对话的模型：校验可用后写入该侧会话的 model/selection 事件。 */
  async function selectModel(mainSessionId, sideId, selection) {
    await restoreFor(mainSessionId)
    const entry = entryOf(mainSessionId, sideId)
    if (!entry) return { ok: false, error: '未知侧对话' }
    const sideAgent = agents.get(entry.sessionId)
    if (!sideAgent || !sideAgent.model || typeof sideAgent.model.select !== 'function') {
      return { ok: false, error: '侧对话 agent 不在线' }
    }
    const chosen = normalizeSelection(selection)
    if (!chosen) return { ok: false, error: '参数缺失' }
    const llm = services.llm
    if (llm && typeof llm.resolveCallConfig === 'function') {
      try {
        await llm.resolveCallConfig(chosen)
      } catch (err) {
        return { ok: false, error: '该模型不可用：' + (err && err.message ? String(err.message) : String(err)) }
      }
    }
    sideAgent.model.select(chosen)
    entry.selection = chosen
    entry.updatedAt = Date.now()
    bumpVersion()
    return { ok: true, selection: chosen }
  }

  /**
   * 继承主对话上下文：把主会话「最近的若干轮」用户/助手文本抓出来，作为一条隐藏的
   * plugin 注入消息交给侧 agent。
   * 只带对话文字，工具调用/工具结果一律不继承。
   * 两种范围：
   *   recent（默认）—— 最近 ≤20 条消息、≤2 万字，够「我们在聊什么」的近期背景；
   *   full          —— 主对话里全部用户/助手文字（同样不含工具）。
   * 主对话没有已完成回合时返回 undefined（只能开独立上下文）。
   */
  const INHERIT_RECENT_TURNS = 10
  const INHERIT_RECENT_CHARS = 20000
  /** 继承模式规范化：true 视为 recent；未知值视为不继承。 */
  function normalizeInheritMode(value) {
    if (value === true) return 'recent'
    if (value === 'recent' || value === 'full') return value
    return null
  }
  async function buildInheritedContext(mainSessionId, mode) {
    let events
    const live = sessions.get(mainSessionId)
    if (live && typeof live.snapshotEvents === 'function') {
      events = live.snapshotEvents()
    } else {
      try {
        const snap = await sessionQuery.readSession(mainSessionId)
        events = snap && Array.isArray(snap.events) ? snap.events : []
      } catch (err) {
        return undefined
      }
    }
    if (!Array.isArray(events) || events.length === 0) return undefined
    // 只继承已收尾的回合：末尾正在跑的那一轮状态不完整
    let end = -1
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i] && events[i].type === 'turn/end') {
        end = i
        break
      }
    }
    if (end < 0) return undefined
    const recent = mode !== 'full'
    const picked = []
    let chars = 0
    for (let i = end; i >= 0; i -= 1) {
      const event = events[i]
      if (!event) continue
      let role
      let text
      if (event.type === 'user/message') {
        const source = event.data && event.data.source
        if (!source || source.kind !== 'user') continue
        text = textOf(event.data && event.data.content).trim()
        role = '用户'
      } else if (event.type === 'assistant/message') {
        text = textOf(event.data && event.data.message && event.data.message.content).trim()
        role = '助手'
      } else {
        continue
      }
      if (!text) continue
      if (recent) {
        const remaining = INHERIT_RECENT_CHARS - chars
        if (remaining <= 0) break
        // 单条消息也受预算约束：先截断再入列，避免一条超长回复把 2 万字上限撑破
        if (text.length > remaining) text = text.slice(0, remaining) + '…'
      }
      picked.push({ role, text })
      chars += text.length
      if (recent && (chars >= INHERIT_RECENT_CHARS || picked.length >= INHERIT_RECENT_TURNS * 2)) break
    }
    if (!picked.length) return undefined
    picked.reverse()
    const body = picked.map((item) => item.role + '：' + item.text).join('\n\n')
    const head = recent
      ? '【继承自主对话的最近上下文】\n以下是最新一轮往来里最近的' + picked.length + ' 条对话'
      : '【继承自主对话的完整上下文】\n以下是主对话的全部对话（共 ' + picked.length + ' 条）'
    return {
      mode,
      messageCount: picked.length,
      text: head
        + '，只包含用户与助手的文字，不含工具调用与工具输出。\n'
        + '它只作为背景参考：不需要复述，也不要当成新的用户指令。\n\n'
        + body,
    }
  }

  /** 停止当前回合：调用 agent 的 cancel（等价主对话的「停止」）。 */
  async function stop(mainSessionId, sideId) {
    await restoreFor(mainSessionId)
    const entry = entryOf(mainSessionId, sideId)
    if (!entry) return { ok: false, error: '未知侧对话' }
    if (entry.bringingBack) return { ok: false, error: '正在带回中，稍后再试' }
    const sideAgent = agents.get(entry.sessionId)
    if (!sideAgent) return { ok: false, error: '侧对话不在线' }
    if (entry.status !== 'running' || typeof sideAgent.cancel !== 'function') return { ok: true, stopped: false }
    try {
      // 与 DSH 自己的停止一致：传 aborted 原因，turn/end 会记录
      sideAgent.cancel({ kind: 'aborted' })
    } catch (err) {
      try {
        sideAgent.cancel(new Error('用户停止'))
      } catch (inner) {
        return { ok: false, error: '停止失败：' + messageOf(inner) }
      }
    }
    entry.status = 'idle'
    entry.updatedAt = Date.now()
    bumpVersion()
    return { ok: true, stopped: true }
  }

  /** 重命名：优先用会话标题服务的 rename（会 supersede 自动标题），否则直接写 session/title 事件。 */
  async function rename(mainSessionId, sideId, title) {
    await restoreFor(mainSessionId)
    const entry = entryOf(mainSessionId, sideId)
    if (!entry) return { ok: false, error: '未知侧对话' }
    if (typeof title !== 'string') return { ok: false, error: '标题必须是字符串' }
    const next = title.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!next) return { ok: false, error: '标题不能为空' }
    const sideAgent = agents.get(entry.sessionId)
    const session = sideAgent && sideAgent.session
    if (!session) return { ok: false, error: '侧对话不在线' }
    try {
      const titles = services.sessionTitle
      if (titles && typeof titles.rename === 'function') {
        await titles.rename(session, next)
      } else {
        session.append('session/title', { title: next, messageSeqs: [], source: { kind: 'user' } })
      }
    } catch (err) {
      return { ok: false, error: '改名失败：' + messageOf(err) }
    }
    entry.title = next
    entry.updatedAt = Date.now()
    bumpVersion()
    return { ok: true, title: next }
  }

  /** 侧对话花费：交给计费插件（dsh-cost-meter）的 costMeter 服务；缺失时返回 null。 */
  async function usage(mainSessionId, sideId) {
    await restoreFor(mainSessionId)
    const entry = entryOf(mainSessionId, sideId)
    if (!entry) return { ok: false, error: '未知侧对话' }
    const costMeter = services.costMeter
    if (!costMeter || typeof costMeter.getSessionCost !== 'function') return { ok: true, usage: null }
    let raw
    try {
      raw = await costMeter.getSessionCost(entry.sessionId)
    } catch (err) {
      return { ok: false, error: '读取费用失败：' + messageOf(err) }
    }
    const own = raw && typeof raw === 'object' ? raw.own : undefined
    if (!own || typeof own !== 'object') return { ok: true, usage: null }
    const pick = (key) => (typeof own[key] === 'number' ? own[key] : undefined)
    return {
      ok: true,
      usage: {
        costCny: pick('costCny'),
        cost: pick('cost'),
        input: pick('input'),
        output: pick('output'),
        cacheRead: pick('cacheRead'),
        cacheWrite: pick('cacheWrite'),
        calls: pick('calls'),
      },
    }
  }

  /** 创建一条侧对话：真实 agent 会话，继承主会话组合；模型默认继承主会话，也可指定。
   *  inherit = 'recent' | 'full'（或 true）时，把主对话的对话文字作为背景注入；
   *  工具调用不继承。 */
  async function open(mainSessionId, firstMessage, selection, inherit) {
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
    const mainOptions = (mainAgent && mainAgent.options) || {}
    const effectivePreset = (agentPresets && agentPresets.composedPreset(mainAgent.ctx)) || mainAgent.session.header.agentPreset
    // 模型：默认继承主会话当前路由（创建时快照），调用方也可指定别的模型。
    // 优先取主 agent 记录的 model/selection（含推理强度），退回创建时的 options。
    let inheritedSelection
    try {
      inheritedSelection = mainAgent.model && typeof mainAgent.model.current === 'function'
        ? normalizeSelection(mainAgent.model.current())
        : undefined
    } catch (err) {
      inheritedSelection = undefined
    }
    if (!inheritedSelection) {
      inheritedSelection = normalizeSelection({
        provider: mainOptions.provider,
        model: mainOptions.model,
        reasoningEffort: mainOptions.reasoningEffort,
      })
    }
    const initialSelection = normalizeSelection(selection) || inheritedSelection
    // 主会话可能完全依赖默认路由（options 里没有 provider/model、model.current() 也拿不到完整选择）：
    // 这种时候不要写死这两个字段，交给 agents.create 的默认值，避免解构时抛错。
    const initialRoute = initialSelection === undefined
      ? {}
      : {
          provider: initialSelection.provider,
          model: initialSelection.model,
          ...initialSelection.reasoningEffort === undefined ? {} : { reasoningEffort: initialSelection.reasoningEffort },
        }
    // 继承上下文：把主对话的对话文字抓成一段背景，等 agent 建好后以隐藏注入的方式交给它。
    const inheritMode = normalizeInheritMode(inherit)
    let inherited
    if (inheritMode) inherited = await buildInheritedContext(mainSessionId, inheritMode)
    const handle = await agents.create({
      sessionId: sideId,
      meta: {
        cwd: mainAgent.session.header.cwd,
        parentSession: mainSessionId,
        agentPreset: effectivePreset,
      },
      agentOptions: {
        ...initialRoute,
        ...mainOptions.maxTokens === undefined ? {} : { maxTokens: mainOptions.maxTokens },
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
      selection: initialSelection,
      inheritMode: inherited ? inherited.mode : null,
    }
    sideChats.set(sideId, entry)
    // 继承来的上下文以 plugin 来源注入：agent 能看到，面板不会铺开（events() 过滤 plugin）
    if (inherited) {
      const sideAgent = agents.get(sideId)
      if (sideAgent && typeof sideAgent.inject === 'function') {
        try {
          sideAgent.inject({
            id: 'side-inherit-' + Date.now(),
            role: 'user',
            content: [{ type: 'text', text: inherited.text }],
            source: {
              // v4 会话格式拒绝 retired 的 kind:'plugin'，来源必须是生产者自己的名字
              kind: 'sidechat',
              form: 'notice',
              summary: '继承自主对话的'
                + (inherited.mode === 'full' ? '完整' : '最近')
                + '上下文（' + inherited.messageCount + ' 条对话）',
            },
          })
        } catch (err) {
          console.error('[side-chat] 注入继承上下文失败', err)
        }
      }
    }
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
    return {
      ok: true,
      id: sideId,
      title,
      inherit: Boolean(inherited),
      inheritMode: inherited ? inherited.mode : null,
      ...inheritMode && inherited === undefined
        ? { notice: '主对话还没有已完成的回合，这条侧对话改成了独立上下文' }
        : {},
    }
  }

  /** 向侧对话注入一条真实用户消息并唤醒侧 agent。 */
  async function send(mainSessionId, sideId, text) {
    await restoreFor(mainSessionId)
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
  async function state(mainSessionId, exclude) {
    await restoreFor(mainSessionId, exclude)
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
        selection: selectionOf(entry),
        inherit: Boolean(entry.inheritMode),
        inheritMode: entry.inheritMode || null,
      })
    }
    chats.sort((a, b) => a.updatedAt - b.updatedAt)
    return { chats, version, openSignal: openSignals.get(mainSessionId) || 0 }
  }

  /** 面板消息流：只保留真实用户输入与助手回复，过滤系统注入与总结请求。 */
  async function events(mainSessionId, sideId) {
    await restoreFor(mainSessionId)
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
        const content = message && Array.isArray(message.content) ? message.content : []
        const text = textOf(content).trim()
        // 思考过程：DSH 的 reasoning 块（主对话里可折叠显示，这里同样带出去）
        const thinking = content
          .filter((block) => block && block.type === 'reasoning' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n\n')
          .trim()
        if (text || thinking) {
          messages.push({
            role: 'assistant',
            text,
            ...thinking ? { thinking } : {},
            time: event.time,
          })
        }
      }
    }
    if (messages.length) {
      entry.updatedAt = messages[messages.length - 1].time
      entry.lastPreview = previewOf(messages[messages.length - 1].text)
    }
    // 逐步骤进度（伪流式）：DSH 没有 token 级增量事件，但会话日志会按 step 落
    // assistant/message(reasoning+tool-call) / tool/result，把这些抽成 trace，
    // 面板 1s 轮询就能看到「思考 → 调工具 → 结果 → 下一步」逐步出现。
    const allEvents = snap && Array.isArray(snap.events) ? snap.events : []
    let turnStart = -1
    for (let i = allEvents.length - 1; i >= 0; i -= 1) {
      const event = allEvents[i]
      const source = event && event.type === 'user/message' ? event.data && event.data.source : undefined
      if (source && source.kind === 'user') {
        turnStart = i
        break
      }
    }
    const trace = []
    for (let i = Math.max(0, turnStart + 1); i < allEvents.length; i += 1) {
      const event = allEvents[i]
      if (!event) continue
      if (event.type === 'turn/end') {
        trace.length = 0
        continue
      }
      if (event.type === 'assistant/message') {
        const content = event.data && event.data.message && Array.isArray(event.data.message.content)
          ? event.data.message.content
          : []
        for (const block of content) {
          if (!block) continue
          if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
            trace.push({ kind: 'thinking', text: block.text.trim().slice(0, 240), time: event.time })
          } else if (block.type === 'tool-call') {
            const name = block.name || (block.tool && block.tool.name) || '工具'
            trace.push({ kind: 'tool', text: String(name), time: event.time })
          }
        }
      } else if (event.type === 'tool/result') {
        const text = textOf(event.data && event.data.message && event.data.message.content).trim()
        if (text) trace.push({ kind: 'result', text: text.slice(0, 300), time: event.time })
      }
    }
    // 等待用户回答的 ask_user_question（工具已调用、还没拿到 tool/result）：
    // 侧面板没有交互式问答 UI，至少要把它显示出来，别让用户觉得「卡住没反应」。
    let question = null
    for (let i = allEvents.length - 1; i >= 0; i -= 1) {
      const event = allEvents[i]
      if (!event || event.type !== 'tool/call') continue
      const data = event.data || {}
      if (data.name !== 'ask_user_question') continue
      const callId = data.callId || data.id
      let answered = false
      for (let j = i + 1; j < allEvents.length; j += 1) {
        const later = allEvents[j]
        if (!later) continue
        if (later.type === 'turn/end') {
          answered = true
          break
        }
        if (later.type === 'tool/result') {
          const laterData = later.data || {}
          if (callId === undefined || laterData.callId === callId || laterData.id === callId) {
            answered = true
            break
          }
        }
      }
      if (answered) break
      try {
        const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
        const first = args && Array.isArray(args.questions) ? args.questions[0] : undefined
        if (first) {
          question = {
            text: String(first.question || first.title || '').slice(0, 500),
            detail: first.detail === undefined ? undefined : String(first.detail).slice(0, 400),
            options: Array.isArray(first.options)
              ? first.options.map((option) => String((option && (option.label || option.value)) || '')).filter(Boolean).slice(0, 6)
              : [],
          }
        }
      } catch (err) {
        question = { text: '（问题内容解析失败，可点「停止」中断这一轮）', options: [] }
      }
      break
    }
    return {
      ok: true,
      messages,
      trace: trace.slice(-12),
      running: entry.status === 'running' || entry.bringingBack === true,
      ...question ? { question } : {},
    }
  }

  /** 带回主对话：侧 agent 自总结 → notice 折叠行注入主会话（不唤醒主 agent）。 */
  async function bringBack(mainSessionId, sideId) {
    await restoreFor(mainSessionId)
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
    // 记录投递前的最大 seq：只接受之后新增的 assistant 文本作为总结
    let baselineSeq = -1
    try {
      const baseline = await sessionQuery.readSession(entry.sessionId)
      for (const event of baseline && Array.isArray(baseline.events) ? baseline.events : []) {
        if (event && typeof event.seq === 'number' && event.seq > baselineSeq) baselineSeq = event.seq
      }
    } catch (err) {
      baselineSeq = -1
    }
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
      const summary = await lastAssistantTextAfter(entry.sessionId, baselineSeq)
      if (!summary) return { ok: false, error: '未能生成总结（这一轮没有产出文字）' }
      mainAgent.inject({
        id: 'side-inject-' + Date.now(),
        role: 'user',
        content: [{ type: 'text', text: '【' + entry.title + ' 摘要】\n' + summary }],
        source: {
          kind: 'sidechat',
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
  /** 归档一条侧对话：按 DSH 的归档逻辑（停止活动 + 进归档集合）。
   *  面板侧不再恢复它：客户端把 id 记进 localStorage，之后每次 state 都带 exclude，
   *  宿主恢复时跳过这些 id（名单丢了最坏情况是被重新恢复出来，不会丢数据）。 */
  async function close(mainSessionId, sideId) {
    await restoreFor(mainSessionId)
    const entry = entryOf(mainSessionId, sideId)
    if (!entry) return { ok: false, error: '未知侧对话' }
    sideChats.delete(sideId)
    if (workspaceRegistry) {
      try {
        await workspaceRegistry.archiveSession(entry.sessionId, { stopActivity: true })
      } catch (err) {
        console.error('[side-chat] 归档失败', err)
      }
    }
    try {
      await entry.handle.dispose()
    } catch (err) {
      // 归档已停掉活动时 dispose 可能已无效，忽略
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

  return { open, send, state, events, bringBack, close, stop, modelCatalog, modelInfo, selectModel, rename, usage, onAgentStatus, onAgentError, disposeAll }
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
      // 可选：模型目录（换模型用）。缺失时面板不显示模型选择器。
      llm: ctx.get('llm'),
      // 可选：计费插件（dsh-cost-meter）暴露的服务，用它的 getSessionCost 读侧会话花费。
      costMeter: ctx.get('costMeter'),
      // 可选：会话标题服务（重命名走它的 rename；缺失时直接写 session/title 事件）
      sessionTitle: ctx.get('sessionTitle'),
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
      // inherit 可以是 'recent' / 'full'（旧调用方传 true 视为 recent）
      return sideChat.open(mainSessionId, firstMessage, args && args.selection, args && args.inherit)
    })
    // 可切换的模型目录（按 provider 分组；服务缺失时返回空列表）
    registerRpc('sidechat/models', () => sideChat.modelCatalog())
    // 精确模型信息（推理强度档位等）：只对当前生效模型按需查询
    registerRpc('sidechat/model-info', (args) => {
      const provider = strArg(args, 'provider')
      const model = strArg(args, 'model')
      if (!provider || !model) return { ok: false, error: '参数缺失' }
      return sideChat.modelInfo(provider, model)
    })
    // 切换某条侧对话的模型（写入该侧会话的 model/selection，下一轮生效）
    registerRpc('sidechat/select-model', (args) => {
      const mainSessionId = strArg(args, 'mainSessionId')
      const sideId = strArg(args, 'id')
      if (!mainSessionId || !sideId) return { ok: false, error: '参数缺失' }
      return sideChat.selectModel(mainSessionId, sideId, args && args.selection)
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
      // exclude：客户端记录的「已归档」侧会话 id，重启恢复时跳过
      const exclude = Array.isArray(args && args.exclude) ? args.exclude.slice(0, 400) : []
      return sideChat.state(mainSessionId, exclude)
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
    // 停止侧对话当前回合
    registerRpc('sidechat/stop', (args) => {
      const mainSessionId = strArg(args, 'mainSessionId')
      const sideId = strArg(args, 'id')
      if (!mainSessionId || !sideId) return { ok: false, error: '参数缺失' }
      return sideChat.stop(mainSessionId, sideId)
    })
    // 重命名侧对话（写 session/title，重启恢复后标题仍然是新的）
    registerRpc('sidechat/rename', (args) => {
      const mainSessionId = strArg(args, 'mainSessionId')
      const sideId = strArg(args, 'id')
      if (!mainSessionId || !sideId) return { ok: false, error: '参数缺失' }
      return sideChat.rename(mainSessionId, sideId, args && args.title)
    })
    // 侧对话花费（依赖计费插件；缺失时返回 usage: null）
    registerRpc('sidechat/usage', (args) => {
      const mainSessionId = strArg(args, 'mainSessionId')
      const sideId = strArg(args, 'id')
      if (!mainSessionId || !sideId) return { ok: false, error: '参数缺失' }
      return sideChat.usage(mainSessionId, sideId)
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
