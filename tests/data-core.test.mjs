/**
 * 02 阶段数据核心验收：DATA-02 / DATA-03 / DATA-04、PRIV-01 / PRIV-02、REC-01。
 * DATA-01（两进程同时写）在 data-lock.test.mjs 里用真实子进程验证。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DataError, openResearchData } from '../data.mjs'
import { assertOutboundAllowed, describeStorageLocation, evaluatePrivacy, modelSafe } from '../privacy.mjs'

function makeProject(root, { studyId = 'data-study', plugins = {} } = {}) {
  mkdirSync(root, { recursive: true })
  const studyPath = path.join(root, 'study.json')
  writeFileSync(studyPath, JSON.stringify({ schemaVersion: 1, studyId, name: '数据核心合成研究', dataRoot: './data', participantId: {}, visits: [], tasks: [], followups: [], plugins }, null, 2))
  const dataRoot = path.join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const study = { id: studyId, name: '数据核心合成研究', path: studyPath, dataRoot, baseDir: root, plugin: {} }
  return { study, studyPath, dataRoot }
}

function open(project, instanceId = 'inst-test-0001', extra = {}) {
  return openResearchData({ study: project.study, instanceId, ...extra })
}

test('提交产生不可变代次、manifest 与 durable 变化记录', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-data-basic-')))
  const data = open(project)
  assert.equal(data.read('demographics').health.state, 'empty')

  const first = data.commit('demographics', { rows: [{ participantKey: 'k1', participantId: 'P-0001', rawValues: { sex: 'f' } }] }, { owner: 'demographic-coder' })
  assert.equal(first.committed, true)
  assert.equal(first.revision, 1)
  assert.match(first.generationId, /^g000001-/)
  const generationDir = path.join(project.dataRoot, 'generations', 'demographics', first.generationId)
  assert.ok(existsSync(path.join(generationDir, 'manifest.json')))
  assert.ok(existsSync(path.join(generationDir, 'data.json')))

  const readBack = data.read('demographics')
  assert.equal(readBack.health.state, 'ok')
  assert.equal(readBack.revision, 1)
  assert.equal(readBack.contentHash, first.contentHash)
  assert.equal(readBack.value.rows[0].participantId, 'P-0001')

  const changes = data.changesSince(0)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].dataset, 'demographics')
  assert.equal(changes[0].newRevision, 1)
  assert.equal(changes[0].instanceId, 'inst-test-0001')

  // 相同内容再提交不产生新代次。
  const again = data.commit('demographics', { rows: [{ participantKey: 'k1', participantId: 'P-0001', rawValues: { sex: 'f' } }] }, { owner: 'demographic-coder' })
  assert.equal(again.unchanged, true)
  assert.equal(data.read('demographics').revision, 1)
})

test('DATA-02 中断在 staging / 孤儿代次 / 兼容镜像时，读者只看到完整旧代', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-data-crash-')))
  const data = open(project)
  data.commit('demographics', { rows: [{ participantKey: 'k1', participantId: 'P-0001' }] }, { owner: 'A' })
  const headBefore = data.head('demographics')
  assert.equal(headBefore.revision, 1)

  // 1) staging 中有半成品（未写 manifest），读者不受影响。
  const partial = path.join(project.dataRoot, 'transactions', 'tx-crash-1')
  mkdirSync(partial, { recursive: true })
  writeFileSync(path.join(partial, 'data.json'), '{"rows": [')
  let preview = data.recoverPreview()
  assert.ok(preview.pendingTransactions.includes('tx-crash-1'))
  assert.equal(data.read('demographics').revision, 1)

  // 2) 代次目录已重命名但 current.json 未发布：属于孤儿，不参与读取。
  const orphan = path.join(project.dataRoot, 'generations', 'demographics', 'g000002-deadbeef')
  mkdirSync(orphan, { recursive: true })
  writeFileSync(path.join(orphan, 'manifest.json'), JSON.stringify({ schemaVersion: 1, generationId: 'g000002-deadbeef', revision: 2, contentHash: 'deadbeef', files: [] }))
  writeFileSync(path.join(orphan, 'data.json'), '{"rows": []}')
  preview = data.recoverPreview()
  assert.ok(preview.orphanGenerations.some(row => row.generation === 'g000002-deadbeef'))
  assert.equal(data.read('demographics').revision, 1)

  // 3) 兼容镜像被写了一半：权威读取仍然来自已提交代次。
  const mirror = data.locate('demographics')
  mkdirSync(path.dirname(mirror), { recursive: true })
  writeFileSync(mirror, '{"rows": [')
  assert.equal(data.read('demographics').revision, 1)
  assert.equal(data.read('demographics').value.rows[0].participantId, 'P-0001')

  // 恢复只归档未完成事务、不动已提交代次。
  const recovered = data.recover()
  assert.equal(recovered.archived.length, 1)
  assert.equal(data.read('demographics').revision, 1)
  assert.equal(data.head('demographics').generationId, headBefore.generationId)

  // 4) 正常提交后原子切换。
  const second = data.commit('demographics', { rows: [{ participantKey: 'k1', participantId: 'P-0002' }] }, { owner: 'A' })
  assert.equal(second.revision, 2)
  assert.equal(data.read('demographics').revision, 2)
  assert.equal(data.read('demographics').value.rows[0].participantId, 'P-0002')
  assert.equal(second.manifest.corrects, null)
})

test('DATA-03 人口学自定义位置、错误实例身份、损坏 JSON 与来源健康', () => {
  const custom = path.join(mkdtempSync(path.join(os.tmpdir(), 'rc-data-custom-')), 'custom', 'demo.json')
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-data-health-')), { plugins: { demographics: { dataPath: custom } } })
  const data = open(project)
  assert.equal(data.locate('demographics'), path.resolve(custom))

  // 自定义位置在数据根之外且未列入 allowedExternalRoots：写入被策略拒绝。
  assert.throws(() => data.commit('demographics', { rows: [] }, { owner: 'A' }), error => error instanceof DataError && error.code === 'policy_blocked')

  // 明确列出来之后可以写。
  mkdirSync(path.dirname(custom), { recursive: true })
  const allowed = open(project, 'inst-test-0001', { allowedExternalRoots: [path.dirname(custom)] })
  const written = allowed.commit('demographics', { rows: [{ participantKey: 'k1', participantId: 'P-0001' }] }, { owner: 'A', mirrors: [{ relativePath: 'demographics/demographics.mirror.json', text: '{"rows":1}' }] })
  assert.equal(written.committed, true)
  assert.ok(existsSync(path.join(project.dataRoot, 'demographics', 'demographics.mirror.json')))

  // 错误实例身份：数据根已被第一次写入认领给另一个实例。
  assert.throws(() => open(project, 'inst-other-9999', { allowedExternalRoots: [path.dirname(custom)] }).commit('demographics', { rows: [] }, { owner: 'B' }), error => error instanceof DataError && error.code === 'wrong_instance')

  // 默认位置与人口学插件一致：dataRoot/demographics.json（没有 dataPath/labDir 时）。
  const legacyProject = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-data-legacy-')))
  writeFileSync(legacyProject.studyPath, JSON.stringify({ schemaVersion: 1, studyId: 'data-study', name: 'x', dataRoot: './data', plugins: { demographics: {} } }, null, 2))
  writeFileSync(path.join(legacyProject.dataRoot, 'demographics.json'), JSON.stringify({ studyId: 'data-study', rows: [{ id: 'P-0001' }] }))
  const legacyData = open(legacyProject)
  assert.equal(legacyData.locate('demographics'), path.join(legacyProject.dataRoot, 'demographics.json'))
  const legacyHealth = legacyData.health('demographics')
  assert.equal(legacyHealth.legacy.state, 'ok')
  assert.ok(legacyHealth.legacy.bytes > 0)

  // 损坏的旧文件不能降级成"尚未录入"。
  const corrupt = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-data-corrupt-')))
  writeFileSync(corrupt.studyPath, JSON.stringify({ schemaVersion: 1, studyId: 'data-study', name: 'x', dataRoot: './data', plugins: { demographics: { dataPath: path.join(corrupt.dataRoot, 'demographics', 'demographics.json') } } }, null, 2))
  mkdirSync(path.join(corrupt.dataRoot, 'demographics'), { recursive: true })
  writeFileSync(path.join(corrupt.dataRoot, 'demographics', 'demographics.json'), '{"rows": [')
  const corruptData = open(corrupt)
  const health = corruptData.health('demographics')
  assert.equal(health.committed.state, 'empty')
  assert.equal(health.legacy.state, 'invalid')
  assert.equal(health.state, 'invalid', '损坏文件不能显示成尚未录入')

  // 当前指针指向缺失代次 → conflict，而不是空。
  const broken = open(makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-data-broken-'))))
  broken.commit('tasks', { list: [] }, { owner: 'A' })
  const head = broken.head('tasks')
  rmSync(path.join(project.dataRoot, 'generations'), { recursive: true, force: true })
  const brokenHead = path.join(broken.root, 'generations', 'tasks', head.generationId)
  rmSync(brokenHead, { recursive: true, force: true })
  const brokenRead = broken.read('tasks')
  assert.equal(brokenRead.health.state, 'conflict')
})

test('DATA-04 修正/改号生成新代次并有前后关联，旧代次 hash 不变', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-data-correct-')))
  const data = open(project)
  const first = data.commit('demographics', { rows: [{ participantKey: 'k1', participantId: 'P-0001', rawValues: { sex: 'f' } }] }, { owner: 'A' })
  // 分析运行的输入快照：记录当时的代次与 hash。
  const analysisInput = { dataset: 'demographics', generationId: first.generationId, contentHash: first.contentHash }
  const oldBytes = readFileSync(path.join(project.dataRoot, 'generations', 'demographics', first.generationId, 'data.json'))
  const oldHash = first.contentHash

  const second = data.commit('demographics', { rows: [{ participantKey: 'k1', participantId: 'P-0001-改', rawValues: { sex: 'f' } }] }, { owner: 'A', corrects: first.generationId, note: '改号' })
  assert.equal(second.revision, 2)
  assert.equal(second.manifest.corrects, first.generationId)
  assert.equal(data.read('demographics').value.rows[0].participantId, 'P-0001-改')

  const history = data.history('demographics')
  assert.equal(history.length, 2)
  const oldEntry = history.find(row => row.generationId === first.generationId)
  assert.ok(oldEntry, '旧代次仍在历史里')
  assert.equal(oldEntry.contentHash, oldHash, '旧代次 hash 不因修正而变')
  assert.equal(analysisInput.contentHash, oldHash)
  assert.equal(readFileSync(path.join(project.dataRoot, 'generations', 'demographics', first.generationId, 'data.json')).equals(oldBytes), true, '旧代次文件未被改写')

  // 过期的预期版本被明确拒绝。
  assert.throws(() => data.commit('demographics', { rows: [] }, { expectedRevision: 1, owner: 'B' }), error => error instanceof DataError && error.code === 'dataset_conflict')
})

test('PRIV-01 严格本地可执行性判定与模型侧脱敏', () => {
  const safe = evaluatePrivacy({ mode: 'strict-local', tools: ['study_status', 'scale_list', 'analysis_status'] })
  assert.equal(safe.enforceable, true)
  assert.equal(safe.bypasses.length, 0)

  const leaky = evaluatePrivacy({ mode: 'strict-local', tools: ['study_status', 'read', 'web_fetch'], attachments: true })
  assert.equal(leaky.enforceable, false)
  assert.deepEqual(leaky.bypasses.map(row => row.tool).sort(), ['attachments', 'read', 'web_fetch'])
  assert.match(leaky.note, /不能声称严格本地/)

  const summary = {
    study: { name: '合成研究', dataRoot: 'D:\\synthetic-lab' },
    counts: { participants: 61, male: 20, female: 41 },
    participants: [{ participantId: 'P-0001', name: '张三', phone: '13800000000', rawValues: { age: 20 } }],
  }
  const safeSummary = modelSafe(summary)
  const text = JSON.stringify(safeSummary)
  assert.doesNotMatch(text, /P-0001|张三|13800000000|synthetic-lab/)
  assert.equal(safeSummary.counts.male, 20)
  assert.equal(safeSummary.counts.female, 41)

  assert.throws(() => assertOutboundAllowed({ mode: 'strict-local' }, { counts: { n: 1 } }), error => error.code === 'policy_blocked')
  const outbound = assertOutboundAllowed({ mode: 'summary-cloud', allowedFields: ['counts', 'male', 'female'] }, { counts: { male: 20, female: 41 } })
  assert.equal(outbound.ok, true)
  assert.throws(() => assertOutboundAllowed({ mode: 'summary-cloud', allowedFields: ['counts'] }, { participants: [{ participantId: 'P-0001', rawValues: { sex: 'f' } }] }), error => error.code === 'policy_blocked')
})

test('PRIV-02 断网也能完成本地提交、读取、备份与恢复', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-data-offline-')))
  const backupDir = mkdtempSync(path.join(os.tmpdir(), 'rc-data-offline-backup-'))
  const originalFetch = globalThis.fetch
  let called = 0
  globalThis.fetch = (...args) => { called += 1; throw new Error('offline: 不应发起网络请求 ' + String(args[0])) }
  try {
    const data = open(project)
    data.commit('demographics', { rows: [{ participantKey: 'k1', participantId: 'P-0001' }] }, { owner: 'offline' })
    assert.equal(data.read('demographics').health.state, 'ok')
    const backup = data.backup(backupDir)
    assert.ok(existsSync(path.join(backup.folder, 'backup.json')))
    const preflight = data.restorePreflight(backup.folder)
    assert.equal(preflight.ok, true)
    assert.equal(called, 0, '数据核心不应发起任何网络请求')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('REC-01 备份恢复后实例身份、版本与内容 hash 一致；篡改的备份被预检拒绝', () => {
  const project = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-data-rec-')))
  const backupDir = mkdtempSync(path.join(os.tmpdir(), 'rc-data-rec-backup-'))
  const data = open(project, 'inst-backup-0001')
  data.ensureInstance({ create: true })
  const demographics = data.commit('demographics', { rows: [{ participantKey: 'k1', participantId: 'P-0001' }] }, { owner: 'A', mirrors: [{ relativePath: 'demographics/demographics.csv', text: 'k1,P-0001\n', role: 'csv' }] })
  const reportHash = 'sha256:report-demo'
  data.commit('participants', { participants: [{ participantKey: 'k1', participantId: 'P-0001' }], report: { hash: reportHash } }, { owner: 'A' })

  const backup = data.backup(backupDir)
  const preflight = data.restorePreflight(backup.folder)
  assert.equal(preflight.ok, true, preflight.problems.join('；'))
  assert.ok(preflight.document.datasets.length >= 2)

  // 恢复到全新的数据根（模拟恢复到另一台机器/另一份副本）。
  const target = makeProject(mkdtempSync(path.join(os.tmpdir(), 'rc-data-rec-target-')))
  const restored = open(target, 'inst-backup-0001')
  const result = restored.restore(backup.folder)
  assert.equal(result.restored, true)
  assert.equal(restored.instanceId, 'inst-backup-0001')
  assert.equal(restored.ensureInstance().studyId, 'data-study')
  assert.equal(restored.read('demographics').revision, demographics.revision)
  assert.equal(restored.read('demographics').contentHash, demographics.contentHash)
  assert.equal(restored.read('participants').value.report.hash, reportHash)
  assert.equal(data.read('demographics').contentHash, restored.read('demographics').contentHash)

  // 篡改备份内容 → 预检失败，恢复不会悄悄接受。
  const tampered = path.join(backup.folder, 'generations', 'demographics', demographics.generationId, 'data.json')
  writeFileSync(tampered, readFileSync(tampered, 'utf8').replace('P-0001', 'P-9999'))
  const badPreflight = restored.restorePreflight(backup.folder)
  assert.equal(badPreflight.ok, false)
  assert.match(badPreflight.problems.join('；'), /hash 不符|digest/)

  // 同步目录提示是路径事实，不是承诺。
  const note = describeStorageLocation('C:\\Users\\me\\OneDrive\\文档\\lab')
  assert.deepEqual(note.syncProviders, ['OneDrive'])
  assert.match(note.warning, /OneDrive/)
})
