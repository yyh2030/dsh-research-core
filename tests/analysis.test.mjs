/**
 * 06 分析数据准备层：一人一行、cardinality 校验、未匹配与缺失统计、可复现 hash。
 * 全部用合成研究，不读任何真实数据。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'
import { openAnalysis, AnalysisError } from '../analysis.mjs'

function makeProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-analysis-'))
  const definition = {
    schemaVersion: 1, studyId: 'analysis-study', name: '分析合成研究', dataRoot: './data',
    participantId: {}, visits: [{ id: 'T0', label: '基线', order: 0 }],
    tasks: [{ id: 'demo', label: '人口学', visits: ['T0'], required: true }, { id: 'stq', label: '状态问卷', visits: ['T0'], required: true }],
    followups: [], plugins: {},
  }
  const studyPath = path.join(root, 'study.json')
  writeFileSync(studyPath, JSON.stringify(definition, null, 2))
  const dataRoot = path.join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const study = { id: definition.studyId, name: definition.name, path: studyPath, dataRoot, baseDir: root, plugin: {}, visits: definition.visits, tasks: definition.tasks, followups: [], revision: 'rev-1' }
  const data = openResearchData({ study, instanceId: 'inst-analysis-0001' })
  const flow = openFlow({ data, study })
  return { study, data, flow }
}

const demographics = rows => ({
  schemaVersion: 2, studyId: 'analysis-study', name: '人口学',
  columns: [{ key: 'sex', label: '性别', kind: 'text' }, { key: 'age', label: '年龄', kind: 'number' }],
  rows: rows.map(([id, sex, age]) => ({ id, values: { sex, age } })),
})

test('汇合成一人一行：缺失、冲突、未匹配与确定性 hash', () => {
  const { study, data, flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled', groups: { condition: 'A' } })
  flow.participants.register({ participantId: 'P-002', status: 'enrolled', groups: { condition: 'B' } })
  flow.participants.register({ participantId: 'P-003', status: 'registered' })
  flow.demographics.commit({ document: demographics([['P-001', 'F', '20'], ['P-002', 'M', '22']]) })
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'r1' })
  flow.observations.publish({ participantId: 'P-002', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-02', recordId: 'r2' })
  flow.observations.publish({ participantId: 'P-002', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-03', recordId: 'r3' })

  const analysis = openAnalysis({ data, study })
  const built = analysis.dataset()
  assert.equal(built.stats.rows, 2, '只算已入组')
  assert.deepEqual(built.columns, ['participantId', 'status', 'groups', 'sex', 'age', 'demo@T0', 'stq@T0'])
  const p1 = built.rows.find(row => row.participantId === 'P-001')
  const p2 = built.rows.find(row => row.participantId === 'P-002')
  assert.equal(p1.sex, 'F')
  assert.equal(p1['demo@T0'], 'missing')
  assert.equal(p1['stq@T0'], 'complete')
  assert.equal(p2['stq@T0'], 'conflict', '未裁决的多份作答标成 conflict')
  assert.equal(built.stats.conflicts, 1)
  // 同输入两次汇合 hash 一致。
  assert.equal(openAnalysis({ data, study }).dataset().hash, built.hash)
  // 任务格缺席用状态字符串表达（'missing'），不算空值；空值统计只针对真正的空单元格。
  assert.equal(built.stats.missing['demo@T0'], 0)
  // 没有人口学的已入组编号：人口学列为空值，计入 missing 与 withoutDemographics。
  flow.participants.register({ participantId: 'P-004', status: 'enrolled' })
  const withGap = openAnalysis({ data, study }).dataset()
  assert.equal(withGap.stats.missing.sex, 1)
  assert.equal(withGap.stats.withoutDemographics, 1)
  // 参与者变化后 hash 变化。
  flow.participants.setStatus({ participantId: 'P-003', status: 'enrolled' })
  assert.notEqual(openAnalysis({ data, study }).dataset().hash, withGap.hash)
})

test('subset=all 包含未入组；缺人口学的已入组编号被计数而不是丢行', () => {
  const { study, data, flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.participants.register({ participantId: 'P-002', status: 'enrolled' })
  flow.participants.register({ participantId: 'P-003', status: 'registered' })
  flow.demographics.commit({ document: demographics([['P-001', 'F', '20']]) })

  const analysis = openAnalysis({ data, study })
  const enrolledOnly = analysis.dataset()
  assert.equal(enrolledOnly.stats.rows, 2)
  assert.equal(enrolledOnly.stats.withoutDemographics, 1, 'P-002 没有人口学行')
  const all = analysis.dataset({ plan: { subset: 'all' } })
  assert.equal(all.stats.rows, 3)
})

test('人口学里同一编号多行时中止该合并，不静默取舍', () => {
  const { study, data } = makeProject()
  data.commit('demographics', demographics([['P-001', 'F', '20'], ['P-001', 'M', '21']]), { owner: 'test' })
  const analysis = openAnalysis({ data, study })
  assert.throws(() => analysis.dataset(), error => error instanceof AnalysisError && error.code === 'duplicate_record')
})
