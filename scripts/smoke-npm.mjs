/**
 * npm 产物冒烟测试（Node 仿真，无浏览器/无 DSH 进程）：
 *   1. lib/index.js —— Host 适配器：apply 后注册 6 条 /sidechat-api/* 路由，
 *      用假 req/res 调用路由处理器，验证 JSON RPC 语义与错误路径。
 *   2. lib/client.js —— Client bundle：stub window/document/__ModuleLoader__，
 *      验证工厂注册 id、exports.apply/inject、apply 不抛异常。
 *
 * 运行：node scripts/smoke-npm.mjs（先 npm run build）
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0

function ok(cond, label, extra) {
  if (cond) {
    console.log('  ✓ ' + label)
  } else {
    failed += 1
    console.error('  ✗ ' + label + (extra !== undefined ? ' — ' + extra : ''))
  }
}

// ---------------------------------------------------------------------------
// 1. Host 适配器
// ---------------------------------------------------------------------------
console.log('[1] lib/index.js（Host 适配器）')

const requireFromLib = createRequire(join(root, 'lib', 'noop.js'))
const sideChatHost = requireFromLib('./index.js')

ok(typeof sideChatHost === 'function', '导出为插件工厂函数')
ok(Array.isArray(sideChatHost.inject) && sideChatHost.inject.includes('webServer'),
  '声明 inject = [webServer]', JSON.stringify(sideChatHost.inject))

const routes = []
const effects = []
const webServer = {
  register(route) {
    if (routes.some((r) => r.kind === route.kind && r.path === route.path)) {
      throw new Error('duplicate route ' + route.path)
    }
    routes.push(route)
    return () => {
      const at = routes.indexOf(route)
      if (at !== -1) routes.splice(at, 1)
    }
  },
}
const services = {
  agents: { get: () => undefined, create: async () => { throw new Error('不应创建') } },
  sessions: { get: () => undefined, flush: async () => {} },
  sessionQuery: { readSession: async () => ({ events: [] }) },
  commands: { register: () => {} },
  workspaceRegistry: { archiveSession: async () => {} },
}
const ctx = {
  get(name) {
    return name === 'webServer' ? webServer : services[name]
  },
  on() {
    return () => {}
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') effects.push(disposer)
    return () => {}
  },
}

sideChatHost(ctx)

const expectedPaths = [
  '/sidechat-api/sidechat/open',
  '/sidechat-api/sidechat/send',
  '/sidechat-api/sidechat/state',
  '/sidechat-api/sidechat/events',
  '/sidechat-api/sidechat/bring-back',
  '/sidechat-api/sidechat/close',
  '/sidechat-api/sidechat/models',
  '/sidechat-api/sidechat/select-model',
  '/sidechat-api/sidechat/usage',
  '/sidechat-api/sidechat/model-info',
  '/sidechat-api/sidechat/rename',
  '/sidechat-api/sidechat/stop',
  '/sidechat-api/sidechat/answer',
]
for (const path of expectedPaths) {
  ok(routes.some((r) => r.kind === 'exact' && r.path === path), '注册路由 ' + path)
}
ok(routes.length === 13, '恰好 13 条路由', '实际 ' + routes.length)
ok(effects.length === 14, 'ctx.effect 共 14 个（13 路由 + 1 disposeAll）', '实际 ' + effects.length)

async function callRoute(path, rawBody) {
  const route = routes.find((r) => r.path === path)
  if (!route) throw new Error('no route ' + path)
  const req = {
    on(ev, cb) {
      if (ev === 'data') this._data = cb
      if (ev === 'end') this._end = cb
      if (ev === 'error') this._error = cb
    },
  }
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
  }
  const pending = route.handler(req, res)
  if (rawBody !== undefined) req._data(rawBody)
  req._end()
  await pending
  return { status: res.status, json: JSON.parse(res.body) }
}

// 业务语义（复用真实业务层 createSideChatService，服务为 stub）
{
  const r = await callRoute('/sidechat-api/sidechat/state', Buffer.from(JSON.stringify({ mainSessionId: 'm1' })))
  // state RPC 与动态路径同构：直接返回 { chats, version, openSignal }，无 ok 包装
  ok(r.status === 200 && Array.isArray(r.json.chats) && r.json.version === 0 && r.json.openSignal === 0,
    'state → {chats[], version, openSignal}', JSON.stringify(r))
}
{
  const r = await callRoute('/sidechat-api/sidechat/open', Buffer.from(JSON.stringify({ mainSessionId: 'm1' })))
  ok(r.status === 200 && r.json.ok === false && r.json.error === '主会话不在线', 'open（主会话不在线）→ 业务错误', JSON.stringify(r.json))
}
{
  const r = await callRoute('/sidechat-api/sidechat/send', Buffer.from(JSON.stringify({ mainSessionId: 'm1', id: 'x', text: 'hi' })))
  ok(r.status === 200 && r.json.ok === false && r.json.error === '未知侧对话', 'send（未知侧对话）→ 业务错误', JSON.stringify(r.json))
}
{
  const r = await callRoute('/sidechat-api/sidechat/events', Buffer.from(JSON.stringify({})))
  ok(r.status === 200 && r.json.ok === false && r.json.error === '参数缺失', 'events（缺参数）→ 参数校验', JSON.stringify(r.json))
}
{
  const r = await callRoute('/sidechat-api/sidechat/state', Buffer.from('not-json{{{'))
  ok(r.status === 500 && r.json.ok === false && /JSON/.test(r.json.error), '非法 JSON 请求体 → 500 业务错误', JSON.stringify(r))
}
{
  // 回归 B6：openSignal 按主会话隔离——换会话不误触发自动打开
  const fakeAgent = {
    session: { header: { cwd: 'D:\\', agentPreset: 'standard' } },
    options: { provider: 'p', model: 'm', maxTokens: 1 },
    ctx: {},
  }
  const realGet = services.agents.get
  services.agents.get = () => fakeAgent
  services.agents.create = async () => ({ dispose: async () => {} })
  const openRes = await callRoute('/sidechat-api/sidechat/open', Buffer.from(JSON.stringify({ mainSessionId: 'm1' })))
  const st1 = await callRoute('/sidechat-api/sidechat/state', Buffer.from(JSON.stringify({ mainSessionId: 'm1' })))
  const st2 = await callRoute('/sidechat-api/sidechat/state', Buffer.from(JSON.stringify({ mainSessionId: 'm2' })))
  ok(openRes.json.ok === true, '回归前置：open(m1) 成功', JSON.stringify(openRes.json))
  ok(st1.json.openSignal === 1, 'state(m1).openSignal = 1', JSON.stringify(st1.json))
  ok(st2.json.openSignal === 0, 'state(m2).openSignal = 0（换会话不误触发）', JSON.stringify(st2.json))
  services.agents.get = realGet
}
{
  const before = routes.length
  for (const dispose of effects) dispose()
  ok(routes.length === 0 && before === 13, 'fiber 回收后路由全部移除')
}
{
  // 回归：个别组合缺少 workspaceRegistry 时，插件仍激活（降级：跳过归档）
  const routes2 = []
  const ctx2 = {
    get(name) {
      if (name === 'webServer') return { register(route) { routes2.push(route); return () => {} } }
      if (name === 'workspaceRegistry') return undefined
      return services[name]
    },
    on() {
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }
  let threw = false
  try {
    sideChatHost(ctx2)
  } catch (err) {
    threw = true
  }
  ok(!threw, '缺 workspaceRegistry 时 apply 不抛异常')
  ok(routes2.length === 13, '缺 workspaceRegistry 时仍注册 12 条路由', '实际 ' + routes2.length)
}

// ---------------------------------------------------------------------------
// 2. Client bundle
// ---------------------------------------------------------------------------
console.log('[2] lib/client.js（Client bundle）')

const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
let handoff = null
const styleTags = []
globalThis.window = {
  __ModuleLoader__: {
    load(h) {
      handoff = h
    },
  },
}
globalThis.document = {
  head: { appendChild(el) { styleTags.push(el) } },
  createElement(tag) {
    return {
      tag,
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v },
      set textContent(v) { this._text = v },
      get textContent() { return this._text },
    }
  },
  querySelectorAll() { return [] },
}
// 间接 eval：bundle 顶层引用 window（globalThis 解析）
;(0, eval)(bundle)

ok(handoff !== null && handoff.id === 'dsh-side-chat', '注册 __ModuleLoader__ id = dsh-side-chat',
  handoff && handoff.id)
ok(typeof handoff.factory === 'function', 'factory 为函数')

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
const pluginExports = handoff.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('意外 require: ' + spec)
})

ok(typeof pluginExports.apply === 'function', 'exports.apply 为函数')
ok(Array.isArray(pluginExports.inject) && pluginExports.inject.includes('slots'),
  'exports.inject 声明服务名 slots（fiber 等待机制）', JSON.stringify(pluginExports.inject))
ok(styleTags.length === 0, '工厂阶段不注入样式（懒加载语义）')

// apply 冒烟：stub slots + 无 timer（静态路径真实情况）
let slotCalls = 0
const slotsStub = {
  inject() {
    slotCalls += 1
    return () => {}
  },
}
const clientCtx = {
  get(name) {
    return name === 'slots' ? slotsStub : undefined
  },
  on() {
    return () => {}
  },
  effect() {
    return () => {}
  },
}
pluginExports.apply(clientCtx)
ok(slotCalls === 2, 'apply 注册两个 slot（header.actions + shell.overlay）', '实际 ' + slotCalls)
ok(styleTags.length === 1, 'apply 注入面板样式（DOM <style> shim）')
ok(styleTags[0] && styleTags[0].attrs['data-plugin'] === 'dsh-side-chat', '样式标签带 data-plugin')
ok(styleTags[0] && /dsh-sidechat-panel/.test(styleTags[0].textContent), '样式内容为 PANEL_CSS')

// host shim 静态检查：fetch 路由前缀正确（不真正发请求）
const hostSrc = bundle.match(/const host = \{[\s\S]*?\n    \}/)
ok(hostSrc !== null && hostSrc[0].includes('/sidechat-api/'), 'host shim 指向 /sidechat-api/ 前缀')

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
