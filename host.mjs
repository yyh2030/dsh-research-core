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

import { researchCore, BindingError, isInside } from './index.mjs'

export { BindingError }

const HEADER = 'x-dsh-page'
const WORKSPACE_HEADER = 'x-dsh-workspace'
const WORKSPACE_PATH_HEADER = 'x-dsh-workspace-path'
/** 宿主适配层版本：用于确认热重载后加载的是哪一份 host.mjs（依赖模块会被 ESM 缓存）。 */
export const HOST_VERSION = '2026-11-10-page-workspace'

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

  /** 宿主工作区清单：pageActor 只在这里查工作区，不信任页面自己报的 cwd。 */
  function hostWorkspaces() {
    try {
      const registry = ctx.get && ctx.get('workspaceRegistry')
      if (!registry || typeof registry.list !== 'function') return []
      return registry.list().filter(row => row && typeof row.path === 'string' && row.path).map(row => ({ id: row.id || '', path: row.path, title: row.title || '' }))
    } catch { return [] }
  }

  /**
   * 宿主注入的页面上下文。只有宿主挂在 req 上的对象才算数；
   * 请求头/请求体里的 sessionId/workspace 是客户端可伪造的，不能当作认证依据。
   */
  function hostPageContext(req) {
    if (!req || typeof req !== 'object') return null
    const raw = req.hostContext || req.dshPageContext || req.dshContext
    const workspace = req.workspace && typeof req.workspace === 'object' ? req.workspace : null
    const session = req.session && typeof req.session === 'object' ? req.session : null
    const source = raw && typeof raw === 'object' ? raw : (workspace ? {
      workspaceId: workspace.workspaceId || workspace.id,
      workspacePath: workspace.workspacePath || workspace.path,
      sessionId: session && (session.sessionId || session.id),
      cwd: (session && session.cwd) || workspace.cwd,
    } : (session ? {
      sessionId: session.sessionId || session.id,
      cwd: session.cwd,
    } : null))
    if (!source || typeof source !== 'object') return null
    return {
      workspaceId: String(source.workspaceId || source.id || '').trim(),
      workspacePath: typeof source.workspacePath === 'string' ? source.workspacePath : (typeof source.path === 'string' ? source.path : ''),
      sessionId: String(source.sessionId || '').trim(),
      cwd: typeof source.cwd === 'string' ? source.cwd : '',
    }
  }

  function workspaceMismatch(message, details) {
    return new BindingError('workspace_mismatch', message, details)
  }

  /**
   * 页面身份：浏览器每个标签页一个 pageId；workspace/cwd 由宿主校验后注入。
   * - 客户端只能报 workspaceId/cwd 候选值，必须能在宿主工作区清单里找到；
   * - 页面请求里自带的 sessionId 一律拒绝，页面不能冒充会话；
   * - 宿主注入的上下文优先，客户端声明与注入不一致时直接拒绝。
   */
  function pageActor(input = {}) {
    const req = input.req || {}
    const header = req.headers ? req.headers[HEADER] : ''
    const pageId = String(input.pageId || header || '').trim()
    if (!pageId) return { kind: 'probe', label: plugin, cwd: localCwd() }

    if (input.sessionId || (req.headers && req.headers['x-dsh-session'] && !hostPageContext(req))) {
      throw new BindingError('actor', '页面请求不能自行声明会话身份，请由宿主注入页面所属会话')
    }

    const injected = hostPageContext(req)
    const workspaces = hostWorkspaces()
    const suppliedWorkspaceId = String(input.workspaceId || (req.headers ? req.headers[WORKSPACE_HEADER] : '') || '').trim()
    const suppliedWorkspacePath = String(input.workspacePath || (req.headers ? req.headers[WORKSPACE_PATH_HEADER] : '') || '').trim()
    let workspaceId = suppliedWorkspaceId || (injected && injected.workspaceId) || ''
    let workspacePath = suppliedWorkspacePath || (injected && injected.workspacePath) || ''
    let cwd = typeof input.cwd === 'string' ? input.cwd : (injected && injected.cwd) || ''

    // 客户端声明与宿主注入不一致：拒绝，不能靠页面自报切到别的工作区。
    if (injected && injected.workspaceId && suppliedWorkspaceId && suppliedWorkspaceId !== injected.workspaceId) {
      throw workspaceMismatch('页面工作区与宿主注入的工作区不一致', { workspaceId: injected.workspaceId, supplied: suppliedWorkspaceId })
    }
    if (injected && injected.workspacePath && suppliedWorkspacePath && suppliedWorkspacePath !== injected.workspacePath && !isInside(injected.workspacePath, suppliedWorkspacePath) && !isInside(suppliedWorkspacePath, injected.workspacePath)) {
      throw workspaceMismatch('页面工作区路径与宿主注入不一致', { workspacePath: injected.workspacePath })
    }
    if (injected && injected.workspaceId) workspaceId = injected.workspaceId
    if (injected && injected.workspacePath) workspacePath = injected.workspacePath
    if (injected && injected.cwd) cwd = injected.cwd

    let workspace = null
    if (workspaceId) workspace = workspaces.find(row => row.id === workspaceId) || null
    if (!workspace && workspacePath) workspace = workspaces.find(row => isInside(row.path, workspacePath) || isInside(workspacePath, row.path)) || null
    // 宿主注入的上下文本身就是可信来源；工作区清单暂时读不到时仍以注入值为准。
    if (!workspace && injected && injected.workspaceId && (!workspaceId || workspaceId === injected.workspaceId)) {
      workspace = { id: injected.workspaceId, path: injected.workspacePath || injected.cwd || '' }
    }
    if (!workspace && cwd) {
      // 客户端自报的 cwd 只有落在已登记工作区里才被采信；宿主注入的 cwd 本身可信。
      workspace = workspaces.find(row => isInside(row.path, cwd)) || null
      if (!workspace && injected) workspace = { id: injected.workspaceId || '', path: cwd }
      if (!workspace) throw workspaceMismatch('页面工作区不在宿主已登记的工作区列表中', { cwd })
    }
    if (workspaceId && !workspace) throw workspaceMismatch('页面工作区不在宿主已登记的工作区列表中', { workspaceId })
    if (workspace && cwd && !isInside(workspace.path, cwd)) {
      throw workspaceMismatch('页面 cwd 与工作区不一致', { workspaceId: workspace.id, cwd })
    }
    if (workspace && workspaceId && workspace.id && workspace.id !== workspaceId) {
      throw workspaceMismatch('页面工作区身份与 cwd 指向的工作区不一致', { workspaceId, resolved: workspace.id })
    }

    if (injected && injected.sessionId) {
      const sessionCwd = sessionCwd(injected.sessionId)
      if (workspace && sessionCwd && !isInside(workspace.path, sessionCwd)) {
        throw workspaceMismatch('宿主会话不属于页面声明的工作区', { sessionId: injected.sessionId, workspaceId: workspace.id })
      }
    }

    const resolvedCwd = workspace ? workspace.path : (cwd || localCwd())
    return {
      kind: 'page',
      pageId,
      cwd: resolvedCwd,
      workspaceId: workspace ? workspace.id : (workspaceId || ''),
      workspacePath: workspace ? workspace.path : '',
      sessionId: injected && injected.sessionId ? injected.sessionId : undefined,
    }
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
    legacyStudy: () => core.legacyStudy(),
    dispatch(scope) { if (unregister) scope.effect(unregister, `${plugin}: research binding`) },
    dispose() { if (unregister) unregister(); unregister = null },
  }
}

/** 把核心的结构化错误码映射到各插件既有的 HTTP 状态语义。 */
export function bindingStatus(error) {
  const code = error && error.code
  if (code === 'binding_required') return 409
  if (code === 'binding_conflict') return 409
  if (code === 'workspace_mismatch') return 409
  if (code === 'study_missing') return 409
  if (code === 'busy') return 409
  if (code === 'actor') return 400
  if (code === 'invalid') return 400
  if (code === 'study_config') return 400
  return 0
}
