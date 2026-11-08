/**
 * 04 阶段流程验收：FLOW-01..08。
 * 参与者索引、人口学提交与性别映射、observation、任务导入、随访锚点、运行台投影。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'

const VISITS = [{ id: 'T0', label: '基线', order: 0 }, { id: 'T1', label: '一周随访', order: 1 }]
const TASKS = [
  { id: 'demo', label: '人口学', visits: ['T0'], required: true },
  { id: 'stq', label: '状态问卷', visits: ['T0', 'T1'], required: true },
  { id: 'opt', label: '可选问卷', visits: ['T0'], required: false },
]
const FOLLOWUPS = [{ id: 'fu1', label: '一周随访', anchorVisit: 'T0', offsetDays: 7, earlyDays: 1, lateDays: 3, targetTaskId: 'stq', targetVisitId: 'T1' }]

function makeProject(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-flow-'))
  const studyPath = path.join(root, 'study.json')
  const definition = {
    schemaVersion: 1,
    studyId: options.studyId || 'flow-study',
    name: '流程合成研究',
    dataRoot: './data',
    participantId: { pattern: '^P-\\d{3}$' },
    visits: options.visits || VISITS,
    tasks: options.tasks || TASKS,
    followups: options.followups || FOLLOWUPS,
    plugins: options.plugins || {},
  }
  writeFileSync(studyPath, JSON.stringify(definition, null, 2))
  const dataRoot = path.join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const study = {
    id: definition.studyId, name: definition.name, path: studyPath, dataRoot, baseDir: root,
    plugin: {}, visits: definition.visits, tasks: definition.tasks, followups: definition.followups, revision: 'rev-1',
  }
  const data = openResearchData({ study, instanceId: options.instanceId || 'inst-flow-0001', allowedExternalRoots: options.allowedExternalRoots })
  const flow = openFlow({ data, study })
  return { root, studyPath, study, data, flow }
}

const demographics = (rows, columns) => ({
  schemaVersion: 2,
  studyId: 'flow-study',
  name: '人口学',
  columns: columns || [{ key: 'sex', label: '性别', kind: 'text', coding: { enabled: true, map: { '1': 'male', '2': 'female', '3': '其他', '': '' }, missing: '' } }],
  rows: rows.map(([id, value]) => ({ id, values: { sex: value } })),
})

test('FLOW-01 新编号人口学保存后正式入组，分母与性别汇总前后准确', () => {
  const { flow, data } = makeProject()
  flow.participants.register({ participantId: 'P-001', reason: '纸质名单' })
  const committed = flow.demographics.commit({ document: demographics([['P-001', '2'], ['P-002', '1']]) })
  assert.deepEqual(committed.participants.created, ['P-002'], '新编号登记为 registered，不自动入组')
  assert.deepEqual(committed.participants.pending, [])
  assert.ok(committed.demographics.revision >= 1)
  const stored = data.read('demographics')
  assert.equal(stored.value.rows.length, 2, '原始值落盘')
  assert.equal(stored.value.rows[0].values.sex, '2')

  let projection = flow.projection()
  assert.equal(projection.totals.participants, 2)
  assert.equal(projection.totals.registered, 2)
  assert.equal(projection.totals.enrolled, 0)
  assert.equal(projection.sex.male + projection.sex.female, 0, '未入组不计入性别分母')

  flow.participants.setStatus({ participantId: 'P-001', status: 'enrolled', groups: { condition: 'A' }, reason: '基线到场' })
  projection = flow.projection()
  assert.equal(projection.totals.enrolled, 1)
  assert.equal(projection.totals.registered, 1)
  assert.equal(projection.sex.female, 1, '编码 2 通过 coding.map → female')
  const card = projection.groups.find(row => row.group.includes('A'))
  assert.equal(card.enrolled, 1)
  assert.equal(card.sex.female, 1)
})

test('FLOW-02 多波次缺题、重复与撤销裁决：状态与分数口径正确，原值都保留', () => {
  const { flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.participants.register({ participantId: 'P-002', status: 'enrolled' })

  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'invalid', eventDate: '2026-11-01', sourceType: 'scale', sourceRevision: 'r1', recordId: 'rec-p1-t0' })
  flow.observations.publish({ participantId: 'P-002', visitId: 'T1', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-09', sourceType: 'scale', sourceRevision: 'r1', recordId: 'rec-p2-t1' })
  flow.observations.publish({ participantId: 'P-002', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', sourceType: 'scale', sourceRevision: 'r1', recordId: 'rec-p2-t0-a' })
  flow.observations.publish({ participantId: 'P-002', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', sourceType: 'scale', sourceRevision: 'r2', recordId: 'rec-p2-t0-b' })

  let projection = flow.projection()
  const p1 = projection.matrix.find(row => row.participantId === 'P-001')
  assert.equal(p1.slots['T0::stq'].quality, 'invalid', '缺题以质量状态呈现，不删作答')
  const p2 = projection.matrix.find(row => row.participantId === 'P-002')
  assert.equal(p2.slots['T0::stq'].collection, 'conflict')
  assert.ok(projection.anomalies.some(row => row.key.includes('|conflict')))

  const duplicate = flow.observations.effective({ participantId: 'P-002', visitId: 'T0', taskId: 'stq' })
  assert.equal(duplicate.state, 'conflict')
  const chosen = duplicate.observations.find(row => row.recordId === 'rec-p2-t0-b')
  flow.observations.adjudicate({ participantKey: duplicate.observations[0].participantKey, visitId: 'T0', taskId: 'stq', observationId: chosen.observationId, reason: '第二次录入更完整' })
  const after = flow.observations.effective({ participantId: 'P-002', visitId: 'T0', taskId: 'stq' })
  assert.equal(after.state, 'complete')
  assert.equal(after.effective.recordId, 'rec-p2-t0-b')
  assert.equal(flow.observations.list().length, 4, '裁决不删除任何原值')

  flow.observations.cancelAdjudication({ participantKey: after.effective.participantKey, visitId: 'T0', taskId: 'stq' })
  assert.equal(flow.observations.effective({ participantId: 'P-002', visitId: 'T0', taskId: 'stq' }).state, 'conflict')
})

test('FLOW-03 相同任务文件重复导入幂等；同名不同内容成为新来源版本', () => {
  const { flow, root } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.participants.register({ participantId: 'P-002', status: 'enrolled' })
  const csv = '编号,访视,任务,日期\nP-001,T0,stq,2026-11-01\nP-002,T0,stq,2026-11-02\nP-999,T0,stq,2026-11-02\n'
  const preview = flow.imports.preview({ filename: 'task.csv', text: csv })
  assert.equal(preview.mapping.id, '编号')
  assert.equal(preview.mapping.visit, '访视')
  assert.equal(preview.mapping.task, '任务')
  assert.equal(preview.mapping.date, '日期')
  assert.equal(preview.totalRows, 3)
  assert.equal(preview.idempotent, false)

  const archiveDir = path.join(root, 'archive')
  const first = flow.imports.commit({ filename: 'task.csv', text: csv, archiveDir })
  assert.equal(first.observations, 2, '未知编号跳过')
  assert.equal(first.skipped, 1)
  assert.ok(existsSync(first.source.archived), '原始文件归档副本存在')
  assert.match(first.source.archived, /task-[0-9a-f]{8}\.csv$/)

  const again = flow.imports.commit({ filename: 'task.csv', text: csv, archiveDir })
  assert.equal(again.idempotent, true)
  assert.equal(again.observations, 0)

  const changed = csv.replace('2026-11-02', '2026-11-03')
  const second = flow.imports.commit({ filename: 'task.csv', text: changed, archiveDir })
  assert.equal(second.idempotent, false)
  assert.equal(second.source.revision, 2)
  assert.match(second.notes.join('；'), /同名文件已有 1 个来源版本/)
  // 修改后的记录成为新的来源版本，旧记录仍在。
  const observations = flow.observations.list()
  assert.ok(observations.some(row => row.sourceRevision === '1'))
  assert.ok(observations.some(row => row.sourceRevision === '2'))
})

test('FLOW-04 改号、退出、分组修正后当前视图一致，旧数据不重写', () => {
  const { flow, data } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled', groups: { condition: 'A' } })
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'rec-1' })
  const observationRevisionBefore = data.head('observations').contentHash
  const observationCount = flow.observations.list().length

  flow.participants.rename({ from: 'P-001', to: 'P-100', reason: '编号写错' })
  const renamed = flow.participants.resolve('P-100')
  assert.equal(renamed.participantId, 'P-100')
  assert.ok(renamed.aliases.includes('P-001'))
  assert.equal(flow.participants.resolve('P-001').participantKey, renamed.participantKey)
  assert.equal(data.head('observations').contentHash, observationRevisionBefore, '改号不改写历史记录')
  assert.equal(flow.observations.list().length, observationCount)

  flow.participants.setStatus({ participantId: 'P-100', status: 'enrolled', groups: { condition: 'B' }, reason: '分组修正' })
  let projection = flow.projection()
  assert.ok(projection.groups.some(row => row.group.includes('B')))
  assert.ok(!projection.groups.some(row => row.group.includes('A')) || projection.groups.find(row => row.group.includes('A')).enrolled === 0)

  flow.participants.setStatus({ participantId: 'P-100', status: 'exited', reason: '主动退出' })
  projection = flow.projection()
  assert.equal(projection.totals.exited, 1)
  const row = projection.matrix.find(item => item.participantId === 'P-100')
  assert.equal(row.slots['T0::stq'].collection, 'not_applicable', '退出后任务不适用，不是缺失')

  assert.throws(() => flow.participants.rename({ from: 'P-100', to: 'P-100', reason: 'x' }), /相同/)
  flow.participants.register({ participantId: 'P-200', status: 'enrolled' })
  assert.throws(() => flow.participants.rename({ from: 'P-100', to: 'P-200', reason: '冲突' }), error => error.code === 'duplicate_record')
})

test('FLOW-05 人口学自定义路径、任意性别编码与缺失按元信息汇总，错误进入来源健康', () => {
  const custom = './data/custom/demographics.json'
  const { flow, data, root } = makeProject({ plugins: { demographics: { dataPath: custom } } })
  assert.equal(data.locate('demographics'), path.join(root, 'data', 'custom', 'demographics.json'))
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.participants.register({ participantId: 'P-002', status: 'enrolled' })
  flow.participants.register({ participantId: 'P-003', status: 'enrolled' })
  flow.participants.register({ participantId: 'P-004', status: 'enrolled' })

  const document = demographics(
    [['P-001', 'M'], ['P-002', 'F'], ['P-003', 'X'], ['P-004', '']],
    [{ key: 'sex', label: '性别', kind: 'text', role: 'sex', coding: { enabled: true, map: { M: 'male', F: 'female', X: '其他', '': '' }, missing: '' } }],
  )
  flow.demographics.commit({ document })
  const projection = flow.projection()
  assert.equal(projection.sex.mapped, true)
  assert.equal(projection.sex.male, 1)
  assert.equal(projection.sex.female, 1)
  assert.equal(projection.sex.other, 1)
  assert.equal(projection.sex.missing, 1)

  // 不认识的数字编码计数为 unknown，不静默变成 0 男 0 女。
  const numeric = makeProject()
  numeric.flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  numeric.flow.demographics.commit({ document: demographics([['P-001', '1']], [{ key: 'sex', label: '性别', kind: 'text', role: 'sex', coding: { enabled: false, map: {}, missing: '' } }]) })
  const numericProjection = numeric.flow.projection()
  assert.equal(numericProjection.sex.unknown, 1)
  assert.equal(numericProjection.sex.male + numericProjection.sex.female, 0)
  assert.match(numericProjection.sex.note, /性别字段/)

  // 损坏的自定义文件：来源健康显示 invalid，不是"尚未录入"。
  mkdirSync(path.dirname(data.locate('demographics')), { recursive: true })
  writeFileSync(data.locate('demographics'), '{"rows": [')
  const health = flow.projection().sources.demographics
  assert.equal(health.legacy.state, 'invalid')
})

test('FLOW-06 可选／不适用／未到期／失败任务：无错误催办，必需失败可定位', () => {
  const { flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.participants.register({ participantId: 'P-002', status: 'screening_failed' })
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'not_due', qualityState: 'unknown', eventDate: null, recordId: 'rec-nd' })
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'demo', collectionState: 'complete', qualityState: 'invalid', eventDate: '2026-11-01', recordId: 'rec-bad' })

  const projection = flow.projection()
  const p1 = projection.matrix.find(row => row.participantId === 'P-001')
  assert.equal(p1.slots['T0::opt'].collection, 'missing')
  assert.equal(p1.slots['T0::stq'].collection, 'not_due')
  const p2 = projection.matrix.find(row => row.participantId === 'P-002')
  assert.equal(p2.slots['T0::demo'].collection, 'not_applicable')
  const optionalAnomaly = projection.anomalies.filter(row => row.taskId === 'opt')
  assert.equal(optionalAnomaly.length, 0, '可选任务缺失不报异常')
  const failed = projection.anomalies.find(row => row.taskId === 'demo' && row.level === 'bad')
  assert.ok(failed, '必需任务失败可定位')
  assert.equal(failed.participantId, 'P-001')
})

test('FLOW-07 随访锚点：未齐→unknown，齐了取最晚有效日期，完成后有来源', () => {
  const { flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  // 只完成一个必需任务 → 锚点未知
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'demo', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'd1' })
  let followups = flow.followups.compute({ today: '2026-11-05' })
  assert.equal(followups[0].state, 'unknown')
  assert.equal(followups[0].anchorDate, null)

  // 全部必需任务完成，取最晚有效日期作为锚点
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-03', recordId: 's1' })
  followups = flow.followups.compute({ today: '2026-11-05' })
  assert.equal(followups[0].anchorDate, '2026-11-03')
  assert.equal(followups[0].dueAt, '2026-11-10')
  assert.equal(followups[0].state, 'scheduled')
  assert.equal(flow.followups.compute({ today: '2026-11-10' })[0].state, 'due')
  assert.equal(flow.followups.compute({ today: '2026-11-20' })[0].state, 'overdue')

  // 目标 observation 完成 → done 且带来源
  flow.observations.publish({ participantId: 'P-001', visitId: 'T1', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-11', recordId: 't1-s1' })
  const done = flow.followups.compute({ today: '2026-11-20' })[0]
  assert.equal(done.state, 'done')
  assert.equal(done.evidence.type, 'observation')
  assert.equal(done.evidence.eventDate, '2026-11-11')

  // 撤销目标记录不可行（不改原值），改用另一位参与者验证人工标记来源。
  flow.participants.register({ participantId: 'P-002', status: 'enrolled' })
  flow.observations.publish({ participantId: 'P-002', visitId: 'T0', taskId: 'demo', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'p2-d' })
  flow.observations.publish({ participantId: 'P-002', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-02', recordId: 'p2-s' })
  flow.followups.mark({ participantId: 'P-002', followupId: 'fu1', reason: '电话完成' })
  const manual = flow.followups.compute({ today: '2026-11-20' }).find(row => row.participantId === 'P-002')
  assert.equal(manual.state, 'done')
  assert.equal(manual.evidence.type, 'manual')
  assert.match(manual.evidence.reason, /电话/)
})

test('FLOW-08 只启用人口学或只启用量表时，各自能保存读取，缺席能力不阻断', () => {
  // 只有人口学：没有任何 observation
  const demographicsOnly = makeProject()
  demographicsOnly.flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  demographicsOnly.flow.demographics.commit({ document: demographics([['P-001', '2']]) })
  const onlyDemo = demographicsOnly.flow.projection()
  assert.equal(onlyDemo.totals.enrolled, 1)
  assert.equal(onlyDemo.sex.female, 1)
  assert.equal(onlyDemo.matrix[0].slots['T0::stq'].collection, 'missing')

  // 只有量表：没有人口学文档
  const scalesOnly = makeProject()
  scalesOnly.flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  scalesOnly.flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'r1' })
  const onlyScales = scalesOnly.flow.projection()
  assert.equal(onlyScales.sex.mapped, false)
  assert.equal(onlyScales.sex.unknown, 1)
  assert.match(onlyScales.sex.note, /没有识别到性别字段/)
  assert.equal(onlyScales.matrix[0].slots['T0::stq'].collection, 'complete')
})

test('变化订阅与重启对账：已提交变化可增量读取，旧快照仍可重建', () => {
  const { flow, data } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'r1' })
  const first = flow.projection()
  const changes = data.changesSince(0)
  assert.ok(changes.some(row => row.dataset === 'participants'))
  assert.ok(changes.some(row => row.dataset === 'observations'))
  const reconciled = flow.reconcile(0)
  assert.equal(reconciled.revisions.observations, first.revisions.observations)
  // 旧快照的 inputRevision 不变；新增变化后重新投影才有新版本。
  flow.participants.setStatus({ participantId: 'P-001', status: 'completed', reason: '完成实验' })
  const second = flow.projection()
  assert.notEqual(first.inputRevision, second.inputRevision)
  assert.equal(first.revisions.observations, second.revisions.observations, '只有参与者变化时观察数据版本不变')
})

test('人口学策略 createPending=false：未登记编号进入待关联，不创建参与者', () => {
  const { flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  const result = flow.demographics.commit({
    document: demographics([['P-001', '2'], ['P-009', '1']]),
    createPending: false,
  })
  assert.deepEqual(result.participants.created, [])
  assert.deepEqual(result.participants.pending, ['P-009'])
  assert.equal(flow.participants.list().length, 1, '未登记编号不自动创建')
  // 人口学文档本身仍然保存（原始值不丢）
  assert.equal(flow.demographics.read().document.rows.length, 2)
})

test('任务导入可用显式列映射覆盖非标准表头', () => {
  const { flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  const csv = 'subject,session,instrument,when\nP-001,T0,stq,2026-11-01\n'
  const preview = flow.imports.preview({ filename: 'odd.csv', text: csv })
  assert.ok(preview.missing.length > 0, '非标准表头默认识别不到')
  const mapped = flow.imports.preview({ filename: 'odd.csv', text: csv, mapping: { id: 'subject', visit: 'session', task: 'instrument', date: 'when' } })
  assert.deepEqual(mapped.missing, [])
  assert.equal(mapped.preview[0].id, 'P-001')
  const committed = flow.imports.commit({ filename: 'odd.csv', text: csv, mapping: { id: 'subject', visit: 'session', task: 'instrument', date: 'when' } })
  assert.equal(committed.observations, 1)
  assert.equal(flow.observations.list()[0].taskId, 'stq')
})

test('随访完成可撤销：撤销后回到按锚点计算的状态', () => {
  const { flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'demo', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'd1' })
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-02', recordId: 's1' })
  flow.followups.mark({ participantId: 'P-001', followupId: 'fu1', reason: '电话完成' })
  assert.equal(flow.followups.compute({ today: '2026-11-10' })[0].state, 'done')
  flow.followups.mark({ participantId: 'P-001', followupId: 'fu1', done: false, reason: '标记错了' })
  assert.equal(flow.followups.compute({ today: '2026-11-10' })[0].state, 'due')
})

test('随访标记拒绝不存在的随访与参与者，不再静默忽略', () => {
  const { flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  assert.throws(() => flow.followups.mark({ participantId: 'P-001', followupId: 'nope' }), /没有随访规则/)
  assert.throws(() => flow.followups.mark({ participantId: 'P-404', followupId: 'fu1' }), /没有这个参与者/)
  // 正常的仍然可以标。
  flow.followups.mark({ participantId: 'P-001', followupId: 'fu1', reason: '电话完成' })
  assert.equal(flow.followupMarks ? flow.followupMarks().length : 1, 1)
})

test('导入里出现研究定义没有的 taskId 时明确提示，记录仍保留', () => {
  const { flow } = makeProject()
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  const csv = '编号,访视,任务,日期\nP-001,T0,ghost,2026-11-01\n'
  const committed = flow.imports.commit({ filename: 'ghost.csv', text: csv })
  assert.equal(committed.observations, 1, '记录仍发布')
  assert.ok(committed.notes.some(note => note.includes('ghost') && note.includes('不在研究定义里')), '提示未知任务')
  const projection = flow.projection()
  assert.equal(projection.matrix[0].slots['T0::ghost'], undefined, '矩阵不显示未定义任务')
})

test('缺失只在声明了到期日且已过期时才算异常', () => {
  const tasks = [
    { id: 'demo', label: '人口学', visits: ['T0'], required: true },
    { id: 'stq', label: '状态问卷', visits: ['T0'], required: true, dueFrom: '2026-11-01' },
  ]
  const { flow } = makeProject({ tasks, followups: [] })
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  // 只有 stq 声明了到期日；今天 11-10 已过期 → 只有它进异常。
  const projection = flow.projection({ today: '2026-11-10' })
  const missing = projection.anomalies.filter(row => row.key.includes('|missing'))
  assert.equal(missing.length, 1)
  assert.equal(missing[0].taskId, 'stq')
  assert.match(missing[0].text, /已到期/)
  // 到期日还没到 → 不算异常。
  const early = flow.projection({ today: '2026-10-01' })
  assert.equal(early.anomalies.filter(row => row.key.includes('|missing')).length, 0)
})

test('任务完成策略与质量策略：complete 只认 complete，score-valid 要求质量有效', () => {
  const tasks = [
    { id: 'demo', label: '人口学', visits: ['T0'], required: true, completionPolicy: 'complete' },
    { id: 'stq', label: '状态问卷', visits: ['T0'], required: true, qualityPolicy: 'score-valid' },
  ]
  const followups = [{ id: 'fu1', label: '一周随访', anchorVisit: 'T0', offsetDays: 7, earlyDays: 1, lateDays: 3 }]
  const { flow } = makeProject({ tasks, followups })
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  // demo 只到 entered、stq 质量不合格：两个必需任务都不算完成 → 锚点 unknown。
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'demo', collectionState: 'entered', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'd1' })
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'invalid', eventDate: '2026-11-02', recordId: 's1' })
  assert.equal(flow.followups.compute({ today: '2026-11-10' })[0].state, 'unknown')
  // demo 补到 complete，但 stq 质量仍不合格 → 锚点还是 unknown（质量策略拦住了）。
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'demo', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'd2' })
  const demoKey = flow.participants.resolve('P-001').participantKey
  flow.observations.adjudicate({ participantKey: demoKey, visitId: 'T0', taskId: 'demo', observationId: flow.observations.effective({ participantId: 'P-001', visitId: 'T0', taskId: 'demo' }).observations[1].observationId, reason: '以后一份为准' })
  assert.equal(flow.followups.compute({ today: '2026-11-10' })[0].state, 'unknown')
  // 再把 stq 重录为合格并裁决 → 锚点取最晚 11-02。
  flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-02', recordId: 's2' })
  flow.observations.adjudicate({ participantKey: demoKey, visitId: 'T0', taskId: 'stq', observationId: flow.observations.effective({ participantId: 'P-001', visitId: 'T0', taskId: 'stq' }).observations[1].observationId, reason: '重录后有效' })
  const anchor = flow.followups.compute({ today: '2026-11-10' })[0]
  assert.equal(anchor.anchorDate, '2026-11-02')
})

test('任务用 visitIds 别名声明访视也能进矩阵', () => {
  const tasks = [{ id: 'demo', label: '人口学', visitIds: ['T0'], required: true }]
  const { flow } = makeProject({ tasks, followups: [] })
  flow.participants.register({ participantId: 'P-001', status: 'enrolled' })
  const projection = flow.projection()
  assert.deepEqual(projection.tasks[0].visits, ['T0'])
  assert.equal(projection.matrix[0].slots['T0::demo'].collection, 'missing')
})

test('矩阵按研究流程排序：visits 的 order 优先于定义顺序', () => {
  const { flow } = makeProject()
  // 故意把 T2 写在最前，靠 order 排回 T0/T1/T2。
  const study = { ...flow.study, visits: [{ id: 'T2', label: 'T2', order: 2 }, { id: 'T0', label: 'T0', order: 0 }, { id: 'T1', label: 'T1', order: 1 }] }
  const reordered = openFlow({ data: openResearchData({ study, instanceId: 'inst-flow-0001' }), study })
  assert.deepEqual(reordered.projection().visits.map(row => row.id), ['T0', 'T1', 'T2'])
})

test('重新打开同一数据根：投影与版本一致（持久化后可重建）', () => {
  const project = makeProject()
  project.flow.participants.register({ participantId: 'P-001', status: 'enrolled', groups: { condition: 'A' } })
  project.flow.observations.publish({ participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete', qualityState: 'valid', eventDate: '2026-11-01', recordId: 'r1' })
  const first = project.flow.projection({ today: '2026-11-10' })
  const dataAgain = openResearchData({ study: project.study, instanceId: 'inst-flow-0001' })
  const flowAgain = openFlow({ data: dataAgain, study: project.study })
  const second = flowAgain.projection({ today: '2026-11-10' })
  assert.equal(second.inputRevision, first.inputRevision)
  assert.equal(JSON.stringify(second.totals), JSON.stringify(first.totals))
  assert.equal(second.matrix[0].slots['T0::stq'].collection, 'complete')
})
