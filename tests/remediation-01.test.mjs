/**
 * 01 阶段回归：数据身份、锁健康、分析健康阻断（D01—D03）。
 * 使用临时合成研究根；不接触真实研究。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DataError, openResearchData } from '../data.mjs'
import { openAnalysis } from '../analysis.mjs'

function makeProject(root, { studyId = 'remediation-01' } = {}) {
  mkdirSync(root, { recursive: true })
  const studyPath = path.join(root, 'study.json')
  writeFileSync(studyPath, JSON.stringify({ schemaVersion: 1, studyId, name: '修复阶段合成研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins: {} }, null, 2))
  const dataRoot = path.join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
  return { study: { id: studyId, name: '修复阶段合成研究', path: studyPath, dataRoot, baseDir: root, plugin: {} }, dataRoot }
}

const participantsDoc = ids => ({ participants: ids.map((id, index) => ({ participantKey: `k${index + 1}`, participantId: id, status: 'enrolled', groups: {} })) })

test('D01-A 错实例读取被拒绝，health 不为 ok', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-inst-')))
  const a = openResearchData({ study: project.study, instanceId: 'inst-A' })
  a.commit('participants', participantsDoc(['P-0001']), { owner: 'study-ops' })

  const b = openResearchData({ study: project.study, instanceId: 'inst-B' })
  for (const call of [
    () => b.read('participants'),
    () => b.health('participants'),
    () => b.history('participants'),
  ]) {
    assert.throws(call, error => error instanceof DataError && error.code === 'wrong_instance')
  }
  assert.throws(() => openAnalysis({ data: b, study: project.study }).dataset({ plan: {} }), error => ['wrong_instance', 'source_unreadable'].includes(error.code))
})

test('D01-B 身份文件缺失但有已提交数据时必须报需要恢复，不能重新认领', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-inst2-')))
  const a = openResearchData({ study: project.study, instanceId: 'inst-A' })
  a.commit('participants', participantsDoc(['P-0001']), { owner: 'study-ops' })
  rmSync(path.join(project.dataRoot, 'study-instance.json'), { force: true })
  const b = openResearchData({ study: project.study, instanceId: 'inst-other' })
  assert.throws(() => b.read('participants'), error => error instanceof DataError && error.code === 'recovery_required')
  assert.throws(() => b.commit('participants', participantsDoc(['P-0002']), { owner: 'study-ops' }), error => error instanceof DataError && error.code === 'recovery_required')
})

test('D01-B2 未初始化数据根仍可空读，不会误报', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-inst3-')))
  const data = openResearchData({ study: project.study, instanceId: 'inst-fresh' })
  const result = data.read('participants')
  assert.equal(result.value, null)
  assert.ok(['empty', 'unconfigured'].includes(result.health.state))
})

test('D01-C 篡改 manifest 身份或代次时拒绝读取', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-manifest-')))
  const a = openResearchData({ study: project.study, instanceId: 'inst-A' })
  const result = a.commit('participants', participantsDoc(['P-0001']), { owner: 'study-ops' })
  const manifestPath = path.join(project.dataRoot, 'generations', 'participants', result.generationId, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  manifest.instanceId = 'inst-EVIL'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  assert.throws(() => a.read('participants'), error => error instanceof DataError && ['wrong_instance', 'source_invalid'].includes(error.code))

  manifest.instanceId = 'inst-A'
  manifest.generationId = 'g999999-deadbeef'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  assert.throws(() => a.read('participants'), error => error instanceof DataError && error.code === 'source_invalid')
})

test('D02-A 空锁与截断 JSON 锁：有界返回 recovery_required，不无线忙等', () => {
  for (const content of ['', '{ "schemaVersion": 1, "dataset": "participants"']) {
    const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-lock1-')))
    const data = openResearchData({ study: project.study, instanceId: 'inst-A' })
    const lock = path.join(project.dataRoot, 'transactions', `lock-${createHash('sha256').update('participants').digest('hex').slice(0, 16)}.json`)
    mkdirSync(path.dirname(lock), { recursive: true })
    writeFileSync(lock, content)
    const started = Date.now()
    assert.throws(() => data.commit('participants', participantsDoc(['P-0001']), { owner: 'x', timeoutMs: 600 }), error => error instanceof DataError && error.code === 'recovery_required')
    assert.ok(Date.now() - started < 3000, '坏锁必须在有界时间内返回')
  }
})

test('D02-B 活锁拒绝；同主机死锁可恢复；其他主机与未知字段不抢占', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-lock2-')))
  const data = openResearchData({ study: project.study, instanceId: 'inst-A' })
  const lockName = createHash('sha256').update('participants').digest('hex').slice(0, 16)
  const lock = path.join(project.dataRoot, 'transactions', `lock-${lockName}.json`)
  mkdirSync(path.dirname(lock), { recursive: true })
  const record = { schemaVersion: 1, dataset: 'participants', processId: process.pid, hostname: os.hostname(), bootId: Math.round((Date.now() - os.uptime() * 1000) / 1000), transactionId: 'tx-live', owner: 'live', studyId: project.study.id, instanceId: 'inst-A', startedAt: new Date().toISOString() }
  writeFileSync(lock, JSON.stringify(record))
  assert.throws(() => data.commit('participants', participantsDoc(['P-0001']), { owner: 'x', timeoutMs: 300 }), error => error instanceof DataError && error.code === 'dataset_conflict')
  assert.ok(existsSync(lock), '活锁不能被删除')

  record.processId = 999999
  writeFileSync(lock, JSON.stringify(record))
  const ok = data.commit('participants', participantsDoc(['P-0001']), { owner: 'x', timeoutMs: 800 })
  assert.equal(ok.committed, true)

  record.processId = process.pid
  record.hostname = 'other-host'
  writeFileSync(lock, JSON.stringify(record))
  assert.throws(() => data.commit('participants', participantsDoc(['P-0002']), { owner: 'x', timeoutMs: 300 }), error => error instanceof DataError && error.code === 'dataset_conflict')
  assert.ok(existsSync(lock), '其他主机的锁不能被抢占')

  writeFileSync(lock, JSON.stringify({ schemaVersion: 1, dataset: 'participants' }))
  assert.throws(() => data.commit('participants', participantsDoc(['P-0003']), { owner: 'x', timeoutMs: 300 }), error => error instanceof DataError && error.code === 'recovery_required')
})

test('D03-A 分析层遇到损坏来源必须失败，不能生成 0 人数据集', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-analysis-')))
  const data = openResearchData({ study: project.study, instanceId: 'inst-A' })
  const result = data.commit('participants', participantsDoc(['P-0001']), { owner: 'study-ops' })
  const dataFile = path.join(project.dataRoot, 'generations', 'participants', result.generationId, 'data.json')
  writeFileSync(dataFile, JSON.stringify({ participants: [] }, null, 2))
  assert.throws(() => openAnalysis({ data, study: project.study }).dataset({ plan: {} }), error => ['source_unreadable', 'source_invalid'].includes(error.code))
})

test('D03-B 参与者未初始化时明确说明等待初始化，不返回空表', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-analysis2-')))
  const data = openResearchData({ study: project.study, instanceId: 'inst-A' })
  assert.throws(() => openAnalysis({ data, study: project.study }).dataset({ plan: {} }), error => error.code === 'source_unconfigured')
})

/* ---------- D04 复合事务 ---------- */

import { openFlow } from '../flow.mjs'

test('D04-A 人口学版本冲突时参与者与人口学都不变', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-d04a-')))
  const data = openResearchData({ study: project.study, instanceId: 'inst-A' })
  const flow = openFlow({ data, study: project.study })
  flow.demographics.commit({ document: { schemaVersion: 1, rows: [{ participantId: 'P-0001' }] } })
  const beforeParticipants = data.read('participants').revision
  const beforeDemographics = data.read('demographics').revision

  assert.throws(
    () => flow.demographics.commit({ document: { schemaVersion: 1, rows: [{ participantId: 'P-0002' }, { participantId: 'P-0003' }] }, expectedRevision: 'stale-hash' }),
    error => error.code === 'dataset_conflict',
  )
  assert.equal(data.read('participants').revision, beforeParticipants)
  assert.equal(data.read('demographics').revision, beforeDemographics)
  assert.equal(flow.participants.resolve('P-0002'), null)
  assert.equal(flow.participants.resolve('P-0003'), null)
})

test('D04-B 指针先于 current 发布时读者看到新事务，reconcile 幂等补齐', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-d04b-')))
  const data = openResearchData({ study: project.study, instanceId: 'inst-A' })
  const v1 = data.commit('demographics', { schemaVersion: 1, rows: [{ participantId: 'P-0001' }] }, { owner: 'test' })
  const next = JSON.stringify({ schemaVersion: 1, rows: [{ participantId: 'P-0001' }, { participantId: 'P-0002' }] }, null, 2)
  const hash = createHash('sha256').update(next).digest('hex')
  const generationId = 'g000002-' + hash.slice(0, 8)
  const folder = path.join(project.dataRoot, 'generations', 'demographics', generationId)
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'data.json'), next)
  writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, generationId, dataset: 'demographics', studyId: project.study.id, instanceId: 'inst-A',
    revision: 2, contentHash: hash, createdAt: new Date().toISOString(), owner: 'test', inputs: [],
    files: [{ role: 'data', relativePath: 'data.json', sha256: hash, bytes: Buffer.byteLength(next) }],
    corrects: null, transactionId: 'tx-crash', note: '',
  }, null, 2))
  writeFileSync(path.join(project.dataRoot, 'transactions', 'study-pointer.json'), JSON.stringify({
    schemaVersion: 1, studyId: project.study.id, instanceId: 'inst-A', transactionId: 'tx-crash',
    at: new Date().toISOString(), datasets: { demographics: { revision: 2, generationId, contentHash: hash } },
  }, null, 2))

  assert.equal(data.read('demographics').revision, 2, '指针优先于滞后的 current.json')
  assert.deepEqual(data.reconcile(), ['demographics'])
  assert.equal(data.reconcile().length, 0, 'reconcile 幂等')
  assert.equal(readFileSync(path.join(project.dataRoot, 'generations', 'demographics', 'current.json'), 'utf8').includes('g000002'), true)
})

test('D04-C 两个实例并发登记同一编号：一笔成功，另一笔冲突且不重复', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-r01-d04c-')))
  const one = openResearchData({ study: project.study, instanceId: 'inst-A' })
  const two = openResearchData({ study: project.study, instanceId: 'inst-A' })
  const document = { schemaVersion: 1, rows: [{ participantId: 'P-0001' }] }
  one.commitMany([{ name: 'participants', value: { schemaVersion: 1, participants: [{ participantKey: 'k1', participantId: 'P-0001' }] }, expectedRevision: 'empty' }, { name: 'demographics', value: document, expectedRevision: 'empty' }], { owner: 'one' })
  assert.throws(
    () => two.commitMany([{ name: 'participants', value: { schemaVersion: 1, participants: [{ participantKey: 'k2', participantId: 'P-0001' }] }, expectedRevision: 'empty' }, { name: 'demographics', value: document, expectedRevision: 'empty' }], { owner: 'two' }),
    error => error.code === 'dataset_conflict',
  )
  const flow = openFlow({ data: one, study: project.study })
  const rows = flow.participants.list().filter(row => row.participantId === 'P-0001')
  assert.equal(rows.length, 1)
})