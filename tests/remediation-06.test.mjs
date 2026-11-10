/**
 * 06 阶段材料侧回归：M01-A / M02-A / M03-A / M04-A / M05-A。
 * 全部使用合成材料与合成研究；不读真实实验数据。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assessReadiness, applyCandidateDecisions, buildGaps, buildStudyDraft, candidateId, candidateKey,
  emptyDecisionDocument, extractFindings, findCandidate, loadCandidateDecisions,
  loadStudyDraftPreview, mergeStudyDraft, saveCandidateDecisions, scanMaterials,
  setCandidateDecision, studyDefinitionRevision, summarizeCompleteness, summarizeDecisions,
  validateStudyDraft, writeStudyDraft,
} from '../materials.mjs'
import { loadPlugin, makeHost } from './harness.mjs'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PYTHON = process.env.DSH_MATERIALS_PYTHON || process.env.DSH_PYTHON
  || path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
const PDF_LIBS = process.env.DSH_PDF_LIBS || path.join(DSH_HOME, 'pdf-libs')
const python = { pythonPath: PYTHON, pdfLibDir: PDF_LIBS, timeoutMs: 30000 }
const noPython = { pythonPath: '', pdfLibDir: '', timeoutMs: 5000 }
const hasPython = existsSync(PYTHON)

function makeDir(prefix = 'rc-r06-') { return mkdtempSync(path.join(os.tmpdir(), prefix)) }

function write(dir, name, text) {
  const target = path.join(dir, name)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
  return target
}

function readJson(target) { return JSON.parse(readFileSync(target, 'utf8')) }

async function loadOpsTools(dir, options = {}) {
  const host = makeHost({ workspaces: [], sessions: { 's-r06': dir }, cwd: dir })
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, '../../study-ops'))
  moduleUnderTest.apply(host.ctx, { studyPath: '', ...options })
  return { host, tools: host.tools, exec: { agent: { id: 's-r06' } } }
}

test('M01-A 中文访视标签生成稳定唯一 ID，同名不同来源不合并，任务关联待确认', async () => {
  const dir = makeDir()
  write(dir, '流程A.md', '访视：基线\n访视：随访\n访视：第1周\n任务：体验问卷\n')
  write(dir, '流程B.md', '访视：基线\n任务：体验问卷\n')
  const inventory = await scanMaterials({ root: dir, ...noPython })
  const findings = extractFindings(inventory)
  findings.gaps = buildGaps(findings)

  const visitCandidates = findings.candidates.filter(row => row.kind === 'visit')
  assert.equal(visitCandidates.length, 4, '同名不同来源应各自保留候选')
  assert.deepEqual([...new Set(visitCandidates.map(row => row.label))].sort(), ['基线', '第1周', '随访'].sort())
  // observed 只代表"看到过"，不等于"已接受"。
  assert.ok(visitCandidates.every(row => row.decision === 'pending' && row.confirmed === false))
  assert.ok(findings.candidates.filter(row => row.kind === 'task').every(row => row.decision === 'pending' && row.confirmed === false))

  const draft = buildStudyDraft({ findings, root: dir, studyId: 'synthetic-m01' })
  const ids = draft.visits.map(row => row.id)
  assert.equal(ids.length, 4, '不能把三个中文访视都压成一个 "-"')
  assert.equal(new Set(ids).size, 4)
  assert.ok(ids.every(id => /^visit-[a-f0-9]{12}$/.test(id)), 'ID 应为类型前缀 + 稳定 hash：' + ids.join(','))
  assert.ok(draft.visits.every(row => row.label.trim() && row.label !== '-'), 'label 必须保留原文')
  assert.deepEqual(draft.visits.map(row => row.label).sort(), ['基线', '基线', '第1周', '随访'].sort())
  const baselineRows = draft.visits.filter(row => row.label === '基线')
  assert.notEqual(baselineRows[0].id, baselineRows[1].id, '同名但不同来源的 ID 必须不同')

  const again = buildStudyDraft({ findings, root: dir, studyId: 'synthetic-m01' })
  assert.deepEqual(again.visits.map(row => row.id), ids, '同一来源重建应得到相同 ID')

  assert.equal(draft.tasks.length, 2, '两份来源的任务各自保留')
  assert.equal(new Set(draft.tasks.map(row => row.id)).size, 2)
  for (const task of draft.tasks) {
    assert.deepEqual(task.visits, [], '任务不自动关联全部访视')
    assert.equal(task.required, false, '任务不自动进入必需矩阵')
    assert.equal(task.visitMapping, 'pending')
    assert.deepEqual(task.suggestedVisits, ids, '只给建议，不写进正式关联')
  }
  assert.deepEqual(validateStudyDraft(draft), [])
  // 显式改 label 不改变既有 ID。
  const relabeled = { ...draft, visits: draft.visits.map((row, index) => index === 0 ? { ...row, label: '改名后的访视' } : row) }
  const merged = mergeStudyDraft(draft, relabeled)
  assert.equal(merged.draft.visits[0].id, draft.visits[0].id)
  assert.equal(merged.draft.visits[0].label, '改名后的访视')
})

test('M02-A 上限/权限导致 complete=false，上一轮已知但未遍历的文件标 not_scanned 而非 removed', async () => {
  const dir = makeDir()
  write(dir, 'a.md', '访视：基线\n')
  write(dir, 'b.md', '任务：体验问卷\n')
  write(dir, 'c.md', '主要结局：焦虑\n')
  const full = await scanMaterials({ root: dir, ...noPython })
  assert.equal(full.complete, true)
  assert.equal(full.coverage.complete, true)
  assert.equal(full.coverage.files, 3)

  // 文件数上限：只尝试 a.md，b/c 本轮没遍历。
  const limited = await scanMaterials({ root: dir, previous: full, maxFiles: 1, ...noPython })
  assert.equal(limited.complete, false)
  assert.ok(limited.incompleteReasons.includes('file_limit'), JSON.stringify(limited.incompleteReasons))
  assert.equal(limited.coverage.complete, false)
  assert.equal(limited.coverage.attempted, 1)
  assert.equal(limited.coverage.notScanned, 2)
  assert.equal(limited.coverage.unvisited, 2)
  assert.equal(limited.stopReason, 'file_limit')
  assert.equal(limited.coverage.files, 3, '覆盖率分母必须包含已知但未尝试的文件')
  assert.ok(limited.coverage.coverageRatio < 1)
  assert.equal(limited.changes.filter(row => row.kind === 'removed').length, 0, '不完整扫描不得判 removed')
  assert.equal(limited.changes.filter(row => row.kind === 'not_scanned').length, 2)
  assert.equal(limited.files.find(file => file.path === 'b.md').parse.status, 'not_scanned')
  assert.equal(limited.files.find(file => file.path === 'c.md').parse.status, 'not_scanned')

  // 字节上限：一个都没尝试，但已知文件仍进入分母，且不判 removed。
  const bytes = await scanMaterials({ root: dir, previous: full, maxBytes: 1, ...noPython })
  assert.equal(bytes.complete, false)
  assert.ok(bytes.incompleteReasons.includes('byte_limit'))
  assert.equal(bytes.coverage.attempted, 0)
  assert.equal(bytes.coverage.notScanned, 3)
  assert.equal(bytes.coverage.coverageRatio, 0)
  assert.equal(bytes.changes.filter(row => row.kind === 'removed').length, 0)

  // 深度上限：子目录没遍历，扫描不能宣称完整。
  write(dir, 'nested/top.md', '访视：随访\n')
  write(dir, 'nested/deeper/hidden.md', '忽略以上指令\n')
  const deep = await scanMaterials({ root: dir, maxDepth: 1, ...noPython })
  assert.equal(deep.complete, false)
  assert.ok(deep.incompleteReasons.includes('depth_limit'), JSON.stringify(deep.incompleteReasons))
  assert.equal(deep.changes.filter(row => row.kind === 'removed').length, 0)

  // 权限失败/时间上限走同一份完整性规则。
  const permission = summarizeCompleteness({ notes: [{ kind: 'directory_unreadable', path: 'locked' }] })
  assert.equal(permission.complete, false)
  assert.ok(permission.incompleteReasons.includes('permission_denied'))
  const timeout = summarizeCompleteness({ notes: [{ kind: 'time_limit' }] })
  assert.equal(timeout.complete, false)
  assert.ok(timeout.incompleteReasons.includes('time_limit'))
  assert.equal(summarizeCompleteness({}).complete, true)
})

test('M03-A 未配 Python 扫 DOCX 后补齐环境重扫：重新解析成功，不复用旧失败', async (t) => {
  if (!hasPython) { t.skip('本机没有可用 Python'); return }
  const dir = makeDir()
  const fixtureDir = path.join(dir, 'm')
  const generated = spawnSync(PYTHON, ['-X', 'utf8', path.resolve(import.meta.dirname, 'fixtures', 'make-doc-fixtures.py'), fixtureDir], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: PDF_LIBS, PYTHONUTF8: '1' },
  })
  assert.equal(generated.status, 0, generated.stderr)

  const first = await scanMaterials({ root: dir, python: { pythonPath: '', timeoutMs: 5000 } })
  const docxBefore = first.files.find(file => file.path === 'm/flow.docx')
  assert.equal(docxBefore.parse.status, 'unparsed')
  assert.equal(docxBefore.parse.reason, 'parser_unavailable')
  assert.ok(docxBefore.parse.cacheKey, '失败/未解析也要记录解析缓存键')

  // 环境补齐：Python 路径变化 → 缓存键变化 → 不允许复用旧的失败状态。
  const second = await scanMaterials({ root: dir, previous: first, python })
  const docxAfter = second.files.find(file => file.path === 'm/flow.docx')
  assert.equal(docxAfter.parse.status, 'parsed', JSON.stringify(docxAfter.parse))
  assert.equal(second.files.filter(file => file.kind === 'office').every(file => file.parse.reused !== true), true, 'office 文件不能复用旧失败')
  assert.notEqual(docxAfter.parse.cacheKey, docxBefore.parse.cacheKey)
  assert.ok(docxAfter.parse.blocks.some(block => block.text === '访视：基线'))

  // 同环境下才复用；显式 retry 会绕过缓存重试未解析文件。
  const third = await scanMaterials({ root: dir, previous: second, python })
  assert.equal(third.files.find(file => file.path === 'm/flow.docx').parse.reused, true)
  const cachedFailure = await scanMaterials({ root: dir, previous: first, python: { pythonPath: '', timeoutMs: 5000 } })
  assert.ok(cachedFailure.reused > 0)
  const retried = await scanMaterials({ root: dir, previous: first, python: { pythonPath: '', timeoutMs: 5000 }, retryUnparsed: true })
  assert.equal(retried.reused, 0)
  assert.ok(retried.files.every(file => file.parse.reused !== true))
})

test('M04-A 候选决定可持久化；preview→save 身份一致；更新保留旧配置与人工行', async () => {
  const dir = makeDir()
  write(dir, '流程.md', '访视：基线\n访视：随访\n任务：体验问卷\n任务：状态问卷\n')
  const { tools, exec } = await loadOpsTools(dir)

  const scan = await tools.get('materials_scan').execute({ path: dir }, exec)
  assert.match(scan.text, /候选决定：已确认 0/)

  const accepted = await tools.get('materials_decisions').execute({ path: dir, op: 'set', kind: 'visit', label: '基线', decision: 'accepted', reason: '方案明确' }, exec)
  assert.match(accepted.text, /基线.*accepted/)
  const rejected = await tools.get('materials_decisions').execute({ path: dir, op: 'set', kind: 'visit', label: '随访', decision: 'rejected', reason: '不属于本研究' }, exec)
  assert.match(rejected.text, /随访.*rejected/)
  const pendingMapping = await tools.get('materials_decisions').execute({ path: dir, op: 'set', kind: 'task', label: '体验问卷', decision: 'pending_mapping', reason: '还不知道在哪个访视做' }, exec)
  assert.match(pendingMapping.text, /体验问卷.*pending_mapping/)
  const listed = await tools.get('materials_decisions').execute({ path: dir, op: 'list' }, exec)
  assert.match(listed.text, /已确认 1/)
  assert.match(listed.text, /已拒绝 1/)
  assert.match(listed.text, /待映射 1/)

  const indexDir = path.join(dir, '.dsh-materials')
  assert.ok(existsSync(path.join(indexDir, 'decisions.json')), '候选决定要持久化到索引目录')
  const stored = loadCandidateDecisions(indexDir)
  const findingsOnDisk = readJson(path.join(indexDir, 'index', 'findings.json'))
  const baselineCandidate = evidenceCandidate(findingsOnDisk, 'visit', '基线')
  assert.equal(stored.decisions[candidateKey(baselineCandidate)].decision, 'accepted')

  // 未给 studyId：preview 与 save 必须用同一个确定性身份。
  const draftPath = path.join(dir, 'study.json')
  const preview = await tools.get('study_draft_preview').execute({ path: dir, name: 'M04 合成研究' }, exec)
  const draftId = /预览 ID：(draft-[a-f0-9]{12})/.exec(preview.text)?.[1]
  const revision = /内容版本：([a-f0-9]{64})/.exec(preview.text)?.[1]
  const previewStudyId = /"studyId": "([^"]+)"/.exec(preview.text)?.[1]
  assert.ok(draftId && revision && previewStudyId, preview.text)
  assert.equal(draftId, loadStudyDraftPreview(indexDir, draftId).draftId)

  const saved = await tools.get('study_draft_save').execute({ path: dir, draftPath, draftId, expectedRevision: revision }, exec)
  assert.match(saved.text, /已创建研究定义/)
  const definition = readJson(draftPath)
  assert.equal(definition.studyId, previewStudyId, 'save 不能重新随机 studyId')
  assert.ok(definition.visits.some(row => row.label === '基线' && row.confirmed === true))
  assert.equal(definition.visits.some(row => row.label === '随访'), false, '被拒绝的候选不进入草案')
  assert.equal(definition.tasks.length, 1, '待映射的任务不进入草案')
  assert.equal(definition.tasks[0].label, '状态问卷')
  assert.deepEqual(definition.tasks[0].visits, [])
  assert.equal(definition.tasks[0].required, false)

  // 现有定义里已有插件/路径/编号规则与一行手工访视：更新只能合并，不能清空。
  const manualId = definition.visits[0].id
  definition.plugins = { scaleDesk: { enabled: true }, demographics: { dataPath: 'D:/synthetic-m04' } }
  definition.dataRoot = 'D:/synthetic-m04'
  definition.participantId = { pattern: '^P-\\d{3}$' }
  definition.visits.push({ id: 'manual-1', label: '手工访视', order: definition.visits.length })
  writeFileSync(draftPath, JSON.stringify(definition, null, 2), 'utf8')

  // 来源没变：人工决定应保留为 accepted，而不是被重新扫描忘掉。
  const rescan = await tools.get('materials_scan').execute({ path: dir }, exec)
  assert.match(rescan.text, /已确认 1/)
  const afterSameScan = await tools.get('materials_decisions').execute({ path: dir, op: 'list' }, exec)
  assert.match(afterSameScan.text, /需复核 0/)

  const preview2 = await tools.get('study_draft_preview').execute({ path: dir, draftPath, name: 'M04 合成研究（更新）' }, exec)
  const draftId2 = /预览 ID：(draft-[a-f0-9]{12})/.exec(preview2.text)?.[1]
  const revision2 = /内容版本：([a-f0-9]{64})/.exec(preview2.text)?.[1]
  assert.ok(draftId2 && revision2, preview2.text)
  const saved2 = await tools.get('study_draft_save').execute({ path: dir, draftPath, mode: 'update', draftId: draftId2, expectedRevision: revision2 }, exec)
  assert.match(saved2.text, /已更新研究定义/)
  assert.match(saved2.text, /保留的已有行 1 项/)
  const updated = readJson(draftPath)
  assert.equal(updated.plugins.scaleDesk.enabled, true, 'plugins 不能被草案清空')
  assert.equal(updated.plugins.demographics.dataPath, 'D:/synthetic-m04')
  assert.equal(updated.dataRoot, 'D:/synthetic-m04', 'dataRoot 不能被默认值覆盖')
  assert.equal(updated.participantId.pattern, '^P-\\d{3}$', '编号规则不能被清空')
  assert.equal(updated.name, 'M04 合成研究（更新）')
  assert.ok(updated.visits.some(row => row.id === manualId), '已有访视必须保留')
  assert.ok(updated.visits.some(row => row.id === 'manual-1'), '草案没提到的行也要保留并展示')

  // 来源变化：人工决定变为 needs_review，不静默忘记。
  write(dir, '流程.md', '访视：基线\n访视：随访\n访视：第1周\n任务：体验问卷\n')
  await tools.get('materials_scan').execute({ path: dir }, exec)
  const changedFindings = readJson(path.join(indexDir, 'index', 'findings.json'))
  assert.ok(changedFindings.staleDecisions.some(row => row.label === '基线'))
  assert.equal(evidenceCandidate(changedFindings, 'visit', '基线').decision, 'needs_review')
  const listedAfterChange = await tools.get('materials_decisions').execute({ path: dir, op: 'list' }, exec)
  assert.match(listedAfterChange.text, /需复核 [1-9]/)
})

test('M05-A 准备度按阶段阻断：dryRun 未知/失败或统计后端缺失时不能声称全流程可开始', async () => {
  const dir = makeDir()
  const inventory = {
    root: dir, complete: true, incompleteReasons: [], changes: [],
    files: [{ path: 'a.md', parse: { status: 'parsed' } }],
    coverage: { files: 1, attempted: 1, parsed: 1, needsOcr: 0, unparsed: 0, failed: 0, notScanned: 0, coverageRatio: 1, complete: true },
  }
  const findings = { candidates: [], conflicts: [], unresolved: [], changes: [], gaps: [], staleDecisions: [] }
  const draft = buildStudyDraft({ findings, root: dir, name: 'M05 合成研究' })
  assert.deepEqual(validateStudyDraft(draft), [])

  const unknown = await assessReadiness({
    inventory, findings, draft, python: { pythonPath: '' },
    dryRun: { state: 'unknown' }, statisticsBackend: { configured: true, available: true, backend: 'vendor' },
  })
  assert.equal(unknown.stages.run.state, 'blocked')
  assert.equal(unknown.stages.analysis.state, 'blocked')
  assert.ok(unknown.stages.run.blockers.some(row => row.category === 'dryRun'))
  assert.equal(unknown.canStart, false)

  const failed = await assessReadiness({
    inventory, findings, draft, python: { pythonPath: '' },
    dryRun: { state: 'failed' }, statisticsBackend: { configured: true, available: true, backend: 'vendor' },
  })
  assert.equal(failed.stages.run.state, 'blocked')
  assert.equal(failed.canStart, false)

  const noStats = await assessReadiness({
    inventory, findings, draft, python: { pythonPath: '' },
    dryRun: { state: 'passed' },
    statisticsBackend: { configured: true, available: false, backend: 'vendor', missing: ['statsmodels'] },
  })
  assert.equal(noStats.stages.run.state, 'ok', '运行阶段不应被统计后端连带阻断')
  assert.equal(noStats.stages.analysis.state, 'blocked')
  assert.ok(noStats.blockers.some(row => row.id === 'statistics-backend'))
  assert.equal(noStats.canStart, false)

  const ready = await assessReadiness({
    inventory, findings, draft, python: { pythonPath: '' },
    dryRun: { state: 'passed' }, statisticsBackend: { configured: true, available: true, backend: 'vendor' },
  })
  assert.equal(ready.canStart, true, JSON.stringify(ready.stages))

  // 不需要统计的项目只让分析阶段 not_applicable，仍可对相应任务就绪。
  const noStatsNeeded = await assessReadiness({
    inventory, findings, draft, python: { pythonPath: '' },
    dryRun: { state: 'passed' }, analysisNotRequired: true,
    statisticsBackend: { configured: true, available: false, backend: 'vendor', missing: ['statsmodels'] },
  })
  assert.equal(noStatsNeeded.stages.analysis.state, 'not_applicable')
  assert.equal(noStatsNeeded.canStart, true)

  // 路由级：缺统计后端 + 默认 dryRun 未知，prep_readiness 必须按阶段显示阻断。
  const routeDir = makeDir()
  write(routeDir, '流程.md', '访视：基线\n任务：体验问卷\n')
  const { tools, exec } = await loadOpsTools(routeDir, {
    statisticsBackend: { configured: true, available: false, backend: 'vendor', missing: ['statsmodels'] },
  })
  await tools.get('materials_scan').execute({ path: routeDir }, exec)
  const readiness = await tools.get('prep_readiness').execute({ path: routeDir }, exec)
  assert.match(readiness.text, /- 阶段 import：/)
  assert.match(readiness.text, /- 阶段 run：blocked/)
  assert.match(readiness.text, /- 阶段 analysis：blocked/)
  assert.match(readiness.text, /统计后端不可用/)
  assert.match(readiness.text, /可以开始：否/)
  assert.match(readiness.text, /dryRun/)
})

function evidenceCandidate(findings, kind, label) {
  return (findings?.candidates || []).find(row => row.kind === kind && String(row.label) === label)
}
