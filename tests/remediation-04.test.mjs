/**
 * 04 阶段回归：重复作答裁决、量表数值分数进入核心分析（F01/F02/F05 的契约部分）。
 * 全部使用合成研究；不读真实量表文件。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'
import { openAnalysis } from '../analysis.mjs'

function makeProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-r04-'))
  const definition = {
    schemaVersion: 1, studyId: 'r04-study', name: '04 合成研究', dataRoot: './data',
    participantId: { pattern: '^P-\\d{3}$' }, visits: [{ id: 'T0', label: '基线', order: 0 }],
    tasks: [{ id: 'ctdas', label: 'CT-DAS', visits: ['T0'], required: true, source: { type: 'scale', scaleId: 'CT_DAS', waveId: 'T0' } }],
    followups: [], plugins: {},
  }
  const studyPath = path.join(root, 'study.json')
  writeFileSync(studyPath, JSON.stringify(definition, null, 2))
  const dataRoot = path.join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const study = { id: definition.studyId, name: definition.name, path: studyPath, dataRoot, baseDir: root, plugin: {}, visits: definition.visits, tasks: definition.tasks, followups: [], revision: 'rev-1' }
  const data = openResearchData({ study, instanceId: 'inst-r04-0001' })
  const flow = openFlow({ data, study })
  return { study, data, flow }
}

function scoresDoc(rows) {
  return { schemaVersion: 1, plugin: 'scale-desk', studyId: 'r04-study', rows }
}

const scoreRow = (overrides = {}) => ({
  participantId: 'P-001', participantKey: 'pk-1', scaleId: 'CT_DAS', waveId: 'T0', subscaleKey: 'total',
  numericValue: 42.5, status: 'ok', reason: null, definitionHash: 'def-hash-v1', definitionVersion: 'v1',
  selectedSubmissionId: 'sub-A', submissionId: 'sub-A', answered: 4, missing: 0, itemCount: 4,
  sourceRevision: 'def:defhashv|sub:sub-A', recordedAt: '2026-11-10T00:00:00Z', ...overrides,
})

test('F02-A 两份 submission 都保留，核心标记冲突；裁决后选中一份', () => {
  const { data, flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.observations.publish({
    participantId: 'P-001', visitId: 'T0', taskId: 'ctdas', recordId: 'scale_ctdas_T0_P-001_subA',
    collectionState: 'complete', qualityState: 'valid', eventDate: null, datePrecision: 'unknown',
    sourceType: 'scale', sourceId: 'CT_DAS@T0', sourceRevision: 'def:h|sub:subA',
    evidence: { scaleId: 'CT_DAS', waveId: 'T0', submissionId: 'subA' },
  })
  flow.observations.publish({
    participantId: 'P-001', visitId: 'T0', taskId: 'ctdas', recordId: 'scale_ctdas_T0_P-001_subB',
    collectionState: 'complete', qualityState: 'valid', eventDate: null, datePrecision: 'unknown',
    sourceType: 'scale', sourceId: 'CT_DAS@T0', sourceRevision: 'def:h|sub:subB',
    evidence: { scaleId: 'CT_DAS', waveId: 'T0', submissionId: 'subB' },
  })
  const observations = data.read('observations').value.observations
  assert.equal(observations.length, 2, '两份原始记录都要保留')
  const slot = flow.observations.effective({ participantKey: observations[0].participantKey, visitId: 'T0', taskId: 'ctdas' })
  assert.equal(slot.state, 'conflict')
  assert.equal(slot.observations.length, 2)

  flow.observations.adjudicate({ participantKey: observations[0].participantKey, visitId: 'T0', taskId: 'ctdas', observationId: observations[0].observationId, reason: '以第一次提交为准' })
  const after = flow.observations.effective({ participantKey: observations[0].participantKey, visitId: 'T0', taskId: 'ctdas' })
  assert.equal(after.state, 'complete')
  assert.equal(after.effective.evidence.submissionId, 'subA')
  assert.equal(after.effective.adjudication.chosen, true)
})

test('F01-A source=core 分析可直接取量表分数数值与代次', () => {
  const { data, flow, study } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  const committed = data.commit('scores', scoresDoc([scoreRow()]), { owner: 'scale-desk', note: '合成分数' })
  const analysis = openAnalysis({ data, study })
  const result = analysis.dataset({ plan: { subset: 'enrolled', variables: [{ name: '总分', type: 'score', scaleId: 'CT_DAS', waveId: 'T0', subscaleKey: 'total' }] } })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].总分, 42.5, '必须直接拿到数值分数，不读平面 scores.csv')
  assert.equal(result.stats.missing.总分, 0)
  assert.equal(result.manifest.datasets.scores.revision, committed.revision)
  assert.equal(result.manifest.datasets.scores.contentHash, committed.contentHash)
})

test('F01-B 未裁决/不可计分给出缺失与原因，不伪 0', () => {
  const { data, flow, study } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.participants.register({ participantId: 'P-002', status: 'enrolled' })
  data.commit('scores', scoresDoc([
    scoreRow(),
    scoreRow({ participantId: 'P-002', participantKey: 'pk-2', numericValue: null, status: 'duplicate', reason: '多份提交未裁决或未被选中', selectedSubmissionId: null }),
  ]), { owner: 'scale-desk' })
  const analysis = openAnalysis({ data, study })
  const result = analysis.dataset({ plan: { subset: 'enrolled', variables: [{ name: '总分', type: 'score', scaleId: 'CT_DAS', waveId: 'T0' }] } })
  assert.equal(result.rows.length, 2)
  const p2 = result.rows[1]
  assert.equal(p2.总分, '', '未裁决必须是缺失')
  assert.equal(result.stats.missing.总分, 1)
  assert.equal(result.stats.missingReason.总分, '多份提交未裁决或未被选中')
})

test('F05-A 分数代次变化会改变分析 hash，历史输入不受影响', () => {
  const { data, flow, study } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  data.commit('scores', scoresDoc([scoreRow()]), { owner: 'scale-desk' })
  const analysis = openAnalysis({ data, study })
  const first = analysis.dataset({ plan: { subset: 'enrolled', variables: [{ name: '总分', type: 'score', scaleId: 'CT_DAS', waveId: 'T0' }] } })
  data.commit('scores', scoresDoc([scoreRow({ numericValue: 50, definitionHash: 'def-hash-v2' })]), { owner: 'scale-desk', note: '定义升级' })
  const second = analysis.dataset({ plan: { subset: 'enrolled', variables: [{ name: '总分', type: 'score', scaleId: 'CT_DAS', waveId: 'T0' }] } })
  assert.equal(first.rows[0].总分, 42.5)
  assert.equal(second.rows[0].总分, 50)
  assert.notEqual(first.hash, second.hash, '分数代次变化必须改变分析 hash')
  assert.equal(second.manifest.datasets.scores.revision, 2)
})
