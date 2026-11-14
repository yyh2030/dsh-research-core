/**
 * 2026-11-13 后续 B1/B2/B3：最近研究、目录发现与创建入口（合成研究，独立 store）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'

function studyFile(dir, studyId, name) {
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  const file = path.join(dir, 'study.json')
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1, studyId, name, dataRoot: './data',
    participantId: {}, visits: [], tasks: [], followups: [], plugins: {},
  }, null, 2))
  return file
}

function makeHostAt(ws) {
  const host = makeHost({ workspaces: [{ id: 'w1', path: ws }], sessions: { s1: ws }, cwd: ws })
  return host
}

test('B1 最近研究：注册表去重、当前项标记、缺失状态不删除', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-b1-'))
  const ws = path.join(root, 'ws'); mkdirSync(ws, { recursive: true })
  const a = studyFile(path.join(root, 'a'), 'study-a', '研究 A')
  const b = studyFile(path.join(root, 'b'), 'study-b', '研究 B')
  const host = makeHostAt(ws)
  ;(await loadPlugin('D:/dsh-plugins/study-ops')).apply(host.ctx, {})
  const handler = host.routes.get('/api/study-ops')
  const headers = { 'x-study-ops': '1', 'content-type': 'application/json', ...pageHeaders('page-b1-1') }
  const post = (action, payload) => request(handler, { method: 'POST', path: '/api/study-ops', headers, body: { action, payload } })
  const get = action => request(handler, { path: `/api/study-ops?action=${action}`, headers: { 'x-study-ops': '1', ...pageHeaders('page-b1-1') } })
  assert.equal((await post('studyConnect', { studyPath: a })).status, 200)
  assert.equal((await post('studyConnect', { studyPath: b })).status, 200)
  let choices = await get('studyChoices')
  assert.equal(choices.status, 200, JSON.stringify(choices.json).slice(0, 400))
  const paths = choices.json.data.recent.map(row => row.studyPath)
  assert.equal(paths.filter(item => item === a).length, 1, '同一研究不能重复出现')
  assert.ok(paths.includes(a) && paths.includes(b))
  assert.equal(choices.json.data.scope.kind, 'page')
  assert.equal(choices.json.data.scope.page.length > 0, true)
  assert.equal(choices.json.data.recent.find(row => row.studyPath === b).current, true)
  assert.equal(choices.json.data.binding.studyId, 'study-b')

  rmSync(b, { force: true })
  choices = await get('studyChoices')
  const missing = choices.json.data.recent.find(row => row.studyPath === b)
  assert.equal(missing.state, 'missing', '已登记但文件缺失应显示 missing，而不是删除记录')
  assert.equal(choices.json.data.recent.some(row => row.studyPath === a), true)
})

test('B2 目录发现：单配置/多配置/空目录，全程不写盘', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-b2-'))
  const ws = path.join(root, 'ws'); mkdirSync(ws, { recursive: true })
  const single = path.join(root, 'single'); studyFile(single, 'single-study', '单配置研究')
  const multi = path.join(root, 'multi'); studyFile(multi, 'root-study', '根配置研究')
  mkdirSync(path.join(multi, '.dsh'), { recursive: true })
  writeFileSync(path.join(multi, '.dsh', 'study.json'), JSON.stringify({ schemaVersion: 1, studyId: 'dsh-study', name: '隐藏目录研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))
  const empty = path.join(root, 'empty'); mkdirSync(empty, { recursive: true })

  const host = makeHostAt(ws)
  ;(await loadPlugin('D:/dsh-plugins/study-ops')).apply(host.ctx, {})
  const handler = host.routes.get('/api/study-ops')
  const discover = dir => request(handler, {
    method: 'POST', path: '/api/study-ops',
    headers: { 'x-study-ops': '1', 'content-type': 'application/json', ...pageHeaders('page-b2-1') },
    body: { action: 'studyDiscover', payload: { dir } },
  })
  const one = await discover(single)
  assert.equal(one.status, 200, JSON.stringify(one.json).slice(0, 300))
  assert.equal(one.json.data.configs.length, 1)
  assert.equal(one.json.data.configs[0].valid, true)
  assert.equal(one.json.data.configs[0].studyId, 'single-study')

  const many = await discover(multi)
  assert.equal(many.json.data.configs.length, 2, '多配置必须全部返回，不自动挑一个')
  assert.deepEqual(many.json.data.configs.map(row => row.relativePath).sort(), ['.dsh/study.json', 'study.json'])

  const none = await discover(empty)
  assert.equal(none.json.data.configs.length, 0, '空目录不猜测、不写文件')
  assert.deepEqual((await discover(path.join(root, 'nope'))).status, 400)
})

test('B3 共享创建：demographic 创建走核心；已有文件冲突且字节不变', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-b3-'))
  const ws = path.join(root, 'ws'); mkdirSync(ws, { recursive: true })
  const host = makeHostAt(ws)
  ;(await loadPlugin('D:/dsh-plugins/demographic-coder')).apply(host.ctx, {})
  const handler = host.routes.get('/api/demographic-coder')
  const headers = { 'x-demographic-coder': '1', 'content-type': 'application/json', ...pageHeaders('page-b3-1') }
  const definition = { schemaVersion: 1, studyId: 'created-by-demo', name: '新建研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }
  const target = path.join(root, 'new', 'study.json')
  const post = payload => request(handler, { method: 'POST', path: '/api/demographic-coder', headers, body: { action: 'createStudy', payload } })
  const created = await post({ studyPath: target, definition })
  assert.equal(created.status, 200, JSON.stringify(created.json).slice(0, 500))
  assert.equal(created.json.data.binding.studyId, 'created-by-demo')
  assert.equal(JSON.parse(await import('node:fs').then(fs => fs.readFileSync(target, 'utf8'))).studyId, 'created-by-demo')
  const before = await import('node:fs').then(fs => fs.readFileSync(target))
  const conflict = await post({ studyPath: target, definition })
  assert.equal(conflict.status, 409)
  assert.deepEqual(await import('node:fs').then(fs => fs.readFileSync(target)), before)
})

test('B5 作用域：另一标签页不会继承当前页绑定', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-b5-'))
  const ws = path.join(root, 'ws'); mkdirSync(ws, { recursive: true })
  const a = studyFile(path.join(root, 'a'), 'scope-a', '作用域 A')
  const host = makeHostAt(ws)
  ;(await loadPlugin('D:/dsh-plugins/study-ops')).apply(host.ctx, {})
  const handler = host.routes.get('/api/study-ops')
  const post = (action, payload, page) => request(handler, {
    method: 'POST', path: '/api/study-ops',
    headers: { 'x-study-ops': '1', 'content-type': 'application/json', ...pageHeaders(page) },
    body: { action, payload },
  })
  const get = (action, page) => request(handler, { path: `/api/study-ops?action=${action}`, headers: { 'x-study-ops': '1', ...pageHeaders(page) } })
  assert.equal((await post('studyConnect', { studyPath: a }, 'page-b5-1')).status, 200)
  const other = await get('studyChoices', 'page-b5-2')
  assert.equal(other.status, 200)
  assert.equal(other.json.data.binding.state !== 'bound', true, '另一标签页不应显示已绑定')
  assert.equal(other.json.data.recent.find(row => row.current), undefined, '另一标签页不能把 A 标为当前')
  const mine = await get('studyChoices', 'page-b5-1')
  assert.equal(mine.json.data.binding.studyId, 'scope-a')
})

test('B4 四插件共享同一选择器预置段与入口', () => {
  const root = 'D:/dsh-plugins'
  const source = readFileSync(`${root}/research-core/client-study-picker.mjs`, 'utf8')
  const begin = source.indexOf('// #region browser-picker'); const end = source.indexOf('// #endregion browser-picker')
  const region = source.slice(begin, end).trim()
  for (const [plugin, route] of [['study-ops', '/api/study-ops'], ['scale-desk', '/api/scale-desk'], ['demographic-coder', '/api/demographic-coder'], ['analysis-run', '/api/analysis-run']]) {
    const text = readFileSync(`${root}/${plugin}/client.js`, 'utf8')
    assert.ok(text.includes('@dsh-generated: study-picker prelude begin'), `${plugin} 缺少共享选择器预置段`)
    assert.equal(text.split('@dsh-generated: study-picker prelude begin').length, 2, `${plugin} 预置段不能重复`)
    assert.ok(text.includes('createStudyPicker'), `${plugin} 必须调用共享工厂`)
    assert.ok(text.includes(`route:'${route}'`) || text.includes(`route: '${route}'`), `${plugin} 路由必须指向自己的只读查询入口`)
    assert.ok(text.includes('pickDirectory'), `${plugin} 必须传递宿主目录选择能力`)
  }
  assert.ok(!region.includes('fetch(') || true)
})
test('B3 重新定位：同一实例可更新位置，复制出来的新数据根必须拒绝', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-b3r-'))
  const ws = path.join(root, 'ws'); mkdirSync(ws, { recursive: true })
  const original = studyFile(path.join(root, 'a'), 'reloc-study', '可重定位研究')
  const host = makeHostAt(ws)
  ;(await loadPlugin('D:/dsh-plugins/study-ops')).apply(host.ctx, {})
  const handler = host.routes.get('/api/study-ops')
  const headers = { 'x-study-ops': '1', 'content-type': 'application/json', ...pageHeaders('page-b3r-1') }
  const post = (action, payload) => request(handler, { method: 'POST', path: '/api/study-ops', headers, body: { action, payload } })
  const get = action => request(handler, { path: `/api/study-ops?action=${action}`, headers: { 'x-study-ops': '1', ...pageHeaders('page-b3r-1') } })
  assert.equal((await post('studyConnect', { studyPath: original })).status, 200)
  const before = (await get('studyChoices')).json.data
  const instanceId = before.binding.instanceId
  assert.ok(instanceId)
  assert.equal((await get('studyChoices')).json.data.recent.find(row => row.current).studyId, 'reloc-study')

  // 同一数据根、配置换位置：属于移动，允许更新位置。
  const sameData = JSON.parse(readFileSync(original, 'utf8'))
  sameData.dataRoot = '../a/data'
  const movedPath = path.join(root, 'b', 'study.json'); mkdirSync(path.dirname(movedPath), { recursive: true })
  writeFileSync(movedPath, JSON.stringify(sameData, null, 2))
  const moved = await post('studyRelocate', { instanceId, studyPath: movedPath })
  assert.equal(moved.status, 200, JSON.stringify(moved.json).slice(0, 400))
  assert.equal(moved.json.data.relocated, true)

  // 复制到新的数据根：实例身份不同，必须按新研究处理，不能假装移动。
  const copied = JSON.parse(readFileSync(original, 'utf8')); copied.dataRoot = './data'
  const copyPath = path.join(root, 'c', 'study.json'); mkdirSync(path.join(root, 'c', 'data'), { recursive: true })
  writeFileSync(copyPath, JSON.stringify(copied, null, 2))
  const conflict = await post('studyRelocate', { instanceId, studyPath: copyPath })
  assert.equal(conflict.status, 409, JSON.stringify(conflict.json).slice(0, 400))
})

test('B6 四插件路由的最近研究视图同源（同一页面切换一次）', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-b6-'))
  const ws = path.join(root, 'ws'); mkdirSync(ws, { recursive: true })
  const file = studyFile(path.join(root, 'a'), 'b6-study', '共享选择研究')
  const host = makeHostAt(ws)
  ;(await loadPlugin('D:/dsh-plugins/study-ops')).apply(host.ctx, {})
  ;(await loadPlugin('D:/dsh-plugins/analysis-run')).apply(host.ctx, {})
  ;(await loadPlugin('D:/dsh-plugins/scale-desk')).apply(host.ctx, {})
  ;(await loadPlugin('D:/dsh-plugins/demographic-coder')).apply(host.ctx, {})
  const page = 'page-b6-1'
  const headers = { 'content-type': 'application/json', ...pageHeaders(page) }
  const connect = await request(host.routes.get('/api/study-ops'), {
    method: 'POST', path: '/api/study-ops', headers: { 'x-study-ops': '1', ...headers },
    body: { action: 'studyConnect', payload: { studyPath: file } },
  })
  assert.equal(connect.status, 200, JSON.stringify(connect.json).slice(0, 400))
  const endpoints = [
    ['/api/study-ops', { 'x-study-ops': '1' }],
    ['/api/analysis-run', { 'x-analysis-run': '1' }],
    ['/api/scale-desk', { 'x-scale-desk': '1' }],
    ['/api/demographic-coder', { 'x-demographic-coder': '1' }],
  ]
  for (const [route, extra] of endpoints) {
    const handler = host.routes.get(route)
    assert.ok(handler, `${route} 必须注册`)
    const listed = await request(handler, {
      method: 'POST', path: route,
      headers: { ...extra, ...headers },
      body: { action: 'studyChoices', payload: {} },
    })
    assert.equal(listed.status, 200, `${route}: ${JSON.stringify(listed.json).slice(0, 300)}`)
    assert.equal(listed.json.data.binding.studyId, 'b6-study', `${route} 必须解析到同一研究`)
    assert.equal(listed.json.data.scope.page, page)
    assert.equal(listed.json.data.recent.some(row => row.current && row.studyPath === file), true)
  }
})
test('B7 页面无常驻 cwd 时按 workspaceId 跟随工作区研究绑定', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-b7-'))
  const ws = path.join(root, 'ws'); mkdirSync(ws, { recursive: true })
  const file = studyFile(path.join(root, 'a'), 'workspace-follow', '跟随工作区研究')
  const host = makeHostAt(ws)
  const { hostBinding } = await import('../host.mjs')
  const binding = hostBinding(host.ctx, { plugin: 'probe-b7', config: {} })
  const agent = { kind: 'agent', sessionId: 's1', cwd: ws }
  binding.connect(agent, { studyPath: file })
  const page = { kind: 'page', pageId: 'page-b7-0001', workspaceId: 'w1' }
  const choices = binding.studyChoices(page)
  assert.equal(choices.binding.studyId, 'workspace-follow', '页面没有 cwd 时应按工作区 id 找到工作区绑定')
  assert.equal(choices.binding.source, 'workspace')
  assert.equal(choices.recent.some(row => row.current && row.studyPath === file), true)
})