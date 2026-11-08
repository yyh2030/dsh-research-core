/**
 * @local/research-core/privacy — 本地数据边界与模型侧脱敏（02 阶段）
 *
 * 这个模块故意"悲观"：它不假设宿主一定挡得住旁路工具，而是先检查当前会话
 * 到底能不能被约束成严格本地。挡不住就明确说挡不住，不宣称严格本地。
 *
 * 对应 02 文档「本地与云端的数据流策略」：
 *   - strict-local：本地解析、规则检查、计分、统计与报告；Agent 默认只收到有限状态。
 *   - summary-cloud：只传显式允许的字段与汇总粒度，逐人原始值阻断。
 *   - 通用 read/shell/附件/浏览器/其它插件也是数据通道，必须一起判定。
 */

export const PRIVACY_MODES = ['strict-local', 'summary-cloud']

/** 能绕过"只返回摘要"的宿主能力：它们在会话里存在，就不能声称严格本地。 */
export const BYPASS_TOOLS = {
  read: '可读取任意本地文件',
  write: '可写任意本地文件',
  edit: '可改任意本地文件',
  apply_patch: '可改任意本地文件',
  bash: '可执行任意命令并读取输出',
  shell: '可执行任意命令并读取输出',
  pwsh: '可执行任意命令并读取输出',
  powershell: '可执行任意命令并读取输出',
  terminal: '可执行任意命令并读取输出',
  web_fetch: '可把请求内容发到外部服务',
  web_search: '可把查询词发到外部服务',
  browser: '可把页面内容发到外部服务或读取剪贴板',
  computer_use: '可读取屏幕与任意应用',
  mcp: '第三方工具可能外传数据',
  upload: '可把文件交给外部服务',
  attachment: '附件会进入模型请求',
}

const SENSITIVE_KEY = /(^|_|\b)(name|姓名|phone|mobile|tel|email|mail|address|住址|idcard|身份证|bank|card|rawvalues|raw|values|note|notes|remark|contact)(\b|_|$)/i
const PATH_LIKE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/
const ID_LIKE = /^[A-Za-z]{0,4}[-_]?\d{2,}$/
const URL_LIKE = /https?:\/\/\S+/gi
const FILE_LIKE = /[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.\-]*\.(?:docx?|xlsx?|pptx?|pdf|csv|tsv|json|md|txt|zip|rar|7z|png|jpe?g|gif|webp|bmp|dat|sav|dta|rds|py|js|mjs)\b/gi

/** 文本里的外链与文件名也当作可能外传的定位信息。 */
function scrubText(text) {
  return String(text).replace(URL_LIKE, '[链接]').replace(FILE_LIKE, '[文件名]')
}

/**
 * 判定一次会话能否被当作严格本地。
 * @param {object} input
 * @param {string} [input.mode]
 * @param {string[]} [input.tools] 当前 Agent 可见的工具名
 * @param {boolean} [input.attachments] 会话是否允许附件
 */
export function evaluatePrivacy(input = {}) {
  const mode = PRIVACY_MODES.includes(input.mode) ? input.mode : 'strict-local'
  const tools = Array.isArray(input.tools) ? input.tools.map(String) : []
  const bypasses = []
  for (const tool of tools) {
    const reason = BYPASS_TOOLS[tool]
    if (reason) bypasses.push({ tool, reason })
  }
  if (input.attachments) bypasses.push({ tool: 'attachments', reason: '附件会进入模型请求' })
  const enforceable = mode === 'strict-local' ? bypasses.length === 0 : true
  const note = mode === 'strict-local'
    ? (enforceable
      ? '会话没有可绕过摘要的本地/外传工具，可以按严格本地执行。'
      : `会话存在 ${bypasses.length} 个旁路能力，不能声称严格本地；请改用受限研究 preset 或完全本地模型会话。`)
    : 'summary-cloud 只允许白名单字段与汇总粒度，逐人原始值仍阻断。'
  return { mode, tools, enforceable, bypasses, note }
}

/** 模型侧脱敏：保留汇总与显式允许的键，丢掉可识别个人信息与本地路径。 */
export function modelSafe(value, options = {}) {
  const allowKeys = new Set((options.allowKeys || []).map(String))
  const maxItems = Number.isFinite(options.maxItems) ? Number(options.maxItems) : 20
  const walk = (input, depth) => {
    if (input === null || input === undefined) return input
    if (typeof input === 'string') {
      if (PATH_LIKE.test(input)) return '[本地路径]'
      const scrubbed = scrubText(input)
      if (ID_LIKE.test(scrubbed) && !allowKeys.has('participantId')) return '[编号]'
      return scrubbed
    }
    if (typeof input === 'number' || typeof input === 'boolean') return input
    if (Array.isArray(input)) {
      const trimmed = input.slice(0, maxItems).map(item => walk(item, depth + 1))
      if (input.length > maxItems) trimmed.push(`…共 ${input.length} 项，其余留本地`)
      return trimmed
    }
    if (typeof input !== 'object') return String(input)
    if (depth > 6) return '[层级过深]'
    const output = {}
    for (const [key, item] of Object.entries(input)) {
      if (allowKeys.has(key)) { output[key] = item; continue }
      if (SENSITIVE_KEY.test(key)) continue
      if (/^participant(Key|Id)$/i.test(key)) continue
      output[key] = walk(item, depth + 1)
    }
    return output
  }
  return walk(value, 0)
}

/**
 * 出站检查：越权字段、逐人原始值、过大载荷都在这里拒绝。
 * @param {object} policy { mode, allowedFields, maxBytes }
 * @param {unknown} payload
 */
export function assertOutboundAllowed(policy = {}, payload) {
  const mode = PRIVACY_MODES.includes(policy.mode) ? policy.mode : 'strict-local'
  const allowed = new Set((policy.allowedFields || []).map(String))
  const text = JSON.stringify(payload ?? null)
  const maxBytes = Number.isFinite(policy.maxBytes) ? Number(policy.maxBytes) : 32 * 1024
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw Object.assign(new Error(`出站载荷超过 ${maxBytes} 字节上限`), { code: 'policy_blocked' })
  }
  if (mode === 'strict-local') {
    throw Object.assign(new Error('严格本地模式不允许把研究数据交给外部模型或服务'), { code: 'policy_blocked' })
  }
  const blocked = []
  const walk = (input, trail) => {
    if (input === null || input === undefined) return
    if (Array.isArray(input)) { input.forEach((item, index) => walk(item, `${trail}[${index}]`)); return }
    if (typeof input !== 'object') return
    for (const [key, item] of Object.entries(input)) {
      const where = trail ? `${trail}.${key}` : key
      const allowedHere = allowed.has(key) || allowed.has(where)
      if (SENSITIVE_KEY.test(key) && !allowedHere) blocked.push(where)
      if (/^participant(Key|Id)$/i.test(key) && !allowedHere) blocked.push(where)
      if (typeof item === 'object') walk(item, where)
    }
  }
  walk(payload, '')
  if (blocked.length) {
    throw Object.assign(new Error(`出站载荷包含未允许的字段：${[...new Set(blocked)].slice(0, 6).join('、')}`), {
      code: 'policy_blocked', fields: [...new Set(blocked)],
    })
  }
  return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), mode }
}

const SYNC_PROVIDERS = [
  ['OneDrive', /\\onedrive\b|onedrive/i],
  ['iCloud Drive', /icloud/i],
  ['Dropbox', /dropbox/i],
  ['Google Drive', /google\s*drive|googledrive/i],
  ['坚果云', /nutstore|jianguoyun/i],
  ['百度网盘', /baidunetdisk|baiduyun/i],
]

/**
 * 路径事实：只根据路径文本给出提示，不能保证识别所有同步软件。
 * 新建研究时用它把"这个目录可能被操作系统/同步盘上传"讲清楚。
 */
export function describeStorageLocation(target) {
  const text = String(target || '')
  const providers = SYNC_PROVIDERS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
  return {
    path: text,
    syncProviders: providers,
    networkShare: /^[\\/]{2}/.test(text) || /^\\\\\?\\UNC\\/i.test(text),
    warning: providers.length
      ? `该目录看起来在 ${providers.join('、')} 同步范围内：即使数据在本地，操作系统或同步客户端仍可能把它上传。建议把研究数据放在非同步目录。`
      : '未从路径文本识别到常见同步盘；这不能保证目录一定不同步。',
  }
}
