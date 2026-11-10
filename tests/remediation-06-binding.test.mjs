/**
 * 06 阶段页面身份与绑定（U01-A/U01-B/U02-A）回归。
 *
 * 这里刻意加载四个真实的 client.js，用它们自己的预置段创建页面身份；
 * 同时用真实 study-ops 路由 + 真实研究核心验证宿主侧工作区校验与旧令牌拒绝。
 * 不读取任何真实研究数据。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadPlugin, makeHost, request } from './harness.mjs'
import {
  PAGE_KEY,
  datasetDraftKey,
  focusKey,
  planDraftKey,
  pluginPageKey,
  safeSegment,
} from '../client-identity.mjs'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..')
const CLIENT_FILES = {
  'study-ops': path.join(PLUGIN_ROOT, 'study-ops', 'client.js'),
  'scale-desk': path.join(PLUGIN_ROOT, 'scale-desk', 'client.js'),
  'demographic-coder': path.join(PLUGIN_ROOT, 'demographic-coder', 'client.js'),
  'analysis-run': path.join(PLUGIN_ROOT, 'analysis-run', 'client.js'),
}
const ALL_PLUGINS = Object.keys(CLIENT_FILES)
const clientSource = Object.fromEntries(Object.entries(CLIENT_FILES).map(([name, file]) => [name, readFileSync(file, 'utf8')]))

/* ------------------------------------------------------------------ *
 * 浏览器替身：真实 client.js + 每标签独立 sessionStorage/window
 * ------------------------------------------------------------------ */

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}))
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null },
    setItem(key, value) { map.set(key, String(value)) },
    removeItem(key) { map.delete(key) },
    key(index) { return [...map.keys()][index] ?? null },
    get length() { return map.size },
    dump() { return Object.fromEntries(map) },
  }
}

function throwingStorage() {
  const fail = () => { throw new Error('storage disabled') }
  return { getItem: fail, setItem: fail, removeItem: fail, key: fail, get length() { return fail() } }
}

function makeBus() {
  const tabs = new Set()
  return { tabs }
}

function channelClass(bus) {
  return class FakeBroadcastChannel {
    constructor(name) { this.name = name; this.handlers = []; bus.tabs.add(this) }
    addEventListener(type, handler) { if (type === 'message') this.handlers.push(handler) }
    removeEventListener() { /* not needed */ }
    postMessage(data) {
      for (const tab of [...bus.tabs]) {
        if (tab === this) continue
        for (const handler of [...tab.handlers]) queueMicrotask(() => handler({ data }))
      }
    }
    close() { bus.tabs.delete(this) }
  }
}

function reactShim() {
  const base = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    Fragment: Symbol('Fragment'),
    Component: class { constructor(props) { this.props = props; this.state = {} } },
  }
  const hooks = {
    useState: value => [value, () => {}],
    useReducer: (_reducer, value) => [value, () => {}],
    useRef: value => ({ current: value }),
    useMemo: fn => fn(),
    useCallback: fn => fn(),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useImperativeHandle: () => {},
    useDebugValue: () => {},
  }
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key]
      if (key in hooks) return hooks[key]
      return () => {}
    },
  })
}

function fakeUiWorkspace(workspaceId, workspacePath) {
  return {
    selection: { getSnapshot: () => ({ sessionId: 'session-1' }) },
    workspaces: {
      list: { getSnapshot: () => ({ items: [{ workspaceId, path: workspacePath, sessionIds: ['session-1'] }] }) },
    },
  }
}

/**
 * 在一个“标签页”里执行四个真实 client bundle。
 * 返回每个插件 factory 的导出（含 identity 测试钩子）与 apply 用的 ctx。
 */
function loadTab(options = {}) {
  const specs = []
  const storage = options.sessionStorage || memoryStorage()
  const local = options.localStorage || memoryStorage()
  const bus = options.bus || null
  const BroadcastChannel = bus ? channelClass(bus) : undefined
  const win = {
    __ModuleLoader__: { load(spec) { specs.push(spec) } },
    crypto: {
      getRandomValues(bytes) {
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
      },
    },
    sessionStorage: storage,
    localStorage: local,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  }
  if (BroadcastChannel) win.BroadcastChannel = BroadcastChannel
  const document = {
    createElement: () => ({ textContent: '', remove() {}, appendChild() {}, dataset: {} }),
    head: { appendChild() {} },
    querySelector: () => null,
    getElementById: () => null,
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  }
  const plugins = options.plugins || ALL_PLUGINS
  const modules = []
  for (const plugin of plugins) {
    const source = clientSource[plugin]
    // 真实 bundle 的 window/document/storage 参数就是页面运行环境。
    new Function('window', 'document', 'sessionStorage', 'localStorage', 'crypto', 'BroadcastChannel', source)(
      win, document, storage, local, win.crypto, BroadcastChannel,
    )
  }
  const ui = options.workspace ? fakeUiWorkspace(options.workspace.id, options.workspace.path) : null
  const ctx = {
    get(name) { return name === 'uiWorkspace' ? ui : undefined },
    effect(run) { const dispose = run(); return typeof dispose === 'function' ? dispose : () => {} },
    inject(_deps, callback) { return callback(ctx) },
    on() { return () => {} },
    slots: {
      inject(_name, callback) { return callback() },
      register() { return () => {} },
    },
  }
  const require = name => {
    if (name === 'react') return reactShim()
    throw new Error('未知模块：' + name)
  }
  for (const spec of specs) {
    const module = spec.factory(require)
    module.apply(ctx)
    modules.push({ id: spec.id, ...module })
  }
  return { win, ctx, modules, storage, local, closeChannels() { for (const tab of [...bus.tabs]) tab.close() } }
}

function identityOf(tab, plugin) {
  const module = tab.modules.find(row => row.id === '@local/' + plugin)
  assert.ok(module && module.identity, `没有拿到 ${plugin} 的页面身份`)
  return module.identity
}

function writeStudy(dir, studyId) {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'study.json')
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    studyId,
    name: `合成研究 ${studyId}`,
    dataRoot: './data',
    participantId: { pattern: '^P-\\d{3}$' },
    visits: [{ id: 'v1', label: '基线' }],
    tasks: [],
    followups: [],
    plugins: {},
  }, null, 2), 'utf8')
  return file
}

/* ------------------------------------------------------------------ *
 * U01-A：两页两工作区，四插件共享 pageId、不串工作区
 * ------------------------------------------------------------------ */

test('U01-A 两标签两工作区：四插件 pageId 一致、工作区不串，刷新保持', async () => {
  const bus = makeBus()
  const storeA = memoryStorage()
  const storeB = memoryStorage()
  const tabA = loadTab({ sessionStorage: storeA, bus, workspace: { id: 'ws-a', path: 'D:/ws/a' } })
  const tabB = loadTab({ sessionStorage: storeB, bus, workspace: { id: 'ws-b', path: 'D:/ws/b' } })

  const collect = async tab => {
    const rows = []
    for (const plugin of ALL_PLUGINS) {
      const identity = identityOf(tab, plugin)
      await identity.ready()
      const snapshot = identity.prepare(tab.ctx)
      rows.push({ plugin, snapshot, headers: identity.headers(), body: identity.body() })
    }
    return rows
  }
  const rowsA = await collect(tabA)
  const rowsB = await collect(tabB)

  const pageIdsA = new Set(rowsA.map(row => row.snapshot.pageId))
  const pageIdsB = new Set(rowsB.map(row => row.snapshot.pageId))
  assert.equal(pageIdsA.size, 1, '同一标签四插件必须共用一个 pageId')
  assert.equal(pageIdsB.size, 1, '同一标签四插件必须共用一个 pageId')
  const [pageA] = [...pageIdsA]
  const [pageB] = [...pageIdsB]
  assert.match(pageA, /^[A-Za-z0-9_-]{8,80}$/)
  assert.notEqual(pageA, pageB, '两个标签不能共用 pageId')
  for (const row of rowsA) {
    assert.equal(row.headers['x-dsh-page'], pageA, row.plugin)
    assert.equal(row.headers['x-dsh-workspace'], 'ws-a', row.plugin)
    assert.equal(row.body.pageId, pageA, row.plugin)
    assert.equal(row.body.workspaceId, 'ws-a', row.plugin)
  }
  for (const row of rowsB) {
    assert.equal(row.headers['x-dsh-page'], pageB, row.plugin)
    assert.equal(row.headers['x-dsh-workspace'], 'ws-b', row.plugin)
    assert.equal(row.body.workspaceId, 'ws-b', row.plugin)
  }

  // 首次生成立即写 sessionStorage：共享键 + 每个插件的带前缀键都在。
  const dumped = storeA.dump()
  assert.equal(dumped[PAGE_KEY], pageA)
  for (const plugin of ALL_PLUGINS) assert.equal(dumped[pluginPageKey(plugin)], pageA, pluginPageKey(plugin))
  assert.equal(storeB.dump()[PAGE_KEY], pageB)

  // 刷新（同一标签、同一 storage、同一 tab 指纹）必须保持 pageId。
  const api = tabA.win.__DSH_RESEARCH_CLIENT_IDENTITY__
  const reloaded = api.createClientIdentity({
    plugin: 'study-ops',
    storage: storeA,
    global: tabA.win,
    workspaceProvider: ctx => api.workspaceFromContext(ctx),
  })
  await reloaded.ready()
  assert.equal(reloaded.pageId(), pageA, '刷新后 pageId 应保持')
})

/* ------------------------------------------------------------------ *
 * U01-B：克隆标签与无 storage
 * ------------------------------------------------------------------ */

test('U01-B 克隆标签复制 sessionStorage 时换新身份；storage 抛错/为空时进程内唯一且不共享 fallback', async () => {
  const bus = makeBus()
  const sourceStore = memoryStorage()
  const original = loadTab({ sessionStorage: sourceStore, bus, plugins: ['study-ops'], workspace: { id: 'ws-a', path: 'D:/ws/a' } })
  const originalIdentity = identityOf(original, 'study-ops')
  await originalIdentity.ready()
  const originalId = originalIdentity.pageId()

  // 克隆标签：浏览器复制 sessionStorage，但 window/tab 指纹不同。
  const cloneStore = memoryStorage(sourceStore.dump())
  const clone = loadTab({ sessionStorage: cloneStore, bus, plugins: ['study-ops'], workspace: { id: 'ws-a', path: 'D:/ws/a' } })
  const cloneIdentity = identityOf(clone, 'study-ops')
  await cloneIdentity.ready()
  assert.notEqual(cloneIdentity.pageId(), originalId, '克隆标签不能沿用原标签的 pageId')
  assert.equal(cloneStore.dump()[PAGE_KEY], cloneIdentity.pageId(), '克隆标签应把新身份写回自己的 sessionStorage')
  assert.equal(sourceStore.dump()[PAGE_KEY], originalId, '原标签身份不能被克隆改动')

  // storage 抛错（隐私模式/禁用）：同一标签四插件仍共用一个进程内唯一 ID。
  const denied = loadTab({ sessionStorage: throwingStorage(), plugins: ALL_PLUGINS, workspace: { id: 'ws-c', path: 'D:/ws/c' } })
  const deniedIds = []
  for (const plugin of ALL_PLUGINS) {
    const identity = identityOf(denied, plugin)
    await identity.ready()
    identity.prepare(denied.ctx)
    deniedIds.push(identity.pageId())
  }
  assert.equal(new Set(deniedIds).size, 1, '无 storage 时同标签四插件仍要一致')
  assert.match(deniedIds[0], /^[A-Za-z0-9_-]{8,80}$/)
  assert.notEqual(deniedIds[0], 'pagemem00000001', '不能退回所有页面共用的 fallback 常量')
  assert.notEqual(deniedIds[0], originalId)

  const deniedOther = loadTab({ sessionStorage: throwingStorage(), plugins: ['study-ops'], workspace: { id: 'ws-d', path: 'D:/ws/d' } })
  const otherIdentity = identityOf(deniedOther, 'study-ops')
  await otherIdentity.ready()
  assert.notEqual(otherIdentity.pageId(), deniedIds[0], '不同标签的进程内 fallback 必须彼此不同')

  // storage 为空（读得到 null）时也生成独立身份，而不是共用常量。
  const empty = loadTab({ sessionStorage: memoryStorage(), plugins: ['study-ops'], workspace: { id: 'ws-e', path: 'D:/ws/e' } })
  const emptyIdentity = identityOf(empty, 'study-ops')
  await emptyIdentity.ready()
  assert.match(emptyIdentity.pageId(), /^[A-Za-z0-9_-]{8,80}$/)
  assert.notEqual(emptyIdentity.pageId(), 'pagemem00000001')
})

/* ------------------------------------------------------------------ *
 * U02-A 客户端：capture 本次 binding，晚到旧响应不覆盖新页面
 * ------------------------------------------------------------------ */

test('U02-A 四插件切换工作区递增绑定代次，晚到旧响应按 workspace/study/instance 拒绝', async () => {
  const tab = loadTab({ sessionStorage: memoryStorage(), workspace: { id: 'ws-a', path: 'D:/ws/a' } })
  for (const plugin of ALL_PLUGINS) {
    const identity = identityOf(tab, plugin)
    await identity.ready()
    identity.prepare(tab.ctx)
    identity.remember({ token: 'token-a1', studyId: 'study-a', instanceId: 'inst-a', bindingRevision: 1, workspaceId: 'ws-a' })
    const ticketA = identity.capture()
    assert.equal(ticketA.workspaceId, 'ws-a')
    assert.equal(ticketA.studyId, 'study-a')
    // 同一绑定的并发请求（如 status + load）都有效，不能因为"后发先至"互相判过时。
    const concurrent = identity.capture()
    assert.doesNotThrow(() => identity.assertResponse(concurrent, { token: 'token-a1', studyId: 'study-a', instanceId: 'inst-a', workspaceId: 'ws-a' }))

    // 同标签切到 B：本地绑定代次 +1，旧令牌清空。
    identity.setWorkspace({ id: 'ws-b', path: 'D:/ws/b' })
    assert.equal(identity.binding(), null)
    identity.remember({ token: 'token-b', studyId: 'study-b', instanceId: 'inst-b', bindingRevision: 2, workspaceId: 'ws-b' })
    const ticketB = identity.capture()
    assert.ok(ticketB.bindingRevision > ticketA.bindingRevision, plugin + ' 切换工作区必须推进绑定版本')
    assert.equal(ticketB.studyId, 'study-b')

    // 晚到的 A 响应：即使研究编号相同，也因工作区代次变化被丢弃。
    assert.throws(
      () => identity.assertResponse(ticketA, { token: 'token-a1', studyId: 'study-a', instanceId: 'inst-a', bindingRevision: 1, workspaceId: 'ws-a' }),
      error => error.code === 'stale_response' && /工作区|绑定/.test(error.message),
      plugin + ' 旧响应必须被拒绝',
    )
    // A 的页面/工作区快照也不能用于 B 的响应。
    assert.throws(
      () => identity.assertResponse(ticketA, { token: 'token-b', studyId: 'study-b', instanceId: 'inst-b', workspaceId: 'ws-b' }),
      error => error.code === 'stale_response',
    )

    assert.equal(identity.accept(ticketB, { token: 'token-b', studyId: 'study-b', instanceId: 'inst-b', workspaceId: 'ws-b' }).token, 'token-b')

    // A→B→A：B 的旧快照不能再覆盖回到 A 的页面。
    identity.setWorkspace({ id: 'ws-a', path: 'D:/ws/a' })
    assert.throws(
      () => identity.assertResponse(ticketB, { token: 'token-b', studyId: 'study-b', instanceId: 'inst-b', workspaceId: 'ws-b' }),
      error => error.code === 'stale_response',
    )
    identity.remember({ token: 'token-a2', studyId: 'study-a', instanceId: 'inst-a', bindingRevision: 3, workspaceId: 'ws-a' })
    const ticketA2 = identity.capture()
    assert.equal(identity.accept(ticketA2, { token: 'token-a2', studyId: 'study-a', instanceId: 'inst-a', workspaceId: 'ws-a' }).token, 'token-a2')

    // 即使工作区/代次相同，响应里的研究编号或实例不一致也不能落进当前状态。
    assert.throws(
      () => identity.assertResponse(ticketA2, { token: 'token-x', studyId: 'study-other', instanceId: 'inst-a', workspaceId: 'ws-a' }),
      error => error.code === 'stale_response' && /研究/.test(error.message),
    )
    assert.throws(
      () => identity.assertResponse(ticketA2, { token: 'token-x', studyId: 'study-a', instanceId: 'inst-other', workspaceId: 'ws-a' }),
      error => error.code === 'stale_response',
    )

    // 换新页面：旧快照立即失效。
    identity.newPage()
    assert.throws(() => identity.assertResponse(ticketA2, null), error => error.code === 'stale_response')
  }
})

/* ------------------------------------------------------------------ *
 * U02-A 宿主：页面工作区校验、旧令牌写 B 被拒、A→B→A 失效
 * ------------------------------------------------------------------ */

test('U02-A 宿主只信注入的工作区：旧 A 令牌不能写 B，同研究换工作区也推进版本', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-r06-binding-'))
  const wsA = path.join(root, 'ws-a')
  const wsB = path.join(root, 'ws-b')
  const store = path.join(root, 'store')
  process.env.DSH_RESEARCH_STORE = store
  const fileA = writeStudy(wsA, 'study-a')
  const fileB = writeStudy(wsB, 'study-b')
  const shared = path.join(root, 'shared')
  const fileShared = writeStudy(shared, 'study-shared')

  const host = makeHost({
    workspaces: [{ id: 'ws-a', path: wsA }, { id: 'ws-b', path: wsB }],
    cwd: path.join(root, 'no-workspace'),
  })
  const plugin = await loadPlugin(path.join(PLUGIN_ROOT, 'study-ops'))
  plugin.apply(host.ctx, { studyPath: '' })
  const handler = host.routes.get('/api/study-ops')
  assert.ok(handler)

  const post = (action, payload, pageId, workspace, extra = {}) => request(handler, {
    method: 'POST',
    path: '/api/study-ops',
    headers: {
      'x-study-ops': '1',
      'content-type': 'application/json',
      'x-dsh-page': pageId,
      ...(workspace ? { 'x-dsh-workspace': workspace } : {}),
      ...(extra.headers || {}),
    },
    body: { action, payload },
    ...(extra.hostContext ? { hostContext: extra.hostContext } : {}),
  })
  const get = (action, pageId, workspace) => request(handler, {
    path: `/api/study-ops?action=${action}`,
    headers: { 'x-study-ops': '1', 'x-dsh-page': pageId, ...(workspace ? { 'x-dsh-workspace': workspace } : {}) },
  })
  const pageId = 'page-u02a00001'

  // 缺令牌仍然拒绝（保持现有行为）。
  const noToken = await post('refresh', {}, pageId, 'ws-a')
  assert.equal(noToken.status, 409)
  assert.equal(noToken.json.error.code, 'binding_required')

  // 页面不能自己声明 sessionId 冒充会话（头与载荷两条路径都要拒绝）。
  const fakeSession = await post('refresh', {}, pageId, 'ws-a', { headers: { 'x-dsh-session': 'session-other' } })
  assert.equal(fakeSession.status, 400)
  assert.equal(fakeSession.json.error.code, 'actor')
  const fakeSessionBody = await post('refresh', { sessionId: 'session-other' }, pageId, 'ws-a')
  assert.equal(fakeSessionBody.status, 400)
  assert.equal(fakeSessionBody.json.error.code, 'actor')

  // 未登记的工作区、客户端与宿主注入不一致都拒绝。
  const unknownWorkspace = await post('studyConnect', { studyPath: fileA }, pageId, 'ws-unknown')
  assert.equal(unknownWorkspace.status, 409)
  assert.equal(unknownWorkspace.json.error.code, 'workspace_mismatch')
  const mismatch = await post('studyConnect', { studyPath: fileA }, pageId, 'ws-b', {
    hostContext: { workspaceId: 'ws-a', workspacePath: wsA },
  })
  assert.equal(mismatch.status, 409)
  assert.equal(mismatch.json.error.code, 'workspace_mismatch')

  // 页面 A 连接研究 A。
  const connectA = await post('studyConnect', { studyPath: fileA }, pageId, 'ws-a')
  assert.equal(connectA.status, 200, connectA.text)
  assert.equal(connectA.json.data.study.id, 'study-a')
  assert.equal(connectA.json.data.binding.workspaceId, 'ws-a')
  const tokenA = connectA.json.data.binding.token
  const statusA = await get('status', pageId, 'ws-a')
  assert.equal(statusA.json.data.study.id, 'study-a')
  assert.equal(statusA.json.data.binding.token, tokenA)

  // 同一页面切到 B：绑定版本推进，B 的研究是 B。
  const connectB = await post('studyConnect', { studyPath: fileB }, pageId, 'ws-b')
  assert.equal(connectB.status, 200, connectB.text)
  assert.equal(connectB.json.data.study.id, 'study-b')
  assert.equal(connectB.json.data.binding.workspaceId, 'ws-b')
  const tokenB = connectB.json.data.binding.token
  assert.ok(connectB.json.data.binding.bindingRevision > statusA.json.data.binding.bindingRevision)

  // 旧 A 令牌在 B 中写入：拒绝，且 B 的绑定仍是 B。
  const staleWrite = await post('refresh', { binding: tokenA, studyId: 'study-b' }, pageId, 'ws-b')
  assert.equal(staleWrite.status, 409, staleWrite.text)
  assert.equal(staleWrite.json.error.code, 'binding_conflict')
  const statusBAfter = await get('status', pageId, 'ws-b')
  assert.equal(statusBAfter.json.data.study.id, 'study-b')
  assert.equal(statusBAfter.json.data.binding.token, tokenB)

  // A→B→A：旧 A 令牌失效，新 A 令牌可用。
  const connectA2 = await post('studyConnect', { studyPath: fileA }, pageId, 'ws-a')
  assert.equal(connectA2.status, 200, connectA2.text)
  const tokenA2 = connectA2.json.data.binding.token
  assert.ok(connectA2.json.data.binding.bindingRevision > connectB.json.data.binding.bindingRevision)
  const oldA = await post('refresh', { binding: tokenA }, pageId, 'ws-a')
  assert.equal(oldA.status, 409)
  assert.equal(oldA.json.error.code, 'binding_conflict')
  const freshA = await post('refresh', { binding: tokenA2 }, pageId, 'ws-a')
  assert.equal(freshA.status, 200, freshA.text)

  // 同一研究在两个工作区之间切换：研究没变也要推进版本，旧令牌不能跨区写。
  const sameA = await post('studyConnect', { studyPath: fileShared }, 'page-shared001', 'ws-a')
  const sameAToken = sameA.json.data.binding.token
  const sameB = await post('studyConnect', { studyPath: fileShared }, 'page-shared001', 'ws-b')
  assert.equal(sameB.status, 200, sameB.text)
  assert.equal(sameB.json.data.binding.studyPath, fileShared)
  assert.ok(sameB.json.data.binding.bindingRevision > sameA.json.data.binding.bindingRevision, '同研究换工作区也必须推进绑定版本')
  const sameOld = await post('refresh', { binding: sameAToken }, 'page-shared001', 'ws-b')
  assert.equal(sameOld.status, 409)
  assert.equal(sameOld.json.error.code, 'binding_conflict')

  // 宿主注入的页面上下文优先：注入 A 时页面报 B 会被拒绝，不能靠头冒充。
  const injected = await post('refresh', {}, pageId, 'ws-b', { hostContext: { workspaceId: 'ws-a', workspacePath: wsA } })
  assert.equal(injected.status, 409)
  assert.equal(injected.json.error.code, 'workspace_mismatch')
})

/* ------------------------------------------------------------------ *
 * 草稿/存储键：instanceId + 数据集，不只 studyId
 * ------------------------------------------------------------------ */

test('U01/U02 草稿与存储键含 instanceId 与数据集，不同实例/数据集不交叉恢复', () => {
  const first = { instanceId: 'inst-1', studyId: 'study-x', dataRoot: 'D:/data/x', studyPath: 'D:/studies/x/study.json' }
  const second = { ...first, instanceId: 'inst-2' }
  const otherData = { ...first, dataRoot: 'D:/data/y', studyPath: 'D:/studies/y/study.json' }

  assert.match(focusKey(first), /inst-1/)
  assert.match(focusKey(first), new RegExp(safeSegment(first.dataRoot)))
  assert.notEqual(focusKey(first), focusKey(second), '实例不同时焦点草稿不能复用')
  assert.notEqual(focusKey(first), focusKey(otherData), '数据集不同时焦点草稿不能复用')

  const plan = planDraftKey(first, 'D:/data/x/analysis/plan.csv', 'study-x')
  assert.match(plan, /inst-1/)
  assert.match(plan, new RegExp(safeSegment('D:/data/x/analysis/plan.csv')))
  assert.notEqual(plan, planDraftKey(second, 'D:/data/x/analysis/plan.csv', 'study-x'))
  assert.notEqual(plan, planDraftKey(first, 'D:/data/y/analysis/plan.csv', 'study-x'))

  const draft = datasetDraftKey('dc:dataset:v3', first, '人口学')
  assert.match(draft, /inst-1/)
  assert.notEqual(draft, datasetDraftKey('dc:dataset:v3', second, '人口学'))

  // 真实 client bundle 必须调用这些键，而不是只按 studyId 存。
  assert.match(clientSource['study-ops'], /identity\.focusKey\(\)/)
  assert.match(clientSource['analysis-run'], /identityApi\.planDraftKey|identity\.planDraftKey/)
  assert.match(clientSource['demographic-coder'], /dc:dataset:v3/)
  for (const plugin of ALL_PLUGINS) {
    assert.doesNotMatch(clientSource[plugin], /pagemem00000001/, plugin + ' 不能保留共用 fallback 常量')
    assert.doesNotMatch(clientSource[plugin], /localStorage\.getItem\(PAGE_KEY\s*\+\s*':default'\)/, plugin + ' 不能再用 localStorage default 作为页面身份')
  }
})

/* ------------------------------------------------------------------ *
 * 预置段与共享模块必须同源
 * ------------------------------------------------------------------ */

test('四份 client 的页面身份预置段与 research-core/client-identity.mjs 保持同步', () => {
  const moduleText = readFileSync(path.join(PLUGIN_ROOT, 'research-core', 'client-identity.mjs'), 'utf8')
  const begin = '// #region browser-core'
  const end = '// #endregion browser-core'
  const core = moduleText.slice(moduleText.indexOf(begin) + begin.length, moduleText.indexOf(end)).trimEnd()
  assert.ok(core.length > 1000)
  for (const plugin of ALL_PLUGINS) {
    assert.ok(clientSource[plugin].includes(core), plugin + ' 的预置段已与 client-identity.mjs 漂移；运行 research-core/scripts/sync-client-identity.mjs')
    assert.ok(clientSource[plugin].includes('createClientIdentity'))
  }
})
