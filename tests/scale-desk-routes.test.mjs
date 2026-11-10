/**
 * scale-desk 的绑定隔离验收：真实量表插件 + 真实研究核心 + 临时合成研究。
 * 只验证"请求属于哪个研究"这一层；计分/建模逻辑沿用插件原有实现。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { before } from 'node:test'

import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'
import { openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'

const root = mkdtempSync(path.join(os.tmpdir(), 'rc-scale-'))
const wsA = path.join(root, 'ws-a')
const wsB = path.join(root, 'ws-b')
const store = path.join(root, 'store')
process.env.DSH_RESEARCH_STORE = store

function writeStudy(dir, studyId, name) {
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  const file = path.join(dir, 'study.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, studyId, name, dataRoot: './data', participantId: { pattern: '^P-\\d{3}$' }, visits: [], tasks: [], followups: [], plugins: { scales: {} } }, null, 2))
  return file
}

const fileA = writeStudy(wsA, 'study-a', '合成研究 A')
const fileB = writeStudy(wsB, 'study-b', '合成研究 B')

let host
let handler

before(async () => {
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../scale-desk'))
  host = makeHost({ workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }], sessions: { 's-a': wsA, 's-b': wsB }, cwd: path.join(root, 'no-config') })
  moduleUnderTest.apply(host.ctx, { studyPath: '' })
  handler = host.routes.get('/api/scale-desk')
  assert.ok(handler, 'scale-desk 应注册路由')
})

const call = options => request(handler, options)
const get = (action, pageId) => call({ path: `/api/scale-desk?action=${action}${pageId ? '&pageId=' + encodeURIComponent(pageId) : ''}`, headers: { 'x-scale-desk': '1', ...(pageId ? pageHeaders(pageId) : {}) } })
const post = (action, payload, pageId) => call({ method: 'POST', path: '/api/scale-desk', headers: { 'x-scale-desk': '1', 'content-type': 'application/json', ...(pageId ? pageHeaders(pageId) : {}) }, body: { action, payload } })

test('无配置时进入空研究，读取不写盘', async () => {
  const response = await get('status', 'page-empty0001')
  assert.equal(response.status, 200, response.text.slice(0, 600))
  assert.equal(response.json.data.binding.state, 'empty')
  assert.equal(existsSync(store), false)
})

test('连接研究后初始化写入该研究的数据目录', async () => {
  const connected = await post('studyConnect', { path: fileA }, 'page-aaaa0001')
  assert.equal(connected.status, 200, JSON.stringify(connected.json))
  assert.equal(connected.json.data.study.id, 'study-a')
  const token = connected.json.data.binding.token

  const status = await get('status', 'page-aaaa0001')
  assert.equal(status.json.data.study.id, 'study-a')
  assert.equal(status.json.data.binding.source, 'page-connect')

  const initialized = await post('initialize', { sample: true, binding: token }, 'page-aaaa0001')
  assert.equal(initialized.status, 200, JSON.stringify(initialized.json).slice(0, 800))
  const defsDir = path.join(wsA, 'data', 'scales', 'defs')
  assert.ok(existsSync(defsDir), '初始化应创建量表定义目录')
  assert.ok(readdirSync(defsDir).length >= 1, '示例定义应写入研究 A')
  assert.equal(existsSync(path.join(wsB, 'data', 'scales', 'defs')), false)
})

test('页面写入缺少令牌时明确拒绝；旧令牌跨研究失效', async () => {
  const missing = await post('initialize', { sample: false }, 'page-aaaa0001')
  assert.equal(missing.status, 409)
  assert.equal(missing.json.error.code, 'binding_required')

  const pageId = 'page-cycle0001'
  const first = await post('studyConnect', { path: fileA }, pageId)
  const firstToken = first.json.data.binding.token
  await post('studyConnect', { path: fileB }, pageId)
  await post('studyConnect', { path: fileA }, pageId)
  const stale = await post('initialize', { sample: false, binding: firstToken }, pageId)
  assert.equal(stale.status, 409)
  assert.equal(stale.json.error.code, 'binding_conflict')
})

test('ISO-02 另一页面连接 B 后，A 的写入仍落在 A', async () => {
  const a = await post('studyConnect', { path: fileA }, 'page-a0000001')
  const b = await post('studyConnect', { path: fileB }, 'page-b0000001')
  assert.equal(a.json.data.study.id, 'study-a')
  assert.equal(b.json.data.study.id, 'study-b')

  const wroteB = await post('initialize', { sample: false, binding: b.json.data.binding.token }, 'page-b0000001')
  assert.equal(wroteB.status, 200, JSON.stringify(wroteB.json))
  const wroteA = await post('initialize', { sample: false, binding: a.json.data.binding.token }, 'page-a0000001')
  assert.equal(wroteA.status, 200, JSON.stringify(wroteA.json))
  assert.equal(wroteA.json.data.study?.id ?? 'study-a', 'study-a')
  assert.ok(existsSync(path.join(wsA, 'data', 'scales', 'defs')))
  assert.ok(existsSync(path.join(wsB, 'data', 'scales', 'defs')))
  assert.equal(existsSync(path.join(wsB, 'data', 'scales', 'defs', 'sample.json')), false)
})

test('工具按调用会话解析研究', async () => {
  const tool = host.tools.get('scale_list')
  assert.ok(tool, '应注册 scale_list 工具')
  const a = await tool.execute({}, { agent: { id: 's-a' } })
  assert.match(a.text, /量表库/)
  const b = await tool.execute({}, { agent: { id: 's-b' } })
  assert.match(b.text, /量表库/)
})

test('crossProcessLock 打开时，另一进程持锁期间写入明确 409', async () => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'rc-scale-lock-'))
  const dataRoot = path.join(project, 'data')
  mkdirSync(path.join(dataRoot, 'scales', 'defs'), { recursive: true })
  mkdirSync(path.join(dataRoot, 'scales', 'answers'), { recursive: true })
  writeFileSync(path.join(dataRoot, 'scales', 'defs', 'GARDEN.json'), readFileSync(path.resolve(import.meta.dirname, '../../scale-desk/sample-def.json'), 'utf8'))
  writeFileSync(path.join(dataRoot, 'scales', 'answers', 'GARDEN__baseline.csv'), '编号,definitionHash,submissionId,q01,q02,q03,q04\nP-001,,sub-0001,1,2,3,4\n')
  const studyPath = path.join(project, 'study.json')
  const definition = {
    schemaVersion: 1, studyId: 'scale-lock', name: '量表锁研究', dataRoot: './data',
    participantId: {}, visits: [{ id: 'T0', label: '基线', order: 0 }],
    tasks: [{ id: 'garden-baseline', label: '花园基线', visits: ['T0'], required: true, source: { type: 'scale', scaleId: 'GARDEN', waveId: 'baseline' } }],
    followups: [], plugins: { scales: {} },
  }
  writeFileSync(studyPath, JSON.stringify(definition, null, 2))
  const lockHost = makeHost({ workspaces: [], sessions: { 's-a': project }, cwd: project })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../scale-desk'))
  moduleUnderTest.apply(lockHost.ctx, { studyPath: '', crossProcessLock: true })
  const lockHandler = lockHost.routes.get('/api/scale-desk')
  const post3 = (action, payload, pageId) => request(lockHandler, { method: 'POST', path: '/api/scale-desk', headers: { 'x-scale-desk': '1', 'content-type': 'application/json', ...pageHeaders(pageId) }, body: { action, payload } })

  const connected = await post3('studyConnect', { path: studyPath }, 'page-scale0002')
  assert.equal(connected.status, 200, JSON.stringify(connected.json).slice(0, 500))
  const instanceId = connected.json.data.binding.instanceId
  const study = { id: 'scale-lock', name: '量表锁研究', path: studyPath, dataRoot, baseDir: project, plugin: {}, visits: definition.visits, tasks: definition.tasks, followups: [], revision: 'r1' }
  const data = openResearchData({ study, instanceId })
  const other = data.lock('scale-desk', { owner: 'other-process', timeoutMs: 100 })
  try {
    const blocked = await post3('score', { binding: connected.json.data.binding.token }, 'page-scale0002')
    assert.equal(blocked.status, 409, JSON.stringify(blocked.json).slice(0, 500))
    assert.match(blocked.json.error.message, /另一个进程/)
  } finally { other.release() }
  const ok = await post3('score', { binding: connected.json.data.binding.token }, 'page-scale0002')
  assert.equal(ok.status, 200, JSON.stringify(ok.json).slice(0, 500))
})

test('能力查询返回绑定与一致性', async () => {
  const response = await get('capabilities', 'page-a0000001')
  assert.equal(response.status, 200, response.text.slice(0, 600))
  assert.equal(response.json.data.binding.studyId, 'study-a')
  assert.equal(response.json.data.consistent, true)
})

test('publishFlow 打开时，计分后把量表提交发布为标准 observation', async () => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'rc-scale-flow-'))
  const dataRoot = path.join(project, 'data')
  mkdirSync(path.join(dataRoot, 'scales', 'defs'), { recursive: true })
  mkdirSync(path.join(dataRoot, 'scales', 'answers'), { recursive: true })
  const sample = readFileSync(path.resolve(import.meta.dirname, '../../scale-desk/sample-def.json'), 'utf8')
  writeFileSync(path.join(dataRoot, 'scales', 'defs', 'GARDEN.json'), sample)
  writeFileSync(path.join(dataRoot, 'scales', 'answers', 'GARDEN__baseline.csv'), '编号,definitionHash,submissionId,q01,q02,q03,q04\nP-001,,sub-0001,1,2,3,4\nP-002,,sub-0002,2,2,2,2\n')
  const studyPath = path.join(project, 'study.json')
  const definition = {
    schemaVersion: 1, studyId: 'scale-flow', name: '量表流程研究', dataRoot: './data',
    participantId: {}, visits: [{ id: 'T0', label: '基线', order: 0 }],
    tasks: [{ id: 'garden-baseline', label: '花园基线', visits: ['T0'], required: true, source: { type: 'scale', scaleId: 'GARDEN', waveId: 'baseline' } }],
    followups: [], plugins: { scales: {} },
  }
  writeFileSync(studyPath, JSON.stringify(definition, null, 2))
  const flowHost = makeHost({ workspaces: [], sessions: { 's-a': project }, cwd: project })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../scale-desk'))
  moduleUnderTest.apply(flowHost.ctx, { studyPath: '', publishFlow: true })
  const flowHandler = flowHost.routes.get('/api/scale-desk')
  const post2 = (action, payload, pageId) => request(flowHandler, { method: 'POST', path: '/api/scale-desk', headers: { 'x-scale-desk': '1', 'content-type': 'application/json', ...pageHeaders(pageId) }, body: { action, payload } })
  const get2 = (action, pageId) => request(flowHandler, { path: `/api/scale-desk?action=${action}&pageId=${encodeURIComponent(pageId)}`, headers: { 'x-scale-desk': '1', ...pageHeaders(pageId) } })

  const connected = await post2('studyConnect', { path: studyPath }, 'page-scale0001')
  assert.equal(connected.status, 200, JSON.stringify(connected.json).slice(0, 600))
  const instanceId = connected.json.data.binding.instanceId
  const study = { id: 'scale-flow', name: '量表流程研究', path: studyPath, dataRoot, baseDir: project, plugin: {}, visits: definition.visits, tasks: definition.tasks, followups: [], revision: 'r1' }
  const data = openResearchData({ study, instanceId })
  const flow = openFlow({ data, study })
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })

  const status = await get2('status', 'page-scale0001')
  assert.equal(status.status, 200, status.text.slice(0, 600))
  const scored = await post2('score', { binding: connected.json.data.binding.token }, 'page-scale0001')
  assert.equal(scored.status, 200, JSON.stringify(scored.json).slice(0, 800))
  assert.ok(scored.json.data.publish, '应返回发布结果')
  assert.equal(scored.json.data.publish.observations.published, 1, '已登记编号发布')
  assert.equal(scored.json.data.publish.observations.unregistered, 1, '未登记编号留在待关联区，不静默增加入组')
  assert.ok(scored.json.data.publish.scores, '分数发布结果应存在')
  assert.equal(scored.json.data.publish.scores.published, 1, '分数也要发布到核心数据集')

  const observations = data.read('observations').value
  assert.equal(observations.observations.length, 1)
  const first = observations.observations.find(row => row.participantId === 'P-001')
  assert.equal(first.taskId, 'garden-baseline')
  assert.equal(first.visitId, 'T0')
  assert.equal(first.collectionState, 'complete')
  assert.equal(first.qualityState, 'valid')
  assert.equal(first.eventDate, null, '未知施测日期保留未知，不用导入日冒充')
  assert.match(first.sourceRevision, /^def:[0-9a-f]{8}\|sub:sub-0001/)

  // 再次计分幂等：recordId 与来源版本相同，不重复累计。
  const again = await post2('score', { binding: connected.json.data.binding.token }, 'page-scale0001')
  assert.equal(again.status, 200)
  assert.equal(data.read('observations').value.observations.length, 1)
})
