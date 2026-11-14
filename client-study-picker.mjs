/**
 * 共享研究选择器（浏览器实现）。
 *
 * 四个插件的 client bundle 都是手写 ESM，不能互相 import；因此这份实现以
 * browser-picker 预置段原样嵌入每个 client.js（见 scripts/sync-client-picker.mjs）。
 * 只依赖 DOM 与各插件自己传入的 request/headers，不复制研究解析逻辑。
 *
 * 入口：window.__DSH_RESEARCH_PICKER__.install(options)
 */
// #region browser-picker
function createStudyPicker(options) {
  const route = options.route
  const headers = options.headers || (() => ({}))
  const pickDirectory = options.pickDirectory || null
  const onChanged = options.onChanged || (() => {})
  const plugin = options.plugin || 'research'
  let root = null
  let panel = null
  let choices = null
  let note = ''
  let busy = false
  let advanced = false
  let creating = false
  let targetDir = ''
  let chooseDir = null

  async function api(action, payload, method = 'POST') {
    const url = method === 'GET' ? `${route}?action=${encodeURIComponent(action)}` : route
    const response = await fetch(url, {
      method,
      headers: { ...headers(), 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ action, payload: payload || {} }) : undefined,
    })
    let data = null
    try { data = await response.json() } catch { data = null }
    if (!response.ok || !data || data.ok === false) {
      const message = data && data.error && (data.error.message || data.error.note) ? (data.error.message || data.error.note) : `请求失败（${response.status}）`
      throw new Error(message)
    }
    return data.data
  }

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'style') { if (node.style) for (const [name, style] of Object.entries(value)) node.style[name] = style }
      else if (key === 'onClick') node.addEventListener('click', value)
      else if (key === 'className') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key === 'value') node.value = value
      else if (key === 'placeholder') node.placeholder = value
      else node.setAttribute(key, value)
    }
    for (const child of children) if (child != null) node.append(child)
    return node
  }

  const buttonStyle = {
    height: '30px', padding: '0 10px', border: '1px solid #cdc7b7', borderRadius: '5px',
    background: '#fffefb', color: '#24221f', cursor: 'pointer', font: 'inherit', fontSize: '13px',
  }
  const rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderBottom: '1px solid #eceade', cursor: 'pointer', width: '100%', background: 'transparent', border: 'none', textAlign: 'left', font: 'inherit' }

  function stateLabel(row) {
    if (row.state === 'ok') return '已存在'
    if (row.state === 'missing') return '需重新定位'
    if (row.state === 'invalid') return '配置损坏'
    return '未知'
  }

  function render() {
    if (!panel) return
    panel.textContent = ''
    const recent = (choices && choices.recent) || []
    const scope = (choices && choices.scope) || {}
    const binding = (choices && choices.binding) || {}
    const head = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
      el('strong', { text: '打开研究' }),
      el('button', { style: buttonStyle, text: '关闭', onClick: close }),
    )
    const scopeBox = el('div', { style: { background: '#f2f0e9', borderRadius: '6px', padding: '8px 10px', fontSize: '12.5px', color: '#5b564d', lineHeight: '1.7' } },
      el('div', { text: `当前页面：${binding.studyId || '未绑定'}` }),
      el('div', { text: `当前工作区：${scope.workspace ? (scope.workspace.path || scope.workspace.id || '已识别') : '未识别'}` }),
      el('div', { text: `当前会话：${scope.kind === 'agent' ? (scope.session || '已识别') : '页面切换不改变 Agent 研究'}` }),
      el('div', { style: { color: '#726c62', fontSize: '12px' }, text: '在此研究工作区打开会话：暂不支持（宿主没有研究→工作区映射）；请在工作区新建会话。' }),
    )
    const list = el('div', { style: { maxHeight: '230px', overflow: 'auto', border: '1px solid #eceade', borderRadius: '6px', marginTop: '10px' } })
    if (!recent.length) list.append(el('div', { style: { padding: '12px', color: '#726c62' }, text: '暂无最近研究。选择研究文件夹或新建研究。' }))
    for (const row of recent) {
      const item = el('button', { style: { ...rowStyle, opacity: row.state === 'missing' ? '0.65' : '1' }, onClick: () => select(row) },
        el('span', { style: { flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: `${row.name || row.studyId || row.studyPath}` }),
        el('span', { style: { color: '#726c62', fontSize: '12px' }, text: row.current ? '当前' : stateLabel(row) }),
      )
      if (row.current) item.style.background = '#f4e5dd'
      list.append(item)
    }
    const actions = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
      el('button', { style: buttonStyle, text: '选择研究文件夹…', onClick: chooseFolder }),
      el('button', { style: buttonStyle, text: '新建研究…', onClick: () => { creating = true; advanced = false; render() } }),
      el('button', { style: buttonStyle, text: '高级', onClick: () => { advanced = !advanced; creating = false; render() } }),
    )
    const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, head, scopeBox, list, actions)
    if (creating) body.append(createForm())
    if (advanced) body.append(advancedForm())
    if (note) body.append(el('div', { style: { color: '#9b3a2c', fontSize: '12.5px' }, text: note }))
    panel.append(body)
  }

  function createForm() {
    const name = el('input', { placeholder: '研究名称', value: '', style: { height: '30px', padding: '0 8px', border: '1px solid #cdc7b7', borderRadius: '5px', font: 'inherit' } })
    const dirText = el('span', { style: { color: '#5b564d', fontSize: '12.5px', wordBreak: 'break-all' }, text: targetDir || '尚未选择父目录' })
    const choose = el('button', { style: buttonStyle, text: '选择父目录…', onClick: async () => {
      const dir = await chooseFolderPath()
      if (!dir) return
      targetDir = dir; render()
    } })
    const create = el('button', { style: { ...buttonStyle, background: '#a55a3c', color: '#fdfbf7', borderColor: '#a55a3c' }, text: '创建并连接', onClick: async () => {
      if (busy) return
      const title = String(name.value || '').trim()
      if (!title) { note = '请填写研究名称'; render(); return }
      if (!targetDir) { note = '请选择父目录'; render(); return }
      busy = true; note = ''
      try {
        const payload = { studyPath: joinPath(targetDir, 'study.json'), name: title }
        await api('studyCreate', payload)
        await finishSwitch()
      } catch (error) { note = error.message; busy = false; render() }
    } })
    return el('div', { style: { border: '1px solid #eceade', borderRadius: '6px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } },
      el('strong', { text: '新建研究' }), name, dirText, el('div', { style: { display: 'flex', gap: '8px' } }, choose, create))
  }

  function advancedForm() {
    const input = el('input', { placeholder: 'study.json 的绝对路径', style: { flex: '1 1 auto', height: '30px', padding: '0 8px', border: '1px solid #cdc7b7', borderRadius: '5px', font: 'inherit' } })
    const connect = el('button', { style: buttonStyle, text: '连接', onClick: async () => {
      if (busy) return
      if (!input.value.trim()) { note = '请填写研究定义路径'; render(); return }
      busy = true; note = ''
      try { await api('studyConnect', { studyPath: input.value.trim() }); await finishSwitch() }
      catch (error) { note = error.message; busy = false; render() }
    } })
    return el('div', { style: { border: '1px solid #eceade', borderRadius: '6px', padding: '10px', display: 'flex', gap: '8px' } }, input, connect)
  }

  function joinPath(dir, name) {
    const clean = String(dir).replace(/[\\/]+$/, '')
    return `${clean}/${name}`
  }

  async function chooseFolderPath() {
    if (!pickDirectory) { note = '当前宿主未提供目录选择，请使用高级路径'; render(); return null }
    try { return await pickDirectory() } catch (error) { note = error.message || '目录选择已取消'; render(); return null }
  }

  async function chooseFolder() {
    const dir = await chooseFolderPath()
    if (!dir) return
    busy = true; note = ''
    try {
      const found = await api('studyDiscover', { dir })
      const configs = (found && found.configs) || []
      if (!configs.length) {
        targetDir = dir; creating = true; advanced = false
        note = '此文件夹没有研究配置，可以新建研究。'
      } else if (configs.length === 1) {
        await api('studyConnect', { studyPath: configs[0].studyPath })
        await finishSwitch()
        return
      } else {
        choices = null
        showConfigs(configs)
        busy = false
        return
      }
    } catch (error) { note = error.message }
    busy = false
    render()
  }

  function showConfigs(configs, relocateId = null) {
    if (!panel) return
    panel.textContent = ''
    panel.append(
      el('strong', { text: relocateId ? '选择重新定位后的研究配置' : '此文件夹有多个研究配置，请选择' }),
      el('div', { style: { margin: '10px 0', border: '1px solid #eceade', borderRadius: '6px' } },
        ...configs.map(row => el('button', { style: rowStyle, onClick: async () => {
          if (!row.valid) { note = '这个配置无效：' + (row.problems || []).join('；'); render(); return }
          try {
            if (relocateId) await api('studyRelocate', { instanceId: relocateId, studyPath: row.studyPath })
            else await api('studyConnect', { studyPath: row.studyPath })
            await finishSwitch()
          } catch (error) { note = error.message; busy = false; render() }
        } },
          el('span', { style: { flex: '1 1 auto' }, text: `${row.name || row.studyId || row.relativePath}` }),
          el('span', { style: { color: row.valid ? '#3f6b4f' : '#9b3a2c', fontSize: '12px' }, text: row.valid ? row.relativePath : '无效' }),
        ))
      ),
      el('button', { style: buttonStyle, text: '返回', onClick: () => { choices = null; refresh(); render() } }),
    )
  }

  async function select(row) {
    if (row.state === 'missing') {
      if (!row.instanceId) { note = '该研究没有实例记录，请选择文件夹或高级路径连接'; advanced = true; render(); return }
      const dir = await chooseFolderPath()
      if (!dir) return
      busy = true; note = ''
      try {
        const found = await api('studyDiscover', { dir })
        const configs = (found && found.configs) || []
        if (!configs.length) { note = '此文件夹没有研究配置'; busy = false; render(); return }
        if (configs.length > 1) { showConfigs(configs, row.instanceId); return }
        await api('studyRelocate', { instanceId: row.instanceId, studyPath: configs[0].studyPath })
        await finishSwitch()
      } catch (error) { note = error.message; busy = false; render() }
      return
    }
    if (!row.studyPath) return
    busy = true; note = ''
    try { await api('studyConnect', { studyPath: row.studyPath }); await finishSwitch() }
    catch (error) { note = error.message; busy = false; render() }
  }

  async function finishSwitch() {
    busy = false
    let name = ''
    try { choices = await api('studyChoices'); const current = (choices.recent || []).find(row => row.current); name = (current && (current.name || current.studyId)) || '' } catch { /* 名称稍后刷新 */ }
    close()
    updateButton()
    showToast(name)
    onChanged()
  }

  function showToast(name) {
    const toast = el('div', {
      style: {
        position: 'fixed', right: '24px', bottom: '28px', zIndex: '2147483100', maxWidth: '420px',
        background: '#24221f', color: '#fdfbf7', borderRadius: '8px', padding: '10px 12px',
        display: 'flex', alignItems: 'center', gap: '10px', font: '13px Cambria, serif',
        boxShadow: '0 10px 26px rgba(0,0,0,.25)',
      },
    },
      el('span', { style: { flex: '1 1 auto' }, text: name ? `已切换到：${name}` : '已切换研究' }),
      el('button', { style: { ...buttonStyle, height: '26px', background: '#fdfbf7' }, text: '刷新面板', onClick: () => { try { window.location.reload() } catch { /* 无窗口 */ } } }),
      el('button', { style: { ...buttonStyle, height: '26px', background: 'transparent', color: '#fdfbf7', borderColor: '#5b564d' }, text: '稍后', onClick: () => toast.remove() }),
    )
    document.body.append(toast)
    setTimeout(() => { try { toast.remove() } catch { /* 已移除 */ } }, 12000)
  }

  async function refresh() {
    try { choices = await api('studyChoices') } catch (error) { choices = null; note = error.message }
    updateButton()
    if (panel) render()
  }

  function updateButton() {
    if (!root) return
    const current = choices && choices.binding && choices.binding.studyId
    const nameRow = choices && choices.recent && choices.recent.find(row => row.current)
    root.textContent = `研究：${(nameRow && (nameRow.name || nameRow.studyId)) || current || '未绑定'} ▾`
  }

  function close() {
    if (panel) {
      if (panel.__onKey) document.removeEventListener('keydown', panel.__onKey)
      panel.remove(); panel = null
    }
  }

  function open() {
    if (panel) { close(); return }
    panel = el('div', {
      style: {
        position: 'fixed', bottom: '108px', right: '24px', width: '540px', maxWidth: 'calc(100vw - 48px)',
        maxHeight: 'calc(100vh - 200px)', overflow: 'auto', zIndex: '2147483000', background: '#fbfaf6',
        border: '1px solid #cdc7b7', borderRadius: '10px', padding: '14px', boxShadow: '0 18px 50px rgba(0,0,0,.22)',
        fontFamily: 'Cambria, "Noto Serif SC", serif', color: '#24221f', fontSize: '14px',
      },
    })
    document.body.append(panel)
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); close() } }
    document.addEventListener('keydown', onKey)
    panel.__onKey = onKey
    refresh()
  }

  function install() {
    if (root) return root
    if (typeof window !== 'undefined' && window.__DSH_RESEARCH_PICKER_INSTANCE__) return window.__DSH_RESEARCH_PICKER_INSTANCE__
    if (!document.body || typeof document.body.appendChild !== 'function' || !document.createElement) return null
    root = el('button', {
      style: {
        position: 'fixed', bottom: '64px', right: '24px', zIndex: '2147482000',
        height: '30px', padding: '0 12px', border: '1px solid #cdc7b7', borderRadius: '999px',
        background: '#fffefb', color: '#24221f', cursor: 'pointer', font: 'inherit', fontSize: '13px',
        boxShadow: '0 2px 10px rgba(0,0,0,.08)',
      },
      text: '研究：加载中…',
      title: `${plugin} 当前研究`,
    })
    root.addEventListener('click', open)
    document.body.append(root)
    // 面板只在研究插件页打开时自动关闭；入口按钮始终可见，避免被误判为“消失”。
    setInterval(() => {
      if (!panel) return
      try { if (!document.querySelector('.so-pagehead,.sd-root,.dc-root,.ar-pagehead')) close() } catch { close() }
    }, 800)
    refresh()
    if (typeof window !== 'undefined') window.__DSH_RESEARCH_PICKER_INSTANCE__ = pickerApi
    return root
  }

  const pickerApi = { install, open, close, refresh, get state() { return choices } }
  return pickerApi
}

const DSH_RESEARCH_PICKER = { createStudyPicker }
// #endregion browser-picker
export { createStudyPicker }
export default DSH_RESEARCH_PICKER
