/**
 * 09 回归：页面写入必须携带绑定令牌（否则 06 之后永远 binding_required）。
 * 同时检查四个 client bundle 的共享 body() 已同步。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createClientIdentity } from '../client-identity.mjs'

function storage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  }
}

test('U02 页面 body 携带记住的绑定令牌与工作区', async () => {
  const identity = createClientIdentity({
    plugin: 'test',
    storage: storage(),
    global: {},
    workspaceProvider: () => ({ workspaceId: 'ws-1', path: 'D:/work' }),
    random: () => 'page01234567',
  })
  await identity.ready()
  identity.prepare({})
  assert.equal(identity.body().binding, undefined, '未绑定前不伪造令牌')
  identity.remember({ token: 'tok-1', studyId: 'study-a', instanceId: 'inst-a', bindingRevision: 3 })
  const body = identity.body()
  assert.equal(body.binding, 'tok-1', '写入请求体必须带 token，服务端才认页面绑定')
  assert.equal(body.workspaceId, 'ws-1')
  assert.equal(body.pageId.length > 0, true)
})

test('U02 四个 client bundle 的 body() 都发送绑定令牌', () => {
  for (const plugin of ['study-ops', 'scale-desk', 'demographic-coder', 'analysis-run']) {
    const source = readFileSync(`D:/dsh-plugins/${plugin}/client.js`, 'utf8')
    assert.match(source, /result\.binding = binding\.token/, `${plugin} 的 body() 缺少 token`)
    // 曾出现 `binding:ticket.token` 覆盖 body 里的正确令牌（ticket.token 恒为 undefined）。
    assert.doesNotMatch(source, /binding:\s*ticket\.token/, `${plugin} 不得用 ticket.token 覆盖 binding`)
  }
})
