/**
 * 无浏览器、无 HTTP 监听的最小宿主：加载真实插件模块，捕获它注册的路由与工具，
 * 再用伪造的 req/res 直接调用，从而在 Node 里跑完整的"请求 → 绑定 → 插件 → 文件"链路。
 *
 * 只用既有 Cordis 契约里插件真正用到的那几个入口：
 *   ctx.get(name)、ctx.effect(fn)、ctx.inject(deps, cb)、ctx.on(...)
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadPlugin(dir) {
  const entry = path.join(dir, 'index.js')
  // 查询串让每个测试拿到新的模块实例（等价于宿主里禁用再启用插件）。
  return await import(pathToFileURL(entry).href + `?inst=${Date.now()}-${Math.random().toString(16).slice(2)}`)
}

export function makeHost({ workspaces = [], sessions = {}, effectiveCwd = {}, cwd = process.cwd() } = {}) {
  const routes = new Map()
  const tools = new Map()
  const disposers = []
  const sessionOf = id => {
    if (!sessions[id]) return undefined
    const session = { header: { cwd: sessions[id] } }
    // 模拟 workingDirectory.set()：header.cwd 不变，有效目录已经切走。
    if (effectiveCwd[id]) session.effectiveCwd = effectiveCwd[id]
    return session
  }
  const services = {
    workspaceRegistry: { list: () => workspaces.map(row => ({ ...row, sessionIds: [] })) },
    sessions: { get: sessionOf },
    workingDirectory: {
      defaultDirectory: cwd,
      get: session => session?.effectiveCwd || session?.header?.cwd || cwd,
    },
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
    },
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
    },
  }
  const ctx = {
    get: name => services[name],
    effect: (fn, label) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    inject: (deps, callback) => { const dispose = callback(ctx); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    on: () => () => {},
  }
  return { ctx, routes, tools, services, disposers }
}

export async function request(handler, { method = 'GET', path: routePath = '/', headers = {}, body, hostContext } = {}) {
  const listeners = {}
  const queue = []
  let ended = false
  let wake = null
  const req = {
    method,
    url: routePath,
    headers: { host: '127.0.0.1:52006', 'sec-fetch-site': 'same-origin', ...headers },
    on(event, callback) { listeners[event] = callback; return req },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) { yield queue.shift(); continue }
        if (ended) return
        await new Promise(resolve => { wake = resolve })
      }
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(text) { this.body = text; this.done = true },
  }
  // 宿主注入的页面上下文：只有测试/宿主能放到 req 上，客户端头/体不能冒充。
  if (hostContext !== undefined) req.hostContext = hostContext
  const settled = handler(req, res)
  if (body !== undefined) {
    const chunk = Buffer.from(JSON.stringify(body), 'utf8')
    setImmediate(() => {
      queue.push(chunk)
      if (listeners.data) listeners.data(chunk)
      ended = true
      if (listeners.end) listeners.end()
      if (wake) { const resolve = wake; wake = null; resolve() }
    })
  }
  await settled
  const text = res.body ?? ''
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { status: res.statusCode, json, text, headers: res.headers }
}

export function pageHeaders(pageId, extra = {}) {
  return { 'x-dsh-page': pageId, ...extra }
}
