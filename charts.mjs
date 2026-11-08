/**
 * @local/research-core/charts — 07 阶段的本地统计图（零依赖 SVG）
 *
 * 只用引擎/结果对象里已经算好的估计与区间画图，不在前端重算 CI。
 * 输出自带标题、单位、n、区间方法与说明的自包含 SVG：无外部资源、无脚本、无位图。
 * PNG 需要本地栅格化器（matplotlib 或系统转换器），由调用方按可用性决定。
 */

export const CHART_VERSION = 'charts/1.0.0'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
export const PALETTE = ['#1b6ca8', '#b3541e', '#2e7d32', '#6b21a8', '#0f766e', '#9a3412']
const FONT = "'Source Han Sans SC','Noto Sans CJK SC','Microsoft YaHei',system-ui,sans-serif"
const NUM_FONT = "'Cascadia Mono','Consolas',monospace"

const escapeXml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const finite = value => typeof value === 'number' && Number.isFinite(value)
const round = (value, digits = 2) => Number(value.toFixed(digits))

function domainOf(rows, key) {
  const values = rows.flatMap(row => [row.low, row.high].filter(finite))
  if (!values.length) return null
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (min === max) { min -= 1; max += 1 }
  const pad = (max - min) * 0.08
  return { min: min - pad, max: max + pad }
}

function frame({ title, subtitle, width, height, domain, axis, padLeft }) {
  const pad = { left: padLeft ?? 168, right: 126, top: 64, bottom: 62 }
  const plot = { x: pad.left, y: pad.top, w: width - pad.left - pad.right, h: height - pad.top - pad.bottom }
  const xFor = value => plot.x + ((value - domain.min) / (domain.max - domain.min)) * plot.w
  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`)
  parts.push(`<desc>${escapeXml(subtitle || title)}</desc>`)
  parts.push(`<style>
    text{font-family:${FONT};fill:#1f2328}
    .title{font-size:20px;font-weight:600}
    .subtitle{font-size:13px;fill:#4b5563}
    .tick{font-size:12.5px;fill:#4b5563}
    .label{font-size:13.5px}
    .num{font-family:${NUM_FONT};font-size:13px}
    .note{font-size:12px;fill:#4b5563}
    .axis{stroke:#1f2328;stroke-width:1}
    .grid{stroke:#e5e7eb;stroke-width:1}
  </style>`)
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`)
  parts.push(`<text class="title" x="${pad.left}" y="34">${escapeXml(title)}</text>`)
  if (subtitle) parts.push(`<text class="subtitle" x="${pad.left}" y="52">${escapeXml(subtitle)}</text>`)
  // 横轴：基线 + 刻度 + 网格
  const ticks = []
  for (let index = 0; index <= 4; index += 1) {
    const value = domain.min + ((domain.max - domain.min) * index) / 4
    ticks.push({ value, x: xFor(value) })
  }
  parts.push(`<line class="axis" x1="${plot.x}" y1="${plot.y + plot.h}" x2="${plot.x + plot.w}" y2="${plot.y + plot.h}"/>`)
  for (const tick of ticks) {
    parts.push(`<line class="grid" x1="${round(tick.x, 2)}" y1="${plot.y}" x2="${round(tick.x, 2)}" y2="${plot.y + plot.h}"/>`)
    parts.push(`<text class="tick num" x="${round(tick.x, 2)}" y="${plot.y + plot.h + 20}" text-anchor="middle">${escapeXml(formatAxis(tick.value))}</text>`)
  }
  if (axis && axis.label) parts.push(`<text class="note" x="${plot.x + plot.w}" y="${plot.y + plot.h + 44}" text-anchor="end">${escapeXml(axis.label)}</text>`)
  return { parts, plot, xFor }
}

export function formatAxis(value) {
  if (!finite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute !== 0 && absolute < 0.01) return value.toExponential(1)
  return String(round(value, absolute >= 100 ? 0 : 2))
}

/** 左侧标签宽度：长变量名不截断、不压到坐标轴。 */
export function leftPadFor(labels) {
  const longest = labels.reduce((max, label) => Math.max(max, String(label).length), 0)
  return Math.min(360, Math.max(120, Math.round(longest * 7.8 + 24)))
}

/**
 * 分组估计与区间：点表示估计，横线表示区间（区间方法由调用方声明），右侧标 n。
 * rows: [{label, estimate, low, high, n, note?}]
 */
export function pointRangeChart({ title, subtitle, rows = [], unit = '', intervalLabel = '95% CI', width = 960, height = 480, nLabel = 'n' }) {
  const usable = rows.filter(row => finite(row.estimate))
  if (!usable.length) return { ok: false, reason: '没有可用于绘图的有效估计' }
  const domain = domainOf(usable)
  if (!domain) return { ok: false, reason: '区间缺失，无法确定坐标范围' }
  const { parts, plot, xFor } = frame({ title, subtitle, width, height, domain, padLeft: leftPadFor(usable.map(row => row.label)), axis: { label: unit ? `单位：${unit}` : '' } })
  const geometry = []
  const rowHeight = plot.h / Math.max(usable.length, 1)
  usable.forEach((row, index) => {
    const y = plot.y + rowHeight * (index + 0.5)
    const color = PALETTE[index % PALETTE.length]
    const x = xFor(row.estimate)
    geometry.push({ label: row.label, x: round(x, 2), y: round(y, 2), low: row.low, high: row.high, estimate: row.estimate, n: row.n ?? null })
    parts.push(`<text class="label" x="${plot.x - 16}" y="${round(y + 4, 2)}" text-anchor="end">${escapeXml(row.label)}</text>`)
    if (finite(row.low) && finite(row.high)) {
      const x1 = xFor(row.low); const x2 = xFor(row.high)
      parts.push(`<line x1="${round(x1, 2)}" y1="${round(y, 2)}" x2="${round(x2, 2)}" y2="${round(y, 2)}" stroke="${color}" stroke-width="2"/>`)
      parts.push(`<line x1="${round(x1, 2)}" y1="${round(y - 6, 2)}" x2="${round(x1, 2)}" y2="${round(y + 6, 2)}" stroke="${color}" stroke-width="2"/>`)
      parts.push(`<line x1="${round(x2, 2)}" y1="${round(y - 6, 2)}" x2="${round(x2, 2)}" y2="${round(y + 6, 2)}" stroke="${color}" stroke-width="2"/>`)
    }
    parts.push(`<circle cx="${round(x, 2)}" cy="${round(y, 2)}" r="5" fill="${color}"/>`)
    const right = `${row.n === null || row.n === undefined ? '' : `${nLabel}=${row.n}`}${row.note ? ` · ${row.note}` : ''}`
    if (right) parts.push(`<text class="num" x="${round(plot.x + plot.w + 12, 2)}" y="${round(y + 4, 2)}">${escapeXml(right)}</text>`)
  })
  parts.push(`<text class="note" x="${plot.x}" y="${height - 16}">点=估计，横线=${escapeXml(intervalLabel)}（区间来自运行结果，不在图上重算）</text>`)
  parts.push('</svg>')
  return { ok: true, version: CHART_VERSION, title, svg: parts.join('\n'), width, height, geometry, domain, summary: { rows: usable.length, intervalLabel } }
}

/**
 * 模型估计／对比（森林图）：零线、估计点与区间，右侧标 p。
 * rows: [{label, estimate, low, high, p}]
 */
export function forestChart({ title, subtitle, rows = [], zero = 0, width = 960, height = 460, unit = '' }) {
  const usable = rows.filter(row => finite(row.estimate))
  if (!usable.length) return { ok: false, reason: '没有可用于绘图的有效估计' }
  const domain = domainOf(usable) || { min: Math.min(zero, 0) - 1, max: Math.max(zero, 0) + 1 }
  if (zero < domain.min || zero > domain.max) { domain.min = Math.min(domain.min, zero); domain.max = Math.max(domain.max, zero) }
  const { parts, plot, xFor } = frame({ title, subtitle, width, height, domain, padLeft: leftPadFor(usable.map(row => row.label)), axis: { label: unit ? `单位：${unit}` : '' } })
  const zeroX = xFor(zero)
  parts.push(`<line x1="${round(zeroX, 2)}" y1="${plot.y}" x2="${round(zeroX, 2)}" y2="${plot.y + plot.h}" stroke="#9ca3af" stroke-dasharray="4 4"/>`)
  parts.push(`<text class="tick" x="${round(zeroX, 2)}" y="${plot.y - 8}" text-anchor="middle">0</text>`)
  const geometry = []
  const rowHeight = plot.h / Math.max(usable.length, 1)
  usable.forEach((row, index) => {
    const y = plot.y + rowHeight * (index + 0.5)
    const color = row.estimate >= zero ? PALETTE[0] : PALETTE[1]
    const x = xFor(row.estimate)
    geometry.push({ label: row.label, x: round(x, 2), y: round(y, 2), estimate: row.estimate, low: row.low, high: row.high, p: row.p })
    parts.push(`<text class="label" x="${plot.x - 16}" y="${round(y + 4, 2)}" text-anchor="end">${escapeXml(row.label)}</text>`)
    if (finite(row.low) && finite(row.high)) {
      const x1 = xFor(row.low); const x2 = xFor(row.high)
      parts.push(`<line x1="${round(x1, 2)}" y1="${round(y, 2)}" x2="${round(x2, 2)}" y2="${round(y, 2)}" stroke="${color}" stroke-width="2"/>`)
      parts.push(`<line x1="${round(x1, 2)}" y1="${round(y - 6, 2)}" x2="${round(x1, 2)}" y2="${round(y + 6, 2)}" stroke="${color}" stroke-width="2"/>`)
      parts.push(`<line x1="${round(x2, 2)}" y1="${round(y - 6, 2)}" x2="${round(x2, 2)}" y2="${round(y + 6, 2)}" stroke="${color}" stroke-width="2"/>`)
    }
    parts.push(`<circle cx="${round(x, 2)}" cy="${round(y, 2)}" r="5" fill="${color}"/>`)
    if (finite(row.p)) parts.push(`<text class="num" x="${round(plot.x + plot.w + 12, 2)}" y="${round(y + 4, 2)}">p=${escapeXml(row.p < 0.001 ? '< .001' : row.p.toFixed(3).replace(/^0/, ''))}</text>`)
  })
  parts.push(`<text class="note" x="${plot.x}" y="${height - 16}">点=估计，横线=95% 区间；虚线为 0（无效应对齐虚线）。</text>`)
  parts.push('</svg>')
  return { ok: true, version: CHART_VERSION, title, svg: parts.join('\n'), width, height, geometry, domain, summary: { rows: usable.length } }
}

/**
 * 配对轨迹：每个参与者一条细线连接前后测量，粗线为均值变化。
 * pairs: [{id, before, after}]
 */
export function pairedChart({ title, subtitle, pairs = [], beforeLabel = '前', afterLabel = '后', width = 880, height = 460, unit = '' }) {
  const usable = pairs.filter(pair => finite(pair.before) && finite(pair.after))
  if (!usable.length) return { ok: false, reason: '没有成对的观测' }
  const values = usable.flatMap(pair => [pair.before, pair.after])
  const min = Math.min(...values); const max = Math.max(...values)
  const span = max - min || 1
  const pad = { left: 120, right: 60, top: 64, bottom: 56 }
  const plot = { x: pad.left, y: pad.top, w: width - pad.left - pad.right, h: height - pad.top - pad.bottom }
  const yFor = value => plot.y + plot.h - ((value - (min - span * 0.08)) / (span * 1.16)) * plot.h
  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`)
  parts.push(`<desc>${escapeXml(subtitle || title)}</desc>`)
  parts.push(`<style>text{font-family:${FONT};fill:#1f2328}.title{font-size:20px;font-weight:600}.subtitle{font-size:13px;fill:#4b5563}.tick{font-size:12.5px;fill:#4b5563}.note{font-size:12px;fill:#4b5563}.num{font-family:${NUM_FONT};font-size:12px}</style>`)
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`)
  parts.push(`<text class="title" x="${pad.left}" y="34">${escapeXml(title)}</text>`)
  if (subtitle) parts.push(`<text class="subtitle" x="${pad.left}" y="52">${escapeXml(subtitle)}</text>`)
  for (let index = 0; index <= 4; index += 1) {
    const value = (min - span * 0.08) + ((span * 1.16) * index) / 4
    const y = yFor(value)
    parts.push(`<line x1="${plot.x}" y1="${round(y, 2)}" x2="${plot.x + plot.w}" y2="${round(y, 2)}" stroke="#e5e7eb"/>`)
    parts.push(`<text class="tick num" x="${plot.x - 10}" y="${round(y + 4, 2)}" text-anchor="end">${escapeXml(formatAxis(value))}</text>`)
  }
  const x1 = plot.x + plot.w * 0.3; const x2 = plot.x + plot.w * 0.7
  const geometry = []
  for (const pair of usable) {
    parts.push(`<line x1="${round(x1, 2)}" y1="${round(yFor(pair.before), 2)}" x2="${round(x2, 2)}" y2="${round(yFor(pair.after), 2)}" stroke="#cbd5e1" stroke-width="1.5"/>`)
    geometry.push({ id: pair.id, x1: round(x1, 2), y1: round(yFor(pair.before), 2), x2: round(x2, 2), y2: round(yFor(pair.after), 2) })
  }
  const meanBefore = usable.reduce((sum, pair) => sum + pair.before, 0) / usable.length
  const meanAfter = usable.reduce((sum, pair) => sum + pair.after, 0) / usable.length
  parts.push(`<circle cx="${round(x1, 2)}" cy="${round(yFor(meanBefore), 2)}" r="6" fill="${PALETTE[0]}"/>`)
  parts.push(`<circle cx="${round(x2, 2)}" cy="${round(yFor(meanAfter), 2)}" r="6" fill="${PALETTE[1]}"/>`)
  parts.push(`<line x1="${round(x1, 2)}" y1="${round(yFor(meanBefore), 2)}" x2="${round(x2, 2)}" y2="${round(yFor(meanAfter), 2)}" stroke="${PALETTE[0]}" stroke-width="3"/>`)
  parts.push(`<text class="tick" x="${round(x1, 2)}" y="${height - 26}" text-anchor="middle">${escapeXml(beforeLabel)}</text>`)
  parts.push(`<text class="tick" x="${round(x2, 2)}" y="${height - 26}" text-anchor="middle">${escapeXml(afterLabel)}</text>`)
  parts.push(`<text class="num" x="${round(x2 + 20, 2)}" y="${round(yFor(meanAfter) + 4, 2)}">均值 ${escapeXml(formatAxis(meanAfter))}</text>`)
  parts.push(`<text class="note" x="${plot.x}" y="${height - 8}">细线=每位参与者（n=${usable.length}），粗线=均值变化；不把观测行当独立样本。${unit ? ` 单位：${escapeXml(unit)}` : ''}</text>`)
  parts.push('</svg>')
  return { ok: true, version: CHART_VERSION, title, svg: parts.join('\n'), width, height, geometry, summary: { pairs: usable.length, meanBefore, meanAfter } }
}

/**
 * 分布图：原始观测的散点条带 + 箱线（中位数、四分位、1.5 IQR 须）。
 * 不假设正态、不画均值柱——小样本也不会被截断基线夸大差异。
 * groups: [{label, values: number[]}]
 */
export function distributionChart({ title, subtitle, groups = [], width = 960, height = 440, unit = '' }) {
  const usable = groups.map(group => ({ label: group.label, values: group.values.filter(finite) })).filter(group => group.values.length > 0)
  if (!usable.length) return { ok: false, reason: '没有可用的原始观测' }
  const all = usable.flatMap(group => group.values)
  let min = Math.min(...all); let max = Math.max(...all)
  if (min === max) { min -= 1; max += 1 }
  const pad = { left: leftPadFor(usable.map(group => group.label)), right: 96, top: 64, bottom: 62 }
  const plot = { x: pad.left, y: pad.top, w: width - pad.left - pad.right, h: height - pad.top - pad.bottom }
  const span = max - min
  const yFor = value => plot.y + plot.h - ((value - (min - span * 0.06)) / (span * 1.12)) * plot.h
  const quantile = (sorted, q) => {
    const position = (sorted.length - 1) * q
    const base = Math.floor(position)
    const rest = position - base
    return sorted[base] + (sorted[base + 1] === undefined ? 0 : (sorted[base + 1] - sorted[base]) * rest)
  }
  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`)
  parts.push(`<desc>${escapeXml(subtitle || title)}</desc>`)
  parts.push(`<style>
    text{font-family:${FONT};fill:#1f2328}
    .title{font-size:20px;font-weight:600}.subtitle{font-size:13px;fill:#4b5563}
    .tick{font-size:12.5px;fill:#4b5563}.label{font-size:13.5px}.num{font-family:${NUM_FONT};font-size:12px}
    .note{font-size:12px;fill:#4b5563}.grid{stroke:#e5e7eb}.axis{stroke:#1f2328}
  </style>`)
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`)
  parts.push(`<text class="title" x="${pad.left}" y="34">${escapeXml(title)}</text>`)
  if (subtitle) parts.push(`<text class="subtitle" x="${pad.left}" y="52">${escapeXml(subtitle)}</text>`)
  for (let index = 0; index <= 4; index += 1) {
    const value = (min - span * 0.06) + ((span * 1.12) * index) / 4
    const y = yFor(value)
    parts.push(`<line class="grid" x1="${plot.x}" y1="${round(y, 2)}" x2="${plot.x + plot.w}" y2="${round(y, 2)}"/>`)
    parts.push(`<text class="tick num" x="${plot.x - 10}" y="${round(y + 4, 2)}" text-anchor="end">${escapeXml(formatAxis(value))}</text>`)
  }
  const columnWidth = plot.w / Math.max(usable.length, 1)
  const geometry = []
  usable.forEach((group, index) => {
    const center = plot.x + columnWidth * (index + 0.5)
    const sorted = group.values.slice().sort((a, b) => a - b)
    const q1 = quantile(sorted, 0.25); const median = quantile(sorted, 0.5); const q3 = quantile(sorted, 0.75)
    const iqr = q3 - q1
    const low = Math.max(sorted[0], q1 - 1.5 * iqr)
    const high = Math.min(sorted[sorted.length - 1], q3 + 1.5 * iqr)
    const color = PALETTE[index % PALETTE.length]
    // 散点条带（每个观测一个点，水平抖动固定，可复现）
    const jitter = Math.min(26, columnWidth * 0.32)
    group.values.forEach((value, pointIndex) => {
      const x = center + (jitter * (pointIndex % 7 - 3)) / 3
      parts.push(`<circle cx="${round(x, 2)}" cy="${round(yFor(value), 2)}" r="2.6" fill="${color}" fill-opacity="0.55"/>`)
    })
    const boxWidth = Math.min(64, columnWidth * 0.42)
    parts.push(`<rect x="${round(center - boxWidth / 2, 2)}" y="${round(yFor(q3), 2)}" width="${round(boxWidth, 2)}" height="${round(Math.max(1, yFor(q1) - yFor(q3)), 2)}" fill="none" stroke="${color}" stroke-width="2"/>`)
    parts.push(`<line x1="${round(center - boxWidth / 2, 2)}" y1="${round(yFor(median), 2)}" x2="${round(center + boxWidth / 2, 2)}" y2="${round(yFor(median), 2)}" stroke="${color}" stroke-width="2.5"/>`)
    parts.push(`<line x1="${round(center, 2)}" y1="${round(yFor(low), 2)}" x2="${round(center, 2)}" y2="${round(yFor(high), 2)}" stroke="${color}" stroke-width="1.5"/>`)
    parts.push(`<text class="label" x="${round(center, 2)}" y="${height - 34}" text-anchor="middle">${escapeXml(group.label)}</text>`)
    parts.push(`<text class="num" x="${round(center, 2)}" y="${height - 18}" text-anchor="middle">n=${group.values.length}</text>`)
    geometry.push({ label: group.label, center: round(center, 2), median: round(median, 4), q1: round(q1, 4), q3: round(q3, 4), low: round(low, 4), high: round(high, 4), n: group.values.length })
  })
  parts.push(`<line class="axis" x1="${plot.x}" y1="${plot.y + plot.h}" x2="${plot.x + plot.w}" y2="${plot.y + plot.h}"/>`)
  parts.push(`<text class="note" x="${plot.x}" y="${height - 4}">每个点=一个观测，箱=四分位，横线=中位数，须=1.5 IQR 内极值；不假设正态。${unit ? ` 单位：${escapeXml(unit)}` : ''}</text>`)
  parts.push('</svg>')
  return { ok: true, version: CHART_VERSION, title, svg: parts.join('\n'), width, height, geometry, summary: { groups: usable.length, observations: all.length } }
}

/** 从结果表里取绘图数据：不重算估计与 CI，只挑列。 */export function chartRowsFromTable(table, spec) {
  const { label = 'group', estimate = 'mean', low = 'ciLow', high = 'ciHigh', n = 'subjects' } = spec || {}
  const rows = (table?.rows || []).map(row => ({ label: String(row[label] ?? '—'), estimate: row[estimate], low: row[low], high: row[high], n: row[n] }))
  return rows
}

/** PNG 需要本地栅格化器；这里只报告可用性，不静默降级。 */
export function pngAvailability({ matplotlib = false, converter = null, browser = null } = {}) {
  if (matplotlib) return { ok: true, backend: 'matplotlib' }
  if (browser) return { ok: true, backend: browser }
  if (converter) return { ok: true, backend: converter }
  return { ok: false, reason: 'PNG 需要本地栅格化器（matplotlib）或系统 SVG 转换器；当前都没有，SVG 仍可用' }
}

/** 找一个可无头渲染的本机浏览器（Chrome/Edge），用于 SVG→PNG 与 HTML→PDF。 */
export function detectBrowser(candidates = []) {
  const list = [
    process.env.DSH_CHROME,
    ...candidates,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean)
  for (const candidate of list) {
    try { if (existsSync(candidate)) return candidate } catch { /* 忽略不可访问路径 */ }
  }
  return null
}

/**
 * 把 SVG 渲染成 PNG：用本机 Chrome/Edge 无头截图，不引入新依赖。
 * 尺寸按 96 CSS px/英寸换算，dpi 默认 300；返回实际像素与有效 dpi。
 */
export function renderPng({ svg, outPath, width, height, dpi = 300, browser }) {
  const executable = browser || detectBrowser()
  if (!executable) return { ok: false, reason: pngAvailability().reason }
  const inches = width / 96
  const scale = Math.max(1, Math.min(4, (inches * dpi) / width))
  const pxWidth = Math.round(width * scale)
  const pxHeight = Math.round(height * scale)
  const htmlPath = path.join(path.dirname(outPath), `.chart-${process.pid}-${Math.random().toString(16).slice(2)}.html`)
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}svg{display:block;width:${pxWidth}px;height:${pxHeight}px}</style></head><body>${svg}</body></html>`
  writeFileSync(htmlPath, html, 'utf8')
  try {
    const profile = path.join(os.tmpdir(), `chart-render-${process.pid}-${Math.random().toString(16).slice(2)}`)
    const result = spawnSync(executable, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
      `--window-size=${pxWidth},${pxHeight}`, `--screenshot=${outPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    if (!existsSync(outPath)) return { ok: false, reason: `浏览器没有产出截图：${String(result.stderr || '').slice(0, 300)}` }
    const header = readFileSync(outPath).subarray(0, 24)
    if (header.subarray(1, 4).toString('latin1') !== 'PNG') return { ok: false, reason: '截图不是 PNG' }
    const pngWidth = header.readUInt32BE(16)
    const pngHeight = header.readUInt32BE(20)
    return { ok: true, backend: executable, path: outPath, width: pngWidth, height: pngHeight, dpi: Math.round((pngWidth / width) * 96) }
  } finally {
    try { rmSync(htmlPath, { force: true }) } catch { /* 忽略 */ }
  }
}

/** 把自包含 HTML 报告渲染成 PDF（Chrome 无头打印），用于 P1-33 的本地转换。 */
export function renderPdf({ html, outPath, browser }) {
  const executable = browser || detectBrowser()
  if (!executable) return { ok: false, reason: '没有可用的无头浏览器，无法本地转 PDF' }
  const htmlPath = path.join(path.dirname(outPath), `.report-${process.pid}-${Math.random().toString(16).slice(2)}.html`)
  writeFileSync(htmlPath, html, 'utf8')
  try {
    const profile = path.join(os.tmpdir(), `pdf-render-${process.pid}-${Math.random().toString(16).slice(2)}`)
    const result = spawnSync(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, '--no-pdf-header-footer', `--print-to-pdf=${outPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
    if (!existsSync(outPath)) return { ok: false, reason: `浏览器没有产出 PDF：${String(result.stderr || '').slice(0, 300)}` }
    const header = readFileSync(outPath).subarray(0, 5).toString('latin1')
    if (header !== '%PDF-') return { ok: false, reason: '输出不是 PDF' }
    return { ok: true, backend: executable, path: outPath }
  } finally {
    try { rmSync(htmlPath, { force: true }) } catch { /* 忽略 */ }
  }
}
