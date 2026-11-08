/**
 * @local/research-core/materials — 工作区材料整理与实验准备（03 阶段）
 *
 * 只做三件事：**看清有哪些材料、从中提出带证据的候选、把缺项与冲突讲清楚。**
 *   - 不改动、不移动、不重命名、不覆盖原始材料；
 *   - 不联网、不调用云端模型；strict-local 下只做规则型抽取；
 *   - 材料里的文字一律当资料，不当指令执行（PREP-07）。
 *
 * 主要入口：
 *   scanMaterials({root, ...})          本地清单 + 解析状态 + 覆盖率（可续扫）
 *   extractFindings(inventory, ...)     候选 / 冲突 / 缺项 / 可疑指令内容
 *   buildStudyDraft({...})              研究配置草案 + 校验 + diff + 独占创建
 *   assessReadiness({...})              分环境的准备度（不给一个百分比掩盖问题）
 *   saveMaterialsIndex / loadMaterialsIndex  派生索引的保存与恢复
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MATERIALS_SCHEMA_VERSION = 1
export const MATERIALS_VERSION = '3.0.0'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PARSER_SCRIPT = path.join(HERE, 'materials_parse.py')

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml', '.srt'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic'])
const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz'])
const LEGACY_EXT = new Set(['.doc', '.xls', '.ppt'])
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pdf'])
const MODEL_EXT = new Set(['.sav', '.dta', '.rds', '.rdata', '.mat', '.m', '.py', '.js', '.mjs', '.ipynb'])

const DEFAULT_EXCLUDES = [
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.cache',
  'backup', 'bak', '备份', 'exports', 'export', 'runs', 'tmp', 'temp', '$recycle.bin',
  'system volume information', '.ds_store', 'thumbs.db', 'desktop.ini', '~$',
  '.dsh', '.dsh-materials',
]
const EXCLUDE_FILE_PATTERNS = [/\.tmp$/i, /\.bak$/i, /\.swp$/i, /^~\$/]
const PROMPT_INJECTION = /(ignore (all )?(previous|above) instructions|disregard (all )?(previous|above)|system prompt|忽略(以上|之前|前面).{0,6}(指令|提示)|你现在是|please (send|upload|post).{0,40}(http|https|ftp):\/\/|把.{0,12}(上传|发送|发到).{0,20}(http|https):\/\/)/i

export class MaterialsError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MaterialsError'
    this.code = code
    this.details = details
  }
}

const sha = (value, length = 64) => createHash('sha256').update(value).digest('hex').slice(0, length)
const posix = value => value.split(path.sep).join('/')

function atomicWrite(target, text) {
  mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, target)
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

function parseExtension(file) { return path.extname(file).toLowerCase() }

export function classifyFile(file) {
  const ext = parseExtension(file)
  if (TEXT_EXT.has(ext)) return 'text'
  if (OFFICE_EXT.has(ext)) return 'office'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (LEGACY_EXT.has(ext)) return 'legacy'
  if (MODEL_EXT.has(ext)) return 'code'
  return 'unknown'
}

function excluded(relative, name, extra) {
  const lower = relative.toLowerCase()
  const base = name.toLowerCase()
  for (const rule of DEFAULT_EXCLUDES) {
    if (base === rule || base.includes(rule)) return rule
    if (lower.includes(`/${rule}/`) || lower.startsWith(`${rule}/`)) return rule
  }
  for (const pattern of EXCLUDE_FILE_PATTERNS) if (pattern.test(base)) return String(pattern)
  for (const rule of extra || []) {
    const text = String(rule || '').toLowerCase().trim()
    if (!text) continue
    if (text.startsWith('.') && text.includes('*')) {
      if (base.endsWith(text.slice(1))) return text
    } else if (lower.includes(text)) return text
  }
  return null
}

function pythonRunner(options = {}) {
  const pythonPath = options.pythonPath || process.env.DSH_MATERIALS_PYTHON || ''
  const pdfLibDir = options.pdfLibDir || process.env.DSH_PDF_LIBS || ''
  const timeoutMs = Number(options.timeoutMs) || 20000
  return { pythonPath, pdfLibDir, timeoutMs }
}

function runParser(file, python) {
  return new Promise(resolve => {
    if (!python.pythonPath) {
      resolve({ ok: false, reason: 'parser_unavailable', error: '未配置本机 Python 路径（office/pdf 解析不可用）' })
      return
    }
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
    if (python.pdfLibDir) env.PYTHONPATH = [python.pdfLibDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
    const child = spawn(python.pythonPath, ['-X', 'utf8', PARSER_SCRIPT, '--file', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = value => { if (!settled) { settled = true; resolve(value) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } finish({ ok: false, reason: 'timeout', error: `解析超过 ${python.timeoutMs}ms` }) }, python.timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 32 * 1024 * 1024) { try { child.kill() } catch { /* 已退出 */ } finish({ ok: false, reason: 'too_large', error: '解析输出过大' }) } })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
    child.on('error', error => finish({ ok: false, reason: 'parser_unavailable', error: error.message }))
    child.on('close', code => {
      clearTimeout(timer)
      const marker = stdout.lastIndexOf('===JSON===')
      if (marker < 0) { finish({ ok: false, reason: 'corrupt', error: stderr || `解析器退出码 ${code}` }); return }
      try { finish(JSON.parse(stdout.slice(marker + 10).trim())) } catch (error) { finish({ ok: false, reason: 'corrupt', error: error.message }) }
    })
  })
}

function textBlocks(text, limit = 5000) {
  const blocks = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length && blocks.length < limit; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    blocks.push({ kind: 'paragraph', text: line.slice(0, 4000), line: index + 1 })
  }
  return blocks
}

export function parseCsv(text) {
  const rows = []
  let row = []
  let value = ''
  let quoted = false
  const source = String(text).replace(/^\uFEFF/, '')
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { value += '"'; index += 1 } else quoted = !quoted
    } else if (quoted) value += char
    else if (char === ',') { row.push(value); value = '' }
    else if (char === '\n') { row.push(value); rows.push(row); row = []; value = '' }
    else if (char !== '\r') value += char
  }
  if (value || row.length) { row.push(value); rows.push(row) }
  return rows.filter(cells => cells.some(cell => String(cell).trim() !== ''))
}

async function parseOneFile(entry, options) {
  const absolute = entry.absolute
  const ext = entry.ext
  const limitBytes = Number(options.maxParseBytes) || 16 * 1024 * 1024
  if (entry.bytes > limitBytes) return { status: 'unparsed', reason: 'too_large', parser: 'none' }
  if (entry.kind === 'archive') return { status: 'unparsed', reason: 'archive', parser: 'none' }
  if (entry.kind === 'legacy') return { status: 'unparsed', reason: 'legacy', parser: 'none' }
  if (entry.kind === 'image') return { status: 'needs_ocr', reason: 'image', parser: 'none' }
  if (entry.kind === 'code') return { status: 'skipped', reason: 'code', parser: 'none' }
  if (entry.kind === 'unknown') return { status: 'unparsed', reason: 'unsupported', parser: 'none' }
  if (entry.kind === 'office') {
    const result = await runParser(absolute, options.python)
    if (!result.ok) {
      if (result.reason === 'needs_ocr') return { status: 'needs_ocr', reason: 'scanned_pdf', parser: 'python', error: result.error }
      return { status: 'unparsed', reason: result.reason || 'corrupt', parser: 'python', error: result.error }
    }
    return { status: 'parsed', parser: 'python', blocks: result.blocks || [], tables: result.tables || [] }
  }
  // 文本类
  let text
  try { text = await readFile(absolute, 'utf8') } catch (error) {
    return { status: 'failed', reason: 'unreadable', parser: 'text', error: error.message }
  }
  if (text.includes('\u0000')) return { status: 'unparsed', reason: 'binary', parser: 'text' }
  if (ext === '.json') {
    try {
      const document = JSON.parse(text.replace(/^\uFEFF/, ''))
      return { status: 'parsed', parser: 'json', blocks: textBlocks(JSON.stringify(document, null, 2)), document }
    } catch (error) {
      return { status: 'failed', reason: 'invalid_json', parser: 'json', error: error.message }
    }
  }
  if (ext === '.csv' || ext === '.tsv') {
    const rows = ext === '.tsv' ? text.split(/\r?\n/).map(line => line.split('\t')).filter(cells => cells.some(cell => cell.trim() !== '')) : parseCsv(text)
    if (!rows.length) return { status: 'parsed', parser: 'table', blocks: [], tables: [] }
    const headers = rows[0].map(cell => String(cell).trim())
    return {
      status: 'parsed',
      parser: 'table',
      tables: [{ ref: { row: 1 }, headers, rows: rows.slice(1, 5001) }],
      blocks: textBlocks(rows.slice(0, 50).map(cells => cells.join(' | ')).join('\n')),
    }
  }
  return { status: 'parsed', parser: 'text', blocks: textBlocks(text) }
}

async function walk(root, options, state) {
  const entries = []
  const excludedRules = new Map()
  const notes = []
  const maxDepth = Number(options.maxDepth) || 8
  const maxFiles = Number(options.maxFiles) || 5000
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    let items
    try { items = await readdir(dir, { withFileTypes: true }) } catch (error) {
      notes.push({ kind: 'directory_unreadable', path: posix(path.relative(root, dir)), error: error.message })
      continue
    }
    items.sort((a, b) => a.name.localeCompare(b.name))
    for (const item of items) {
      if (state.files >= maxFiles) { state.truncated = true; break }
      const absolute = path.join(dir, item.name)
      const relative = posix(path.relative(root, absolute))
      if (item.isSymbolicLink()) {
        if (!options.followSymlinks) {
          excludedRules.set(relative, 'symlink')
          state.skipped += 1
          continue
        }
        notes.push({ kind: 'symlink_followed', path: relative })
      }
      if (item.isDirectory()) {
        const rule = excluded(relative, item.name, options.excludes)
        if (rule) { excludedRules.set(relative, rule); state.skipped += 1; continue }
        if (depth + 1 > maxDepth) { notes.push({ kind: 'depth_limit', path: relative }); continue }
        stack.push({ dir: absolute, depth: depth + 1 })
        continue
      }
      if (!item.isFile()) continue
      const rule = excluded(relative, item.name, options.excludes)
      if (rule) { excludedRules.set(relative, rule); state.skipped += 1; continue }
      entries.push({ absolute, relative })
      state.files += 1
    }
  }
  return { entries, excludedRules, notes }
}

/**
 * 扫描材料目录。不移动/不改名/不覆盖；默认不跟随符号链接；有数量/大小/深度上限。
 * @param {object} options
 * @param {string} options.root 材料目录（工作区）
 * @param {string[]} [options.excludes] 额外排除规则
 * @param {object} [options.previous] 上次扫描结果，用于"只重解析 hash 改变的文件"
 * @param {object} [options.python] { pythonPath, pdfLibDir, timeoutMs }
 */
export async function scanMaterials(options = {}) {
  if (!options.root || !existsSync(options.root)) throw new MaterialsError('source_invalid', '材料目录不存在：' + options.root)
  const root = path.resolve(options.root)
  const limits = {
    maxFiles: Number(options.maxFiles) || 5000,
    maxDepth: Number(options.maxDepth) || 8,
    maxBytes: Number(options.maxBytes) || 200 * 1024 * 1024,
    maxParseBytes: Number(options.maxParseBytes) || 16 * 1024 * 1024,
    timeoutMs: Number(options.timeoutMs) || 60000,
  }
  const python = pythonRunner(options.python || {})
  const rules = { excludes: [...DEFAULT_EXCLUDES, ...(options.excludes || [])], followSymlinks: Boolean(options.followSymlinks), limits }
  const rulesHash = sha(JSON.stringify(rules), 16)
  const startedAt = Date.now()
  const state = { files: 0, skipped: 0, truncated: false }
  const walkResult = await walk(root, { ...options, ...limits }, state)
  const previous = options.previous && Array.isArray(options.previous.files) ? options.previous : null
  const previousByPath = new Map()
  if (previous) for (const file of previous.files) previousByPath.set(file.path, file)

  const files = []
  let parsed = 0, needsOcr = 0, unparsed = 0, failed = 0, reused = 0, totalBytes = 0
  const byKind = {}
  for (const entry of walkResult.entries) {
    if (Date.now() - startedAt > limits.timeoutMs) {
      walkResult.notes.push({ kind: 'time_limit', atFiles: files.length })
      break
    }
    let info
    try { info = await lstat(entry.absolute) } catch (error) {
      files.push({ path: entry.relative, kind: classifyFile(entry.absolute), ext: parseExtension(entry.absolute), bytes: 0, sha256: null, parse: { status: 'failed', reason: 'unreadable', error: error.message } })
      failed += 1
      continue
    }
    if (totalBytes + info.size > limits.maxBytes) {
      walkResult.notes.push({ kind: 'byte_limit', path: entry.relative })
      break
    }
    let buffer
    try { buffer = await readFile(entry.absolute) } catch (error) {
      files.push({ path: entry.relative, kind: classifyFile(entry.absolute), ext: parseExtension(entry.absolute), bytes: info.size, sha256: null, parse: { status: 'failed', reason: 'unreadable', error: error.message } })
      failed += 1
      continue
    }
    const hash = sha(buffer)
    totalBytes += info.size
    const kind = classifyFile(entry.absolute)
    const ext = parseExtension(entry.absolute)
    const record = { path: entry.relative, kind, ext, bytes: info.size, sha256: hash, mtimeMs: Math.round(info.mtimeMs) }
    const before = previousByPath.get(record.path)
    if (before && before.sha256 === hash && before.parse && ['parsed', 'needs_ocr', 'unparsed', 'failed'].includes(before.parse.status)) {
      record.parse = { ...before.parse, reused: true }
      reused += 1
    } else {
      record.parse = await parseOneFile({ ...record, absolute: entry.absolute }, { ...limits, python, maxParseBytes: limits.maxParseBytes })
    }
    if (record.parse.status === 'parsed') parsed += 1
    else if (record.parse.status === 'needs_ocr') needsOcr += 1
    else if (record.parse.status === 'failed') failed += 1
    else if (record.parse.status !== 'skipped') unparsed += 1
    byKind[kind] = (byKind[kind] || 0) + 1
    files.push(record)
  }
  const considered = files.length
  const changes = []
  if (previous) {
    const seen = new Set()
    for (const file of files) {
      seen.add(file.path)
      const before = previousByPath.get(file.path)
      if (!before) changes.push({ path: file.path, kind: 'added' })
      else if (before.sha256 !== file.sha256) changes.push({ path: file.path, kind: 'modified', beforeSha256: before.sha256, afterSha256: file.sha256 })
    }
    for (const file of previous.files || []) if (!seen.has(file.path)) changes.push({ path: file.path, kind: 'removed', beforeSha256: file.sha256 })
  }
  const coverage = {
    files: considered,
    parsed,
    needsOcr,
    unparsed,
    failed,
    skipped: state.skipped,
    excludedRules: Object.fromEntries(walkResult.excludedRules),
    coverageRatio: considered ? Math.round((parsed / considered) * 1000) / 1000 : 0,
    totalBytes,
    byKind,
  }
  return {
    schemaVersion: MATERIALS_SCHEMA_VERSION,
    scanId: `scan-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${sha(root + rulesHash, 6)}`,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    root,
    rulesHash,
    rules,
    coverage,
    files,
    reused,
    changes,
    truncated: state.truncated,
    notes: walkResult.notes,
  }
}

/* ------------------------------------------------------------------ *
 * 候选提取
 * ------------------------------------------------------------------ */

function snippet(text, limit = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > limit ? clean.slice(0, limit) + '…' : clean
}

function evidenceOf(file, ref, text) {
  return { path: file.path, sha256: file.sha256, ref: ref || null, snippet: snippet(text) }
}

const VISIT_LINE = /^(?:访视|阶段|时点|时间点)\s*[：:]\s*(.+)$|^((?:T\d+|baseline|基线|筛查|随访|第[一二三四五六七八九十0-9]+周|week\s*\d+))\s*(?:[：:\-—]\s*(.+))?$/i
const SCALE_LINE = /(量表|问卷|scale|questionnaire)[^。；\n]{0,40}?(\d+)\s*(?:道)?题/i
const REVERSE_LINE = /(?:反向题|反向计分|reverse(?:\s|-)?scored?)[^。；\n]{0,60}?([0-9]+(?:\s*[、,，]\s*[0-9]+)*)/i
const TASK_LINE = /^(?:任务|电脑任务|实验任务|task)\s*[：:]\s*(.+)$|^[-*]\s*(?:任务|电脑任务)\s*[：:]\s*(.+)$/i
const OUTCOME_LINE = /(主要结局|primary\s+outcome|主分析|main\s+analysis|混合模型|mixed[\s-]?effects?|anova|回归|regression)[^。；\n]{0,80}/i
const DEMO_HEADER = /^(性别|sex|gender|年龄|age|出生|birth|教育|education|学历|收入|income|婚姻|marital|专业|major|年级|grade|职业|occupation)$/i
const ID_HEADER = /^(编号|被试编号|participant\s*id|participantid|subject\s*id|id|code)$/i

/** 从清单里抽候选：每项都带 observed / inferred / unresolved 证据等级与来源位置。 */
export function extractFindings(inventory, options = {}) {
  const candidates = []
  const instructionLike = []
  const unresolved = []
  const seen = new Set()
  const push = (candidate) => {
    const key = `${candidate.kind}|${candidate.label}|${candidate.evidence[0]?.path || ''}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(candidate)
  }
  for (const file of inventory.files || []) {
    if (file.parse && file.parse.status === 'needs_ocr') {
      unresolved.push({ kind: 'needs_ocr', path: file.path, text: `需要 OCR 或人工转录：${file.path}` })
      continue
    }
    if (file.parse && file.parse.status !== 'parsed' && file.parse.status !== 'skipped') {
      unresolved.push({ kind: file.parse.reason || 'unparsed', path: file.path, text: `未解析：${file.path}（${file.parse.reason || file.parse.status}）` })
      continue
    }
    if (!file.parse) continue
    for (const block of file.parse.blocks || []) {
      const text = String(block.text || '')
      if (PROMPT_INJECTION.test(text)) instructionLike.push({ path: file.path, ref: block, snippet: snippet(text, 200) })
      const visit = VISIT_LINE.exec(text)
      if (visit) {
        const label = String(visit[1] || visit[2] || '').trim()
        if (label && label.length <= 30) push({ kind: 'visit', label, level: 'observed', evidence: [evidenceOf(file, block, text)] })
      }
      const scale = SCALE_LINE.exec(text)
      if (scale) {
        // 名称取"题量之前、去掉通用前缀"的部分：量表：花园量表 10 题 → 花园量表
        const name = text
          .replace(/\s*\d+\s*(?:道)?题[\s\S]*$/, '')
          .replace(/^[\s\S]*?(?:量表|问卷|scale|questionnaire)\s*[：:\-—]?\s*/i, '')
          .trim()
          .slice(0, 60)
        push({
          kind: 'scoring', label: name || '未命名量表',
          value: { itemCount: Number(scale[2]), reverseItems: [], raw: snippet(text) },
          level: 'inferred', mapping: 'pending', evidence: [evidenceOf(file, block, text)],
        })
      }
      const reverse = REVERSE_LINE.exec(text)
      if (reverse) {
        const items = reverse[1].split(/[、,，\s]+/).map(Number).filter(Number.isFinite)
        const last = candidates.filter(row => row.kind === 'scoring').slice(-1)[0]
        if (last) {
          last.value.reverseItems = items
          last.evidence.push(evidenceOf(file, block, text))
        } else {
          push({ kind: 'scoring', label: '未命名量表', value: { itemCount: null, reverseItems: items }, level: 'inferred', mapping: 'pending', evidence: [evidenceOf(file, block, text)] })
        }
      }
      const task = TASK_LINE.exec(text)
      if (task) {
        const label = String(task[1] || task[2] || '').trim()
        if (label) push({ kind: 'task', label, level: 'observed', evidence: [evidenceOf(file, block, text)] })
      }
      const outcome = OUTCOME_LINE.exec(text)
      if (outcome) push({ kind: 'outcome', label: outcome[0].trim().slice(0, 80), level: 'observed', evidence: [evidenceOf(file, block, text)] })
    }
    for (const table of file.parse.tables || []) {
      const headers = (table.headers || (table.rows && table.rows[0]) || []).map(cell => String(cell).trim())
      for (const header of headers) {
        if (DEMO_HEADER.test(header)) push({ kind: 'demographicVariable', label: header, level: 'observed', evidence: [evidenceOf(file, table.ref, headers.join(' | '))] })
        if (ID_HEADER.test(header)) push({ kind: 'participantIdColumn', label: header, level: 'observed', evidence: [evidenceOf(file, table.ref, headers.join(' | '))] })
      }
      if (headers.length && headers.some(header => ID_HEADER.test(header))) {
        const idIndex = headers.findIndex(header => ID_HEADER.test(header))
        const sample = (table.rows && table.rows[1] && table.rows[1][idIndex]) || ''
        if (sample) {
          const pattern = /^\d+$/.test(sample) ? `^\\d{${String(sample).length}}$` : `^${String(sample).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d/g, '\\d')}$`
          push({ kind: 'participantIdPattern', label: pattern, level: 'inferred', evidence: [evidenceOf(file, { ...table.ref, row: 2 }, sample)] })
        }
      }
    }
  }
  const conflicts = detectConflicts(candidates)
  return {
    schemaVersion: MATERIALS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scanId: inventory.scanId || null,
    root: inventory.root || null,
    counts: { candidates: candidates.length, conflicts: conflicts.length, unresolved: unresolved.length, instructionLike: instructionLike.length, changes: (inventory.changes || []).length },
    candidates,
    conflicts,
    unresolved,
    instructionLike,
    changes: inventory.changes || [],
    notes: (inventory.notes || []).map(note => ({ ...note, text: '扫描提示：' + (note.kind || '') })),
  }
}

/** 同一量表出现互斥计分规则时生成冲突项，不合并、不自动批准（PREP-01）。 */
export function detectConflicts(candidates) {
  const groups = new Map()
  for (const candidate of candidates) {
    if (candidate.kind !== 'scoring' || !candidate.value) continue
    const key = String(candidate.label || '').replace(/\s+/g, '').toLowerCase()
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(candidate)
  }
  const conflicts = []
  for (const [key, rows] of groups) {
    const signatures = new Set(rows.map(row => `${row.value.itemCount ?? '?'}|${(row.value.reverseItems || []).join(',')}`))
    if (signatures.size <= 1) continue
    conflicts.push({
      id: `conflict-scoring-${sha(key, 10)}`,
      kind: 'scoring_rule',
      label: rows[0].label,
      status: 'pending',
      severity: 'high',
      options: rows.map(row => ({ itemCount: row.value.itemCount ?? null, reverseItems: row.value.reverseItems || [], evidence: row.evidence })),
      text: `量表「${rows[0].label}」出现了 ${signatures.size} 组不同的计分规则，需要人工确认后才会进入正式计分。`,
    })
  }
  return conflicts
}

/* ------------------------------------------------------------------ *
 * 缺项与准备度
 * ------------------------------------------------------------------ */

const GAP_DEFS = [
  { id: 'materials-id', category: 'materials', severity: 'high', blockingFor: ['import'], test: f => !f.candidates.some(row => row.kind === 'participantIdColumn') && !f.candidates.some(row => row.kind === 'participantIdPattern'), text: '没有找到参与者编号列或编号样例，导入前需要确认编号规则。', suggestedAction: '在人口学表或任务导出里标出编号列，或直接给出编号样例。' },
  { id: 'config-visits', category: 'config', severity: 'high', blockingFor: ['run-console'], test: f => !f.candidates.some(row => row.kind === 'visit'), text: '没有识别到访视/时点，运行台无法组织任务列。', suggestedAction: '提供方案或流程表，或在草案里手工加入访视。' },
  { id: 'config-tasks', category: 'config', severity: 'medium', blockingFor: ['run-console'], test: f => !f.candidates.some(row => row.kind === 'task'), text: '没有识别到任务/问卷，准备度无法判断采集环节。', suggestedAction: '提供量表清单或任务说明。' },
  { id: 'scoring-conflict', category: 'scoring', severity: 'high', blockingFor: ['scoring'], test: f => f.conflicts.length > 0, text: '存在互斥的计分规则，必须人工确认后才能计分。', suggestedAction: '在冲突项里选定一版，或注明以哪份材料为准。' },
  { id: 'analysis-outcome', category: 'analysis', severity: 'high', blockingFor: ['analysis'], test: f => !f.candidates.some(row => row.kind === 'outcome'), text: '没有明确的主要结局或分析计划。', suggestedAction: '提供分析计划或明确主要结局；未说明项保持未知，不要从既有数据反推。' },
  { id: 'materials-unparsed', category: 'materials', severity: 'low', blockingFor: [], test: f => f.unresolved.length > 0, text: '存在未解析材料（扫描件/加密/压缩包/旧格式），相关内容没有进入候选。', suggestedAction: '需要时补 OCR、解密或另存为新格式；不影响已识别部分的可用性。' },
]

export function buildGaps(findings) {
  const gaps = []
  for (const def of GAP_DEFS) {
    if (!def.test(findings)) continue
    gaps.push({
      id: def.id,
      category: def.category,
      severity: def.severity,
      status: 'open',
      text: def.text,
      suggestedAction: def.suggestedAction,
      blockingFor: def.blockingFor,
      sourceRefs: (findings.unresolved || []).slice(0, 3).map(row => ({ path: row.path, text: row.text })),
    })
  }
  // 未解析材料逐条列出，便于点开定位（但不升级为阻断项）。
  for (const row of findings.unresolved || []) {
    gaps.push({ id: `unresolved-${sha(row.path, 8)}`, category: 'materials', severity: 'low', status: 'open', text: row.text, suggestedAction: '确认是否需要 OCR／解密／转换格式。', blockingFor: [], sourceRefs: [{ path: row.path }] })
  }
  return gaps
}

export function markGapStatus(findings, gapId, status, reason = '') {
  const gaps = Array.isArray(findings.gaps) ? findings.gaps : []
  const target = gaps.find(row => row.id === gapId)
  if (!target) throw new MaterialsError('not_found', '没有这个缺项：' + gapId)
  if (!['open', 'not_applicable', 'resolved'].includes(status)) throw new MaterialsError('invalid', '状态只能是 open / not_applicable / resolved')
  target.status = status
  if (reason) target.reason = String(reason).slice(0, 500)
  target.updatedAt = new Date().toISOString()
  return target
}

const pythonCache = new Map()

function checkPython(python = {}) {
  const key = `${python.pythonPath || ''}|${python.pdfLibDir || ''}`
  if (pythonCache.has(key)) return pythonCache.get(key)
  const pending = new Promise(resolve => {
    if (!python.pythonPath) { resolve({ available: false, reason: '未配置本机 Python 路径' }); return }
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    if (python.pdfLibDir) env.PYTHONPATH = [python.pdfLibDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
    const code = 'import sys,json;out={"python":sys.version.split()[0],"packages":{}};' +
      'mods={"numpy":"numpy","pandas":"pandas","openpyxl":"openpyxl","python-docx":"docx","pymupdf":"fitz"}\n' +
      'for name,mod in mods.items():\n try:\n  m=__import__(mod); out["packages"][name]=getattr(m,"__version__","ok")\n except Exception: out["packages"][name]=None\n' +
      'print("===JSON==="+json.dumps(out))'
    const child = spawn(python.pythonPath, ['-X', 'utf8', '-c', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    let stdout = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } resolve({ available: false, reason: '检测超时' }) }, 15000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.on('error', error => { clearTimeout(timer); resolve({ available: false, reason: error.message }) })
    child.on('close', () => {
      clearTimeout(timer)
      const marker = stdout.lastIndexOf('===JSON===')
      if (marker < 0) { resolve({ available: false, reason: '检测失败' }); return }
      try { resolve({ available: true, ...JSON.parse(stdout.slice(marker + 10).trim()) }) } catch (error) { resolve({ available: false, reason: error.message }) }
    })
  })
  pythonCache.set(key, pending)
  return pending
}

/**
 * 准备度按环境分别判断：材料、配置、统计环境、演练。没有一个百分比能掩盖关键缺项。
 */
export async function assessReadiness(options = {}) {
  const { inventory, findings, draft } = options
  const blockers = []
  const pending = []
  const gaps = Array.isArray(findings?.gaps) ? findings.gaps : []
  const openHigh = gaps.filter(gap => gap.status === 'open' && gap.severity === 'high')
  for (const gap of openHigh) blockers.push({ id: gap.id, category: gap.category, text: gap.text })
  for (const conflict of findings?.conflicts || []) pending.push({ id: conflict.id, kind: conflict.kind, text: conflict.text })
  for (const row of findings?.unresolved || []) pending.push({ id: row.path, kind: row.kind, text: row.text })
  for (const candidate of (findings?.candidates || []).filter(row => row.mapping === 'pending')) pending.push({ id: `${candidate.kind}:${candidate.label}`, kind: 'pending_mapping', text: `待映射：${candidate.kind} ${candidate.label}` })
  for (const change of findings?.changes || []) pending.push({ id: `change-${change.path}`, kind: 'needs_review', text: `来源已变化（${change.kind}）：${change.path}，相关配置需复核，不后台改动正式规则` })

  const coverage = inventory?.coverage || { files: 0, parsed: 0, coverageRatio: 0 }
  const materialsState = coverage.files === 0 ? 'blocked' : (openHigh.some(gap => gap.category === 'materials') ? 'blocked' : (coverage.coverageRatio >= 0.8 ? 'ok' : 'partial'))

  const draftProblems = draft ? validateStudyDraft(draft) : ['还没有研究配置草案']
  const configState = draftProblems.length === 0 ? 'ok' : (draft ? 'partial' : 'blocked')
  const configuration = {
    state: configState,
    problems: draftProblems,
    confirmed: draft ? { visits: (draft.visits || []).length, tasks: (draft.tasks || []).length, followups: (draft.followups || []).length, hasParticipantPattern: Boolean(draft.participantId?.pattern) } : null,
  }

  const python = await checkPython(options.python || {})
  const requiredGlobals = ['pandas', 'numpy']
  const missingRuntime = python.available ? requiredGlobals.filter(name => !python.packages?.[name]) : requiredGlobals
  const statisticsEnvironment = {
    state: !python.available ? 'blocked' : (missingRuntime.length ? 'partial' : 'ok'),
    python: python.available ? { version: python.python, packages: python.packages } : null,
    missing: missingRuntime,
    notes: python.available
      ? (missingRuntime.length ? `缺少 ${missingRuntime.join('、')}，统计与部分解析会不可用。` : '本机 Python 与统计依赖可用。')
      : `本机 Python 不可用：${python.reason}。DOCX/XLSX/PDF 解析与统计将不可用（不会转云端）。`,
  }

  const dryRun = options.dryRun || { state: 'unknown', sources: [], notes: ['还没有跑演练'] }

  const readiness = {
    schemaVersion: MATERIALS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    areas: {
      materials: { state: materialsState, coverage, blockers: openHigh.filter(gap => gap.category === 'materials').map(gap => gap.id) },
      configuration,
      statisticsEnvironment,
      dryRun,
    },
    blockers,
    pending,
    canStart: blockers.length === 0 && draftProblems.length === 0 && (python.available || options.pythonNotRequired === true),
  }
  return readiness
}

/* ------------------------------------------------------------------ *
 * 研究草案
 * ------------------------------------------------------------------ */

const STUDY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export function validateStudyDraft(draft) {
  const problems = []
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return ['研究定义必须是 JSON 对象']
  if (draft.schemaVersion !== 1) problems.push('schemaVersion 必须为 1')
  if (!STUDY_ID_RE.test(String(draft.studyId || '').trim())) problems.push('studyId 需为 1–80 个字母、数字、点、下划线或连字符')
  if (!String(draft.name || '').trim()) problems.push('研究名称不能为空')
  if (draft.dataRoot !== undefined && !String(draft.dataRoot || '').trim()) problems.push('dataRoot 需为非空路径字符串')
  if (draft.participants !== undefined && (typeof draft.participants !== 'object' || draft.participants === null || Array.isArray(draft.participants))) problems.push('participants 需为对象')
  const ids = {}
  for (const kind of ['visits', 'tasks', 'followups']) {
    if (draft[kind] !== undefined && !Array.isArray(draft[kind])) { problems.push(`${kind} 需为数组`); continue }
    const found = new Set()
    for (const row of draft[kind] || []) {
      if (!row || typeof row !== 'object' || !String(row.id || '').trim()) { problems.push(`${kind} 中每项需有非空 id`); continue }
      if (found.has(row.id)) problems.push(`${kind} 重复 id：${row.id}`)
      found.add(row.id)
    }
    ids[kind] = found
  }
  for (const task of draft.tasks || []) {
    if (task && task.visits !== undefined && !Array.isArray(task.visits)) { problems.push(`任务${task.id}的visits需为数组`); continue }
    for (const visit of task?.visits || []) if (!ids.visits?.has(visit)) problems.push(`任务${task.id}引用未知访视${visit}`)
  }
  for (const followup of draft.followups || []) {
    if (!followup || !ids.visits?.has(followup.anchorVisit)) problems.push(`随访${followup?.id}引用未知锚点${followup?.anchorVisit}`)
  }
  if (draft.plugins !== undefined && (typeof draft.plugins !== 'object' || draft.plugins === null || Array.isArray(draft.plugins))) problems.push('plugins 需为对象')
  return problems
}

/**
 * 从已确认的候选生成草案。mapping 仍为 pending 的候选不会进入正式配置。
 * decisions: { [candidateKey]: 'accept' | 'reject' }，未出现的按"只接受 observed 且非 pending"处理。
 */
export function buildStudyDraft(options = {}) {
  const findings = options.findings || {}
  const decisions = options.decisions || {}
  const accepted = (findings.candidates || []).filter(candidate => {
    const key = candidateKey(candidate)
    if (decisions[key] === 'reject') return false
    if (decisions[key] === 'accept') return true
    return candidate.level === 'observed' && candidate.mapping !== 'pending' && candidate.kind !== 'participantIdPattern'
  })
  const visits = []
  const visitByLabel = new Map()
  for (const candidate of accepted.filter(row => row.kind === 'visit')) {
    const id = String(candidate.label).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || `visit-${visits.length + 1}`
    if (visitByLabel.has(id)) continue
    visitByLabel.set(id, true)
    visits.push({ id, label: String(candidate.label).slice(0, 60), order: visits.length })
  }
  const tasks = []
  for (const candidate of accepted.filter(row => row.kind === 'task')) {
    const id = String(candidate.label).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || `task-${tasks.length + 1}`
    if (tasks.some(row => row.id === id)) continue
    tasks.push({ id, label: String(candidate.label).slice(0, 60), visits: visits.map(row => row.id) })
  }
  const patternCandidate = (findings.candidates || []).find(row => row.kind === 'participantIdPattern' && decisions[candidateKey(row)] === 'accept')
  const draft = {
    schemaVersion: 1,
    studyId: options.studyId || `study-${sha(String(options.root || findings.root || '') + Date.now(), 8)}`,
    name: options.name || '未命名研究（由材料草案生成）',
    dataRoot: options.dataRoot || './data',
    participantId: patternCandidate ? { pattern: patternCandidate.label } : {},
    visits,
    tasks,
    followups: [],
    plugins: options.plugins || {},
  }
  return draft
}

export function candidateKey(candidate) {
  return `${candidate.kind}|${candidate.label}|${candidate.evidence?.[0]?.path || ''}`
}

export function diffStudyDraft(current, next) {
  const rows = []
  const walk = (a, b, prefix) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return
    const bothObjects = a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)
    if (bothObjects) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], prefix ? `${prefix}.${key}` : key)
      return
    }
    rows.push({ path: prefix || '(root)', before: a ?? null, after: b ?? null })
  }
  walk(current || null, next || null, '')
  return rows
}

/** 独占创建或按 revision 更新；不覆盖未知变更。 */
export function writeStudyDraft(options = {}) {
  const target = options.path
  if (!target || !path.isAbsolute(target)) throw new MaterialsError('invalid', '研究定义需要绝对路径')
  const problems = validateStudyDraft(options.draft)
  if (problems.length) throw new MaterialsError('invalid', problems.join('；'))
  const text = JSON.stringify(options.draft, null, 2) + '\n'
  const revision = sha(text)
  if (options.mode === 'create') {
    mkdirSync(path.dirname(target), { recursive: true })
    try { writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' }) } catch (error) {
      if (error.code === 'EEXIST') throw new MaterialsError('dataset_conflict', '研究定义已存在，请选择更新或换一个路径')
      throw error
    }
    return { created: true, path: target, revision }
  }
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : null
  if (existing === null) {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, text, { encoding: 'utf8' })
    return { created: true, path: target, revision }
  }
  if (options.expectedRevision && sha(existing) !== options.expectedRevision) {
    throw new MaterialsError('dataset_conflict', '研究定义已被改动，请重新预览后再保存')
  }
  if (!options.expectedRevision && options.force !== true) {
    throw new MaterialsError('dataset_conflict', '更新研究定义需要 expectedRevision（先预览）')
  }
  atomicWrite(target, text)
  return { created: false, path: target, revision }
}

/* ------------------------------------------------------------------ *
 * 派生索引
 * ------------------------------------------------------------------ */

export function saveMaterialsIndex(options = {}) {
  const dir = options.dir
  if (!dir || !path.isAbsolute(dir)) throw new MaterialsError('invalid', '索引目录需要绝对路径')
  const base = path.join(dir, 'index')
  atomicWrite(path.join(base, 'materials.json'), JSON.stringify(options.inventory, null, 2))
  if (options.findings) atomicWrite(path.join(base, 'findings.json'), JSON.stringify(options.findings, null, 2))
  if (options.readiness) atomicWrite(path.join(base, 'readiness.json'), JSON.stringify(options.readiness, null, 2))
  if (options.report) atomicWrite(path.join(base, 'prep-report.md'), String(options.report))
  return { dir: base, files: ['materials.json', 'findings.json', 'readiness.json', 'prep-report.md'].filter(name => existsSync(path.join(base, name))) }
}

export function loadMaterialsIndex(dir) {
  if (!dir) throw new MaterialsError('invalid', '需要索引目录')
  const base = path.join(dir, 'index')
  const read = name => { try { return JSON.parse(readFileSync(path.join(base, name), 'utf8')) } catch { return null } }
  return { inventory: read('materials.json'), findings: read('findings.json'), readiness: read('readiness.json'), report: (() => { try { return readFileSync(path.join(base, 'prep-report.md'), 'utf8') } catch { return null } })() }
}

/* ------------------------------------------------------------------ *
 * 可读报告
 * ------------------------------------------------------------------ */

export function renderPrepReport({ inventory, findings, readiness }) {
  const lines = []
  const coverage = inventory?.coverage || {}
  lines.push('# 材料接入与准备度报告')
  lines.push('')
  lines.push(`生成时间：${new Date().toISOString()}`)
  lines.push(`材料目录：${inventory?.root || '—'}`)
  lines.push('')
  lines.push('## 覆盖范围')
  lines.push('')
  lines.push(`- 文件：${coverage.files ?? 0}（已解析 ${coverage.parsed ?? 0}，需要 OCR ${coverage.needsOcr ?? 0}，未解析 ${coverage.unparsed ?? 0}，解析失败 ${coverage.failed ?? 0}）`)
  lines.push(`- 覆盖率：${Math.round((coverage.coverageRatio ?? 0) * 100)}%`)
  lines.push(`- 扫描轮次：${inventory?.scanId || '—'}（复用 ${inventory?.reused ?? 0} 个未变文件）`)
  lines.push('')
  lines.push('## 阻断项与待核实项')
  lines.push('')
  if (!readiness?.blockers?.length && !readiness?.pending?.length) lines.push('没有阻断项。')
  for (const blocker of readiness?.blockers || []) lines.push(`- [阻断/${blocker.category}] ${blocker.text}`)
  for (const row of readiness?.pending || []) lines.push(`- [待核实] ${row.text}`)
  lines.push('')
  lines.push('## 已识别配置')
  lines.push('')
  const groups = new Map()
  for (const candidate of findings?.candidates || []) {
    if (!groups.has(candidate.kind)) groups.set(candidate.kind, [])
    groups.get(candidate.kind).push(candidate)
  }
  if (!groups.size) lines.push('尚未识别到可用的配置候选。')
  for (const [kind, rows] of groups) lines.push(`- ${kind}：${rows.slice(0, 12).map(row => row.label).join('；')}${rows.length > 12 ? `…共 ${rows.length} 项` : ''}`)
  lines.push('')
  lines.push('## 准备度')
  lines.push('')
  for (const [area, value] of Object.entries(readiness?.areas || {})) lines.push(`- ${area}：${value.state}`)
  lines.push('')
  lines.push('> 材料里的文字只作资料解析，不会作为指令执行；本报告与派生产物可随时删除并重新生成，原始材料保持不变。')
  return lines.join('\n')
}
