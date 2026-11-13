/**
 * @local/research-core/flow — 参与者索引、标准 observation、任务导入与运行台投影（04 阶段）
 *
 * 这一层把"录入 → 任务数据 → 进度与质量"接到 02 的数据核心上：
 *   - 参与者索引：编号始终是字符串，保留前导零/字母/Unicode；入组、分组、人口学分别建模；
 *     改号用稳定 participantKey + aliases，历史记录不重写；每次状态变更留时间与理由。
 *   - 人口学：原始值 + 编码映射 + 缺失码一起提交；性别角色按字段元信息（role / label / coding）识别，
 *     识别不了就是 unknown，不硬编码 1/2、不把错误显示成"0 男 0 女"。
 *   - observation：采集状态与质量状态分开；重复作答保留全部原值，裁决选择一份并留理由，可撤销。
 *   - 任务导入：CSV/TSV 预览 + 提交；同内容重复导入幂等，同名不同内容成为新来源版本并提示；
 *     原始文件只登记 hash，不修改。
 *   - 随访锚点：所有必需且适用任务唯一完成的最晚有效日期；完成可由目标 observation 或人工标记触发。
 *   - 投影：从已提交版本重建，带 inputRevision 与来源健康；订阅变化只是加速，重启按版本对账。
 *
 * 所有写入都经 `openResearchData` 的提交点，跨进程锁与不可变代次沿用 02 的实现。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseCsv } from './materials.mjs'

export const FLOW_SCHEMA_VERSION = 1
export const FLOW_VERSION = '4.2.0'

export const COLLECTION_STATES = ['not_due', 'missing', 'received', 'entered', 'complete', 'conflict']
export const QUALITY_STATES = ['unchecked', 'valid', 'invalid', 'unscorable', 'unknown']
export const PARTICIPANT_STATUSES = ['registered', 'enrolled', 'exited', 'completed', 'screening_failed']

const sha = (value, length = 64) => createHash('sha256').update(value).digest('hex').slice(0, length)
const nowIso = () => new Date().toISOString()
const asText = value => (value === null || value === undefined ? '' : String(value))
const normaliseDate = value => {
  const text = asText(value).trim()
  if (!text) return { date: null, precision: 'unknown' }
  const direct = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (direct) return { date: text, precision: 'day' }
  const partial = /^(\d{4})-(\d{2})$/.exec(text)
  if (partial) return { date: `${text}-15`, precision: 'month' }
  const year = /^(\d{4})$/.exec(text)
  if (year) return { date: `${text}-07-01`, precision: 'year' }
  const parsed = new Date(text)
  if (!Number.isNaN(parsed.getTime())) return { date: parsed.toISOString().slice(0, 10), precision: 'day' }
  return { date: null, precision: 'unknown' }
}
const addDays = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + Number(days || 0))
  return value.toISOString().slice(0, 10)
}
const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000)

export class FlowError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'FlowError'
    this.code = code
    this.details = details
    this.committed = details.committed === true
  }
}

/**
 * @param {object} options
 * @param {object} options.data   openResearchData 的实例（已绑定研究 + instanceId）
 * @param {object} options.study  研究上下文（id/name/visits/tasks/followups/plugin）
 */
export function openFlow(options = {}) {
  const { data, study } = options
  if (!data) throw new FlowError('invalid', 'openFlow 需要数据核心实例')
  if (!study || !study.id) throw new FlowError('invalid', 'openFlow 需要研究上下文')

  const owner = options.owner || 'flow'

  function readDoc(name, fallback) {
    const result = data.read(name)
    if (result.health.state === 'invalid' || result.health.state === 'conflict' || result.health.state === 'unreadable') {
      throw new FlowError('source_invalid', `数据集 ${name} 不可读（${result.health.state}）`, { health: result.health })
    }
    return result.value || fallback
  }

  function recentRevision(name) {
    return data.head(name)?.contentHash || 'empty'
  }

  /** 读-改-提交；并发改动时重试一次，仍冲突就明确报错。 */
  function mutate(name, fallback, mutateDoc, options2 = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expectedRevision = recentRevision(name)
      const doc = readDoc(name, fallback)
      const next = mutateDoc(doc) || doc
      try {
        const result = data.commit(name, next, { expectedRevision, owner, note: options2.note || '', mirrors: options2.mirrors })
        return { doc: next, result }
      } catch (error) {
        if (error && error.code === 'dataset_conflict' && attempt === 0) continue
        throw error
      }
    }
    throw new FlowError('dataset_conflict', `数据集 ${name} 连续冲突，请重试`)
  }

  const participantsEmpty = () => ({ schemaVersion: FLOW_SCHEMA_VERSION, participants: [] })
  const observationsEmpty = () => ({ schemaVersion: FLOW_SCHEMA_VERSION, observations: [] })
  const sourcesEmpty = () => ({ schemaVersion: FLOW_SCHEMA_VERSION, sources: [] })
  const marksEmpty = () => ({ schemaVersion: FLOW_SCHEMA_VERSION, marks: [] })

  /* ---------- 参与者索引 ---------- */

  function participantsDoc() { return readDoc('participants', participantsEmpty()) }

  function findParticipant(doc, id) {
    const text = asText(id).trim()
    if (!text) return null
    return doc.participants.find(row => row.participantId === text || (row.aliases || []).includes(text)) || null
  }

  function resolveParticipant(id) {
    return findParticipant(participantsDoc(), id)
  }

  function listParticipants() {
    return participantsDoc().participants.slice()
  }

  function newParticipantKey(participantId) {
    return `pk_${sha(`${study.id}|${participantId}|${nowIso()}|${Math.random()}`, 14)}`
  }

  function recordHistory(row, status, reason, at = nowIso()) {
    row.statusHistory = row.statusHistory || []
    row.statusHistory.push({ status, at, reason: String(reason || '') })
    row.status = status
    row.updatedAt = at
  }

  /**
   * 登记或关联一个编号。已存在（含别名）则返回现有记录，不重复累计。
   * status 默认 registered：人口学录入不会自动让某人"已入组"。
   */
  function registerParticipant(input = {}) {
    const participantId = asText(input.participantId).trim()
    if (!participantId) throw new FlowError('invalid', '参与者编号不能为空')
    if (/[\u0000-\u001F\u007F]/u.test(participantId)) throw new FlowError('invalid', '参与者编号不能包含控制字符')
    if (input.status && !PARTICIPANT_STATUSES.includes(input.status)) throw new FlowError('invalid', `未知状态：${input.status}`)
    return mutate('participants', participantsEmpty(), doc => {
      const existing = findParticipant(doc, participantId)
      if (existing) {
        if (input.reason || input.status) {
          if (input.status && input.status !== existing.status) recordHistory(existing, input.status, input.reason || '重复登记时的状态确认')
          else if (input.reason) recordHistory(existing, existing.status, input.reason)
        }
        return doc
      }
      const status = input.status || 'registered'
      const row = {
        participantKey: newParticipantKey(participantId),
        participantId,
        aliases: [],
        status,
        groups: { ...(input.groups || {}) },
        registeredAt: nowIso(),
        updatedAt: nowIso(),
        source: input.source || { type: 'manual' },
        statusHistory: [{ status, at: nowIso(), reason: String(input.reason || '首次登记') }],
      }
      doc.participants.push(row)
      return doc
    })
  }

  function setParticipantStatus(input = {}) {
    const id = asText(input.participantId || input.id).trim()
    if (!PARTICIPANT_STATUSES.includes(input.status)) throw new FlowError('invalid', '状态不合法')
    return mutate('participants', participantsEmpty(), doc => {
      const row = findParticipant(doc, id)
      if (!row) throw new FlowError('not_found', '没有这个参与者：' + id)
      if (input.groups && typeof input.groups === 'object') row.groups = { ...row.groups, ...input.groups }
      if (row.status !== input.status || input.reason) recordHistory(row, input.status, input.reason || '显式状态变更')
      return doc
    })
  }

  /** 改号：稳定 participantKey 不变，旧号进 aliases，历史记录不重写。 */
  function renameParticipant(input = {}) {
    const from = asText(input.from).trim()
    const to = asText(input.to).trim()
    if (!from || !to) throw new FlowError('invalid', '改号需要 from 与 to')
    if (from === to) throw new FlowError('invalid', '新旧编号相同')
    return mutate('participants', participantsEmpty(), doc => {
      const row = findParticipant(doc, from)
      if (!row) throw new FlowError('not_found', '没有这个参与者：' + from)
      const clash = findParticipant(doc, to)
      if (clash && clash.participantKey !== row.participantKey) throw new FlowError('duplicate_record', `编号 ${to} 已被另一参与者使用`)
      const oldPrimary = row.participantId
      const aliases = new Set([...(row.aliases || [])])
      if (oldPrimary !== to) aliases.add(oldPrimary)
      aliases.delete(to)
      row.aliases = [...aliases]
      row.participantId = to
      recordHistory(row, row.status, input.reason || `改号：${from} → ${to}`)
      return doc
    })
  }

  /* ---------- 人口学 ---------- */

  const SEX_LABEL = /^(male|m|man|男|男性)$/i
  const FEMALE_LABEL = /^(female|f|woman|女|女性)$/i
  const OTHER_LABEL = /^(other|nonbinary|non-binary|其他|其它|第三性别)$/i
  const MISSING_LABEL = /^(unknown|missing|na|n\/a|未填|缺失|未知|-)$/i

  /** 按字段元信息识别性别列：先看 role，再看 key/label；不猜数字编码。 */
  function sexColumn(document) {
    const columns = document?.columns || []
    return columns.find(column => /^sex$|^gender$/i.test(asText(column.role))) ||
      columns.find(column => /sex|gender|性别/i.test(asText(column.label)) || /sex|gender|性别/i.test(asText(column.key))) ||
      null
  }

  function classifySex(value, column) {
    const raw = asText(value).trim()
    if (!raw) return 'missing'
    const coding = column?.coding || {}
    if (coding.missing !== undefined && asText(coding.missing) === raw) return 'missing'
    const mapped = coding.map && Object.hasOwn(coding.map, raw) ? asText(coding.map[raw]).trim() : ''
    const candidates = [raw, mapped].filter(Boolean)
    for (const text of candidates) {
      if (SEX_LABEL.test(text)) return 'male'
      if (FEMALE_LABEL.test(text)) return 'female'
      if (OTHER_LABEL.test(text)) return 'other'
      if (MISSING_LABEL.test(text)) return 'missing'
    }
    return 'unknown'
  }

  function demographicsDocument() {
    const result = data.read('demographics')
    return { document: result.value, health: result.health, revision: result.revision }
  }

  function demographicsSexIndex(document) {
    const column = sexColumn(document)
    if (!column) return { column: null, byId: new Map(), note: '没有识别到性别字段（role 或 label 含 sex/gender/性别）' }
    const byId = new Map()
    for (const row of document?.rows || []) {
      const id = asText(row.participantId ?? row.id).trim()
      if (!id) continue
      byId.set(id, classifySex(row.values?.[column.key] ?? row[column.key], column))
    }
    return { column, byId, note: `性别字段：${column.label || column.key}` }
  }

  /**
   * 人口学提交：先完整校验文档与所有编号，再在**同一次研究事务**里提交
   * participants（仅新增登记）与 demographics。任何校验或版本冲突都发生在写入之前，
   * 因此检查失败不会留下"参与者已登记、人口学没提交"的半成品。
   */
  function commitDemographics(input = {}) {
    const document = input.document
    if (!document || typeof document !== 'object') throw new FlowError('invalid', '缺少人口学文档')
    if (typeof document.schemaVersion !== 'number') throw new FlowError('invalid', '人口学文档需要 schemaVersion')
    const rows = Array.isArray(document.rows) ? document.rows : []
    const createPending = input.createPending !== false

    // 第一步：只校验，不落盘。
    const seen = new Set()
    const ids = []
    for (const row of rows) {
      const id = asText(row && (row.participantId ?? row.id)).trim()
      if (!id) continue
      if (/[\u0000-\u001F\u007F]/u.test(id)) throw new FlowError('invalid', `参与者编号不能包含控制字符：${JSON.stringify(id)}`)
      if (seen.has(id)) throw new FlowError('duplicate_record', `人口学文档里同一编号出现多行：${id}`)
      seen.add(id)
      ids.push(id)
    }

    // 第二步：在内存里准备参与者候选，不逐人提交。
    const participants = participantsDoc()
    const created = []
    const pending = []
    for (const id of ids) {
      if (findParticipant(participants, id)) continue
      if (!createPending) { pending.push(id); continue }
      const at = nowIso()
      participants.participants.push({
        participantKey: newParticipantKey(id),
        participantId: id,
        aliases: [],
        status: 'registered',
        groups: {},
        registeredAt: at,
        updatedAt: at,
        source: { type: 'demographics', path: input.sourcePath || null },
        statusHistory: [{ status: 'registered', at, reason: '人口学录入时登记' }],
      })
      created.push(id)
    }

    // 第三步：一次复合提交；预期版本在写盘前核对，冲突时两个数据集都不变。
    const entries = []
    if (created.length) entries.push({ name: 'participants', value: participants, expectedRevision: recentRevision('participants'), note: '人口学关联' })
    entries.push({
      name: 'demographics', value: document,
      expectedRevision: input.expectedRevision ?? recentRevision('demographics'),
      mirrors: input.mirrors || [], note: '人口学原始值 + 编码映射',
    })
    const committed = data.commitMany(entries, { owner, timeoutMs: input.timeoutMs })
    const byName = Object.fromEntries(committed.datasets.map(row => [row.dataset, row]))
    return {
      participants: {
        revision: byName.participants?.revision ?? null,
        contentHash: byName.participants?.contentHash ?? null,
        created, pending,
        unchanged: Boolean(byName.participants?.unchanged),
      },
      demographics: {
        revision: byName.demographics?.revision ?? null,
        contentHash: byName.demographics?.contentHash ?? null,
        unchanged: Boolean(byName.demographics?.unchanged),
      },
      transactionId: committed.transactionId,
    }
  }

  /* ---------- observation ---------- */

  function observationsDoc() { return readDoc('observations', observationsEmpty()) }

  function effectiveFor(doc, { participantKey, participantId, visitId, taskId }) {
    const rows = doc.observations.filter(row => row.visitId === visitId && row.taskId === taskId &&
      (participantKey ? row.participantKey === participantKey : row.participantId === participantId))
    if (!rows.length) return { state: 'missing', observations: [] }
    const chosen = rows.find(row => row.adjudication && row.adjudication.chosen === true)
    if (chosen) return { state: 'complete', observations: rows, effective: chosen }
    if (rows.length === 1) return { state: 'complete', observations: rows, effective: rows[0] }
    return { state: 'conflict', observations: rows }
  }

  function publishObservation(input = {}) {
    const participantKey = asText(input.participantKey).trim()
    const participantId = asText(input.participantId).trim()
    const visitId = asText(input.visitId).trim()
    const taskId = asText(input.taskId).trim()
    if (!visitId || !taskId) throw new FlowError('invalid', 'observation 需要 visitId 与 taskId')
    if (!participantKey && !participantId) throw new FlowError('invalid', 'observation 需要参与者')
    const participant = participantKey ? participantsDoc().participants.find(row => row.participantKey === participantKey) : resolveParticipant(participantId)
    if (!participant) throw new FlowError('not_found', '参与者不在索引里：' + (participantId || participantKey))
    const collectionState = COLLECTION_STATES.includes(input.collectionState) ? input.collectionState : 'complete'
    const qualityState = QUALITY_STATES.includes(input.qualityState) ? input.qualityState : 'unchecked'
    const recordId = asText(input.recordId).trim() || `obs_${sha(`${participant.participantKey}|${visitId}|${taskId}|${input.sourceRevision || nowIso()}`, 16)}`
    return mutate('observations', observationsEmpty(), doc => {
      const existing = doc.observations.find(row => row.recordId === recordId)
      if (existing) {
        if (existing.sourceRevision && input.sourceRevision && existing.sourceRevision !== input.sourceRevision) {
          throw new FlowError('duplicate_record', `记录 ${recordId} 已存在且来源版本不同，请作为新记录提交`, { existing: existing.sourceRevision })
        }
        return doc
      }
      const duplicates = doc.observations.filter(row => row.participantKey === participant.participantKey && row.visitId === visitId && row.taskId === taskId && !row.adjudication)
      const row = {
        observationId: `os_${sha(recordId + Math.random(), 16)}`,
        recordId,
        participantKey: participant.participantKey,
        participantId: participant.participantId,
        visitId,
        taskId,
        collectionState: duplicates.length ? 'conflict' : collectionState,
        qualityState,
        eventDate: input.eventDate || null,
        datePrecision: input.datePrecision || 'unknown',
        sourceType: input.sourceType || 'manual',
        sourceId: input.sourceId || null,
        sourceRevision: input.sourceRevision || null,
        evidence: input.evidence || null,
        supersedes: input.supersedes || null,
        adjudication: null,
        recordedAt: nowIso(),
      }
      doc.observations.push(row)
      if (duplicates.length) for (const other of duplicates) other.collectionState = 'conflict'
      return doc
    })
  }

  function adjudicate(input = {}) {
    const { participantKey, visitId, taskId } = input
    const observationId = asText(input.observationId).trim()
    if (!participantKey || !visitId || !taskId) throw new FlowError('invalid', '裁决需要 participantKey / visitId / taskId')
    if (!asText(input.reason).trim()) throw new FlowError('invalid', '裁决需要理由')
    return mutate('observations', observationsEmpty(), doc => {
      const rows = doc.observations.filter(row => row.participantKey === participantKey && row.visitId === visitId && row.taskId === taskId)
      if (!rows.some(row => row.observationId === observationId)) throw new FlowError('not_found', '没有这份作答')
      // 裁决版本在文档级单调递增：撤销后重新裁决不会复用旧版本号，
      // 已发布的旧分数才能被分析层识别为"待重算"而不是继续有效。
      const version = Number(doc.adjudicationSeq || 0) + 1
      doc.adjudicationSeq = version
      for (const row of rows) {
        if (row.observationId === observationId) {
          row.adjudication = { chosen: true, reason: input.reason, at: nowIso(), version }
          row.collectionState = 'complete'
        } else {
          row.adjudication = { chosen: false, supersededBy: observationId, reason: input.reason, at: nowIso(), version }
          row.collectionState = 'conflict'
        }
      }
      return doc
    })
  }

  /** 撤销裁决：恢复冲突状态，不删除任何原值。 */
  function cancelAdjudication(input = {}) {
    const { participantKey, visitId, taskId } = input
    return mutate('observations', observationsEmpty(), doc => {
      const rows = doc.observations.filter(row => row.participantKey === participantKey && row.visitId === visitId && row.taskId === taskId)
      if (!rows.length) throw new FlowError('not_found', '这个槽位没有可撤销的裁决')
      doc.adjudicationSeq = Number(doc.adjudicationSeq || 0) + 1
      for (const row of rows) {
        row.adjudication = null
        row.collectionState = rows.length > 1 ? 'conflict' : row.collectionState
      }
      return doc
    })
  }

  /* ---------- 任务导入 ---------- */

  function splitTable(text, filename = '') {
    const clean = asText(text).replace(/^\uFEFF/, '')
    if (/\.tsv$/i.test(filename)) {
      return clean.split(/\r?\n/).map(line => line.split('\t')).filter(cells => cells.some(cell => cell.trim() !== ''))
    }
    return parseCsv(clean)
  }

  const COLUMN_HINTS = {
    id: /^(编号|被试编号|参与者|participant\s*id|participantid|subject\s*id|subject|id|code)$/i,
    visit: /^(访视|时点|visit|visit\s*id|session)$/i,
    task: /^(任务|task|task\s*id|问卷|scale)$/i,
    date: /^(日期|date|time|datetime|时间|施测日期)$/i,
    status: /^(状态|status|state)$/i,
    value: /^(值|value|score|得分|反馈|response|应答)$/i,
    unit: /^(单位|unit)$/i,
  }

  function detectMapping(headers, override = {}) {
    const mapping = { ...override }
    for (const header of headers) {
      const text = asText(header).trim()
      for (const [role, pattern] of Object.entries(COLUMN_HINTS)) {
        if (mapping[role]) continue
        if (pattern.test(text)) mapping[role] = header
      }
    }
    return mapping
  }

  function sourceFor(filename, hash) {
    const doc = readDoc('tasks', sourcesEmpty())
    return (doc.sources || []).find(row => row.sourceId === `${asText(filename)}#${hash}`) || null
  }

  function previewTaskImport(input = {}) {
    const rows = splitTable(input.text, input.filename)
    if (!rows.length) throw new FlowError('invalid', '文件是空的')
    const headers = rows[0].map(cell => asText(cell).trim())
    const mapping = detectMapping(headers, input.mapping || {})
    const missing = ['id', 'visit', 'task', 'date'].filter(role => !mapping[role])
    const hash = asText(input.sourceHash) || sha(asText(input.text))
    const index = header => headers.indexOf(mapping[header])
    const problems = []
    const preview = []
    for (const [offset, cells] of rows.slice(1, 11).entries()) {
      const record = {}
      for (const role of ['id', 'visit', 'task', 'date', 'status', 'value', 'unit']) {
        if (mapping[role]) record[role] = asText(cells[index(role)] ?? '').trim()
      }
      const date = normaliseDate(record.date)
      if (record.date && !date.date) problems.push({ row: offset + 2, text: `日期无法识别：${record.date}` })
      preview.push({ row: offset + 2, ...record, eventDate: date.date, datePrecision: date.precision })
    }
    const existing = sourceFor(input.filename, hash)
    const sameName = existing ? null : (readDoc('tasks', sourcesEmpty()).sources || []).filter(row => row.filename === input.filename)
    return {
      filename: asText(input.filename),
      headers,
      mapping,
      missing,
      problems,
      preview,
      totalRows: Math.max(0, rows.length - 1),
      sha256: hash,
      idempotent: Boolean(existing),
      newSourceRevision: sameName && sameName.length ? Math.max(...sameName.map(row => Number(row.revision) || 0)) + 1 : 1,
      sameFilenameOtherContent: (sameName || []).map(row => ({ revision: row.revision, sha256: row.sha256, importedAt: row.importedAt })),
    }
  }

  /**
   * 提交任务导入：原始文件只登记 hash（可选归档副本），解析结果发布为 observations。
   * 同一内容重复导入幂等；同名不同内容成为新来源版本并提示。
   */
  function commitTaskImport(input = {}) {
    const preview = previewTaskImport(input)
    if (preview.missing.length) throw new FlowError('invalid', `缺少必要的列：${preview.missing.join('、')}（可显式给出 mapping）`)
    if (preview.idempotent) {
      return { idempotent: true, source: sourceFor(input.filename, preview.sha256), observations: 0, notes: ['相同内容已导入过，未重复累计'] }
    }
    const rows = splitTable(input.text, input.filename).slice(1)
    const headers = splitTable(input.text, input.filename)[0].map(cell => asText(cell).trim())
    const index = header => headers.indexOf(preview.mapping[header])
    const revision = preview.newSourceRevision
    const sourceId = `${asText(input.filename)}#${preview.sha256}`
    let archived = null
    if (input.archiveDir) {
      const dir = path.resolve(input.archiveDir)
      mkdirSync(dir, { recursive: true })
      const target = path.join(dir, `${path.basename(asText(input.filename), path.extname(input.filename))}-${preview.sha256.slice(0, 8)}${path.extname(asText(input.filename))}`)
      if (!existsSync(target)) writeFileSync(target, input.sourcePath ? readFileSync(input.sourcePath) : input.text)
      archived = target
    }
    const notes = []
    if (preview.sameFilenameOtherContent.length) notes.push(`同名文件已有 ${preview.sameFilenameOtherContent.length} 个来源版本，本次为第 ${revision} 版（hash 不同，不是重复导入）`)
    // 文件里有研究定义没有的 taskId/visitId 时，记录仍保留，但矩阵不会显示——把它说出来，别让它悄悄消失。
    const knownTasks = new Set((Array.isArray(study.tasks) ? study.tasks : []).map(task => task && task.id))
    const knownVisits = new Set((Array.isArray(study.visits) ? study.visits : []).map(visit => visit && visit.id))
    const unknownTasks = new Set()
    const unknownVisits = new Set()
    let published = 0
    let skipped = 0
    for (const [offset, cells] of rows.entries()) {
      const id = asText(cells[index('id')] ?? '').trim()
      if (!id) continue
      const participant = resolveParticipant(id)
      if (!participant) { skipped += 1; continue }
      const visitId = asText(cells[index('visit')] ?? '').trim()
      const taskId = asText(cells[index('task')] ?? '').trim()
      if (!visitId || !taskId) { skipped += 1; continue }
      if (knownTasks.size && !knownTasks.has(taskId)) unknownTasks.add(taskId)
      if (knownVisits.size && !knownVisits.has(visitId)) unknownVisits.add(visitId)
      const date = normaliseDate(cells[index('date')])
      const recordId = `imp_${preview.sha256.slice(0, 10)}_${offset + 2}`
      publishObservation({
        participantKey: participant.participantKey,
        visitId,
        taskId,
        recordId,
        collectionState: 'received',
        qualityState: 'unchecked',
        eventDate: date.date,
        datePrecision: date.precision,
        sourceType: 'import',
        sourceId,
        sourceRevision: String(revision),
        evidence: { file: asText(input.filename), sha256: preview.sha256, row: offset + 2, archived },
      })
      published += 1
    }
    if (unknownTasks.size) notes.push(`以下 taskId 不在研究定义里（记录已保留，矩阵不会显示）：${[...unknownTasks].join('、')}`)
    if (unknownVisits.size) notes.push(`以下 visitId 不在研究定义里：${[...unknownVisits].join('、')}`)
    const result = mutate('tasks', sourcesEmpty(), doc => {
      doc.sources.push({
        sourceId, filename: asText(input.filename), sha256: preview.sha256, bytes: Buffer.byteLength(asText(input.text), 'utf8'),
        revision, rows: rows.length, published, skipped, mapping: preview.mapping,
        archived, importedAt: nowIso(),
      })
      return doc
    })
    return { idempotent: false, source: result.doc.sources.find(row => row.sourceId === sourceId), observations: published, skipped, notes }
  }

  /* ---------- 随访 ---------- */

  function followupMarks() { return readDoc('followupMarks', marksEmpty()) }

  function markFollowup(input = {}) {
    const participantId = asText(input.participantId).trim()
    const followupId = asText(input.followupId).trim()
    if (!participantId || !followupId) throw new FlowError('invalid', '随访完成需要 participantId 与 followupId')
    // 标在不存在的随访上会被投影静默忽略，等于"标了但没生效"；这里直接拒绝。
    const known = Array.isArray(study.followups) ? study.followups : []
    if (known.length && !known.some(row => row && row.id === followupId)) {
      throw new FlowError('not_found', `研究定义里没有随访规则：${followupId}`)
    }
    if (!resolveParticipant(participantId)) throw new FlowError('not_found', `没有这个参与者：${participantId}`)
    return mutate('followupMarks', marksEmpty(), doc => {
      doc.marks = (doc.marks || []).filter(row => !(row.participantId === participantId && row.followupId === followupId))
      doc.marks.push({ participantId, followupId, done: input.done !== false, at: nowIso(), reason: asText(input.reason || '人工标记') })
      return doc
    })
  }

  const COMPLETION_STATES = {
    received: ['received', 'entered', 'complete'],
    entered: ['entered', 'complete'],
    complete: ['complete'],
  }
  /** 任务声明的完成策略；缺省为 entered（保持旧研究的行为）。 */
  function taskCompletionPolicy(task) {
    return task && COMPLETION_STATES[task.completionPolicy] ? task.completionPolicy : 'entered'
  }
  function taskVisits(task) {
    if (!task) return []
    if (Array.isArray(task.visits)) return task.visits
    if (Array.isArray(task.visitIds)) return task.visitIds
    return []
  }
  /** 采集状态达标 + 声明了 qualityPolicy=score-valid 时质量必须有效。 */
  function taskComplete(task, observation) {
    if (!observation) return false
    if (!COMPLETION_STATES[taskCompletionPolicy(task)].includes(observation.collectionState)) return false
    if (task.qualityPolicy === 'score-valid' && observation.qualityState !== 'valid') return false
    return true
  }

  function computeFollowups(options2 = {}) {
    const today = options2.today || new Date().toISOString().slice(0, 10)
    const participants = participantsDoc().participants
    const observations = observationsDoc().observations
    const marks = followupMarks().marks || []
    const followups = Array.isArray(study.followups) ? study.followups : []
    const tasks = Array.isArray(study.tasks) ? study.tasks : []
    const rows = []
    for (const participant of participants) {
      for (const followup of followups) {
        const anchorVisit = followup.anchorVisit
        const required = tasks.filter(task => taskVisits(task).includes(anchorVisit) && task.required !== false)
        const dates = []
        let complete = required.length > 0
        for (const task of required) {
          const effective = effectiveFor({ observations }, { participantKey: participant.participantKey, visitId: anchorVisit, taskId: task.id })
          const observation = effective.effective
          if (!taskComplete(task, observation) || !observation.eventDate) { complete = false; continue }
          dates.push(observation.eventDate)
        }
        const anchorDate = complete && dates.length ? dates.slice().sort().at(-1) : null
        const due = anchorDate ? addDays(anchorDate, followup.offsetDays || 0) : null
        const early = due && Number.isFinite(followup.earlyDays) ? addDays(due, -followup.earlyDays) : due
        const late = due && Number.isFinite(followup.lateDays) ? addDays(due, followup.lateDays) : due
        const mark = marks.find(row => row.participantId === participant.participantId && row.followupId === followup.id)
        const targetTaskId = followup.targetTaskId || followup.taskId || null
        const targetVisitId = followup.targetVisitId || followup.visitId || followup.id
        let targetDone = null
        if (targetTaskId) {
          const targetTask = tasks.find(task => task.id === targetTaskId) || null
          const effective = effectiveFor({ observations }, { participantKey: participant.participantKey, visitId: targetVisitId, taskId: targetTaskId })
          if (targetTask ? taskComplete(targetTask, effective.effective) : (effective.effective && ['complete', 'entered', 'received'].includes(effective.effective.collectionState))) targetDone = effective.effective
        }
        let state
        let evidence = null
        if (targetDone) { state = 'done'; evidence = { type: 'observation', observationId: targetDone.observationId, eventDate: targetDone.eventDate } }
        else if (mark && mark.done) { state = 'done'; evidence = { type: 'manual', at: mark.at, reason: mark.reason } }
        else if (!anchorDate) state = 'unknown'
        else if (today > late) state = 'overdue'
        else if (today >= early) state = 'due'
        else state = 'scheduled'
        rows.push({
          participantId: participant.participantId, participantKey: participant.participantKey,
          followupId: followup.id, label: followup.label || followup.id,
          anchorVisit, anchorDate, dueAt: due, earlyFrom: early, lateUntil: late,
          daysFromDue: due ? daysBetween(due, today) : null, state, evidence,
        })
      }
    }
    return rows
  }

  /* ---------- 投影 ---------- */

  function taskApplicability(task, participant) {
    if (participant.status === 'exited' || participant.status === 'screening_failed') return false
    if (task.groups && Array.isArray(task.groups) && task.groups.length) {
      const values = Object.values(participant.groups || {})
      return task.groups.some(group => values.includes(group))
    }
    return true
  }

  function buildProjection(options2 = {}) {
    const today = options2.today || new Date().toISOString().slice(0, 10)
    const participants = participantsDoc().participants
    const observations = observationsDoc().observations
    const demographics = demographicsDocument()
    const sexIndex = demographicsSexIndex(demographics.document)
    const tasks = Array.isArray(study.tasks) ? study.tasks : []
    // 矩阵按研究流程排：有 order 用 order，没有就保持定义顺序（sort 在 V8 里是稳定的）。
    const visits = (Array.isArray(study.visits) ? study.visits.slice() : [])
      .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0))
    const followups = computeFollowups({ today })
    const totals = { participants: participants.length, registered: 0, enrolled: 0, exited: 0, completed: 0, screeningFailed: 0 }
    for (const row of participants) {
      if (row.status === 'registered') totals.registered += 1
      else if (row.status === 'enrolled') totals.enrolled += 1
      else if (row.status === 'exited') totals.exited += 1
      else if (row.status === 'completed') totals.completed += 1
      else if (row.status === 'screening_failed') totals.screeningFailed += 1
    }
    const emptySex = () => ({ male: 0, female: 0, other: 0, unknown: 0, missing: 0 })
    const sex = emptySex()
    const groupMap = new Map()
    const matrix = []
    const anomalies = []
    for (const participant of participants) {
      const category = sexIndex.byId.get(participant.participantId) || (participant.status === 'enrolled' ? 'unknown' : 'missing')
      const groupKey = Object.entries(participant.groups || {}).map(([key, value]) => `${key}=${value}`).join(' & ') || '未分组'
      if (!groupMap.has(groupKey)) groupMap.set(groupKey, { group: groupKey, enrolled: 0, sex: emptySex() })
      const card = groupMap.get(groupKey)
      if (participant.status === 'enrolled') {
        sex[category] = (sex[category] || 0) + 1
        card.enrolled += 1
        card.sex[category] = (card.sex[category] || 0) + 1
      }
      const slots = {}
      for (const visit of visits) {
        for (const task of tasks) {
          if (!taskVisits(task).includes(visit.id)) continue
          const key = `${visit.id}::${task.id}`
          if (!taskApplicability(task, participant)) { slots[key] = { collection: 'not_applicable', quality: 'unknown' }; continue }
          const effective = effectiveFor({ observations }, { participantKey: participant.participantKey, visitId: visit.id, taskId: task.id })
          if (effective.state === 'conflict') {
            slots[key] = { collection: 'conflict', quality: 'unknown', observations: effective.observations.map(row => row.observationId) }
            anomalies.push({ key: `${participant.participantId}|${visit.id}|${task.id}|conflict`, level: 'warn', participantId: participant.participantId, visitId: visit.id, taskId: task.id, text: '有一份以上的作答，尚未裁决' })
            continue
          }
          const observation = effective.effective
          if (!observation) {
            slots[key] = { collection: 'missing', quality: 'unknown' }
            // 只有声明了到期日、且已经过期，才把"没记录"算成异常；没有窗口时只是"未完成"，
            // 避免把还没到时点的人误报成异常（旧运行台的口径也是这样）。
            const dueFrom = asText(task.dueFrom || visit.dueFrom).trim()
            if (task.required !== false && participant.status === 'enrolled' && dueFrom && today >= dueFrom) {
              anomalies.push({ key: `${participant.participantId}|${visit.id}|${task.id}|missing`, level: 'warn', participantId: participant.participantId, visitId: visit.id, taskId: task.id, text: `必需任务已到期（${dueFrom}）仍没有记录` })
            }
            continue
          }
          slots[key] = { collection: observation.collectionState, quality: observation.qualityState, observationId: observation.observationId, sourceType: observation.sourceType, eventDate: observation.eventDate }
          if (observation.qualityState === 'invalid' || observation.qualityState === 'unscorable') anomalies.push({ key: `${participant.participantId}|${visit.id}|${task.id}|quality`, level: 'bad', participantId: participant.participantId, visitId: visit.id, taskId: task.id, text: `质量状态：${observation.qualityState}` })
        }
      }
      matrix.push({
        participantKey: participant.participantKey, participantId: participant.participantId,
        status: participant.status, groups: participant.groups || {}, sex: category, slots,
      })
    }
    const revisions = {
      participants: recentRevision('participants'), demographics: recentRevision('demographics'),
      observations: recentRevision('observations'), tasks: recentRevision('tasks'),
      followups: recentRevision('followupMarks'), study: study.revision || null,
    }
    const health = {
      participants: data.health('participants'), demographics: data.health('demographics'),
      observations: data.health('observations'), tasks: data.health('tasks'),
    }
    return {
      schemaVersion: FLOW_SCHEMA_VERSION,
      generatedAt: nowIso(),
      today,
      study: { id: study.id, name: study.name },
      totals,
      sex: { ...sex, mapped: Boolean(sexIndex.column), note: sexIndex.note },
      groups: [...groupMap.values()],
      visits: visits.map(row => ({ id: row.id, label: row.label || row.id })),
      tasks: tasks.map(row => ({ id: row.id, label: row.label || row.id, visits: taskVisits(row), required: row.required !== false, completionPolicy: taskCompletionPolicy(row), qualityPolicy: row.qualityPolicy || null, source: row.source || null })),
      matrix,
      anomalies,
      followups,
      followupCounts: {
        due: followups.filter(row => row.state === 'due').length,
        overdue: followups.filter(row => row.state === 'overdue').length,
        unknown: followups.filter(row => row.state === 'unknown').length,
        done: followups.filter(row => row.state === 'done').length,
      },
      sources: health,
      revisions,
      inputRevision: sha(JSON.stringify(revisions)),
    }
  }

  function onChange(listener) { return data.onChange(listener) }

  /** 重启/失联后的对账：返回自上次 seq 以来的变化与当前版本。 */
  function reconcile(seq = 0) {
    const changes = data.changesSince(seq)
    return { changes, revisions: { participants: recentRevision('participants'), demographics: recentRevision('demographics'), observations: recentRevision('observations'), tasks: recentRevision('tasks'), followups: recentRevision('followupMarks') } }
  }

  return {
    version: FLOW_VERSION,
    data,
    study,
    participants: { list: listParticipants, resolve: resolveParticipant, register: registerParticipant, setStatus: setParticipantStatus, rename: renameParticipant },
    demographics: { read: demographicsDocument, sexIndex: demographicsSexIndex, commit: commitDemographics },
    observations: { list: () => observationsDoc().observations.slice(), effective: (query) => effectiveFor({ observations: observationsDoc().observations }, query), publish: publishObservation, adjudicate, cancelAdjudication },
    imports: { preview: previewTaskImport, commit: commitTaskImport },
    followups: { compute: computeFollowups, mark: markFollowup, marks: () => followupMarks().marks || [] },
    projection: buildProjection,
    onChange,
    reconcile,
    revisions: () => ({ participants: recentRevision('participants'), demographics: recentRevision('demographics'), observations: recentRevision('observations'), tasks: recentRevision('tasks'), followups: recentRevision('followupMarks') }),
  }
}

export default openFlow
