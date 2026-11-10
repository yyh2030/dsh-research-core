/**
 * @local/research-core/privacy-projection — 07 阶段：Agent 输出与分享产物的统一投影
 *
 * 边界（对应 07 方案 P01—P04）：
 *   - strict-local：敏感工具只返回状态、计数、opaque artifactId 与明确的 blocked 原因；
 *     逐人编号、数值、本地路径、姓名/联系方式不进入 Agent 返回。
 *   - summary-cloud：按字段白名单过滤；未知字段与超过字节上限的载荷整体拒绝。
 *   - local：只授权本机界面读取完整视图。Agent 工具即使配置为 local，也仍走最小化投影，
 *     因为"页面能看到"与"模型/外部服务能看到"不是同一件事。
 *
 * 分享视图（shareProjection）与 Agent 视图分开：
 *   - 从白名单重新构造 study（仅 id/name/version）、表、图注、正文与 manifest；
 *   - 表格按列 schema/角色过滤，未知列默认不保留；不靠"值看起来像数字"判断；
 *   - 自由文本仍标注"无法自动保证匿名"，PNG/PDF/SVG 需要人工审阅；
 *   - 本地完整对象不被修改，分享包只带可追溯的 hash/计数与 redactions，不带原始记录。
 *
 * 这个模块不负责判断宿主会话是否真的被限制成严格本地。它只做两件事：
 *   1. 把自己能控制的返回内容最小化；
 *   2. 在 enforceability 里明确"无法证明宿主没有 read/pwsh/附件/浏览器旁路"，
 *      不伪造"已阻止"。
 */

import { createHash } from 'node:crypto'
import { BYPASS_TOOLS } from './privacy.mjs'

export const PRIVACY_MODES = ['strict-local', 'summary-cloud', 'local']
export const DEFAULT_PRIVACY_MODE = 'strict-local'
export const AGENT_PROJECTION_VERSION = 'privacy-projection/1.0.0'
export const SHARE_PROJECTION_VERSION = 'share-projection/1.0.0'
export const SHARE_SCHEMA_VERSION = 1
export const SHARE_NOTICE = '分享包按字段白名单重新构造；自由文本、图片元数据与自由命名变量无法仅靠规则保证匿名，导出前需人工审阅。'

const DEFAULT_MAX_BYTES = 32 * 1024
const MAX_TEXT_CHARS = 12000

/* ------------------------------------------------------------------ *
 * 1. 文本脱敏：Windows/UNC/Unix/家目录、邮箱、URL、证件/手机号
 * ------------------------------------------------------------------ */

const URL_PATTERN = /https?:\/\/[^\s"'<>|，。；、]+/gi
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s"'<>|，。；、]*/g
const EXTENDED_UNC_PATTERN = /\\\\\?\\[^\s"'<>|，。；、]*/g
const UNC_PATH_PATTERN = /\\\\[A-Za-z0-9._$-]+\\[^\s"'<>|，。；、]*/g
const UNIX_PATH_PATTERN = /(^|[\s"'(=:：，。；、])\/(?:home|Users|root|tmp|var|etc|opt|mnt|media|private|Volumes|proc)\/[^\s"'<>|，。；、]*/g
const TILDE_PATH_PATTERN = /(^|[\s"'(=:：，。；、])~\/[^\s"'<>|，。；、]*/g
const FILE_PATTERN = /[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.\-]*\.(?:docx?|xlsx?|pptx?|pdf|csv|tsv|json|md|txt|zip|rar|7z|png|jpe?g|gif|webp|bmp|dat|sav|dta|rds|py|js|mjs)\b/gi
const ID_CARD_PATTERN = /(?<!\d)\d{17}[\dXx](?!\d)/g
const CN_MOBILE_PATTERN = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g

/** 逐人编号：P-001 / ID001 / PID-12；只认大写前缀，避免误伤 sha256 等单词。 */
const PARTICIPANT_ID_TOKEN = /(?<![A-Za-z0-9_])(?:[A-Z]{1,6}[-_]?\d{2,})(?![A-Za-z0-9_])/g

/** 判断文本里是否有需要整段隐藏的高风险定位信息（路径/邮箱/URL/证件）。 */
export function containsHighRisk(value) {
  const text = String(value ?? '')
  if (!text) return false
  for (const pattern of [URL_PATTERN, EMAIL_PATTERN, WINDOWS_PATH_PATTERN, EXTENDED_UNC_PATTERN, UNC_PATH_PATTERN, UNIX_PATH_PATTERN, TILDE_PATH_PATTERN, ID_CARD_PATTERN, CN_MOBILE_PATTERN]) {
    pattern.lastIndex = 0
    if (pattern.test(text)) return true
  }
  return false
}

/**
 * 文本脱敏：路径/链接/邮箱/证件/手机号/文件名。默认不处理"任意名字"，
 * 因为自由文本里的人名无法靠单一正则可靠识别——这是本模块明确保留的边界。
 */
export function scrubText(value) {
  return String(value ?? '')
    .replace(URL_PATTERN, '[链接]')
    .replace(EMAIL_PATTERN, '[邮箱]')
    .replace(EXTENDED_UNC_PATTERN, '[本地路径]')
    .replace(UNC_PATH_PATTERN, '[本地路径]')
    .replace(WINDOWS_PATH_PATTERN, '[本地路径]')
    .replace(UNIX_PATH_PATTERN, '$1[本地路径]')
    .replace(TILDE_PATH_PATTERN, '$1[本地路径]')
    .replace(ID_CARD_PATTERN, '[联系信息]')
    .replace(CN_MOBILE_PATTERN, '[联系信息]')
    .replace(FILE_PATTERN, '[文件名]')
}

/** Agent 文本再紧一层：同时去掉逐人编号。 */
export function scrubAgentText(value) {
  return scrubText(value).replace(PARTICIPANT_ID_TOKEN, '[编号]')
}

/**
 * 显示名审查。路径/邮箱/URL/过长/控制字符会让整段显示名被隐藏，
 * 因为把"张伟 <mail> C:\..."里只替换邮箱与路径，仍会留下姓名。
 */
export function reviewDisplayName(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return { name: null, hidden: false, reason: null }
  if (text.length > 120) return { name: '[显示名已隐藏]', hidden: true, reason: '显示名过长' }
  if (/[\u0000-\u001F\u007F]/u.test(text)) return { name: '[显示名已隐藏]', hidden: true, reason: '显示名含控制字符' }
  if (containsHighRisk(text)) return { name: '[显示名已隐藏]', hidden: true, reason: '显示名含本地路径或联系信息' }
  return { name: text, hidden: false, reason: null }
}

/* ------------------------------------------------------------------ *
 * 2. 策略读取：privacy 服务 / 研究插件配置 / 插件配置，默认 strict-local
 * ------------------------------------------------------------------ */

export function resolvePrivacyMode(value, fallback = DEFAULT_PRIVACY_MODE) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return PRIVACY_MODES.includes(text) ? text : fallback
}

function serviceMode(service) {
  if (!service) return null
  if (typeof service === 'string') return resolvePrivacyMode(service, null)
  if (typeof service === 'function') {
    try { return serviceMode(service()) } catch { return null }
  }
  if (typeof service !== 'object') return null
  for (const method of ['getMode', 'mode', 'getPolicy', 'policy', 'current']) {
    if (typeof service[method] === 'function') {
      try {
        const value = service[method]()
        const found = serviceMode(value) || resolvePrivacyMode(value, null)
        if (found) return found
      } catch { /* 服务实现失败时继续看下一个入口 */ }
    }
  }
  for (const key of ['mode', 'privacyMode', 'currentMode']) {
    const found = resolvePrivacyMode(service[key], null)
    if (found) return found
  }
  return null
}

function firstArray(...values) {
  for (const value of values) if (Array.isArray(value)) return value.map(String).filter(Boolean)
  return null
}

/**
 * 解析当前生效的隐私策略。Agent 的工具参数不参与这个函数——
 * 只有 privacy 服务、研究定义里的 plugins.<pluginKey>.privacyMode、
 * 或插件配置 privacyMode 能改变模式；都没有就是 strict-local。
 */
export function resolvePrivacyPolicy(input = {}) {
  const { ctx = null, config = {}, study = null, pluginKey = '' } = input || {}
  let service = null
  try { service = ctx && typeof ctx.get === 'function' ? ctx.get('privacy') : null } catch { /* 服务不可用按默认 */ }
  const studyPlugin = (study && study.plugin) || (study && study.plugins && study.plugins[pluginKey]) || {}
  const configPrivacy = config && config.privacy && typeof config.privacy === 'object' ? config.privacy : {}
  let mode = DEFAULT_PRIVACY_MODE
  let source = 'default'
  const candidates = [
    ['privacy-service', serviceMode(service)],
    ['study-config', resolvePrivacyMode(studyPlugin.privacyMode, null)],
    ['plugin-config', resolvePrivacyMode(config.privacyMode, null)],
    ['plugin-config', resolvePrivacyMode(configPrivacy.mode, null)],
  ]
  for (const [from, value] of candidates) {
    if (!value) continue
    mode = value
    source = from
    break
  }
  const serviceObject = service && typeof service === 'object' ? service : {}
  return {
    mode,
    source,
    service,
    sessionTools: firstArray(config.sessionTools, config.privacySessionTools, configPrivacy.sessionTools, serviceObject.sessionTools, serviceObject.tools, serviceObject.bypassTools),
    attachments: Boolean(config.attachments ?? configPrivacy.attachments ?? serviceObject.attachments),
    allowedColumns: config.allowedColumns || configPrivacy.allowedColumns || serviceObject.allowedColumns || null,
    maxBytes: Number.isFinite(Number(config.privacyMaxBytes)) ? Number(config.privacyMaxBytes) : (Number.isFinite(Number(configPrivacy.maxBytes)) ? Number(configPrivacy.maxBytes) : undefined),
  }
}

/* ------------------------------------------------------------------ *
 * 3. 会话旁路判定：按 namespace/能力类型，不按精确字符串
 * ------------------------------------------------------------------ */

const KNOWN_SAFE_TOOLS = new Set([
  'analysis_status', 'analysis_results', 'analysis_run', 'analysis_export', 'analysis_exclude',
  'scale_list', 'scale_flow', 'scale_score', 'scale_validate',
  'materials_scan', 'prep_readiness', 'materials_decisions', 'study_draft_preview', 'study_draft_save',
  'study_binding', 'study_data_health', 'study_status', 'study_schedule',
  'participants_manage', 'observations_manage', 'task_import', 'followup_manage', 'flow_projection',
])

function toolTokens(name) {
  return String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** 把工具名拆成能力：read、pwsh、browser_navigate、mcp__github__read_file 都要识别。 */
export function describeSessionTools(tools = []) {
  const bypasses = []
  const unknown = []
  for (const raw of Array.isArray(tools) ? tools : []) {
    const name = String(raw || '').trim()
    if (!name) continue
    const tokens = toolTokens(name)
    const normalized = tokens.join('_')
    let matched = null
    for (const [capability, reason] of Object.entries(BYPASS_TOOLS)) {
      if (tokens.includes(capability) || normalized.includes(capability)) { matched = { tool: name, capability, reason }; break }
    }
    if (matched) bypasses.push(matched)
    else if (!tokens.some(token => KNOWN_SAFE_TOOLS.has(token)) && !KNOWN_SAFE_TOOLS.has(normalized)) {
      unknown.push({ tool: name, reason: '未知工具不能自动判安全' })
    }
  }
  return { bypasses, unknown }
}

/**
 * 会话可执行性声明。插件只能限制自己的返回，不能替宿主承诺 read/pwsh 不存在。
 * - 没有工具清单：unenforceable = 'unknown'（无法证明）；
 * - 有旁路或未知工具：unenforceable = true；
 * - 清单无旁路且全为已知安全工具：enforced = true，但仍提示取决于宿主清单完整性。
 */
export function evaluateSessionEnforceability(options = {}) {
  const tools = firstArray(options.sessionTools)
  const attachmentBypass = options.attachments
    ? [{ tool: 'attachments', capability: 'attachment', reason: BYPASS_TOOLS.attachment }]
    : []
  if (!tools || tools.length === 0) {
    return {
      enforced: false,
      unenforceable: 'unknown',
      bypasses: attachmentBypass,
      unknownTools: [],
      notBlocked: attachmentBypass.map(row => row.tool),
      reason: '未提供会话工具清单：本插件无法证明当前通用会话没有 read/pwsh/附件/浏览器等旁路，因此只保证工具返回已最小化，不宣称严格本地已强制执行。',
    }
  }
  const { bypasses, unknown } = describeSessionTools(tools)
  const allBypasses = [...attachmentBypass, ...bypasses]
  const enforced = allBypasses.length === 0 && unknown.length === 0
  return {
    enforced,
    unenforceable: enforced ? false : true,
    bypasses: allBypasses,
    unknownTools: unknown,
    notBlocked: allBypasses.map(row => row.tool),
    reason: enforced
      ? '提供的会话工具清单未发现旁路；是否真正严格本地仍取决于宿主清单是否完整。'
      : `会话声明 ${allBypasses.length} 个旁路能力与 ${unknown.length} 个未知工具：插件只能限制自身工具返回，不能阻止 read/pwsh/附件/浏览器读取同一研究数据。`,
  }
}

/* ------------------------------------------------------------------ *
 * 4. Agent 投影
 * ------------------------------------------------------------------ */

const SAFE_COUNT_KEYS = new Set([
  'runs', 'tables', 'rows', 'figures', 'png', 'presentations', 'artifacts',
  'subjects', 'observations', 'n', 'excluded', 'scales', 'filled', 'complete',
  'bad', 'warn', 'info', 'issues', 'files', 'parsed', 'needsOcr', 'unparsed',
  'failed', 'notScanned', 'attempted', 'candidates', 'blockers', 'pending',
  'conflicts', 'decisions', 'accepted', 'rejected', 'pending_mapping', 'needs_review',
  'instructionLike', 'autoTicks', 'exclusions', 'answers', 'matched', 'records',
])

const STRICT_BLOCKED = {
  analysis_results: [
    { field: 'tables[].rows', reason: '逐行数值与逐人记录不进入 Agent 返回' },
    { field: 'tables[].columns', reason: '逐列变量名与取值不进入 Agent 返回' },
    { field: 'meta.study.path', reason: '本地路径不返回' },
    { field: 'report', reason: '自由文本无法自动保证匿名' },
  ],
  analysis_status: [
    { field: 'paths.outputDir', reason: '本地路径不返回' },
    { field: 'source.path', reason: '本地路径不返回' },
    { field: 'runs[].runId', reason: '运行编号改为 opaque artifactId' },
    { field: 'exclusions[].id', reason: '逐人排除明细不返回' },
  ],
  analysis_export: [
    { field: 'dir', reason: '本地路径不返回' },
    { field: 'manifest.artifacts[].relativePath', reason: '只返回 opaque artifactId' },
    { field: 'study.path', reason: '本地路径不返回' },
  ],
  analysis_run: [
    { field: 'runDir', reason: '本地路径不返回' },
    { field: 'meta', reason: '完整运行 meta 不进入 Agent 返回' },
    { field: 'summaryText', reason: '文本摘要可能带运行编号与人数，只返回计数' },
  ],
  scale_score: [
    { field: 'scores[].value', reason: '逐人分数与题目作答不进入 Agent 返回' },
    { field: 'id', reason: '被试编号不返回' },
    { field: 'issues[].text', reason: '校验自由文本不进入 Agent 返回' },
  ],
}

/** summary-cloud 的顶层字段白名单。这份名单之外的新字段一律拒绝，不静默透传。 */
const SUMMARY_ALLOWED = {
  analysis_results: ['runId', 'status', 'counts', 'tables', 'figureKeys', 'analysisSet', 'integrity', 'study'],
  analysis_status: ['status', 'counts', 'study', 'runs', 'backends', 'pendingChanges'],
  analysis_export: ['runId', 'revision', 'status', 'counts', 'artifacts', 'figures', 'pdf', 'office'],
  analysis_run: ['status', 'runId', 'reused', 'counts', 'error'],
  scale_score: ['scope', 'status', 'counts', 'scales'],
  materials_scan: ['status', 'counts', 'coverage', 'decisions', 'blockers', 'pending', 'conflicts', 'instructionLike', 'complete'],
  prep_readiness: ['status', 'counts', 'areas', 'stages', 'blockers', 'pending', 'canStart'],
}

function opaqueArtifactId(seed) {
  return 'art-' + createHash('sha256').update(`dsh-privacy-projection:${String(seed)}`).digest('hex').slice(0, 16)
}

function safeStatus(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{0,39}$/.test(text) ? text : 'unknown'
}

function takeCounts(source, out) {
  if (!source || typeof source !== 'object') return
  for (const [key, value] of Object.entries(source)) {
    if (key === 'issues' && value && typeof value === 'object') { takeCounts(value, out); continue }
    if (!SAFE_COUNT_KEYS.has(key)) continue
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'string' && /^\d+$/.test(value)) out[key] = Number(value)
  }
}

function safeCounts(kind, payload) {
  const out = {}
  takeCounts(payload && payload.counts, out)
  takeCounts(payload, out)
  if (Array.isArray(payload?.tables) && out.tables === undefined) out.tables = payload.tables.length
  if (Array.isArray(payload?.figures) && out.figures === undefined) out.figures = payload.figures.length
  if (Array.isArray(payload?.runs) && out.runs === undefined) out.runs = payload.runs.length
  if (Array.isArray(payload?.presentations) && out.presentations === undefined) out.presentations = payload.presentations.length
  if (kind === 'analysis_export' && Array.isArray(payload?.artifacts) && out.artifacts === undefined) out.artifacts = payload.artifacts.length
  return out
}

function safeArtifacts(kind, payload) {
  const seeds = []
  if (payload && typeof payload.runId === 'string' && payload.runId) seeds.push(kind === 'analysis_export' ? `${payload.runId}:${payload.revision ?? 0}` : payload.runId)
  if (kind === 'analysis_status' && Array.isArray(payload?.runs)) {
    for (const run of payload.runs.slice(0, 20)) if (run && typeof run.runId === 'string' && run.runId) seeds.push(run.runId)
  }
  if (Array.isArray(payload?.artifacts)) {
    for (const item of payload.artifacts.slice(0, 40)) {
      const relative = typeof item === 'string' ? item : item?.relativePath
      if (relative) seeds.push(`${payload.runId || ''}:${relative}`)
    }
  }
  const seen = new Set()
  return seeds.filter(seed => {
    if (!seed || seen.has(seed)) return false
    seen.add(seed)
    return true
  }).slice(0, 40).map(seed => ({ artifactId: opaqueArtifactId(seed), status: 'local-only' }))
}

function safeStudyForAgent(kind, payload) {
  if (kind !== 'analysis_status') return undefined
  const raw = payload && payload.study
  if (!raw || typeof raw !== 'object') return undefined
  const reviewed = reviewDisplayName(raw.name)
  const out = {}
  if (reviewed.name) out.name = reviewed.name
  if (reviewed.hidden) out.displayNameHidden = true
  return Object.keys(out).length ? out : undefined
}

function enforceabilityBlock(options) {
  return evaluateSessionEnforceability(options)
}

function strictObjectProjection(kind, payload, options = {}) {
  const enforceability = enforceabilityBlock(options)
  const envelope = {
    ok: true,
    projection: 'strict-local',
    projectionVersion: AGENT_PROJECTION_VERSION,
    kind,
    status: safeStatus(payload?.status ?? payload?.scope ?? 'ok'),
    counts: safeCounts(kind, payload),
    artifacts: safeArtifacts(kind, payload),
    blocked: STRICT_BLOCKED[kind] || [{ field: '$', reason: 'strict-local 下该工具只返回状态与计数' }],
    enforceability,
  }
  const study = safeStudyForAgent(kind, payload)
  if (study) envelope.study = study
  if (options.requestedMode === 'local') {
    envelope.note = 'local 模式只授权本机界面读取完整视图；本次 Agent 返回仍按严格本地最小化处理。'
  }
  if (options.attachments) {
    envelope.blocked = envelope.blocked.concat([{ field: 'attachments', reason: '附件会进入模型请求，不能当作本地数据' }])
  }
  return envelope
}

function projectText(payload, mode, options = {}) {
  const source = String(payload ?? '')
  const scrubbed = scrubAgentText(source)
  const clipped = scrubbed.length > MAX_TEXT_CHARS
    ? `${scrubbed.slice(0, MAX_TEXT_CHARS)}\n…（其余 ${scrubbed.length - MAX_TEXT_CHARS} 字符留本地）`
    : scrubbed
  const label = mode === 'summary-cloud' ? 'summary-cloud' : 'strict-local'
  return `${clipped}\n\n（隐私边界：已去除本地路径、联系信息与逐人编号；当前模式 ${label}。本插件只能限制自己的返回，通用会话的 read/pwsh/附件/浏览器旁路无法由本插件阻断——不宣称"已阻止"。自由文本与图片元数据无法仅靠规则保证匿名。）`
}

function blockedEnvelope(kind, mode, blocked, options, counts = {}) {
  return {
    ok: false,
    projection: mode,
    projectionVersion: AGENT_PROJECTION_VERSION,
    kind,
    status: 'blocked',
    code: 'policy_blocked',
    counts,
    blocked,
    enforceability: enforceabilityBlock(options),
    note: '载荷被隐私策略整体拒绝，未发送任何内容；本机完整数据保持不变。',
  }
}

/**
 * 从一批表中按列 schema 取可安全分享的列。未知列默认不保留。
 * 返回 { columns, rows, dropped, types } 或 null（无可安全列）。
 */
function safeColumnKey(column) {
  return String(column && typeof column === 'object' ? column.key : column ?? '')
}

function normalizeColumn(column) {
  if (column && typeof column === 'object') {
    return {
      key: safeColumnKey(column),
      zh: String(column.zh ?? column.title?.zh ?? column.label ?? column.key ?? ''),
      en: String(column.en ?? column.title?.en ?? column.label ?? column.key ?? ''),
      ...(column.role ? { role: String(column.role) } : {}),
    }
  }
  return { key: String(column ?? ''), zh: String(column ?? ''), en: String(column ?? '') }
}

const SENSITIVE_COLUMN = /^(?:.*_)?(?:name|fullname|firstname|lastname|phone|mobile|tel|telephone|email|mail|address|idcard|id_card|bankcard|bank_card|cardno|card_no|note|notes|remark|remarks|comment|comments|contact|freetext|free_text|text)$/i
const IDENTIFIER_COLUMN = /^(?:.*_)?(?:participantid|participantkey|subjectid|subjectkey|patientid|recordid|recordkey)$/i
const IDENTIFIER_LABEL = /^(?:participant\s*id|subject\s*id|participant|subject|id|编号|参与者编号|受试者编号|被试编号)$/i
const SENSITIVE_CJK_COLUMN = /姓名|名字|手机|电话|邮箱|住址|地址|身份证|备注|联系人/

function isSensitiveColumn(key, column) {
  const raw = String(key || '')
  if (SENSITIVE_COLUMN.test(raw)) return true
  if (SENSITIVE_CJK_COLUMN.test(raw)) return true
  if (SENSITIVE_CJK_COLUMN.test(column?.zh || '')) return true
  if (SENSITIVE_CJK_COLUMN.test(column?.en || '')) return true
  return false
}

function isIdentifierColumn(key, column) {
  const raw = String(key || '')
  if (IDENTIFIER_COLUMN.test(raw)) return true
  if (IDENTIFIER_LABEL.test(raw)) return true
  if (/编号/.test(raw) || /编号/.test(column?.zh || '')) return true
  return false
}

function roleFromType(type) {
  if (type === 'number') return 'measure'
  if (type === 'string') return 'category'
  return null
}

function normalizeAllowedColumns(value) {
  const allowed = new Set()
  if (Array.isArray(value)) for (const item of value) if (item) allowed.add(String(item))
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (item) allowed.add(String(key))
  return allowed
}

function columnDecision(column, declaredType, allowed) {
  if (allowed.has(column.key)) return { keep: true, reason: null }
  const header = `${column.key} ${column.zh || ''} ${column.en || ''}`
  if (containsHighRisk(header)) return { keep: false, reason: '列名或标签含本地路径/联系信息' }
  if (isIdentifierColumn(column.key, column)) return { keep: false, reason: '逐人编号列默认不进入分享包' }
  if (isSensitiveColumn(column.key, column)) return { keep: false, reason: '列名属于身份/联系/自由文本敏感角色' }
  const role = column.role || roleFromType(declaredType)
  if (role === 'measure' || role === 'number') return { keep: true, reason: null }
  if (role === 'category' || role === 'string') return { keep: true, reason: null }
  return { keep: false, reason: '列角色未知或未声明，默认不保留' }
}

function shareCell(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.length > 500 ? `${value.slice(0, 500)}…[已截断]` : value
    return scrubText(text)
  }
  return '[值已省略]'
}

function shareAnalysisSet(value) {
  if (!value || typeof value !== 'object') return null
  const out = {}
  for (const key of ['subset', 'subjects', 'n', 'observations', 'excluded']) {
    const item = value[key]
    if (item === undefined || item === null) continue
    out[key] = typeof item === 'number' && Number.isFinite(item) ? item : String(item)
  }
  return Object.keys(out).length ? out : null
}

/** 分享表：只保留白名单/已知角色的列，行里只保留这些列。 */
export function shareTable(table, context = {}) {
  if (!table || typeof table !== 'object') return null
  const allowed = context.allowedColumns instanceof Set ? context.allowedColumns : normalizeAllowedColumns(context.allowedColumns)
  const redactions = Array.isArray(context.redactions) ? context.redactions : []
  const types = table.types && typeof table.types === 'object' ? table.types : {}
  const columns = []
  const dropped = []
  for (const [index, raw] of (table.columns || []).entries()) {
    const column = normalizeColumn(raw)
    const decision = columnDecision(column, types[column.key], allowed)
    if (decision.keep) columns.push({ ...column, ...(types[column.key] ? { type: types[column.key] } : {}) })
    else {
      dropped.push({ index, reason: decision.reason })
      redactions.push({ field: `tables[${table.key || '?'}].columns[${index}]`, reason: decision.reason })
    }
  }
  if (!columns.length) {
    redactions.push({ field: `tables[${table.key || '?'}]`, reason: '没有可安全分享的列，整表不进入分享包' })
    return null
  }
  const rows = (table.rows || []).map(row => {
    const out = {}
    for (const column of columns) {
      if (row && Object.hasOwn(row, column.key)) out[column.key] = shareCell(row[column.key])
    }
    return out
  })
  const title = table.title && typeof table.title === 'object'
    ? { zh: reviewShareLabel(table.title.zh, redactions, `tables[${table.key}].title.zh`), en: reviewShareLabel(table.title.en, redactions, `tables[${table.key}].title.en`) }
    : { zh: reviewShareLabel(table.title || table.key || '未命名表', redactions, `tables[${table.key}].title`), en: reviewShareLabel(table.title || table.key || 'Untitled', redactions, `tables[${table.key}].title`) }
  const notes = (table.notes || []).map((note, index) => reviewShareText(note, redactions, `tables[${table.key}].notes[${index}]`))
  return {
    key: String(table.key || ''),
    number: Number.isFinite(Number(table.number)) ? Number(table.number) : null,
    title,
    nodeId: table.nodeId ? scrubText(table.nodeId) : null,
    analysisSet: shareAnalysisSet(table.analysisSet) || shareAnalysisSet(context.fallbackAnalysisSet),
    types: Object.fromEntries(columns.filter(column => column.type).map(column => [column.key, column.type])),
    sourceHash: typeof table.sourceHash === 'string' ? table.sourceHash : null,
    columns: columns.map(({ type, ...column }) => column),
    rows,
    notes,
    droppedColumns: dropped.length,
  }
}

function reviewShareLabel(value, redactions, field) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (containsHighRisk(text)) {
    redactions.push({ field, reason: '标签含本地路径或联系信息，已隐藏整段文本' })
    return '[文本已隐藏]'
  }
  return scrubText(text)
}

/** 自由文本：含路径/联系信息时整段隐藏，避免只替换一部分而留下姓名。 */
function reviewShareText(value, redactions, field) {
  const text = String(value ?? '')
  if (!text) return ''
  if (containsHighRisk(text)) {
    redactions.push({ field, reason: '自由文本含本地路径或联系信息，已隐藏整段' })
    return '[文本已隐藏]'
  }
  return scrubText(text)
}

function shareFigure(figure, redactions) {
  if (!figure || typeof figure !== 'object') return null
  const out = { key: String(figure.key || 'figure') }
  const rawTitle = typeof figure.title === 'string' ? figure.title : ''
  if (rawTitle) {
    if (containsHighRisk(rawTitle)) {
      out.title = '[图注已隐藏]'
      out.captionNeedsReview = true
      redactions.push({ field: `figures[${out.key}].title`, reason: '图注含本地路径或联系信息，整段隐藏' })
    } else out.title = scrubText(rawTitle)
  }
  const svg = relativeArtifactPath(figure.svg)
  const png = relativeArtifactPath(figure.png)
  if (svg) out.svg = svg
  if (png) out.png = png
  for (const key of ['width', 'height']) if (Number.isFinite(Number(figure[key]))) out[key] = Number(figure[key])
  if (figure.analysisSetId) out.analysisSetId = scrubText(figure.analysisSetId)
  if (/paired|individual|trajector/i.test(out.key)) {
    out.reviewRequired = true
    redactions.push({ field: `figures[${out.key}]`, reason: '逐人轨迹图可能显示个体数据，分享前需人工审阅' })
  }
  return out
}

/** 分享包只接受相对路径；绝对路径/UNC/`..` 一律不进入 manifest。 */
export function relativeArtifactPath(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/')
  if (!text) return null
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.startsWith('//') || text.startsWith('~')) return null
  const parts = text.split('/').filter(part => part && part !== '.')
  if (!parts.length || parts.includes('..')) return null
  return parts.join('/')
}

/** 分享 manifest：只保留相对路径与可追溯 hash，不带源机器环境路径。 */
export function shareManifest(manifest = {}) {
  const artifacts = []
  for (const item of Array.isArray(manifest.artifacts) ? manifest.artifacts : []) {
    const relativePath = relativeArtifactPath(item && item.relativePath)
    if (!relativePath) continue
    artifacts.push({
      mediaType: String(item.mediaType || 'application/octet-stream'),
      relativePath,
      sha256: typeof item.sha256 === 'string' ? item.sha256 : null,
      runId: typeof item.runId === 'string' ? item.runId : null,
      ...(Array.isArray(item.nodeIds) ? { nodeIds: item.nodeIds.map(node => scrubText(node)) } : {}),
    })
  }
  const out = {
    schemaVersion: SHARE_SCHEMA_VERSION,
    resultsVersion: manifest.resultsVersion || null,
    runId: typeof manifest.runId === 'string' ? manifest.runId : null,
    nodeIds: Array.isArray(manifest.nodeIds) ? manifest.nodeIds.map(node => scrubText(node)) : [],
    sourceHash: typeof manifest.sourceHash === 'string' ? manifest.sourceHash : null,
    createdAt: manifest.createdAt || null,
    renderer: typeof manifest.renderer === 'string' ? scrubText(manifest.renderer) : null,
    presentationRevision: Number.isFinite(Number(manifest.presentationRevision)) ? Number(manifest.presentationRevision) : null,
    artifacts,
    notes: [SHARE_NOTICE],
  }
  for (const key of ['formatSchema']) if (manifest[key] !== undefined) out.formatSchema = manifest[key]
  if (manifest.analysisSet !== undefined) out.analysisSet = shareAnalysisSet(manifest.analysisSet)
  if (Array.isArray(manifest.figures)) out.figures = manifest.figures.map(figure => ({ key: scrubText(figure?.key || ''), analysisSetId: figure?.analysisSetId ? scrubText(figure.analysisSetId) : null }))
  if (manifest.render && typeof manifest.render === 'object') {
    const render = {}
    for (const [key, value] of Object.entries(manifest.render)) render[key] = typeof value === 'string' ? scrubText(value) : value
    out.render = render
  }
  if (manifest.parent !== undefined) out.parent = relativeArtifactPath(manifest.parent) || null
  for (const key of ['pdf', 'office']) {
    const value = manifest[key]
    if (!value || typeof value !== 'object') continue
    const copy = {}
    for (const [field, item] of Object.entries(value)) {
      if (typeof item === 'string') {
        const relative = relativeArtifactPath(item)
        copy[field] = relative || scrubText(item)
      } else copy[field] = item
    }
    out[key] = copy
  }
  if (manifest.sourceModelHash !== undefined) out.sourceModelHash = typeof manifest.sourceModelHash === 'string' ? manifest.sourceModelHash : null
  return out
}

/** 分享 meta（供报告正文/诊断使用）：去掉进程、路径与逐人集合，只保留可解释字段。 */
function shareMeta(meta, redactions) {
  const nodes = {}
  const sourceNodes = meta && meta.nodes && typeof meta.nodes === 'object' ? meta.nodes : {}
  for (const [name, node] of Object.entries(sourceNodes)) {
    const entry = { status: safeStatus(node?.status), reason: reviewShareText(node?.reason || '', redactions, `meta.nodes[${name}].reason`) }
    if (node && node.result && typeof node.result === 'object') entry.result = sanitizeShareValue(node.result, redactions)
    nodes[name] = entry
  }
  return {
    status: safeStatus(meta?.status),
    study: meta?.study && typeof meta.study === 'object' ? meta.study : undefined,
    nodes,
    warnings: (Array.isArray(meta?.warnings) ? meta.warnings : []).map((warning, index) => reviewShareText(warning, redactions, `meta.warnings[${index}]`)),
  }
}

function sanitizeShareValue(value, redactions = [], depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth > 8) return '[层级过深]'
  if (Array.isArray(value)) {
    if (value.length > 200) redactions.push({ field: 'array', reason: '数组过长，已截断' })
    return value.slice(0, 200).map(item => sanitizeShareValue(item, redactions, depth + 1))
  }
  if (typeof value !== 'object') return String(value)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (/(?:^|_)(path|paths|dataRoot|config|process|hostname|pid|ids|pairs|raw|rawValues|values|address|email|mail|phone|mobile|tel|name)$/i.test(key)) {
      redactions.push({ field: key, reason: '对象字段属于路径/进程/逐人数据，分享包不保留' })
      continue
    }
    out[key] = sanitizeShareValue(item, redactions, depth + 1)
  }
  return out
}

function shareStudy(study, redactions) {
  const out = {}
  if (!study || typeof study !== 'object') return out
  if (study.id !== undefined && study.id !== null) out.id = scrubText(study.id)
  const reviewed = reviewDisplayName(study.name)
  if (reviewed.name) out.name = reviewed.name
  if (reviewed.hidden) redactions.push({ field: 'study.name', reason: reviewed.reason })
  if (typeof study.version === 'string' || typeof study.version === 'number') out.version = scrubText(study.version)
  for (const field of ['path', 'dataRoot', 'config', 'baseDir', 'plugins']) {
    if (study[field] !== undefined) redactions.push({ field: `study.${field}`, reason: '分享包不包含本地路径/配置' })
  }
  return out
}

/**
 * 从结果对象重新构造分享视图。输入不被修改；本机完整结果仍在运行目录。
 * @param {object} results buildResults 的输出（或结构相同的对象）
 * @param {object} [options] { meta, artifacts, allowedColumns, mode }
 */
export function shareProjection(results, options = {}) {
  const input = results && typeof results === 'object' ? results : {}
  const redactions = []
  const study = shareStudy(input.study, redactions)
  const fallbackAnalysisSet = shareAnalysisSet(input.analysisSet)
  const tables = []
  for (const table of Array.isArray(input.tables) ? input.tables : []) {
    const projected = shareTable(table, { allowedColumns: options.allowedColumns, redactions, fallbackAnalysisSet })
    if (projected) tables.push(projected)
  }
  const figures = (Array.isArray(input.figures) ? input.figures : []).map(figure => shareFigure(figure, redactions)).filter(Boolean)
  const warnings = (Array.isArray(input.warnings) ? input.warnings : []).map((warning, index) => reviewShareText(warning, redactions, `warnings[${index}]`))
  const output = {
    schemaVersion: SHARE_SCHEMA_VERSION,
    shareVersion: SHARE_PROJECTION_VERSION,
    version: input.version || null,
    resultsVersion: input.version || null,
    runId: typeof input.runId === 'string' ? input.runId : null,
    study,
    nodeIds: (Array.isArray(input.nodeIds) ? input.nodeIds : []).map(node => scrubText(node)),
    analysisSet: shareAnalysisSet(input.analysisSet),
    sourceHash: typeof input.sourceHash === 'string' ? input.sourceHash : null,
    tables,
    figures,
    warnings,
    hash: typeof input.hash === 'string' ? input.hash : null,
    redactions,
    notes: [SHARE_NOTICE],
  }
  if (options.meta && typeof options.meta === 'object') {
    const meta = shareMeta(options.meta, redactions)
    meta.study = study
    output.meta = meta
  }
  if (Array.isArray(options.artifacts)) {
    output.manifest = shareManifest({
      resultsVersion: input.version || null,
      runId: input.runId,
      nodeIds: input.nodeIds,
      sourceHash: input.sourceHash,
      artifacts: options.artifacts,
      renderer: options.renderer,
      presentationRevision: options.presentationRevision,
    })
  }
  return output
}

/* ------------------------------------------------------------------ *
 * 5. 错误投影：不带原始记录、不带路径栈
 * ------------------------------------------------------------------ */

export function sanitizeError(error, options = {}) {
  const source = error && typeof error === 'object' ? error : {}
  const code = typeof source.code === 'string' && /^[a-z][a-z0-9_.-]{0,40}$/i.test(source.code) ? source.code : 'error'
  const raw = typeof source.message === 'string' ? source.message : String(error ?? '未知错误')
  const message = scrubAgentText(raw).slice(0, 800)
  const out = {
    ok: false,
    status: 'error',
    projection: 'error',
    code,
    message,
    stack: null,
    stackOmitted: true,
    note: '错误已去路径与逐人编号；原始记录、异常栈与 details 不返回。',
  }
  if (options.mode) out.mode = options.mode
  if (Array.isArray(source.fields)) out.fields = source.fields.map(item => scrubText(item)).slice(0, 10)
  if (source.details !== undefined) out.detailsOmitted = true
  return out
}

/* ------------------------------------------------------------------ *
 * 6. 对外入口
 * ------------------------------------------------------------------ */

/**
 * @param {string} kind 工具/视图类型，如 analysis_results、scale_score、materials_scan
 * @param {unknown} payload 对象按 kind 投影；字符串按文本摘要投影
 * @param {string} mode strict-local | summary-cloud | local
 * @param {object} [options] { sessionTools, allowedColumns, maxBytes, attachments }
 */
export function agentProjection(kind, payload, mode, options = {}) {
  const requestedMode = resolvePrivacyMode(mode)
  const effective = requestedMode === 'local' ? 'strict-local' : requestedMode
  const context = { ...options, requestedMode }

  if (payload === null || payload === undefined) payload = {}
  if (typeof payload === 'string' || effective === 'strict-local') {
    if (typeof payload === 'string') return projectText(payload, effective, context)
    return strictObjectProjection(kind, payload, context)
  }

  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Number(options.maxBytes) : DEFAULT_MAX_BYTES
  const serialized = JSON.stringify(payload)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > maxBytes) {
    return blockedEnvelope(kind, effective, [{ field: '$', reason: `载荷 ${bytes} 字节超过 ${maxBytes} 字节上限` }], context, safeCounts(kind, payload))
  }

  const allowed = new Set(SUMMARY_ALLOWED[kind] || [])
  const unknown = Object.keys(payload).filter(key => !allowed.has(key))
  if (unknown.length) {
    return blockedEnvelope(kind, effective, unknown.slice(0, 10).map(field => ({ field, reason: '不在 summary-cloud 字段白名单中' })), context, safeCounts(kind, payload))
  }
  if (kind === 'scale_score' && payload.scope === 'subject') {
    return {
      ok: true,
      projection: 'summary-cloud',
      projectionVersion: AGENT_PROJECTION_VERSION,
      kind,
      scope: 'subject',
      status: 'blocked',
      counts: safeCounts(kind, payload),
      blocked: [{ field: 'scores', reason: 'summary-cloud 只传汇总粒度，逐人分数与题目原始值阻断' }],
      enforceability: enforceabilityBlock(context),
    }
  }

  const redactions = []
  const filtered = {}
  const fallbackAnalysisSet = shareAnalysisSet(payload.analysisSet)
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'tables' && Array.isArray(value)) { filtered.tables = value.map(table => shareTable(table, { allowedColumns: options.allowedColumns, redactions, fallbackAnalysisSet })).filter(Boolean); continue }
    if (key === 'study') { filtered.study = shareStudy(value, redactions); continue }
    if (key === 'analysisSet') { filtered.analysisSet = shareAnalysisSet(value); continue }
    if (key === 'counts') { const counts = {}; takeCounts(value, counts); filtered.counts = counts; continue }
    if (key === 'artifacts' && Array.isArray(value)) {
      // 相对产物路径是允许的；绝对路径仍被丢弃。
      filtered.artifacts = value.map(item => relativeArtifactPath(typeof item === 'string' ? item : item?.relativePath)).filter(Boolean).map(relativePath => ({ relativePath }))
      continue
    }
    if (key === 'error' && typeof value === 'string') { filtered.error = scrubAgentText(value); continue }
    filtered[key] = sanitizeShareValue(value, redactions)
  }
  const out = {
    ok: true,
    projection: 'summary-cloud',
    projectionVersion: AGENT_PROJECTION_VERSION,
    kind,
    status: safeStatus(payload.status ?? payload.scope ?? 'ok'),
    ...filtered,
    enforceability: enforceabilityBlock(context),
  }
  if (redactions.length) out.redactions = redactions
  if (requestedMode === 'local') out.note = 'local 模式只授权本机界面读取完整视图；本次 Agent 返回仍按白名单汇总处理。'
  return out
}
