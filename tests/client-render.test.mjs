/**
 * 客户端渲染冒烟测试：用最小 React 替身把 study-ops 面板渲染一遍。
 *
 * 目的：浏览器里"页面空白"通常是渲染期抛错（slot entry crashed），而这种错误
 * node --check 抓不到、宿主侧测试也看不到。这里喂入真实的 status / flowProjection
 * 响应，强制 Panel 的初始 state，再同步渲染整棵树；任何组件抛错都会让测试失败。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'

function makeReactShim() {
  const frames = []
  const forced = { values: null }
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) })
  function render(node) {
    if (node === null || node === undefined || node === false || node === true) return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { for (const child of node) render(child); return }
    if (typeof node !== 'object' || !node.type) throw new Error('意外的节点：' + String(node))
    const { type, props, children } = node
    if (typeof type === 'function') {
      frames.push({ forced: frames.length === 0 ? forced.values : null, index: 0 })
      try { render(type(props)) } finally { frames.pop() }
      return
    }
    for (const child of children) render(child)
  }
  const React = {
    createElement,
    useState(initial) {
      const frame = frames[frames.length - 1]
      const list = frame && frame.forced
      let value = initial
      if (list && frame.index < list.length) value = list[frame.index]
      if (frame) frame.index += 1
      return [value, () => {}]
    },
    useEffect() {},
    useCallback(fn) { return fn },
    useRef(initial) { return { current: initial } },
  }
  return { React, render, forced }
}

function runPanel(panel, values) {
  const shim = makeReactShim()
  shim.forced.values = values
  shim.render(panel({}))
}

test('study-ops 面板可以用真实数据渲染（空白页的回归测试）', async () => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'rc-render-'))
  mkdirSync(path.join(project, 'data'), { recursive: true })
  const studyPath = path.join(project, 'study.json')
  writeFileSync(studyPath, JSON.stringify({
    schemaVersion: 1, studyId: 'render-study', name: '渲染冒烟研究', dataRoot: './data',
    participantId: { pattern: '^P-\\d{3}$' },
    visits: [{ id: 'T0', label: '基线', order: 0 }, { id: 'T1', label: '随访', order: 1 }],
    tasks: [
      { id: 'demo', label: '人口学', visits: ['T0'], required: true },
      { id: 'stq', label: '状态问卷', visits: ['T0', 'T1'], required: true },
      { id: 'opt', label: '可选', visits: ['T0'], required: false },
    ],
    followups: [{ id: 'fu1', label: '一周随访', anchorVisit: 'T0', offsetDays: 7, earlyDays: 1, lateDays: 3 }],
    plugins: {},
  }, null, 2))
  const host = makeHost({ workspaces: [], sessions: {}, cwd: project })
  const plugin = await loadPlugin('D:/dsh-plugins/study-ops')
  plugin.apply(host.ctx, { studyPath: '' })
  const handler = host.routes.get('/api/study-ops')
  const connected = await request(handler, {
    method: 'POST', path: '/api/study-ops',
    headers: { 'x-study-ops': '1', 'content-type': 'application/json', ...pageHeaders('page-render001') },
    body: { action: 'studyConnect', payload: { studyPath } },
  })
  assert.equal(connected.status, 200, connected.text.slice(0, 400))
  const status = await request(handler, { path: '/api/study-ops?action=status', headers: { 'x-study-ops': '1', ...pageHeaders('page-render001') } })
  assert.equal(status.status, 200, status.text.slice(0, 400))
  const projection = await request(handler, { path: '/api/study-ops?action=flowProjection', headers: { 'x-study-ops': '1', ...pageHeaders('page-render001') } })
  assert.equal(projection.status, 200, projection.text.slice(0, 400))
  const snap = status.json.data
  const core = projection.json.data

  const code = readFileSync('D:/dsh-plugins/study-ops/client.js', 'utf8')
  const shim = makeReactShim()
  const registrations = new Map()
  const styleStub = { set textContent(value) {}, remove() {}, appendChild() {} }
  globalThis.document = { createElement: () => styleStub, head: { appendChild() {} } }
  const slots = {
    register(declaration, component) { registrations.set(declaration.name + (declaration.key ? ':' + declaration.key : ''), component); return () => {} },
    inject(dependency, callback) { return callback() },
  }
  const ctx = { inject: ['slots'], slots, effect: run => { try { const dispose = run(); return typeof dispose === 'function' ? dispose : () => {} } catch { return () => {} } }, get: () => undefined, on: () => () => {} }
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        const module = factory(name => {
          if (name === 'react') return shim.React
          throw new Error('未知模块：' + name)
        })
        module.apply(ctx)
      },
    },
  }
  new Function('window', 'document', code)(globalThis.window, globalThis.document)
  const panel = registrations.get('main:study-ops')
  assert.ok(panel, '应注册 main:study-ops 面板')

  // 强制 Panel 的 11 个初始 state：snap / error / busy / filter / notice / dismissed / query / stale / core / cellDetail / reason
  shim.forced.values = [snap, '', false, 'all', '', false, '', false, core, null, '']
  assert.doesNotThrow(() => shim.render(panel({})), '面板渲染不应抛错')
})

test('面板在 core 尚未加载 / 核心为空 / 核心报错时都能安全渲染', () => {
  const code = readFileSync('D:/dsh-plugins/study-ops/client.js', 'utf8')
  const shim = makeReactShim()
  const registrations = new Map()
  const styleStub = { set textContent(value) {}, remove() {}, appendChild() {} }
  globalThis.document = { createElement: () => styleStub, head: { appendChild() {} } }
  const slots = {
    register(declaration, component) { registrations.set(declaration.name + (declaration.key ? ':' + declaration.key : ''), component); return () => {} },
    inject(dependency, callback) { return callback() },
  }
  const ctx = { inject: ['slots'], slots, effect: run => { try { const dispose = run(); return typeof dispose === 'function' ? dispose : () => {} } catch { return () => {} } }, get: () => undefined, on: () => () => {} }
  globalThis.window = { __ModuleLoader__: { load({ factory }) { const module = factory(name => (name === 'react' ? shim.React : (() => { throw new Error('未知模块：' + name) })())); module.apply(ctx) } } }
  new Function('window', 'document', code)(globalThis.window, globalThis.document)
  const panel = registrations.get('main:study-ops')

  const snap = {
    study: { id: 's', name: '渲染研究', revision: 'r', path: null },
    today: '2026-11-07', generatedAt: new Date().toISOString(), stateRevision: 0,
    columns: [], visits: [], subjects: [], schedule: [], anomalies: [], dismissed: [], fileIssues: [],
    sources: {}, enrollment: { n: 0, total: 0, groups: {} }, counts: { bad: 0, warn: 0, followupDue: 0 },
    binding: { source: 'candidate', instanceId: 'inst_x', bindingRevision: 0 },
  }
  const cases = [
    ['core 尚未加载（首帧）', [snap, '', false, 'all', '', false, '', false, null, null, '']],
    ['核心为空研究', [snap, '', false, 'all', '', false, '', false, { empty: true, binding: {}, study: {} }, null, '']],
    ['核心读取失败', [snap, '', false, 'all', '', false, '', false, { error: '读取失败' }, null, '']],
    ['还没有状态（snap 为空）', [null, '请求失败', false, 'all', '', false, '', false, null, null, '']],
  ]
  for (const [name, values] of cases) {
    shim.forced.values = values
    assert.doesNotThrow(() => shim.render(panel({})), `渲染失败：${name}`)
  }

  // 带量表任务来源与单元格明细：应渲染矩阵、明细和"在量表计分中打开"按钮而不崩。
  const core = {
    totals: { participants: 1, enrolled: 1, registered: 0, exited: 0, completed: 0, screeningFailed: 0 },
    sex: { male: 0, female: 1, other: 0, unknown: 0, missing: 0, mapped: true, note: '性别字段：性别' },
    groups: [{ group: 'condition=A', enrolled: 1, sex: { male: 0, female: 1, other: 0, unknown: 0, missing: 0 } }],
    visits: [{ id: 'T0', label: '基线' }],
    tasks: [{ id: 'garden', label: '花园量表', visits: ['T0'], required: true, source: { type: 'scale', scaleId: 'GARDEN', waveId: 'baseline' } }],
    matrix: [{ participantKey: 'pk_1', participantId: 'P-001', status: 'enrolled', groups: { condition: 'A' }, slots: { 'T0::garden': { collection: 'complete', quality: 'valid', observationId: 'os1' } } }],
    followups: [{ participantId: 'P-001', followupId: 'fu1', label: '一周随访', anchorDate: '2026-11-02', dueAt: '2026-11-09', state: 'due', evidence: null }],
    anomalies: [], followupCounts: { due: 0, overdue: 0, unknown: 0, done: 0 }, sources: {}, inputRevision: 'abc123def456',
  }
  const detail = { state: 'complete', visitId: 'T0', taskId: 'garden', participant: { participantId: 'P-001' }, observations: [{ observationId: 'os1', collectionState: 'complete', qualityState: 'valid', sourceType: 'scale', sourceRevision: 'def:x|sub:y' }] }
  shim.forced.values = [snap, '', false, 'all', '', false, '', false, core, detail, '']
  assert.doesNotThrow(() => shim.render(panel({})), '带量表来源与明细的面板渲染不应抛错')

  // 读取失败但已有上次快照：显示"显示的是 … 的快照"，不清空矩阵。
  shim.forced.values = [snap, '', false, 'all', '', false, '', false, core, detail, '', new Date().toISOString(), '网络错误']
  assert.doesNotThrow(() => shim.render(panel({})), '核心读取失败时保留快照渲染不应抛错')
})
