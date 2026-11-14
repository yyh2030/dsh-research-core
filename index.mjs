/**
 * @local/research-core — 研究身份与绑定核心（Host 侧，无界面）
 *
 * 职责（第一阶段：身份与隔离）：
 *   1. 研究身份：canonical 路径、instanceId、studyRevision、dataRevision。
 *   2. 解析顺序：显式页面/会话记录 → 工作区记录 → 会话 cwd 的项目配置 →
 *      旧 profile 配置（仅作首次接入候选）→ 空研究。
 *   3. 绑定令牌：页面与会话各自持有带 bindingRevision 的令牌；切换研究即失效，
 *      过期写入返回结构化冲突，绝不自动改写到另一研究。
 *   4. 持久记录：工作区、会话、页面绑定写在宿主本地 JSON，
 *      以原子重命名写入；只读解析不写盘。
 *   5. 切换执行：插件注册 prepareSwitch/currentIdentity，core 在互斥区内完成
 *      "解析 → 切换 → 执行"，同一进程里多个研究 handle 由调用身份选择。
 *
 * 本模块不是 Cordis Service：四个业务插件各自 import 它，进程内通过
 * globalThis[Symbol.for('dsh.research.core.v1')] 共享同一个实例，
 * 因此任一插件先加载都能拿到同一份注册表，且不需要额外的 profile 行。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CORE_VERSION = '1.2.0'
export const STORE_SCHEMA_VERSION = 1

const SHARED = Symbol.for('dsh.research.core.v1')
const TOKEN_PREFIX = 'rc1'
const PAGE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/
const PROJECT_CONFIG_NAMES = [path.join('.dsh', 'study.json'), 'study.json', path.join('_lab', 'study.json')]

export class BindingError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'BindingError'
    this.code = code
    this.details = details
  }
}

const conflict = (message, details) => new BindingError('binding_conflict', message, details)
const invalid = (message, details) => new BindingError('invalid', message, details)
const notFound = (message, details) => new BindingError('not_found', message, details)

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

/** realpath 最长存在前缀，让"尚未创建"的路径也有稳定拼写。 */
export function canonicalPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let current = path.resolve(value)
  const tail = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      // realpath 统一 junction／符号链接与大小写实际拼写。
      return path.join(realpathSync.native(current), ...tail)
    } catch { /* 还不存在，继续向父目录找 */ }
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(value)
    tail.unshift(path.basename(current))
    current = parent
  }
  return path.resolve(value)
}

/** 大小写不敏感平台用统一小写做键，防止同目录换成另一种拼写被当成两个研究。 */
export function pathKey(value) {
  const canonical = canonicalPath(value)
  if (!canonical) return null
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function isInside(parent, child) {
  const a = pathKey(parent)
  const b = pathKey(child)
  if (!a || !b) return false
  const rel = path.relative(a, b)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

const sha = (value, length) => createHash('sha256').update(value).digest('hex').slice(0, length)

/* ------------------------------------------------------------------ *
 * 本地存储
 * ------------------------------------------------------------------ */

function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, file)
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* 尽力清理 */ }
  }
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}

/* ------------------------------------------------------------------ *
 * 核心实例
 * ------------------------------------------------------------------ */

export function researchCore(options = {}) {
  if (globalThis[SHARED]) {
    if (options && Object.keys(options).length) globalThis[SHARED].configure(options)
    return globalThis[SHARED]
  }
  const core = createCore(options)
  globalThis[SHARED] = core
  return core
}

function createCore(initial) {
  const state = {
    options: {},
    explicitStoreDir: false,
    plugins: new Map(),
    instances: null,
    bindings: null,
    warnings: [],
    queue: Promise.resolve(),
  }
  const defaults = {
    homeDir: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    profileDir: process.env.DSH_PROFILE_DIR || '',
    storeDir: process.env.DSH_RESEARCH_STORE || '',
    legacyStudyPath: '',
    legacyProjectRoot: '',
  }
  configure(defaults)
  if (initial && Object.keys(initial).length) configure(initial)

  function configure(patch = {}) {
    const next = { ...state.options }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null || value === '') continue
      next[key] = value
    }
    // 显式 storeDir 优先；否则每次 homeDir 变化都重新推导，避免沿用旧 home。
    const explicitStore = state.explicitStoreDir || (patch && typeof patch.storeDir === 'string' && patch.storeDir.trim() !== '')
    next.storeDir = explicitStore ? next.storeDir : path.join(next.homeDir, 'storages', 'research-core')
    state.explicitStoreDir = explicitStore
    state.options = next
    state.instances = null
    state.bindings = null
  }

  /* ---------- 持久记录 ---------- */

  function storeFile(name) { return path.join(state.options.storeDir, `${name}.json`) }

  function loadInstances() {
    if (state.instances) return state.instances
    const raw = readJsonFile(storeFile('instances'), null)
    const list = raw && raw.schemaVersion === STORE_SCHEMA_VERSION && raw.entries && typeof raw.entries === 'object' ? raw.entries : {}
    const byKey = new Map()
    for (const entry of Object.values(list)) if (entry && entry.instanceKey) byKey.set(entry.instanceKey, entry)
    state.instances = { schemaVersion: STORE_SCHEMA_VERSION, entries: list, byKey }
    return state.instances
  }

  function saveInstances() {
    const data = state.instances
    atomicJson(storeFile('instances'), { schemaVersion: STORE_SCHEMA_VERSION, entries: data.entries })
  }

  function loadBindings() {
    if (state.bindings) return state.bindings
    const raw = readJsonFile(storeFile('bindings'), null)
    const entries = raw && raw.schemaVersion === STORE_SCHEMA_VERSION && raw.entries && typeof raw.entries === 'object' ? raw.entries : {}
    state.bindings = { schemaVersion: STORE_SCHEMA_VERSION, entries }
    return state.bindings
  }

  function saveBindings() {
    atomicJson(storeFile('bindings'), { schemaVersion: STORE_SCHEMA_VERSION, entries: state.bindings.entries })
  }

  /** 实例身份由实例键确定性派生：同一 canonical 配置 → 同一 id；克隆到新路径 → 新 id。 */
  function derivedInstanceId(instanceKey) { return `inst_${sha(instanceKey, 16)}` }

  function instanceFor(descriptor) {
    const instances = loadInstances()
    let entry = instances.byKey.get(descriptor.instanceKey)
    if (entry) {
      let dirty = false
      if (entry.studyId !== descriptor.studyId) { entry.studyId = descriptor.studyId; dirty = true }
      if (entry.name !== descriptor.name) { entry.name = descriptor.name; dirty = true }
      if (entry.configPath !== descriptor.studyPath) { entry.configPath = descriptor.studyPath; dirty = true }
      const now = new Date().toISOString()
      if (now.slice(0, 10) !== String(entry.lastSeenAt || '').slice(0, 10)) { entry.lastSeenAt = now; dirty = true }
      if (dirty) saveInstances()
      return entry
    }
    const now = new Date().toISOString()
    entry = {
      instanceId: derivedInstanceId(descriptor.instanceKey),
      instanceKey: descriptor.instanceKey,
      studyId: descriptor.studyId,
      name: descriptor.name,
      configPath: descriptor.studyPath,
      canonicalConfigPath: descriptor.canonicalConfigPath,
      canonicalRoot: descriptor.canonicalRoot,
      empty: !descriptor.studyPath,
      createdAt: now,
      lastSeenAt: now,
    }
    instances.entries[entry.instanceId] = entry
    instances.byKey.set(entry.instanceKey, entry)
    saveInstances()
    return entry
  }

  /* ---------- 研究描述 ---------- */

  /**
   * 只读描述一份研究配置；不创建目录、不写文件、不改配置。
   * 未提供 studyPath 时得到"空研究"描述（instanceKey 取决于数据根目录）。
   */
  function describeStudy(input = {}) {
    const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd()
    const configured = typeof input.studyPath === 'string' && input.studyPath.trim() !== ''
    const studyPath = configured ? path.resolve(cwd, input.studyPath) : null
    let text = ''
    let raw = null
    if (studyPath) {
      try { text = readFileSync(studyPath, 'utf8').replace(/^\uFEFF/, ''); raw = JSON.parse(text) }
      catch (error) { throw new BindingError('study_config', `研究定义读取失败：${error.message}`) }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BindingError('study_config', '研究定义必须是 JSON 对象')
    }
    const base = studyPath ? path.dirname(studyPath) : path.resolve(input.projectRoot || cwd)
    const dataRoot = path.resolve(base, (raw && typeof raw.dataRoot === 'string' && raw.dataRoot.trim() ? raw.dataRoot : null) || input.labDir || './data')
    const canonicalConfigPath = studyPath ? (canonicalPath(studyPath) || studyPath) : null
    const canonicalRoot = canonicalPath(dataRoot) || dataRoot
    const studyId = raw && typeof raw.studyId === 'string' && raw.studyId.trim() ? raw.studyId.trim() : ''
    const name = raw && typeof raw.name === 'string' ? raw.name : ''
    const studyRevision = studyPath ? sha(text, 32) : ''
    const instanceKey = canonicalConfigPath
      ? `config:${process.platform === 'win32' ? canonicalConfigPath.toLowerCase() : canonicalConfigPath}`
      : `empty:${process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot}`
    return {
      configured: Boolean(studyPath),
      studyPath,
      canonicalConfigPath,
      studyRevision,
      studyId,
      name,
      dataRoot,
      canonicalRoot,
      instanceKey,
      targetKey: studyPath ? `config:${pathKey(studyPath)}` : `empty:${pathKey(dataRoot)}`,
    }
  }

  function attachInstance(descriptor, { register = false } = {}) {
    if (!descriptor.configured) return { ...descriptor, instanceId: `none_${sha(descriptor.instanceKey, 12)}` }
    const instances = loadInstances()
    let entry = instances.byKey.get(descriptor.instanceKey)
    if (!entry && register) entry = instanceFor(descriptor)
    return { ...descriptor, instanceId: entry ? entry.instanceId : derivedInstanceId(descriptor.instanceKey) }
  }

  /* ---------- 插件注册 ---------- */

  function registerPlugin(name, hooks = {}) {
    if (typeof name !== 'string' || !name.trim()) throw invalid('插件名不能为空')
    state.plugins.set(name, {
      version: hooks.version || null,
      legacyStudyPath: hooks.legacyStudyPath || state.options.legacyStudyPath || '',
      legacyProjectRoot: hooks.legacyProjectRoot || state.options.legacyProjectRoot || '',
      emptyBase: typeof hooks.emptyBase === 'function' ? hooks.emptyBase : null,
      loadStudy: hooks.loadStudy,
      currentIdentity: hooks.currentIdentity,
      prepareSwitch: hooks.prepareSwitch,
      busy: hooks.busy,
    })
    return () => { if (state.plugins.get(name) === hooks) state.plugins.delete(name) }
  }

  function legacyDescriptor() {
    for (const hooks of state.plugins.values()) {
      if (!hooks || !hooks.legacyStudyPath) continue
      try {
        const descriptor = describeStudy({ studyPath: hooks.legacyStudyPath, projectRoot: hooks.legacyProjectRoot || undefined })
        return { descriptor, plugin: hooks }
      } catch { /* 旧配置不可读时继续尝试下一个插件 */ }
    }
    return null
  }

  /**
   * 其它插件在“没有页面绑定”时统一回退到同一份旧配置研究。
   * 只读描述，不注册、不写绑定；没有旧配置时返回 null。
   */
  function legacyStudy() {
    const legacy = legacyDescriptor()
    if (!legacy) return null
    const descriptor = legacy.descriptor
    return {
      studyPath: descriptor.studyPath || null,
      projectRoot: legacy.plugin.legacyProjectRoot || null,
      studyId: descriptor.studyId || null,
      name: descriptor.name || null,
      dataRoot: descriptor.dataRoot || null,
      configured: Boolean(descriptor.configured),
    }
  }

  /** 工作区清单每次解析前由宿主刷新；不清空已加载的实例与绑定缓存。 */
  function setWorkspaces(list) {
    state.options.workspaces = Array.isArray(list)
      ? list.filter(row => row && typeof row.path === 'string' && row.path).map(row => ({ id: row.id || null, path: row.path, title: row.title || null }))
      : []
  }

  /* ---------- 调用身份 ---------- */

  function actorScope(actor) {
    if (!actor || typeof actor !== 'object') throw new BindingError('actor', '缺少调用身份')
    const cwd = actor.cwd ? path.resolve(actor.cwd) : null
    if (actor.kind === 'page') {
      const pageId = String(actor.pageId || '').trim()
      if (!PAGE_ID_RE.test(pageId)) throw new BindingError('actor', '页面身份缺失或格式不正确')
      return {
        kind: 'page',
        key: `page:${pageId}`,
        pageId,
        cwd,
        workspaceId: String(actor.workspaceId || '').trim(),
        workspacePath: String(actor.workspacePath || '').trim(),
      }
    }
    if (actor.kind === 'agent') {
      const sessionId = String(actor.sessionId || '').trim()
      if (!sessionId) throw new BindingError('actor', '会话身份缺失')
      return { kind: 'agent', key: `session:${sessionId}`, sessionId, cwd }
    }
    if (actor.kind === 'background') {
      const instanceId = String(actor.instanceId || '').trim()
      if (!instanceId) throw new BindingError('actor', '后台任务缺少实例身份')
      return { kind: 'background', key: `background:${instanceId}`, instanceId, cwd }
    }
    if (actor.kind === 'probe') return { kind: 'probe', key: `probe:${actor.label || 'default'}`, cwd }
    throw new BindingError('actor', `未知调用身份类型：${actor.kind}`)
  }

  const scopeHash = scope => sha(scope.key, 10)
  /** 令牌里带工作区指纹：同页切到另一工作区后旧令牌不能继续用。 */
  const workspaceHash = scope => sha(scope.kind === 'page' ? (scope.workspaceId || '') : '', 8)

  /* ---------- 工作区与项目配置发现 ---------- */

  function workspaceFor(cwd) {
    if (!cwd) return null
    const list = Array.isArray(state.options.workspaces) ? state.options.workspaces : []
    let best = null
    for (const workspace of list) {
      if (!workspace || !workspace.path) continue
      if (!isInside(workspace.path, cwd)) continue
      if (!best || pathKey(workspace.path).length > pathKey(best.path).length) best = workspace
    }
    return best
  }

  function projectConfigFor(cwd) {
    if (!cwd) return null
    for (const name of PROJECT_CONFIG_NAMES) {
      const candidate = path.join(cwd, name)
      try { if (statSync(candidate).isFile()) return candidate } catch { /* 不存在 */ }
    }
    return null
  }

  /* ---------- 解析 ---------- */

  function bindingRecord(key) {
    const bindings = loadBindings()
    return bindings.entries[key] || null
  }

  function tokenFor(scope, descriptor, revision) {
    return [
      TOKEN_PREFIX,
      descriptor.instanceId,
      scopeHash(scope),
      String(revision || 0),
      descriptor.configured ? descriptor.studyRevision.slice(0, 16) : 'empty',
      workspaceHash(scope),
    ].join('.')
  }

  function parseToken(token) {
    if (typeof token !== 'string') return null
    const parts = token.split('.')
    if ((parts.length !== 5 && parts.length !== 6) || parts[0] !== TOKEN_PREFIX) return null
    if (!/^\d+$/.test(parts[3])) return null
    // 5 段是旧格式（无工作区）；按空工作区对待，切过工作区后自然不匹配。
    return { instanceId: parts[1], keyHash: parts[2], bindingRevision: Number(parts[3]), studyRevision: parts[4], workspaceHash: parts[5] || sha('', 8) }
  }

  /** 页面绑定记录带工作区；同页换工作区即使研究没变也要推进版本。 */
  function effectiveRevision(scope, record) {
    const base = record ? Number(record.revision) || 0 : 0
    if (!record || scope.kind !== 'page') return { revision: base, workspaceChanged: false }
    // 只有页面明确报告了另一个工作区才算切换；旧客户端不报工作区时不能把记录抹掉。
    const changed = Boolean(scope.workspaceId) && scope.workspaceId !== (record.workspaceId || '')
    return { revision: base + (changed ? 1 : 0), workspaceChanged: changed }
  }

  function buildView(scope, descriptor, record) {
    const effective = effectiveRevision(scope, record)
    const revision = effective.revision
    const withInstance = attachInstance(descriptor, { register: false })
    return {
      schemaVersion: 1,
      state: record ? 'bound' : 'candidate',
      source: record ? record.source || 'explicit' : 'candidate',
      instanceId: withInstance.instanceId,
      studyId: descriptor.studyId,
      name: descriptor.name,
      studyRevision: descriptor.studyRevision,
      configured: descriptor.configured,
      studyPath: descriptor.studyPath,
      dataRoot: descriptor.dataRoot,
      canonicalRoot: descriptor.canonicalRoot,
      bindingRevision: revision,
      workspaceChanged: effective.workspaceChanged,
      workspace: { id: scope.kind === 'page' ? (scope.workspaceId || '') : '', path: scope.kind === 'page' ? (scope.workspacePath || '') : '' },
      workspaceId: scope.kind === 'page' ? (scope.workspaceId || '') : '',
      scope: { kind: scope.kind, keyHash: scopeHash(scope) },
      token: tokenFor(scope, withInstance, revision),
      study: {
        id: descriptor.studyId,
        name: descriptor.name,
        instanceId: withInstance.instanceId,
        revision: descriptor.studyRevision,
        path: descriptor.studyPath,
        dataRoot: descriptor.dataRoot,
        configured: descriptor.configured,
        source: record ? record.source || 'explicit' : 'candidate',
      },
    }
  }

  function emptyBaseFor(plugin) {
    const hooks = plugin ? state.plugins.get(plugin) : null
    if (hooks && typeof hooks.emptyBase === 'function') {
      try { const base = hooks.emptyBase(); if (base) return path.resolve(base) } catch { /* 退回进程目录 */ }
    }
    return process.cwd()
  }

  function emptyDescriptor(plugin) {
    // 与插件未配置时的默认根一致：插件自己声明的 emptyBase → 进程工作目录。
    const base = emptyBaseFor(plugin)
    return describeStudy({ projectRoot: base, cwd: base, labDir: path.join(base, '_lab') })
  }

  function resolveFromRecord(scope, record) {
    let descriptor
    try {
      descriptor = describeStudy({ studyPath: record.studyPath || undefined, cwd: record.cwd || undefined, projectRoot: record.projectRoot || undefined })
    } catch (error) {
      return {
        schemaVersion: 1,
        state: 'missing',
        source: record.source || 'explicit',
        scope: { kind: scope.kind, keyHash: scopeHash(scope) },
        error: { code: error.code || 'study_config', message: error.message },
        instanceId: record.instanceId || null,
        studyId: record.studyId || null,
        studyRevision: record.studyRevision || '',
        studyPath: record.studyPath || null,
        dataRoot: record.dataRoot || null,
        configured: Boolean(record.studyPath),
        bindingRevision: Number(record.revision) || 0,
        token: null,
        study: { id: record.studyId || null, name: '', instanceId: record.instanceId || null, revision: record.studyRevision || '', path: record.studyPath || null, dataRoot: record.dataRoot || null, configured: Boolean(record.studyPath), source: record.source || 'explicit' },
      }
    }
    return buildView(scope, descriptor, record)
  }

  /** 只读解析：不写盘。返回 state ∈ bound | candidate | empty | missing。 */
  /** 页面没有 cwd 时，仍可按工作区 id 找到工作区绑定（标签页跟随工作区）。 */
  function workspaceRecordById(id) {
    const workspaceId = String(id || '').trim()
    if (!workspaceId) return null
    const bindings = loadBindings()
    for (const [key, entry] of Object.entries(bindings.entries)) {
      if (key.startsWith('workspace:') && entry && entry.workspaceId === workspaceId) return entry
    }
    return null
  }
  function resolve(actor, options = {}) {
    const scope = actorScope(actor)
    const record = bindingRecord(scope.key)
    if (record) return resolveFromRecord(scope, record)

    if (scope.kind === 'page' && scope.workspaceId) {
      const workspaceRecord = workspaceRecordById(scope.workspaceId)
      if (workspaceRecord) {
        const view = resolveFromRecord(scope, { ...workspaceRecord, source: 'workspace' })
        return { ...view, source: 'workspace' }
      }
    }
    if (scope.cwd && (scope.kind === 'agent' || scope.kind === 'probe' || scope.kind === 'page')) {
      const workspace = workspaceFor(scope.cwd)
      if (workspace) {
        const workspaceRecord = bindingRecord(`workspace:${pathKey(workspace.path)}`)
        if (workspaceRecord) {
          const view = resolveFromRecord(scope, { ...workspaceRecord, source: 'workspace' })
          return { ...view, source: 'workspace' }
        }
      }
      const projectConfig = projectConfigFor(scope.cwd)
      if (projectConfig) {
        try {
          const descriptor = describeStudy({ studyPath: projectConfig })
          const view = buildView(scope, descriptor, null)
          return { ...view, source: 'project' }
        } catch { /* 项目配置不合法时退回旧配置候选 */ }
      }
    }

    const legacy = legacyDescriptor()
    if (legacy) {
      const view = buildView(scope, legacy.descriptor, null)
      return { ...view, source: 'legacy' }
    }

    const view = buildView(scope, emptyDescriptor(options.plugin), null)
    return { ...view, state: 'empty', source: 'empty' }
  }

  function persistRecord(scope, view, source) {
    const bindings = loadBindings()
    const previous = bindings.entries[scope.key] || null
    const sameWorkspace = !scope.workspaceId || (previous && previous.workspaceId || '') === scope.workspaceId
    const sameTarget = previous && previous.studyPath === view.studyPath && previous.instanceId === view.instanceId && sameWorkspace
    const revision = previous ? (sameTarget ? Number(previous.revision) || 0 : (Number(previous.revision) || 0) + 1) : 1
    const record = {
      instanceId: view.instanceId,
      studyPath: view.studyPath,
      studyId: view.studyId,
      studyRevision: view.studyRevision,
      dataRoot: view.dataRoot,
      workspaceId: scope.workspaceId || (previous && previous.workspaceId) || '',
      workspacePath: scope.workspacePath || (previous && previous.workspacePath) || '',
      cwd: scope.cwd || null,
      source,
      revision,
      updatedAt: new Date().toISOString(),
    }
    bindings.entries[scope.key] = record
    saveBindings()
    return record
  }

  function persistWorkspace(scope, view, source) {
    if (!scope.cwd) return null
    const workspace = workspaceFor(scope.cwd)
    if (!workspace) return null
    const key = `workspace:${pathKey(workspace.path)}`
    const bindings = loadBindings()
    const previous = bindings.entries[key] || null
    const sameTarget = previous && previous.studyPath === view.studyPath && previous.instanceId === view.instanceId
    const revision = previous ? (sameTarget ? Number(previous.revision) || 0 : (Number(previous.revision) || 0) + 1) : 1
    bindings.entries[key] = {
      instanceId: view.instanceId,
      studyPath: view.studyPath,
      studyId: view.studyId,
      studyRevision: view.studyRevision,
      dataRoot: view.dataRoot,
      workspaceId: workspace.id || null,
      workspacePath: workspace.path,
      source,
      revision,
      updatedAt: new Date().toISOString(),
    }
    saveBindings()
    return bindings.entries[key]
  }

  /** 创建空研究 == 写一份最小研究定义，再显式连接。 */
  function minimalDefinition(target, { studyId, name } = {}) {
    const id = String(studyId || '').trim() || `study-${sha(`${pathKey(target)}|${Date.now()}`, 8)}`
    return {
      schemaVersion: 1,
      studyId: id,
      name: String(name || '').trim() || '新研究',
      dataRoot: './data',
      participantId: {},
      visits: [],
      tasks: [],
      followups: [],
      plugins: {},
    }
  }

  /** 记录显式打开：lastSeenAt 保留兼容，lastOpenedAt/openCount 只用于"最近使用"。 */
  function touchOpened(instanceId) {
    if (!instanceId) return
    const instances = loadInstances()
    const entry = Object.values(instances.entries).find(row => row.instanceId === instanceId)
    if (!entry) return
    entry.lastOpenedAt = new Date().toISOString()
    entry.openCount = Number(entry.openCount || 0) + 1
    entry.lastSeenAt = entry.lastOpenedAt
    saveInstances()
  }

  /**
   * 重新定位：只有当新配置解析出的数据根仍属于同一实例时才按"移动"处理；
   * 复制/分叉会得到不同 instanceId，必须作为新研究显式连接。
   */
  function relocateStudy(actor, options = {}) {
    const instanceId = String(options.instanceId || '').trim()
    if (!instanceId) throw invalid('重新定位需要实例引用')
    const instances = loadInstances()
    const entry = instances.entries[instanceId]
    if (!entry) throw notFound('没有这个研究实例')
    if (!options.studyPath) throw invalid('重新定位需要新的研究定义路径')
    const next = describeStudy({ studyPath: path.resolve(actorScope(actor).cwd || process.cwd(), options.studyPath) })
    let previous = null
    try { if (entry.configPath) previous = describeStudy({ studyPath: entry.configPath }) } catch { previous = null }
    const sameDataRoot = Boolean(previous && previous.dataRoot && next.dataRoot
      && canonicalPath(previous.dataRoot) === canonicalPath(next.dataRoot))
    // 数据根里的实例记录是更硬的证据：有记录且不是本实例，就是复制/分叉。
    let markerId = null
    try { markerId = JSON.parse(readFileSync(path.join(next.dataRoot, 'study-instance.json'), 'utf8')).instanceId || null } catch { markerId = null }
    if (markerId && markerId !== instanceId) throw conflict('目标数据根属于另一实例（复制或分叉），不能按移动处理；请作为新研究连接')
    if (!sameDataRoot && markerId !== instanceId) throw conflict('目标配置的数据根不是原实例；若确实移动，请让新配置指向原数据根')
    // 视为移动：保留 instanceId，把注册项迁移到新的配置路径键上，再走统一 connect 持久化绑定。
    const previousConfig = entry.configPath || null
    delete instances.byKey[entry.instanceKey]
    entry.instanceKey = next.instanceKey
    entry.configPath = next.studyPath
    entry.canonicalConfigPath = next.canonicalConfigPath
    entry.canonicalRoot = next.canonicalRoot
    instances.byKey[next.instanceKey] = entry
    saveInstances()
    const view = connect(actor, { studyPath: options.studyPath, source: 'relocate' })
    return { ...view, relocated: true, previousConfig }
  }
  function connect(actor, options = {}) {
    const scope = actorScope(actor)
    let studyPath = options.studyPath ? path.resolve(scope.cwd || process.cwd(), options.studyPath) : null

    // 创建分支必须先于“连接已有研究”：否则带 studyPath 的 create:true 会直接去读一个
    // 还不存在的文件。已有目标一律冲突，不覆盖、也不误当连接，失败不留半套目录。
    if (options.create) {
      if (!studyPath) throw invalid('创建空研究需要给出研究定义文件路径')
      if (existsSync(studyPath)) throw conflict('该路径已有研究定义，请选择"连接已有研究"或换一个路径')
      const definition = options.definition || minimalDefinition(studyPath, options)
      mkdirSync(path.dirname(studyPath), { recursive: true })
      try {
        writeFileSync(studyPath, JSON.stringify(definition, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (error.code === 'EEXIST') throw conflict('该路径已有研究定义，请选择"连接已有研究"或换一个路径')
        throw error
      }
    }
    if (!studyPath) throw invalid('连接研究需要提供研究定义路径')

    const hooks = state.plugins.get(options.plugin)
    // 用插件自己的加载器校验一次，避免 core 与插件对同一份配置有两种解释。
    if (hooks && typeof hooks.loadStudy === 'function') hooks.loadStudy(studyPath)

    const descriptor = describeStudy({ studyPath, cwd: scope.cwd || undefined })
    const withInstance = attachInstance(descriptor, { register: true })
    touchOpened(withInstance.instanceId)
    const base = buildView(scope, withInstance, null)
    const record = persistRecord(scope, base, options.source || 'explicit')
    if (scope.kind === 'agent') persistWorkspace(scope, base, options.source || 'explicit')
    const view = buildView(scope, withInstance, record)
    return { ...view, state: 'bound' }
  }

  function disconnect(actor) {
    const scope = actorScope(actor)
    const bindings = loadBindings()
    if (!bindings.entries[scope.key]) return false
    delete bindings.entries[scope.key]
    saveBindings()
    return true
  }

  /**
   * 写入前的版本校验。
   * - 页面：必须携带令牌；令牌过期、跨页面或研究配置变化都返回结构化冲突。
   * - 会话（工具调用）：宿主已按 Agent id 认证身份；允许带 expected 身份做一致性核对。
   * - 首次写一个候选研究时会落绑定记录（候选 → 已绑定），令牌随之稳定。
   */
  function assertWrite(actor, expected = {}, options = {}) {
    const scope = actorScope(actor)
    const before = resolve(scope, options)
    if (before.state === 'missing') {
      throw new BindingError('study_missing', '当前绑定的研究定义已不存在，请重新连接研究', { studyPath: before.studyPath })
    }
    const supplied = expected && typeof expected === 'object' ? expected : {}
    const token = typeof supplied.token === 'string' ? supplied.token : (typeof expected === 'string' ? expected : '')

    if (scope.kind === 'page' || scope.kind === 'probe') {
      if (!token) throw new BindingError('binding_required', '写入需要当前研究绑定，请刷新页面后重试')
    }
    if (token) {
      const parsed = parseToken(token)
      if (!parsed) throw conflict('研究绑定令牌无法识别，请刷新页面后重试')
      if (parsed.keyHash !== scopeHash(scope)) throw conflict('研究绑定令牌属于其他页面或会话')
      if (parsed.workspaceHash !== workspaceHash(scope)) throw conflict('研究绑定属于其他工作区，请重新读取后再写入', { current: { workspaceId: scope.workspaceId || '', studyId: before.studyId } })
      if (parsed.instanceId !== before.instanceId) throw conflict('当前页面已绑定到其他研究实例，请重新加载', { current: { instanceId: before.instanceId, studyId: before.studyId } })
      if (parsed.bindingRevision !== before.bindingRevision) throw conflict('研究绑定已切换，请重新加载后再写入', { current: { bindingRevision: before.bindingRevision, studyId: before.studyId } })
      if (parsed.studyRevision !== (before.configured ? before.studyRevision.slice(0, 16) : 'empty')) throw conflict('研究定义已在外部修改，请重新连接后再写入')
    }
    if (supplied.studyId && before.studyId && supplied.studyId !== before.studyId) {
      throw conflict('请求携带的研究编号与当前绑定不一致', { current: { studyId: before.studyId } })
    }
    if (supplied.studyRevision && before.studyRevision) {
      // 各插件历史版本用完整 sha256，核心用前 32 位；比较时按前缀对齐。
      const suppliedRevision = String(supplied.studyRevision)
      const currentRevision = String(before.studyRevision)
      if (!(suppliedRevision === currentRevision || suppliedRevision.startsWith(currentRevision) || currentRevision.startsWith(suppliedRevision))) {
        throw conflict('请求携带的研究版本与当前绑定不一致，请重新读取')
      }
    }
    if (supplied.instanceId && before.instanceId && supplied.instanceId !== before.instanceId) {
      throw conflict('请求携带的实例身份与当前绑定不一致')
    }

    // 同页切换工作区且研究没变：首次用新令牌写入时把新工作区落库，旧令牌从此失效。
    if (before.workspaceChanged && before.configured) {
      const record = persistRecord(scope, before, before.source)
      const descriptor = describeStudy({ studyPath: before.studyPath })
      const withInstance = attachInstance(descriptor, { register: true })
      return { ...buildView(scope, withInstance, record), state: 'bound' }
    }

    if (before.state === 'candidate' || before.state === 'empty' || before.state === 'missing') {
      if (before.configured) {
        const descriptor = describeStudy({ studyPath: before.studyPath })
        const withInstance = attachInstance(descriptor, { register: true })
        const base = buildView(scope, withInstance, null)
        const record = persistRecord(scope, base, before.source)
        if (scope.kind === 'agent') persistWorkspace(scope, base, before.source)
        return { ...buildView(scope, withInstance, record), state: 'bound' }
      }
    }
    return before
  }

  /* ---------- 切换互斥 ---------- */

  function enqueue(run) {
    const next = state.queue.then(run, run)
    state.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * 解析 → 校验 → 切换到目标研究 → 执行 → 返回绑定。
   * 同一进程内的切换串行化，避免两个页面同时把插件加载的研究改来改去。
   * `holdLock:false` 用于长任务（如本地分析）：切换在锁内完成，执行在锁外，
   * 由插件自己的 busy 标志阻止执行期间被切走。
   */
  function withBinding(actor, options, run) {
    const plugin = options && options.plugin
    const mode = (options && options.mode) || 'read'
    const expected = options && options.expected
    const holdLock = !(options && options.holdLock === false)
    return enqueue(async () => {
      const hooks = state.plugins.get(plugin)
      const view = mode === 'write' ? assertWrite(actor, expected, { plugin }) : resolve(actor, { plugin })
      // 长任务在锁外执行，但插件状态必须在锁内捕获，避免执行期间被切到别的研究。
      const captured = typeof (options && options.capture) === 'function' ? options.capture() : undefined
      if (view.state === 'missing') throw new BindingError('study_missing', '当前绑定的研究定义已不存在，请重新连接研究')
      if (hooks) {
        const current = typeof hooks.currentIdentity === 'function' ? hooks.currentIdentity() : null
        const currentKey = current ? (current.studyPath ? `config:${pathKey(current.studyPath)}` : `empty:${pathKey(current.dataRoot)}`) : null
        const wanted = view.configured ? `config:${pathKey(view.studyPath)}` : `empty:${pathKey(view.dataRoot)}`
        if (currentKey && currentKey !== wanted) {
          if (typeof hooks.busy === 'function' && hooks.busy()) throw new BindingError('busy', '插件正在写入或计算，请稍后重试')
          if (typeof hooks.prepareSwitch !== 'function') throw new BindingError('switch_unsupported', '该插件未提供研究切换入口')
          const transaction = hooks.prepareSwitch(view.studyPath)
          try {
            transaction.commit()
            const after = hooks.currentIdentity()
            const afterKey = after && (after.studyPath ? `config:${pathKey(after.studyPath)}` : `empty:${pathKey(after.dataRoot)}`)
            if (afterKey !== wanted) throw new BindingError('switch_failed', `研究切换后身份不一致（期望 ${wanted}，实际 ${afterKey ?? '未知'}），已回滚`)
          } catch (error) {
            try { transaction.rollback() } catch { /* 回滚失败时保留原错误 */ }
            throw error
          }
        } else if (currentKey && view.configured && current && current.revision && String(current.revision).slice(0, 32) !== view.studyRevision) {
          // 同一研究但在外部被改动：重新加载配置，避免继续用旧定义应答。
          if (typeof hooks.busy === 'function' && hooks.busy()) throw new BindingError('busy', '插件正在写入或计算，请稍后重试')
          if (typeof hooks.prepareSwitch === 'function') hooks.prepareSwitch(view.studyPath).commit()
        }
      }
      const invoke = async () => run(view, captured)
      if (holdLock) return { binding: view, value: await invoke() }
      return { binding: view, invoke, deferred: true }
    }).then(async result => {
      if (!result.deferred) return result
      return { binding: result.binding, value: await result.invoke() }
    })
  }

  /* ---------- 能力与候选 ---------- */

  function listStudies() {
    const instances = loadInstances()
    const rows = []
    for (const entry of Object.values(instances.entries)) {
      if (!entry || !entry.instanceKey) continue
      let exists = false
      try { exists = Boolean(entry.configPath) && statSync(entry.configPath).isFile() } catch { exists = false }
      rows.push({
        instanceId: entry.instanceId,
        studyId: entry.studyId,
        name: entry.name,
        studyPath: entry.configPath || null,
        exists,
        empty: Boolean(entry.empty),
        lastSeenAt: entry.lastSeenAt || null,
      })
    }
    rows.sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
    return rows
  }

  function candidates(actor) {
    const scope = actorScope(actor)
    const rows = []
    const projectConfig = scope.cwd ? projectConfigFor(scope.cwd) : null
    if (projectConfig) rows.push({ kind: 'project', studyPath: projectConfig, label: '工作区项目配置' })
    const legacy = legacyDescriptor()
    if (legacy) rows.push({ kind: 'legacy', studyPath: legacy.descriptor.studyPath, label: '旧配置来源' })
    for (const row of listStudies()) rows.push({ kind: 'registered', instanceId: row.instanceId, studyPath: row.studyPath, label: row.name || row.studyId, exists: row.exists })
    const workspace = scope.cwd ? workspaceFor(scope.cwd) : null
    const workspaceRecord = workspace ? bindingRecord(`workspace:${pathKey(workspace.path)}`) : null
    return { projectConfig, legacy: legacy ? legacy.descriptor.studyPath : null, workspace: workspace ? { id: workspace.id || null, path: workspace.path, binding: workspaceRecord } : null, studies: rows }
  }

  /**
   * 最近研究与当前作用域：只读、按 canonical 路径去重、只做有界存在性/配置检查。
   * 不扫描整盘、不写注册表、不根据扫描时间推断权威版本。
   */
  function studyChoices(actor) {
    const scope = actorScope(actor)
    const resolved = resolve(actor)
    const workspace = scope.cwd ? workspaceFor(scope.cwd) : null
    const rows = new Map()
    const keyOf = row => row.studyPath ? `path:${canonicalPath(row.studyPath) || row.studyPath}` : `inst:${row.instanceId || row.studyId || row.name || 'unknown'}`
    const add = row => {
      const key = keyOf(row)
      const current = rows.get(key) || { studyPath: null, studyId: null, name: null, instanceId: null, dataRoot: null, lastSeenAt: null, sources: [], exists: false, valid: false, state: 'unknown', current: false }
      const next = { ...current }
      next.sources = [...new Set([...current.sources, ...(row.sources || [])])]
      for (const field of ['studyPath', 'studyId', 'name', 'instanceId', 'dataRoot', 'lastSeenAt']) if (!next[field] && row[field]) next[field] = row[field]
      rows.set(key, next)
    }
    const legacy = legacyDescriptor()
    if (legacy) add({ studyPath: legacy.descriptor.studyPath, studyId: legacy.descriptor.studyId, name: legacy.descriptor.name, dataRoot: legacy.descriptor.dataRoot, sources: ['legacy'] })
    if (scope.cwd) {
      const projectConfig = projectConfigFor(scope.cwd)
      if (projectConfig) add({ studyPath: projectConfig, sources: ['project'] })
    }
    if (workspace) {
      const record = bindingRecord(`workspace:${pathKey(workspace.path)}`)
      if (record && record.studyPath) add({ studyPath: record.studyPath, instanceId: record.instanceId, sources: ['workspace'] })
    }
    for (const row of listStudies()) add({ studyPath: row.studyPath, instanceId: row.instanceId, studyId: row.studyId, name: row.name, lastSeenAt: row.lastSeenAt, sources: ['recent'] })
    if (resolved.studyPath) add({ studyPath: resolved.studyPath, instanceId: resolved.instanceId, studyId: resolved.studyId, name: resolved.name, sources: ['current'] })

    for (const row of rows.values()) {
      if (!row.studyPath) { row.state = 'empty'; continue }
      row.exists = existsSync(row.studyPath)
      try {
        const info = describeStudy({ studyPath: row.studyPath, cwd: scope.cwd || undefined })
        row.valid = true
        row.studyId = row.studyId || info.studyId
        row.name = row.name || info.name
        row.dataRoot = row.dataRoot || info.dataRoot
        row.state = 'ok'
      } catch (error) {
        row.valid = false
        row.state = row.exists ? 'invalid' : 'missing'
        row.error = error.message
      }
      row.current = Boolean(resolved.studyPath && canonicalPath(row.studyPath) === canonicalPath(resolved.studyPath))
    }
    const recent = [...rows.values()].sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
    return {
      scope: {
        kind: scope.kind,
        cwd: scope.cwd || null,
        page: scope.kind === 'page' ? scope.pageId : null,
        session: scope.kind === 'agent' ? scope.sessionId : null,
        workspace: workspace ? { id: workspace.id || null, path: workspace.path } : null,
      },
      binding: {
        state: resolved.state || null,
        source: resolved.source || null,
        studyId: resolved.studyId || null,
        studyPath: resolved.studyPath || null,
        instanceId: resolved.instanceId || null,
      },
      recent,
    }
  }

  /** 只检查约定位置（不递归）；多个配置原样返回，由用户选择，不按文件名/时间猜。 */
  function discoverStudy(dir) {
    const target = path.resolve(String(dir || ''))
    if (!dir) throw invalid('需要研究目录')
    let info
    try { info = statSync(target) } catch { throw invalid('目录不存在：' + target) }
    if (!info.isDirectory()) throw invalid('不是目录：' + target)
    const places = ['study.json', path.join('.dsh', 'study.json'), path.join('_lab', 'study.json')]
    const configs = []
    for (const relativePath of places) {
      const studyPath = path.join(target, relativePath)
      if (!existsSync(studyPath)) continue
      const row = { relativePath: relativePath.replaceAll('\\', '/'), studyPath, valid: false, problems: [] }
      try {
        const descriptor = describeStudy({ studyPath })
        row.valid = true
        row.studyId = descriptor.studyId
        row.name = descriptor.name
        row.dataRoot = descriptor.dataRoot
      } catch (error) {
        row.problems = [error.message]
      }
      configs.push(row)
    }
    return { dir: target, configs }
  }

  function readCapabilities(actor) {
    const resolved = resolve(actor)
    const plugins = []
    for (const [name, hooks] of state.plugins) {
      let current = null
      try { current = typeof hooks.currentIdentity === 'function' ? hooks.currentIdentity() : null } catch { current = null }
      // 只读能力查询也把插件对齐到当前会话/页面绑定；否则同一启动里没打开过的面板
      // 会暂时停留在各自缓存的空研究，一致性检查误报不一致。busy 时保持原状并如实报告。
      if (resolved.configured && typeof hooks.prepareSwitch === 'function') {
        const wantedForPlugin = `config:${pathKey(resolved.studyPath)}`
        const currentForPlugin = current ? (current.studyPath ? `config:${pathKey(current.studyPath)}` : `empty:${pathKey(current.dataRoot)}`) : null
        if (currentForPlugin !== wantedForPlugin) {
          try { hooks.prepareSwitch(resolved.studyPath).commit(); current = hooks.currentIdentity() } catch { /* 保持原状 */ }
        }
      }
      const currentKey = current ? (current.studyPath ? `config:${pathKey(current.studyPath)}` : `empty:${pathKey(current.dataRoot)}`) : null
      const wantedKey = resolved.configured ? `config:${pathKey(resolved.studyPath)}` : `empty:${pathKey(resolved.dataRoot)}`
      plugins.push({
        name,
        version: hooks.version || null,
        current: current ? { studyId: current.studyId || null, studyPath: current.studyPath || null, revision: current.revision || null } : null,
        matchesBinding: currentKey ? currentKey === wantedKey : null,
      })
    }
    return {
      core: { version: CORE_VERSION, storeDir: state.options.storeDir, profileDir: state.options.profileDir || null },
      actor: { kind: resolved.scope.kind, keyHash: resolved.scope.keyHash },
      binding: resolved,
      plugins,
      consistent: plugins.every(row => row.matchesBinding !== false),
      candidates: candidates(actor),
      warnings: [...state.warnings],
    }
  }

  return {
    version: CORE_VERSION,
    configure,
    registerPlugin,
    setWorkspaces,
    describeStudy,
    legacyStudy,
    resolve,
    connect,
    relocateStudy,
    disconnect,
    assertWrite,
    withBinding,
    readCapabilities,
    candidates,
    listStudies,
    studyChoices,
    discoverStudy,
    minimalDefinition,
    storeFile,
    // 01 文档里的领域方法名，保持与设计文档一一对应（实现见上）。
    resolveBinding: resolve,
    connectStudy: connect,
    assertContext: assertWrite,
    /** 供插件做数据集版本比较：字节级 hash，配置版本与数据版本不混用。 */
    revisionOf(value) {
      if (value === null || value === undefined) return 'empty'
      return sha(typeof value === 'string' ? value : JSON.stringify(value), 32)
    },
    _actorScope: actorScope,
  }
}

export default researchCore
