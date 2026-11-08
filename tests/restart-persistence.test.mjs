/**
 * ISO-04 的真实进程边界验收：
 *   进程 1 建立页面绑定与工作区绑定 → 进程 2（全新进程，无共享内存）恢复它们。
 * 与 identity.test.mjs 里"删掉单例再重建"不同，这里是真的换一个 Node 进程。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const child = path.resolve(import.meta.dirname, 'fixtures', 'restart-child.mjs')
const root = mkdtempSync(path.join(os.tmpdir(), 'rc-restart-'))
const wsA = path.join(root, 'ws-a')
const store = path.join(root, 'store')
mkdirSync(path.join(wsA, 'data'), { recursive: true })
const fileA = path.join(wsA, 'study.json')
writeFileSync(fileA, JSON.stringify({ schemaVersion: 1, studyId: 'restart-study', name: '重启研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))

function run(mode) {
  const result = spawnSync(process.execPath, [child], {
    encoding: 'utf8',
    env: { ...process.env, RELAY_MODE: mode, RELAY_STORE: store, RELAY_WSA: wsA, RELAY_FILEA: fileA, DSH_RESEARCH_STORE: '' },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

test('ISO-04 跨进程：页面绑定与工作区绑定在宿主重启后恢复', () => {
  const connected = run('connect')
  assert.ok(connected.pageToken.startsWith('rc1.'))
  assert.equal(connected.pageRevision, 1)

  const restored = run('resolve')
  assert.equal(restored.state, 'bound')
  assert.equal(restored.studyId, 'restart-study')
  assert.equal(restored.instanceId, connected.pageInstance)
  assert.equal(restored.revision, connected.pageRevision)
  assert.equal(restored.token, connected.pageToken, '同一页面在新进程里应拿到同一令牌')

  // 新会话（从未连接过）在同一工作区里，靠工作区记录初始化到同一个研究。
  assert.equal(restored.newcomerState, 'bound')
  assert.equal(restored.newcomerStudyId, 'restart-study')
  assert.equal(restored.newcomerSource, 'workspace')
})
