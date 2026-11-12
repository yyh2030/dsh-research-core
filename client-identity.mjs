/**
 * 页面身份与绑定快照（浏览器可用，无 Node 依赖）。
 *
 * 四个业务插件共用同一份逻辑：
 *   - pageId 首次生成后立即写入 sessionStorage（共享键 + 插件前缀键）；
 *   - 同一标签内四插件通过共享键/内存单例拿到同一个 pageId；
 *   - 没有 sessionStorage（隐私模式/禁用）时退回本标签进程内唯一 ID，
 *     绝不使用所有页面共用的 localStorage 常量；
 *   - BroadcastChannel 握手检测克隆标签（sessionStorage 被复制时换新 ID）；
 *   - 工作区切换递增本地 bindingRevision 并清空当前令牌；
 *   - 每次请求 capture 页面/工作区/绑定，响应回来后核对，晚到响应不覆盖新状态。
 *
 * client.js 不能打包 ESM，因此 `python research-core/scripts/sync-client-identity.mjs`
 * 会把 #region browser-core 原样嵌进四个 client bundle 的预置段；测试会核对两边一致。
 */

// #region browser-core
const DSH_RESEARCH_CLIENT_IDENTITY = (function () {
  const IDENTITY_VERSION = '2026-11-10-u02'
  /** 共享键：同一标签里四个插件都读它，保证 pageId 一致。 */
  const PAGE_KEY = 'dsh:research:page:v3'
  /** 每个插件自己的键：键名含插件前一等公民前缀，便于诊断与单独清理。 */
  const PAGE_KEY_PREFIX = 'dsh:research:page:v3:plugin'
  const WORKSPACE_KEY = 'dsh:research:workspace:v3'
  const REVISION_KEY = 'dsh:research:page-revision:v3'
  const TAB_CHANNEL = 'dsh-research-tab-v3'
  const GLOBAL_KEY = '__DSH_RESEARCH_CLIENT_IDENTITY__'
  const PAGE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/
  const PROBE_TIMEOUT_MS = 60
  /** 同一 realm（一个标签页）里所有插件共用的随机标签指纹，用来区分同标签兄弟与克隆标签。 */
  const tabNonce = randomToken()

  function randomToken(length) {
    const bytes = new Uint8Array(Math.ceil((length || 24) / 2))
    const cryptoSource = typeof globalThis !== 'undefined' ? globalThis.crypto : null
    if (cryptoSource && typeof cryptoSource.getRandomValues === 'function') cryptoSource.getRandomValues(bytes)
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  }

  function randomPageId() { return randomToken(24) }

  function isPageId(value) { return typeof value === 'string' && PAGE_ID_RE.test(value) }

  function pluginPageKey(plugin) {
    const name = String(plugin || 'unknown').trim() || 'unknown'
    return PAGE_KEY_PREFIX + ':' + name
  }

  function safeSegment(value) {
    const text = String(value === null || value === undefined ? '' : value).trim()
    if (!text) return 'none'
    return text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96) || 'none'
  }

  /** 数据集标识：优先 dataRoot，其次研究定义路径，最后 studyId；只用于草稿键隔离。 */
  function datasetKey(binding) {
    if (!binding || typeof binding !== 'object') return 'none'
    return safeSegment(binding.dataRoot || binding.studyPath || binding.dataset || binding.studyId || 'none')
  }

  function instanceKey(binding) {
    return safeSegment(binding && (binding.instanceId || binding.studyId) || 'none')
  }

  /** study-ops 写到 scale-desk 的焦点提示：同一研究实例 + 同一数据集才复用。 */
  function focusKey(binding) {
    return 'dsh:research:focus:v2:' + instanceKey(binding) + ':' + datasetKey(binding)
  }

  /** analysis-run 方案草稿：实例 + 数据集（dataPath），不能只按 studyId 存。 */
  function planDraftKey(binding, dataPath, studyId) {
    return 'analysis-plan:v2:' + instanceKey(binding) + ':' + safeSegment(studyId || (binding && binding.studyId)) + ':' + safeSegment(dataPath || datasetKey(binding))
  }

  /** demographic-coder 数据集草稿：实例 + 数据集名。 */
  function datasetDraftKey(prefix, binding, dataset) {
    return String(prefix || 'dc:dataset:v3') + ':' + instanceKey(binding) + ':' + safeSegment(dataset || datasetKey(binding))
  }

  /**
   * 从 Client Slot/Service 契约读取当前标签所属工作区。
   * 只读 uiWorkspace 的当前会话与工作区成员关系；拿不到就返回 null，绝不猜 cwd。
   */
  function workspaceFromContext(ctx) {
    try {
      if (!ctx || typeof ctx.get !== 'function') return null
      const ui = ctx.get('uiWorkspace')
      if (!ui) return null
      const selection = ui.selection && typeof ui.selection.getSnapshot === 'function' ? ui.selection.getSnapshot() : null
      const sessionId = selection && selection.sessionId
      const snapshot = ui.workspaces && ui.workspaces.list && typeof ui.workspaces.list.getSnapshot === 'function' ? ui.workspaces.list.getSnapshot() : null
      const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
      let workspace = null
      if (sessionId) workspace = items.find(item => item && Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)) || null
      if (!workspace && selection && selection.workspaceId) workspace = items.find(item => item && item.workspaceId === selection.workspaceId) || null
      if (!workspace) return null
      return { id: workspace.workspaceId || '', path: workspace.path || '' }
    } catch { return null }
  }

  function safeStorage(global) {
    try { return global && global.sessionStorage ? global.sessionStorage : null } catch { return null }
  }

  function createClientIdentity(options) {
    const settings = options || {}
    const global = settings.global || (typeof globalThis !== 'undefined' ? globalThis : null)
    const plugin = String(settings.plugin || 'unknown')
    const storage = settings.storage !== undefined ? settings.storage : safeStorage(global)
    // 只从页面 window（或显式注入）取 BroadcastChannel；Node 测试进程的全局实现
    // 不能被误当成浏览器标签能力，否则测试/宿主进程会被常驻通道挂住。
    const broadcastFactory = settings.BroadcastChannel || (global && global.BroadcastChannel) || null
    const workspaceProvider = settings.workspaceProvider || null
    const random = typeof settings.random === 'function' ? settings.random : randomPageId
    const tabId = settings.tabId || tabNonce
    const pageKey = pluginPageKey(plugin)
    let pageId = ''
    let workspace = null
    let revision = 0
    let binding = null
    let readyPromise = null
    let channel = null

    function read(key) {
      try { return storage && typeof storage.getItem === 'function' ? String(storage.getItem(key) || '') : '' } catch { return '' }
    }
    function write(key, value) {
      try { if (storage && typeof storage.setItem === 'function') storage.setItem(key, String(value)); return true } catch { return false }
    }
    function remove(key) { try { if (storage && typeof storage.removeItem === 'function') storage.removeItem(key) } catch { /* ignore */ } }

    function workspaceStorageKey(id) { return WORKSPACE_KEY + ':' + id }
    function revisionStorageKey(id) { return REVISION_KEY + ':' + id }

    function readWorkspace() {
      const raw = read(workspaceStorageKey(pageId))
      if (!raw) return null
      try {
        const value = JSON.parse(raw)
        return value && typeof value === 'object' ? { id: String(value.id || ''), path: String(value.path || '') } : null
      } catch { return null }
    }
    function readRevision() {
      const value = Number(read(revisionStorageKey(pageId)))
      return Number.isFinite(value) && value >= 0 ? value : 0
    }
    function persistWorkspace() {
      if (!pageId) return
      if (workspace) write(workspaceStorageKey(pageId), JSON.stringify(workspace))
      else remove(workspaceStorageKey(pageId))
      write(revisionStorageKey(pageId), String(revision))
    }

    function normalizeWorkspace(value) {
      if (!value) return null
      if (typeof value === 'string') return { id: value.trim(), path: '' }
      const id = String(value.id || value.workspaceId || '').trim()
      const path = typeof value.path === 'string' ? value.path.trim() : ''
      if (!id && !path) return null
      return { id, path }
    }

    function installChannel() {
      if (channel || !broadcastFactory) return
      try {
        channel = new broadcastFactory(TAB_CHANNEL)
        if (typeof channel.addEventListener === 'function') {
          channel.addEventListener('message', event => {
            const message = event && event.data ? event.data : event
            if (!message || message.type !== 'identity-probe' || !message.nonce) return
            // 同一标签的四个兄弟共用一个 tab 指纹，不能互相判成克隆；只回答其他标签的探测。
            if (message.tab === tabId) return
            if (message.pageId !== pageId) return
            try { channel.postMessage({ type: 'identity-alive', pageId, nonce: message.nonce }) } catch { /* ignore */ }
          })
        }
      } catch { channel = null }
    }

    /** 克隆标签会复制 sessionStorage；用 BroadcastChannel 问一下这个 pageId 是否已在别的标签活着。 */
    async function contested(id) {
      if (!broadcastFactory) return false
      let probe = null
      try { probe = new broadcastFactory(TAB_CHANNEL) } catch { return false }
      return await new Promise(resolve => {
        let settled = false
        const nonce = random()
        const finish = value => {
          if (settled) return
          settled = true
          try { if (probe && typeof probe.close === 'function') probe.close() } catch { /* ignore */ }
          resolve(value)
        }
        if (typeof probe.addEventListener === 'function') {
          probe.addEventListener('message', event => {
            const message = event && event.data ? event.data : event
            if (message && message.type === 'identity-alive' && message.pageId === id && message.nonce === nonce) finish(true)
          })
        }
        try { probe.postMessage({ type: 'identity-probe', pageId: id, nonce, tab: tabId }) } catch { finish(false); return }
        setTimeout(() => finish(false), PROBE_TIMEOUT_MS)
      })
    }

    function ready() {
      if (readyPromise) return readyPromise
      readyPromise = (async () => {
        const storedPlugin = read(pageKey)
        const storedShared = read(PAGE_KEY)
        // 共享键优先：四个插件以它为唯一事实；插件键只做诊断/清理辅助。
        let candidate = isPageId(storedShared) ? storedShared : (isPageId(storedPlugin) ? storedPlugin : '')
        // 同标签的兄弟插件已经通过共享内存确认过这个身份，不必再互探。
        if (candidate && candidate !== memoryPageId() && await contested(candidate)) candidate = ''
        if (!candidate) {
          candidate = isPageId(memoryPageId()) ? memoryPageId() : random()
          // 进程内唯一 ID：同一标签的四个插件通过共享内存拿到同一个值，克隆/无 storage 时也彼此不同。
          setMemoryPageId(candidate)
          write(pageKey, candidate)
          write(PAGE_KEY, candidate)
        } else {
          setMemoryPageId(candidate)
          if (storedPlugin !== candidate) write(pageKey, candidate)
          if (storedShared !== candidate) write(PAGE_KEY, candidate)
        }
        pageId = candidate
        if (!workspace) workspace = readWorkspace()
        revision = Math.max(revision, readRevision())
        installChannel()
        return pageId
      })()
      return readyPromise
    }

    // 进程内单例挂在全局 API 上：四个插件 bundle 共用同一个 API 实例时通过它对齐。
    function memoryPageId() {
      try { return global && global.__DSH_RESEARCH_PAGE_MEMORY__ ? String(global.__DSH_RESEARCH_PAGE_MEMORY__) : '' } catch { return '' }
    }
    function setMemoryPageId(value) {
      try { if (global) global.__DSH_RESEARCH_PAGE_MEMORY__ = value } catch { /* ignore */ }
    }

    /** 同标签任一插件 newPage 后，其他插件下次请求前要采纳新的共享 pageId。 */
    function syncPageFromGlobal() {
      const sharedMemory = memoryPageId()
      if (!isPageId(sharedMemory) || sharedMemory === pageId) return
      pageId = sharedMemory
      workspace = readWorkspace()
      revision = readRevision()
      binding = null
    }

    function ensure() {
      syncPageFromGlobal()
      if (!pageId) {
        // 同步路径也不能覆盖已持久化的身份；只有确实没有候选时才生成。
        const storedShared = read(PAGE_KEY)
        const storedPlugin = read(pageKey)
        const stored = isPageId(storedShared) ? storedShared : (isPageId(storedPlugin) ? storedPlugin : '')
        pageId = stored || (isPageId(memoryPageId()) ? memoryPageId() : random())
        setMemoryPageId(pageId)
        if (!stored) write(PAGE_KEY, pageId)
        if (storedPlugin !== pageId) write(pageKey, pageId)
        if (!workspace) workspace = readWorkspace()
        revision = Math.max(revision, readRevision())
      }
      return pageId
    }

    function syncWorkspace(ctx) {
      if (typeof workspaceProvider !== 'function' || !pageId) return workspace
      let next = null
      try { next = workspaceProvider(ctx) } catch { next = null }
      return setWorkspace(next)
    }

    function setWorkspace(next) {
      const normalized = normalizeWorkspace(next)
      if (!normalized) return workspace
      if (workspace && workspace.id === normalized.id && workspace.path === normalized.path) return workspace
      if (workspace) {
        // 同标签切换工作区：绑定代次递增，旧令牌作废。
        revision += 1
        binding = null
      }
      workspace = normalized
      persistWorkspace()
      return workspace
    }

    function newPage() {
      const next = random()
      pageId = next
      setMemoryPageId(next)
      revision = 0
      binding = null
      write(pageKey, next)
      write(PAGE_KEY, next)
      persistWorkspace()
      installChannel()
      return next
    }

    function prepare(ctx) {
      syncPageFromGlobal()
      ensure()
      if (typeof workspaceProvider === 'function') syncWorkspace(ctx)
      return begin()
    }

    function begin() {
      ensure()
      return {
        pageId,
        workspaceId: workspace ? workspace.id : '',
        workspacePath: workspace ? workspace.path : '',
        bindingRevision: revision,
        studyId: binding ? binding.studyId || '' : '',
        instanceId: binding ? binding.instanceId || '' : '',
        token: binding ? binding.token || '' : '',
      }
    }

    function headers() {
      ensure()
      const result = { 'x-dsh-page': pageId }
      if (workspace && workspace.id) result['x-dsh-workspace'] = workspace.id
      return result
    }

    function body() {
      ensure()
      const result = { pageId, bindingRevision: revision }
      if (workspace && workspace.id) result.workspaceId = workspace.id
      // 写入令牌必须随请求体发送：连接/读取响应会 remember() 令牌，但只有 body 带上它，
      // 服务端 assertWrite 才会认为这是当前页面的绑定（否则页面永远 binding_required）。
      if (binding && binding.token) result.binding = binding.token
      return result
    }

    function capture() { return begin() }

    function remember(nextBinding) {
      if (!nextBinding || typeof nextBinding !== 'object' || !nextBinding.token) return binding
      binding = {
        token: String(nextBinding.token),
        studyId: nextBinding.studyId || (nextBinding.study && nextBinding.study.id) || '',
        instanceId: nextBinding.instanceId || (nextBinding.study && nextBinding.study.instanceId) || '',
        studyRevision: nextBinding.studyRevision || (nextBinding.study && nextBinding.study.revision) || '',
        bindingRevision: Number(nextBinding.bindingRevision) || 0,
        workspaceId: nextBinding.workspaceId || '',
      }
      return binding
    }

    function staleError(message, details) {
      const error = new Error(message)
      error.code = 'stale_response'
      error.details = details
      return error
    }

    /**
     * 响应回来后核对本次 capture：页面、工作区代次或研究身份变了就拒绝，
     * 由调用方丢弃这次结果，不能覆盖新页面状态。
     */
    function assertResponse(snapshot, responseBinding, options) {
      if (!snapshot) return true
      if (snapshot.pageId !== pageId) throw staleError('页面身份已变化，忽略过时响应', { pageId, expected: snapshot.pageId })
      if (snapshot.bindingRevision !== revision) throw staleError('页面绑定已切换，忽略过时响应', { bindingRevision: revision, expected: snapshot.bindingRevision })
      const workspaceId = workspace ? workspace.id : ''
      if ((snapshot.workspaceId || '') !== workspaceId) throw staleError('页面工作区已切换，忽略过时响应', { workspaceId, expected: snapshot.workspaceId })
      if (responseBinding && typeof responseBinding === 'object') {
        const allowRebind = options && options.allowRebind === true
        const responseStudy = responseBinding.studyId || (responseBinding.study && responseBinding.study.id) || ''
        const responseInstance = responseBinding.instanceId || (responseBinding.study && responseBinding.study.instanceId) || ''
        const responseWorkspace = responseBinding.workspaceId || ''
        if (responseWorkspace && workspaceId && responseWorkspace !== workspaceId) {
          throw staleError('响应来自其他工作区，已丢弃', { workspaceId, responseWorkspace })
        }
        if (!allowRebind) {
          if (snapshot.studyId && responseStudy && snapshot.studyId !== responseStudy) {
            throw staleError('响应属于其他研究，已丢弃', { studyId: responseStudy, expected: snapshot.studyId })
          }
          if (snapshot.instanceId && responseInstance && snapshot.instanceId !== responseInstance) {
            throw staleError('响应属于其他研究实例，已丢弃', { instanceId: responseInstance, expected: snapshot.instanceId })
          }
        }
      }
      return true
    }

    function accept(snapshot, responseBinding, options) {
      assertResponse(snapshot, responseBinding, options)
      return remember(responseBinding)
    }

    // 首次创建就落盘：隐私模式下也会落到本标签的进程内单例。
    void ready().catch(() => {})

    return {
      version: IDENTITY_VERSION,
      plugin,
      ready,
      ensure,
      pageId() { return ensure() },
      newPage,
      prepare,
      begin,
      syncWorkspace,
      setWorkspace,
      workspace() { return workspace ? { ...workspace } : null },
      revision() { return revision },
      headers,
      body,
      capture,
      remember,
      binding() { return binding ? { ...binding } : null },
      assertResponse,
      accept,
      focusKey() { return focusKey(binding) },
      planDraftKey(dataPath) { return planDraftKey(binding, dataPath, binding && binding.studyId) },
      datasetDraftKey(prefix, dataset) { return datasetDraftKey(prefix, binding, dataset) },
      staleError,
    }
  }

  return {
    IDENTITY_VERSION,
    PAGE_KEY,
    PAGE_KEY_PREFIX,
    WORKSPACE_KEY,
    REVISION_KEY,
    TAB_CHANNEL,
    GLOBAL_KEY,
    randomPageId,
    isPageId,
    pluginPageKey,
    safeSegment,
    datasetKey,
    instanceKey,
    focusKey,
    planDraftKey,
    datasetDraftKey,
    workspaceFromContext,
    createClientIdentity,
  }
})()
// #endregion browser-core

export const IDENTITY_VERSION = DSH_RESEARCH_CLIENT_IDENTITY.IDENTITY_VERSION
export const PAGE_KEY = DSH_RESEARCH_CLIENT_IDENTITY.PAGE_KEY
export const PAGE_KEY_PREFIX = DSH_RESEARCH_CLIENT_IDENTITY.PAGE_KEY_PREFIX
export const WORKSPACE_KEY = DSH_RESEARCH_CLIENT_IDENTITY.WORKSPACE_KEY
export const REVISION_KEY = DSH_RESEARCH_CLIENT_IDENTITY.REVISION_KEY
export const TAB_CHANNEL = DSH_RESEARCH_CLIENT_IDENTITY.TAB_CHANNEL
export const GLOBAL_KEY = DSH_RESEARCH_CLIENT_IDENTITY.GLOBAL_KEY
export const randomPageId = DSH_RESEARCH_CLIENT_IDENTITY.randomPageId
export const isPageId = DSH_RESEARCH_CLIENT_IDENTITY.isPageId
export const pluginPageKey = DSH_RESEARCH_CLIENT_IDENTITY.pluginPageKey
export const safeSegment = DSH_RESEARCH_CLIENT_IDENTITY.safeSegment
export const datasetKey = DSH_RESEARCH_CLIENT_IDENTITY.datasetKey
export const instanceKey = DSH_RESEARCH_CLIENT_IDENTITY.instanceKey
export const focusKey = DSH_RESEARCH_CLIENT_IDENTITY.focusKey
export const planDraftKey = DSH_RESEARCH_CLIENT_IDENTITY.planDraftKey
export const datasetDraftKey = DSH_RESEARCH_CLIENT_IDENTITY.datasetDraftKey
export const workspaceFromContext = DSH_RESEARCH_CLIENT_IDENTITY.workspaceFromContext
export const createClientIdentity = DSH_RESEARCH_CLIENT_IDENTITY.createClientIdentity
export default DSH_RESEARCH_CLIENT_IDENTITY
