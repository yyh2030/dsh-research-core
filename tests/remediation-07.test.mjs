/**
 * 07 隐私执行与分享边界回归：P01-A / P01-B / P02-A / P02-B / P03-A（+ P03-B/P04 边界说明）。
 *
 * 只用合成研究、合成运行与临时目录；不读真实数据、不抓真实模型请求或凭证。
 * 这些测试同时走真实插件工具路径（analysis-run / scale-desk / study-ops）与投影纯函数，
 * 避免"只测脱敏函数、实际工具仍原样返回"的假通过。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  agentProjection, evaluateSessionEnforceability, resolvePrivacyPolicy, sanitizeError,
  shareManifest, shareProjection, SHARE_NOTICE,
} from '../privacy-projection.mjs'
import { renderHtmlReport } from '../results.mjs'
import { loadPlugin, makeHost } from './harness.mjs'

// 每个测试进程独立的研究绑定存储，避免不同进程/用例之间残留的会话绑定串研究。
const STORE = mkdtempSync(path.join(os.tmpdir(), 'rc-07-store-'))
process.env.DSH_RESEARCH_STORE = STORE

function makeDir(prefix = 'rc-07-') { return mkdtempSync(path.join(os.tmpdir(), prefix)) }
function readJson(target) { return JSON.parse(readFileSync(target, 'utf8')) }

function writeStudyProject({ prefix = 'rc-07-', name = '合成研究 07', plugin = {}, dataRoot = './data' } = {}) {
  const root = makeDir(prefix)
  const dataDir = path.join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const definition = {
    schemaVersion: 1,
    studyId: 'study-07',
    name,
    dataRoot,
    participantId: { pattern: '^P-\\d{3}$' },
    visits: [],
    tasks: [],
    followups: [],
    plugins: { analysis: {}, scales: {}, ops: {}, ...plugin },
  }
  const file = path.join(root, 'study.json')
  writeFileSync(file, JSON.stringify(definition, null, 2), 'utf8')
  return { root, dataDir, file, definition }
}

/** 合成运行：表里同时放编号、姓名、组别、数值与路径，用来验证工具/分享都不透传。 */
function writeFakeRun(project, { runId = '20990101-000000-07a', studyId = 'study-07', studyName = '合成研究 07' } = {}) {
  const outputDir = path.join(project.dataDir, 'analysis')
  const runDir = path.join(outputDir, 'runs', runId)
  mkdirSync(path.join(runDir, 'tables'), { recursive: true })
  const rows = [
    ['participantId', '姓名', 'group', 'mean', 'note'],
    ['P-001', '张伟', 'A', '42.5', '联系 zhangwei@example.com 或 C:\\Users\\16787\\secret'],
    ['P-002', '李四', 'B', '7', 'D:\\研究\\私密'],
  ]
  const csv = '\uFEFF' + rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n'
  writeFileSync(path.join(runDir, 'tables', 'descriptives.csv'), csv, 'utf8')
  const types = { participantId: 'string', 姓名: 'string', group: 'string', mean: 'number', note: 'string' }
  const analysisSet = { subset: 'enrolled', subjects: 2, observations: 2, excluded: 0 }
  const meta = {
    schemaVersion: 1,
    runId,
    status: 'ok',
    study: { id: studyId, name: studyName, path: project.file, dataRoot: project.dataDir },
    startedAt: '2026-11-10T00:00:00.000Z',
    finishedAt: '2026-11-10T00:00:01.000Z',
    subjects: 2,
    observations: 2,
    analysisSet,
    tables: [{ key: 'descriptives', label: '描述统计', path: 'tables/descriptives.csv', types, analysisSet }],
    artifactHashes: {},
    nodes: { descriptives: { status: 'executed' } },
    warnings: ['读取 C:\\Users\\16787\\a.csv 失败'],
  }
  writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  writeFileSync(path.join(outputDir, 'plan.json'), JSON.stringify({
    dataPath: path.join(project.root, 'missing.csv'), idColumn: 'participantId', analyses: ['descriptives'],
  }, null, 2), 'utf8')
  return { runId, runDir, outputDir }
}

let sessionSeq = 0
async function loadPluginTools(pluginName, project, { config = {}, privacyService } = {}) {
  const sessionId = `s-07-${++sessionSeq}-${Math.random().toString(16).slice(2, 6)}`
  const host = makeHost({ workspaces: [], sessions: { [sessionId]: project.root }, cwd: project.root })
  if (privacyService) host.services.privacy = privacyService
  const moduleUnderTest = await loadPlugin(path.resolve(import.meta.dirname, `../../${pluginName}`))
  moduleUnderTest.apply(host.ctx, { studyPath: '', ...config })
  return { host, tools: host.tools, exec: { agent: { id: sessionId } } }
}

function writeScaleData(project) {
  const defsDir = path.join(project.dataDir, 'scales', 'defs')
  const answersDir = path.join(project.dataDir, 'scales', 'answers')
  mkdirSync(defsDir, { recursive: true })
  mkdirSync(answersDir, { recursive: true })
  writeFileSync(path.join(defsDir, 'GARDEN.json'), readFileSync(path.resolve(import.meta.dirname, '../../scale-desk/sample-def.json'), 'utf8'), 'utf8')
  writeFileSync(path.join(answersDir, 'GARDEN__baseline.csv'), '\uFEFF编号,definitionHash,submissionId,q01,q02,q03,q04\nP-001,,sub-0001,1,2,3,4\n', 'utf8')
}

/* ------------------------------------------------------------------ *
 * P01-A：strict-local 下敏感工具只有状态/计数/opaque artifactId
 * ------------------------------------------------------------------ */

test('P01-A strict-local：analysis_results/analysis_status 不返回编号、数值、路径', async () => {
  const project = writeStudyProject()
  const run = writeFakeRun(project)
  const { tools, exec } = await loadPluginTools('analysis-run', project)

  const resultsTool = tools.get('analysis_results')
  assert.ok(resultsTool, '应注册 analysis_results')
  const results = JSON.parse((await resultsTool.execute({ runId: run.runId }, exec)).text)
  assert.equal(results.projection, 'strict-local')
  assert.equal(results.ok, true)
  assert.ok(results.counts.tables >= 1, JSON.stringify(results))
  assert.ok(Array.isArray(results.blocked) && results.blocked.length >= 1)
  assert.match(results.artifacts[0].artifactId, /^art-[a-f0-9]{16}$/)
  const resultText = JSON.stringify(results)
  for (const forbidden of ['P-001', '张伟', 'zhangwei@example.com', '42.5', 'participantId', 'C:\\Users', 'D:\\研究', 'tables/descriptives.csv']) {
    assert.ok(!resultText.includes(forbidden), `strict-local 不应返回 ${forbidden}：${resultText.slice(0, 500)}`)
  }

  const status = JSON.parse((await tools.get('analysis_status').execute({}, exec)).text)
  assert.equal(status.projection, 'strict-local')
  assert.ok(status.counts.runs >= 1)
  // 安全显示名可保留，用于让用户知道在看哪项研究；路径/真实运行编号不得出现。
  assert.match(JSON.stringify(status), /合成研究 07/)
  const statusText = JSON.stringify(status)
  for (const forbidden of ['C:\\Users', 'D:\\研究', run.runId, run.outputDir, '"paths":{', '"source":{']) {
    assert.ok(!statusText.includes(forbidden), `analysis_status 不应返回 ${forbidden}`)
  }
})

test('P01-A strict-local：scale_score 不把逐人分数、编号、量表名送入 Agent；工具参数不能放宽', async () => {
  const project = writeStudyProject()
  writeScaleData(project)
  const { tools, exec } = await loadPluginTools('scale-desk', project)

  const scoreTool = tools.get('scale_score')
  assert.ok(scoreTool, '应注册 scale_score')
  const strict = await scoreTool.execute({ id: 'P-001' }, exec)
  assert.match(strict.text, /严格本地|只给状态与计数/)
  assert.match(strict.text, /subjects 1/)
  for (const forbidden of ['P-001', 'GARDEN', '虚构花园体验问卷', 'C:\\Users', 'D:\\研究']) {
    assert.ok(!strict.text.includes(forbidden), `strict-local 不应返回 ${forbidden}：${strict.text}`)
  }

  // Agent 通过工具参数声明更宽松的模式一律无效：策略只读配置/服务。
  const widened = await scoreTool.execute({ id: 'P-001', privacyMode: 'summary-cloud', mode: 'local', policy: { mode: 'local' } }, exec)
  assert.match(widened.text, /严格本地|只给状态与计数/)
  assert.ok(!widened.text.includes('P-001'))
  const summaryWidened = await scoreTool.execute({ privacyMode: 'summary-cloud' }, exec)
  assert.ok(!summaryWidened.text.includes('GARDEN'), '工具参数不能把 strict-local 放宽成 summary-cloud')

  // 配置 summary-cloud 后：量表名/波次人数可见，但逐人编号与分数仍阻断。
  const cloud = await loadPluginTools('scale-desk', project, { config: { privacyMode: 'summary-cloud' } })
  const cloudText = (await cloud.tools.get('scale_score').execute({}, cloud.exec)).text
  assert.match(cloudText, /花园示例/)
  assert.match(cloudText, /baseline 1 人/)
  assert.ok(!cloudText.includes('P-001'))
  const cloudSubject = (await cloud.tools.get('scale_score').execute({ id: 'P-001' }, cloud.exec)).text
  assert.match(cloudSubject, /阻断|blocked/)
  assert.ok(!cloudSubject.includes('P-001'))
})

test('P01-A study-ops 材料摘要：材料目录路径与编号不进入 Agent 文本', async () => {
  const project = writeStudyProject()
  const materials = makeDir('rc-07-materials-')
  writeFileSync(path.join(materials, '流程.md'), '访视：基线\n任务：体验问卷\n', 'utf8')
  const { tools, exec } = await loadPluginTools('study-ops', project)

  const scan = await tools.get('materials_scan').execute({ path: materials }, exec)
  assert.match(scan.text, /材料目录：/)
  assert.match(scan.text, /\[本地路径\]/)
  assert.ok(!scan.text.includes(materials), '材料目录绝对路径不应出现在 Agent 返回')
  assert.ok(!scan.text.includes('P-001'))

  const readiness = await tools.get('prep_readiness').execute({ path: materials }, exec)
  assert.match(readiness.text, /可以开始：/)
  assert.ok(!readiness.text.includes(materials), '准备度返回也不带材料目录路径')
})

/* ------------------------------------------------------------------ *
 * P01-B：summary-cloud 白名单；未知字段/超大载荷整体拒绝
 * ------------------------------------------------------------------ */

test('P01-B summary-cloud：只保留白名单字段，未知字段与超大载荷被拒绝', async () => {
  const allowed = agentProjection('analysis_results', {
    runId: '20990101-000000-07a',
    status: 'ok',
    counts: { tables: 1 },
    tables: [{
      key: 'descriptives',
      number: 1,
      title: { zh: '描述统计', en: 'Descriptives' },
      types: { group: 'string', mean: 'number', participantId: 'string' },
      columns: [
        { key: 'group', zh: '分组', en: 'Group' },
        { key: 'mean', zh: '均值', en: 'Mean' },
        { key: 'participantId', zh: '参与者编号', en: 'Participant ID' },
      ],
      rows: [{ group: 'A', mean: 2.5, participantId: 'P-001' }],
      analysisSet: { subset: 'enrolled', subjects: 1, observations: 1 },
    }],
  }, 'summary-cloud')
  assert.equal(allowed.ok, true, JSON.stringify(allowed))
  assert.equal(allowed.projection, 'summary-cloud')
  assert.equal(allowed.tables[0].rows[0].mean, 2.5)
  const allowedText = JSON.stringify(allowed)
  assert.ok(!allowedText.includes('P-001'))
  assert.ok(!allowedText.includes('participantId'))

  const unknown = agentProjection('analysis_results', { status: 'ok', counts: { tables: 1 }, secretField: '未声明字段' }, 'summary-cloud')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'policy_blocked')
  assert.equal(unknown.status, 'blocked')
  assert.ok(unknown.blocked.some(row => row.field === 'secretField'))

  const oversized = agentProjection('analysis_results', {
    status: 'ok',
    counts: { tables: 1 },
    tables: [{ key: 't', rows: [{ blob: 'x'.repeat(40000) }] }],
  }, 'summary-cloud')
  assert.equal(oversized.ok, false)
  assert.equal(oversized.code, 'policy_blocked')
  assert.match(JSON.stringify(oversized.blocked), /超过/)

  // 真实插件工具：配置 privacyMode=summary-cloud 后只返回允许字段，仍无逐人编号。
  const project = writeStudyProject()
  const run = writeFakeRun(project)
  const { tools, exec } = await loadPluginTools('analysis-run', project, { config: { privacyMode: 'summary-cloud' } })
  const summary = JSON.parse((await tools.get('analysis_results').execute({ runId: run.runId }, exec)).text)
  assert.equal(summary.projection, 'summary-cloud')
  assert.equal(summary.tables[0].rows[0].mean, 42.5)
  assert.ok(!JSON.stringify(summary).includes('P-001'), 'summary-cloud 也不能返回逐人编号')
  assert.ok(!JSON.stringify(summary).includes('张伟'), 'summary-cloud 也不能返回姓名列')
})

/* ------------------------------------------------------------------ *
 * P02-A：分享投影去除姓名/邮箱/路径（研究名、列名、表值、图注、错误）
 * ------------------------------------------------------------------ */

test('P02-A 分享投影：研究名/列名/表值/图注/错误里的姓名、邮箱、路径不进入分享包', () => {
  const results = {
    schemaVersion: 1,
    version: 'results/1.0.0',
    runId: '20990101-000000-07b',
    study: {
      id: 'study-07',
      name: '张伟 zhangwei@example.com C:\\Users\\16787\\secret',
      path: 'C:\\Users\\16787\\data',
      dataRoot: 'D:\\data',
      version: 'v1',
      config: { labDir: 'C:\\lab' },
    },
    nodeIds: ['descriptives'],
    analysisSet: { subset: 'enrolled', subjects: 2, observations: 2, excluded: 0 },
    sourceHash: 'a'.repeat(64),
    tables: [{
      key: 'descriptives',
      number: 1,
      title: { zh: '描述 C:\\Users\\16787\\x', en: 'Descriptives' },
      nodeId: 'descriptives',
      analysisSet: { subset: 'enrolled', subjects: 2, observations: 2 },
      types: { participantId: 'string', 姓名: 'string', group: 'string', note: 'string', mean: 'number' },
      columns: [
        { key: 'participantId', zh: '参与者编号', en: 'Participant ID' },
        { key: '姓名', zh: '姓名', en: 'Name' },
        { key: 'group', zh: '分组', en: 'Group' },
        { key: 'note', zh: '备注', en: 'Note' },
        { key: 'mean', zh: '均值', en: 'Mean' },
        { key: 'mystery', zh: '未知列', en: 'Mystery' },
      ],
      rows: [{
        participantId: 'P-001',
        姓名: '张伟',
        group: 'A',
        note: '联系 zhangwei@example.com 或 C:\\Users\\16787\\secret',
        mean: 42.5,
        mystery: 'C:\\secret',
      }],
      notes: ['数据在 C:\\Users\\16787\\secret.csv'],
    }],
    figures: [{
      key: 'model-estimates',
      title: '模型 张伟 zhangwei@example.com C:\\Users\\16787\\x',
      svg: 'figures/model-estimates.svg',
      width: 640,
      analysisSetId: 'aset-1',
    }],
    warnings: ['读取 C:\\Users\\16787\\a.csv 失败，联系张伟'],
    hash: 'b'.repeat(64),
  }
  const share = shareProjection(results, {
    meta: {
      status: 'ok',
      study: results.study,
      nodes: {
        regression: { status: 'failed', reason: '打开 C:\\Users\\16787\\secret.csv 失败，联系张伟' },
      },
      warnings: results.warnings,
    },
  })
  const text = JSON.stringify(share)
  for (const forbidden of ['张伟', 'zhangwei@example.com', 'C:\\Users', 'D:\\data', 'C:\\lab', 'P-001', 'participantId', 'secret']) {
    assert.ok(!text.includes(forbidden), `分享包不应包含 ${forbidden}：${text.slice(0, 800)}`)
  }
  // study 只保留获准字段，路径/dataRoot/config 已去掉；显示名整段隐藏而不是只替换其中一段。
  assert.deepEqual(Object.keys(share.study).sort(), ['id', 'name', 'version'])
  assert.equal(share.study.name, '[显示名已隐藏]')
  assert.equal(share.study.path, undefined)
  assert.equal(share.study.dataRoot, undefined)
  assert.equal(share.study.config, undefined)
  // 表按 schema 过滤：编号/姓名/备注/未知列去掉，分组与均值保留。
  assert.deepEqual(share.tables[0].columns.map(column => column.key).sort(), ['group', 'mean'])
  assert.equal(share.tables[0].rows[0].group, 'A')
  assert.equal(share.tables[0].rows[0].mean, 42.5)
  assert.equal(share.tables[0].rows[0].note, undefined)
  assert.equal(share.tables[0].columns.some(column => column.key === 'mystery'), false, '未知列默认不保留')
  // 图注与正文/错误文字同策略。
  assert.equal(share.figures[0].title, '[图注已隐藏]')
  assert.equal(share.meta.nodes.regression.reason, '[文本已隐藏]')
  assert.ok(share.redactions.length > 0)
  assert.ok(share.notes.includes(SHARE_NOTICE))
  // 本机完整对象仍是原值，分享投影不修改输入，便于本地追溯。
  assert.equal(results.study.path, 'C:\\Users\\16787\\data')
  assert.equal(results.tables[0].rows[0].participantId, 'P-001')
})

/* ------------------------------------------------------------------ *
 * P02-B：按列 schema 过滤，不靠"值像数字"误判
 * ------------------------------------------------------------------ */

test('P02-B 分享表按 schema：ID001 与普通分类保留，逐人编号/姓名列过滤', () => {
  const results = {
    study: { id: 'study-07', name: '合成研究' },
    tables: [{
      key: 'mixed',
      number: 1,
      title: { zh: '混合表', en: 'Mixed' },
      types: { participantId: 'string', group: 'string', score: 'number', 姓名: 'string' },
      columns: [
        { key: 'participantId', zh: '参与者编号', en: 'Participant ID' },
        { key: 'group', zh: '分组', en: 'Group' },
        { key: 'score', zh: '得分', en: 'Score' },
        { key: '姓名', zh: '姓名', en: 'Name' },
      ],
      rows: [
        { participantId: 'P-007', group: 'ID001', score: 12.5, 姓名: '李四' },
        { participantId: 'P-008', group: '123', score: 7, 姓名: '王五' },
      ],
    }],
  }
  const share = shareProjection(results)
  assert.deepEqual(share.tables[0].columns.map(column => column.key).sort(), ['group', 'score'])
  assert.deepEqual(share.tables[0].rows.map(row => row.group), ['ID001', '123'], '分类值不应因为看起来像编号/数字被删')
  assert.deepEqual(share.tables[0].rows.map(row => row.score), [12.5, 7])
  const text = JSON.stringify(share)
  assert.ok(!text.includes('P-007'))
  assert.ok(!text.includes('李四'))
  // 值是数字或编号都不是过滤理由；列角色才是。
  assert.ok(text.includes('ID001'))
})

/* ------------------------------------------------------------------ *
 * P02-A 真实导出路径：HTML/JSON 标题与表值同策略，manifest 只含相对路径
 * ------------------------------------------------------------------ */

test('P02-A 真实导出：report.html/results.json 与 manifest 同策略，不带姓名/邮箱/路径', async () => {
  const project = writeStudyProject({ name: '张伟 zhangwei@example.com C:\\Users\\16787\\secret' })
  const run = writeFakeRun(project, { studyName: '张伟 zhangwei@example.com C:\\Users\\16787\\secret' })
  const { tools, exec } = await loadPluginTools('analysis-run', project)

  const tool = tools.get('analysis_export')
  assert.ok(tool, '应注册 analysis_export')
  const output = JSON.parse((await tool.execute({ runId: run.runId }, exec)).text)
  assert.equal(output.projection, 'strict-local')
  assert.ok(!JSON.stringify(output).includes('C:\\Users'), '导出工具的返回也不带本地路径')
  assert.ok(output.counts.artifacts >= 2)

  const presentation = path.join(run.runDir, 'presentation', '1')
  const html = readFileSync(path.join(presentation, 'report.html'), 'utf8')
  const resultsJson = readFileSync(path.join(presentation, 'results.json'), 'utf8')
  const manifest = readJson(path.join(presentation, 'manifest.json'))
  for (const forbidden of ['张伟', 'zhangwei@example.com', 'C:\\Users', 'D:\\研究', 'P-001', 'participantId', '姓名']) {
    assert.ok(!html.includes(forbidden), `report.html 不应包含 ${forbidden}`)
    assert.ok(!resultsJson.includes(forbidden), `results.json 不应包含 ${forbidden}`)
  }
  const share = JSON.parse(resultsJson)
  assert.equal(share.study.name, '[显示名已隐藏]')
  assert.equal(share.study.path, undefined)
  assert.deepEqual(share.tables[0].columns.map(column => column.key).sort(), ['group', 'mean'])
  assert.ok(Array.isArray(share.redactions))
  assert.equal(manifest.artifacts.every(item => /^(?:figures\/)?[^/\\:]+\.(?:html|json|svg|png|pdf|docx|xlsx)$/.test(item.relativePath)), true, JSON.stringify(manifest.artifacts))
  const manifestText = JSON.stringify(manifest)
  assert.ok(!manifestText.includes('C:\\Users'))
  assert.ok(!manifestText.includes('D:\\研究'))
  // 分享 HTML 仍然自包含、可渲染。
  assert.match(html, /class="three-line"/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.ok(existsSync(path.join(presentation, 'results.json')))
})

/* ------------------------------------------------------------------ *
 * P03-A：声明当前通用会话不可强制严格本地，不伪造"已阻止"
 * ------------------------------------------------------------------ */

test('P03-A 通用会话不可强制严格本地：返回 unenforceable，旁路工具不被冒充为已阻断', async () => {
  // 没有工具清单：只能说明"无法证明"，不能宣称已强制执行。
  const unknown = evaluateSessionEnforceability()
  assert.equal(unknown.enforced, false)
  assert.equal(unknown.unenforceable, 'unknown')
  assert.match(unknown.reason, /无法证明|不能/)

  const bypasses = evaluateSessionEnforceability({ sessionTools: ['read', 'pwsh', 'browser_navigate', 'mcp__github__read_file'] })
  assert.equal(bypasses.enforced, false)
  assert.equal(bypasses.unenforceable, true)
  assert.ok(bypasses.bypasses.some(row => row.tool === 'read'))
  assert.ok(bypasses.bypasses.some(row => row.tool === 'pwsh'))
  assert.ok(bypasses.bypasses.some(row => row.tool === 'browser_navigate'))
  assert.ok(bypasses.bypasses.some(row => row.tool === 'mcp__github__read_file'))
  assert.deepEqual(bypasses.notBlocked.sort(), ['browser_navigate', 'mcp__github__read_file', 'pwsh', 'read'].sort())
  const withAttachment = evaluateSessionEnforceability({ sessionTools: ['analysis_results'], attachments: true })
  assert.equal(withAttachment.enforced, false)
  assert.equal(withAttachment.unenforceable, true)
  assert.ok(withAttachment.bypasses.some(row => row.tool === 'attachments'))

  const pure = agentProjection('analysis_results', { runId: '20990101-000000-07a', status: 'ok', counts: { tables: 1 } }, 'strict-local', {
    sessionTools: ['read', 'pwsh', 'browser_navigate', 'mcp__github__read_file'],
  })
  assert.equal(pure.enforceability.unenforceable, true)
  // blocked 是"字段被投影阻断"，不是"read/pwsh 被宿主阻断"。
  assert.ok(!pure.blocked.some(row => /^(?:read|pwsh|browser)/.test(row.field)))

  // 真实工具路径：privacy 服务声明旁路后，工具返回必须带同一边界，而不是只说"已阻止"。
  const project = writeStudyProject()
  const run = writeFakeRun(project)
  const { tools, exec } = await loadPluginTools('analysis-run', project, {
    privacyService: { mode: 'strict-local', tools: ['read', 'pwsh', 'browser_navigate', 'mcp__github__read_file'] },
  })
  const result = JSON.parse((await tools.get('analysis_results').execute({ runId: run.runId }, exec)).text)
  assert.equal(result.enforceability.enforced, false)
  assert.equal(result.enforceability.unenforceable, true)
  assert.ok(result.enforceability.bypasses.some(row => row.tool === 'read'))
  assert.ok(result.enforceability.notBlocked.includes('read'))
  assert.ok(!result.blocked.some(row => /^(?:read|pwsh|browser)/.test(row.field)))
})

/* ------------------------------------------------------------------ *
 * P03-B / P04 边界：不伪造真实请求捕获与断网全链路
 * ------------------------------------------------------------------ */

test('P03-B/P04 边界：投影模块无联网依赖，分享 HTML 自包含；未捕获真实模型请求', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '../privacy-projection.mjs'), 'utf8')
  assert.doesNotMatch(source, /\bfetch\s*\(|node:http|node:https|node:net|from\s+['"]https?:/)
  const results = {
    study: { id: 'study-07', name: '合成研究' },
    runId: '20990101-000000-07c',
    version: 'results/1.0.0',
    analysisSet: { subset: 'enrolled', subjects: 2, observations: 2, excluded: 0 },
    tables: [{
      key: 'descriptives', number: 1, title: { zh: '描述统计', en: 'Descriptives' },
      types: { group: 'string', mean: 'number' },
      columns: [{ key: 'group', zh: '分组', en: 'Group' }, { key: 'mean', zh: '均值', en: 'Mean' }],
      rows: [{ group: 'A', mean: 2.5 }],
    }],
  }
  const share = shareProjection(results, { meta: { status: 'ok', study: results.study, nodes: {}, warnings: [] } })
  const html = renderHtmlReport({ meta: share.meta, results: share })
  assert.doesNotMatch(html, /https?:\/\//)
  assert.match(html, /<!doctype html>/)
  // 明确边界：本测试只证明静态无网络依赖与本地模板可渲染；
  // P04-A 需要宿主侧记录真实请求载荷，P03-B 需要在断网环境运行本地模型/模板全链路。
  // 这里不抓真实请求、不伪造"已捕获"，也不宣称这两项已满足。
  assert.ok(share.notes.includes(SHARE_NOTICE))
})

/* ------------------------------------------------------------------ *
 * 策略读取与错误投影的补充断言
 * ------------------------------------------------------------------ */

test('策略读取：privacy 服务优先，缺省 strict-local；错误返回不带路径/编号/栈', () => {
  const fakeCtx = { get: name => name === 'privacy' ? { mode: 'summary-cloud' } : undefined }
  assert.equal(resolvePrivacyPolicy({ ctx: fakeCtx, config: { privacyMode: 'local' } }).mode, 'summary-cloud')
  assert.equal(resolvePrivacyPolicy({ config: { privacyMode: 'local' } }).mode, 'local')
  assert.equal(resolvePrivacyPolicy({ config: {} }).mode, 'strict-local')
  assert.equal(resolvePrivacyPolicy({ config: { privacyMode: 'not-a-mode' } }).mode, 'strict-local')

  const error = Object.assign(new Error('读取 C:\\Users\\16787\\secret.csv 时 P-001 失败'), { code: 'source_unreadable', details: { record: { id: 'P-001' } }, stack: 'C:\\Users\\16787\\x.js:1' })
  const safe = sanitizeError(error)
  assert.equal(safe.ok, false)
  assert.equal(safe.code, 'source_unreadable')
  assert.ok(!safe.message.includes('C:\\Users'))
  assert.ok(!safe.message.includes('P-001'))
  assert.equal(safe.stack, null)
  assert.equal(safe.detailsOmitted, true)
  assert.equal(JSON.stringify(safe).includes('C:\\Users'), false)
})
