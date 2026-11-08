/**
 * 04 端到端合成演练：参与者登记 → 人口学（含性别映射）→ 入组/分组 →
 * 问卷与任务 observation → 重复裁决 → 聚合 CSV 导入 → 随访锚点与完成 → 投影与对账。
 *
 * 全部使用合成研究，不接触真实数据；断言只看状态、计数与版本。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'

const VISITS = [{ id: 'T0', label: '基线', order: 0 }, { id: 'T1', label: '一周随访', order: 1 }]
const TASKS = [
  { id: 'demo', label: '人口学', visits: ['T0'], required: true },
  { id: 'stq', label: '状态问卷', visits: ['T0'], required: true },
  { id: 'garden', label: '花园量表', visits: ['T1'], required: true, source: { type: 'scale', scaleId: 'GARDEN', waveId: 'baseline' } },
  { id: 'opt', label: '可选问卷', visits: ['T0'], required: false },
]
const FOLLOWUPS = [{ id: 'fu1', label: '一周随访', anchorVisit: 'T0', offsetDays: 7, earlyDays: 1, lateDays: 3 }]

function makeProject(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-e2e-'))
  const definition = {
    schemaVersion: 1, studyId: 'e2e-study', name: '端到端合成研究', dataRoot: './data',
    participantId: {}, visits: VISITS, tasks: overrides.tasks || TASKS, followups: overrides.followups || FOLLOWUPS, plugins: {},
  }
  const studyPath = path.join(root, 'study.json')
  writeFileSync(studyPath, JSON.stringify(definition, null, 2))
  const dataRoot = path.join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const study = {
    id: definition.studyId, name: definition.name, path: studyPath, dataRoot, baseDir: root,
    plugin: {}, visits: definition.visits, tasks: definition.tasks, followups: definition.followups, revision: 'rev-1',
  }
  const data = openResearchData({ study, instanceId: 'inst-e2e-0001' })
  const flow = openFlow({ data, study })
  return { root, studyPath, study, data, flow }
}

const demographics = () => ({
  schemaVersion: 2, studyId: 'e2e-study', name: '人口学',
  columns: [{ key: 'sex', label: '性别', kind: 'text', role: 'sex', coding: { enabled: true, map: { F: 'female', M: 'male' }, missing: '' } }],
  rows: [{ id: 'P-001', values: { sex: 'F' } }, { id: 'P-002', values: { sex: 'M' } }],
})

test('04 端到端：登记 → 人口学 → 入组分组 → 问卷/任务 → 导入 → 随访 → 投影', () => {
  const { flow, data, study } = makeProject()

  // 1) 人口学保存：两人都只登记为 registered，不自动入组
  const committed = flow.demographics.commit({ document: demographics() })
  assert.deepEqual(committed.participants.created.sort(), ['P-001', 'P-002'])
  assert.equal(flow.projection().totals.registered, 2)
  assert.equal(flow.projection().totals.enrolled, 0)

  // 2) 正式入组并分组
  flow.participants.setStatus({ participantId: 'P-001', status: 'enrolled', groups: { condition: 'A' }, reason: '基线到场' })
  flow.participants.setStatus({ participantId: 'P-002', status: 'enrolled', groups: { condition: 'B' }, reason: '基线到场' })

  // 3) 基线任务：两人都完成人口学与状态问卷
  for (const id of ['P-001', 'P-002']) {
    flow.observations.publish({ participantId: id, visitId: 'T0', taskId: 'demo', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: `demo-${id}` })
    flow.observations.publish({ participantId: id, visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: id === 'P-001' ? '2026-11-02' : '2026-11-03', recordId: `stq-${id}` })
  }

  // 4) 一条重复作答：先冲突，再裁决
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-02', recordId: 'stq-P-001-dup' })
  const conflict = flow.observations.effective({ participantId: 'P-001', visitId: 'T0', taskId: 'stq' })
  assert.equal(conflict.state, 'conflict')
  flow.observations.adjudicate({ participantKey: conflict.observations[0].participantKey, visitId: 'T0', taskId: 'stq', observationId: conflict.observations[0].observationId, reason: '以第一次录入为准' })
  assert.equal(flow.observations.effective({ participantId: 'P-001', visitId: 'T0', taskId: 'stq' }).state, 'complete')

  // 5) 一周随访的量表数据通过聚合 CSV 导入（只导入 P-001）
  const csv = '编号,访视,任务,日期\nP-001,T1,garden,2026-11-09\n'
  const preview = flow.imports.preview({ filename: 'garden-week.csv', text: csv })
  assert.deepEqual(preview.missing, [])
  const imported = flow.imports.commit({ filename: 'garden-week.csv', text: csv })
  assert.equal(imported.observations, 1)

  // 6) 投影：人数、性别、分组卡片、矩阵、异常、随访
  const projection = flow.projection({ today: '2026-11-10' })
  assert.equal(projection.totals.participants, 2)
  assert.equal(projection.totals.enrolled, 2)
  assert.equal(projection.sex.female, 1)
  assert.equal(projection.sex.male, 1)
  assert.equal(projection.sex.mapped, true)
  assert.equal(projection.groups.length, 2)
  const cardA = projection.groups.find(row => row.group.includes('A'))
  assert.equal(cardA.enrolled, 1)
  assert.equal(cardA.sex.female, 1)
  const p1 = projection.matrix.find(row => row.participantId === 'P-001')
  const p2 = projection.matrix.find(row => row.participantId === 'P-002')
  assert.equal(p1.slots['T0::demo'].collection, 'complete')
  assert.equal(p1.slots['T1::garden'].collection, 'received', '导入的记录为已收到')
  assert.equal(p2.slots['T1::garden'].collection, 'missing')
  assert.ok(!projection.anomalies.some(row => row.participantId === 'P-002' && row.taskId === 'garden'), '没有到期窗口时，缺失只算未完成，不算异常')
  // 随访锚点取 T0 两个必需任务的最晚日期：P-001 = 11-02，P-002 = 11-03
  const fu1 = projection.followups.find(row => row.participantId === 'P-001' && row.followupId === 'fu1')
  assert.equal(fu1.anchorDate, '2026-11-02')
  assert.equal(fu1.dueAt, '2026-11-09')
  assert.equal(fu1.state, 'due')
  const fu2 = projection.followups.find(row => row.participantId === 'P-002' && row.followupId === 'fu1')
  assert.equal(fu2.anchorDate, '2026-11-03')
  assert.equal(fu2.dueAt, '2026-11-10')

  // 7) 人工标记随访完成，投影与对账同步
  flow.followups.mark({ participantId: 'P-002', followupId: 'fu1', reason: '电话完成' })
  const done = flow.projection({ today: '2026-11-10' })
  assert.equal(done.followupCounts.done, 1)
  assert.equal(done.followups.find(row => row.participantId === 'P-002').evidence.type, 'manual')
  const reconciled = flow.reconcile(0)
  assert.ok(reconciled.changes.some(row => row.dataset === 'followupMarks'))
  assert.equal(reconciled.revisions.observations, done.revisions.observations)
  assert.ok(data.read('observations').value.observations.length >= 6, '原值都保留')

  // 8) 新快照可重复重建：两次投影只差时间戳，数字与版本一致
  const again = flow.projection({ today: '2026-11-10' })
  assert.equal(again.inputRevision, done.inputRevision)
  assert.equal(JSON.stringify(again.totals), JSON.stringify(done.totals))
  void study
})

test('任务适用组：只对声明组出现，其他组显示不适用而不是缺失', () => {
  const tasks = [
    ...TASKS,
    { id: 'only-b', label: '仅 B 组任务', visits: ['T0'], required: true, groups: ['B'] },
  ]
  const { flow } = makeProject({ tasks, followups: [] })
  flow.participants.register({ participantId: 'P-001', status: 'enrolled', groups: { condition: 'A' } })
  flow.participants.register({ participantId: 'P-002', status: 'enrolled', groups: { condition: 'B' } })
  flow.observations.publish({ participantId: 'P-002', visitId: 'T0', taskId: 'only-b', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'b1' })
  const projection = flow.projection()
  const a = projection.matrix.find(row => row.participantId === 'P-001')
  const b = projection.matrix.find(row => row.participantId === 'P-002')
  assert.equal(a.slots['T0::only-b'].collection, 'not_applicable')
  assert.equal(b.slots['T0::only-b'].collection, 'complete')
  assert.equal(projection.anomalies.filter(row => row.taskId === 'only-b').length, 0, '不适用不产生异常')
})

test('未知施测日期不冒充导入日：锚点保持 unknown', () => {
  const { flow } = makeProject({ followups: FOLLOWUPS })
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'demo', collectionState: 'complete', qualityState: 'valid', eventDate: null, datePrecision: 'unknown', recordId: 'd1' })
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: null, datePrecision: 'unknown', recordId: 's1' })
  const row = flow.followups.compute({ today: '2026-11-10' })[0]
  assert.equal(row.anchorDate, null)
  assert.equal(row.dueAt, null)
  assert.equal(row.state, 'unknown')
})
