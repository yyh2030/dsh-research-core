/**
 * 07 统计图：几何正确、n/区间口径、SVG 自包含、PNG/PDF 用本机浏览器栅格化。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  pointRangeChart, forestChart, pairedChart, distributionChart, chartRowsFromTable, detectBrowser, renderPng, renderPdf, pngAvailability, leftPadFor,
} from '../charts.mjs'
import { buildResults, renderHtmlReport } from '../results.mjs'

const rows = [
  { label: 'A 组', estimate: 2.5, low: 0.5, high: 4.5, n: 3 },
  { label: 'B 组', estimate: 9, low: 6, high: 12, n: 3 },
]
const domain = { min: 0.5 - (12 - 0.5) * 0.08, max: 12 + (12 - 0.5) * 0.08 }
const padLeft = leftPadFor(rows.map(row => row.label))
const xOf = value => padLeft + ((value - domain.min) / (domain.max - domain.min)) * (960 - padLeft - 126)

test('分组估计图：坐标按线性映射、n 与区间说明在图上', () => {
  const chart = pointRangeChart({ title: '分组估计', rows, unit: '分', height: 320 })
  assert.equal(chart.ok, true)
  assert.match(chart.svg, /<svg[^>]*viewBox="0 0 960 320"/)
  assert.match(chart.svg, /A 组/)
  assert.match(chart.svg, /n=3/)
  assert.match(chart.svg, /95% CI/)
  assert.equal(chart.geometry.length, 2)
  assert.ok(Math.abs(chart.geometry[0].x - xOf(2.5)) < 1.01, `A 组 x=${chart.geometry[0].x} 期望 ${xOf(2.5)}`)
  assert.ok(Math.abs(chart.geometry[1].x - xOf(9)) < 1.01)
  assert.ok(chart.geometry[1].x > chart.geometry[0].x)
  assert.doesNotMatch(chart.svg, /<script/i)
  assert.doesNotMatch(chart.svg.replace('http://www.w3.org/2000/svg', ''), /https?:\/\//)
})

test('估计图：缺失或非法估计被跳过并说明，不画伪点', () => {
  const chart = pointRangeChart({ title: 't', rows: [{ label: 'A', estimate: null, low: null, high: null }], height: 300 })
  assert.equal(chart.ok, false)
  assert.match(chart.reason, /有效估计/)
  const mixed = pointRangeChart({ title: 't', rows: [{ label: 'A', estimate: 1, low: 0, high: 2, n: 2 }, { label: 'B', estimate: Number.NaN }], height: 300 })
  assert.equal(mixed.ok, true)
  assert.equal(mixed.geometry.length, 1)
})

test('森林图：零线、p 值格式与对比方向', () => {
  const chart = forestChart({ title: '对比', rows: [
    { label: 'B − A', estimate: 5.5, low: 2.1, high: 8.9, p: 0.0004 },
    { label: 'Y − X', estimate: -1.25, low: -3, high: 0.5, p: 0.24 },
  ], height: 300 })
  assert.equal(chart.ok, true)
  assert.match(chart.svg, /stroke-dasharray="4 4"/, '应有零线')
  assert.match(chart.svg, /p=&lt; \.001|p=< \.001/)
  assert.match(chart.svg, /p=\.240/)
  assert.equal(chart.geometry.length, 2)
})

test('配对轨迹：每个参与者一条线，均值为粗线，n 与单位标注', () => {
  const chart = pairedChart({ title: '前后变化', pairs: [
    { id: 'P1', before: 10, after: 11 },
    { id: 'P2', before: 11, after: 13 },
    { id: 'P3', before: 12, after: 15 },
  ], unit: '分' })
  assert.equal(chart.ok, true)
  assert.equal(chart.geometry.length, 3)
  assert.match(chart.svg, /n=3/)
  assert.match(chart.svg, /单位：分/)
  assert.equal(chart.summary.meanBefore, 11)
  assert.ok(Math.abs(chart.summary.meanAfter - 13) < 1e-9)
  assert.match(chart.svg, /不把观测行当独立样本/)
})

test('分布图：散点条带 + 箱线，须为 1.5 IQR 内极值，n 与中位数可核对', () => {
  const chart = distributionChart({ title: '分布', groups: [
    { label: 'A', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20] },
    { label: 'B', values: [2, 4, 6, 8] },
  ] })
  assert.equal(chart.ok, true)
  assert.equal(chart.geometry.length, 2)
  const a = chart.geometry[0]
  assert.equal(a.n, 11)
  assert.equal(a.median, 6)
  assert.equal(a.q1, 3.5)
  assert.equal(a.q3, 8.5)
  assert.equal(a.high, 16, '上须应封到 1.5 IQR 内（20 是离群点）')
  assert.equal(chart.summary.observations, 15)
  assert.match(chart.svg, /n=11/)
  assert.match(chart.svg, /不假设正态/)
  assert.doesNotMatch(chart.svg, /<script/i)
  const empty = distributionChart({ title: 't', groups: [{ label: 'A', values: [] }] })
  assert.equal(empty.ok, false)
})

test('从结果表取图数据：只挑列，不重算', () => {
  const results = buildResults({ run: { runId: 'r1' }, meta: { subjects: 3, dataset: { hash: 'h' } }, tables: [
    { key: 'descriptives', columns: ['group', 'subjects', 'mean', 'ciLow', 'ciHigh'], rows: [
      { group: 'A', subjects: 3, mean: 2.5, ciLow: 0.5, ciHigh: 4.5 },
    ] },
  ] })
  const chart = chartRowsFromTable(results.tables[0])
  assert.deepEqual(chart, [{ label: 'A', estimate: 2.5, low: 0.5, high: 4.5, n: 3 }])
})

test('PDF 分页：上百行表不会挤成一页，页数随内容增长', () => {
  const browser = detectBrowser()
  if (!browser) return
  const rows = Array.from({ length: 120 }, (_, index) => ({ group: `组 ${index + 1}`, subjects: 2, mean: index + 0.5, sd: 1, ciLow: index - 1, ciHigh: index + 2 }))
  const built = buildResults({
    run: { runId: 'pdf-pages' },
    meta: { subjects: 240, observations: 240, dataset: { hash: 'a'.repeat(64) }, study: { name: '分页检查' }, nodes: {}, warnings: [] },
    tables: [{ key: 'descriptives', columns: ['group', 'subjects', 'mean', 'sd', 'ciLow', 'ciHigh'], rows }],
  })
  const html = renderHtmlReport({ meta: { study: { name: '分页检查' }, subjects: 240, dataset: { hash: 'a'.repeat(64) }, nodes: {} }, results: built, today: '2026-11-07' })
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-pdf-'))
  const pdf = renderPdf({ html, outPath: path.join(dir, 'report.pdf'), browser })
  assert.equal(pdf.ok, true, pdf.reason)
  const text = readFileSync(path.join(dir, 'report.pdf')).toString('latin1')
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length
  assert.ok(pages >= 3, '120 行表应跨多页，实际页数：' + pages)
  assert.match(text.slice(0, 200), /%PDF-/)
})

test('PNG 与 PDF：本机浏览器无头渲染，尺寸与有效 DPI', async () => {
  const browser = detectBrowser()
  if (!browser) {
    const availability = pngAvailability()
    assert.equal(availability.ok, false)
    return
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-chart-'))
  const chart = pointRangeChart({ title: '分组估计', rows, height: 300 })
  const pngPath = path.join(dir, 'chart.png')
  const png = renderPng({ svg: chart.svg, outPath: pngPath, width: 960, height: 300, dpi: 300, browser })
  assert.equal(png.ok, true, png.reason)
  assert.ok(existsSync(pngPath))
  assert.ok(Math.abs(png.width / png.height - 960 / 300) < 0.05, '应保持图幅比例')
  assert.ok(png.width >= 960 * 2, '300dpi 应比 CSS 像素大')
  assert.ok(png.dpi >= 290 && png.dpi <= 310, '有效 dpi 接近 300：' + png.dpi)

  const results = buildResults({ run: { runId: 'r1' }, meta: { subjects: 6, dataset: { hash: 'a'.repeat(64) }, study: { name: '合成研究' } }, tables: [
    { key: 'descriptives', columns: ['group', 'subjects', 'mean', 'ciLow', 'ciHigh'], rows: [{ group: 'A', subjects: 3, mean: 2.5, ciLow: 0.5, ciHigh: 4.5 }] },
  ] })
  const html = renderHtmlReport({ meta: { subjects: 6, dataset: { hash: 'a'.repeat(64) }, study: { name: '合成研究' }, nodes: {} }, results, today: '2026-11-07' })
  const pdfPath = path.join(dir, 'report.pdf')
  const pdf = renderPdf({ html, outPath: pdfPath, browser })
  assert.equal(pdf.ok, true, pdf.reason)
  assert.equal(readFileSync(pdfPath).subarray(0, 5).toString('latin1'), '%PDF-')
})
