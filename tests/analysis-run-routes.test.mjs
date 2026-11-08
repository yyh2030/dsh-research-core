/**
 * analysis-run 的绑定隔离验收：真实插件 + 真实研究核心 + 临时合成研究。
 * 包括一次真实的本地 Python 分析运行（用 DSH 自带运行时）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test, { before } from 'node:test'

import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'
import { openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PYTHON = process.env.DSH_ANALYSIS_PYTHON || process.env.DSH_PYTHON
  || path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
const root = mkdtempSync(path.join(os.tmpdir(), 'rc-analysis-'))
const wsA = path.join(root, 'ws-a')
const wsB = path.join(root, 'ws-b')
const store = path.join(root, 'store')
process.env.DSH_RESEARCH_STORE = store

function writeStudy(dir, studyId, name) {
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  const file = path.join(dir, 'study.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, studyId, name, dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))
  return file
}

function writeCsv(dir, rows) {
  const file = path.join(dir, 'data.csv')
  const lines = ['participantId,group,score,score_post']
  rows.forEach((row, index) => lines.push(`P-${String(index + 1).padStart(3, '0')},${row.group},${row.score},${row.score + 1}`))
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

const fileA = writeStudy(wsA, 'study-a', '合成研究 A')
const fileB = writeStudy(wsB, 'study-b', '合成研究 B')
const csvA = writeCsv(wsA, Array.from({ length: 12 }, (_, i) => ({ group: i % 2 ? 'B' : 'A', score: 10 + (i % 5) })))

let host
let handler
let tools
let sixBRunId = null
let sixCRunId = null

before(async () => {
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../analysis-run'))
  host = makeHost({ workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }], sessions: { 's-a': wsA, 's-b': wsB }, cwd: path.join(root, 'no-config') })
  moduleUnderTest.apply(host.ctx, { studyPath: '', pythonPath: PYTHON })
  handler = host.routes.get('/api/analysis-run')
  tools = host.tools
  assert.ok(handler, 'analysis-run 应注册路由')
})

const call = options => request(handler, options)
const get = (action, pageId, extra = '') => call({ path: `/api/analysis-run?action=${action}${extra}`, headers: { 'x-analysis-run': '1', ...pageHeaders(pageId) } })
const post = (action, payload, pageId) => call({ method: 'POST', path: '/api/analysis-run', headers: { 'x-analysis-run': '1', 'content-type': 'application/json', ...pageHeaders(pageId) }, body: { action, payload } })

test('无配置时进入空研究且可读', async () => {
  const response = await get('status', 'page-empty0001')
  assert.equal(response.status, 200, response.text)
  assert.equal(response.json.data.binding.state, 'empty')
  assert.equal(response.json.data.binding.configured, false)
})

test('连接研究后方案与排除都写在绑定研究的输出目录', async () => {
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-aaaa0001')
  assert.equal(connected.status, 200, JSON.stringify(connected.json))
  assert.equal(connected.json.data.study.id, 'study-a')
  const token = connected.json.data.binding.token

  const schema = await get('schema', 'page-aaaa0001')
  assert.equal(schema.json.data.study.id, 'study-a')
  const plan = { dataPath: csvA, idColumn: 'participantId', outcome: 'score', layout: 'wide', groupColumns: ['group'], covariates: [], pairedColumns: ['score', 'score_post'], analyses: ['descriptives'], gate: { minSubjects: 4 } }
  const saved = await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, 'page-aaaa0001')
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.ok(existsSync(path.join(wsA, 'data', 'analysis', 'plan.json')))
  assert.equal(existsSync(path.join(wsB, 'data', 'analysis', 'plan.json')), false)

  const excluded = await post('exclude', { op: 'add', id: 'P-001', reason: '合成测试排除', revision: schema.json.data.exclusionsRevision, binding: token }, 'page-aaaa0001')
  assert.equal(excluded.status, 200, JSON.stringify(excluded.json))
  assert.ok(existsSync(path.join(wsA, 'data', 'analysis', 'exclusions.json')))
})

test('本地分析运行使用页面绑定的研究并产出结果', async () => {
  const status = await get('status', 'page-aaaa0001')
  assert.equal(status.json.data.study.id, 'study-a')
  const run = await post('run', { stage: 'all', binding: status.json.data.binding.token }, 'page-aaaa0001')
  assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 1200))
  const runId = run.json.data.runId
  assert.ok(runId, '应返回运行编号')

  const results = await get('results', 'page-aaaa0001', '&run=' + encodeURIComponent(runId))
  assert.equal(results.status, 200, results.text.slice(0, 800))
  assert.ok(results.json.data.tables.length >= 1, '应至少有一张统计表')
  assert.equal(results.json.data.study.id, 'study-a')
  assert.ok(existsSync(path.join(wsA, 'data', 'analysis', 'runs', runId, 'meta.json')))
  assert.equal(existsSync(path.join(wsB, 'data', 'analysis', 'runs', runId)), false)
})

test('6A 描述统计补齐：IQR/SE/CI 与类别频数；环境锁漂移时明确失败', async () => {
  const csv = path.join(wsA, 'six-a.csv')
  writeFileSync(csv, 'participantId,group,score,sex\nP-001,A,1,F\nP-002,A,2,F\nP-003,A,3,M\nP-004,A,4,M\nP-005,B,2,F\nP-006,B,4,M\n')
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-aaaa0001')
  const token = connected.json.data.binding.token
  const schema = await get('schema', 'page-aaaa0001')
  const plan = {
    dataPath: csv, idColumn: 'participantId', outcome: 'score', layout: 'wide',
    groupColumns: ['group'], covariates: [], pairedColumns: [], analyses: ['descriptives'],
    frequencies: [{ column: 'sex' }], gate: { minSubjects: 2 },
  }
  const saved = await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, 'page-aaaa0001')
  assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 600))
  // 前面的用例把 P-001 排除了；这里先撤销，保证 A 组是 1/2/3/4 四行。
  const cleared = await post('exclude', { op: 'remove', id: 'P-001', reason: '6A 用例需要完整行', revision: schema.json.data.exclusionsRevision, binding: token }, 'page-aaaa0001')
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json).slice(0, 600))

  const run = await post('run', { stage: 'all', binding: token }, 'page-aaaa0001')
  assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 1200))
  const runId = run.json.data.runId
  const tablesDir = path.join(wsA, 'data', 'analysis', 'runs', runId, 'tables')
  const describe = readFileSync(path.join(tablesDir, 'descriptives.csv'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.split(','))
  const header = describe[0]
  const record = group => {
    const cells = describe.find(line => line[header.indexOf('group')] === group)
    return Object.fromEntries(header.map((name, index) => [name, cells[index]]))
  }
  const a = record('A')
  const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(Number(actual) - expected) <= tolerance, `${actual} ≈ ${expected}`)
  near(a.mean, 2.5)
  near(a.sd, Math.sqrt(5 / 3))
  near(a.se, Math.sqrt(5 / 3) / 2)
  near(a.q1, 1.75)
  near(a.q3, 3.25)
  near(a.iqr, 1.5)
  near(a.valueRange, 3)
  assert.equal(Number(a.validObservations), 4)
  assert.equal(Number(a.ciLevel), 0.95)
  // 95% t 区间：t(3)=3.1824，se=0.6455 → 0.4460 ~ 4.5540
  near(a.ciLow, 2.5 - 3.182446305283708 * (Math.sqrt(5 / 3) / 2), 1e-6)
  near(a.ciHigh, 2.5 + 3.182446305283708 * (Math.sqrt(5 / 3) / 2), 1e-6)

  const freq = readFileSync(path.join(tablesDir, 'frequencies.csv'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.split(','))
  const freqHeader = freq[0]
  const freqRow = (group, value) => {
    const line = freq.find(row => row[freqHeader.indexOf('group')] === group && row[freqHeader.indexOf('value')] === value)
    return Object.fromEntries(freqHeader.map((name, index) => [name, line[index]]))
  }
  assert.equal(freqRow('A', 'F').count, '2')
  assert.equal(freqRow('A', 'F').denominator, '4')
  assert.equal(Number(freqRow('A', 'F').percent), 50)
  assert.equal(freqRow('A', 'M').count, '2')
  assert.equal(freqRow('B', 'F').denominator, '2')

  // 同输入 + 同方案 + 同代码 + 同环境 → 复用缓存，不新增运行目录。
  const runsDir = path.join(wsA, 'data', 'analysis', 'runs')
  const before = readdirSync(runsDir).length
  const again = await post('run', { stage: 'all', binding: token }, 'page-aaaa0001')
  assert.equal(again.status, 200, JSON.stringify(again.json).slice(0, 600))
  assert.equal(again.json.data.reused, true)
  assert.equal(again.json.data.runId, runId)
  assert.equal(readdirSync(runsDir).length, before)
  // 输入一变就产生新运行，不复用旧结果。
  writeFileSync(csv, 'participantId,group,score,sex\nP-001,A,2,F\nP-002,A,2,F\nP-003,A,3,M\nP-004,A,4,M\nP-005,B,2,F\nP-006,B,4,M\n')
  const changed = await post('run', { stage: 'all', binding: token }, 'page-aaaa0001')
  assert.equal(changed.status, 200, JSON.stringify(changed.json).slice(0, 600))
  assert.notEqual(changed.json.data.runId, runId)
  assert.equal(changed.json.data.reused, undefined)

  // 未支持或不合法的建模选项必须明确报错，不能拟合近似模型。
  for (const [patch, pattern] of [
    [{ distribution: 'poisson' }, /未支持.*分布/],
    [{ interactions: ['group'] }, /interaction|交互/],
    [{ randomSlopes: ['group'] }, /未支持.*随机斜率/],
    [{ sumsOfSquares: 'IV' }, /sumsOfSquares/],
  ]) {
    const currentRevision = (await get('schema', 'page-aaaa0001')).json.data.planRevision
    const saved = await post('plan', { plan: { ...plan, ...patch }, revision: currentRevision, binding: token }, 'page-aaaa0001')
    assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 400))
    const rejected = await post('run', { stage: 'all', binding: token }, 'page-aaaa0001')
    assert.ok(rejected.status >= 400, '未支持选项应被拒绝：' + JSON.stringify(patch))
    assert.match(JSON.stringify(rejected.json), pattern)
  }
  // 恢复一个可运行方案，避免影响后续断言。
  const restoreRevision = (await get('schema', 'page-aaaa0001')).json.data.planRevision
  await post('plan', { plan, revision: restoreRevision, binding: token }, 'page-aaaa0001')

  // 环境锁：首次运行会写锁；篡改后应明确失败，不能悄悄换环境继续算。
  const lockFile = path.join(wsA, 'data', 'analysis', 'environment.lock.json')
  assert.ok(existsSync(lockFile), '第一次运行应生成环境锁')
  writeFileSync(lockFile, JSON.stringify({ schemaVersion: 1, pythonMajorMinor: '0.0', implementation: 'CPython', packages: { numpy: '0.0.0' } }))
  const drifted = await post('run', { stage: 'all', binding: token }, 'page-aaaa0001')
  assert.ok(drifted.status >= 400, '环境漂移应失败')
  assert.match(JSON.stringify(drifted.json), /环境/, '错误要说明环境与锁不一致')
  rmSync(lockFile, { force: true })

  // 缺后端时明确"环境待准备"，不是 failed，也不换检验。
  const environment = JSON.parse(readFileSync(path.join(wsA, 'data', 'analysis', 'runs', runId, 'environment.json'), 'utf8'))
  if (!(environment.packages || {}).statsmodels) {
    const planWithModel = { ...plan, analyses: ['descriptives', 'regression'] }
    const revision = (await get('schema', 'page-aaaa0001')).json.data.planRevision
    await post('plan', { plan: planWithModel, revision, binding: token }, 'page-aaaa0001')
    const runModel = await post('run', { stage: 'all', binding: token }, 'page-aaaa0001')
    assert.equal(runModel.status, 200, JSON.stringify(runModel.json).slice(0, 800))
    const nodes = runModel.json.data.meta.nodes
    assert.equal(nodes.regression.status, 'not_run')
    assert.match(nodes.regression.reason, /环境待准备/)
  }
})

test('从已提交代次汇合分析表：source=core 时不读外部 CSV', async () => {
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-core0001')
  const token = connected.json.data.binding.token
  const instanceId = connected.json.data.binding.instanceId

  // 用同一个实例身份往核心里写参与者与人口学（页面与分析插件都读这份实例）。
  const study = { id: 'study-a', name: '合成研究 A', path: fileA, dataRoot: path.join(wsA, 'data'), baseDir: wsA, plugin: {}, visits: [], tasks: [], followups: [], revision: 'rev-1' }
  const data = openResearchData({ study, instanceId })
  const flow = openFlow({ data, study })
  flow.participants.register({ participantId: 'P-101', status: 'enrolled', groups: { condition: 'A' } })
  flow.participants.register({ participantId: 'P-102', status: 'enrolled', groups: { condition: 'B' } })
  flow.demographics.commit({
    document: {
      schemaVersion: 2, studyId: 'study-a', name: '人口学',
      columns: [{ key: 'age', label: '年龄', kind: 'number' }, { key: 'sex', label: '性别', kind: 'text' }],
      rows: [{ id: 'P-101', values: { age: '20', sex: 'F' } }, { id: 'P-102', values: { age: '30', sex: 'M' } }],
    },
  })

  const plan = {
    source: { type: 'core' }, idColumn: 'participantId', outcome: 'age', layout: 'wide',
    groupColumns: ['sex'], covariates: [], pairedColumns: [], analyses: ['descriptives'], gate: { minSubjects: 2 },
    variables: [
      { name: 'participantId', type: 'participant', field: 'participantId' },
      { name: 'age', type: 'demographics', column: 'age' },
      { name: 'sex', type: 'demographics', column: 'sex' },
    ],
  }
  const schema = await get('schema', 'page-core0001')
  const saved = await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, 'page-core0001')
  assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 600))
  const cleared = await post('exclude', { op: 'remove', id: 'P-001', reason: '核心汇合用例', revision: schema.json.data.exclusionsRevision, binding: token }, 'page-core0001')
  assert.ok(cleared.status === 200 || cleared.status === 400, '排除名单里没有 P-001 时允许失败')

  const run = await post('run', { stage: 'all', binding: token }, 'page-core0001')
  assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 1200))
  const meta = run.json.data.meta
  assert.equal(meta.dataset.type, 'core')
  assert.match(meta.dataset.hash, /^[0-9a-f]{64}$/)
  assert.equal(meta.dataset.stats.rows, 2)
  assert.ok(existsSync(meta.dataset.path), '汇合出的 CSV 应落在输出目录 datasets/')
  const csv = readFileSync(meta.dataset.path, 'utf8')
  assert.match(csv, /P-101/)
  assert.match(csv, /P-102/)
  const table = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', run.json.data.runId, 'tables', 'descriptives.csv'), 'utf8')
  assert.match(table, /F/)
  assert.match(table, /M/)
  assert.equal(run.json.data.reused, undefined)

  // 状态页对 core 来源显示当前汇合版本；核心一变就提示"有更新待运行"。
  const statusNow = await get('status', 'page-core0001')
  assert.equal(statusNow.json.data.source.kind, 'core')
  assert.equal(statusNow.json.data.source.exists, true, JSON.stringify(statusNow.json.data.source))
  assert.equal(statusNow.json.data.source.hash, meta.dataset.hash)
  assert.equal(statusNow.json.data.pendingChanges, false)
  // 统计后端来源：插件自带 vendor 时 scipy 应从 vendor 加载（插件安装后即成立）。
  assert.ok(['vendor', 'runtime'].includes(statusNow.json.data.backendsSource))
  assert.equal(statusNow.json.data.backends.descriptives.ok, true)
  flow.participants.register({ participantId: 'P-103', status: 'enrolled' })
  const statusAfter = await get('status', 'page-core0001')
  assert.equal(statusAfter.json.data.pendingChanges, true)
  // 并发运行时第二个请求排队合并，运行结束后补跑一次，队列清空。
  const [first, second] = await Promise.all([
    post('run', { stage: 'all', binding: token }, 'page-core0001'),
    post('run', { stage: 'all', binding: token }, 'page-core0001'),
  ])
  const queued = [first, second].find(response => response.json.data && response.json.data.queued === true)
  const started = [first, second].find(response => response.json.data && response.json.data.runId)
  assert.ok(queued || started, '并发请求应有一个开始、一个排队或复用')
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await get('status', 'page-core0001')
    if (!state.json.data.queued && !state.json.data.busy) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const drained = await get('status', 'page-core0001')
  assert.equal(drained.json.data.queued, false, '补跑完成后队列应清空')
})

test('预处理 DAG：中心化派生列可用；非法变换使下游节点取消；旧运行标记 stale', async () => {
  const csv = path.join(wsA, 'dag.csv')
  writeFileSync(csv, 'participantId,score\nP-201,10\nP-202,20\nP-203,30\nP-204,40\n')
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-dag00001')
  const token = connected.json.data.binding.token
  const base = { dataPath: csv, idColumn: 'participantId', outcome: 'score_c', layout: 'wide', groupColumns: [], covariates: [], pairedColumns: [], analyses: ['descriptives'], gate: { minSubjects: 2 } }
  const plan = { ...base, transforms: [{ op: 'center', column: 'score', name: 'score_c' }] }
  const schema = await get('schema', 'page-dag00001')
  const saved = await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, 'page-dag00001')
  assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 400))
  const run = await post('run', { stage: 'all', binding: token }, 'page-dag00001')
  assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 900))
  const nodes = run.json.data.meta.nodes
  assert.equal(nodes.prepare.status, 'executed')
  assert.equal(nodes.prepare.result.transforms[0].op, 'center')
  assert.equal(nodes.descriptives.dependsOn.includes('prepare'), true)
  const table = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', run.json.data.runId, 'tables', 'descriptives.csv'), 'utf8')
  assert.match(table, /0(\.0+)?,/, '中心化后均值应为 0')
  const firstRunId = run.json.data.runId

  // 非法变换（对含 0 的列取对数）→ 准备节点失败，分析节点取消。
  writeFileSync(csv, 'participantId,score\nP-201,0\nP-202,20\nP-203,30\nP-204,40\n')
  const badPlan = { ...base, transforms: [{ op: 'log', column: 'score', name: 'score_c' }] }
  const revision = (await get('schema', 'page-dag00001')).json.data.planRevision
  await post('plan', { plan: badPlan, revision, binding: token }, 'page-dag00001')
  const failed = await post('run', { stage: 'all', binding: token }, 'page-dag00001')
  assert.ok(failed.status >= 400, '非法变换应失败')
  assert.match(JSON.stringify(failed.json), /log|正数|positive/i)

  // 数据变过 → 旧运行在列表里显示 stale。
  writeFileSync(csv, 'participantId,score\nP-201,12\nP-202,22\nP-203,32\nP-204,42\n')
  const goodPlan = { ...base, transforms: [{ op: 'center', column: 'score', name: 'score_c' }] }
  const revision2 = (await get('schema', 'page-dag00001')).json.data.planRevision
  await post('plan', { plan: goodPlan, revision: revision2, binding: token }, 'page-dag00001')
  const second = await post('run', { stage: 'all', binding: token }, 'page-dag00001')
  assert.equal(second.status, 200, JSON.stringify(second.json).slice(0, 800))
  const status = await get('status', 'page-dag00001')
  const rows = status.json.data.runs
  const older = rows.find(row => row.runId === firstRunId)
  assert.equal(older.stale, true, '输入变化的旧运行应标记 stale：' + JSON.stringify(rows.slice(0, 4)))
  assert.equal(status.json.data.runs[0].stale, false)
})

test('6B 线性模型：交互项、SS 类型、系数 CI 与预设对比', async () => {
  const csv = path.join(wsA, 'six-b.csv')
  const rows = [
    ['P-301', 'A', 'X', '1'], ['P-302', 'A', 'X', '2'], ['P-303', 'A', 'Y', '3'], ['P-304', 'A', 'Y', '4'],
    ['P-305', 'B', 'X', '6'], ['P-306', 'B', 'X', '8'], ['P-307', 'B', 'Y', '10'], ['P-308', 'B', 'Y', '12'],
  ]
  writeFileSync(csv, 'participantId,group,cond,score\n' + rows.map(row => row.join(',')).join('\n') + '\n')
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-6b0000001')
  const token = connected.json.data.binding.token
  const plan = {
    dataPath: csv, idColumn: 'participantId', outcome: 'score', layout: 'wide',
    groupColumns: ['group', 'cond'], covariates: [], pairedColumns: [],
    analyses: ['regression'], gate: { minSubjects: 4 },
    interactions: [['group', 'cond']], sumsOfSquares: 'III',
    contrasts: [{ column: 'group', levels: ['A', 'B'], name: 'B - A' }],
  }
  const schema = await get('schema', 'page-6b0000001')
  const saved = await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, 'page-6b0000001')
  assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 500))
  const run = await post('run', { stage: 'all', binding: token }, 'page-6b0000001')
  sixBRunId = run.json.data.runId
  assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 1200))
  const result = run.json.data.meta.nodes.regression
  assert.equal(result.status, 'executed', JSON.stringify(result).slice(0, 400))
  const value = result.result
  assert.equal(value.sumsOfSquares, 3)
  // 交互项出现在方差分析表里，并有偏 eta²（展示名已从内部编码翻成 group × cond）。
  const interaction = value.anova.find(row => /group × cond/.test(row.term))
  assert.ok(interaction, '应包含交互项：' + JSON.stringify(value.anova.map(row => row.term)))
  assert.ok(Number(interaction.partialEtaSquared) > 0 && Number(interaction.partialEtaSquared) <= 1)
  // 系数带 95% CI，且区间包含点估计。
  const coefficient = value.coefficients.find(row => /group = B/.test(row.term))
  assert.ok(coefficient, '系数名应可读：' + JSON.stringify(value.coefficients.map(row => row.term)))
  assert.ok(coefficient.ciLow < coefficient.estimate && coefficient.estimate < coefficient.ciHigh)
  // 对比：模型里有交互项时，group 的系数是"参考水平 cond=X 上的组间差"：
  // A/X 均值 (1+2)/2=1.5，B/X 均值 (6+8)/2=7 → 5.5（不是边际均值差 6.5）。
  assert.equal(value.contrasts.length, 1)
  const contrast = value.contrasts[0]
  assert.equal(contrast.from, 'A')
  assert.equal(contrast.to, 'B')
  assert.ok(Math.abs(contrast.estimate - 5.5) < 1e-9, 'estimate: ' + contrast.estimate)
  // 总体检验与预设对比也要落成表，而不只留在节点 JSON 里。
  const tables = run.json.data.meta.tables.map(table => table.key)
  assert.ok(tables.includes('anova'), JSON.stringify(tables))
  assert.ok(tables.includes('contrasts'), JSON.stringify(tables))
  assert.ok(contrast.ciLow < contrast.estimate && contrast.estimate < contrast.ciHigh)
  assert.equal(value.designColumns, 4, '截距 + group + cond + 交互')
})

test('6C 重复测量：随机截距的 ML/REML、方差成分与诊断；配对 t 独立核对', async () => {
  // 6 名参与者的 T0/T1 差值依次为 1..6（均值 3.5）→ 混合模型 within 效应与配对 t 都可手算。
  const csv = path.join(wsA, 'six-c.csv')
  const lines = ['participantId,visit,score']
  const deltas = [1, 2, 3, 4, 5, 6]
  deltas.forEach((delta, index) => {
    const base = 10 + index + 1
    lines.push(`P-40${index + 1},T0,${base}`)
    lines.push(`P-40${index + 1},T1,${base + delta}`)
  })
  writeFileSync(csv, lines.join('\n') + '\n')
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-6c0000001')
  const token = connected.json.data.binding.token
  const plan = {
    dataPath: csv, idColumn: 'participantId', outcome: 'score', layout: 'long',
    within: { column: 'visit', levels: ['T0', 'T1'] }, groupColumns: [], covariates: [], pairedColumns: [],
    analyses: ['mixed', 'paired'], gate: { minSubjects: 4 },
  }
  const schema = await get('schema', 'page-6c0000001')
  await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, 'page-6c0000001')
  const run = await post('run', { stage: 'all', binding: token }, 'page-6c0000001')
  sixCRunId = run.json.data.runId
  assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 1200))
  const mixed = run.json.data.meta.nodes.mixed
  assert.equal(mixed.status, 'executed', JSON.stringify(mixed).slice(0, 500))
  const value = mixed.result
  assert.equal(value.converged, true)
  assert.equal(value.method, 'ML random intercept')
  assert.equal(value.reml, false)
  assert.equal(value.singular, false)
  assert.equal(value.groupSizes.min, 2)
  assert.equal(value.groupSizes.max, 2)
  assert.equal(value.subjects, 6)
  const within = value.coefficients.find(row => /T\.T1/.test(row.term))
  assert.ok(Math.abs(within.estimate - 3.5) < 1e-6, 'within effect: ' + within.estimate)
  assert.ok(within.ciLow < within.estimate && within.estimate < within.ciHigh)
  assert.ok(value.varianceComponents.groupVariance >= 0)
  assert.ok(value.varianceComponents.residualVariance >= 0)

  const paired = run.json.data.meta.nodes.paired
  assert.equal(paired.status, 'executed', JSON.stringify(paired).slice(0, 400))
  // 配对：差值 1..6 → 均值 3.5，t = 3.5 / (1.8708/√6) ≈ 4.58258，df = 5
  assert.ok(Math.abs(paired.result.estimate - 3.5) < 1e-9)
  assert.ok(Math.abs(paired.result.t - 4.58257569495584) < 1e-6, 't: ' + paired.result.t)
  assert.equal(paired.result.df, 5)
  assert.ok(paired.result.ciLow < 3.5 && 3.5 < paired.result.ciHigh)

  // REML 选择必须显式反映在结果里。
  const remlPlan = { ...plan, reml: true }
  const revision = (await get('schema', 'page-6c0000001')).json.data.planRevision
  await post('plan', { plan: remlPlan, revision, binding: token }, 'page-6c0000001')
  const remlRun = await post('run', { stage: 'all', binding: token }, 'page-6c0000001')
  assert.equal(remlRun.status, 200, JSON.stringify(remlRun.json).slice(0, 800))
  assert.equal(remlRun.json.data.meta.nodes.mixed.result.method, 'REML random intercept')
  assert.equal(remlRun.json.data.meta.nodes.mixed.result.reml, true)
})

test('07 样本特征表：数值与分类变量按整体/分组给出 n、均值/SD 与计数/百分比', async () => {
  const csv = path.join(wsA, 'six-b.csv')
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-sample001')
  const token = connected.json.data.binding.token
  const plan = {
    dataPath: csv, idColumn: 'participantId', outcome: 'score', layout: 'wide',
    groupColumns: ['group'], covariates: [], pairedColumns: [], analyses: ['sample'], gate: { minSubjects: 2 },
    sampleColumns: [{ column: 'score', kind: 'numeric', label: '得分' }, { column: 'group', kind: 'categorical', label: '分组' }],
  }
  const schema = await get('schema', 'page-sample001')
  const saved = await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, 'page-sample001')
  assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 400))
  const run = await post('run', { stage: 'all', binding: token }, 'page-sample001')
  assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 900))
  assert.equal(run.json.data.meta.nodes.sample.status, 'executed')
  const table = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', run.json.data.runId, 'tables', 'sample.csv'), 'utf8')
  const grid = table.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.split(','))
  const rows = grid.slice(1).map(line => Object.fromEntries(grid[0].map((name, index) => [name, line[index]])))
  const overall = rows.find(row => row.scope === '整体' && row.variable === 'score')
  assert.equal(overall.kind, '数值')
  assert.equal(Number(overall.n), 8)
  assert.ok(Math.abs(Number(overall.mean) - 5.75) < 1e-9, 'overall mean: ' + overall.mean)
  const groupA = rows.find(row => row.scope === 'group=A' && row.variable === 'score')
  assert.equal(Number(groupA.n), 4)
  assert.ok(Math.abs(Number(groupA.mean) - 2.5) < 1e-9)
  const cat = rows.filter(row => row.kind === '分类' && row.scope === '整体')
  assert.equal(cat.length, 2)
  assert.equal(Number(cat.find(row => row.level === 'A').count), 4)
  assert.equal(Number(cat.find(row => row.level === 'A').percent), 50)
  // 声明了不存在的列：样本特征节点失败并给出原因（其余模块仍可完成 → partial）。
  const bad = { ...plan, sampleColumns: [{ column: 'nope', kind: 'numeric' }] }
  const revision = (await get('schema', 'page-sample001')).json.data.planRevision
  await post('plan', { plan: bad, revision, binding: token }, 'page-sample001')
  const failed = await post('run', { stage: 'all', binding: token }, 'page-sample001')
  assert.equal(failed.status, 200)
  assert.equal(failed.json.data.meta.status, 'partial')
  assert.equal(failed.json.data.meta.nodes.sample.status, 'failed')
  assert.match(failed.json.data.meta.nodes.sample.reason, /nope/)
})

test('07 敏感性分析：全部观测 vs 完整病例的分组均值差与剔除人数', async () => {
  const csv = path.join(wsA, 'sensitivity.csv')
  writeFileSync(csv, [
    'participantId,group,cond,score,cov',
    'P-501,A,X,1,1', 'P-502,A,X,2,2', 'P-503,A,Y,3,3', 'P-504,A,Y,4,', 
    'P-505,B,X,6,1', 'P-506,B,X,8,2', 'P-507,B,Y,10,3', 'P-508,B,Y,12,4',
  ].join('\n') + '\n')
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-sens001')
  const token = connected.json.data.binding.token
  const plan = {
    dataPath: csv, idColumn: 'participantId', outcome: 'score', layout: 'wide',
    groupColumns: ['group'], covariates: ['cov'], pairedColumns: [], analyses: ['sensitivity'], gate: { minSubjects: 2 },
  }
  const schema = await get('schema', 'page-sens001')
  await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, 'page-sens001')
  const run = await post('run', { stage: 'all', binding: token }, 'page-sens001')
  assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 900))
  assert.equal(run.json.data.meta.nodes.sensitivity.status, 'executed')
  const grid = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', run.json.data.runId, 'tables', 'sensitivity.csv'), 'utf8')
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.split(','))
  const rows = grid.slice(1).map(line => Object.fromEntries(grid[0].map((name, index) => [name, line[index]])))
  const overall = rows.find(row => row.scope === '整体')
  // 全部 8 人；完整病例 7 人（P-504 的 cov 缺失）；均值差 = 完整病例均值 − 全部均值
  assert.equal(Number(overall.nAll), 8)
  assert.equal(Number(overall.nComplete), 7)
  assert.equal(Number(overall.dropped), 1)
  const completeMean = (1 + 2 + 3 + 6 + 8 + 10 + 12) / 7
  assert.ok(Math.abs(Number(overall.meanComplete) - completeMean) < 1e-9, 'complete mean: ' + overall.meanComplete)
  assert.ok(Math.abs(Number(overall.deltaMean) - (completeMean - 46 / 8)) < 1e-9)
  const groupA = rows.find(row => row.scope === 'group=A')
  assert.equal(Number(groupA.dropped), 1)
})

test('扩展模块：相关、信度、t 检验、方差分析、中介都能执行并给出可核对的结果', async () => {
  const csv = path.join(wsA, 'extended.csv')
  const lines = ['id,x,m,y,g,i1,i2,i3,g3']
  let seed = 12345
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let index = 1; index <= 60; index += 1) {
    const x = index
    const m = 0.8 * x + (rand() * 2 - 1) * 2
    const y = 0.7 * m + 0.3 * x + (rand() * 2 - 1) * 2
    const i1 = (index % 5) + 1
    lines.push([index, x, m.toFixed(3), y.toFixed(3), index % 2 === 0 ? 'A' : 'B', i1, i1 + (index % 2), i1 - (index % 2), ['A', 'B', 'C'][index % 3]].join(','))
  }
  writeFileSync(csv, lines.join('\n') + '\n')
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-ext000001')
  const token = connected.json.data.binding.token
  const base = { dataPath: csv, idColumn: 'id', outcome: 'y', layout: 'wide', groupColumns: [], covariates: [], pairedColumns: [], gate: { minSubjects: 10 } }
  const runModule = async (name, extra) => {
    const schema = await get('schema', 'page-ext000001')
    await post('plan', { plan: { ...base, analyses: [name], ...extra }, revision: schema.json.data.planRevision, binding: token }, 'page-ext000001')
    const run = await post('run', { stage: 'all', binding: token }, 'page-ext000001')
    assert.equal(run.status, 200, name + ' ' + JSON.stringify(run.json).slice(0, 600))
    return run.json.data
  }

  const correlation = await runModule('correlation', { correlation: { columns: ['x', 'm', 'y'], method: 'pearson', correct: 'bh' } })
  assert.equal(correlation.meta.nodes.correlation.status, 'executed')
  const corrTable = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', correlation.runId, 'tables', 'correlation.csv'), 'utf8')
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1).map(line => line.split(','))
  const xm = corrTable.find(row => row[1] === 'x' && row[2] === 'm')
  assert.ok(Math.abs(Number(xm[6]) - 0.997) < 0.01, 'corr x-m: ' + xm[6])
  assert.ok(Number(xm[12]) > 0 && Number(xm[12]) <= 1, 'BH 校正 p 应在 (0,1]')

  const reliability = await runModule('reliability', { reliability: [{ name: '测试量表', items: ['i1', 'i2', 'i3'] }] })
  assert.equal(reliability.meta.nodes.reliability.status, 'executed')
  const alphaRow = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', reliability.runId, 'tables', 'reliability.csv'), 'utf8')
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/)[1].split(',')
  assert.equal(Number(alphaRow[1]), 60)
  assert.equal(Number(alphaRow[2]), 3)
  assert.ok(Number(alphaRow[3]) > 0.9, 'alpha: ' + alphaRow[3])

  const ttest = await runModule('ttest', { ttest: { kind: 'independent', group: 'g', outcome: 'y' } })
  assert.equal(ttest.meta.nodes.ttest.status, 'executed')
  const tRow = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', ttest.runId, 'tables', 'ttest.csv'), 'utf8')
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/)[1].split(',')
  assert.equal(tRow[0], '独立样本（Welch）')
  assert.ok(Math.abs(Number(tRow[5])) < 2, 'meanDiff: ' + tRow[5])
  assert.ok(Number(tRow[9]) > 0.1, 'p: ' + tRow[9])

  const anova = await runModule('anova', { anova: { factors: ['g3'], sumsOfSquares: 'II' } })
  assert.equal(anova.meta.nodes.anova.status, 'executed')
  const anovaRow = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', anova.runId, 'tables', 'anova.csv'), 'utf8')
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/)[1].split(',')
  assert.equal(Number(anovaRow[1]), 2)
  assert.ok(Number(anovaRow[2]) > 0)

  const mediation = await runModule('mediation', { mediation: { x: 'x', m: 'm', y: 'y', bootstrap: 200, seed: 7 } })
  assert.equal(mediation.meta.nodes.mediation.status, 'executed')
  const medRows = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', mediation.runId, 'tables', 'mediation.csv'), 'utf8')
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1).map(line => line.split(','))
  const a = Number(medRows[0][1]); const b = Number(medRows[1][1]); const indirect = Number(medRows[3][1])
  assert.ok(Math.abs(a - 0.8) < 0.08, 'a: ' + a)
  assert.ok(Math.abs(b - 0.7) < 0.1, 'b: ' + b)
  assert.ok(Math.abs(indirect - a * b) < 1e-9)
  assert.ok(Number(medRows[3][3]) < indirect && indirect < Number(medRows[3][4]), 'bootstrap CI 应包含间接效应')
})

test('自定义脚本：表格进入运行快照，脚本报错与无产出都明确失败', async () => {
  const csv = path.join(wsA, 'script.csv')
  const lines = ['id,y,g']
  for (let index = 1; index <= 12; index += 1) lines.push([index, index * 2, index % 2 ? 'A' : 'B'].join(','))
  writeFileSync(csv, lines.join('\n') + '\n')
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-scr00001')
  const token = connected.json.data.binding.token
  const base = { dataPath: csv, idColumn: 'id', outcome: 'y', layout: 'wide', groupColumns: [], covariates: [], pairedColumns: [], gate: { minSubjects: 3 } }
  const runScript = async code => {
    const schema = await get('schema', 'page-scr00001')
    await post('plan', { plan: { ...base, analyses: ['script'], script: { code } }, revision: schema.json.data.planRevision, binding: token }, 'page-scr00001')
    const run = await post('run', { stage: 'all', binding: token }, 'page-scr00001')
    assert.equal(run.status, 200)
    return run.json.data
  }

  const ok = await runScript("means = data.groupby('g', as_index=False)['y'].mean()\nsave('group_means', means)")
  assert.equal(ok.meta.nodes.script.status, 'executed')
  assert.equal(ok.meta.tables.length, 1)
  const table = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', ok.runId, 'tables', 'script.csv'), 'utf8')
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  assert.equal(table.length, 3)
  assert.match(table[0], /g,y/)

  const failed = await runScript("raise ValueError('boom')")
  assert.equal(failed.meta.nodes.script.status, 'failed')
  assert.match(failed.meta.nodes.script.reason, /boom/)

  const empty = await runScript('x = 1')
  assert.equal(empty.meta.nodes.script.status, 'failed')
  assert.match(empty.meta.nodes.script.reason, /save/)

  const multi = await runScript("save('n', pd.DataFrame({'n': [len(data)]}))\nsave('sums', data.groupby('g')['y'].sum().reset_index())")
  const keys = multi.meta.tables.map(item => item.key).sort()
  assert.deepEqual(keys, ['script', 'script_sums'])
})

test('07 导出：自包含 HTML、SVG/PNG、manifest 与 presentation revision', async () => {
  const runId = sixBRunId
  assert.ok(runId, '6B 运行应已记录')
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-6b0000001')
  const token = connected.json.data.binding.token
  const first = await post('export', { runId, binding: token }, 'page-6b0000001')
  assert.equal(first.status, 200, JSON.stringify(first.json).slice(0, 1200))
  const value = first.json.data
  assert.equal(value.runId, runId)
  assert.equal(value.revision, 1)
  assert.equal(value.manifest.parent, null)
  const dir = path.join(wsA, 'data', 'analysis', 'runs', runId, 'presentation', '1')
  for (const file of ['report.html', 'results.json', 'manifest.json']) assert.ok(existsSync(path.join(dir, file)), file)
  const html = readFileSync(path.join(dir, 'report.html'), 'utf8')
  const resultsOne = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8'))
  const metaBefore = readFileSync(path.join(wsA, 'data', 'analysis', 'runs', runId, 'meta.json'), 'utf8')
  // REP-01：同一个估计在结果对象、HTML 与图里一致（5.5 显示为 5.50）。
  const table = resultsOne.tables.find(row => row.key === 'regression')
  const estimateRow = table.rows.find(row => String(row.term).includes('group = B'))
  assert.ok(Math.abs(estimateRow.estimate - 5.5) < 1e-9)
  assert.match(html, /5\.50/, 'HTML 表里应有同一个估计的显示值')
  assert.doesNotMatch(html, /5\.5000000000000036/, '显示层不应泄露浮点噪声')
  assert.match(html, /class="three-line"/)
  assert.doesNotMatch(html, /https?:\/\//, '报告不应引用任何外部资源')
  assert.doesNotMatch(html, /C:\\Users/, '报告不应出现绝对路径')
  assert.ok(value.figures.includes('model-estimates'), JSON.stringify(value.figures))
  assert.ok(existsSync(path.join(dir, 'figures', 'model-estimates.svg')))
  if (value.png > 0) assert.ok(existsSync(path.join(dir, 'figures', 'model-estimates.png')))
  assert.equal(value.pdf, true, '本机浏览器可用时应能转 PDF')
  if (value.office) {
    for (const file of ['tables.docx', 'tables.xlsx']) assert.ok(existsSync(path.join(dir, file)), file)
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    assert.ok(manifest.artifacts.some(item => item.relativePath === 'tables.docx'))
    assert.ok(manifest.artifacts.some(item => item.relativePath === 'tables.xlsx'))
    // REP-03：Word 表是三线表（无竖线、表头行重复）+ XLSX 可打开，且都有数据行。
    const verify = spawnSync(PYTHON, ['-c',
      `from docx import Document; from openpyxl import load_workbook; ` +
      `d=Document(r'${path.join(dir, 'tables.docx')}'); t=d.tables[0]; xml=t._tbl.tblPr.xml; ` +
      `hdr='w:tblHeader' in t.rows[0]._tr.xml; ` +
      `w=load_workbook(r'${path.join(dir, 'tables.xlsx')}'); ` +
      `print(len(d.tables), len(t.rows), len(t.columns), 'insideV' in xml and 'none' in xml, hdr, len(w.sheetnames))`], { encoding: 'utf8' })
    const parts = (verify.stdout || '').trim().split(/\s+/)
    assert.ok(Number(parts[0]) >= 1 && Number(parts[1]) >= 2 && Number(parts[2]) >= 2, verify.stdout + verify.stderr)
    assert.equal(parts[3], 'True', '不应有竖线（insideV=none）')
    assert.equal(parts[4], 'True', '表头行应可跨页重复')
    assert.ok(Number(parts[5]) >= 1)
  }
  // 再导出一次：revision 递增并有父引用，旧版本与模型不被改写（REP-08）。
  const second = await post('export', { runId, binding: token }, 'page-6b0000001')
  assert.equal(second.status, 200)
  assert.equal(second.json.data.revision, 2)
  assert.equal(second.json.data.manifest.parent, 'presentation/1/manifest.json')
  assert.ok(existsSync(path.join(wsA, 'data', 'analysis', 'runs', runId, 'presentation', '1', 'report.html')))
  const resultsTwo = JSON.parse(readFileSync(path.join(wsA, 'data', 'analysis', 'runs', runId, 'presentation', '2', 'results.json'), 'utf8'))
  assert.equal(resultsTwo.hash, resultsOne.hash, '重新排版不改变结果对象 hash')
  assert.equal(readFileSync(path.join(wsA, 'data', 'analysis', 'runs', runId, 'meta.json'), 'utf8'), metaBefore, '导出不修改运行 meta')
  // 页面能看到历史版本，并能通过受控路由打开报告。
  const listed = await request(handler, { path: `/api/analysis-run?action=results&run=${runId}`, headers: { 'x-analysis-run': '1', ...pageHeaders('page-6b0000001') } })
  const presentations = listed.json.data.presentations
  assert.ok(Array.isArray(presentations) && presentations.length >= 2, JSON.stringify(presentations))
  assert.equal(presentations[0].revision, 2)
  assert.ok(presentations[0].files.includes('report.html'))
  const served = await request(handler, { path: `/api/analysis-run?action=presentation&run=${runId}&rev=1&file=report.html`, headers: { ...pageHeaders('page-6b0000001') } })
  assert.equal(served.status, 200)
  assert.match(served.headers['content-type'], /text\/html/)
  assert.match(served.headers['content-security-policy'] || '', /default-src 'none'/)
  const servedBody = Buffer.isBuffer(served.text) ? served.text.toString('utf8') : String(served.text || '')
  assert.match(servedBody, /class="three-line"/)
  const blocked = await request(handler, { path: `/api/analysis-run?action=presentation&run=${runId}&rev=1&file=../meta.json`, headers: { ...pageHeaders('page-6b0000001') } })
  assert.equal(blocked.status, 404, '路径穿越必须被拒绝')
  // 长表重复测量运行也能导出配对轨迹（逐人 T0→T1）。令牌绑定页面，先在本页连接同一研究。
  const pairedConnection = await post('studyConnect', { studyPath: fileA }, 'page-6c0000001')
  assert.equal(pairedConnection.status, 200, JSON.stringify(pairedConnection.json).slice(0, 400))
  const paired = await post('export', { runId: sixCRunId, binding: pairedConnection.json.data.binding.token }, 'page-6c0000001')
  assert.equal(paired.status, 200, JSON.stringify(paired.json).slice(0, 600))
  assert.ok(paired.json.data.figures.includes('paired-trajectories'), JSON.stringify(paired.json.data.figures))
})

test('ANA-07 中断的运行可被识别，后续运行不受影响', async () => {
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-6c0000001')
  const token = connected.json.data.binding.token
  // 被中断的运行：status 仍是 running，但记录的进程已不存在 → interrupted。
  const interruptedDir = path.join(wsA, 'data', 'analysis', 'runs', '20990101-000000-dead')
  mkdirSync(interruptedDir, { recursive: true })
  writeFileSync(path.join(interruptedDir, 'meta.json'), JSON.stringify({
    schemaVersion: 1, runId: '20990101-000000-dead', status: 'running', study: { id: 'study-a' },
    startedAt: new Date().toISOString(), process: { pid: 999999, hostname: os.hostname() },
  }))
  const statuses = await get('status', 'page-6c0000001')
  const interrupted = statuses.json.data.runs.find(row => row.runId === '20990101-000000-dead')
  assert.ok(interrupted, '应能看到中断的运行')
  assert.equal(interrupted.status, 'running')
  assert.equal(interrupted.interrupted, true)
  // 后续运行不受影响。
  const afterInterrupt = await post('run', { stage: 'all', binding: token }, 'page-6c0000001')
  assert.equal(afterInterrupt.status, 200, JSON.stringify(afterInterrupt.json).slice(0, 600))
})

test('另一页面连接 B 后，A 的旧令牌仍写 A；页面缺令牌则拒绝', async () => {
  const a = await post('studyConnect', { studyPath: fileA }, 'page-a0000001')
  const b = await post('studyConnect', { studyPath: fileB }, 'page-b0000001')
  assert.equal(a.json.data.study.id, 'study-a')
  assert.equal(b.json.data.study.id, 'study-b')

  const schema = await get('schema', 'page-a0000001')
  const written = await post('exclude', { op: 'add', id: 'P-002', reason: '仍写 A', revision: schema.json.data.exclusionsRevision, binding: a.json.data.binding.token }, 'page-a0000001')
  assert.equal(written.status, 200, JSON.stringify(written.json))
  assert.equal(written.json.data.study.id, 'study-a')
  assert.ok(readFileSync(path.join(wsA, 'data', 'analysis', 'exclusions.json'), 'utf8').includes('P-002'))
  assert.equal(existsSync(path.join(wsB, 'data', 'analysis', 'exclusions.json')), false)

  const missing = await post('exclude', { op: 'add', id: 'P-003', reason: '无令牌', revision: schema.json.data.exclusionsRevision }, 'page-b0000001')
  assert.equal(missing.status, 409)
  assert.equal(missing.json.error.code, 'binding_required')
})

test('工具按调用会话解析研究，不读全局当前研究', async () => {
  const statusTool = tools.get('analysis_status')
  assert.ok(statusTool)
  const a = await statusTool.execute({}, { agent: { id: 's-a' } })
  assert.match(a.text, /合成研究 A/)
  const b = await statusTool.execute({}, { agent: { id: 's-b' } })
  assert.match(b.text, /合成研究 B/)
  const anonymous = await statusTool.execute({}, {})
  assert.doesNotMatch(anonymous.text, /合成研究 A/)
  assert.doesNotMatch(anonymous.text, /合成研究 B/)
})

test('能力查询带绑定与插件一致性', async () => {
  const response = await get('capabilities', 'page-aaaa0001')
  assert.equal(response.status, 200, response.text)
  assert.equal(response.json.data.binding.studyId, 'study-a')
  assert.equal(response.json.data.consistent, true)
})

test('预览：返回列名与各模块人数，且不写任何运行目录', async () => {
  const csv = path.join(wsA, 'preview.csv')
  const lines = ['id,y,g']
  for (let index = 1; index <= 10; index += 1) lines.push([index, index, index % 2 ? 'A' : 'B'].join(','))
  writeFileSync(csv, lines.join('\n') + '\n')
  const connected = await post('studyConnect', { studyPath: fileA }, 'page-prv00001')
  const token = connected.json.data.binding.token
  const plan = { dataPath: csv, idColumn: 'id', outcome: 'y', layout: 'wide', groupColumns: ['g'], covariates: [], pairedColumns: [], analyses: ['descriptives', 'sample'] }
  const before = readdirSync(path.join(wsA, 'data', 'analysis', 'runs')).length
  const preview = await post('preview', { plan, binding: token }, 'page-prv00001')
  assert.equal(preview.status, 200, preview.text)
  assert.ok(preview.json.data.columns.includes('y'))
  assert.equal(preview.json.data.rows, 10)
  assert.equal(preview.json.data.modules.sample.eligible, 10)
  assert.equal(readdirSync(path.join(wsA, 'data', 'analysis', 'runs')).length, before, '预览不应创建运行目录')
})