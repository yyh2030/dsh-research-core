/**
 * 2026-11-13 后续修复 A1/A4/A5/A6 的合成回归。
 * 全部使用临时目录与临时研究，不读写真实研究。
 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'
import { openAnalysis } from '../analysis.mjs'
import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'

const PYTHON = 'C:/Users/16787/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe'
const ENGINE = 'D:/dsh-plugins/analysis-run/engine.py'

function makeProject(prefix = 'rc-fix-') {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix))
  const definition = {
    schemaVersion: 1, studyId: 'fix-study', name: 'FIX 合成研究', dataRoot: './data',
    participantId: { pattern: '^P-\\d{3}$' }, visits: [{ id: 'T0', label: '基线', order: 0 }],
    tasks: [{ id: 'stq', label: '状态问卷', visits: ['T0'], required: true, source: { type: 'scale', scaleId: 'STQ', waveId: 'T0' } }],
    followups: [], plugins: {},
  }
  const studyPath = path.join(root, 'study.json')
  writeFileSync(studyPath, JSON.stringify(definition, null, 2))
  const dataRoot = path.join(root, 'data'); mkdirSync(dataRoot, { recursive: true })
  const study = { id: definition.studyId, name: definition.name, path: studyPath, dataRoot, baseDir: root, plugin: {}, visits: definition.visits, tasks: definition.tasks, followups: [], revision: 'rev-1' }
  const data = openResearchData({ study, instanceId: 'inst-fix-0001' })
  const flow = openFlow({ data, study })
  return { root, study, data, flow, studyPath, dataRoot }
}

function scoreRow(overrides = {}) {
  return {
    participantId: 'P-001', scaleId: 'STQ', waveId: 'T0', subscaleKey: 'total',
    numericValue: 42, status: 'ok', reason: null, definitionHash: 'def-hash', definitionVersion: 'v1',
    selectedSubmissionId: 'subB', submissionId: 'subB', answered: 1, missing: 0, itemCount: 1,
    taskId: 'stq', visitId: 'T0', sourceRevision: 'def:defhash|sub:subB',
    recordedAt: '2026-11-13T00:00:00Z', ...overrides,
  }
}

test('FIX-01 撤销/改选裁决后不再读取旧分数，重算后才读新值', () => {
  const project = makeProject('rc-fix-a1-')
  const { data, flow, study } = project
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  const participant = flow.participants.list().find(row => row.participantId === 'P-001')
  const publish = (recordId, submissionId) => flow.observations.publish({
    participantId: 'P-001', visitId: 'T0', taskId: 'stq', recordId,
    collectionState: 'complete', qualityState: 'valid', sourceType: 'scale', sourceId: 'STQ@T0',
    sourceRevision: `def:h|sub:${submissionId}`, evidence: { scaleId: 'STQ', waveId: 'T0', submissionId },
  })
  publish('obs-b', 'subB'); publish('obs-a', 'subA')
  const rows = data.read('observations').value.observations
  const subB = rows.find(row => row.recordId === 'obs-b'); const subA = rows.find(row => row.recordId === 'obs-a')

  flow.observations.adjudicate({ participantKey: participant.participantKey, visitId: 'T0', taskId: 'stq', observationId: subB.observationId, reason: '先选 B' })
  const chosenVersion = data.read('observations').value.observations.find(row => row.observationId === subB.observationId).adjudication.version
  const first = data.commit('scores', { schemaVersion: 1, plugin: 'scale-desk', studyId: 'fix-study', rows: [
    scoreRow({ observationId: subB.observationId, adjudicationVersion: chosenVersion }),
    scoreRow({ numericValue: null, status: 'duplicate', reason: '多份提交未裁决或未被选中', selectedSubmissionId: null, observationId: subB.observationId, adjudicationVersion: chosenVersion }),
  ] }, { owner: 'scale-desk' })
  const plan = { subset: 'enrolled', variables: [{ name: 'score_t0', type: 'score', scaleId: 'STQ', waveId: 'T0' }] }
  const analysis = openAnalysis({ data, study })
  const before = analysis.dataset({ plan })
  assert.equal(before.rows[0].score_t0, 42)

  flow.observations.cancelAdjudication({ participantKey: participant.participantKey, visitId: 'T0', taskId: 'stq' })
  const revoked = analysis.dataset({ plan })
  assert.equal(revoked.rows[0].score_t0, '', '撤销后不能再读旧分数 42')
  assert.equal(revoked.stats.missingReason.score_t0, 'adjudication_revoked')

  flow.observations.adjudicate({ participantKey: participant.participantKey, visitId: 'T0', taskId: 'stq', observationId: subA.observationId, reason: '改选 A' })
  const newVersion = data.read('observations').value.observations.find(row => row.observationId === subA.observationId).adjudication.version
  assert.notEqual(newVersion, chosenVersion, '撤销后重新裁决必须得到新的版本号')
  const pending = analysis.dataset({ plan })
  assert.equal(pending.rows[0].score_t0, '', '改选 A 但未重算时不能继续读 B 的 42')
  assert.equal(pending.stats.missingReason.score_t0, 'score_pending')

  data.commit('scores', { schemaVersion: 1, plugin: 'scale-desk', studyId: 'fix-study', rows: [
    scoreRow({ numericValue: 17, selectedSubmissionId: 'subA', submissionId: 'subA', observationId: subA.observationId, adjudicationVersion: newVersion }),
  ] }, { owner: 'scale-desk' })
  const after = analysis.dataset({ plan })
  assert.equal(after.rows[0].score_t0, 17, '重算后只返回 A 的分数')
  assert.equal(after.stats.missing.score_t0, 0)

  // 历史 scores 代次仍可读且保留 B 的 42，不被新代次改写。
  const oldGeneration = data.history('scores').find(row => row.revision === first.revision)
  assert.ok(oldGeneration, '旧 scores 代次必须保留')
  const historical = JSON.parse(readFileSync(path.join(project.dataRoot, 'generations', 'scores', oldGeneration.generationId, 'data.json'), 'utf8')).rows
  assert.equal(historical.find(row => row.submissionId === 'subB').numericValue, 42)
  assert.notEqual(before.hash, after.hash, '裁决/分数变化必须改变分析 hash')
})

function engineRun(request) {
  const result = spawnSync(PYTHON, ['-X', 'utf8', ENGINE, '--request-json', JSON.stringify(request)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const marker = String(result.stdout || '').lastIndexOf('===JSON===')
  if (marker < 0) throw new Error('engine failed: ' + String(result.stderr || '').slice(-500))
  return JSON.parse(result.stdout.slice(marker + 10))
}

test('FIX-04 5 人输入：ttest 有效 4、相关有效 3，节点/表/分析集一致', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-fix-a4-'))
  const csv = path.join(root, 'data.csv')
  writeFileSync(csv, ['participantId,y,z', '001,1,10', '002,2,11', '003,3,15', '004,4,', '005,,'].join('\n') + '\n')
  const outputDir = path.join(root, 'out'); mkdirSync(outputDir, { recursive: true })
  const result = engineRun({ action: 'run', study: { id: 'fix-a4', name: 'fix-a4' }, plan: {
    dataPath: csv, idColumn: 'participantId', outcome: 'y', layout: 'wide', groupColumns: [], covariates: [], pairedColumns: [],
    gate: { minSubjects: 2 }, analyses: ['ttest', 'correlation'],
    ttest: { kind: 'one-sample', mu: 0 }, correlation: { columns: ['y', 'z'] },
  }, outputDir, exclusions: [] })
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400))
  const readTable = key => {
    const text = readFileSync(path.join(outputDir, 'runs', result.runId, 'tables', `${key}.csv`), 'utf8').replace(/^\uFEFF/, '').trim()
    const lines = text.split(/\r?\n/); const header = lines[0].split(',')
    return { header, rows: lines.slice(1).map(line => line.split(',')) }
  }
  const ttestTable = readTable('ttest'); const corrTable = readTable('correlation')
  const ttestN = Number(ttestTable.rows[0][ttestTable.header.indexOf('n')])
  const corrN = Number(corrTable.rows[0][corrTable.header.indexOf('n')])
  assert.equal(ttestN, 4, 'ttest 应纳入 001—004 共 4 人')
  assert.equal(corrN, 3, '相关应纳入 001—003 共 3 人')
  assert.equal(result.meta.nodes.ttest.result.analysisSet.n, 4)
  assert.equal(result.meta.nodes.correlation.result.analysisSet.n, 3)
  for (const key of ['ttest', 'correlation']) {
    const table = result.meta.tables.find(item => item.key === key)
    assert.equal(table.analysisSet.subjects, key === 'ttest' ? 4 : 3, `${key} 表的 analysisSet 必须是节点实际人数`)
    assert.deepEqual(table.analysisSet.columns, key === 'ttest' ? ['participantId', 'y'] : ['participantId', 'y', 'z'])
  }
})

test('FIX-05 直调引擎也加载自带统计后端；缺后端时明确 blocked', () => {
  const healthy = spawnSync(PYTHON, ['-c', `import sys; sys.path.insert(0, r'D:/dsh-plugins/analysis-run/vendor/site-packages'); import statsmodels; print(statsmodels.__version__)`], { encoding: 'utf8' })
  assert.equal(healthy.status, 0, healthy.stderr)
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-fix-a5-'))
  assert.ok(readFileSync(ENGINE, 'utf8').includes('vendor/site-packages'), 'engine 必须自带 vendor 引导')

  // 把 engine.py 单独复制到没有 vendor 的目录：同一请求应返回 not_run，而不是 undefined 崩溃。
  const bare = path.join(root, 'bare'); mkdirSync(bare, { recursive: true })
  copyFileSync(ENGINE, path.join(bare, 'engine.py'))
  const csv = path.join(root, 'data.csv')
  writeFileSync(csv, ['id,y', '1,1', '2,2', '3,3', '4,5', '5,6'].join('\n') + '\n')
  const output = path.join(root, 'out')
  const result = spawnSync(PYTHON, ['-X', 'utf8', path.join(bare, 'engine.py'), '--request-json', JSON.stringify({
    action: 'run', study: { id: 'bare', name: 'bare' }, plan: {
      dataPath: csv, idColumn: 'id', outcome: 'y', layout: 'wide', groupColumns: [], covariates: [], pairedColumns: [],
      gate: { minSubjects: 2 }, analyses: ['regression'],
    }, outputDir: output, exclusions: [],
  })], { encoding: 'utf8' })
  const marker = String(result.stdout).lastIndexOf('===JSON===')
  const payload = JSON.parse(String(result.stdout).slice(marker + 10))
  assert.equal(payload.ok, true, String(result.stderr).slice(-300))
  assert.equal(payload.meta.nodes.regression.status, 'not_run')
  assert.match(payload.meta.nodes.regression.reason, /环境待准备/)
})

test('FIX-06 create:true 真正创建研究；已有文件不覆盖', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-fix-a6-'))
  const ws = path.join(root, 'ws'); mkdirSync(ws, { recursive: true })
  const studyPath = path.join(ws, 'study.json')
  writeFileSync(studyPath, JSON.stringify({ schemaVersion: 1, studyId: 'existing', name: '已有研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))
  const host = makeHost({ workspaces: [{ id: 'w1', path: ws }], sessions: { s1: ws }, cwd: ws })
  ;(await loadPlugin('D:/dsh-plugins/study-ops')).apply(host.ctx, {})
  const handler = host.routes.get('/api/study-ops')
  const connect = (target) => request(handler, {
    method: 'POST', path: '/api/study-ops',
    headers: { 'x-study-ops': '1', 'content-type': 'application/json', ...pageHeaders('page-fix-a6') },
    body: { action: 'studyCreate', payload: { studyPath: target } },
  })
  const createdPath = path.join(ws, 'new-study.json')
  const created = await connect(createdPath)
  assert.equal(created.status, 200, JSON.stringify(created.json).slice(0, 500))
  const written = JSON.parse(readFileSync(createdPath, 'utf8'))
  assert.equal(written.schemaVersion, 1)
  assert.ok(written.studyId)
  assert.equal(created.json.data.binding.studyId, written.studyId)

  const before = readFileSync(studyPath)
  const conflict = await connect(studyPath)
  assert.equal(conflict.status, 409)
  assert.match(JSON.stringify(conflict.json), /已有研究定义|冲突|conflict|study/)
  assert.deepEqual(readFileSync(studyPath), before, '已有文件必须字节不变')
})

test('FIX-03 完整缓存：任一必需产物/代码被篡改、缺失或越界都不复用', () => {
  const script = `
import hashlib, json, os, sys, tempfile, importlib.util
from pathlib import Path
root = Path(tempfile.mkdtemp(prefix='rc-fix-a3-'))
(root/'tables').mkdir(); (root/'code').mkdir()
files = {'input.csv':'participantId,y\\n1,1\\n', 'plan.json':'{}', 'study.json':'{}', 'exclusions.json':'[]',
         'environment.json':'{}', 'model.json':'{}', 'report.md':'# report', 'tables/t.csv':'a,b\\n1,2\\n',
         'code/engine.py':'# code'}
for name, text in files.items(): (root/name).write_text(text, encoding='utf-8')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
def meta():
    return {'source': {'sha256': sha(root/'input.csv')},
            'artifactHashes': {name: sha(root/name) for name in files},
            'tables': [{'path':'tables/t.csv','sha256':sha(root/'tables/t.csv')}]}
spec = importlib.util.spec_from_file_location('engine', r'D:/dsh-plugins/analysis-run/engine.py')
engine = importlib.util.module_from_spec(spec); spec.loader.exec_module(engine)
results = {'baseline': engine.cache_artifacts_ok(root, meta())}
for target in ['input.csv','model.json','report.md','tables/t.csv','plan.json','study.json','exclusions.json','environment.json','code/engine.py']:
    m = meta(); (root/target).write_text('tampered', encoding='utf-8')
    results[target] = engine.cache_artifacts_ok(root, m)
    (root/target).write_text(files[target], encoding='utf-8')
m = meta(); del m['artifactHashes']['model.json']; results['missing_hash'] = engine.cache_artifacts_ok(root, m)
outside = root.parent / 'outside-artifact.txt'; outside.write_text('outside', encoding='utf-8')
m = meta(); m['artifactHashes']['../outside-artifact.txt'] = hashlib.sha256(outside.read_bytes()).hexdigest()
results['traversal'] = engine.cache_artifacts_ok(root, m)
results['legacy_no_hashes'] = engine.cache_artifacts_ok(root, {'source': {'sha256': sha(root/'input.csv')}, 'tables': []})
print(json.dumps(results))
`
  const result = spawnSync(PYTHON, ['-c', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr.slice(-800))
  const verdicts = JSON.parse(result.stdout.trim().split('\n').pop())
  assert.equal(verdicts.baseline, true, '完整缓存必须可复用')
  for (const target of ['input.csv','model.json','report.md','tables/t.csv','plan.json','study.json','exclusions.json','environment.json','code/engine.py']) {
    assert.equal(verdicts[target], false, `${target} 被篡改后不得复用`)
  }
  assert.equal(verdicts.missing_hash, false, '缺必需 artifact hash 不得复用')
  assert.equal(verdicts.traversal, false, '越界 artifact 路径必须拒绝')
  assert.equal(verdicts.legacy_no_hashes, false, '没有 artifactHashes 的旧 run 不得当作可信缓存')
})

test('FIX-03 集成：篡改 report 后同请求不复用，forceRecompute 产生新 run', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-fix-a3-run-'))
  const csv = path.join(root, 'data.csv')
  writeFileSync(csv, ['id,y', '1,1', '2,2', '3,3'].join('\n') + '\n')
  const outputDir = path.join(root, 'out'); mkdirSync(outputDir, { recursive: true })
  const run = () => engineRun({ action: 'run', study: { id: 'fix-a3', name: 'fix-a3' }, plan: {
    dataPath: csv, idColumn: 'id', outcome: 'y', layout: 'wide', groupColumns: [], covariates: [], pairedColumns: [],
    gate: { minSubjects: 2 }, analyses: ['descriptives'],
  }, outputDir, exclusions: [] })
  const first = run()
  assert.equal(first.ok, true)
  assert.equal(run().reused, true, '完整缓存应复用')
  writeFileSync(path.join(first.runDir, 'report.md'), '# tampered', 'utf8')
  const second = run()
  assert.equal(second.ok, true)
  assert.equal(second.reused, undefined, 'report 损坏不得返回 reused')
  assert.notEqual(second.runId, first.runId)
})