/**
 * @local/research-core/host — 插件侧的宿主适配层。
 *
 * 四个业务插件都用它接同一个研究核心：
 *   - register()：把插件的加载器、当前身份与切换事务登记给核心；
 *   - pageActor(req)：把浏览器请求识别为"页面身份"（pageId 由页面提供）；
 *   - agentActor(exec)：把工具调用识别为"会话身份"（Agent id + 会话 cwd）；
 *   - read()/write()：解析 → 校验 → 切换 → 执行，并把绑定回传给页面；
 *   - connect()：显式连接已有研究或创建空研究（UI 与工具同一实现）。
 *
 * 这里不做业务判断：读写目标始终是调用身份解析出的那一个研究。
 */

import { researchCore, BindingError } from './index.mjs'

export { BindingError }

const HEADER = 'x-dsh-page'
/** 宿主适配层版本：用于确认热重载后加载的是哪一份 host.mjs（依赖模块会被 ESM 缓存）。 */
export const HOST_VERSION = '2026-11-06-cwd'

export function hostBinding(ctx, options) {
  const plugin = options.plugin
  const config = options.config || {}
  const core = researchCore({ profileDir: process.env.DSH_PROFILE_DIR || '' })

  const localCwd = () => {
    try {
      const working = ctx.get && ctx.get('workingDirectory')
      if (working && typeof working.defaultDirectory === 'string' && working.defaultDirectory) return working.defaultDirectory
    } catch { /* 无宿主服务时退回进程目录 */ }
    return process.cwd()
  }

  function sessionCwd(sessionId) {
    if (!sessionId) return localCwd()
    try {
      const sessions = ctx.get && ctx.get('sessions')
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
      if (session) {
        // Session.header.cwd 是创建时的不变值；用户 cd 之后的有效目录在 workingDirectory 里。
        const working = ctx.get && ctx.get('workingDirectory')
        if (working && typeof working.get === 'function') {
          const effective = working.get(session)
          if (typeof effective === 'string' && effective) return effective
        }
        const cwd = session.header && session.header.cwd
        if (typeof cwd === 'string' && cwd) return cwd
      }
    } catch { /* 会话不在本进程或服务不可用时按默认目录 */ }
    return localCwd()
  }

  function syncWorkspaces() {
    try {
      const registry = ctx.get && ctx.get('workspaceRegistry')
      if (!registry || typeof registry.list !== 'function') return
      const list = registry.list()
      core.setWorkspaces(list.map(row => ({ id: row.id, path: row.path, title: row.title })))
    } catch { /* 工作区服务不可用时保留上次清单 */ }
  }

  let unregister = null
  if (options.hooks) {
    unregister = core.registerPlugin(plugin, {
      version: options.version || null,
      legacyStudyPath: config.studyPath || '',
      legacyProjectRoot: config.projectRoot || '',
      emptyBase: options.hooks.emptyBase,
      loadStudy: options.hooks.loadStudy,
      currentIdentity: options.hooks.currentIdentity,
      prepareSwitch: options.hooks.prepareSwitch,
      busy: options.hooks.busy,
    })
  }

  /** 页面身份：浏览器每个标签页一个 pageId；缺失时退化为只读探针身份。 */
  function pageActor(input = {}) {
    const header = input.req && input.req.headers ? input.req.headers[HEADER] : ''
    const pageId = String(input.pageId || header || '').trim()
    if (pageId) return { kind: 'page', pageId, cwd: input.cwd || localCwd() }
    return { kind: 'probe', label: plugin, cwd: localCwd() }
  }

  /** 会话身份：工具调用由宿主保证 exec.agent 是发起该调用的会话。 */
  function agentActor(exec) {
    const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
    if (!sessionId) return { kind: 'probe', label: `${plugin}#tool`, cwd: localCwd() }
    return { kind: 'agent', sessionId, cwd: sessionCwd(sessionId) }
  }

  async function activate(actor) {
    const result = await core.withBinding(actor, { plugin, mode: 'read' }, view => view)
    return result.binding
  }

  async function read(actor, run) {
    syncWorkspaces()
    const result = await core.withBinding(actor, { plugin, mode: 'read' }, async view => run(view))
    return { binding: result.binding, data: result.value }
  }

  async function write(actor, expected, run, options = {}) {
    syncWorkspaces()
    if (actor.kind === 'probe') throw new BindingError('binding_required', '写入需要页面或会话的研究绑定，请刷新页面后重试')
    const result = await core.withBinding(actor, { plugin, mode: 'write', expected, holdLock: options.holdLock !== false, capture: options.capture }, async (view, captured) => run(view, captured))
    return { binding: result.binding, data: result.value }
  }

  /**
   * 显式连接研究。create:true 表示在该路径写一份新的空研究定义。
   * 页面连接只改页面绑定；会话连接同时改会话与所属工作区的绑定。
   */
  function connect(actor, payload = {}) {
    syncWorkspaces()
    const view = core.connect(actor, {
      plugin,
      studyPath: payload.studyPath,
      create: payload.create === true,
      definition: payload.definition,
      studyId: payload.studyId,
      name: payload.name,
      source: payload.source || (actor.kind === 'page' ? 'page-connect' : 'session-connect'),
    })
    return view
  }

  function capabilities(actor) {
    syncWorkspaces()
    const result = core.readCapabilities(actor)
    return { ...result, core: { ...result.core, hostVersion: HOST_VERSION } }
  }

  return {
    core,
    plugin,
    sessionCwd,
    syncWorkspaces,
    pageActor,
    agentActor,
    activate,
    read,
    write,
    connect,
    capabilities,
    dispatch(scope) { if (unregister) scope.effect(unregister, `${plugin}: research binding`) },
    dispose() { if (unregister) unregister(); unregister = null },
  }
}

/** 把核心的结构化错误码映射到各插件既有的 HTTP 状态语义。 */
export function bindingStatus(error) {
  const code = error && error.code
  if (code === 'binding_required') return 409
  if (code === 'binding_conflict') return 409
  if (code === 'study_missing') return 409
  if (code === 'busy') return 409
  if (code === 'actor') return 400
  if (code === 'invalid') return 400
  if (code === 'study_config') return 400
  return 0
}
