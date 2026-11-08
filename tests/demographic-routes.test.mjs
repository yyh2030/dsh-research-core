/**
 * demographic-coder 的绑定隔离验收：真人学数据集写入绑定研究的磁盘，
 * 另一个页面/研究会话不受影响。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { before } from 'node:test'

import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'

const root = mkdtempSync(path.join(os.tmpdir(), 'rc-demo-'))
const wsA = path.join(root, 'ws-a')
const wsB = path.join(root, 'ws-b')
const store = path.join(root, 'store')
process.env.DSH_RESEARCH_STORE = store

function writeStudy(dir, studyId, name, participantPattern = '^P-\\d{3}$') {
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  const file = path.join(dir, 'study.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, studyId, name, dataRoot: './data', participantId: { pattern: participantPattern }, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))
  return file
}

const fileA = writeStudy(wsA, 'study-a', '合成研究 A')
const fileB = writeStudy(wsB, 'study-b', '合成研究 B')

const datasetA = { name: '人口学 A', columns: [{ key: 'sex', label: '性别', kind: 'text', required: false }], rows: [{ id: 'P-001', values: { sex: '女' } }] }
const datasetB = { name: '人口学 B', columns: [{ key: 'sex', label: '性别', kind: 'text', required: false }], rows: [{ id: 'P-002', values: { sex: '男' } }] }

let host
let handler

before(async () => {
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../demographic-coder'))
  host = makeHost({ workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }], sessions: { 's-a': wsA }, cwd: path.join(root, 'no-config') })
  moduleUnderTest.apply(host.ctx, { studyPath: '' })
  handler = host.routes.get('/api/demographic-coder')
  assert.ok(handler, 'demographic-coder 应注册路由')
})

const call = options => request(handler, options)
const get = (action, pageId) => call({ path: `/api/demographic-coder?action=${action}${pageId ? '&pageId=' + encodeURIComponent(pageId) : ''}`, headers: { 'x-demographic-coder': '1', ...(pageId ? pageHeaders(pageId) : {}) } })
const post = (action, payload, pageId) => call({ method: 'POST', path: '/api/demographic-coder', headers: { 'x-demographic-coder': '1', 'content-type': 'application/json', ...(pageId ? pageHeaders(pageId) : {}) }, body: { action, payload } })

test('无配置时进入空研究，读取不写盘', async () => {
  const response = await get('status', 'page-empty0001')
  assert.equal(response.status, 200, response.text)
  assert.equal(response.json.data.binding.state, 'empty')
  assert.equal(existsSync(store), false)
})

test('连接研究后人口学数据写入该研究的数据目录', async () => {
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-aaaa0001')
  assert.equal(connected.status, 200, JSON.stringify(connected.json))
  assert.equal(connected.json.data.study.id, 'study-a')
  const token = connected.json.data.binding.token

  const loaded = await get('load', 'page-aaaa0001')
  assert.equal(loaded.status, 200, loaded.text)
  const revision = loaded.json.data.revision

  const synced = await post('sync', { dataset: datasetA, revision, studyRevision: loaded.json.data.studyRevision, studyId: 'study-a', binding: token }, 'page-aaaa0001')
  assert.equal(synced.status, 200, JSON.stringify(synced.json))
  const target = path.join(wsA, 'data', 'demographics.json')
  assert.ok(existsSync(target), '人口学快照应落在研究 A 的数据目录')
  const document = JSON.parse(readFileSync(target, 'utf8'))
  assert.equal(document.studyId, 'study-a')
  assert.equal(document.rows[0].id, 'P-001')
  assert.equal(existsSync(path.join(wsB, 'data', 'demographics.json')), false)
})

test('ISO-01 两个页面各写各的研究，数据 hash 互不影响', async () => {
  const a = await post('studyConnect', { studyPath: fileA }, 'page-a0000001')
  const b = await post('studyConnect', { studyPath: fileB }, 'page-b0000001')
  assert.equal(a.json.data.study.id, 'study-a')
  assert.equal(b.json.data.study.id, 'study-b')

  const loadB = await get('load', 'page-b0000001')
  const syncB = await post('sync', { dataset: datasetB, revision: loadB.json.data.revision, studyRevision: loadB.json.data.studyRevision, binding: b.json.data.binding.token }, 'page-b0000001')
  assert.equal(syncB.status, 200, JSON.stringify(syncB.json))
  assert.ok(existsSync(path.join(wsB, 'data', 'demographics.json')))
  const documentB = JSON.parse(readFileSync(path.join(wsB, 'data', 'demographics.json'), 'utf8'))
  assert.equal(documentB.rows[0].id, 'P-002')

  const loadA = await get('load', 'page-a0000001')
  const syncA = await post('sync', { dataset: datasetA, revision: loadA.json.data.revision, studyRevision: loadA.json.data.studyRevision, binding: a.json.data.binding.token }, 'page-a0000001')
  assert.equal(syncA.status, 200, JSON.stringify(syncA.json))
  const documentA = JSON.parse(readFileSync(path.join(wsA, 'data', 'demographics.json'), 'utf8'))
  assert.equal(documentA.rows[0].id, 'P-001')
})

test('页面写入缺少令牌时明确拒绝；旧令牌跨研究失效', async () => {
  const load = await get('load', 'page-b0000001')
  const missing = await post('sync', { dataset: datasetB, revision: load.json.data.revision, studyRevision: load.json.data.studyRevision }, 'page-b0000001')
  assert.equal(missing.status, 409)
  assert.equal(missing.json.error.code, 'binding_required')

  const pageId = 'page-cycle0001'
  const first = await post('studyConnect', { studyPath: fileA }, pageId)
  const firstToken = first.json.data.binding.token
  await post('studyConnect', { studyPath: fileB }, pageId)
  await post('studyConnect', { studyPath: fileA }, pageId)
  const reload = await get('load', pageId)
  const stale = await post('sync', { dataset: datasetA, revision: reload.json.data.revision, studyRevision: reload.json.data.studyRevision, binding: firstToken }, pageId)
  assert.equal(stale.status, 409)
  assert.equal(stale.json.error.code, 'binding_conflict')
})

test('创建空研究：写一份最小定义并绑定到该页面', async () => {
  const target = path.join(root, 'created', 'study.json')
  const created = await post('createStudy', {
    studyPath: target,
    definition: { schemaVersion: 1, studyId: 'created-study', name: '新建研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: { demographics: {} } }
  }, 'page-create001')
  assert.equal(created.status, 200, JSON.stringify(created.json))
  assert.ok(existsSync(target))
  assert.equal(created.json.data.study.id, 'created-study')
  const status = await get('status', 'page-create001')
  assert.equal(status.json.data.study.id, 'created-study')
  assert.equal(status.json.data.binding.source, 'page-connect')
})

test('能力查询返回绑定与候选研究', async () => {
  const response = await get('capabilities', 'page-a0000001')
  assert.equal(response.status, 200, response.text)
  assert.equal(response.json.data.binding.studyId, 'study-a')
  assert.ok(response.json.data.candidates.studies.length >= 2)
})

test('publishFlow 打开时，保存同时发布参与者索引与 demographics 代次', async () => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'rc-demo-flow-'))
  mkdirSync(path.join(project, 'data'), { recursive: true })
  const studyPath = path.join(project, 'study.json')
  writeFileSync(studyPath, JSON.stringify({ schemaVersion: 1, studyId: 'demo-flow', name: '人口学流程研究', dataRoot: './data', participantId: { pattern: '^P-\\d{3}$' }, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))
  const flowHost = makeHost({ workspaces: [], sessions: { 's-a': project }, cwd: project })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../demographic-coder'))
  moduleUnderTest.apply(flowHost.ctx, { studyPath: '', publishFlow: true })
  const flowHandler = flowHost.routes.get('/api/demographic-coder')
  const call2 = options => request(flowHandler, options)
  const post2 = (action, payload, pageId) => call2({ method: 'POST', path: '/api/demographic-coder', headers: { 'x-demographic-coder': '1', 'content-type': 'application/json', ...pageHeaders(pageId) }, body: { action, payload } })
  const get2 = (action, pageId) => call2({ path: `/api/demographic-coder?action=${action}&pageId=${encodeURIComponent(pageId)}`, headers: { 'x-demographic-coder': '1', ...pageHeaders(pageId) } })

  const connected = await post2('studyConnect', { studyPath }, 'page-flow000001')
  assert.equal(connected.status, 200, JSON.stringify(connected.json))
  const loaded = await get2('load', 'page-flow000001')
  const synced = await post2('sync', { dataset: datasetA, revision: loaded.json.data.revision, studyRevision: loaded.json.data.studyRevision, binding: connected.json.data.binding.token }, 'page-flow000001')
  assert.equal(synced.status, 200, JSON.stringify(synced.json))
  assert.ok(synced.json.data.flow, '应返回核心发布结果：' + JSON.stringify(synced.json.data))
  assert.deepEqual(synced.json.data.flow.participants.created, ['P-001'])

  const { openResearchData } = await import('../data.mjs')
  const study = { id: 'demo-flow', name: '人口学流程研究', path: studyPath, dataRoot: path.join(project, 'data'), baseDir: project, plugin: {} }
  const data = openResearchData({ study, instanceId: synced.json.data.binding.instanceId })
  assert.equal(data.read('demographics').health.state, 'ok', 'demographics 已有已提交代次')
  assert.equal(data.read('demographics').value.rows[0].id, 'P-001')
  const participants = data.read('participants').value
  assert.equal(participants.participants.length, 1)
  assert.equal(participants.participants[0].status, 'registered', '人口学保存只登记，不自动入组')
})
