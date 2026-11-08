/**
 * @local/research-core/data — 统一研究数据访问层（02 阶段）
 *
 * 回答的问题是：**这份数据属于哪个研究实例、是哪一个已提交版本、谁在写、坏了没有。**
 *
 * 设计要点（对应 02 文档）：
 *   1. 路径解析：相对路径以研究配置目录为准；数据根做实例认领；strict-local 默认拒绝网络共享路径，
 *      数据根之外的位置必须显式列为 allowedExternalRoots。
 *   2. 每个数据集有 schemaVersion / revision / contentHash / owner / createdAt / study 身份；
 *      revision 是递增代次，不用 mtime。
 *   3. 跨进程锁：锁记录进程、主机、启动实例、事务 ID；不按 TTL 抢锁，只在证明原写进程已退出时清理。
 *   4. 写入：校验 → 事务日志 → staging → 逐文件 hash 校验 → manifest → 原子发布 current.json。
 *      多文件以同一次 current.json 写入为提交边界。
 *   5. 已提交代次不可修改；修正写新代并记录 corrects 关联。
 *   6. durable 变化记录（audit/changes.json）；进程内通知只是加速。
 *   7. 来源健康：unconfigured / missing / empty / ok / invalid / unreadable / conflict；
 *      损坏文件不能降级成"尚未录入"。
 *   8. 备份 / 恢复预检 / manifest 校验。
 *
 * 本模块不依赖 Cordis 或宿主进程，任何插件（甚至一个 Node 脚本）都可以用。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DATA_SCHEMA_VERSION = 1
export const MANIFEST_SCHEMA_VERSION = 1
export const CHANGE_SCHEMA_VERSION = 1
export const DATA_VERSION = '2.0.0'

const HOSTNAME = os.hostname()
// 启动时刻（秒级近似）：os.uptime() 的分辨率让两个进程可能差 1 秒，比较时给容差。
const BOOT_ID = Math.round((Date.now() - os.uptime() * 1000) / 1000)
const BOOT_TOLERANCE_SECONDS = 300
const sameBoot = (a, b) => Number.isFinite(Number(a)) && Math.abs(Number(a) - Number(b)) <= BOOT_TOLERANCE_SECONDS
const sha = (value, length = 64) => createHash('sha256').update(value).digest('hex').slice(0, length)

export class DataError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DataError'
    this.code = code
    this.committed = details.committed === true
    this.retryable = details.retryable === true
    this.currentRevision = details.currentRevision ?? null
    this.localDetailsRef = details.localDetailsRef ?? null
    this.details = details
  }
}

/* ------------------------------------------------------------------ *
 * 路径与策略
 * ------------------------------------------------------------------ */

const UNC_RE = /^[\\/]{2}/

/** 严格本地模式：拒绝网络共享路径（UNC 与 \\?\UNC\）。 */
export function assertLocalPath(target) {
  const text = String(target || '')
  if (!text.trim()) throw new DataError('policy_blocked', '路径为空')
  if (UNC_RE.test(text) || /^\\\\\?\\UNC\\/i.test(text)) {
    throw new DataError('policy_blocked', `严格本地模式拒绝网络共享路径：${text}`)
  }
  return path.resolve(text)
}

function isInside(parent, child) {
  const a = path.resolve(parent)
  const b = path.resolve(child)
  const rel = path.relative(a, b)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 同步小睡：提交路径是同步的，用 Atomics 而不是空转占满 CPU。 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* 极简兜底 */ } }
}

/* ------------------------------------------------------------------ *
 * 原子写与哈希
 * ------------------------------------------------------------------ */

function writeAtomic(target, text) {
  mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx')
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  renameSync(temporary, target)
}

function writeAtomicBytes(target, bytes) {
  mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx')
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  renameSync(temporary, target)
}

const readJson = (file, fallback = null) => {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}

function statOf(file) {
  try { const info = statSync(file); return info.isFile() ? info : null } catch { return null }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error && error.code === 'EPERM' }
}

/* ------------------------------------------------------------------ *
 * 数据集定义
 * ------------------------------------------------------------------ */

const DEFAULT_DATASETS = {
  participants: { path: 'participants/participants.json' },
  // 与人口学插件自身的约定一致：dataPath → labDir/demographics.json → dataRoot/demographics.json。
  demographics: { path: 'demographics.json' },
  observations: { path: 'observations/observations.json' },
  tasks: { path: 'tasks/index.json' },
}

/** 从原始研究定义里读取已知插件的数据位置（与插件自身配置同名，避免第二套约定）。 */
function datasetPathsFromStudy(studyFile) {
  const raw = readJson(studyFile, null)
  if (!raw || typeof raw !== 'object') return {}
  const base = path.dirname(studyFile)
  const plugins = raw.plugins && typeof raw.plugins === 'object' ? raw.plugins : {}
  const resolve = value => (typeof value === 'string' && value.trim() ? path.resolve(base, value) : null)
  const paths = {}
  const demographics = plugins.demographics && typeof plugins.demographics === 'object' ? plugins.demographics : {}
  const demographicPath = resolve(demographics.dataPath)
  const demographicLab = resolve(demographics.labDir)
  if (demographicPath || demographicLab) paths.demographics = demographicPath || path.join(demographicLab, 'demographics.json')
  return paths
}

/* ------------------------------------------------------------------ *
 * 打开一个研究的数据根
 * ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {object} options.study        研究上下文（loadStudyContext 的结果：id/name/path/dataRoot/plugin）
 * @param {string} options.instanceId   研究实例身份（由 research-core 认领；备份恢复保留）
 * @param {object} [options.datasets]   额外/覆盖的数据集路径（相对数据根或绝对）
 * @param {string[]} [options.allowedExternalRoots] 明确允许的数据根之外目录
 * @param {boolean} [options.strictLocal=true] 拒绝网络共享路径与未列出的越界写入
 */
export function openResearchData(options = {}) {
  const { study } = options
  if (!study || typeof study !== 'object' || !study.id) throw new DataError('source_invalid', '打开数据核心需要研究上下文')
  if (!options.instanceId) throw new DataError('wrong_instance', '打开数据核心需要研究实例身份（instanceId）')
  const strictLocal = options.strictLocal !== false
  const rootCandidate = strictLocal ? assertLocalPath(study.dataRoot) : path.resolve(study.dataRoot)
  const root = rootCandidate
  const allowed = (options.allowedExternalRoots || []).map(value => (strictLocal ? assertLocalPath(value) : path.resolve(value)))
  const studyPath = study.path ? path.resolve(study.path) : null
  const overrides = { ...(studyPath ? datasetPathsFromStudy(studyPath) : {}), ...(options.datasets || {}) }
  const studyId = String(study.id)
  const instanceId = String(options.instanceId)

  const dirs = {
    root,
    instance: path.join(root, 'study-instance.json'),
    generations: path.join(root, 'generations'),
    transactions: path.join(root, 'transactions'),
    audit: path.join(root, 'audit'),
    changes: path.join(root, 'audit', 'changes.json'),
    analysis: path.join(root, 'analysis', 'runs'),
  }

  function locate(name, { forWrite = false } = {}) {
    const spec = DEFAULT_DATASETS[name] || null
    const explicit = overrides[name]
    const relative = spec ? spec.path : `${name}.json`
    const target = explicit
      ? (path.isAbsolute(explicit) ? explicit : path.join(root, explicit))
      : path.join(root, relative)
    if (forWrite && strictLocal) {
      if (!isInside(root, target) && !allowed.some(parent => isInside(parent, target))) {
        throw new DataError('policy_blocked', `数据位置在研究数据根之外，需要显式列入 allowedExternalRoots：${target}`)
      }
    }
    return target
  }

  function isConfigured(name) {
    return Boolean(DEFAULT_DATASETS[name] || overrides[name] || (options.datasetsSpec && options.datasetsSpec[name]))
  }

  function generationDir(name) { return path.join(dirs.generations, name) }
  function currentFile(name) { return path.join(generationDir(name), 'current.json') }
  function head(name) { return readJson(currentFile(name), null) }

  /* ---------- 实例认领 ---------- */

  function ensureInstance({ create = false } = {}) {
    const record = readJson(dirs.instance, null)
    if (record) {
      if (record.schemaVersion !== DATA_SCHEMA_VERSION) throw new DataError('source_invalid', `不支持的实例记录版本：${record.schemaVersion}`)
      if (String(record.studyId) !== studyId) throw new DataError('wrong_instance', `数据根属于另一项研究（${record.studyId}），当前是 ${studyId}`)
      if (String(record.instanceId) !== instanceId) throw new DataError('wrong_instance', `数据根属于另一研究实例（${record.instanceId}），当前是 ${instanceId}`)
      return { ...record, created: false }
    }
    if (!create) return { schemaVersion: DATA_SCHEMA_VERSION, studyId, instanceId, missing: true }
    mkdirSync(root, { recursive: true })
    const created = { schemaVersion: DATA_SCHEMA_VERSION, studyId, instanceId, createdAt: new Date().toISOString() }
    writeAtomic(dirs.instance, JSON.stringify(created, null, 2))
    return { ...created, created: true }
  }

  /* ---------- 跨进程锁 ---------- */

  function lockFile(name) { return path.join(dirs.transactions, `lock-${sha(name, 16)}.json`) }

  function lockState(record) {
    if (!record) return 'missing'
    if (record.hostname !== HOSTNAME) return 'other-host'
    if (!sameBoot(record.bootId, BOOT_ID)) return 'stale-reboot'
    return pidAlive(Number(record.processId)) ? 'held' : 'stale-dead'
  }

  /**
   * 取锁。失败时返回 dataset_conflict（retryable），绝不按 TTL 抢锁；
   * 只有"同主机、同启动实例、进程已退出"或"启动实例不同（重启过）"才清理。
   */
  function acquire(name, { owner = 'unknown', transactionId = `tx-${randomUUID()}`, timeoutMs = 1500 } = {}) {
    mkdirSync(dirs.transactions, { recursive: true })
    const file = lockFile(name)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const record = {
        schemaVersion: DATA_SCHEMA_VERSION, dataset: name, processId: process.pid, hostname: HOSTNAME,
        bootId: BOOT_ID, transactionId, owner, studyId, instanceId, startedAt: new Date().toISOString(),
      }
      try {
        const fd = openSync(file, 'wx')
        try { writeFileSync(fd, JSON.stringify(record, null, 2), 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
        return {
          transactionId,
          release() {
            const current = readJson(file, null)
            if (current && current.transactionId === transactionId) rmSync(file, { force: true })
          },
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      const held = readJson(file, null)
      const state = lockState(held)
      if (state === 'missing') continue
      if (state === 'stale-dead' || state === 'stale-reboot') {
        const archive = path.join(dirs.transactions, 'stale', `lock-${sha(name, 16)}-${Date.now()}.json`)
        mkdirSync(path.dirname(archive), { recursive: true })
        try { renameSync(file, archive) } catch { /* 另一个进程已清理 */ }
        continue
      }
      if (Date.now() >= deadline) {
        const current = head(name)
        throw new DataError('dataset_conflict', `数据集 ${name} 正在被 ${held?.owner || '另一进程'} 写入`, {
          committed: false, retryable: true, currentRevision: current?.revision ?? 0, localDetailsRef: file,
        })
      }
      sleepSync(25)
    }
  }

  /* ---------- 变化记录 ---------- */

  function readChanges() {
    const value = readJson(dirs.changes, null)
    if (value && Array.isArray(value.changes)) return value
    return { schemaVersion: CHANGE_SCHEMA_VERSION, seq: 0, changes: [] }
  }

  function appendChange(change) {
    const store = readChanges()
    store.seq = Math.max(Number(store.seq) || 0, Number(change.seq) || 0)
    store.changes.push(change)
    writeAtomic(dirs.changes, JSON.stringify(store, null, 2))
    for (const listener of listeners) { try { listener(change) } catch { /* 订阅者失败不影响提交 */ } }
    return change
  }

  function changesSince(seq = 0) {
    const store = readChanges()
    return store.changes.filter(change => Number(change.seq) > Number(seq))
  }

  const listeners = new Set()
  function onChange(listener) { listeners.add(listener); return () => listeners.delete(listener) }

  /* ---------- 读取 ---------- */

  const HEALTH = ['unconfigured', 'missing', 'empty', 'ok', 'invalid', 'unreadable', 'conflict']

  function read(name, options = {}) {
    const current = head(name)
    if (!current) {
      return {
        dataset: name, value: null, revision: 0, contentHash: null, generationId: null,
        health: { state: isConfigured(name) ? 'empty' : 'unconfigured', path: locate(name) },
      }
    }
    if (current.schemaVersion !== DATA_SCHEMA_VERSION) {
      return { dataset: name, value: null, revision: Number(current.revision) || 0, health: { state: 'invalid', error: '当前指针版本不支持' } }
    }
    if (options.revision !== undefined && Number(options.revision) !== Number(current.revision) && options.revision !== current.contentHash && options.revision !== current.generationId) {
      throw new DataError('dataset_conflict', `数据集 ${name} 已更新到版本 ${current.revision}`, {
        committed: false, retryable: false, currentRevision: current.revision, localDetailsRef: currentFile(name),
      })
    }
    const folder = path.join(generationDir(name), current.generationId)
    const manifest = readJson(path.join(folder, 'manifest.json'), null)
    if (!manifest) return { dataset: name, value: null, revision: current.revision, health: { state: 'conflict', error: '已提交代次的 manifest 缺失' } }
    const dataFile = path.join(folder, 'data.json')
    const info = statOf(dataFile)
    if (!info) return { dataset: name, value: null, revision: current.revision, health: { state: 'conflict', error: '已提交代次的数据文件缺失' } }
    let text
    try { text = readFileSync(dataFile, 'utf8') } catch (error) {
      return { dataset: name, value: null, revision: current.revision, health: { state: 'unreadable', error: error.message } }
    }
    if (sha(text) !== manifest.contentHash) {
      return { dataset: name, value: null, revision: current.revision, health: { state: 'invalid', error: '数据文件与已提交 hash 不符' } }
    }
    let value
    try { value = JSON.parse(text) } catch (error) {
      return { dataset: name, value: null, revision: current.revision, health: { state: 'invalid', error: error.message } }
    }
    return { dataset: name, value, revision: Number(manifest.revision), contentHash: manifest.contentHash, generationId: manifest.generationId, manifest, health: { state: 'ok', path: locate(name) } }
  }

  /** 兼容平面文件（旧插件写的镜像）只用于迁移与健康提示，不是权威输入。 */
  function legacyHealth(name) {
    const target = locate(name)
    const info = statOf(target)
    if (!info) return { state: existsSync(path.dirname(target)) ? 'missing' : 'missing', path: target }
    if (info.size === 0) return { state: 'empty', path: target, bytes: 0 }
    try {
      const text = readFileSync(target, 'utf8').replace(/^\uFEFF/, '')
      if (!/\.json$/i.test(target)) return { state: 'ok', path: target, bytes: info.size, kind: 'file' }
      const document = JSON.parse(text)
      if (document && typeof document === 'object' && document.studyId && String(document.studyId) !== studyId) {
        return { state: 'invalid', path: target, bytes: info.size, error: `文件属于研究 ${document.studyId}` }
      }
      return { state: 'ok', path: target, bytes: info.size, kind: 'json' }
    } catch (error) {
      return { state: 'invalid', path: target, bytes: info.size, error: error.message }
    }
  }

  function health(name) {
    if (!name) {
      const names = new Set([...Object.keys(DEFAULT_DATASETS), ...Object.keys(overrides)])
      return [...names].map(item => health(item))
    }
    let committed
    try { const result = read(name); committed = { state: result.health.state, revision: result.revision, generationId: result.generationId, contentHash: result.contentHash } }
    catch (error) { committed = { state: 'invalid', error: error.message } }
    let legacy
    try { legacy = legacyHealth(name) } catch (error) { legacy = { state: 'invalid', error: error.message } }
    // 损坏的兼容文件不能因为还没有已提交代次就被降级成"尚未录入"。
    let state = committed.state
    if (committed.state === 'empty' && legacy.state === 'invalid') state = 'invalid'
    return { dataset: name, state, committed, legacy }
  }

  /* ---------- 写入 ---------- */

  function verifyFiles(folder, files) {
    for (const file of files) {
      const target = path.join(folder, file.relativePath)
      if (!isInside(folder, target)) throw new DataError('source_invalid', `提交文件越界：${file.relativePath}`)
      const info = statOf(target)
      if (!info) throw new DataError('source_invalid', `提交文件缺失：${file.relativePath}`)
      const bytes = readFileSync(target)
      if (sha(bytes) !== file.sha256) throw new DataError('source_invalid', `提交文件 hash 不符：${file.relativePath}`)
    }
  }

  /**
   * 提交一个数据集的新代次。
   * value 会被规范化为 2 空格缩进 JSON；mirrors 只在提交完成后写平面文件（可重建，不是权威）。
   */
  function commit(name, value, options = {}) {
    const text = JSON.stringify(value, null, 2)
    const contentHash = sha(text)
    const owner = options.owner || 'unknown'
    // 数据集声明的兼容位置（可能是配置里的自定义路径）也要过 strict-local 越界检查。
    const declaredTarget = locate(name, { forWrite: true })
    void declaredTarget
    return withLock(name, { owner, timeoutMs: options.timeoutMs, transactionId: options.transactionId }, () => {
      // 第一次真正写入时认领数据根；之后身份不符会被拒绝。
      ensureInstance({ create: true })
      const current = head(name)
      const previousRevision = Number(current?.revision) || 0
      if (options.expectedRevision !== undefined && options.expectedRevision !== null && String(options.expectedRevision) !== '') {
        const expected = options.expectedRevision
        const accepted = [String(previousRevision), current?.contentHash || 'empty', current?.generationId].filter(Boolean).map(String)
        if (!accepted.includes(String(expected))) {
          throw new DataError('dataset_conflict', `数据集 ${name} 的预期版本 ${expected} 与当前 ${previousRevision} 不一致`, {
            committed: false, retryable: false, currentRevision: previousRevision, localDetailsRef: currentFile(name),
          })
        }
      }
      if (options.credentials !== undefined) {
        // 占位：02 不接收凭据，避免把密钥写进研究数据目录。
        throw new DataError('policy_blocked', '研究数据提交不接受凭据字段')
      }
      if (current && current.contentHash === contentHash && options.force !== true) {
        return { dataset: name, generationId: current.generationId, revision: previousRevision, contentHash, committed: true, unchanged: true, manifest: readJson(path.join(generationDir(name), current.generationId, 'manifest.json'), null) }
      }
      const revision = previousRevision + 1
      const generationId = `g${String(revision).padStart(6, '0')}-${contentHash.slice(0, 8)}`
      const transactionId = options.transactionId || `tx-${randomUUID()}`
      const folder = path.join(generationDir(name), generationId)
      const staging = path.join(dirs.transactions, transactionId)
      const files = [{ role: 'data', relativePath: 'data.json', sha256: contentHash, bytes: Buffer.byteLength(text) }]
      const mirrors = (options.mirrors || []).map(mirror => {
        const bytes = Buffer.from(String(mirror.text ?? ''), 'utf8')
        const relativePath = String(mirror.relativePath || '')
        const target = path.isAbsolute(relativePath) ? relativePath : path.join(root, relativePath)
        if (!relativePath || !isInside(root, target)) throw new DataError('source_invalid', `镜像路径越界：${relativePath}`)
        return { role: mirror.role || 'mirror', relativePath: path.relative(root, target).split(path.sep).join('/'), bytes, sha256: sha(bytes) }
      })
      for (const mirror of mirrors) files.push({ role: mirror.role, relativePath: mirror.relativePath, sha256: mirror.sha256, bytes: mirror.bytes.length })
      mkdirSync(staging, { recursive: true })
      try {
        writeFileSync(path.join(staging, 'data.json'), text, 'utf8')
        for (const mirror of mirrors) {
          const target = path.join(staging, mirror.relativePath)
          mkdirSync(path.dirname(target), { recursive: true })
          writeFileSync(target, mirror.bytes)
        }
        const manifest = {
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          generationId,
          dataset: name,
          studyId,
          instanceId,
          revision,
          contentHash,
          createdAt: new Date().toISOString(),
          owner,
          inputs: options.inputs || [],
          files,
          corrects: options.corrects || null,
          operationId: options.operationId || null,
          note: options.note || '',
          transactionId,
        }
        writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
        verifyFiles(staging, files)
        mkdirSync(generationDir(name), { recursive: true })
        if (existsSync(folder)) throw new DataError('source_invalid', `代次目录已存在：${generationId}`)
        renameSync(staging, folder)
        // 提交边界：这一行写入成功后，所有读者切到新代。
        writeAtomic(currentFile(name), JSON.stringify({
          schemaVersion: DATA_SCHEMA_VERSION, dataset: name, generationId, revision,
          contentHash, committedAt: manifest.createdAt, studyId, instanceId,
        }, null, 2))
        const mirrorResults = []
        for (const mirror of mirrors) {
          try {
            writeAtomicBytes(path.join(root, mirror.relativePath), mirror.bytes)
            mirrorResults.push({ relativePath: mirror.relativePath, ok: true })
          } catch (error) {
            mirrorResults.push({ relativePath: mirror.relativePath, ok: false, error: error.message })
          }
        }
        const change = appendChange({
          schemaVersion: CHANGE_SCHEMA_VERSION,
          changeId: `chg-${randomUUID()}`,
          seq: revision,
          dataset: name,
          oldRevision: previousRevision,
          newRevision: revision,
          oldGenerationId: current?.generationId || null,
          newGenerationId: generationId,
          contentHash,
          studyId,
          instanceId,
          owner,
          operationId: manifest.operationId,
          corrects: manifest.corrects,
          committedAt: manifest.createdAt,
        })
        return { dataset: name, generationId, revision, contentHash, committed: true, changed: true, manifest, change, mirrors: mirrorResults }
      } catch (error) {
        try { rmSync(staging, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
        if (error instanceof DataError) throw error
        throw new DataError('source_invalid', `提交失败：${error.message}`, { committed: false, retryable: false })
      }
    })
  }

  function withLock(name, { owner, timeoutMs, transactionId }, run) {
    const lock = acquire(name, { owner, timeoutMs, transactionId })
    try { return run() } finally { lock.release() }
  }

  /* ---------- 恢复 ---------- */

  function listChildren(folder) {
    try { return readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { return [] }
  }

  /** 预检：只读，不改任何文件。 */
  function recoverPreview() {
    const pendingTransactions = listChildren(dirs.transactions).filter(name => !name.startsWith('lock-') && name !== 'stale')
    const staleLocks = []
    try {
      for (const entry of readdirSync(dirs.transactions, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith('lock-')) continue
        const file = path.join(dirs.transactions, entry.name)
        const record = readJson(file, null)
        const state = lockState(record)
        if (state === 'stale-dead' || state === 'stale-reboot') staleLocks.push({ file, record, state })
      }
    } catch { /* 没有事务目录 */ }
    const orphanGenerations = []
    for (const name of new Set([...Object.keys(DEFAULT_DATASETS), ...Object.keys(overrides)])) {
      const current = head(name)
      const committed = Number(current?.revision) || 0
      for (const generation of listChildren(generationDir(name))) {
        const manifest = readJson(path.join(generationDir(name), generation, 'manifest.json'), null)
        if (!manifest) { orphanGenerations.push({ dataset: name, generation, reason: 'manifest 缺失' }); continue }
        if (Number(manifest.revision) > committed) orphanGenerations.push({ dataset: name, generation, reason: '代次未发布为当前版本' })
      }
    }
    const lastCommitted = {}
    for (const name of new Set([...Object.keys(DEFAULT_DATASETS), ...Object.keys(overrides)])) {
      const current = head(name)
      lastCommitted[name] = current ? { revision: current.revision, generationId: current.generationId } : null
    }
    return { pendingTransactions, staleLocks, orphanGenerations, lastCommitted, needRecovery: pendingTransactions.length > 0 || staleLocks.length > 0 }
  }

  /** 应用恢复：归档未完成事务、清理可证明已退出的锁；已提交代次不动。 */
  function recover() {
    const preview = recoverPreview()
    const archived = []
    for (const name of preview.pendingTransactions) {
      const from = path.join(dirs.transactions, name)
      const to = path.join(dirs.transactions, 'stale', `${name}-${Date.now()}`)
      mkdirSync(path.dirname(to), { recursive: true })
      try { renameSync(from, to); archived.push({ transaction: name, archivedTo: to }) } catch { /* 已被别处清理 */ }
    }
    const removedLocks = []
    for (const row of preview.staleLocks) {
      const to = path.join(dirs.transactions, 'stale', `${path.basename(row.file, '.json')}-${Date.now()}.json`)
      mkdirSync(path.dirname(to), { recursive: true })
      try { renameSync(row.file, to); removedLocks.push({ file: row.file, state: row.state, archivedTo: to }) } catch { /* 已被别处清理 */ }
    }
    if (archived.length || removedLocks.length) {
      appendChange({
        schemaVersion: CHANGE_SCHEMA_VERSION, changeId: `chg-${randomUUID()}`, seq: readChanges().seq,
        dataset: '__recovery__', oldRevision: null, newRevision: null, studyId, instanceId,
        owner: 'recover', committedAt: new Date().toISOString(), archived, removedLocks,
      })
    }
    return { ...preview, archived, removedLocks, needRecovery: false }
  }

  /* ---------- 备份 / 恢复 ---------- */

  function backup(targetDir, options = {}) {
    const target = strictLocal ? assertLocalPath(targetDir) : path.resolve(targetDir)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const folder = path.join(target, `backup-${stamp}`)
    mkdirSync(folder, { recursive: true })
    const datasets = []
    const files = []
    for (const name of new Set([...Object.keys(DEFAULT_DATASETS), ...Object.keys(overrides)])) {
      const current = head(name)
      if (!current) continue
      const source = path.join(generationDir(name), current.generationId)
      const manifest = readJson(path.join(source, 'manifest.json'), null)
      if (!manifest) continue
      const destination = path.join(folder, 'generations', name, current.generationId)
      mkdirSync(destination, { recursive: true })
      for (const file of manifest.files) {
        const from = path.join(source, file.relativePath)
        const to = path.join(destination, file.relativePath)
        mkdirSync(path.dirname(to), { recursive: true })
        copyFileSync(from, to)
        const bytes = readFileSync(to)
        if (sha(bytes) !== file.sha256) throw new DataError('source_invalid', `备份复制后 hash 不符：${name}/${file.relativePath}`)
        files.push({ dataset: name, relativePath: path.relative(folder, to).split(path.sep).join('/'), sha256: file.sha256, bytes: file.bytes })
      }
      copyFileSync(path.join(source, 'manifest.json'), path.join(destination, 'manifest.json'))
      datasets.push({ dataset: name, revision: current.revision, generationId: current.generationId, contentHash: current.contentHash, manifest })
    }
    const instance = readJson(dirs.instance, null) || { schemaVersion: DATA_SCHEMA_VERSION, studyId, instanceId }
    writeAtomic(path.join(folder, 'instance.json'), JSON.stringify(instance, null, 2))
    const digest = sha(JSON.stringify(files.map(file => [file.relativePath, file.sha256]).sort()))
    const document = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      studyId,
      instanceId,
      digest,
      datasets,
      files,
    }
    writeAtomic(path.join(folder, 'backup.json'), JSON.stringify(document, null, 2))
    return { folder, digest, datasets: datasets.map(row => ({ dataset: row.dataset, revision: row.revision, generationId: row.generationId })) }
  }

  function restorePreflight(folder) {
    const source = path.resolve(folder)
    const document = readJson(path.join(source, 'backup.json'), null)
    if (!document) return { ok: false, problems: ['缺少 backup.json'], folder: source }
    const problems = []
    if (document.schemaVersion !== 1) problems.push(`不支持的备份版本：${document.schemaVersion}`)
    if (String(document.studyId) !== studyId) problems.push(`备份属于研究 ${document.studyId}，当前是 ${studyId}`)
    if (String(document.instanceId) !== instanceId) problems.push(`备份属于实例 ${document.instanceId}，当前是 ${instanceId}`)
    let digest
    try {
      for (const file of document.files || []) {
        const target = path.join(source, file.relativePath)
        const info = statOf(target)
        if (!info) { problems.push(`备份文件缺失：${file.relativePath}`); continue }
        const bytes = readFileSync(target)
        if (sha(bytes) !== file.sha256) problems.push(`备份文件 hash 不符：${file.relativePath}`)
      }
      digest = sha(JSON.stringify((document.files || []).map(file => [file.relativePath, file.sha256]).sort()))
      if (digest !== document.digest) problems.push('备份清单 digest 与文件不符')
    } catch (error) {
      problems.push(`备份校验失败：${error.message}`)
    }
    return { ok: problems.length === 0, problems, folder: source, document, digest }
  }

  /** 恢复到当前数据根：只追加代次并切换 current.json，不改已提交历史。 */
  function restore(folder) {
    const preflight = restorePreflight(folder)
    if (!preflight.ok) {
      throw new DataError('source_invalid', `恢复预检未通过：${preflight.problems.join('；')}`, { committed: false, retryable: false, details: preflight })
    }
    const document = preflight.document
    const restored = []
    for (const row of document.datasets || []) {
      const manifest = row.manifest
      const destination = path.join(generationDir(row.dataset), row.generationId)
      if (!existsSync(destination)) {
        mkdirSync(destination, { recursive: true })
        for (const file of manifest.files) {
          const from = path.join(preflight.folder, 'generations', row.dataset, row.generationId, file.relativePath)
          const to = path.join(destination, file.relativePath)
          mkdirSync(path.dirname(to), { recursive: true })
          copyFileSync(from, to)
        }
        copyFileSync(path.join(preflight.folder, 'generations', row.dataset, row.generationId, 'manifest.json'), path.join(destination, 'manifest.json'))
      }
      verifyFiles(destination, manifest.files)
      writeAtomic(currentFile(row.dataset), JSON.stringify({
        schemaVersion: DATA_SCHEMA_VERSION, dataset: row.dataset, generationId: row.generationId,
        revision: row.revision, contentHash: row.contentHash, committedAt: new Date().toISOString(), studyId, instanceId,
      }, null, 2))
      restored.push({ dataset: row.dataset, revision: row.revision, generationId: row.generationId })
    }
    const instanceRestored = ensureInstance({ create: true })
    appendChange({
      schemaVersion: CHANGE_SCHEMA_VERSION, changeId: `chg-${randomUUID()}`, seq: readChanges().seq,
      dataset: '__restore__', oldRevision: null, newRevision: null, studyId, instanceId,
      owner: 'restore', committedAt: new Date().toISOString(), folder: preflight.folder, digest: preflight.digest, restored,
    })
    return { restored: true, digest: preflight.digest, datasets: restored, instance: instanceRestored }
  }

  /* ---------- 只读投影 ---------- */

  return {
    version: DATA_VERSION,
    studyId,
    instanceId,
    root,
    dirs,
    locate,
    ensureInstance,
    read,
    commit,
    health,
    head: name => head(name),
    history(name) {
      const rows = []
      for (const generation of listChildren(generationDir(name)).sort()) {
        const manifest = readJson(path.join(generationDir(name), generation, 'manifest.json'), null)
        if (manifest) rows.push({ generationId: generation, revision: manifest.revision, contentHash: manifest.contentHash, createdAt: manifest.createdAt, owner: manifest.owner, corrects: manifest.corrects, inputs: manifest.inputs })
      }
      return rows.sort((a, b) => b.revision - a.revision)
    },
    changesSince,
    onChange,
    recoverPreview,
    recover,
    backup,
    restorePreflight,
    restore,
    lock: (name, options) => acquire(name, options || {}),
    verifyFiles,
    bootId: BOOT_ID,
    hostname: HOSTNAME,
    datasetNames: () => [...new Set([...Object.keys(DEFAULT_DATASETS), ...Object.keys(overrides)])],
  }
}

export default openResearchData
