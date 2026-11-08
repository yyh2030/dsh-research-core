/**
 * 07 基础：结果对象、格式化、三线表与报告模板。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LABELS, labelFor, formatNumber, formatP, formatCI, formatValue, redact,
  buildResults, renderTableHtml, reportSections, renderHtmlReport, artifactManifest,
} from '../results.mjs'

const meta = {
  runId: '20261107-120000-abcd',
  study: { id: 's1', name: '合成研究' },
  status: 'ok',
  subjects: 6,
  observations: 6,
  excludedIds: ['P-004'],
  warnings: ['regression: 方差很小'],
  dataset: { hash: 'a'.repeat(64), stats: { subset: 'enrolled', rows: 6 } },
  source: { sha256: 'b'.repeat(64) },
  nodes: {
    prepare: { status: 'executed' },
    descriptives: { status: 'executed' },
    regression: { status: 'executed', result: { rank: 4, designColumns: 4, dfResidual: 2, conditionNumber: 12.5, sumsOfSquares: 3, formula: 'score ~ C(group) + cond' } },
    mixed: { status: 'not_run', reason: 'not selected in plan' },
    paired: { status: 'failed', reason: 'paired differences need nonzero variance' },
  },
}

const tables = [
  {
    key: 'descriptives', nodeId: 'descriptives',
    columns: ['group', 'subjects', 'mean', 'sd', 'se', 'ciLow', 'ciHigh', 'missing'],
    rows: [
      { group: 'A', subjects: 3, mean: 2.5, sd: 1.2909944487358056, se: 0.7453559924999299, ciLow: -0.707, ciHigh: 5.707, missing: 0 },
      { group: 'B', subjects: 3, mean: 9, sd: 2.6457513110645907, se: 1.5275252316519465, ciLow: 2.427, ciHigh: 15.573, missing: 0 },
    ],
    notes: ['CI 为 95% t 区间；分母为独立参与者。'],
  },
  {
    key: 'coefficients', nodeId: 'regression',
    columns: ['term', 'estimate', 'se', 'ciLow', 'ciHigh', 'p'],
    rows: [{ term: 'cond: Y', estimate: 5.5, se: 1.2, ciLow: 2.1, ciHigh: 8.9, p: 0.0004 }],
  },
]

test('格式化：p 值、零与负零、缺失、CI', () => {
  assert.equal(formatP(0.0004), '< .001')
  assert.equal(formatP(0.0342), '.034')
  assert.equal(formatP(1), '> .999')
  assert.equal(formatP(null), '—')
  assert.equal(formatNumber(0), '0')
  assert.equal(formatNumber(-0), '0')
  assert.equal(formatNumber(1e-12), '0')
  assert.equal(formatNumber(2.345), '2.35')
  assert.equal(formatNumber(Number.NaN), '—')
  assert.equal(formatNumber(null), '—')
  assert.equal(formatCI(1.234, 5.678), '[1.23, 5.68]')
  assert.equal(formatValue('percent', 50), '50.0%')
  assert.equal(formatValue('mean', 2.5, { decimals: 3 }), '2.500')
})

test('标签：已知项双语，未知项保留原名而不是猜翻译', () => {
  assert.deepEqual(labelFor('mean'), { zh: '均值', en: 'Mean', known: true })
  const unknown = labelFor('my_custom_score')
  assert.equal(unknown.zh, 'my_custom_score')
  assert.equal(unknown.known, false)
  assert.equal(LABELS.p.zh, 'p')
})

test('结果对象：完整精度保留，行带 runId/nodeId/分析集/来源版本', () => {
  const results = buildResults({ run: { runId: meta.runId }, meta, tables })
  assert.equal(results.runId, meta.runId)
  assert.equal(results.sourceHash, 'a'.repeat(64))
  assert.deepEqual(results.analysisSet, { subset: 'enrolled', subjects: 6, observations: 6, excluded: 1 })
  assert.equal(results.tables.length, 2)
  // 完整精度保留为数字，格式化只在渲染时发生。
  const mean = results.tables[0].rows[0].mean
  assert.equal(typeof mean, 'number')
  assert.equal(mean, 2.5)
  assert.equal(results.tables[0].columns.find(column => column.key === 'mean').zh, '均值')
  assert.equal(results.tables[1].nodeId, 'regression')
  assert.equal(results.tables[0].sourceHash, 'a'.repeat(64))
})

test('三线表：双语表头、数值右对齐、表号与注释、脱敏', () => {
  const results = buildResults({ run: { runId: meta.runId }, meta, tables })
  const html = renderTableHtml(results.tables[0])
  assert.match(html, /class="three-line"/)
  assert.match(html, /<span class="zh">均值<\/span><span class="en">Mean<\/span>/)
  assert.match(html, /class="num"/)
  assert.match(html, /表 1/)
  assert.match(html, /分析集：enrolled · n=6 · 观测=6/)
  assert.match(html, /<th class="num" scope="col"><span class="zh">均值<\/span>/)
  assert.match(html, /<p class="note">/)
  // 不应出现绝对本地路径（占位符会被 HTML 转义）。
  const withPath = renderTableHtml({ ...results.tables[0], notes: ['数据在 D:\\研究\\私密\\data.csv'] })
  assert.doesNotMatch(withPath, /D:\\研究/)
  assert.match(withPath, /本地路径/)
})

test('报告段落：覆盖截止、输入版本、样本流、方法、结果、诊断、局限', () => {
  const results = buildResults({ run: { runId: meta.runId }, meta, tables })
  const sections = reportSections({ meta, results, today: '2026-11-07' })
  const keys = sections.map(section => section.key)
  assert.deepEqual(keys, ['scope', 'inputs', 'flow', 'qc', 'methods', 'results', 'diagnostics', 'limits'])
  const qc = sections.find(section => section.key === 'qc').body
  assert.match(qc, /排除 1 人/)
  assert.match(qc, /警告 1 条/)
  assert.match(qc, /方差很小/)
  const diagnostics = sections.find(section => section.key === 'diagnostics').body
  assert.match(diagnostics, /秩 4\/4/)
  assert.match(diagnostics, /条件数 12\.5/)
  const limits = sections.find(section => section.key === 'limits').body
  assert.match(limits, /混合模型.*not selected in plan|mixed.*not selected/s)
  assert.match(limits, /paired/)
  assert.match(sections.find(section => section.key === 'inputs').body, /a{16}/)
})

test('HTML 报告：自包含、无外链、脱敏、含三线表', () => {
  const results = buildResults({ run: { runId: meta.runId }, meta, tables })
  const html = renderHtmlReport({ meta: { ...meta, study: { name: 'D:\\私密\\研究' } }, results, today: '2026-11-07' })
  assert.match(html, /<!doctype html>/)
  assert.match(html, /<style>/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.doesNotMatch(html, /<script/i)
  assert.match(html, /本地路径/)
  assert.match(html, /class="three-line"/)
  assert.match(html, /table.three-line thead th\.num\{text-align:center\}/)
  assert.match(html, /table.three-line td\.num\{text-align:center/)
  assert.match(html, /表 2/)
})

test('产物清单：媒体类型、hash、runId、渲染环境', () => {
  const results = buildResults({ run: { runId: meta.runId }, meta, tables })
  const manifest = artifactManifest({ results, artifacts: [{ mediaType: 'text/html', relativePath: 'report.html', sha256: 'c'.repeat(64) }] })
  assert.equal(manifest.runId, meta.runId)
  assert.equal(manifest.sourceHash, 'a'.repeat(64))
  assert.equal(manifest.artifacts.length, 1)
  assert.equal(manifest.artifacts[0].mediaType, 'text/html')
  assert.match(manifest.renderer, /node\//)
  assert.equal(manifest.presentationRevision, 1)
})

test('REP-06 深色/窄屏/键盘：报告带媒体查询、焦点样式与可横向滚动的表容器', () => {
  const results = buildResults({ run: { runId: meta.runId }, meta, tables })
  const html = renderHtmlReport({ meta, results, today: '2026-11-07' })
  assert.match(html, /@media \(prefers-color-scheme:dark\)/)
  assert.match(html, /@media \(max-width:720px\)/)
  assert.match(html, /:focus-visible\{outline:2px solid/)
  assert.match(html, /class="table-scroll"/)
  assert.match(html, /@media print/)
  // 打印分页：A4、表头跨页重复、行不截断
  assert.match(html, /@page\{size:A4/)
  assert.match(html, /table.three-line thead\{display:table-header-group\}/)
  assert.match(html, /table.three-line tr\{break-inside:avoid\}/)
  // 深色模式不应把文字与背景都设成同一颜色
  const darkBlock = html.slice(html.indexOf('@media (prefers-color-scheme:dark)'))
  assert.match(darkBlock, /--ink:#e8eaed/)
  assert.match(darkBlock, /background:#17191c/)
})

test('REP-06 零行与上百行表：都能渲染，不崩溃、不截断', () => {  const empty = renderTableHtml({ key: 't', number: 1, title: { zh: '空表', en: 'Empty' }, columns: [{ key: 'mean', zh: '均值', en: 'Mean' }], rows: [], notes: [], analysisSet: { subset: 'enrolled', subjects: 0, observations: 0 } })
  assert.match(empty, /class="three-line"/)
  assert.match(empty, /n=0/)
  const rows = Array.from({ length: 120 }, (_, index) => ({ group: `组 ${index + 1}`, subjects: 2, mean: index }))
  const many = renderTableHtml({ key: 't', number: 2, title: { zh: '大表', en: 'Large' }, columns: ['group', 'subjects', 'mean'].map(key => ({ key, zh: key, en: key })), rows, notes: [], analysisSet: { subset: 'enrolled', subjects: 240, observations: 240 } })
  assert.equal((many.match(/<tr>/g) || []).length, 121, '表头 + 120 行都要输出')
  assert.match(many, /组 120/)
  assert.equal((many.match(/<td class="num">/g) || []).length, 240, '数值列右对齐')
})
