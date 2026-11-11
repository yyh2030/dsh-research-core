/**
 * 09 阶段 · 合成端到端脚本（方案第 37—49 行，跳过第 9 步提醒/手机）。
 *
 * 全部数据都在 mkdtemp 临时目录里合成；不打开、不复制、不写入 D:\yyh-lab 或任何真实研究。
 * 每一步都真实调用插件注册的路由 / 工具 / 研究核心 API，并断言状态与关键数值，不只断言文件存在。
 *
 * 覆盖：
 *   E2E-01 A 材料：中文基线/随访、两组与中文任务、计分冲突；扫描 → 候选确认 → 草案保存 →
 *           准备度演练；断言访视 ID 稳定、同名不同来源不合并、候选决定可追溯。
 *   E2E-02 登记/人口学/入组：注册 2 人 + 人口学复合提交再登记 2 人；核对总男女与分组男女。
 *   E2E-03 两波次量表：重复提交、缺题、修正；核心裁决选中有效 submission，scores 数值与状态；
 *           未裁决时分析表为缺失。
 *   E2E-04 任务 CSV：同内容幂等、不同内容成为新来源、缺必要列的损坏源被阻断。
 *   E2E-05 source=core 分析：score 类型变量；逐批加人时门槛按有效样本；改方案/排除产生新指纹；
 *           脚本变更使缓存失效。
 *   E2E-06 导出读回：DOCX/XLSX 单元格、小数、n、ID 与 CI、图、分享脱敏。
 *   E2E-07 B 研究交错：两个临时研究使用相同编号，交错写入/读取，页面/后台/数据读取不串。
 *   E2E-08 锁/崩溃/重启：并发写有界拒绝、坏锁有界退出且不静默删除、死进程锁恢复、重开状态正确。
 *   E2E-09 断网/本地：把 fetch 替换成抛错后仍能本地运行/导出；分享产物无外部 URL。
 *   SKIP-09-9 提醒/手机端属于 08 阶段，需官方 gateway；本文件不伪造。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'
import { openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'
import { openAnalysis } from '../analysis.mjs'

const STORE = mkdtempSync(path.join(os.tmpdir(), 'rc-r09e2e-store-'))
process.env.DSH_RESEARCH_STORE = STORE

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PYTHON = process.env.DSH_ANALYSIS_PYTHON || process.env.DSH_PYTHON
  || path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
const hasPython = existsSync(PYTHON)

const sha = (value, length = 64) => createHash('sha256').update(value).digest('hex').slice(0, length)

function tmp(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  assertInsideTemp(dir)
  return dir
}

/** 任何由测试创建的路径都必须在系统临时目录内，且不能出现真实研究路径字样。 */
function assertInsideTemp(target) {
  const root = path.resolve(os.tmpdir())
  const resolved = path.resolve(target)
  const relative = path.relative(root, resolved)
  assert.ok(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), `路径不在系统临时目录内：${resolved}`)
  assert.doesNotMatch(resolved, /yyh-lab|dsh[\\/]plugins[\\/]research-core[\\/](data|fixtures)/i)
}

function write(dir, name, text) {
  const target = path.join(dir, name)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
  return target
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

function writeStudy(dir, { studyId, name, visits = [], tasks = [], followups = [], plugins = {} }) {
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  const file = path.join(dir, 'study.json')
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1, studyId, name, dataRoot: './data', participantId: { pattern: '^P-\\d{3}$' },
    visits, tasks, followups, plugins,
  }, null, 2))
  return file
}

function studyContext(file, overrides = {}) {
  const definition = readJson(file)
  return {
    id: definition.studyId,
    name: definition.name,
    path: file,
    dataRoot: path.join(path.dirname(file), definition.dataRoot || './data'),
    baseDir: path.dirname(file),
    plugin: {},
    visits: definition.visits || [],
    tasks: definition.tasks || [],
    followups: definition.followups || [],
    revision: 'rev-e2e',
    ...overrides,
  }
}

async function loadOps(projectDir, options = {}) {
  const host = makeHost({ workspaces: [], sessions: { 's-e2e': projectDir }, cwd: projectDir })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../study-ops'))
  moduleUnderTest.apply(host.ctx, { studyPath: '', ...options })
  return { host, tools: host.tools, exec: { agent: { id: 's-e2e' } }, handler: host.routes.get('/api/study-ops') }
}

async function loadScale(projectDir, options = {}) {
  const host = makeHost({ workspaces: [], sessions: { 's-e2e': projectDir }, cwd: projectDir })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../scale-desk'))
  moduleUnderTest.apply(host.ctx, { studyPath: '', publishFlow: true, ...options })
  const handler = host.routes.get('/api/scale-desk')
  assert.ok(handler, 'scale-desk 应注册路由')
  return { host, handler, tools: host.tools }
}

async function loadAnalysis(projectDir, options = {}) {
  const host = makeHost({ workspaces: [], sessions: { 's-e2e': projectDir }, cwd: projectDir })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../analysis-run'))
  moduleUnderTest.apply(host.ctx, { studyPath: '', pythonPath: PYTHON, ...options })
  const handler = host.routes.get('/api/analysis-run')
  assert.ok(handler, 'analysis-run 应注册路由')
  return { host, handler, tools: host.tools }
}

function parsePreviewDraft(text) {
  const at = text.indexOf('\n{\n')
  assert.ok(at >= 0, '预览应包含草案 JSON：' + text.slice(0, 300))
  return JSON.parse(text.slice(at + 1))
}

function readCsvGrid(file) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim()
  const rows = text.split(/\r?\n/).map(line => line.split(','))
  const header = rows.shift()
  return rows.map(row => Object.fromEntries(header.map((name, index) => [name, row[index]])))
}

function participantsOf(data) {
  return (data.read('participants').value?.participants || []).map(row => row.participantId)
}

function scoresOf(data) {
  return data.read('scores').value?.rows || []
}

/** 量表项目：两份临时研究共用同一组编号、同一份定义，用于交错测试。 */
const SCALE_DEFINITION = {
  schemaVersion: 1, studyId: 'scale-e2e', name: '09 E2E 量表研究', dataRoot: './data',
  participantId: { pattern: '^P-\\d{3}$' },
  visits: [{ id: 'T0', label: '基线', order: 0 }, { id: 'T1', label: '随访', order: 1 }],
  tasks: [
    { id: 'garden-baseline', label: '花园基线', visits: ['T0'], required: true, source: { type: 'scale', scaleId: 'GARDEN', waveId: 'baseline' } },
    { id: 'garden-followup', label: '花园随访', visits: ['T1'], required: true, source: { type: 'scale', scaleId: 'GARDEN', waveId: 'followup' } },
  ],
  followups: [], plugins: { scales: {} },
}

function seedScaleProject(dir, studyId, answers) {
  const file = writeStudy(dir, { ...SCALE_DEFINITION, studyId, name: '09 E2E 量表研究 ' + studyId })
  write(dir, 'data/scales/defs/GARDEN.json', readFileSync(path.resolve(import.meta.dirname, '../../scale-desk/sample-def.json'), 'utf8'))
  for (const [wave, rows] of Object.entries(answers)) {
    const lines = ['编号,definitionHash,submissionId,q01,q02,q03,q04']
    for (const row of rows) lines.push([row.id, '', row.submissionId, ...row.values].join(','))
    write(dir, `data/scales/answers/GARDEN__${wave}.csv`, lines.join('\n') + '\n')
  }
  return file
}

/* ------------------------------------------------------------------ *
 * E2E-01 材料：扫描 → 候选确认 → 草案保存 → 准备度演练
 * ------------------------------------------------------------------ */
test('E2E-01 中文材料扫描/确认/草案/准备度：访视 ID 稳定、同名不同来源不合并、候选决定可追溯', async () => {
  const dir = tmp('rc-r09e2e-material-')
  try {
    write(dir, '流程.md', '访视：基线\n访视：随访\n任务：体验问卷\n任务：状态问卷\n')
    write(dir, '计分A.md', '量表：体验问卷 4 题\n反向计分：2\n主要结局：焦虑分数\n')
    write(dir, '计分B.md', '量表：体验问卷 4 题\n反向计分：3\n')
    const { tools, exec } = await loadOps(dir, {
      statisticsBackend: { configured: true, available: true, backend: 'vendor' },
    })

    const scan = await tools.get('materials_scan').execute({ path: dir }, exec)
    assert.match(scan.text, /已识别：/)
    assert.match(scan.text, /候选决定：已确认 0/)
    assert.match(scan.text, /冲突 1 项/, scan.text)

    const findingsPath = path.join(dir, '.dsh-materials', 'index', 'findings.json')
    const findings = readJson(findingsPath)
    assert.equal(findings.conflicts.length, 1)
    assert.equal(findings.conflicts[0].kind, 'scoring_rule')
    assert.equal(findings.conflicts[0].status, 'pending', '计分冲突不能自动批准')
    const visitCandidates = findings.candidates.filter(row => row.kind === 'visit')
    assert.equal(visitCandidates.length, 2, '中文访视候选应各自保留')
    assert.deepEqual(visitCandidates.map(row => row.label).sort(), ['基线', '随访'].sort())
    assert.ok(visitCandidates.every(row => row.decision === 'pending' && row.confirmed === false))

    // 通过工具显式确认两个访视与两个中文任务；决定写入派生索引。
    for (const [kind, label] of [['visit', '基线'], ['visit', '随访'], ['task', '体验问卷'], ['task', '状态问卷']]) {
      const decided = await tools.get('materials_decisions').execute({ path: dir, op: 'set', kind, label, decision: 'accepted', reason: '09 E2E 人工确认' }, exec)
      assert.match(decided.text, new RegExp(`${label}.*accepted`), decided.text)
    }
    const listed = await tools.get('materials_decisions').execute({ path: dir, op: 'list' }, exec)
    assert.match(listed.text, /已确认 4/)

    const draftPath = path.join(dir, 'study.json')
    const preview1 = await tools.get('study_draft_preview').execute({ path: dir, draftPath, name: '09 E2E 材料研究', studyId: 'e2e-material' }, exec)
    const draft1 = parsePreviewDraft(preview1.text)
    assert.equal(draft1.studyId, 'e2e-material')
    assert.equal(draft1.visits.length, 2, '草案不能丢访视')
    assert.deepEqual(draft1.visits.map(row => row.label).sort(), ['基线', '随访'].sort())
    assert.ok(draft1.visits.every(row => /^visit-[a-f0-9]{12}$/.test(row.id)), JSON.stringify(draft1.visits))
    assert.equal(draft1.tasks.length, 2, '两个中文任务都应进入草案')
    assert.ok(draft1.tasks.every(row => Array.isArray(row.visits) && row.visits.length === 0), '任务不自动关联全部访视')
    const ids = draft1.visits.map(row => row.id)
    assert.equal(new Set(ids).size, 2)

    const draftId = /预览 ID：(draft-[a-f0-9]{12})/.exec(preview1.text)?.[1]
    const revision = /内容版本：([a-f0-9]{64})/.exec(preview1.text)?.[1]
    assert.ok(draftId && revision, preview1.text.slice(0, 300))
    const saved = await tools.get('study_draft_save').execute({ path: dir, draftPath, draftId, expectedRevision: revision }, exec)
    assert.match(saved.text, /已创建研究定义/)
    const definition = readJson(draftPath)
    assert.equal(definition.studyId, 'e2e-material')
    assert.deepEqual(definition.visits.map(row => row.id), ids, '保存后的访视 ID 必须与预览一致')
    assert.deepEqual(definition.visits.map(row => row.label).sort(), ['基线', '随访'].sort())
    assert.equal(definition.tasks.length, 2)
    assert.ok(definition.tasks.every(row => row.visits.length === 0 && row.required === false))

    // 重新扫描 + 重新预览：来源没变，ID 与访视不能漂移。
    const rescan = await tools.get('materials_scan').execute({ path: dir }, exec)
    assert.match(rescan.text, /已确认 4/)
    assert.match(rescan.text, /需复核 0/)
    const preview2 = await tools.get('study_draft_preview').execute({ path: dir, draftPath, name: '09 E2E 材料研究', studyId: 'e2e-material' }, exec)
    const draft2 = parsePreviewDraft(preview2.text)
    assert.deepEqual(draft2.visits.map(row => row.id), ids, '同一来源重建的访视 ID 必须稳定')

    // 候选决定可追溯：保存了 kind/label/sourcePath/sourceSha256/reason。
    const decisions = readJson(path.join(dir, '.dsh-materials', 'decisions.json'))
    const visitDecision = Object.values(decisions.decisions).find(row => row.kind === 'visit' && row.label === '基线')
    assert.ok(visitDecision, '访视决定应持久化')
    assert.equal(visitDecision.decision, 'accepted')
    assert.equal(visitDecision.sourcePath, '流程.md')
    assert.match(visitDecision.sourceSha256, /^[0-9a-f]{64}$/)
    assert.equal(visitDecision.reason, '09 E2E 人工确认')
    assert.ok(Object.values(decisions.decisions).some(row => row.kind === 'task' && row.label === '体验问卷' && row.decision === 'accepted'))

    // 准备度演练：计分冲突与未知 dryRun 必须如实阻断，不能声称可以开始。
    const readiness = await tools.get('prep_readiness').execute({ path: dir }, exec)
    assert.match(readiness.text, /- 阶段 scoring：blocked/)
    assert.match(readiness.text, /互斥的计分规则/)
    assert.match(readiness.text, /- 阶段 run：blocked/)
    assert.match(readiness.text, /dryRun/)
    assert.match(readiness.text, /可以开始：否/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * E2E-02 登记 / 人口学 / 入组
 * ------------------------------------------------------------------ */
test('E2E-02 登记与人口学复合提交：总男女与分组男女计数一致', async () => {
  const dir = tmp('rc-r09e2e-flow-')
  try {
    const file = writeStudy(dir, { studyId: 'e2e-flow', name: '09 E2E 流程研究', visits: [], tasks: [] })
    const { tools, exec } = await loadOps(dir)
    const study = studyContext(file)

    // 先登记 2 人（仍是 registered，不因为登记就自动入组）。
    for (const id of ['P-001', 'P-002']) {
      const result = await tools.get('participants_manage').execute({ op: 'register', participantId: id, status: 'registered', reason: '09 E2E 登记' }, exec)
      assert.match(result.text, /已登记/)
    }
    const health = await tools.get('study_data_health').execute({}, exec)
    const instanceId = /实例\s+([A-Za-z0-9_-]+)/.exec(health.text)?.[1]
    assert.ok(instanceId, '应从插件读到绑定实例身份：' + health.text.slice(0, 200))
    const data = openResearchData({ study, instanceId })
    const flow = openFlow({ data, study })
    assert.deepEqual(participantsOf(data), ['P-001', 'P-002'])
    assert.equal((data.read('participants').value.participants || []).every(row => row.status === 'registered'), true)

    // 人口学复合提交：同一事务里新增 P-003/P-004，并提交 4 行人口学；任何一步失败都不能留下半成品。
    const committed = flow.demographics.commit({
      document: {
        schemaVersion: 2, studyId: 'e2e-flow', name: '人口学',
        columns: [
          { key: 'sex', label: '性别', kind: 'text', role: 'sex' },
          { key: 'group', label: '分组', kind: 'text' },
          { key: 'age', label: '年龄', kind: 'number' },
        ],
        rows: [
          { id: 'P-001', values: { sex: '女', group: 'A', age: '20' } },
          { id: 'P-002', values: { sex: '男', group: 'A', age: '22' } },
          { id: 'P-003', values: { sex: '女', group: 'B', age: '24' } },
          { id: 'P-004', values: { sex: '男', group: 'B', age: '26' } },
        ],
      },
    })
    assert.deepEqual(committed.participants.created.sort(), ['P-003', 'P-004'], '新编号由人口学同事务登记')
    assert.equal(committed.participants.revision, 3, '两次登记后复合提交只再递增一代')
    assert.equal(committed.demographics.revision, 1)
    assert.ok(committed.transactionId)
    assert.deepEqual(participantsOf(data).sort(), ['P-001', 'P-002', 'P-003', 'P-004'])
    assert.equal(data.read('demographics').value.rows.length, 4)

    // 再显式入组并写分组。
    for (const [id, group] of [['P-001', 'A'], ['P-002', 'A'], ['P-003', 'B'], ['P-004', 'B']]) {
      const result = await tools.get('participants_manage').execute({ op: 'status', participantId: id, status: 'enrolled', groups: { arm: group }, reason: '09 E2E 入组' }, exec)
      assert.match(result.text, /已更新|已登记/)
    }
    assert.deepEqual((data.read('participants').value.participants || []).map(row => [row.participantId, row.status, row.groups.arm]).sort(), [
      ['P-001', 'enrolled', 'A'], ['P-002', 'enrolled', 'A'], ['P-003', 'enrolled', 'B'], ['P-004', 'enrolled', 'B'],
    ])

    // 核心投影与工具投影读同一份数据。
    const projection = flow.projection({ today: '2026-11-11' })
    assert.equal(projection.totals.participants, 4)
    assert.equal(projection.totals.enrolled, 4)
    assert.deepEqual({ male: projection.sex.male, female: projection.sex.female, unknown: projection.sex.unknown }, { male: 2, female: 2, unknown: 0 })
    const groupA = projection.groups.find(row => row.group === 'arm=A')
    const groupB = projection.groups.find(row => row.group === 'arm=B')
    assert.deepEqual({ enrolled: groupA.enrolled, male: groupA.sex.male, female: groupA.sex.female }, { enrolled: 2, male: 1, female: 1 })
    assert.deepEqual({ enrolled: groupB.enrolled, male: groupB.sex.male, female: groupB.sex.female }, { enrolled: 2, male: 1, female: 1 })

    const text = (await tools.get('flow_projection').execute({ focus: 'all', today: '2026-11-11' }, exec)).text
    assert.match(text, /已入组 4/)
    assert.match(text, /男 2，女 2/)
    assert.match(text, /arm=A：已入组 2；男 1 女 1/)
    assert.match(text, /arm=B：已入组 2；男 1 女 1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * E2E-03 两波次量表、重复/缺题/修正、核心裁决
 * ------------------------------------------------------------------ */
test('E2E-03 量表两波次：重复提交与缺题先为缺失，核心裁决后只给选中 submission 数值', async (t) => {
  const dir = tmp('rc-r09e2e-scale-')
  try {
    const file = seedScaleProject(dir, 'e2e-scale', {
      baseline: [
        { id: 'P-001', submissionId: 'sub-b1', values: [1, 2, 3, 4] },
        { id: 'P-001', submissionId: 'sub-b2', values: [5, 4, 5, 5] },
        { id: 'P-002', submissionId: 'sub-b3', values: [1, 2, 3, ''] },
        { id: 'P-003', submissionId: 'sub-b4', values: [3, 3, 3, 3] },
      ],
      followup: [
        { id: 'P-001', submissionId: 'sub-f1', values: [2, 2, 2, 2] },
        { id: 'P-002', submissionId: 'sub-f2', values: [1, 2, 3, 4] },
        { id: 'P-003', submissionId: 'sub-f3', values: [4, 4, 4, 4] },
      ],
    })
    const { handler } = await loadScale(dir)
    const call = options => request(handler, options)
    const post = (action, payload, pageId) => call({
      method: 'POST', path: '/api/scale-desk',
      headers: { 'x-scale-desk': '1', 'content-type': 'application/json', ...pageHeaders(pageId) },
      body: { action, payload },
    })

    const page = 'page-e2e-scale01'
    const connected = await post('studyConnect', { path: file }, page)
    assert.equal(connected.status, 200, JSON.stringify(connected.json).slice(0, 600))
    const token = connected.json.data.binding.token
    const instanceId = connected.json.data.binding.instanceId
    const study = studyContext(file)
    const data = openResearchData({ study, instanceId })
    const flow = openFlow({ data, study })
    for (const id of ['P-001', 'P-002', 'P-003']) flow.participants.register({ participantId: id, status: 'enrolled' })
    flow.demographics.commit({
      document: {
        schemaVersion: 2, studyId: 'e2e-scale', name: '人口学',
        columns: [{ key: 'sex', label: '性别', kind: 'text', role: 'sex' }],
        rows: [
          { id: 'P-001', values: { sex: '女' } },
          { id: 'P-002', values: { sex: '男' } },
          { id: 'P-003', values: { sex: '女' } },
        ],
      },
    })

    // 第一次计分：P-001 有两份未裁决提交 → 观察格 conflict，scores 两行都为 null/duplicate。
    const scored = await post('score', { binding: token }, page)
    assert.equal(scored.status, 200, JSON.stringify(scored.json).slice(0, 800))
    assert.equal(scored.json.data.publish.observations.published, 7, '两波次 7 份提交都应发布为 observation')
    const conflictSlot = flow.observations.effective({ participantId: 'P-001', visitId: 'T0', taskId: 'garden-baseline' })
    assert.equal(conflictSlot.state, 'conflict')
    assert.equal(conflictSlot.observations.length, 2)

    let rows = scoresOf(data)
    const p001Baseline = rows.filter(row => row.participantId === 'P-001' && row.waveId === 'baseline')
    assert.equal(p001Baseline.length, 2, '重复提交保留全部原值')
    assert.ok(p001Baseline.every(row => row.numericValue === null && row.status === 'duplicate'), JSON.stringify(p001Baseline))
    const p002Baseline = rows.find(row => row.participantId === 'P-002' && row.waveId === 'baseline')
    assert.equal(p002Baseline.status, 'prorated', '缺一题按 minProportion 允许比例计分')
    assert.ok(Math.abs(p002Baseline.numericValue - 2.67) < 1e-9, String(p002Baseline.numericValue))
    const p003Followup = rows.find(row => row.participantId === 'P-003' && row.waveId === 'followup')
    assert.equal(p003Followup.status, 'ok')
    assert.equal(p003Followup.numericValue, 3.5)

    // 未裁决时分析表把 P-001 的基线分数记为缺失，而不是随便取第一份。
    const plan = {
      source: { type: 'core' }, idColumn: 'participantId', outcome: 'score_t0', layout: 'wide',
      groupColumns: ['sex'], covariates: [], pairedColumns: [], analyses: ['descriptives'], gate: { minSubjects: 4 },
      variables: [
        { name: 'participantId', type: 'participant', field: 'participantId' },
        { name: 'sex', type: 'demographics', column: 'sex' },
        { name: 'score_t0', type: 'score', scaleId: 'GARDEN', waveId: 'baseline', subscaleKey: 'experience' },
        { name: 'score_t1', type: 'score', scaleId: 'GARDEN', waveId: 'followup', subscaleKey: 'experience' },
      ],
    }
    const before = openAnalysis({ data, study }).dataset({ plan })
    const p001Before = before.rows.find(row => row.participantId === 'P-001')
    assert.equal(p001Before.score_t0, '', '未裁决的重复提交在分析表里必须是缺失')
    assert.ok(before.stats.missing.score_t0 >= 1)
    assert.ok(before.stats.missingReason.score_t0, '缺失要有原因')

    // 核心裁决选中“修正后的第二次提交”：其余原值保留，但只有选中的 submission 出分数。
    const chosen = conflictSlot.observations.find(row => row.evidence.submissionId === 'sub-b2')
    assert.ok(chosen, '应能找到修正提交')
    flow.observations.adjudicate({
      participantKey: chosen.participantKey, visitId: 'T0', taskId: 'garden-baseline',
      observationId: chosen.observationId, reason: '第二次提交为修正版，选为有效',
    })
    const afterAdjudication = flow.observations.effective({ participantKey: chosen.participantKey, visitId: 'T0', taskId: 'garden-baseline' })
    assert.equal(afterAdjudication.state, 'complete')
    assert.equal(afterAdjudication.effective.evidence.submissionId, 'sub-b2')

    const rescored = await post('score', { binding: token }, page)
    assert.equal(rescored.status, 200, JSON.stringify(rescored.json).slice(0, 800))
    rows = scoresOf(data)
    const afterP001 = rows.filter(row => row.participantId === 'P-001' && row.waveId === 'baseline')
    assert.equal(afterP001.length, 2, '裁决不删除原值')
    const selected = afterP001.find(row => row.submissionId === 'sub-b2')
    const rejected = afterP001.find(row => row.submissionId === 'sub-b1')
    assert.equal(selected.numericValue, 4.25, '修正版 [5,4,5,5] 反向题 4→2，均值 4.25')
    assert.equal(selected.status, 'ok')
    assert.equal(selected.selectedSubmissionId, 'sub-b2')
    assert.equal(rejected.numericValue, null)
    assert.equal(rejected.status, 'duplicate')
    assert.equal(rejected.reason, '多份提交未裁决或未被选中')
    assert.equal(rows.filter(row => row.waveId === 'followup').length, 3)

    // 裁决后分析层必须取选中 submission 的数值，而不是文件里的第一条。
    const after = openAnalysis({ data, study }).dataset({ plan })
    assert.equal(after.rows.find(row => row.participantId === 'P-001').score_t0, 4.25, '分析层必须优先 selectedSubmissionId 对应的分数行')
    assert.equal(rows.filter(row => row.waveId === 'followup').length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * E2E-04 任务 CSV 导入
 * ------------------------------------------------------------------ */
test('E2E-04 任务 CSV：同内容幂等、不同内容新来源、缺必要列的损坏源被阻断', async () => {
  const dir = tmp('rc-r09e2e-import-')
  try {
    const file = writeStudy(dir, {
      studyId: 'e2e-import', name: '09 E2E 导入研究',
      visits: [{ id: 'T0', label: '基线', order: 0 }, { id: 'T1', label: '随访', order: 1 }],
      tasks: [{ id: 'stq', label: '状态问卷', visits: ['T0', 'T1'], required: true }],
    })
    const { tools, exec } = await loadOps(dir)
    const study = studyContext(file)
    for (const id of ['P-001', 'P-002']) {
      const registered = await tools.get('participants_manage').execute({ op: 'register', participantId: id, status: 'enrolled', reason: '09 E2E 导入' }, exec)
      assert.match(registered.text, /已登记/)
    }
    const health = await tools.get('study_data_health').execute({}, exec)
    const instanceId = /实例\s+([A-Za-z0-9_-]+)/.exec(health.text)?.[1]
    assert.ok(instanceId, '应从插件读到绑定实例身份：' + health.text.slice(0, 200))
    const data = openResearchData({ study, instanceId })

    const firstCsv = '编号,访视,任务,日期\nP-001,T0,stq,2026-11-01\nP-002,T0,stq,2026-11-02\n'
    const preview = await tools.get('task_import').execute({ op: 'preview', text: firstCsv, path: 'tasks.csv' }, exec)
    assert.match(preview.text, /必要列齐全/)
    assert.match(preview.text, /将作为第 1 个来源版本提交/)

    const committed = await tools.get('task_import').execute({ op: 'commit', text: firstCsv, path: 'tasks.csv' }, exec)
    assert.match(committed.text, /已导入：发布 2 条 observation/)
    let sources = data.read('tasks').value.sources
    assert.equal(sources.length, 1)
    assert.equal(sources[0].rows, 2)
    assert.equal(sources[0].revision, 1)
    assert.equal(data.read('observations').value.observations.length, 2)

    // 同内容重复导入：幂等，不新增来源，也不重复累计 observation。
    const again = await tools.get('task_import').execute({ op: 'commit', text: firstCsv, path: 'tasks.csv' }, exec)
    assert.match(again.text, /相同内容已导入过/)
    sources = data.read('tasks').value.sources
    assert.equal(sources.length, 1)
    assert.equal(data.read('observations').value.observations.length, 2)

    // 同名不同内容：成为第 2 个来源版本，并只新增本次的行。
    const secondCsv = '编号,访视,任务,日期\nP-001,T1,stq,2026-11-08\nP-002,T1,stq,2026-11-09\nP-002,T1,stq,2026-11-10\n'
    const second = await tools.get('task_import').execute({ op: 'commit', text: secondCsv, path: 'tasks.csv' }, exec)
    assert.match(second.text, /已导入：发布 3 条 observation/)
    assert.match(second.text, /同名文件已有 1 个来源版本，本次为第 2 版/)
    sources = data.read('tasks').value.sources
    assert.equal(sources.length, 2)
    assert.deepEqual(sources.map(row => row.revision).sort(), [1, 2])
    assert.notEqual(sources[0].sha256, sources[1].sha256)
    assert.equal(data.read('observations').value.observations.length, 5)

    // 损坏源：缺日期列，提交必须拒绝，来源与观察都不增加。
    const brokenCsv = '编号,访视,任务\nP-001,T0,stq\n'
    const brokenPreview = await tools.get('task_import').execute({ op: 'preview', text: brokenCsv, path: 'broken.csv' }, exec)
    assert.match(brokenPreview.text, /缺少必要列：date/)
    await assert.rejects(
      () => tools.get('task_import').execute({ op: 'commit', text: brokenCsv, path: 'broken.csv' }, exec),
      error => /缺少必要的列/.test(String(error && error.message || error)),
    )
    assert.equal(data.read('tasks').value.sources.length, 2, '损坏源不能登记为来源')
    assert.equal(data.read('observations').value.observations.length, 5, '损坏源不能发布 observation')
    assert.equal(data.read('tasks').health.state, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * E2E-05 source=core 分析：score 变量、门槛、方案/排除指纹、脚本缓存
 * ------------------------------------------------------------------ */
test('E2E-05 source=core 分析：逐批加人门槛、方案/排除指纹与脚本缓存失效', async () => {
  const dir = tmp('rc-r09e2e-analysis-')
  try {
    const file = seedScaleProject(dir, 'e2e-analysis', {
      baseline: [
        { id: 'P-001', submissionId: 'sub-b1', values: [1, 2, 3, 4] },
        { id: 'P-002', submissionId: 'sub-b3', values: [1, 2, 3, ''] },
        { id: 'P-003', submissionId: 'sub-b4', values: [3, 3, 3, 3] },
      ],
      followup: [
        { id: 'P-001', submissionId: 'sub-f1', values: [2, 2, 2, 2] },
        { id: 'P-002', submissionId: 'sub-f2', values: [1, 2, 3, 4] },
        { id: 'P-003', submissionId: 'sub-f3', values: [4, 4, 4, 4] },
      ],
    })
    const scale = await loadScale(dir)
    const scaleCall = options => request(scale.handler, options)
    const scalePost = (action, payload, pageId) => scaleCall({
      method: 'POST', path: '/api/scale-desk',
      headers: { 'x-scale-desk': '1', 'content-type': 'application/json', ...pageHeaders(pageId) },
      body: { action, payload },
    })
    const page = 'page-e2e-analysis01'
    const connected = await scalePost('studyConnect', { path: file }, page)
    assert.equal(connected.status, 200, JSON.stringify(connected.json).slice(0, 500))
    const instanceId = connected.json.data.binding.instanceId
    const study = studyContext(file)
    const data = openResearchData({ study, instanceId })
    const flow = openFlow({ data, study })
    for (const id of ['P-001', 'P-002', 'P-003']) flow.participants.register({ participantId: id, status: 'enrolled' })
    flow.demographics.commit({
      document: {
        schemaVersion: 2, studyId: 'e2e-analysis', name: '人口学',
        columns: [{ key: 'sex', label: '性别', kind: 'text', role: 'sex' }],
        rows: [
          { id: 'P-001', values: { sex: '女' } },
          { id: 'P-002', values: { sex: '男' } },
          { id: 'P-003', values: { sex: '女' } },
        ],
      },
    })
    const firstScore = await scalePost('score', { binding: connected.json.data.binding.token }, page)
    assert.equal(firstScore.status, 200, JSON.stringify(firstScore.json).slice(0, 800))
    assert.equal(firstScore.json.data.publish.observations.published, 6)

    const analysis = await loadAnalysis(dir)
    const call = options => request(analysis.handler, options)
    const get = (action, pageId, extra = '') => call({ path: `/api/analysis-run?action=${action}${extra}`, headers: { 'x-analysis-run': '1', ...pageHeaders(pageId) } })
    const post = (action, payload, pageId) => call({
      method: 'POST', path: '/api/analysis-run',
      headers: { 'x-analysis-run': '1', 'content-type': 'application/json', ...pageHeaders(pageId) },
      body: { action, payload },
    })
    const aPage = 'page-e2e-analysis02'
    const connectedAnalysis = await post('studyConnect', { studyPath: file }, aPage)
    assert.equal(connectedAnalysis.status, 200, JSON.stringify(connectedAnalysis.json).slice(0, 500))
    const token = connectedAnalysis.json.data.binding.token

    const plan = {
      source: { type: 'core' }, idColumn: 'participantId', outcome: 'score_t0', layout: 'wide',
      groupColumns: ['sex'], covariates: [], pairedColumns: [], analyses: ['descriptives', 'ttest'], gate: { minSubjects: 4 },
      ttest: { kind: 'independent', group: 'sex', outcome: 'score_t0' },
      variables: [
        { name: 'participantId', type: 'participant', field: 'participantId' },
        { name: 'sex', type: 'demographics', column: 'sex' },
        { name: 'score_t0', type: 'score', scaleId: 'GARDEN', waveId: 'baseline', subscaleKey: 'experience' },
        { name: 'score_t1', type: 'score', scaleId: 'GARDEN', waveId: 'followup', subscaleKey: 'experience' },
      ],
    }
    const schema = await get('schema', aPage)
    const saved = await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, aPage)
    assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 500))

    // 第一批只有 3 人有效样本：ttest 门槛 4 未到，节点 not_run 并给出 eligibleSubjects。
    const run1 = await post('run', { stage: 'all', binding: token }, aPage)
    assert.equal(run1.status, 200, JSON.stringify(run1.json).slice(0, 1200))
    assert.equal(run1.json.data.meta.dataset.type, 'core')
    assert.equal(run1.json.data.meta.dataset.stats.rows, 3)
    assert.equal(run1.json.data.meta.nodes.ttest.status, 'not_run')
    assert.equal(run1.json.data.meta.nodes.ttest.eligibleSubjects, 3)
    assert.match(run1.json.data.meta.nodes.ttest.reason, /< gate 4/)
    const run1Id = run1.json.data.runId
    const run1Fingerprint = readJson(path.join(dir, 'data', 'analysis', 'runs', run1Id, 'meta.json')).fingerprint
    assert.match(run1Fingerprint, /^[0-9a-f]{64}$/)

    // 第二批加 P-004（男性），补两波量表作答后重算；有效样本 4，ttest 执行。
    flow.participants.register({ participantId: 'P-004', status: 'enrolled' })
    flow.demographics.commit({
      document: {
        schemaVersion: 2, studyId: 'e2e-analysis', name: '人口学',
        columns: [{ key: 'sex', label: '性别', kind: 'text', role: 'sex' }],
        rows: [
          { id: 'P-001', values: { sex: '女' } }, { id: 'P-002', values: { sex: '男' } },
          { id: 'P-003', values: { sex: '女' } }, { id: 'P-004', values: { sex: '男' } },
        ],
      },
    })
    const baselineFile = path.join(dir, 'data', 'scales', 'answers', 'GARDEN__baseline.csv')
    const followupFile = path.join(dir, 'data', 'scales', 'answers', 'GARDEN__followup.csv')
    writeFileSync(baselineFile, readFileSync(baselineFile, 'utf8') + 'P-004,,sub-b5,2,2,2,2\n', 'utf8')
    writeFileSync(followupFile, readFileSync(followupFile, 'utf8') + 'P-004,,sub-f5,5,5,5,5\n', 'utf8')
    const secondScore = await scalePost('score', { binding: connected.json.data.binding.token }, page)
    assert.equal(secondScore.status, 200, JSON.stringify(secondScore.json).slice(0, 800))
    assert.equal(scoresOf(data).filter(row => row.participantId === 'P-004' && row.waveId === 'baseline').length, 1)

    const run2 = await post('run', { stage: 'all', binding: token }, aPage)
    assert.equal(run2.status, 200, JSON.stringify(run2.json).slice(0, 1200))
    assert.notEqual(run2.json.data.runId, run1Id, '数据变化后应产生新运行')
    assert.equal(run2.json.data.meta.dataset.stats.rows, 4)
    assert.equal(run2.json.data.meta.nodes.ttest.status, 'executed')
    const run2Fingerprint = readJson(path.join(dir, 'data', 'analysis', 'runs', run2.json.data.runId, 'meta.json')).fingerprint
    assert.notEqual(run2Fingerprint, run1Fingerprint, '数据变化必须改变运行指纹')

    // 改方案：新增 sample 表；即使数据不变也必须产生新指纹/新运行。
    const planChanged = {
      ...plan,
      analyses: ['descriptives', 'ttest', 'sample'],
      sampleColumns: [{ column: 'score_t0', kind: 'numeric', label: '基线得分' }, { column: 'sex', kind: 'categorical', label: '性别' }],
    }
    const schema2 = await get('schema', aPage)
    const saved2 = await post('plan', { plan: planChanged, revision: schema2.json.data.planRevision, binding: token }, aPage)
    assert.equal(saved2.status, 200, JSON.stringify(saved2.json).slice(0, 500))
    const run3 = await post('run', { stage: 'all', binding: token }, aPage)
    assert.equal(run3.status, 200, JSON.stringify(run3.json).slice(0, 1200))
    assert.notEqual(run3.json.data.runId, run2.json.data.runId)
    assert.equal(run3.json.data.meta.nodes.sample.status, 'executed')
    const run3Fingerprint = readJson(path.join(dir, 'data', 'analysis', 'runs', run3.json.data.runId, 'meta.json')).fingerprint
    assert.notEqual(run3Fingerprint, run2Fingerprint)

    // 排除 P-002：新运行应用排除，人数下降，旧运行在列表中标记 stale。
    const schema3 = await get('schema', aPage)
    const excluded = await post('exclude', { op: 'add', id: 'P-002', reason: '09 E2E 合成排除', revision: schema3.json.data.exclusionsRevision, binding: token }, aPage)
    assert.equal(excluded.status, 200, JSON.stringify(excluded.json).slice(0, 500))
    const run4 = await post('run', { stage: 'all', binding: token }, aPage)
    assert.equal(run4.status, 200, JSON.stringify(run4.json).slice(0, 1200))
    assert.notEqual(run4.json.data.runId, run3.json.data.runId)
    assert.equal(run4.json.data.meta.subjects, 3)
    assert.deepEqual(run4.json.data.meta.excludedIds, ['P-002'])
    const runs = (await get('status', aPage)).json.data.runs
    assert.equal(runs[0].runId, run4.json.data.runId)
    assert.ok(runs.find(row => row.runId === run3.json.data.runId).stale, '方案/排除变化后的旧运行应标 stale')

    // 脚本缓存：同代码复用；代码变更后必须新运行，不复用旧结果。
    const scriptPlan = {
      ...planChanged,
      analyses: ['script'],
      script: { code: "save('count', pd.DataFrame({'n': [len(data)]}))" },
    }
    const revision4 = (await get('schema', aPage)).json.data.planRevision
    await post('plan', { plan: scriptPlan, revision: revision4, binding: token }, aPage)
    const script1 = await post('run', { stage: 'all', binding: token }, aPage)
    assert.equal(script1.status, 200, JSON.stringify(script1.json).slice(0, 1200))
    assert.equal(script1.json.data.meta.nodes.script.status, 'executed')
    const script1Id = script1.json.data.runId
    const script2 = await post('run', { stage: 'all', binding: token }, aPage)
    assert.equal(script2.status, 200, JSON.stringify(script2.json).slice(0, 800))
    assert.equal(script2.json.data.reused, true, '同输入/方案/代码/环境应复用缓存')
    assert.equal(script2.json.data.runId, script1Id)
    const scriptPlan2 = { ...scriptPlan, script: { code: "save('count', pd.DataFrame({'n': [len(data) * 2]}))" } }
    const revision5 = (await get('schema', aPage)).json.data.planRevision
    await post('plan', { plan: scriptPlan2, revision: revision5, binding: token }, aPage)
    const script3 = await post('run', { stage: 'all', binding: token }, aPage)
    assert.equal(script3.status, 200, JSON.stringify(script3.json).slice(0, 1200))
    assert.notEqual(script3.json.data.runId, script1Id, '脚本变更不能复用旧缓存')
    assert.notEqual(script3.json.data.reused, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * E2E-06 导出与读回
 * ------------------------------------------------------------------ */
test('E2E-06 导出读回 DOCX/XLSX：小数、n、CI、图与分享脱敏', async (t) => {
  if (!hasPython) { t.skip('本机没有可用 Python，无法真实渲染/读回 DOCX/XLSX'); return }
  const dir = tmp('rc-r09e2e-export-')
  try {
    const csv = write(dir, 'data.csv', [
      'participantId,group,score',
      'P-001,A,1', 'P-002,A,2', 'P-003,A,3', 'P-004,A,4',
      'P-005,B,6', 'P-006,B,8', 'P-007,B,10', 'P-008,B,12',
    ].join('\n') + '\n')
    const file = writeStudy(dir, { studyId: 'e2e-export', name: '09 E2E 导出研究' })
    const analysis = await loadAnalysis(dir)
    const call = options => request(analysis.handler, options)
    const get = (action, pageId) => call({ path: `/api/analysis-run?action=${action}`, headers: { 'x-analysis-run': '1', ...pageHeaders(pageId) } })
    const post = (action, payload, pageId) => call({
      method: 'POST', path: '/api/analysis-run',
      headers: { 'x-analysis-run': '1', 'content-type': 'application/json', ...pageHeaders(pageId) },
      body: { action, payload },
    })
    const page = 'page-e2e-export01'
    const connected = await post('studyConnect', { studyPath: file }, page)
    assert.equal(connected.status, 200, JSON.stringify(connected.json).slice(0, 500))
    const token = connected.json.data.binding.token
    const plan = {
      dataPath: csv, idColumn: 'participantId', outcome: 'score', layout: 'wide',
      groupColumns: ['group'], covariates: [], pairedColumns: [], analyses: ['descriptives', 'ttest'],
      ttest: { kind: 'independent', group: 'group', outcome: 'score' }, gate: { minSubjects: 4 },
    }
    const schema = await get('schema', page)
    const saved = await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, page)
    assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 400))
    const run = await post('run', { stage: 'all', binding: token }, page)
    assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 1200))
    assert.equal(run.json.data.meta.nodes.ttest.status, 'executed')
    const runId = run.json.data.runId
    const runDir = path.join(dir, 'data', 'analysis', 'runs', runId)
    const ttestGrid = readCsvGrid(path.join(runDir, 'tables', 'ttest.csv'))
    const expected = ttestGrid[0]
    assert.equal(Number(expected.n), 8)
    assert.ok(Math.abs(Number(expected.meanDiff) - (2.5 - 9)) < 1e-9, expected.meanDiff)
    assert.ok(Number(expected.ciLow) < Number(expected.meanDiff) && Number(expected.meanDiff) < Number(expected.ciHigh))

    const exported = await post('export', { runId, binding: token }, page)
    assert.equal(exported.status, 200, JSON.stringify(exported.json).slice(0, 1200))
    const presentation = path.join(runDir, 'presentation', '1')
    for (const name of ['report.html', 'results.json', 'manifest.json', 'tables.docx', 'tables.xlsx']) {
      assert.ok(existsSync(path.join(presentation, name)), '缺少导出产物：' + name)
    }
    const results = readJson(path.join(presentation, 'results.json'))
    const manifest = readJson(path.join(presentation, 'manifest.json'))
    const ttestTable = results.tables.find(table => table.key === 'ttest')
    assert.ok(ttestTable, '导出结果应包含 ttest 表：' + results.tables.map(table => table.key).join(','))
    assert.deepEqual(ttestTable.columns.map(column => column.key), ttestGrid.length ? Object.keys(ttestGrid[0]) : ttestTable.columns.map(column => column.key))
    const exportedRow = ttestTable.rows[0]
    assert.equal(Number(exportedRow.n), 8)
    assert.ok(Math.abs(Number(exportedRow.meanDiff) - Number(expected.meanDiff)) < 1e-12)
    assert.ok(Math.abs(Number(exportedRow.ciLow) - Number(expected.ciLow)) < 1e-12)
    assert.ok(Math.abs(Number(exportedRow.ciHigh) - Number(expected.ciHigh)) < 1e-12)

    // 图与 CI：分组估计图存在，manifest 引用了同一图形，HTML 里带 95% 区间说明。
    assert.ok(results.figures.some(figure => figure.key === 'group-estimates'), JSON.stringify(results.figures))
    assert.ok(existsSync(path.join(presentation, 'figures', 'group-estimates.svg')))
    assert.ok((manifest.figures || []).some(figure => figure.key === 'group-estimates'))
    const html = readFileSync(path.join(presentation, 'report.html'), 'utf8')
    assert.match(html, /95%/)
    assert.match(html, /-6\.50/, 'HTML 应显示同一个小数（-6.50）')
    assert.doesNotMatch(html, /https?:\/\//, '报告不应引用外部资源')
    assert.doesNotMatch(html, new RegExp(dir.replace(/\\/g, '\\\\')), '报告不应出现本机绝对路径')

    // 读回 DOCX/XLSX：用真实 python-docx/openpyxl 验证单元格，不只 trust 文件存在。
    const inspect = spawnSync(PYTHON, ['-X', 'utf8', '-c', [
      'import json,sys',
      'from docx import Document',
      'from openpyxl import load_workbook',
      'results=json.load(open(sys.argv[1],encoding="utf-8"))',
      'doc=Document(sys.argv[2]); wb=load_workbook(sys.argv[3])',
      'out={"tables":len(doc.tables),"cells":[],"sheets":wb.sheetnames,"xlsx":{}}',
      'for table in doc.tables:',
      '    out["cells"].append([[cell.text for cell in row.cells] for row in table.rows])',
      'for index,table in enumerate(results["tables"]):',
      '    key=table["key"];',
      '    if key not in wb.sheetnames: continue',
      '    ws=wb[key]; values=[]',
      '    for column_index,column in enumerate(table["columns"],start=1):',
      '        cell=ws.cell(row=6,column=column_index)',
      '        values.append([column["key"],cell.value,cell.number_format])',
      '    out["xlsx"][key]=values',
      'json.dump(out,sys.stdout,ensure_ascii=False)',
    ].join('\n'), path.join(presentation, 'results.json'), path.join(presentation, 'tables.docx'), path.join(presentation, 'tables.xlsx')], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
    assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout)
    const summary = JSON.parse(inspect.stdout.trim())
    assert.ok(summary.tables >= results.tables.length, 'DOCX 表数量应覆盖导出表')
    const ttestIndex = results.tables.findIndex(table => table.key === 'ttest')
    const ttestDocTable = summary.cells[ttestIndex]
    assert.ok(ttestDocTable, 'DOCX 应有 ttest 三线表')
    const header = ttestDocTable[0]
    assert.ok(header.some(cell => /n|样本/.test(cell)), JSON.stringify(header))
    const ttestXlsx = summary.xlsx.ttest
    assert.ok(ttestXlsx, 'XLSX 应有 ttest 工作表')
    const byKey = Object.fromEntries(ttestXlsx.map(row => [row[0], row]))
    assert.ok(Math.abs(Number(byKey.n[1]) - 8) < 1e-12)
    assert.equal(byKey.n[2], '0', 'n 应按整数显示')
    assert.ok(Math.abs(Number(byKey.meanDiff[1]) - Number(expected.meanDiff)) < 1e-12)
    assert.equal(byKey.meanDiff[2], '0.00', '均值差应保留两位小数格式')
    assert.ok(Math.abs(Number(byKey.ciLow[1]) - Number(expected.ciLow)) < 1e-12)
    assert.equal(byKey.ciLow[2], '0.00')
    const meanDiffColumn = ttestTable.columns.findIndex(column => column.key === 'meanDiff')
    const meanDiffCell = ttestDocTable[1][meanDiffColumn]
    assert.equal(meanDiffCell, Number(expected.meanDiff).toFixed(2), 'DOCX 应显示两位小数')

    // 分享脱敏：本机运行目录有逐人编号；分享产物不含编号、绝对路径或外部 URL。
    const localInput = readFileSync(path.join(runDir, 'input.csv'), 'utf8')
    assert.match(localInput, /P-001/, '本机运行数据仍应保留逐人编号')
    assert.match(readJson(path.join(runDir, 'meta.json')).source.sha256, /^[0-9a-f]{64}$/)
    assert.ok(Array.isArray(results.redactions) && results.redactions.some(row => /路径|本地/.test(row.reason)), JSON.stringify(results.redactions))
    const serialized = JSON.stringify({ results, manifest })
    assert.doesNotMatch(serialized, /P-00[1-8]/, '分享结果/manifest 不能泄露逐人编号')
    assert.doesNotMatch(serialized, new RegExp(dir.replace(/\\/g, '\\\\')), '分享结果/manifest 不能泄露本机路径')
    assert.doesNotMatch(serialized, /https?:\/\//)
    assert.ok((manifest.artifacts || []).length >= 4)
    assert.ok((manifest.artifacts || []).every(item => item.relativePath && !path.isAbsolute(item.relativePath)))

    const docxText = summary.cells.flat(2).join('\n')
    assert.doesNotMatch(docxText, /P-00[1-8]/, 'DOCX 分享表不能包含逐人编号')
    const xlsxText = Object.values(summary.xlsx).flat(2).map(row => String(row[1] ?? '')).join('\n')
    assert.doesNotMatch(xlsxText, /P-00[1-8]/, 'XLSX 分享表不能包含逐人编号')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * E2E-07 B 研究交错
 * ------------------------------------------------------------------ */
test('E2E-07 两个研究使用相同编号交错写入：页面、后台与数据读取都不串', async () => {
  const root = tmp('rc-r09e2e-two-')
  try {
    const wsA = path.join(root, 'ws-a')
    const wsB = path.join(root, 'ws-b')
    const answersA = {
      baseline: [{ id: 'P-001', submissionId: 'a-b1', values: [1, 1, 1, 1] }, { id: 'P-002', submissionId: 'a-b2', values: [2, 2, 2, 2] }, { id: 'P-003', submissionId: 'a-b3', values: [3, 3, 3, 3] }],
      followup: [{ id: 'P-001', submissionId: 'a-f1', values: [1, 1, 1, 1] }, { id: 'P-002', submissionId: 'a-f2', values: [2, 2, 2, 2] }, { id: 'P-003', submissionId: 'a-f3', values: [3, 3, 3, 3] }],
    }
    const answersB = {
      baseline: [{ id: 'P-001', submissionId: 'b-b1', values: [5, 5, 5, 5] }, { id: 'P-002', submissionId: 'b-b2', values: [5, 5, 5, 5] }, { id: 'P-003', submissionId: 'b-b3', values: [5, 5, 5, 5] }],
      followup: [{ id: 'P-001', submissionId: 'b-f1', values: [5, 5, 5, 5] }, { id: 'P-002', submissionId: 'b-f2', values: [5, 5, 5, 5] }, { id: 'P-003', submissionId: 'b-f3', values: [5, 5, 5, 5] }],
    }
    const fileA = seedScaleProject(wsA, 'e2e-study-a', answersA)
    const fileB = seedScaleProject(wsB, 'e2e-study-b', answersB)
    assert.notEqual(path.resolve(fileA), path.resolve(fileB))

    const host = makeHost({
      workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }],
      sessions: { 's-a': wsA, 's-b': wsB },
      cwd: path.join(root, 'no-config'),
    })
    const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../scale-desk'))
    moduleUnderTest.apply(host.ctx, { studyPath: '', publishFlow: true })
    const handler = host.routes.get('/api/scale-desk')
    const call = options => request(handler, options)
    const post = (action, payload, pageId) => call({
      method: 'POST', path: '/api/scale-desk',
      headers: { 'x-scale-desk': '1', 'content-type': 'application/json', ...pageHeaders(pageId) },
      body: { action, payload },
    })
    const getStatus = pageId => call({ path: `/api/scale-desk?action=status&pageId=${encodeURIComponent(pageId)}`, headers: { 'x-scale-desk': '1', ...pageHeaders(pageId) } })

    const connA = await post('studyConnect', { path: fileA }, 'page-two-a0001')
    const connB = await post('studyConnect', { path: fileB }, 'page-two-b0001')
    assert.equal(connA.status, 200, JSON.stringify(connA.json).slice(0, 500))
    assert.equal(connB.status, 200, JSON.stringify(connB.json).slice(0, 500))
    assert.equal(connA.json.data.study.id, 'e2e-study-a')
    assert.equal(connB.json.data.study.id, 'e2e-study-b')
    const tokenA = connA.json.data.binding.token
    const tokenB = connB.json.data.binding.token
    const studyA = studyContext(fileA)
    const studyB = studyContext(fileB)
    const dataA = openResearchData({ study: studyA, instanceId: connA.json.data.binding.instanceId })
    const dataB = openResearchData({ study: studyB, instanceId: connB.json.data.binding.instanceId })
    const flowA = openFlow({ data: dataA, study: studyA })
    const flowB = openFlow({ data: dataB, study: studyB })

    // 相同编号，不同分组与性别；交错写入。
    for (const [flow, arm, sex] of [[flowA, 'A', '女'], [flowB, 'B', '男']]) {
      for (const id of ['P-001', 'P-002', 'P-003']) flow.participants.register({ participantId: id, status: 'enrolled', groups: { arm } })
      flow.demographics.commit({
        document: {
          schemaVersion: 2, studyId: flow.study.id, name: '人口学',
          columns: [{ key: 'sex', label: '性别', kind: 'text', role: 'sex' }],
          rows: ['P-001', 'P-002', 'P-003'].map(id => ({ id, values: { sex } })),
        },
      })
    }

    const scoreA1 = await post('score', { binding: tokenA }, 'page-two-a0001')
    const scoreB1 = await post('score', { binding: tokenB }, 'page-two-b0001')
    const scoreA2 = await post('score', { binding: tokenA }, 'page-two-a0001')
    assert.equal(scoreA1.status, 200, JSON.stringify(scoreA1.json).slice(0, 500))
    assert.equal(scoreB1.status, 200, JSON.stringify(scoreB1.json).slice(0, 500))
    assert.equal(scoreA2.status, 200, JSON.stringify(scoreA2.json).slice(0, 500))

    const aRow = scoresOf(dataA).find(row => row.participantId === 'P-001' && row.waveId === 'baseline')
    const bRow = scoresOf(dataB).find(row => row.participantId === 'P-001' && row.waveId === 'baseline')
    assert.equal(aRow.numericValue, 2, 'A 的 P-001 应来自 A 的作答（[1,1,1,1] 反向题后均值 2）')
    assert.equal(bRow.numericValue, 4, 'B 的 P-001 应来自 B 的作答（[5,5,5,5] 反向题后均值 4）')
    assert.notEqual(aRow.numericValue, bRow.numericValue)
    assert.equal(aRow.submissionId, 'a-b1')
    assert.equal(bRow.submissionId, 'b-b1')
    assert.equal(dataA.read('participants').revision, dataB.read('participants').revision, '两份研究独立演进，revision 恰好相同不代表串数据')
    assert.equal(readJson(path.join(wsA, 'data', '.scale-study.json')).studyId, 'e2e-study-a')
    assert.equal(readJson(path.join(wsB, 'data', '.scale-study.json')).studyId, 'e2e-study-b')

    const statusA = await getStatus('page-two-a0001')
    const statusB = await getStatus('page-two-b0001')
    assert.equal(statusA.json.data.study.id, 'e2e-study-a')
    assert.equal(statusB.json.data.study.id, 'e2e-study-b')
    assert.equal(statusA.json.data.binding.token, tokenA)
    assert.equal(statusB.json.data.binding.token, tokenB)

    // 后台工具按会话读各自研究；运行台投影的分组与性别也不串。
    const opsHost = makeHost({
      workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }],
      sessions: { 's-a': wsA, 's-b': wsB },
      cwd: path.join(root, 'no-config'),
    })
    const ops = await loadPlugin(path.resolve(import.meta.dirname, '../../study-ops'))
    ops.apply(opsHost.ctx, { studyPath: '' })
    const textA = (await opsHost.tools.get('study_status').execute({ focus: 'summary' }, { agent: { id: 's-a' } })).text
    const textB = (await opsHost.tools.get('study_status').execute({ focus: 'summary' }, { agent: { id: 's-b' } })).text
    assert.match(textA, /09 E2E 量表研究 e2e-study-a/)
    assert.doesNotMatch(textA, /e2e-study-b/)
    assert.match(textB, /09 E2E 量表研究 e2e-study-b/)
    assert.doesNotMatch(textB, /e2e-study-a/)
    const projectionA = (await opsHost.tools.get('flow_projection').execute({ focus: 'groups' }, { agent: { id: 's-a' } })).text
    const projectionB = (await opsHost.tools.get('flow_projection').execute({ focus: 'groups' }, { agent: { id: 's-b' } })).text
    assert.match(projectionA, /arm=A：已入组 3；男 0 女 3/)
    assert.doesNotMatch(projectionA, /arm=B/)
    assert.match(projectionB, /arm=B：已入组 3；男 3 女 0/)
    assert.doesNotMatch(projectionB, /arm=A/)
    assert.deepEqual(participantsOf(dataA), ['P-001', 'P-002', 'P-003'])
    assert.deepEqual(participantsOf(dataB), ['P-001', 'P-002', 'P-003'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * E2E-08 锁 / 崩溃 / 重启
 * ------------------------------------------------------------------ */
test('E2E-08 并发写与坏锁：有界拒绝、不丢更新、坏锁不静默删除、死锁恢复、重开状态正确', () => {
  const dir = tmp('rc-r09e2e-lock-')
  try {
    const file = writeStudy(dir, { studyId: 'e2e-lock', name: '09 E2E 锁研究', visits: [], tasks: [] })
    const study = studyContext(file)
    const dataA = openResearchData({ study, instanceId: 'inst-lock-0001' })
    const dataB = openResearchData({ study, instanceId: 'inst-lock-0001' })

    dataA.commit('participants', { schemaVersion: 1, participants: [{ participantId: 'P-001', status: 'registered' }] }, { owner: 'e2e' })
    const revisionBefore = dataA.read('participants').revision

    // 并发写：A 持锁时 B 只有在有界等待后明确冲突；释放后 B 成功且只递增一次。
    const held = dataA.lock('participants', { owner: 'holder-A', timeoutMs: 500 })
    const started = Date.now()
    assert.throws(
      () => dataB.commit('participants', { schemaVersion: 1, participants: [{ participantId: 'P-002', status: 'registered' }] }, { owner: 'writer-B', timeoutMs: 250 }),
      error => error && error.code === 'dataset_conflict' && error.committed === false,
    )
    assert.ok(Date.now() - started < 2000, '锁冲突必须有界返回')
    assert.equal(dataA.read('participants').revision, revisionBefore, '冲突方不能留下半成品')
    held.release()
    const written = dataB.commit('participants', {
      schemaVersion: 1,
      participants: [{ participantId: 'P-001', status: 'registered' }, { participantId: 'P-002', status: 'registered' }],
    }, { owner: 'writer-B', timeoutMs: 500 })
    assert.equal(written.committed, true)
    assert.equal(dataB.read('participants').revision, revisionBefore + 1, '释放后只提交一次，无丢更新')

    // 坏锁：锁文件损坏时有界返回 recovery_required，且不能静默删除/抢占。
    const lockDemographics = path.join(study.dataRoot, 'transactions', `lock-${sha('demographics', 16)}.json`)
    const heldBad = dataA.lock('demographics', { owner: 'bad-lock', timeoutMs: 500 })
    writeFileSync(lockDemographics, '{', 'utf8')
    const badStarted = Date.now()
    assert.throws(
      () => dataB.commit('demographics', { schemaVersion: 1, rows: [] }, { owner: 'after-bad', timeoutMs: 300 }),
      error => error && error.code === 'recovery_required' && error.committed === false,
    )
    assert.ok(Date.now() - badStarted < 2000, '坏锁必须在有界时间内退出')
    assert.ok(existsSync(lockDemographics), '坏锁不能被静默删除')
    void heldBad.release()

    // 操作者修复坏锁后，同一数据集可以正常提交。
    rmSync(lockDemographics, { force: true })
    const recovered = dataB.commit('demographics', { schemaVersion: 1, rows: [{ id: 'P-001', values: { sex: '女' } }] }, { owner: 'after-repair', timeoutMs: 500 })
    assert.equal(recovered.committed, true)
    assert.equal(dataB.read('demographics').revision, 1)

    // 崩溃遗留锁：同主机、同启动实例、进程已退出 → 归档后继续，不按 TTL 抢活锁。
    const heldDead = dataA.lock('tasks', { owner: 'dead-owner', timeoutMs: 500 })
    const deadLockFile = path.join(study.dataRoot, 'transactions', `lock-${sha('tasks', 16)}.json`)
    const deadRecord = readJson(deadLockFile)
    writeFileSync(deadLockFile, JSON.stringify({ ...deadRecord, processId: 999999, owner: 'dead-process' }), 'utf8')
    const afterCrash = dataB.commit('tasks', { schemaVersion: 1, sources: [] }, { owner: 'recoverer', timeoutMs: 900 })
    assert.equal(afterCrash.committed, true)
    assert.equal(afterCrash.revision, 1)
    assert.equal(existsSync(deadLockFile), false, '死进程锁应被归档而不是继续阻塞')
    const staleDir = path.join(study.dataRoot, 'transactions', 'stale')
    assert.ok(existsSync(staleDir) && readdirSync(staleDir).some(name => name.startsWith('lock-')), '遗留锁应归档到 transactions/stale')
    void heldDead.release()

    // 重启（重新打开）后重新读取同一数据根：状态与 revision 正确，没有内存残留。
    const reopened = openResearchData({ study, instanceId: 'inst-lock-0001' })
    assert.deepEqual(participantsOf(reopened).sort(), ['P-001', 'P-002'])
    assert.equal(reopened.read('participants').revision, revisionBefore + 1)
    assert.equal(reopened.read('demographics').revision, 1)
    assert.equal(reopened.read('tasks').revision, 1)
    assert.deepEqual(reopened.recoverPreview().staleLocks, [], '已归档的锁不应再次被识别为待恢复')
    assert.equal(reopened.health('participants').state, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * E2E-09 断网 / 本地
 * ------------------------------------------------------------------ */
test('E2E-09 断网本地全链路：fetch 被禁用仍能运行/导出，分享产物无外部 URL', async (t) => {
  if (!hasPython) { t.skip('本机没有可用 Python，无法运行本地分析引擎'); return }
  const dir = tmp('rc-r09e2e-offline-')
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  try {
    const csv = write(dir, 'data.csv', 'participantId,group,score\nP-001,A,1\nP-002,A,2\nP-003,B,3\nP-004,B,4\n')
    const file = writeStudy(dir, { studyId: 'e2e-offline', name: '09 E2E 断网研究' })
    const analysis = await loadAnalysis(dir)
    const call = options => request(analysis.handler, options)
    const get = (action, pageId) => call({ path: `/api/analysis-run?action=${action}`, headers: { 'x-analysis-run': '1', ...pageHeaders(pageId) } })
    const post = (action, payload, pageId) => call({
      method: 'POST', path: '/api/analysis-run',
      headers: { 'x-analysis-run': '1', 'content-type': 'application/json', ...pageHeaders(pageId) },
      body: { action, payload },
    })
    const page = 'page-e2e-offline01'
    const connected = await post('studyConnect', { studyPath: file }, page)
    assert.equal(connected.status, 200)
    const token = connected.json.data.binding.token
    const plan = {
      dataPath: csv, idColumn: 'participantId', outcome: 'score', layout: 'wide',
      groupColumns: ['group'], covariates: [], pairedColumns: [], analyses: ['descriptives'], gate: { minSubjects: 2 },
    }
    const schema = await get('schema', page)
    await post('plan', { plan, revision: schema.json.data.planRevision, binding: token }, page)

    // 断网：任何 fetch 调用都会抛错，并记录次数。
    globalThis.fetch = () => { fetchCalls += 1; throw new Error('网络被测试禁用') }
    const run = await post('run', { stage: 'all', binding: token }, page)
    assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 800))
    const exported = await post('export', { runId: run.json.data.runId, binding: token }, page)
    assert.equal(exported.status, 200, JSON.stringify(exported.json).slice(0, 800))
    assert.equal(fetchCalls, 0, '本地运行/导出不能发起 fetch')

    // 分享产物无外部 URL；本机路径与逐人编号不进入分享视图。
    const dirOut = path.join(dir, 'data', 'analysis', 'runs', run.json.data.runId, 'presentation', '1')
    const html = readFileSync(path.join(dirOut, 'report.html'), 'utf8')
    const results = readFileSync(path.join(dirOut, 'results.json'), 'utf8')
    const manifest = readFileSync(path.join(dirOut, 'manifest.json'), 'utf8')
    for (const [name, text] of [['report.html', html], ['results.json', results], ['manifest.json', manifest]]) {
      assert.doesNotMatch(text, /https?:\/\//, `${name} 不应包含外部 URL`)
      assert.doesNotMatch(text, /P-00[1-4]/, `${name} 不应包含逐人编号`)
      assert.doesNotMatch(text, new RegExp(dir.replace(/\\/g, '\\\\')), `${name} 不应包含本机绝对路径`)
    }

    // Agent 出站摘要也不带路径/逐人编号；没有模板/通知服务时不伪造通知载荷。
    const statusTool = analysis.tools.get('analysis_status')
    const statusText = (await statusTool.execute({}, { agent: { id: 's-e2e' } })).text
    assert.doesNotMatch(statusText, /P-00[1-4]/)
    assert.doesNotMatch(statusText, new RegExp(dir.replace(/\\/g, '\\\\')))
    assert.doesNotMatch(statusText, /https?:\/\//)
    // 生产插件不引入 HTTP/网络模块（本测试只做静态核对，不声称覆盖官方通知 gateway）。
    for (const source of ['analysis-run/index.js', 'scale-desk/index.js', 'study-ops/index.js']) {
      const code = readFileSync(path.resolve(import.meta.dirname, '../../', source), 'utf8')
      assert.doesNotMatch(code, /\bfetch\s*\(|node:https?\b|from\s+['"]https?:/i, `${source} 不应发起网络请求`)
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * 明确跳过：第 9 步提醒/手机属于 08 阶段
 * ------------------------------------------------------------------ */
test('SKIP-09-9 提醒创建/改期/解除/回执与手机状态（属 08，需要官方 gateway）', {
  skip: '方案第 9 步属于 08 阶段：提醒创建/改期/解除/回执与手机状态需要官方 gateway；本阶段按任务说明跳过，不用本地 stub 伪造真实发送或手机状态。',
}, () => {
  assert.fail('不应执行')
})
