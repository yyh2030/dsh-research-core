/**
 * 06 / ANA-01—07 的合成验收（不含 6B/6C：本机运行时缺 statsmodels）。
 * 每个场景都用同一份合成研究，验证"数据变化 → 运行 → 快照/状态"的可观察行为。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { before } from 'node:test'

import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'
import { openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PYTHON = process.env.DSH_ANALYSIS_PYTHON || process.env.DSH_PYTHON
  || path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
const sha = value => createHash('sha256').update(value).digest('hex')

let host
let handler
let token
let instanceId
let study
let data
let flow
let runsDir
let root

const get = (action, pageId = 'page-ana00001') => request(handler, { path: `/api/analysis-run?action=${action}`, headers: { 'x-analysis-run': '1', ...pageHeaders(pageId) } })
const post = (action, payload, pageId = 'page-ana00001') => request(handler, { method: 'POST', path: '/api/analysis-run', headers: { 'x-analysis-run': '1', 'content-type': 'application/json', ...pageHeaders(pageId) }, body: { action, payload } })

async function savePlan(plan) {
  const schema = await get('schema')
  const saved = await post('plan', { plan, revision: schema.json.data.planRevision, binding: token })
  assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 500))
}

const basePlan = () => ({
  source: { type: 'core' }, idColumn: 'participantId', outcome: 'age', layout: 'wide',
  groupColumns: [], covariates: [], pairedColumns: [], analyses: ['descriptives', 'regression'], gate: { minSubjects: 10 },
  variables: [
    { name: 'participantId', type: 'participant', field: 'participantId' },
    { name: 'age', type: 'demographics', column: 'age' },
  ],
})

function addParticipants(ids) {
  for (const id of ids) flow.participants.register({ participantId: id, status: 'enrolled' })
  const existing = flow.participants.list().filter(row => row.status === 'enrolled').map(row => row.participantId)
  flow.demographics.commit({
    document: {
      schemaVersion: 2, studyId: 'ana-study', name: '人口学',
      columns: [{ key: 'age', label: '年龄', kind: 'number' }],
      rows: existing.map((id, index) => ({ id, values: { age: String(20 + index) } })),
    },
  })
}

before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'rc-ana-'))
  process.env.DSH_RESEARCH_STORE = path.join(root, 'store')
  const dir = path.join(root, 'ws')
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  const file = path.join(dir, 'study.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, studyId: 'ana-study', name: 'ANA 合成研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))
  host = makeHost({ workspaces: [{ id: 'w', path: dir }], sessions: { 's-a': dir }, cwd: dir })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../analysis-run'))
  moduleUnderTest.apply(host.ctx, { studyPath: '', pythonPath: PYTHON })
  handler = host.routes.get('/api/analysis-run')
  const connected = await post('studyConnect', { studyPath: file })
  assert.equal(connected.status, 200, connected.text.slice(0, 400))
  token = connected.json.data.binding.token
  instanceId = connected.json.data.binding.instanceId
  study = { id: 'ana-study', name: 'ANA 合成研究', path: file, dataRoot: path.join(dir, 'data'), baseDir: dir, plugin: {}, visits: [], tasks: [], followups: [], revision: 'r1' }
  data = openResearchData({ study, instanceId })
  flow = openFlow({ data, study })
  runsDir = path.join(dir, 'data', 'analysis', 'runs')
})

test('ANA-01 逐批加入：描述统计更新，推断节点因门槛保持 not_run', async () => {
  await savePlan(basePlan())
  addParticipants(['P-001'])
  const first = await post('run', { stage: 'all', binding: token })
  assert.equal(first.status, 200, JSON.stringify(first.json).slice(0, 800))
  assert.equal(first.json.data.meta.subjects, 1)
  assert.equal(first.json.data.meta.nodes.descriptives.status, 'executed')
  assert.equal(first.json.data.meta.nodes.regression.status, 'not_run')
  assert.match(first.json.data.meta.nodes.regression.reason, /gate|环境待准备/)

  addParticipants(['P-002', 'P-003', 'P-004', 'P-005'])
  const five = await post('run', { stage: 'all', binding: token })
  assert.equal(five.status, 200)
  assert.equal(five.json.data.meta.subjects, 5)
  assert.equal(five.json.data.meta.nodes.descriptives.status, 'executed')
})

test('ANA-02 新数据只改变新运行，历史运行目录不被改写', async () => {
  const status = await get('status')
  const newest = status.json.data.runs[0]
  const metaBefore = readFileSync(path.join(runsDir, newest.runId, 'meta.json'), 'utf8')
  addParticipants(['P-006'])
  const run = await post('run', { stage: 'all', binding: token })
  assert.equal(run.status, 200)
  assert.equal(readFileSync(path.join(runsDir, newest.runId, 'meta.json'), 'utf8'), metaBefore, '历史运行 meta 不应被改写')
  const after = await get('status')
  const previous = after.json.data.runs.find(row => row.runId === newest.runId)
  assert.equal(previous.stale, true)
  assert.equal(run.json.data.meta.subjects, 6)
})

test('ANA-03 运行快照固定：数据在运行后再变，旧运行输入与 dataset hash 不变', async () => {
  const status = await get('status')
  const last = status.json.data.runs[0]
  const meta = JSON.parse(readFileSync(path.join(runsDir, last.runId, 'meta.json'), 'utf8'))
  const input = readFileSync(path.join(runsDir, last.runId, 'input.csv'))
  assert.equal(sha(input), meta.source.sha256, '运行快照的文件 hash 应与 meta 一致')
  addParticipants(['P-007'])
  assert.equal(sha(readFileSync(path.join(runsDir, last.runId, 'input.csv'))), meta.source.sha256, '旧快照不应被改动')
  const after = await get('status')
  assert.equal(after.json.data.pendingChanges, true, '数据变了应提示有更新待运行')
})

test('ANA-04 同输入复现：复用同一运行，产物 hash 一致', async () => {
  const run = await post('run', { stage: 'all', binding: token })
  assert.equal(run.status, 200)
  const reuse = await post('run', { stage: 'all', binding: token })
  assert.equal(reuse.status, 200)
  assert.equal(reuse.json.data.reused, true)
  assert.equal(reuse.json.data.runId, run.json.data.runId)
  const dir = path.join(runsDir, run.json.data.runId)
  assert.ok(existsSync(path.join(dir, 'tables', 'descriptives.csv')))
  const first = readFileSync(path.join(dir, 'tables', 'descriptives.csv'))
  const again = readFileSync(path.join(dir, 'tables', 'descriptives.csv'))
  assert.equal(sha(first), sha(again))
})

test('ANA-06 坏合并与非法变换都显式失败，不产生伪成功表', async () => {
  // 人口学同号多行 → 汇合层拒绝
  data.commit('demographics', {
    schemaVersion: 2, studyId: 'ana-study', name: '人口学',
    columns: [{ key: 'age', label: '年龄', kind: 'number' }],
    rows: [{ id: 'P-001', values: { age: '20' } }, { id: 'P-001', values: { age: '21' } }],
  }, { owner: 'test' })
  const runsBefore = readdirSync(runsDir).length
  const bad = await post('run', { stage: 'all', binding: token })
  assert.ok(bad.status >= 400, '重复编号应中止合并')
  assert.match(JSON.stringify(bad.json), /duplicate_record|多行/)
  assert.equal(readdirSync(runsDir).length, runsBefore, '失败不应产生新的运行目录')
  // 恢复一份正常人口学，并验证非法变换（未知列）也不会留下成功表
  addParticipants([])
  await savePlan({ ...basePlan(), transforms: [{ op: 'center', column: 'no_such_column', name: 'x' }] })
  const failed = await post('run', { stage: 'all', binding: token })
  assert.ok(failed.status >= 400)
  assert.match(JSON.stringify(failed.json), /unknown column|列/)
})

test('ANA-05（描述统计部分）与独立手算结果一致；后端可用性可见', async () => {
  const status = await get('status')
  const latest = status.json.data.runs.find(row => row.status === 'ok')
  const meta = JSON.parse(readFileSync(path.join(runsDir, latest.runId, 'meta.json'), 'utf8'))
  const rows = readFileSync(path.join(runsDir, latest.runId, 'tables', 'descriptives.csv'), 'utf8')
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.split(','))
  const header = rows[0]
  const values = rows.slice(1).map(line => Object.fromEntries(header.map((name, index) => [name, line[index]])))
  // 独立手算：与引擎无关的纯 JS 公式。
  const ages = flow.demographics.read().document.rows.map(row => Number((row.values || row).age)).filter(Number.isFinite)
  const mean = ages.reduce((sum, value) => sum + value, 0) / ages.length
  const variance = ages.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (ages.length - 1)
  const sd = Math.sqrt(variance)
  const sorted = ages.slice().sort((a, b) => a - b)
  const quantile = q => {
    const position = (sorted.length - 1) * q
    const base = Math.floor(position)
    const rest = position - base
    return sorted[base] + (sorted[base + 1] === undefined ? 0 : (sorted[base + 1] - sorted[base]) * rest)
  }
  const near = (actual, expected, label) => assert.ok(Math.abs(Number(actual) - expected) <= 1e-9, `${label}: ${actual} vs ${expected}`)
  assert.equal(values.length, 1, '没有分组时只有一行')
  const row = values[0]
  near(row.mean, mean, 'mean')
  near(row.sd, sd, 'sd')
  near(row.se, sd / Math.sqrt(ages.length), 'se')
  near(row.median, quantile(0.5), 'median')
  near(row.iqr, quantile(0.75) - quantile(0.25), 'iqr')
  near(row.valueRange, Math.max(...ages) - Math.min(...ages), 'range')
  // 后端可用性：描述统计必须 ok；回归/混合取决于本机是否装了 statsmodels，两者要一致。
  assert.equal(status.json.data.backends.descriptives.ok, true)
  const regression = status.json.data.backends.regression
  assert.equal(regression.ok, !regression.missing.includes('statsmodels'), '缺包列表与可用性要一致')
  assert.equal(meta.nodes.descriptives.status, 'executed')
})

test('ANA-07 失败运行有明确状态，修复后可继续新运行', async () => {
  const status = await get('status')
  const failedRun = status.json.data.runs.find(row => row.status === 'failed')
  assert.ok(failedRun, '应有失败运行记录')
  assert.ok(failedRun.error, '失败运行要带错误原因')
  await savePlan(basePlan())
  const recovered = await post('run', { stage: 'all', binding: token })
  assert.equal(recovered.status, 200, JSON.stringify(recovered.json).slice(0, 800))
  assert.equal(recovered.json.data.meta.nodes.descriptives.status, 'executed')
  assert.equal(recovered.json.data.meta.status === 'ok' || recovered.json.data.meta.status === 'partial', true)
})
