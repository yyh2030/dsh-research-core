/**
 * DATA-01：两个真实进程同时写同一数据集，只允许一个成功，另一个明确冲突。
 * 以及"写进程崩溃后遗留锁"的恢复条件（证明原进程已退出才清理，不按 TTL 抢锁）。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openResearchData } from '../data.mjs'

const child = path.resolve(import.meta.dirname, 'fixtures', 'data-writer-child.mjs')
const lockFileFor = name => `lock-${createHash('sha256').update(name).digest('hex').slice(0, 16)}.json`

function makeProject(instanceId = 'inst-lock-0001') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-data-lock-'))
  const studyPath = path.join(root, 'study.json')
  writeFileSync(studyPath, JSON.stringify({ schemaVersion: 1, studyId: 'lock-study', name: '锁合成研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))
  mkdirSync(path.join(root, 'data'), { recursive: true })
  const study = { id: 'lock-study', name: '锁合成研究', path: studyPath, dataRoot: path.join(root, 'data'), baseDir: root, plugin: {} }
  return { root, studyPath, study, instanceId }
}

function childEnv(project, mode, extra = {}) {
  return {
    ...process.env,
    DATA_MODE: mode,
    DATA_STUDY_PATH: project.studyPath,
    DATA_STUDY_ID: project.study.id,
    DATA_INSTANCE: project.instanceId,
    DATA_MARKER: path.join(project.root, 'marker.json'),
    ...extra,
  }
}

function runChild(project, mode, extra = {}) {
  const result = spawnSync(process.execPath, [child], { encoding: 'utf8', env: childEnv(project, mode, extra) })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const text = String(result.stdout || '').trim()
  return text ? JSON.parse(text) : {}
}

function waitFor(predicate, timeoutMs = 4000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs) } catch { /* 兜底 */ }
  }
  return false
}

test('DATA-01 一个进程持锁写时，另一个进程的提交明确冲突；释放后可提交', async () => {
  const project = makeProject()
  const marker = path.join(project.root, 'marker.json')

  const holder = spawn(process.execPath, [child], { env: childEnv(project, 'hold'), stdio: ['ignore', 'pipe', 'pipe'] })
  let holderOutput = ''
  holder.stdout.on('data', chunk => { holderOutput += chunk })
  holder.stderr.on('data', chunk => { holderOutput += chunk })
  assert.ok(waitFor(() => existsSync(marker)), '持锁进程应写出 marker')

  const contender = runChild(project, 'try', { DATA_WRITER: 'B' })
  assert.equal(contender.ok, false)
  assert.equal(contender.code, 'dataset_conflict')
  assert.equal(contender.retryable, true)
  assert.equal(contender.committed, false)

  // 持锁进程释放后再提交成功，数据只出现一次。
  await new Promise((resolve, reject) => {
    holder.on('exit', code => (code === 0 ? resolve() : reject(new Error(holderOutput || `exit ${code}`))))
  })
  const winner = runChild(project, 'try', { DATA_WRITER: 'C' })
  assert.equal(winner.ok, true, JSON.stringify(winner))
  assert.equal(winner.revision, 1)

  const data = openResearchData({ study: project.study, instanceId: project.instanceId })
  assert.equal(data.read('demographics').revision, 1)
  assert.equal(data.read('demographics').value.writer, 'C')
  const changes = data.changesSince(0).filter(row => row.dataset === 'demographics')
  assert.equal(changes.length, 1, '冲突的一方不应留下提交记录')
})

test('写进程崩溃留下锁：只有证明原进程已退出才清理，随后可正常提交', () => {
  const project = makeProject('inst-lock-0002')
  const marker = path.join(project.root, 'marker.json')
  runChild(project, 'die-holding')
  assert.ok(existsSync(marker), '崩溃进程应已持过锁')

  const lockDir = path.join(project.study.dataRoot, 'transactions')
  const lockPath = path.join(lockDir, lockFileFor('demographics'))
  assert.ok(existsSync(lockPath), '崩溃进程的锁文件应还在')
  const deadLock = JSON.parse(readFileSync(lockPath, 'utf8'))
  assert.equal(deadLock.owner, 'child-dead')

  const data = openResearchData({ study: project.study, instanceId: project.instanceId })
  const preview = data.recoverPreview()
  assert.equal(preview.staleLocks.length, 1, '应识别出死进程留下的锁')
  const result = data.commit('demographics', { writer: 'after-crash' }, { owner: 'recoverer', timeoutMs: 900 })
  assert.equal(result.committed, true)
  assert.equal(result.revision, 1)
  // 遗留锁已被归档，不再阻塞后续写入。
  assert.equal(existsSync(lockPath), false)
  assert.ok(existsSync(path.join(lockDir, 'stale')), '遗留锁应被归档而不是删除')
})
