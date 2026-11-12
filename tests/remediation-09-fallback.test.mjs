/**
 * 09 回退一致性：只有 study-ops 配置了 studyPath 时，其余插件在没有页面绑定的启动里
 * 也必须解析到同一份旧配置研究，而不是各自落到不同的空工作区研究。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadPlugin, makeHost, request, pageHeaders } from './harness.mjs'

test('无页面绑定时四个插件回退到同一 legacy 研究', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-fallback-'))
  const ws = path.join(root, 'ws'); mkdirSync(path.join(ws, 'data'), { recursive: true })
  const studyPath = path.join(ws, 'study.json')
  writeFileSync(studyPath, JSON.stringify({
    schemaVersion: 1, studyId: 'fallback-study', name: '回退一致性研究', dataRoot: './data',
    participantId: { pattern: '^P-\\d{3}$' }, visits: [], tasks: [], followups: [], plugins: {},
  }, null, 2))
  const host = makeHost({ workspaces: [{ id: 'w1', path: ws }], sessions: { s1: ws }, cwd: ws })
  const ops = await loadPlugin('D:/dsh-plugins/study-ops')
  ops.apply(host.ctx, { studyPath })
  for (const name of ['analysis-run', 'scale-desk', 'demographic-coder']) {
    const plugin = await loadPlugin(`D:/dsh-plugins/${name}`)
    plugin.apply(host.ctx, {})
  }
  const handler = host.routes.get('/api/study-ops')
  const res = await request(handler, {
    path: '/api/study-ops?action=capabilities',
    headers: { 'x-study-ops': '1', ...pageHeaders('page-fallback-1') },
  })
  assert.equal(res.status, 200, JSON.stringify(res.json).slice(0, 500))
  const rows = res.json.data.plugins
  const ids = Object.fromEntries(rows.map(row => [row.name, row.current && row.current.studyId]))
  assert.equal(ids['study-ops'], 'fallback-study')
  for (const name of ['analysis-run', 'scale-desk', 'demographic-coder']) {
    assert.equal(ids[name], 'fallback-study', `${name} 应回退到同一 legacy 研究，实际 ${ids[name]}`)
  }
  assert.equal(res.json.data.consistent, true, JSON.stringify(rows))
})

test('页面绑定后能力查询把未打开过的插件对齐到同一研究', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-fallback2-'))
  const ws = path.join(root, 'ws'); mkdirSync(path.join(ws, 'data'), { recursive: true })
  const studyPath = path.join(ws, 'study.json')
  writeFileSync(studyPath, JSON.stringify({ schemaVersion: 1, studyId: 'align-study', name: '对齐研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))
  const host = makeHost({ workspaces: [{ id: 'w1', path: ws }], sessions: { s1: ws }, cwd: ws })
  ;(await loadPlugin('D:/dsh-plugins/study-ops')).apply(host.ctx, {})
  ;(await loadPlugin('D:/dsh-plugins/analysis-run')).apply(host.ctx, {})
  const handler = host.routes.get('/api/study-ops')
  const headers = { 'x-study-ops': '1', 'content-type': 'application/json', ...pageHeaders('page-align-1') }
  const connect = await request(handler, { method: 'POST', path: '/api/study-ops', headers, body: { action: 'studyConnect', payload: { studyPath } } })
  assert.equal(connect.status, 200, JSON.stringify(connect.json).slice(0, 400))
  const caps = await request(handler, { path: '/api/study-ops?action=capabilities', headers: { 'x-study-ops': '1', ...pageHeaders('page-align-1') } })
  assert.equal(caps.status, 200, JSON.stringify(caps.json).slice(0, 400))
  const row = caps.json.data.plugins.find(item => item.name === 'analysis-run')
  assert.equal(row.current.studyId, 'align-study', JSON.stringify(caps.json.data.plugins))
  assert.equal(caps.json.data.consistent, true)
})