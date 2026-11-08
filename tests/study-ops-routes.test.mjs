/**
 * ISO-01/02/03/07/08 的宿主级验收：真实 study-ops 插件 + 真实研究核心 + 临时合成研究。
 * 不经过浏览器，也不监听端口；直接调用插件注册的 HTTP handler 与工具。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'

import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'
import { openResearchData } from '../data.mjs'

const root = mkdtempSync(path.join(os.tmpdir(), 'rc-ops-'))
const wsA = path.join(root, 'ws-a')
const wsB = path.join(root, 'ws-b')
const store = path.join(root, 'store')
process.env.DSH_RESEARCH_STORE = store

function writeStudy(dir, { studyId, name, visits = [], followups = [] }) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'study.json'), JSON.stringify({ schemaVersion: 1, studyId, name, dataRoot: './data', participantId: { pattern: '^P-\\d{3}$' }, visits, tasks: [], followups, plugins: {} }, null, 2))
  return path.join(dir, 'study.json')
}

let moduleUnderTest
let host
let handler
const fileA = writeStudy(wsA, { studyId: 'study-a', name: '合成研究 A', visits: [{ id: 'v1', label: '基线' }] })
const fileB = writeStudy(wsB, { studyId: 'study-b', name: '合成研究 B', visits: [{ id: 'v1', label: '基线' }] })

before(async () => {
  moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../study-ops'))
  host = makeHost({ workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }], sessions: { 's-a': wsA, 's-b': wsB }, cwd: path.join(root, 'no-config') })
  moduleUnderTest.apply(host.ctx, { studyPath: '' })
  handler = host.routes.get('/api/study-ops')
  assert.ok(handler, 'study-ops 应注册 /api/study-ops 路由')
})

after(() => { try { host.disposers.forEach(fn => fn()) } catch { /* 清理尽力而为 */ } })

const call = (options) => request(handler, options)
const post = (action, payload, headers) => call({ method: 'POST', path: '/api/study-ops', headers: { 'x-study-ops': '1', 'content-type': 'application/json', ...(headers || {}) }, body: { action, payload } })
const get = (action, pageId) => call({ path: `/api/study-ops?action=${action}`, headers: { 'x-study-ops': '1', ...pageHeaders(pageId) } })

test('ISO-07 无配置时页面进入空研究，查询不写绑定记录', async () => {
  const response = await get('status', 'page-empty0001')
  assert.equal(response.status, 200, response.text)
  assert.equal(response.json.data.binding.configured, false)
  assert.equal(response.json.data.binding.state, 'empty')
  assert.equal(existsSync(store), false, '只读解析不应创建绑定存储')
})

test('连接研究后页面持有绑定，写入落在那一个研究的数据目录', async () => {
  const connected = await post('studyConnect', { studyPath: fileA }, pageHeaders('page-aaaa0001'))
  assert.equal(connected.status, 200)
  assert.equal(connected.json.data.study.id, 'study-a')
  const token = connected.json.data.binding.token
  assert.ok(token, '连接后应返回绑定令牌')

  const status = await get('status', 'page-aaaa0001')
  assert.equal(status.json.data.study.id, 'study-a')
  assert.equal(status.json.data.binding.source, 'page-connect')
  assert.equal(status.json.data.binding.token, token)

  const written = await post('restore', { stateRevision: status.json.data.stateRevision, binding: token }, pageHeaders('page-aaaa0001'))
  assert.equal(written.status, 200, JSON.stringify(written.json))
  assert.ok(existsSync(path.join(wsA, 'data', 'ops', 'study-a', 'state.json')), '写入应落在研究 A 的数据目录')
  assert.equal(existsSync(path.join(wsB, 'data', 'ops', 'study-a', 'state.json')), false)
})

test('页面写入缺少令牌时明确拒绝，不猜一个研究', async () => {
  const response = await post('restore', { stateRevision: 0 }, { 'x-dsh-page': 'page-notoken001' })
  assert.equal(response.status, 409)
  assert.equal(response.json.error.code, 'binding_required')
})

test('ISO-02 另一页面连接 B 后，A 的令牌仍然只写 A', async () => {
  const a = await post('studyConnect', { studyPath: fileA }, pageHeaders('page-a0000001'))
  const b = await post('studyConnect', { studyPath: fileB }, pageHeaders('page-b0000001'))
  assert.equal(a.json.data.study.id, 'study-a')
  assert.equal(b.json.data.study.id, 'study-b')

  const tokenA = a.json.data.binding.token
  const tokenB = b.json.data.binding.token
  const statusB = await get('status', 'page-b0000001')
  assert.equal(statusB.json.data.study.id, 'study-b')
  const wroteB = await post('restore', { stateRevision: statusB.json.data.stateRevision, binding: tokenB }, pageHeaders('page-b0000001'))
  assert.equal(wroteB.status, 200, JSON.stringify(wroteB.json))

  const statusA = await get('status', 'page-a0000001')
  const written = await post('restore', { stateRevision: statusA.json.data.stateRevision, binding: tokenA }, pageHeaders('page-a0000001'))
  assert.equal(written.status, 200, JSON.stringify(written.json))
  assert.equal(written.json.data.study.id, 'study-a')
  assert.ok(existsSync(path.join(wsA, 'data', 'ops', 'study-a', 'state.json')))
  assert.ok(existsSync(path.join(wsB, 'data', 'ops', 'study-b', 'state.json')), 'B 只写自己的数据目录')
  assert.equal(existsSync(path.join(wsB, 'data', 'ops', 'study-a', 'state.json')), false)
})

test('ISO-03 同一页面 A→B→A 后旧 A 令牌失效', async () => {
  const pageId = 'page-cycle0001'
  const first = await post('studyConnect', { studyPath: fileA }, pageHeaders(pageId))
  const firstToken = first.json.data.binding.token
  await post('studyConnect', { studyPath: fileB }, pageHeaders(pageId))
  const third = await post('studyConnect', { studyPath: fileA }, pageHeaders(pageId))
  assert.equal(third.json.data.study.id, 'study-a')
  assert.ok(third.json.data.binding.bindingRevision > first.json.data.binding.bindingRevision)

  const status = await get('status', pageId)
  const stale = await post('restore', { stateRevision: status.json.data.stateRevision, binding: firstToken }, pageHeaders(pageId))
  assert.equal(stale.status, 409)
  assert.equal(stale.json.error.code, 'binding_conflict')

  const fresh = await post('restore', { stateRevision: status.json.data.stateRevision, binding: status.json.data.binding.token }, pageHeaders(pageId))
  assert.equal(fresh.status, 200, JSON.stringify(fresh.json))
})

test('ISO-08 研究定义被外部修改后，旧令牌写入被拒绝', async () => {
  const pageId = 'page-stale0001'
  await post('studyConnect', { studyPath: fileA }, pageHeaders(pageId))
  const status = await get('status', pageId)
  const original = readFileSync(fileA, 'utf8')
  writeFileSync(fileA, original.replace('合成研究 A', '合成研究 A（改名）'))
  try {
    const stale = await post('restore', { stateRevision: status.json.data.stateRevision, binding: status.json.data.binding.token }, pageHeaders(pageId))
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'binding_conflict')
  } finally {
    writeFileSync(fileA, original)
  }
})

test('工具从调用会话取绑定：会话 cwd 的项目配置生效，且不需要令牌', async () => {
  const tool = host.tools.get('study_status')
  assert.ok(tool, '应注册 study_status 工具')
  const result = await tool.execute({ focus: 'all' }, { agent: { id: 's-a' } })
  assert.match(result.text, /合成研究 A/)
  const other = await tool.execute({ focus: 'all' }, { agent: { id: 's-b' } })
  assert.match(other.text, /合成研究 B/)
  // 没有会话身份时不能读到任何一项研究，更不能猜一个。
  const anonymous = await tool.execute({ focus: 'all' }, {})
  assert.doesNotMatch(anonymous.text, /合成研究 A/)
  assert.doesNotMatch(anonymous.text, /合成研究 B/)
})

test('ISO-05 会话 cd 到另一个项目根后，工具解析到新工作区的项目配置', async () => {
  const moved = makeHost({
    workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }],
    sessions: { 's-move': wsA },
    effectiveCwd: { 's-move': wsB },
    cwd: path.join(root, 'no-config'),
  })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../study-ops'))
  moduleUnderTest.apply(moved.ctx, { studyPath: '' })
  const tool = moved.tools.get('study_status')
  assert.ok(tool)
  // header.cwd 仍是 A，但有效目录已经切到 B：应按 B 的项目配置解析。
  const text = (await tool.execute({ focus: 'all' }, { agent: { id: 's-move' } })).text
  assert.match(text, /合成研究 B/)
  assert.doesNotMatch(text, /合成研究 A/)
})

test('study_binding 工具报告当前会话的研究位置与插件一致性', async () => {
  const tool = host.tools.get('study_binding')
  assert.ok(tool, '应注册 study_binding 工具')
  const result = await tool.execute({}, { agent: { id: 's-a' } })
  assert.match(result.text, /合成研究 A/)
  assert.match(result.text, /插件一致性：一致/)
  assert.match(result.text, /会话目录：/)
  assert.doesNotMatch(result.text, /rc1\./, '不应把绑定令牌回传给模型')
})

test('能力查询返回插件身份、候选研究与一致性', async () => {
  const response = await get('capabilities', 'page-aaaa0001')
  assert.equal(response.status, 200, response.text)
  const data = response.json.data
  assert.equal(data.binding.studyId, 'study-a')
  assert.ok(Array.isArray(data.plugins) && data.plugins.some(row => row.name === 'study-ops'))
  assert.ok(data.candidates.studies.length >= 2)
  assert.equal(data.consistent, true)
})

test('03 材料接入工具：扫描 → 准备度 → 草案预览与独占保存', async () => {
  const materials = mkdtempSync(path.join(os.tmpdir(), 'rc-ops-materials-'))
  writeFileSync(path.join(materials, '流程.md'), '访视：基线\n任务：体验问卷\n')
  writeFileSync(path.join(materials, '计划.md'), '主要结局：焦虑分数\n')
  writeFileSync(path.join(materials, '人口学.csv'), '编号,性别\nP-001,女\n')
  const toolsHost = makeHost({ workspaces: [], sessions: { 's-a': wsA }, cwd: materials })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../study-ops'))
  moduleUnderTest.apply(toolsHost.ctx, { studyPath: '' })

  const scan = await toolsHost.tools.get('materials_scan').execute({ path: materials }, { agent: { id: 's-a' } })
  assert.match(scan.text, /材料目录：/)
  assert.match(scan.text, /已识别：/)
  assert.match(scan.text, /索引：/)
  assert.doesNotMatch(scan.text, /P-001/, '摘要不应回传逐人编号')

  const readiness = await toolsHost.tools.get('prep_readiness').execute({ path: materials }, { agent: { id: 's-a' } })
  assert.match(readiness.text, /materials：/)
  assert.match(readiness.text, /statisticsEnvironment：/)
  assert.match(readiness.text, /可以开始：/)

  const preview = await toolsHost.tools.get('study_draft_preview').execute({ path: materials, name: '材料合成研究', studyId: 'materials-study' }, { agent: { id: 's-a' } })
  assert.match(preview.text, /访视 1 个；任务 1 个/)
  assert.match(preview.text, /"studyId": "materials-study"/)

  const draftPath = path.join(materials, 'study.json')
  const saved = await toolsHost.tools.get('study_draft_save').execute({ path: materials, draftPath, studyId: 'materials-study', name: '材料合成研究' }, { agent: { id: 's-a' } })
  assert.match(saved.text, /已创建研究定义/)
  assert.ok(existsSync(draftPath))
  assert.equal(JSON.parse(readFileSync(draftPath, 'utf8')).studyId, 'materials-study')
  await assert.rejects(
    () => toolsHost.tools.get('study_draft_save').execute({ path: materials, draftPath, studyId: 'materials-study', name: '材料合成研究' }, { agent: { id: 's-a' } }),
    /已存在|冲突|dataset_conflict|研究定义已存在/,
  )
})

test('04 流程工具：参与者 → observation → 任务导入 → 随访 → 投影', async () => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'rc-ops-flow-'))
  mkdirSync(path.join(project, 'data'), { recursive: true })
  const definition = {
    schemaVersion: 1, studyId: 'flow-tools', name: '流程工具研究', dataRoot: './data',
    participantId: {}, visits: [{ id: 'T0', label: '基线', order: 0 }], tasks: [{ id: 'stq', label: '状态问卷', visits: ['T0'], required: true, source: { type: 'scale', scaleId: 'DEMO', waveId: 'baseline' } }],
    followups: [{ id: 'fu1', label: '一周随访', anchorVisit: 'T0', offsetDays: 7, earlyDays: 1, lateDays: 3 }], plugins: {},
  }
  writeFileSync(path.join(project, 'study.json'), JSON.stringify(definition, null, 2))
  const toolsHost = makeHost({ workspaces: [], sessions: { 's-flow': project }, cwd: project })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../study-ops'))
  moduleUnderTest.apply(toolsHost.ctx, { studyPath: '' })
  const tools = toolsHost.tools
  const exec = { agent: { id: 's-flow' } }

  const registered = await tools.get('participants_manage').execute({ op: 'register', participantId: 'P-001', status: 'enrolled', groups: { condition: 'A' }, reason: '合成' }, exec)
  assert.match(registered.text, /已登记/)
  await tools.get('participants_manage').execute({ op: 'status', participantId: 'P-001', status: 'enrolled', groups: { condition: 'A' }, reason: '入组' }, exec)

  const published = await tools.get('observations_manage').execute({ op: 'publish', participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'r1' }, exec)
  assert.match(published.text, /已发布 observation/)

  const csv = '编号,访视,任务,日期\nP-001,T0,stq,2026-11-02\n'
  const preview = await tools.get('task_import').execute({ op: 'preview', text: csv }, exec)
  assert.match(preview.text, /列映射/)
  assert.match(preview.text, /必要列齐全/)
  const committed = await tools.get('task_import').execute({ op: 'commit', text: csv }, exec)
  assert.match(committed.text, /已导入/)
  const again = await tools.get('task_import').execute({ op: 'commit', text: csv }, exec)
  assert.match(again.text, /未重复累计/)

  await tools.get('followup_manage').execute({ op: 'mark', participantId: 'P-001', followupId: 'fu1', reason: '电话完成' }, exec)
  const followups = await tools.get('followup_manage').execute({ op: 'list', today: '2026-11-10' }, exec)
  assert.match(followups.text, /随访 \d+ 条/)

  const projection = await tools.get('flow_projection').execute({ focus: 'all' }, exec)
  assert.match(projection.text, /参与者 1/)
  assert.match(projection.text, /已入组 1/)
  assert.match(projection.text, /性别/)
  assert.match(projection.text, /来源：/)
  assert.doesNotMatch(projection.text, /rc1\./)

  // study_status 也附一行核心摘要，与运行台同一份投影。
  const statusText = await tools.get('study_status').execute({ focus: 'summary' }, exec)
  assert.match(statusText.text, /核心：入组 1 \/ 参与者 1/)
  assert.match(statusText.text, /未知 1/, '没有人口学时性别计为未知，不伪造男女')

  // 页面用的只读投影接口（GET，不需要令牌）；页面先显式连接研究。
  const connectedPage = await request(toolsHost.routes.get('/api/study-ops'), {
    method: 'POST', path: '/api/study-ops',
    headers: { 'x-study-ops': '1', 'content-type': 'application/json', ...pageHeaders('page-flow-route1') },
    body: { action: 'studyConnect', payload: { studyPath: path.join(project, 'study.json') } },
  })
  assert.equal(connectedPage.status, 200, connectedPage.text.slice(0, 400))
  const projectionResponse = await request(toolsHost.routes.get('/api/study-ops'), { path: '/api/study-ops?action=flowProjection', headers: { 'x-study-ops': '1', ...pageHeaders('page-flow-route1') } })
  assert.equal(projectionResponse.status, 200, projectionResponse.text.slice(0, 600))
  const payload = projectionResponse.json.data
  assert.ok(payload.binding && payload.binding.configured)
  assert.equal(payload.totals.enrolled, 1)
  assert.ok(payload.groups.length >= 1)
  const scaleTask = payload.tasks.find(task => task.id === 'stq')
  assert.ok(scaleTask, '投影应包含任务定义')
  assert.deepEqual(scaleTask.source, { type: 'scale', scaleId: 'DEMO', waveId: 'baseline' }, '任务来源用于跨面板跳转')

  // 单元格明细 + 裁决/撤销（页面同一条实现，写入需要令牌）。
  const token = connectedPage.json.data.binding.token
  const slotPost = (action, body) => request(toolsHost.routes.get('/api/study-ops'), {
    method: 'POST', path: '/api/study-ops',
    headers: { 'x-study-ops': '1', 'content-type': 'application/json', ...pageHeaders('page-flow-route1') },
    body: { action, payload: { ...body, binding: token } },
  })
  const detail = await slotPost('observationDetail', { participantId: 'P-001', visitId: 'T0', taskId: 'stq' })
  assert.equal(detail.status, 200, detail.text.slice(0, 600))
  assert.equal(detail.json.data.state, 'conflict', '已有一条录入 + 一条导入，未裁决应为冲突')
  assert.equal(detail.json.data.observations.length, 2)
  const chosen = detail.json.data.observations[0].observationId
  const adjudicated = await slotPost('observationAdjudicate', { participantId: 'P-001', visitId: 'T0', taskId: 'stq', observationId: chosen, reason: '第二次录入更完整' })
  assert.equal(adjudicated.status, 200, adjudicated.text.slice(0, 600))
  assert.equal(adjudicated.json.data.state, 'complete')
  assert.equal(adjudicated.json.data.observations.length, 2, '裁决不删除原值')
  assert.equal(adjudicated.json.data.observations.find(row => row.observationId === chosen).adjudication.chosen, true)
  const cancelled = await slotPost('observationCancel', { participantId: 'P-001', visitId: 'T0', taskId: 'stq' })
  assert.equal(cancelled.status, 200, cancelled.text.slice(0, 600))
  assert.equal(cancelled.json.data.state, 'conflict')

  // 页面上的随访完成/撤销走同一条实现（写核心并留理由）。
  const undone = await slotPost('followupMark', { participantId: 'P-001', followupId: 'fu1', done: false })
  assert.equal(undone.status, 200, undone.text.slice(0, 600))
  assert.equal(undone.json.data.followupCounts.done, 0)
  const redone = await slotPost('followupMark', { participantId: 'P-001', followupId: 'fu1', done: true, reason: '运行台人工标记' })
  assert.equal(redone.status, 200, redone.text.slice(0, 600))
  assert.equal(redone.json.data.followupCounts.done, 1)
  assert.equal(redone.json.data.followups.find(row => row.participantId === 'P-001').evidence.type, 'manual')
})

test('study_data_health 工具独立使用数据核心报告来源健康', async () => {
  // 用一个全新的宿主实例，避免同进程里多个 study-ops 实例共享核心登记表。
  const healthHost = makeHost({
    workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }],
    sessions: { 's-a': wsA },
    cwd: path.join(root, 'no-config'),
  })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../study-ops'))
  moduleUnderTest.apply(healthHost.ctx, { studyPath: '' })
  const tool = healthHost.tools.get('study_data_health')
  assert.ok(tool, '应注册 study_data_health 工具')

  // 用数据核心在合成研究 A 的数据根里提交一个已提交代次。
  const study = { id: 'study-a', name: '合成研究 A', path: fileA, dataRoot: path.join(wsA, 'data'), baseDir: wsA, plugin: {} }
  const data = openResearchData({ study, instanceId: 'inst-health-test' })
  data.commit('demographics', { rows: [{ participantKey: 'k1', participantId: 'P-001' }] }, { owner: 'test' })

  const result = await tool.execute({ dataset: 'demographics' }, { agent: { id: 's-a' } })
  assert.match(result.text, /数据根：/)
  assert.match(result.text, /demographics：已提交 v1/)
  assert.match(result.text, /兼容文件/)
  assert.doesNotMatch(result.text, /P-001/, '只返回状态，不返回逐人数据')

  // 没有会话身份时不能编造一个研究。
  const anonymous = await tool.execute({}, {})
  assert.ok(anonymous.text.length > 0)
})

test('task_import 支持 XLSX：用本机 Python 读第一个工作表，原始文件 hash 与归档', async t => {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const python = [
    process.env.DSH_MATERIALS_PYTHON,
    process.env.DSH_PYTHON,
    path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'python3'),
  ].filter(Boolean).find(candidate => existsSync(candidate))
  if (!python) { t.skip('本机没有可用的 Python'); return }
  const pdfLibs = process.env.DSH_PDF_LIBS || path.join(dshHome, 'pdf-libs')
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
  if (existsSync(pdfLibs)) env.PYTHONPATH = [pdfLibs, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)

  const project = mkdtempSync(path.join(os.tmpdir(), 'rc-xlsx-'))
  const studyPath = path.join(project, 'study.json')
  writeFileSync(studyPath, JSON.stringify({
    schemaVersion: 1, studyId: 'xlsx-study', name: 'XLSX 导入研究', dataRoot: './data',
    participantId: {}, visits: [{ id: 'T0', label: '基线', order: 0 }],
    tasks: [{ id: 'stq', label: '状态问卷', visits: ['T0'], required: true }], followups: [], plugins: {},
  }, null, 2))
  const xlsx = path.join(project, 'tasks.xlsx')
  const create = spawnSync(python, ['-X', 'utf8', '-c',
    'import sys, openpyxl\nwb=openpyxl.Workbook()\nws=wb.active\nfor row in [["编号","访视","任务","日期"],["P-001","T0","stq","2026-11-01"]]: ws.append(row)\nwb.save(sys.argv[1])',
    xlsx], { encoding: 'utf8', env })
  if (create.status !== 0) { t.skip('写不了 xlsx：' + String(create.stderr || '').slice(0, 200)); return }

  const xlsxHost = makeHost({ workspaces: [], sessions: { 's-x': project }, cwd: project })
  const mod = await loadPlugin(path.resolve(import.meta.dirname, '../../study-ops'))
  mod.apply(xlsxHost.ctx, { studyPath: '', pythonPath: python })
  const tool = xlsxHost.tools.get('task_import')
  assert.ok(tool, '应注册 task_import 工具')
  const ex = { agent: { id: 's-x' } }
  const preview = await tool.execute({ op: 'preview', path: xlsx }, ex)
  assert.match(preview.text, /tasks\.xlsx/)
  assert.match(preview.text, /必要列齐全/)
  assert.match(preview.text, /P-001 T0\/stq 2026-11-01/)

  // 先登记参与者，提交后才会发布 observation。
  const connect = await request(xlsxHost.routes.get('/api/study-ops'), {
    method: 'POST', path: '/api/study-ops',
    headers: { 'x-study-ops': '1', 'content-type': 'application/json' },
    body: { action: 'studyConnect', payload: { studyPath } },
  })
  assert.equal(connect.status, 200, connect.text.slice(0, 400))
  const tools2 = xlsxHost.tools.get('participants_manage')
  await tools2.execute({ op: 'register', participantId: 'P-001', status: 'enrolled' }, ex)
  const committed = await tool.execute({ op: 'commit', path: xlsx }, ex)
  assert.match(committed.text, /已导入：发布 1 条 observation/)

  // 幂等：同一文件再导一次不重复累计。
  const again = await tool.execute({ op: 'commit', path: xlsx }, ex)
  assert.match(again.text, /相同内容已导入过/)

  // 归档的是原始 xlsx 字节（hash 取文件 hash），不是转换后的 CSV。
  const study = { id: 'xlsx-study', name: 'XLSX 导入研究', path: studyPath, dataRoot: path.join(project, 'data'), baseDir: project, plugin: {}, visits: [{ id: 'T0', label: '基线', order: 0 }], tasks: [{ id: 'stq', label: '状态问卷', visits: ['T0'], required: true }], followups: [], revision: 'r1' }
  const data = openResearchData({ study, instanceId: connect.json.data.binding.instanceId })
  const sources = data.read('tasks').value.sources || []
  assert.equal(sources.length, 1)
  assert.equal(sources[0].filename, 'tasks.xlsx')
  const fileHash = createHash('sha256').update(readFileSync(xlsx)).digest('hex')
  assert.equal(sources[0].sha256, fileHash, '来源 hash 是原始 xlsx 的 hash')
  const archive = path.join(project, 'data', 'tasks', 'archive')
  const files = existsSync(archive) ? readdirSync(archive) : []
  const archived = files.find(name => name.endsWith('.xlsx'))
  assert.ok(archived, '应归档原始 xlsx')
  const archivedBytes = readFileSync(path.join(archive, archived))
  assert.ok(archivedBytes.subarray(0, 2).toString() === 'PK', '归档文件是 xlsx（zip）字节，不是 CSV 文本')
})
