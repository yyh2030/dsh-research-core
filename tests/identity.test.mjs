/**
 * research-core 身份与隔离自测（node --test）。
 * 覆盖 01 阶段的 ISO 场景中可在纯模块层验证的部分。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { BindingError, canonicalPath, researchCore } from '../index.mjs'

const SHARED = Symbol.for('dsh.research.core.v1')

function freshHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'rc-home-'))
}

function freshCore(options) {
  delete globalThis[SHARED]
  return researchCore(options)
}

function storeFileCount(home) {
  const dir = path.join(home, 'storages', 'research-core')
  if (!existsSync(dir)) return 0
  return readdirSync(dir).length
}

function makeStudy(root, { studyId, name = studyId, dataRoot = './data', extra = {} } = {}) {
  mkdirSync(root, { recursive: true })
  const file = path.join(root, 'study.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, studyId, name, dataRoot, participantId: {}, visits: [], tasks: [], followups: [], plugins: {}, ...extra }, null, 2))
  return file
}

function fakeHooks(state, describe) {
  const identityOf = studyPath => {
    const descriptor = describe(studyPath)
    return { studyId: descriptor.studyId, studyPath: descriptor.studyPath, dataRoot: descriptor.dataRoot, revision: descriptor.studyRevision }
  }
  return {
    version: '0.0.1',
    currentIdentity: () => state.current,
    prepareSwitch(studyPath) {
      const previous = state.current
      const next = identityOf(studyPath)
      return {
        commit() { state.current = next; state.switches += 1 },
        rollback() { state.current = previous },
      }
    },
    busy: () => false,
  }
}

function page(plugin, pageId, cwd) { return { kind: 'page', pageId, cwd } }
function agent(sessionId, cwd) { return { kind: 'agent', sessionId, cwd } }

test('只读解析不写盘；工作区项目配置被发现', () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  makeStudy(wsA, { studyId: 'study-a' })
  const core = freshCore({ homeDir: home, workspaces: [{ id: 'wa', path: wsA }] })
  const view = core.resolve(agent('s-1', wsA))
  assert.equal(view.state, 'candidate')
  assert.equal(view.source, 'project')
  assert.equal(view.studyId, 'study-a')
  assert.ok(view.token.startsWith('rc1.'))
  assert.equal(storeFileCount(home), 0, '只读解析不应写盘')
})

test('ISO-01 两个工作区各自解析到自己的研究，绑定互不影响', () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  const wsB = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-b-'))
  makeStudy(wsA, { studyId: 'study-a' })
  makeStudy(wsB, { studyId: 'study-b' })
  const core = freshCore({ homeDir: home, workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }] })

  const a = core.connect(agent('s-a', wsA), { studyPath: path.join(wsA, 'study.json') })
  const b = core.connect(agent('s-b', wsB), { studyPath: path.join(wsB, 'study.json') })
  assert.equal(a.studyId, 'study-a')
  assert.equal(b.studyId, 'study-b')
  assert.notEqual(a.instanceId, b.instanceId)

  const writeA = core.assertWrite(agent('s-a', wsA), { token: a.token })
  const writeB = core.assertWrite(agent('s-b', wsB), { token: b.token })
  assert.equal(writeA.studyId, 'study-a')
  assert.equal(writeB.studyId, 'study-b')
  assert.equal(core.resolve(agent('s-a', wsA)).studyId, 'study-a')
  assert.equal(core.resolve(agent('s-b', wsB)).studyId, 'study-b')
})

test('ISO-02 另一会话切到 B 后，A 的旧令牌仍只写 A', () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  const wsB = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-b-'))
  const fileA = makeStudy(wsA, { studyId: 'same-id' })
  const fileB = makeStudy(wsB, { studyId: 'same-id' })
  const core = freshCore({ homeDir: home, workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }] })

  const first = core.connect(agent('s-1', wsA), { studyPath: fileA })
  core.connect(agent('s-2', wsB), { studyPath: fileB })
  const again = core.assertWrite(agent('s-1', wsA), { token: first.token })
  assert.equal(again.studyPath, canonicalPath(fileA))
  assert.notEqual(again.studyPath, canonicalPath(fileB))
})

test('ISO-03 页面 A→B→A 后旧 A 令牌失效', () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  const wsB = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-b-'))
  const fileA = makeStudy(wsA, { studyId: 'study-a' })
  const fileB = makeStudy(wsB, { studyId: 'study-b' })
  const core = freshCore({ homeDir: home, workspaces: [] })
  const actor = page('study-ops', 'page-abcdefgh')

  const firstA = core.connect(actor, { studyPath: fileA })
  core.connect(actor, { studyPath: fileB })
  const thirdA = core.connect(actor, { studyPath: fileA })
  assert.equal(thirdA.studyId, 'study-a')
  assert.ok(thirdA.bindingRevision > firstA.bindingRevision)

  assert.throws(
    () => core.assertWrite(actor, { token: firstA.token }),
    error => error instanceof BindingError && error.code === 'binding_conflict',
  )
  assert.equal(core.assertWrite(actor, { token: thirdA.token }).studyId, 'study-a')
  const other = core.connect(page('study-ops', 'page-zzzzzzzz'), { studyPath: fileA })
  assert.equal(core.assertWrite(page('study-ops', 'page-zzzzzzzz'), { token: other.token }).studyId, 'study-a')
})

test('ISO-04 重启后（进程内共享实例重建）恢复页面与工作区绑定', () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  const fileA = makeStudy(wsA, { studyId: 'study-a' })
  const workspaces = [{ id: 'wa', path: wsA }]

  const first = freshCore({ homeDir: home, workspaces })
  const bound = first.connect(page('demographic-coder', 'page-11111111'), { studyPath: fileA })
  const agentBound = first.connect(agent('s-1', wsA), { studyPath: fileA })

  const restarted = freshCore({ homeDir: home, workspaces })
  const pageAgain = restarted.resolve(page('demographic-coder', 'page-11111111'))
  assert.equal(pageAgain.state, 'bound')
  assert.equal(pageAgain.studyId, 'study-a')
  assert.equal(pageAgain.token, bound.token)
  const agentAgain = restarted.resolve(agent('s-1', wsA))
  assert.equal(agentAgain.studyId, 'study-a')
  assert.equal(restarted.resolve(agent('s-new', wsA)).studyId, 'study-a')
  assert.equal(agentBound.studyId, 'study-a')
})

test('ISO-05 子目录 cd 保持研究；切换到另一研究根时切换绑定', () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  const wsB = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-b-'))
  const sub = path.join(wsA, 'deep', 'inside')
  mkdirSync(sub, { recursive: true })
  makeStudy(wsA, { studyId: 'study-a' })
  makeStudy(wsB, { studyId: 'study-b' })
  const core = freshCore({ homeDir: home, workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }] })

  core.connect(agent('s-1', wsA), { studyPath: path.join(wsA, 'study.json') })
  assert.equal(core.resolve(agent('s-1', sub)).studyId, 'study-a')
  core.connect(agent('s-2', wsB), { studyPath: path.join(wsB, 'study.json') })
  assert.equal(core.resolve(agent('s-2', wsB)).studyId, 'study-b')
  assert.equal(core.resolve(agent('s-1', sub)).studyId, 'study-a')
})

test('ISO-06 同 ID 不同数据实例隔离；同目录别名视为同一实例', () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  const wsB = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-b-'))
  const fileA = makeStudy(wsA, { studyId: 'shared-id' })
  const fileB = makeStudy(wsB, { studyId: 'shared-id' })
  const core = freshCore({ homeDir: home, workspaces: [] })

  const a = core.connect(page('scale-desk', 'page-aaaaaaaa'), { studyPath: fileA })
  const b = core.connect(page('scale-desk', 'page-bbbbbbbb'), { studyPath: fileB })
  assert.notEqual(a.instanceId, b.instanceId)

  let alias = path.join(os.tmpdir(), `rc-alias-${Date.now()}`)
  try {
    symlinkSync(wsA, alias, 'junction')
  } catch {
    alias = wsA
  }
  const aliased = core.connect(page('scale-desk', 'page-cccccccc'), { studyPath: path.join(alias, 'study.json') })
  assert.equal(aliased.instanceId, a.instanceId)
})

test('ISO-07 无配置、无候选时进入空研究，且查询不写盘', () => {
  const home = freshHome()
  const empty = mkdtempSync(path.join(os.tmpdir(), 'rc-empty-'))
  const core = freshCore({ homeDir: home, workspaces: [{ id: 'we', path: empty }] })
  const view = core.resolve(page('study-ops', 'page-empty001'))
  assert.equal(view.state, 'empty')
  assert.equal(view.configured, false)
  assert.ok(view.token)
  assert.equal(storeFileCount(home), 0)
})

test('ISO-08 研究定义在外部修改后，旧令牌写入被拒绝', () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  const fileA = makeStudy(wsA, { studyId: 'study-a' })
  const core = freshCore({ homeDir: home, workspaces: [] })
  const actor = page('analysis-run', 'page-stale001')
  const bound = core.connect(actor, { studyPath: fileA })

  writeFileSync(fileA, readFileSync(fileA, 'utf8').trimEnd() + '\n')
  assert.throws(
    () => core.assertWrite(actor, { token: bound.token }),
    error => error instanceof BindingError && error.code === 'binding_conflict',
  )
})

test('withBinding 串行切换插件当前研究并返回绑定', async () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  const wsB = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-b-'))
  const fileA = makeStudy(wsA, { studyId: 'study-a' })
  makeStudy(wsB, { studyId: 'study-b' })
  const core = freshCore({ homeDir: home, workspaces: [{ id: 'wa', path: wsA }, { id: 'wb', path: wsB }] })
  const descriptorA = core.describeStudy({ studyPath: fileA })
  const state = { current: { studyId: 'study-a', studyPath: descriptorA.studyPath, dataRoot: descriptorA.dataRoot, revision: descriptorA.studyRevision }, switches: 0 }
  core.registerPlugin('demo', fakeHooks(state, studyPath => core.describeStudy({ studyPath })))

  const one = await core.withBinding(agent('s-1', wsA), { plugin: 'demo', mode: 'read' }, async view => view.studyId)
  const two = await core.withBinding(agent('s-2', wsB), { plugin: 'demo', mode: 'read' }, async view => view.studyId)
  assert.equal(one.value, 'study-a')
  assert.equal(two.value, 'study-b')
  assert.equal(state.switches, 1)
  assert.equal(core.readCapabilities(agent('s-2', wsB)).consistent, true)
})

test('页面写入缺少令牌时明确拒绝', () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  const fileA = makeStudy(wsA, { studyId: 'study-a' })
  const core = freshCore({ homeDir: home, workspaces: [] })
  core.connect(page('study-ops', 'page-token001'), { studyPath: fileA })
  assert.throws(
    () => core.assertWrite(page('study-ops', 'page-token001'), {}),
    error => error instanceof BindingError && error.code === 'binding_required',
  )
})

test('令牌不能跨页面使用', () => {
  const home = freshHome()
  const wsA = mkdtempSync(path.join(os.tmpdir(), 'rc-ws-a-'))
  const fileA = makeStudy(wsA, { studyId: 'study-a' })
  const core = freshCore({ homeDir: home, workspaces: [] })
  const mine = core.connect(page('study-ops', 'page-mine0001'), { studyPath: fileA })
  core.connect(page('study-ops', 'page-other001'), { studyPath: fileA })
  assert.throws(
    () => core.assertWrite(page('study-ops', 'page-other001'), { token: mine.token }),
    error => error instanceof BindingError && error.code === 'binding_conflict',
  )
})
