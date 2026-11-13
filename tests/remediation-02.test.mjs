/**
 * 02 阶段回归：统计输入、节点分析集与推断正确性（S01—S06）。
 * 直接调用引擎 CLI，使用临时合成 CSV；表内容从 runDir/tables 读回，期望值用手算或独立公式。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const PYTHON = process.env.DSH_ANALYSIS_PYTHON || process.env.DSH_PYTHON
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const ENGINE = 'D:/dsh-plugins/analysis-run/engine.py'

function runEngine(request) {
  const result = spawnSync(PYTHON, ['-X', 'utf8', ENGINE, '--request-json', JSON.stringify(request)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const marker = String(result.stdout || '').lastIndexOf('===JSON===')
  if (marker < 0) throw new Error('引擎没有返回结果：' + String(result.stderr || '').slice(-500))
  return JSON.parse(result.stdout.slice(marker + 10))
}

function fixture(rows, header) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-r02-'))
  const csv = path.join(root, 'data.csv')
  writeFileSync(csv, [header.join(','), ...rows].join('\n') + '\n', 'utf8')
  return { root, csv }
}

function run(csv, plan, name = 'run') {
  const outputDir = path.join(path.dirname(csv), name)
  mkdirSync(outputDir, { recursive: true })
  return runEngine({ action: 'run', study: { id: 'synthetic', name: 'synthetic' }, plan: { dataPath: csv, idColumn: 'id', outcome: 'y', layout: 'wide', groupColumns: [], covariates: [], pairedColumns: [], gate: { minSubjects: 30 }, ...plan }, outputDir, exclusions: [] })
}

function preview(csv, plan) {
  return runEngine({ action: 'preview', study: { id: 'synthetic', name: 'synthetic' }, plan: { dataPath: csv, idColumn: 'id', outcome: 'y', layout: 'wide', groupColumns: [], covariates: [], pairedColumns: [], gate: { minSubjects: 30 }, ...plan } })
}

/** 读回表 CSV：返回 { header, rows }，每行是字符串数组（支持引号内逗号）。 */
function parseLine(line) {
  const out = []; let value = ''; let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]
    if (ch === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1 } else quoted = !quoted
    } else if (ch === ',' && !quoted) { out.push(value); value = '' } else value += ch
  }
  out.push(value)
  return out
}

function table(result, key) {
  const text = readFileSync(path.join(result.runDir, 'tables', `${key}.csv`), 'utf8').replace(/^\uFEFF/, '').trim()
  const lines = text.split(/\r?\n/)
  return { header: parseLine(lines[0]), rows: lines.slice(1).map(line => parseLine(line)) }
}
const column = (tableValue, name) => tableValue.header.indexOf(name)
const cell = (tableValue, row, name) => row[column(tableValue, name)]

test('S01-A 检验列只有 4 个有效值时，门槛按 4 判定而不是总行数', () => {
  const rows = []
  for (let index = 1; index <= 40; index += 1) rows.push(`${index},${index % 5},${index <= 4 ? index : ''}`)
  const { csv } = fixture(rows, ['id', 'y', 'z'])
  const plan = { analyses: ['correlation'], correlation: { columns: ['z', 'y'] } }
  const result = run(csv, plan)
  assert.equal(result.meta.nodes.correlation.status, 'not_run')
  assert.equal(result.meta.nodes.correlation.eligibleSubjects, 4)
  assert.match(result.meta.nodes.correlation.reason, /4 eligible participants < gate 30/)
  const info = preview(csv, plan)
  assert.equal(info.modules.correlation.eligible, 4)
})

test('S01-B 分组相关按各 scope 独立判定门槛', () => {
  const rows = []
  for (let index = 1; index <= 40; index += 1) rows.push(`${index},${index},${index},${index <= 4 ? 'B' : 'A'}`)
  const { csv } = fixture(rows, ['id', 'x', 'y', 'g'])
  const plan = { analyses: ['correlation'], correlation: { columns: ['x', 'y'], by: ['g'] } }
  const result = run(csv, plan)
  assert.equal(result.meta.nodes.correlation.status, 'executed')
  assert.ok(result.meta.tables.some(item => item.key === 'correlation'))
  const skipped = result.meta.nodes.correlation.result.skippedScopes
  assert.ok(skipped.some(row => row.scope === 'B' && row.eligible === 4), JSON.stringify(skipped))
  const out = table(result, 'correlation')
  assert.equal(out.rows.length, 2, '整体与 A 组各一行，B 组被跳过')
})

test('S02-A Spearman 覆盖字符串数字、负数、小数与并列值', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  const rows = values.map((value, index) => `${index + 1},${value},${String(value)},-${value / 2}`)
  const { csv } = fixture(rows, ['id', 'y', 'z', 'w'])
  const plan = { analyses: ['correlation'], gate: { minSubjects: 5 }, correlation: { columns: ['y', 'z', 'w'], method: 'spearman' } }
  const result = run(csv, plan)
  assert.equal(result.meta.nodes.correlation.status, 'executed')
  const out = table(result, 'correlation')
  const pair = out.rows.find(row => cell(out, row, 'x') === 'y' && cell(out, row, 'y') === 'z')
  assert.ok(pair, '应包含 y-z 配对')
  assert.ok(Math.abs(Number(cell(out, pair, 'r')) - 1) < 1e-12, 'r=' + cell(out, pair, 'r'))
  const tied = fixture(['1,1,1', '2,1,1', '3,2,2', '4,2,2', '5,3,3', '6,3,3', '7,4,4'], ['id', 'y', 'z'])
  const tiedResult = run(tied.csv, { analyses: ['correlation'], gate: { minSubjects: 3 }, correlation: { columns: ['y', 'z'], method: 'spearman' } }, 'run-ties')
  assert.equal(tiedResult.meta.nodes.correlation.status, 'executed')
  const tiedOut = table(tiedResult, 'correlation')
  assert.ok(Math.abs(Number(cell(tiedOut, tiedOut.rows[0], 'r')) - 1) < 1e-12)
})

test('S02-B 非主变量含非法字符串时明确失败，空白按缺失处理', () => {
  const rows = []
  for (let index = 1; index <= 40; index += 1) rows.push(`${index},${index},${index <= 30 ? index : ''},${index === 5 ? 'abc' : index}`)
  const { csv } = fixture(rows, ['id', 'y', 'z', 'w'])
  const blank = run(csv, { analyses: ['correlation'], gate: { minSubjects: 30 }, correlation: { columns: ['y', 'z'] } })
  assert.equal(blank.meta.nodes.correlation.status, 'executed', blank.meta.nodes.correlation.reason)
  assert.equal(blank.meta.nodes.correlation.result.analysisSet.n, 30)
  const invalid = run(csv, { analyses: ['correlation'], correlation: { columns: ['y', 'w'] } }, 'run-invalid')
  assert.equal(invalid.meta.nodes.correlation.status, 'failed')
  assert.match(invalid.meta.nodes.correlation.reason, /无法解析为数值/)
})

test('S03-A 偏相关按控制设计秩扣除自由度', () => {
  const rows = []
  for (let index = 1; index <= 40; index += 1) rows.push(`${index},${index + ((index * 7) % 5)},${index + ((index * 11) % 3)},${index + ((index * 13) % 4)}`)
  const { csv } = fixture(rows, ['id', 'y', 'x', 'c'])
  const plan = { analyses: ['correlation'], gate: { minSubjects: 5 }, correlation: { columns: ['x', 'y'], partial: ['c'] } }
  const result = run(csv, plan)
  assert.equal(result.meta.nodes.correlation.status, 'executed')
  const out = table(result, 'correlation')
  const row = out.rows[0]
  const r = Number(cell(out, row, 'r')); const t = Number(cell(out, row, 't')); const df = Number(cell(out, row, 'df'))
  assert.equal(df, 37, 'n=40 控制 1 个满秩变量 → df=37')
  assert.ok(Math.abs(t - r * Math.sqrt(df / (1 - r * r))) < 1e-9, 't 必须与 r、df 自洽')
})

test('S03-B 列名含空格/中文/符号与控制变量共线都可解释', () => {
  const rows = []
  for (let index = 1; index <= 40; index += 1) rows.push(`${index},${index},${index * 2 + index % 7},${index * 3 + index % 5},${index},${index * 2}`)
  const { csv } = fixture(rows, ['id', 'y', '得分 A', '指标-b', '控制 1', '控制 2'])
  const plan = { analyses: ['correlation'], gate: { minSubjects: 5 }, correlation: { columns: ['得分 A', '指标-b'], partial: ['控制 1', '控制 2'] } }
  const result = run(csv, plan)
  assert.equal(result.meta.nodes.correlation.status, 'executed', result.meta.nodes.correlation.reason)
  const out = table(result, 'correlation')
  // 两个控制列共线：设计秩 = 2（截距 + 1），df = 40 - 2 - 1 = 37
  assert.equal(Number(cell(out, out.rows[0], 'df')), 37)
})

test('S04-A Table1 按 participantId 去重，冲突特征明确拒绝', () => {
  const rows = ['P-001,T0,20', 'P-001,T1,20', 'P-002,T0,30', 'P-002,T1,30']
  const { csv } = fixture(rows, ['id', 'visit', 'age'])
  const plan = { layout: 'long', outcome: 'age', within: { column: 'visit', levels: ['T0', 'T1'] }, analyses: ['sample'], sampleColumns: [{ column: 'age', kind: 'numeric', label: '年龄' }] }
  const result = run(csv, plan)
  assert.equal(result.meta.nodes.sample.status, 'executed', result.meta.nodes.sample.reason)
  const out = table(result, 'sample')
  const overall = out.rows.find(row => cell(out, row, 'scope') === '整体' && cell(out, row, 'kind') === '数值')
  assert.equal(Number(cell(out, overall, 'n')), 2, '两人两访视应计为 2 人')
  assert.ok(Math.abs(Number(cell(out, overall, 'sd')) - 7.0710678) < 1e-6, '样本 SD 应为 7.071068')

  const conflictRows = ['P-001,T0,20', 'P-001,T1,21', 'P-002,T0,30', 'P-002,T1,30']
  const conflict = fixture(conflictRows, ['id', 'visit', 'age'])
  const conflicted = run(conflict.csv, plan, 'run-conflict')
  assert.equal(conflicted.meta.nodes.sample.status, 'failed')
  assert.match(conflicted.meta.nodes.sample.reason, /特征值不一致/)
})

test('S05-A 反向题按声明量尺端点翻转，题总相关为 corrected', () => {
  const rows = ['1,5,1,2', '2,4,2,3', '3,3,1,4', '4,2,2,5', '5,1,1,2']
  const { csv } = fixture(rows, ['id', 'i1', 'i2', 'i3'])
  const plan = { outcome: 'i1', analyses: ['reliability'], gate: { minSubjects: 3 }, reliability: [{ name: 'scale', items: ['i1', 'i2', 'i3'], reverse: ['i2'], range: [1, 5] }] }
  const result = run(csv, plan)
  assert.equal(result.meta.nodes.reliability.status, 'executed', result.meta.nodes.reliability.reason)
  const out = table(result, 'reliability')
  const row = out.rows[0]
  // 独立参考：i2 反向为 6 - i2，再按 k/(k-1)(1 - Σvar/var(total)) 手算
  const items = [[5, 5, 2], [4, 4, 3], [3, 5, 4], [2, 4, 5], [1, 5, 2]]
  const k = 3
  const colVar = j => { const values = items.map(item => item[j]); const mean = values.reduce((a, b) => a + b, 0) / values.length; return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) }
  const totals = items.map(item => item.reduce((a, b) => a + b, 0))
  const totalMean = totals.reduce((a, b) => a + b, 0) / totals.length
  const totalVar = totals.reduce((sum, value) => sum + (value - totalMean) ** 2, 0) / (totals.length - 1)
  const expected = k / (k - 1) * (1 - (colVar(0) + colVar(1) + colVar(2)) / totalVar)
  assert.ok(Math.abs(Number(cell(out, row, 'alpha')) - expected) < 1e-9, `alpha=${cell(out, row, 'alpha')} expected=${expected}`)
  assert.equal(cell(out, row, 'reverseSource'), 'declared')
  assert.equal(cell(out, row, 'itemTotalType'), 'corrected')
})

test('S06-A 零方差样本与零方差两组都不输出伪造 t', () => {
  const constant = fixture(['1,5', '2,5', '3,5', '4,5'], ['id', 'y'])
  const oneSample = run(constant.csv, { analyses: ['ttest'], gate: { minSubjects: 2 }, ttest: { kind: 'one-sample', mu: 3 } })
  assert.equal(oneSample.meta.nodes.ttest.status, 'failed')
  assert.match(oneSample.meta.nodes.ttest.reason, /零方差/)

  const grouped = fixture(['1,5,A', '2,5,A', '3,5,B', '4,5,B'], ['id', 'y', 'g'])
  const independent = run(grouped.csv, { analyses: ['ttest'], gate: { minSubjects: 2 }, ttest: { kind: 'independent', group: 'g' } }, 'run-two-groups')
  assert.equal(independent.meta.nodes.ttest.status, 'failed')
  assert.match(independent.meta.nodes.ttest.reason, /标准误/)
})

test('S07 节点分析集：id、n、观测数与列声明一致', () => {
  const rows = []
  for (let index = 1; index <= 40; index += 1) rows.push(`${index},${index},${index % 2 ? 'A' : 'B'},${index <= 2 ? '' : index}`)
  const { csv } = fixture(rows, ['id', 'y', 'g', 'z'])
  const plan = { analyses: ['descriptives', 'regression'], outcome: 'y', groupColumns: ['g'], covariates: ['z'] }
  const result = run(csv, plan)
  const regression = result.meta.nodes.regression.result
  assert.ok(regression.analysisSet, '必须有 analysisSet')
  assert.equal(regression.analysisSet.n, 38)
  assert.equal(regression.analysisSet.id.length, 16)
  assert.deepEqual(regression.analysisSet.columns, ['id', 'y', 'g', 'z'])
  assert.equal(regression.analysisSet.ruleVersion, 'analysis-engine/2.5.0')
})
