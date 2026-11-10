/**
 * @local/research-core/analysis — 分析数据准备层（06 阶段，6A 基础）
 *
 * 只从**已提交代次**取数，不读旧 CSV 镜像、不读未提交的中间文件：
 *   - 参与者索引 + 人口学 + observation → 一人一行的分析表；
 *   - 每次汇合记录数据集版本/内容 hash，产出可复现的 manifest；
 *   - cardinality 违规（同一编号多行人口学、join 会扩行）直接中止并说明；
 *   - 未匹配编号、冲突格、缺失数列进统计，不用静默 join 掩盖。
 *
 * 列来源用 `plan.variables` 声明，避免"自动把所有人的所有列都塞进来"：
 *   { name, type: 'participant', field: 'status' | 'groups' }
 *   { name, type: 'demographics', column }
 *   { name, type: 'task', taskId, visitId, field: 'collection' | 'quality' | 'eventDate' }
 * 不写 variables 时给一组保守默认：status、groups、全部人口学列、全部任务格（collection）。
 */
import { createHash } from 'node:crypto'

export class AnalysisError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'AnalysisError'
    this.code = code
    this.details = details
  }
}

const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const asText = value => (value === null || value === undefined ? '' : String(value))

function readDataset(data, name) {
  const result = data.read(name)
  return {
    value: result.value,
    revision: result.revision || 0,
    contentHash: result.contentHash || null,
    state: result.health && result.health.state,
    error: result.health && result.health.error,
  }
}

/** 人口学取值：同时接受 {id, values:{...}} 与扁平 {id, 列: 值} 两种行。 */
function demographicValue(row, column) {
  if (!row) return undefined
  if (row.values && Object.hasOwn(row.values, column)) return row.values[column]
  return row[column]
}

const MISSING_STATES = new Set(['unconfigured', 'missing', 'empty'])
const BROKEN_STATES = new Set(['invalid', 'unreadable', 'conflict'])

/** 损坏来源立即阻断；必需来源未初始化时明确报"等待初始化"，不生成空表。 */
function requireSource(meta, name, { required }) {
  if (BROKEN_STATES.has(meta.state)) {
    throw new AnalysisError('source_unreadable', `数据集 ${name} 不可用（${meta.state}）${meta.error ? '：' + meta.error : ''}`, { dataset: name, state: meta.state })
  }
  if (MISSING_STATES.has(meta.state) && required) {
    throw new AnalysisError('source_unconfigured', `数据集 ${name} 尚未初始化（${meta.state}），等待数据录入后再分析`, { dataset: name, state: meta.state })
  }
}

export function openAnalysis({ data, study, owner = 'analysis-run' }) {
  function participantsDoc() {
    const result = readDataset(data, 'participants')
    return { participants: (result.value && result.value.participants) || [], meta: result }
  }
  function demographicsDoc() {
    const result = readDataset(data, 'demographics')
    const document = result.value || null
    return { document, rows: (document && document.rows) || [], columns: (document && document.columns) || [], meta: result }
  }
  function observationsDoc() {
    const result = readDataset(data, 'observations')
    return { observations: (result.value && result.value.observations) || [], meta: result }
  }
  function scoresDoc() {
    const result = readDataset(data, 'scores')
    return { rows: (result.value && result.value.rows) || [], meta: result }
  }

  function defaultVariables(demographics, tasks) {
    const variables = [
      { name: 'participantId', type: 'participant', field: 'participantId' },
      { name: 'status', type: 'participant', field: 'status' },
      { name: 'groups', type: 'participant', field: 'groups' },
    ]
    for (const column of demographics.columns) variables.push({ name: column.key, type: 'demographics', column: column.key })
    for (const task of tasks) {
      for (const visitId of task.visits || []) {
        variables.push({ name: `${task.id}@${visitId}`, type: 'task', taskId: task.id, visitId, field: 'collection' })
      }
    }
    return variables
  }

  /**
   * 汇合成一人一行的分析表。返回 { columns, rows, stats, manifest, hash }。
   * 同一编号在人口学里出现多行 → 中止（duplicate_record），不做静默取舍。
   */
  function dataset(input = {}) {
    const plan = input.plan || {}
    const subset = plan.subset === 'all' ? 'all' : 'enrolled'
    const participantsResult = participantsDoc()
    const demographics = demographicsDoc()
    const observationsResult = observationsDoc()
    const scoresResult = scoresDoc()
    requireSource(participantsResult.meta, 'participants', { required: true })
    requireSource(demographics.meta, 'demographics', { required: false })
    requireSource(observationsResult.meta, 'observations', { required: false })
    requireSource(scoresResult.meta, 'scores', { required: false })
    const scoreByKey = new Map()
    for (const row of scoresResult.rows) {
      const key = `${asText(row.participantId)}|${asText(row.scaleId)}|${asText(row.waveId)}|${asText(row.subscaleKey || 'total')}`
      if (!scoreByKey.has(key.trim())) scoreByKey.set(key.trim(), row)
    }
    const tasks = Array.isArray(study.tasks) ? study.tasks : []
    const variables = Array.isArray(plan.variables) && plan.variables.length ? plan.variables : defaultVariables(demographics, tasks)

    // 人口学按编号建索引；重复编号直接中止。
    const byId = new Map()
    const duplicates = []
    for (const row of demographics.rows) {
      const id = asText(row.participantId ?? row.id).trim()
      if (!id) continue
      if (byId.has(id)) { duplicates.push(id); continue }
      byId.set(id, row)
    }
    if (duplicates.length) {
      throw new AnalysisError('duplicate_record', `人口学里同一编号出现多行：${[...new Set(duplicates)].slice(0, 10).join('、')}`, { duplicates: [...new Set(duplicates)] })
    }

    const selected = participantsResult.participants.filter(row => subset === 'all' || row.status === 'enrolled')
    // 冲突格：同一参与者/访视/任务有多份未裁决的记录。
    const slotCounts = new Map()
    for (const row of observationsResult.observations) {
      const key = `${row.participantKey}|${row.visitId}|${row.taskId}`
      slotCounts.set(key, (slotCounts.get(key) || 0) + 1)
    }
    const effectiveBySlot = new Map()
    for (const row of observationsResult.observations) {
      const key = `${row.participantKey}|${row.visitId}|${row.taskId}`
      const current = effectiveBySlot.get(key)
      if (!current) { effectiveBySlot.set(key, row); continue }
      // 已有裁决时以 chosen 为准；否则保留第一条并把冲突数交给统计。
      if (row.adjudication && row.adjudication.chosen) effectiveBySlot.set(key, row)
      else if (!(current.adjudication && current.adjudication.chosen) && current.observationId > row.observationId) effectiveBySlot.set(key, row)
    }

    const rows = []
    const missing = Object.fromEntries(variables.map(variable => [variable.name, 0]))
    const missingReason = {}
    let conflicts = 0
    const unfinished = []
    for (const participant of selected) {
      const id = asText(participant.participantId)
      const record = {}
      for (const variable of variables) {
        let value
        if (variable.type === 'participant') {
          if (variable.field === 'groups') value = Object.entries(participant.groups || {}).map(([key, item]) => `${key}=${item}`).join('&')
          else value = participant[variable.field]
        } else if (variable.type === 'demographics') {
          value = demographicValue(byId.get(id), variable.column)
        } else if (variable.type === 'score') {
          const key = `${id}|${asText(variable.scaleId)}|${asText(variable.waveId)}|${asText(variable.subscaleKey || 'total')}`
          const score = scoreByKey.get(key.trim())
          if (!score) value = ''
          else if (score.numericValue === null || score.numericValue === undefined) { value = ''; missingReason[variable.name] = score.reason || score.status || '不可计分' }
          else value = Number(score.numericValue)
        } else if (variable.type === 'task') {
          const key = `${participant.participantKey}|${variable.visitId}|${variable.taskId}`
          const slot = effectiveBySlot.get(key)
          const count = slotCounts.get(key) || 0
          if (count > 1 && !(slot && slot.adjudication && slot.adjudication.chosen)) { value = 'conflict'; conflicts += 1 }
          else if (!slot) value = 'missing'
          else value = variable.field === 'quality' ? slot.qualityState : variable.field === 'eventDate' ? slot.eventDate || null : slot.collectionState
        }
        if (value === undefined || value === null || value === '') { missing[variable.name] += 1; value = '' }
        record[variable.name] = value
      }
      if (!byId.has(id)) unfinished.push(id)
      rows.push(record)
    }
    rows.sort((left, right) => asText(left.participantId).localeCompare(asText(right.participantId), 'en'))
    if (rows.length !== selected.length) throw new AnalysisError('invalid', '分析表行数与参与者数不一致')

    const columns = variables.map(variable => variable.name)
    const datasets = {
      participants: { revision: participantsResult.meta.revision, contentHash: participantsResult.meta.contentHash, state: participantsResult.meta.state },
      demographics: { revision: demographics.meta.revision, contentHash: demographics.meta.contentHash, state: demographics.meta.state },
      observations: { revision: observationsResult.meta.revision, contentHash: observationsResult.meta.contentHash, state: observationsResult.meta.state },
      scores: { revision: scoresResult.meta.revision, contentHash: scoresResult.meta.contentHash, state: scoresResult.meta.state },
    }
    const stats = {
      subset,
      participants: participantsResult.participants.length,
      rows: rows.length,
      columns: columns.length,
      conflicts,
      withoutDemographics: unfinished.length,
      missing,
      missingReason,
    }
    const manifest = {
      schemaVersion: 1,
      engine: 'research-core/analysis',
      generatedAt: new Date().toISOString(),
      studyRevision: study.revision || null,
      plan: { subset, variables },
      datasets,
      stats,
    }
    return { columns, rows, stats, manifest, hash: sha({ columns, rows, datasets }) }
  }

  return { dataset }
}
