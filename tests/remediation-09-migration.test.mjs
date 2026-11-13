/**
 * 09 阶段：私有副本迁移与回退演练。
 *
 * 全部使用 mkdtemp 合成研究：不打开、不复制、不写入任何真实研究目录
 * （D:\yyh-lab、workspace 里的真实 study 或真实数据根）。
 *
 * 覆盖：
 *   a. 建研究并写入参与者/人口学/观察/分数，记录 revision、contentHash 与来源健康；
 *   b. backup 到临时目录，核对 backup.json 的清单、逐文件 hash 与 digest；
 *   c. 数据根整体复制为影子副本，按同一研究定义从新路径读取，健康仍为 ok；
 *      原目录逐文件 hash 不变；副本继承实例身份，换新 instanceId 会被有界拒绝；
 *   d. 切换后新增只落在影子副本，原目录不出现新参与者/观察；
 *   e. 回退：切换到新副本后新增的数据先单独备份；旧备份恢复到另一个干净根，
 *      旧数据恢复而新增数据不在其中；新增数据可从切换后备份重新导入，未被静默覆盖。
 *      restorePreflight 对错误实例/版本/研究/篡改文件有界拒绝。
 *   f. 同时记录一个真实限制：就地 restore 只写 current.json，不重置 study-pointer，
 *      因此同一数据根上 restore 返回成功，读取仍以更高代次的指针为准（见 M09-E）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DataError, openResearchData } from '../data.mjs'
import { openFlow } from '../flow.mjs'
import { openAnalysis } from '../analysis.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
const shaBytes = bytes => createHash('sha256').update(bytes).digest('hex')

/** 所有数据/备份/影子/回退目录都必须在系统临时目录内，绝不允许真实研究路径。 */
function assertInsideTemp(target) {
  const tmp = path.resolve(os.tmpdir())
  const resolved = path.resolve(target)
  const rel = path.relative(tmp, resolved)
  assert.ok(rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)), `路径不在系统临时目录内：${resolved}`)
  assert.doesNotMatch(resolved, /yyh-lab|dsh[\\/]plugins[\\/]research-core[\\/](data|fixtures)/i)
}

/** 建一个合成研究：研究定义、数据根、上下文全部在临时目录。 */
function makeProject(prefix, { studyId = 'remediation-09' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix))
  const dataRoot = path.join(root, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const definition = {
    schemaVersion: 1,
    studyId,
    name: '09 迁移演练合成研究',
    dataRoot: './data',
    participantId: {},
    visits: [
      { id: 'T0', label: '基线', order: 0 },
      { id: 'T1', label: '随访', order: 1 },
    ],
    tasks: [
      { id: 'demo', label: '人口学', visits: ['T0'], required: true },
      { id: 'stq', label: '状态问卷', visits: ['T0', 'T1'], required: true },
    ],
    followups: [],
    plugins: {},
  }
  const studyPath = path.join(root, 'study.json')
  writeFileSync(studyPath, JSON.stringify(definition, null, 2))
  const study = {
    id: studyId, name: definition.name, path: studyPath, dataRoot, baseDir: root,
    plugin: {}, visits: definition.visits, tasks: definition.tasks, followups: [], revision: 'rev-1',
  }
  return { root, study, dataRoot, definition }
}

function openProject(project, instanceId) {
  const data = openResearchData({
    study: project.study,
    instanceId,
    datasets: { scores: 'scores/scores.json' },
  })
  return { data, flow: openFlow({ data, study: project.study }) }
}

const demographics = (studyId, rows) => ({
  schemaVersion: 2,
  studyId,
  name: '人口学',
  columns: [
    { key: 'sex', label: '性别', kind: 'text', role: 'sex' },
    { key: 'age', label: '年龄', kind: 'number' },
  ],
  rows: rows.map(([id, sex, age]) => ({ id, values: { sex, age } })),
})

/** 写入一个完整但很小的合成研究：2 人、人口学、2 条观察、2 条分数。 */
function seedStudy(data, flow, { studyId = 'remediation-09' } = {}) {
  flow.participants.register({ participantId: 'P-001', status: 'enrolled', groups: { arm: 'A' } })
  flow.participants.register({ participantId: 'P-002', status: 'enrolled', groups: { arm: 'B' } })
  flow.demographics.commit({ document: demographics(studyId, [['P-001', '女', '20'], ['P-002', '男', '22']]) })
  flow.observations.publish({
    participantId: 'P-001', visitId: 'T0', taskId: 'stq', collectionState: 'complete',
    qualityState: 'valid', eventDate: '2026-11-01', recordId: 'obs-P001-T0',
  })
  flow.observations.publish({
    participantId: 'P-002', visitId: 'T0', taskId: 'stq', collectionState: 'complete',
    qualityState: 'valid', eventDate: '2026-11-02', recordId: 'obs-P002-T0',
  })
  data.commit('scores', {
    schemaVersion: 1, studyId,
    rows: [
      { participantId: 'P-001', visitId: 'T0', scaleId: 'STQ', score: 12 },
      { participantId: 'P-002', visitId: 'T0', scaleId: 'STQ', score: 18 },
    ],
  }, { owner: 'scale-desk' })
}

const DATASETS = ['participants', 'demographics', 'observations', 'scores']

/** 每个数据集的当前代次与来源健康，供备份/影子逐字段对照。 */
function snapshot(data) {
  return DATASETS.map(name => {
    const result = data.read(name)
    return {
      dataset: name,
      revision: result.revision,
      contentHash: result.contentHash,
      generationId: result.generationId,
      state: result.health.state,
    }
  })
}

function healthStates(data) {
  return Object.fromEntries(data.health().map(row => [row.dataset, row.state]))
}

/** 目录内所有文件（相对路径 + 内容 hash），用于证明原目录一个字节都没被改。 */
function hashTree(root) {
  const rows = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.isFile()) rows.push(`${path.relative(root, target).split(path.sep).join('/')}:${shaBytes(readFileSync(target))}`)
    }
  }
  walk(root)
  return rows.sort()
}

/** 按 data.mjs backup 的规则重算清单 digest，确认不是只 trust 返回字段。 */
function digestOf(document) {
  return sha(JSON.stringify((document.files || []).map(file => [file.relativePath, file.sha256]).sort()))
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function participantsOf(data) {
  const result = data.read('participants')
  return (result.value?.participants || []).map(row => row.participantId)
}

test('M09-A 合成研究建档：四个数据集的 revision/contentHash 与来源健康可核对', () => {
  const project = makeProject('rc-r09-seed-')
  try {
    assertInsideTemp(project.root)
    const { data, flow } = openProject(project, 'inst-A')
    seedStudy(data, flow)

    const marks = snapshot(data)
    assert.equal(marks.length, DATASETS.length)
    for (const mark of marks) {
      assert.ok(Number.isInteger(mark.revision) && mark.revision >= 1, `${mark.dataset} 应有递增代次`)
      assert.match(mark.contentHash, /^[0-9a-f]{64}$/, `${mark.dataset} 应有内容 hash`)
      assert.equal(mark.state, 'ok', `${mark.dataset} 来源健康应为 ok`)
      assert.ok(mark.generationId)
    }

    const states = healthStates(data)
    for (const name of DATASETS) assert.equal(states[name], 'ok', `整体健康里 ${name} 应为 ok`)
    assert.equal(states.tasks, 'empty', '尚未录入的任务数据集是 empty，不是 ok 也不是 invalid')

    // 分析读数也先记一份基线，影子副本必须给出同一份数据表。
    const baseline = openAnalysis({ data, study: project.study }).dataset()
    assert.equal(baseline.stats.rows, 2)
    assert.equal(baseline.stats.withoutDemographics, 0)
    assert.ok(baseline.hash)

    // 数据集之外的审计/提交指针属于运行状态，不是合成输入；只确认它们存在且可解析。
    assert.ok(existsSync(path.join(project.dataRoot, 'study-instance.json')))
    assert.ok(existsSync(path.join(project.dataRoot, 'transactions', 'study-pointer.json')))
    assertInsideTemp(path.join(project.dataRoot, 'generations', 'participants'))
  } finally {
    rmSync(project.root, { recursive: true, force: true })
  }
})

test('M09-B 备份：清单含全部数据集、逐文件 hash 与 digest 都能复算', () => {
  const project = makeProject('rc-r09-backup-')
  const backupRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-r09-backup-out-'))
  try {
    const { data, flow } = openProject(project, 'inst-A')
    seedStudy(data, flow)
    const marks = snapshot(data)

    const backup = data.backup(backupRoot)
    assertInsideTemp(backup.folder)
    assert.ok(existsSync(path.join(backup.folder, 'backup.json')))
    assert.ok(existsSync(path.join(backup.folder, 'instance.json')))
    assert.match(backup.digest, /^[0-9a-f]{64}$/)

    const document = readJson(path.join(backup.folder, 'backup.json'))
    assert.equal(document.schemaVersion, 1)
    assert.equal(document.studyId, project.study.id)
    assert.equal(document.instanceId, 'inst-A')
    assert.equal(document.digest, backup.digest)
    assert.equal(digestOf(document), document.digest, 'digest 必须能由清单重算')

    // 每个数据集都进入备份，且 revision / contentHash 与备份前的读数一致。
    assert.deepEqual(document.datasets.map(row => row.dataset).sort(), DATASETS.slice().sort())
    for (const mark of marks) {
      const row = document.datasets.find(item => item.dataset === mark.dataset)
      assert.ok(row, `备份缺少 ${mark.dataset}`)
      assert.equal(row.revision, mark.revision)
      assert.equal(row.contentHash, mark.contentHash)
      assert.ok(row.manifest)
      assert.equal(row.manifest.contentHash, mark.contentHash)
    }

    // 逐文件校验：路径在备份目录内、sha256 与字节数都与清单一致。
    assert.ok(document.files.length >= DATASETS.length)
    for (const file of document.files) {
      const target = path.join(backup.folder, file.relativePath)
      assertInsideTemp(target)
      assert.ok(existsSync(target), `备份文件缺失：${file.relativePath}`)
      const bytes = readFileSync(target)
      assert.equal(shaBytes(bytes), file.sha256, `hash 不符：${file.relativePath}`)
      assert.equal(bytes.length, file.bytes, `字节数不符：${file.relativePath}`)
    }

    const preflight = data.restorePreflight(backup.folder)
    assert.equal(preflight.ok, true, preflight.problems.join('；'))
    assert.equal(preflight.digest, document.digest)
    assert.ok(existsSync(path.join(backup.folder, 'generations', 'participants', marks[0].generationId, 'manifest.json')))
  } finally {
    rmSync(project.root, { recursive: true, force: true })
    rmSync(backupRoot, { recursive: true, force: true })
  }
})

test('M09-C 影子副本：换路径可读、健康 ok、原目录逐字节不变；换新实例身份被有界拒绝', () => {
  const project = makeProject('rc-r09-shadow-')
  const backupRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-r09-shadow-backup-'))
  try {
    const { data, flow } = openProject(project, 'inst-A')
    seedStudy(data, flow)
    const marks = snapshot(data)
    const baseline = openAnalysis({ data, study: project.study }).dataset()

    const backup = data.backup(backupRoot)
    const before = hashTree(project.dataRoot)

    // 把数据根整体复制到另一个临时目录，并复制研究定义，使影子不依赖原路径。
    const shadowRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-r09-shadow-copy-'))
    try {
      const shadowDataRoot = path.join(shadowRoot, 'data')
      cpSync(project.dataRoot, shadowDataRoot, { recursive: true })
      const shadowStudyPath = path.join(shadowRoot, 'study.json')
      copyFileSync(project.study.path, shadowStudyPath)
      const shadowStudy = { ...project.study, path: shadowStudyPath, dataRoot: shadowDataRoot, baseDir: shadowRoot }
      assertInsideTemp(shadowDataRoot)
      assert.notEqual(path.resolve(shadowStudy.dataRoot), path.resolve(project.study.dataRoot))

      // 副本继承了实例身份：换一个新 instanceId 打开应被有界拒绝，而不是静默认领。
      const started = Date.now()
      assert.throws(
        () => openResearchData({ study: shadowStudy, instanceId: 'inst-shadow-0002', datasets: { scores: 'scores/scores.json' } }).read('participants'),
        error => error instanceof DataError && error.code === 'wrong_instance',
      )
      assert.ok(Date.now() - started < 2000, '错误实例必须在有界时间内拒绝')
      const instanceRecord = readJson(path.join(shadowDataRoot, 'study-instance.json'))
      assert.equal(instanceRecord.instanceId, 'inst-A', '复制保留原实例身份，不自动改名')

      // 同一研究定义 + 同一实例身份从新路径打开：读数与来源健康必须与备份前一致。
      const shadow = openResearchData({
        study: shadowStudy,
        instanceId: 'inst-A',
        datasets: { scores: 'scores/scores.json' },
      })
      const shadowMarks = snapshot(shadow)
      assert.deepEqual(shadowMarks, marks, '影子副本的 revision/contentHash/health 应与原根一致')
      const shadowStates = healthStates(shadow)
      for (const name of DATASETS) assert.equal(shadowStates[name], 'ok')
      const shadowBaseline = openAnalysis({ data: shadow, study: shadowStudy }).dataset()
      assert.equal(shadowBaseline.hash, baseline.hash, '分析表 hash 不应包含数据根路径')
      assert.equal(shadowBaseline.stats.rows, baseline.stats.rows)
      assert.ok(participantsOf(shadow).includes('P-001'))

      // 备份本身也能在影子副本上通过预检。
      assert.equal(shadow.restorePreflight(backup.folder).ok, true)
    } finally {
      rmSync(shadowRoot, { recursive: true, force: true })
    }

    // 复制/打开影子期间，原目录内容一个字节都不能变。
    assert.deepEqual(hashTree(project.dataRoot), before, '原数据根在影子演练中不应被修改')
    assert.equal(data.read('participants').health.state, 'ok')
  } finally {
    rmSync(project.root, { recursive: true, force: true })
    rmSync(backupRoot, { recursive: true, force: true })
  }
})

test('M09-D 切换后新增只进影子副本，旧备份回退后新增不在其中但可从切换后备份重放', () => {
  const project = makeProject('rc-r09-switch-')
  const backupRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-r09-switch-backup-'))
  const postRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-r09-switch-post-'))
  const rollbackProject = makeProject('rc-r09-rollback-', { studyId: 'remediation-09' })
  const reimportProject = makeProject('rc-r09-reimport-', { studyId: 'remediation-09' })
  try {
    const { data, flow } = openProject(project, 'inst-A')
    seedStudy(data, flow)
    const marks = snapshot(data)
    const before = hashTree(project.dataRoot)
    const preSwitch = data.backup(backupRoot)
    assert.equal(data.restorePreflight(preSwitch.folder).ok, true)

    // 影子副本作为"切换后的新数据根"，在原路径之外继续录入。
    const shadowRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-r09-switch-shadow-'))
    let shadow
    let postSwitch
    try {
      const shadowDataRoot = path.join(shadowRoot, 'data')
      cpSync(project.dataRoot, shadowDataRoot, { recursive: true })
      const shadowStudyPath = path.join(shadowRoot, 'study.json')
      copyFileSync(project.study.path, shadowStudyPath)
      const shadowStudy = { ...project.study, path: shadowStudyPath, dataRoot: shadowDataRoot, baseDir: shadowRoot }
      shadow = openResearchData({ study: shadowStudy, instanceId: 'inst-A', datasets: { scores: 'scores/scores.json' } })
      const shadowFlow = openFlow({ data: shadow, study: shadowStudy })

      shadowFlow.participants.register({ participantId: 'P-003', status: 'enrolled', groups: { arm: 'A' } })
      shadowFlow.observations.publish({
        participantId: 'P-003', visitId: 'T0', taskId: 'stq', collectionState: 'complete',
        qualityState: 'valid', eventDate: '2026-11-03', recordId: 'obs-P003-T0',
      })
      shadow.commit('scores', {
        schemaVersion: 1, studyId: project.study.id,
        rows: [
          { participantId: 'P-001', visitId: 'T0', scaleId: 'STQ', score: 12 },
          { participantId: 'P-002', visitId: 'T0', scaleId: 'STQ', score: 18 },
          { participantId: 'P-003', visitId: 'T0', scaleId: 'STQ', score: 25 },
        ],
      }, { owner: 'scale-desk' })

      const markOf = name => marks.find(mark => mark.dataset === name)

      // 新增只出现在影子；原目录仍只有 2 人、revision 不变。
      assert.deepEqual(participantsOf(shadow).sort(), ['P-001', 'P-002', 'P-003'])
      assert.equal(shadow.read('participants').revision, markOf('participants').revision + 1)
      assert.equal(shadow.read('observations').revision, markOf('observations').revision + 1)
      assert.equal(shadow.read('scores').revision, markOf('scores').revision + 1)
      assert.deepEqual(participantsOf(data).sort(), ['P-001', 'P-002'])
      assert.equal(data.read('participants').revision, markOf('participants').revision, '原根不能被影子写入带动')
      assert.equal(data.read('observations').revision, markOf('observations').revision)
      assert.deepEqual(hashTree(project.dataRoot), before, '影子写入不应修改原数据根')

      // 回退前先保存切换后的新增数据。
      postSwitch = shadow.backup(postRoot)
      const postDocument = readJson(path.join(postSwitch.folder, 'backup.json'))
      assert.equal(postDocument.instanceId, 'inst-A')
      for (const name of ['participants', 'observations', 'scores']) {
        const row = postDocument.datasets.find(item => item.dataset === name)
        assert.ok(row)
        assert.equal(row.revision, shadow.read(name).revision)
      }
      const newParticipantsFile = path.join(
        postSwitch.folder, 'generations', 'participants',
        postDocument.datasets.find(row => row.dataset === 'participants').generationId, 'data.json',
      )
      assert.match(readFileSync(newParticipantsFile, 'utf8'), /P-003/, '切换后备份必须包含新增参与者')
    } finally {
      rmSync(shadowRoot, { recursive: true, force: true })
    }

    // 回退：恢复到另一个干净数据根（同一实例）。旧数据回来，新增数据不在其中。
    const { data: rollback } = openProject(rollbackProject, 'inst-A')
    const fallback = rollback.restore(preSwitch.folder)
    assert.equal(fallback.restored, true)
    assert.equal(fallback.digest, preSwitch.digest)
    assert.deepEqual(
      fallback.datasets.map(row => [row.dataset, row.revision]).sort(),
      readJson(path.join(preSwitch.folder, 'backup.json')).datasets.map(row => [row.dataset, row.revision]).sort(),
    )
    const markOf = name => marks.find(mark => mark.dataset === name)
    assert.deepEqual(participantsOf(rollback).sort(), ['P-001', 'P-002'], '旧备份只恢复切换前数据')
    assert.equal(rollback.read('participants').revision, markOf('participants').revision)
    assert.equal(rollback.read('observations').revision, markOf('observations').revision)
    assert.equal(rollback.read('scores').revision, markOf('scores').revision)
    assert.equal(rollback.read('demographics').revision, markOf('demographics').revision)
    assert.ok(!participantsOf(rollback).includes('P-003'), '回退后新增参与者不能悄悄出现，也不能被伪装成旧数据')
    for (const name of DATASETS) assert.equal(healthStates(rollback)[name], 'ok')
    assert.equal(openAnalysis({ data: rollback, study: rollbackProject.study }).dataset().stats.rows, 2)

    // 新增数据没有丢：恢复到另一个干净根导入切换后备份，P-003 及其观察/分数重新出现。
    const { data: reimportData } = openProject(reimportProject, 'inst-A')
    const reimport = reimportData.restore(postSwitch.folder)
    assert.equal(reimport.restored, true)
    assert.deepEqual(participantsOf(reimportData).sort(), ['P-001', 'P-002', 'P-003'])
    assert.equal(reimportData.read('participants').revision, markOf('participants').revision + 1)
    assert.equal(reimportData.read('observations').revision, markOf('observations').revision + 1)
    const observationIds = (reimportData.read('observations').value?.observations || []).map(row => row.recordId)
    assert.ok(observationIds.includes('obs-P003-T0'), '切换后观察必须可重放')
    const scoreIds = (reimportData.read('scores').value?.rows || []).map(row => row.participantId)
    assert.ok(scoreIds.includes('P-003'), '切换后分数必须可重放')
    // restore 只追加/切换 current，不删除已提交代次：新增代次仍在目录里。
    const finalGeneration = reimportData.read('participants').generationId
    assert.ok(existsSync(path.join(reimportProject.dataRoot, 'generations', 'participants', finalGeneration)))
    assert.match(readFileSync(path.join(reimportProject.dataRoot, 'generations', 'participants', finalGeneration, 'data.json'), 'utf8'), /P-003/)
  } finally {
    rmSync(project.root, { recursive: true, force: true })
    rmSync(backupRoot, { recursive: true, force: true })
    rmSync(postRoot, { recursive: true, force: true })
    rmSync(rollbackProject.root, { recursive: true, force: true })
    rmSync(reimportProject.root, { recursive: true, force: true })
  }
})

test('M09-E restorePreflight 对错误实例/版本/研究/缺失/篡改备份有界拒绝', () => {
  const project = makeProject('rc-r09-preflight-')
  const backupRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-r09-preflight-out-'))
  const tamperRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-r09-preflight-tamper-'))
  try {
    const { data, flow } = openProject(project, 'inst-A')
    seedStudy(data, flow)
    const backup = data.backup(backupRoot)

    const clone = name => {
      const target = path.join(tamperRoot, name)
      cpSync(backup.folder, target, { recursive: true })
      return target
    }
    const editDocument = (folder, edit) => {
      const file = path.join(folder, 'backup.json')
      const document = readJson(file)
      edit(document)
      writeFileSync(file, JSON.stringify(document, null, 2))
      return folder
    }
    const bounded = fn => {
      const started = Date.now()
      const value = fn()
      assert.ok(Date.now() - started < 2000, '预检拒绝必须有界')
      return value
    }

    const wrongInstance = editDocument(clone('wrong-instance'), document => { document.instanceId = 'inst-OTHER' })
    const instanceResult = bounded(() => data.restorePreflight(wrongInstance))
    assert.equal(instanceResult.ok, false)
    assert.match(instanceResult.problems.join('；'), /实例/)

    const wrongVersion = editDocument(clone('wrong-version'), document => { document.schemaVersion = 2 })
    const versionResult = bounded(() => data.restorePreflight(wrongVersion))
    assert.equal(versionResult.ok, false)
    assert.match(versionResult.problems.join('；'), /不支持的备份版本/)

    const wrongStudy = editDocument(clone('wrong-study'), document => { document.studyId = 'another-study' })
    const studyResult = bounded(() => data.restorePreflight(wrongStudy))
    assert.equal(studyResult.ok, false)
    assert.match(studyResult.problems.join('；'), /研究/)

    const missing = path.join(tamperRoot, 'no-backup')
    mkdirSync(missing, { recursive: true })
    const missingResult = bounded(() => data.restorePreflight(missing))
    assert.equal(missingResult.ok, false)
    assert.match(missingResult.problems.join('；'), /缺少 backup\.json/)

    const tampered = clone('tampered-file')
    const document = readJson(path.join(tampered, 'backup.json'))
    const participantsRow = document.datasets.find(row => row.dataset === 'participants')
    const targetFile = path.join(tampered, 'generations', 'participants', participantsRow.generationId, 'data.json')
    writeFileSync(targetFile, readFileSync(targetFile, 'utf8').replace('P-001', 'P-999'))
    const tamperedResult = bounded(() => data.restorePreflight(tampered))
    assert.equal(tamperedResult.ok, false)
    assert.match(tamperedResult.problems.join('；'), /hash 不符|digest/)

    // 预检失败时 restore 必须拒绝，并且当前数据根一个字节都不写。
    const before = hashTree(project.dataRoot)
    const started = Date.now()
    assert.throws(
      () => data.restore(wrongInstance),
      error => error instanceof DataError && error.code === 'source_invalid' && error.committed === false,
    )
    assert.ok(Date.now() - started < 2000)
    assert.deepEqual(hashTree(project.dataRoot), before, '预检失败不能写数据根')
    assert.equal(data.read('participants').health.state, 'ok')
  } finally {
    rmSync(project.root, { recursive: true, force: true })
    rmSync(backupRoot, { recursive: true, force: true })
    rmSync(tamperRoot, { recursive: true, force: true })
  }
})

test('FIX-07 同根已有已提交数据时 restore 在写入前明确拒绝', () => {
  const project = makeProject('rc-r09-inplace-')
  const backupRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-r09-inplace-out-'))
  try {
    const { data, flow } = openProject(project, 'inst-A')
    seedStudy(data, flow)
    const oldMarks = snapshot(data)
    const backup = data.backup(backupRoot)

    // 切换后新增：同一数据根上继续录入，形成更高代次。
    flow.participants.register({ participantId: 'P-003', status: 'enrolled', groups: { arm: 'A' } })
    const newRevision = data.read('participants').revision
    const newGenerationId = data.read('participants').generationId
    assert.equal(newRevision, oldMarks[0].revision + 1)
    const pointerFile = path.join(project.dataRoot, 'transactions', 'study-pointer.json')
    const pointerBefore = readFileSync(pointerFile, 'utf8')

    const beforeReject = snapshot(data)
    assert.throws(
      () => data.restore(backup.folder),
      error => error.code === 'unsupported_restore_target',
      '同根已有已提交数据时必须在写入前拒绝，不能返回 restored:true',
    )
    assert.deepEqual(snapshot(data), beforeReject, '拒绝恢复不得改动目标数据根')
    assert.equal(readFileSync(pointerFile, 'utf8'), pointerBefore, '拒绝恢复不修改提交指针')
    assert.equal(readJson(path.join(project.dataRoot, 'generations', 'participants', 'current.json')).revision, newRevision)
    assert.equal(data.read('participants').revision, newRevision)
    assert.deepEqual(participantsOf(data).sort(), ['P-001', 'P-002', 'P-003'])

    // 新增代次没有被删除或改写：数据在，只是"回退"没有生效。
    assert.ok(existsSync(path.join(project.dataRoot, 'generations', 'participants', newGenerationId)), 'restore 不应静默删除切换后新增的代次')
    assert.match(readFileSync(path.join(project.dataRoot, 'generations', 'participants', newGenerationId, 'data.json'), 'utf8'), /P-003/)
    assert.equal(data.health('participants').state, 'ok')

    // 结论（也是本阶段报告里要写明的真实限制）：同根回退需要先停写，
    // 再把旧备份恢复到另一个干净根并切过去；当前 API 没有"重置提交指针"入口，
    // 因此不能把同根 restore 的 restored:true 当作回退完成。
    assert.ok(existsSync(path.join(backup.folder, 'backup.json')))
  } finally {
    rmSync(project.root, { recursive: true, force: true })
    rmSync(backupRoot, { recursive: true, force: true })
  }
})
