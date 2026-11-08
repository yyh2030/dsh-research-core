/**
 * 03 阶段回归：图表、Office 三线表与报告保真（R01—R04）。
 * 使用临时合成 CSV/results；Office 用 python-docx/openpyxl 读回单元格值。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { distributionChart, pointRangeChart } from '../charts.mjs'
import { tableFromGrid, buildResults } from '../results.mjs'

const PYTHON = process.env.DSH_ANALYSIS_PYTHON || process.env.DSH_PYTHON
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const ENGINE = 'D:/dsh-plugins/analysis-run/engine.py'
const OFFICE = 'D:/dsh-plugins/analysis-run/office_export.py'

function python(args, options = {}) {
  const result = spawnSync(PYTHON, ['-X', 'utf8', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') }
}

function engine(request) {
  const result = python([ENGINE, '--request-json', JSON.stringify(request)])
  const marker = result.stdout.lastIndexOf('===JSON===')
  if (marker < 0) throw new Error('引擎没有返回结果：' + result.stderr.slice(-500))
  return JSON.parse(result.stdout.slice(marker + 10))
}

function fixture(rows, header) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-r03-'))
  const csv = path.join(root, 'data.csv')
  writeFileSync(csv, [header.join(','), ...rows].join('\n') + '\n', 'utf8')
  return { root, csv }
}

function run(csv, plan, extra = {}) {
  const outputDir = path.join(path.dirname(csv), extra.name || 'run')
  mkdirSync(outputDir, { recursive: true })
  return engine({ action: 'run', study: { id: 'synthetic', name: 'synthetic' }, plan: { dataPath: csv, idColumn: 'id', outcome: 'y', layout: 'wide', groupColumns: [], covariates: [], pairedColumns: [], gate: { minSubjects: 2 }, ...plan }, outputDir, exclusions: extra.exclusions || [] })
}

test('R01-A 显示精度：.42/−.42/.49/.004/0/−0/缺失与 p 规则', () => {
  const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('oe', r'${OFFICE}')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
cases = [('mean', 0.42), ('mean', -0.42), ('ciHigh', 0.49), ('estimate', 0.004), ('estimate', 0.0), ('estimate', -0.0), ('mean', None), ('p', 0.0004), ('df', 37.5), ('subjects', 40), ('participantId', '001')]
print(json.dumps([[key, module.display(key, value)] for key, value in cases]))
`
  const result = python(['-c', script])
  assert.equal(result.status, 0, result.stderr.slice(-400))
  const rows = JSON.parse(result.stdout)
  const shown = rows.map(row => row[1])
  assert.deepEqual(shown, ['0.42', '-0.42', '0.49', '0.00', '0.00', '0.00', '—', '< .001', '37.50', '40', '001'])
})

test('R01-B Office 读回：DOCX 文本与 XLSX 数值/格式都保真', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-r03-office-'))
  const results = {
    schemaVersion: 1,
    analysisSet: { subset: 'enrolled', subjects: 4, observations: 4 },
    tables: [{
      key: 'regression', number: 1,
      title: { zh: '回归', en: 'Regression' },
      columns: [
        { key: 'term', zh: '项', en: 'Term' },
        { key: 'estimate', zh: '估计', en: 'Estimate' },
        { key: 'p', zh: 'p', en: 'p' },
        { key: 'participantId', zh: '编号', en: 'ID' },
      ],
      rows: [
        { term: 'Intercept', estimate: 0.42, p: 0.0004, participantId: '001' },
        { term: 'slope', estimate: -0.42, p: 0.49, participantId: '010' },
      ],
      analysisSet: { subset: 'enrolled', subjects: 4, observations: 4 },
      sourceHash: 'abc123',
    }],
  }
  const resultsPath = path.join(root, 'results.json')
  writeFileSync(resultsPath, JSON.stringify(results))
  const output = python([OFFICE, '--results', resultsPath, '--out', root])
  const marker = output.stdout.lastIndexOf('===JSON===')
  assert.ok(marker >= 0, output.stderr)
  const payload = JSON.parse(output.stdout.slice(marker + 10))
  assert.equal(payload.ok, true, JSON.stringify(payload))

  const readScript = `
import json, sys
from docx import Document
from openpyxl import load_workbook
doc = Document(sys.argv[1])
cell_texts = [cell.text for table in doc.tables for row in table.rows for cell in row.cells]
book = load_workbook(sys.argv[2])
sheet = book[book.sheetnames[0]]
values = []
for row in sheet.iter_rows(min_row=6, max_row=7, values_only=False):
    values.append([[cell.value, cell.number_format] for cell in row])
print(json.dumps({'docx': cell_texts, 'xlsx': values}, ensure_ascii=False))
`
  const read = python(['-c', readScript, payload.docx, payload.xlsx])
  assert.equal(read.status, 0, read.stderr.slice(-400))
  const readBack = JSON.parse(read.stdout)
  assert.ok(readBack.docx.some(text => text.trim() === '0.42'), 'DOCX 应保留 0.42：' + JSON.stringify(readBack.docx))
  assert.ok(readBack.docx.some(text => text.trim() === '001'), 'DOCX 应保留编号 001')
  const [[estimateCell, pCell]] = [readBack.xlsx[0].slice(1, 4)]
  assert.equal(estimateCell[0], 0.42, 'XLSX 估计值应是数值 0.42')
  assert.equal(estimateCell[1], '0.00', 'XLSX 估计值 number_format')
  assert.equal(pCell[0], '< .001', 'p 显示为文本阈值')
  assert.equal(readBack.xlsx[0][3][0], '001', 'XLSX 编号保持字符串')
})

test('R02-A 分布图只使用模型分析集：排除者与空白不进图', () => {
  const { csv } = fixture(['a,1', 'b,2', 'excluded,1000', 'blank,'], ['id', 'y'])
  const result = run(csv, { analyses: ['descriptives'] }, { exclusions: [{ id: 'excluded' }], name: 'r02a' })
  assert.equal(result.meta.nodes.descriptives.status, 'executed', result.meta.nodes.descriptives.reason)
  const distribution = result.meta.charts.distribution
  assert.ok(distribution && !distribution.error, JSON.stringify(distribution))
  const values = distribution.groups.flatMap(group => group.values)
  assert.deepEqual(values, [1, 2], '只应包含分析集内的 1、2')
  assert.equal(distribution.n, 2)
})

test('R02-B 变换后的分析集进入图表，原始数据不被改', () => {
  const { csv } = fixture(['a,1', 'b,2', 'c,3'], ['id', 'y'])
  const result = run(csv, { analyses: ['descriptives'], transforms: [{ op: 'center', column: 'y' }] }, { name: 'r02b' })
  assert.equal(result.meta.nodes.descriptives.status, 'executed', result.meta.nodes.descriptives.reason)
  const values = result.meta.charts.distribution.groups.flatMap(group => group.values)
  assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0)) < 1e-9, '中心化后应均值为 0：' + JSON.stringify(values))
  const raw = readFileSync(csv, 'utf8')
  assert.match(raw, /a,1/)
  assert.doesNotMatch(raw, /-1\.0/)
})

test('R03-A 每张表用模型实际分析集；编号 001 在表格类型里保持字符串', () => {
  const rows = []
  for (let index = 1; index <= 40; index += 1) rows.push(`${index === 1 ? '001' : index === 2 ? '010' : index},${index},${index <= 4 ? index : ''}`)
  const { csv } = fixture(rows, ['id', 'y', 'z'])
  const result = run(csv, { analyses: ['correlation'], gate: { minSubjects: 2 }, correlation: { columns: ['z', 'y'] } }, { name: 'r03a' })
  assert.equal(result.meta.nodes.correlation.status, 'executed', result.meta.nodes.correlation.reason)
  const table = result.meta.tables.find(item => item.key === 'correlation')
  assert.equal(table.analysisSet.subjects, 4, '表格分析集应是 4 人，不是 40')
  assert.equal(table.types.scope, 'string', '分组/文本列必须声明为字符串')
  assert.equal(table.types.r, 'number', '统计量列必须声明为数值')

  const grid = tableFromGrid({ key: 'idcheck', columns: ['participantId', 'score'], rows: [['001', '0.42']], types: { participantId: 'string', score: 'number' } })
  assert.equal(grid.rows[0].participantId, '001', '编号 001 保持字符串')
  assert.equal(grid.rows[0].score, 0.42, '数值列仍转数字')
  const built = buildResults({ run: { runId: 'r1' }, meta: { subjects: 40, observations: 40 }, tables: [{ ...grid, analysisSet: table.analysisSet }] })
  assert.equal(built.tables[0].analysisSet.subjects, 4)
  assert.equal(built.tables[0].types.participantId, 'string')
})

test('R03-B 两因素分组图使用组合标签，不把计数列当分组', () => {
  const rows = []
  for (let index = 1; index <= 20; index += 1) rows.push(`${index},${index},${index % 2 ? 'MS' : 'DP'},${index % 3 ? 'EFT' : 'ERT'}`)
  const { csv } = fixture(rows, ['id', 'y', 'salience', 'intervention'])
  const result = run(csv, { analyses: ['descriptives'], groupColumns: ['salience', 'intervention'] }, { name: 'r03b' })
  assert.equal(result.meta.nodes.descriptives.status, 'executed', result.meta.nodes.descriptives.reason)
  const labels = result.meta.charts.distribution.groups.map(group => group.label)
  assert.ok(labels.every(label => label.includes(' × ')), JSON.stringify(labels))
  assert.ok(labels.some(label => label === 'MS × EFT'), JSON.stringify(labels))
})

test('R04-A 箱线须画到围栏内真实极值，离群点保留', () => {
  const chart = distributionChart({ title: 'fence', groups: [{ label: 'A', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20] }] })
  assert.equal(chart.geometry[0].high, 10)
  assert.equal(chart.geometry[0].low, 1)
  const second = distributionChart({ title: 'fence2', groups: [{ label: 'B', values: [1, 2, 3, 4, 100] }] })
  assert.equal(second.geometry[0].high, 4)
  assert.match(second.svg, /<circle/, '离群点仍应画出')
  const range = pointRangeChart({ title: 'range', rows: [{ label: 'A', estimate: 0.42, low: 0.12, high: 0.49 }] })
  assert.ok(range.svg.includes('0.42') || range.svg.includes('0.4'), '区间图应保留真实数值')
})
