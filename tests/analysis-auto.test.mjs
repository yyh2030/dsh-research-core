/**
 * 06 去抖自动运行：核心数据变化 → 去抖 150ms → 自动跑一次；数据再变 → 再补跑。
 * 用独立测试进程（node --test 每个文件一个进程），避免与其它用例共享插件注册。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'
import { openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PYTHON = process.env.DSH_ANALYSIS_PYTHON || process.env.DSH_PYTHON
  || path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')

test('autoRun：核心数据变化后自动去抖运行，并随数据更新补跑', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-auto-'))
  process.env.DSH_RESEARCH_STORE = path.join(root, 'store')
  const dir = path.join(root, 'ws')
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  const file = path.join(dir, 'study.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, studyId: 'auto-study', name: '自动分析研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))

  const host = makeHost({ workspaces: [{ id: 'w', path: dir }], sessions: { 's-a': dir }, cwd: dir })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../analysis-run'))
  moduleUnderTest.apply(host.ctx, { studyPath: '', pythonPath: PYTHON, autoRun: true, debounceMs: 150, autoPollMs: 100 })
  const handler = host.routes.get('/api/analysis-run')
  const get = (action, pageId) => request(handler, { path: `/api/analysis-run?action=${action}`, headers: { 'x-analysis-run': '1', ...pageHeaders(pageId) } })
  const post = (action, payload, pageId) => request(handler, { method: 'POST', path: '/api/analysis-run', headers: { 'x-analysis-run': '1', 'content-type': 'application/json', ...pageHeaders(pageId) }, body: { action, payload } })

  const connected = await post('studyConnect', { studyPath: file }, 'page-auto0001')
  assert.equal(connected.status, 200, connected.text.slice(0, 400))
  const token = connected.json.data.binding.token
  const instanceId = connected.json.data.binding.instanceId

  const study = { id: 'auto-study', name: '自动分析研究', path: file, dataRoot: path.join(dir, 'data'), baseDir: dir, plugin: {}, visits: [], tasks: [], followups: [], revision: 'r1' }
  const data = openResearchData({ study, instanceId })
  const flow = openFlow({ data, study })
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.demographics.commit({
    document: { schemaVersion: 2, studyId: 'auto-study', name: '人口学', columns: [{ key: 'age', label: '年龄', kind: 'number' }], rows: [{ id: 'P-001', values: { age: '20' } }] },
  })

  const schema = await get('schema', 'page-auto0001')
  const plan = {
    source: { type: 'core' }, idColumn: 'participantId', outcome: 'age', layout: 'wide',
    groupColumns: [], covariates: [], pairedColumns: [], analyses: ['descriptives'], gate: { minSubjects: 2 },
    variables: [
      { name: 'participantId', type: 'participant', field: 'participantId' },
      { name: 'age', type: 'demographics', column: 'age' },
    ],
  }
  const saved = await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, 'page-auto0001')
  assert.equal(saved.status, 200, saved.text.slice(0, 400))

  const waitFor = async (predicate, timeout = 20000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const state = await get('status', 'page-auto0001')
      if (state.json && state.json.data && predicate(state.json.data)) return state.json.data
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    return null
  }

  const first = await waitFor(state => (state.runs || []).length >= 1)
  assert.ok(first, '核心有数据且方案已保存后应自动运行一次')
  assert.equal(first.source.kind, 'core')
  const firstRunId = first.runs[0].runId

  // 新增一名参与者并补人口学 → 数据集 hash 变化 → 去抖后自动补跑。
  flow.participants.register({ participantId: 'P-002', status: 'enrolled' })
  flow.demographics.commit({
    document: { schemaVersion: 2, studyId: 'auto-study', name: '人口学', columns: [{ key: 'age', label: '年龄', kind: 'number' }], rows: [{ id: 'P-001', values: { age: '20' } }, { id: 'P-002', values: { age: '30' } }] },
  })
  const second = await waitFor(state => (state.runs || []).some(row => row.runId !== firstRunId))
  assert.ok(second, '数据变化后应自动补跑新的运行')
  assert.equal(second.pendingChanges, false, '补跑完成后不再提示有更新')
  assert.equal(second.queued, false)

  // FIX-02：数据不变、只改人工排除，也必须自动补跑；同一排除不得无限重复。
  // 自动运行可能正在写，排除写入遇到 busy 时有界重试，模拟用户稍后再点一次。
  let excluded = null
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const stateBefore = await get('status', 'page-auto0001')
    const attempt = await post('exclude', { op: 'add', id: 'P-002', reason: '合成排除', revision: stateBefore.json.data.exclusionsRevision, binding: token }, 'page-auto0001')
    if (attempt.status === 200) { excluded = attempt; break }
    if (attempt.status !== 409) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(excluded, '排除写入应在自动运行结束后成功')
  const third = await waitFor(state => (state.runs || []).length >= 3)
  assert.ok(third, '只改排除名单也应触发一次自动运行')
  assert.notEqual(third.runs[0].runId, second.runs[0].runId)
  await new Promise(resolve => setTimeout(resolve, 600))
  const settled = await get('status', 'page-auto0001')
  assert.equal((settled.json.data.runs || []).length, 3, '同一排除不应反复补跑')})
