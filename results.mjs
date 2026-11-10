/**
 * @local/research-core/results — 07 阶段的结果对象、格式化与三线表/报告渲染
 *
 * 原则：
 *   - 数值对象保留完整精度；格式化只在渲染时做，不覆盖原值；
 *   - 表格/图/段落都带 runId、nodeId、analysisSet、sourceHash，便于追溯；
 *   - 未知变量保留原名，不猜测翻译；缺失显示 '—'；p 用 '< .001' 规则；零与负零统一为 0；
 *   - 三线表只依赖 CSS 边框（顶线/表头下线/底线），不靠 Markdown 横线冒充；
 *   - 报告默认脱敏：不写姓名、联系方式、逐人排除明细与绝对本地路径，不引用任何外部资源。
 */
import { createHash } from 'node:crypto'

export const RESULTS_VERSION = 'results/1.0.0'

export const LABELS = {
  participantId: { zh: '参与者编号', en: 'Participant ID' },
  subject: { zh: '参与者', en: 'Participant' },
  group: { zh: '分组', en: 'Group' },
  cond: { zh: '条件', en: 'Condition' },
  visit: { zh: '时点', en: 'Visit' },
  n: { zh: '人数', en: 'n' },
  subjects: { zh: '独立人数', en: 'Participants' },
  observations: { zh: '观测数', en: 'Observations' },
  validObservations: { zh: '有效', en: 'Valid' },
  missing: { zh: '缺失', en: 'Missing' },
  mean: { zh: '均值', en: 'Mean' },
  sd: { zh: '标准差', en: 'SD' },
  se: { zh: '标准误', en: 'SE' },
  median: { zh: '中位数', en: 'Median' },
  q1: { zh: 'Q1', en: 'Q1' },
  q3: { zh: 'Q3', en: 'Q3' },
  iqr: { zh: '四分位距', en: 'IQR' },
  minimum: { zh: '最小值', en: 'Min' },
  maximum: { zh: '最大值', en: 'Max' },
  valueRange: { zh: '极差', en: 'Range' },
  ciLow: { zh: '下限', en: 'Lower' },
  ciHigh: { zh: '上限', en: 'Upper' },
  ciLevel: { zh: 'CI', en: 'CI' },
  ciCritical: { zh: 't*', en: 't*' },
  estimate: { zh: '估计', en: 'Estimate' },
  term: { zh: '项', en: 'Term' },
  coef: { zh: '系数', en: 'Coefficient' },
  p: { zh: 'p', en: 'p' },
  'p-value': { zh: 'p', en: 'p' },
  t: { zh: 't', en: 't' },
  df: { zh: '自由度', en: 'df' },
  F: { zh: 'F', en: 'F' },
  sumSq: { zh: '平方和', en: 'Sum of squares' },
  partialEtaSquared: { zh: '偏 η²', en: 'Partial η²' },
  rSquared: { zh: 'R²', en: 'R²' },
  adjRSquared: { zh: '调整 R²', en: 'Adjusted R²' },
  from: { zh: '参照', en: 'From' },
  to: { zh: '比较', en: 'To' },
  count: { zh: '计数', en: 'Count' },
  denominator: { zh: '分母', en: 'Denominator' },
  percent: { zh: '百分比', en: 'Percent' },
  value: { zh: '取值', en: 'Value' },
  column: { zh: '变量', en: 'Variable' },
  level: { zh: '水平', en: 'Level' },
  groupVariance: { zh: '组间方差', en: 'Group variance' },
  residualVariance: { zh: '残差方差', en: 'Residual variance' },
  icc: { zh: 'ICC', en: 'ICC' },
  descriptives: { zh: '描述统计', en: 'Descriptive statistics' },
  sample: { zh: '样本特征', en: 'Sample characteristics' },
  sensitivity: { zh: '敏感性分析', en: 'Sensitivity analysis' },
  correlation: { zh: '相关分析', en: 'Correlation' },
  reliability: { zh: '信度', en: 'Reliability' },
  ttest: { zh: 't 检验', en: 't test' },
  mediation: { zh: '中介分析', en: 'Mediation' },
  script: { zh: '自定义脚本', en: 'Custom script' },
  x: { zh: 'X', en: 'X' },
  y: { zh: 'Y', en: 'Y' },
  method: { zh: '方法', en: 'Method' },
  partial: { zh: '控制变量', en: 'Partialled out' },
  r: { zh: 'r', en: 'r' },
  'p_adjusted': { zh: '校正 p', en: 'Adjusted p' },
  name: { zh: '条目组', en: 'Scale' },
  k: { zh: '题量', en: 'Items' },
  alpha: { zh: 'Cronbach α', en: 'Cronbach α' },
  itemTotalMin: { zh: '题总相关最小', en: 'Item-total min' },
  itemTotalMax: { zh: '题总相关最大', en: 'Item-total max' },
  meanInterItem: { zh: '平均题间相关', en: 'Mean inter-item r' },
  comparison: { zh: '比较', en: 'Comparison' },
  mean1: { zh: '均值 1', en: 'Mean 1' },
  mean2: { zh: '均值 2', en: 'Mean 2' },
  meanDiff: { zh: '均值差', en: 'Mean difference' },
  cohenD: { zh: "Cohen's d", en: "Cohen's d" },
  effect: { zh: '效应', en: 'Effect' },
  scope: { zh: '范围', en: 'Scope' },
  nAll: { zh: '全部 n', en: 'n (all)' },
  meanAll: { zh: '全部均值', en: 'Mean (all)' },
  sdAll: { zh: '全部 SD', en: 'SD (all)' },
  nComplete: { zh: '完整病例 n', en: 'n (complete)' },
  meanComplete: { zh: '完整病例均值', en: 'Mean (complete)' },
  sdComplete: { zh: '完整病例 SD', en: 'SD (complete)' },
  deltaMean: { zh: '均值差', en: 'Mean difference' },
  dropped: { zh: '剔除人数', en: 'Dropped' },
  variable: { zh: '变量', en: 'Variable' },
  label: { zh: '标签', en: 'Label' },
  kind: { zh: '类型', en: 'Type' },
  frequencies: { zh: '类别频数', en: 'Frequency table' },
  coefficients: { zh: '模型系数', en: 'Model coefficients' },
  anova: { zh: '方差分析', en: 'ANOVA' },
  contrasts: { zh: '预设对比', en: 'Planned contrasts' },
  regression: { zh: '回归 / ANCOVA', en: 'Regression / ANCOVA' },
  paired: { zh: '配对变化', en: 'Paired change' },
  mixed: { zh: '混合模型', en: 'Mixed model' },
  report: { zh: '报告', en: 'Report' },
}

export function labelFor(key, labels = LABELS) {
  const entry = labels[key]
  if (!entry) return { zh: String(key), en: String(key), known: false }
  return { zh: entry.zh, en: entry.en, known: true }
}

/** 渲染用数字：缺失 → '—'；零/负零 → '0'；非常小 → '0'；不做四舍五入以外的修改。 */
export function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || value === '') return '—'
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return '—'
  const threshold = 0.5 * Math.pow(10, -decimals)
  if (Math.abs(number) < threshold) return '0'
  return number.toFixed(decimals)
}

/** p 值：< .001 与 > .999 单独表述，其余三位小数并去掉整数位 0（APA 风格）。 */
export function formatP(value) {
  if (value === null || value === undefined || value === '') return '—'
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number < 0.001) return '< .001'
  if (number > 0.999) return '> .999'
  const text = number.toFixed(3)
  return text.startsWith('0') ? text.slice(1) : text
}

export function formatCI(low, high, decimals = 2) {
  return `[${formatNumber(low, decimals)}, ${formatNumber(high, decimals)}]`
}

const INTEGER_KEYS = new Set(['subjects', 'n', 'observations', 'validObservations', 'missing', 'df', 'count', 'denominator'])

export function formatValue(key, value, options = {}) {
  if (key === 'p' || key === 'p-value') return formatP(value)
  if (key === 'percent') return value === null || value === undefined ? '—' : `${formatNumber(value, 1)}%`
  if (typeof value === 'number') return formatNumber(value, INTEGER_KEYS.has(key) ? 0 : (options.decimals ?? 2))
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

/** 脱敏：去掉绝对本地路径（Windows 与 Unix），其余文本原样保留。 */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]*/g, '<本地路径>')
    .replace(/(^|\s)\/(?:Users|home|tmp|var)\/[^\s"'<>]*/g, '$1<本地路径>')
}

const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

/**
 * 把引擎运行结果整理成统一结果对象：完整精度保留在 rows 里，显示格式在渲染时生成。
 */
export function buildResults({ run, meta, tables = [], labels = LABELS }) {
  const nodeIds = Object.keys(meta?.nodes || {})
  const analysisSet = {
    subset: meta?.dataset?.stats?.subset || 'enrolled',
    subjects: meta?.subjects ?? meta?.dataset?.stats?.rows ?? null,
    observations: meta?.observations ?? null,
    excluded: Array.isArray(meta?.excludedIds) ? meta.excludedIds.length : 0,
  }
  const sourceHash = meta?.dataset?.hash || meta?.source?.sha256 || null
  const built = tables.map((table, index) => {
    const nodeId = table.nodeId || (table.key === 'frequencies' ? 'descriptives' : table.key)
    return {
      key: table.key,
      number: index + 1,
      title: table.title || labelFor(table.key, labels),
      nodeId,
      analysisSet: table.analysisSet || analysisSet,
      types: table.types || null,
      sourceHash: table.sourceHash || sourceHash,
      columns: (table.columns || []).map(column => {
        const key = typeof column === 'string' ? column : column.key
        const label = typeof column === 'string' ? labelFor(key, labels) : (column.title || labelFor(key, labels))
        // 07：列角色随结果对象保留，分享投影按 schema 过滤而不是按值推断。
        return { key, ...label, ...(typeof column === 'object' && column.role ? { role: String(column.role) } : {}) }
      }),
      rows: (table.rows || []).map(row => ({ ...row })),
      notes: table.notes || [],
    }
  })
  return {
    schemaVersion: 1,
    version: RESULTS_VERSION,
    runId: run?.runId || meta?.runId || null,
    study: meta?.study || null,
    nodeIds,
    analysisSet,
    sourceHash,
    tables: built,
    figures: [],
    warnings: (meta?.warnings || []).slice(),
    hash: sha({ runId: run?.runId || meta?.runId || null, tables: built.map(table => ({ key: table.key, rows: table.rows, columns: table.columns })) }),
  }
}

/** CSV 网格 → 结果表：表头做双语标签，数值列转成数字（编号/文本保留原样）。 */
export function tableFromGrid({ key, columns = [], rows = [], labels = LABELS, types = null, analysisSet = null, nodeId = null, title = null }) {
  const numeric = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/
  const columnsTyped = columns.map(column => ({ key: column, ...labelFor(column, labels) }))
  const objects = rows.map(row => Object.fromEntries(columns.map((column, index) => {
    const raw = row[index] === undefined ? '' : row[index]
    if (raw === '') return [column, null]
    const declared = types && types[column]
    // 引擎声明的列类型优先：编号/组水平保持原文（"001" 不能变成 1），数值列才转数字。
    if (declared === 'string') return [column, raw]
    if (declared === 'number') return [column, numeric.test(raw) ? Number(raw) : raw]
    return [column, numeric.test(raw) ? Number(raw) : raw]
  })))
  const numericKeys = new Set(columns.filter(column => objects.some(row => typeof row[column] === 'number')))
  return { key, columns: columnsTyped, rows: objects, numericKeys: [...numericKeys], types: types || null, analysisSet, nodeId, title }
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

/** 三线表：顶线、表头下线、底线由 CSS 类控制，无竖线。 */
export function renderTableHtml(table, options = {}) {
  const decimals = options.decimals ?? 2
  const declared = options.types || table.types || null
  // 有引擎声明类型时按声明判定数值列；否则退回值推断。避免把编号/组水平当数字。
  const numericColumns = new Set(table.columns.filter(column => declared
    ? declared[column.key] === 'number'
    : table.rows.some(row => {
      const value = row[column.key]
      return typeof value === 'number' || (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)))
    })).map(column => column.key))
  const head = table.columns.map(column => `<th${numericColumns.has(column.key) ? ' class="num"' : ''} scope="col"><span class="zh">${escapeHtml(column.zh)}</span><span class="en">${escapeHtml(column.en)}</span></th>`).join('')
  const body = table.rows.map(row => `<tr>${table.columns.map(column => {
    const value = row[column.key]
    const isNumeric = typeof value === 'number' || (value !== null && value !== '' && Number.isFinite(Number(value)))
    const cell = formatValue(column.key, value, { decimals })
    return `<td${isNumeric ? ' class="num"' : ''}>${escapeHtml(cell)}</td>`
  }).join('')}</tr>`).join('\n')
  const notes = (table.notes || []).map(note => `<p class="note">${escapeHtml(redact(note))}</p>`).join('')
  const meta = [`<span class="meta">分析集：${escapeHtml(table.analysisSet.subset)} · n=${escapeHtml(table.analysisSet.subjects ?? '—')} · 观测=${escapeHtml(table.analysisSet.observations ?? '—')}</span>`,
    `<span class="meta">来源版本：${escapeHtml(String(table.sourceHash || '—').slice(0, 12))}</span>`].join('')
  return [
    `<figure class="table-figure" data-table="${escapeHtml(table.key)}">`,
    `<figcaption><span class="table-no">表 ${table.number}</span> ${escapeHtml(table.title.zh)}<span class="en-title">${escapeHtml(table.title.en)}</span></figcaption>`,
    `<div class="table-meta">${meta}</div>`,
    `<div class="table-scroll"><table class="three-line"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    notes,
    '</figure>',
  ].join('\n')
}

/** 报告段落：只解释真实执行/未执行的内容，不把 partial 写成完整结论。 */
export function reportSections({ meta, results, today = new Date().toISOString().slice(0, 10) }) {
  const nodes = meta?.nodes || {}
  const executed = Object.entries(nodes).filter(([, node]) => node.status === 'executed').map(([name]) => name)
  const notRun = Object.entries(nodes).filter(([, node]) => node.status === 'not_run').map(([name, node]) => `${name}：${node.reason}`)
  const failed = Object.entries(nodes).filter(([, node]) => node.status === 'failed').map(([name, node]) => `${name}：${node.reason}`)
  const cancelled = Object.entries(nodes).filter(([, node]) => node.status === 'cancelled').map(([name, node]) => `${name}：${node.reason}`)
  const diagnostics = []
  const regression = nodes.regression?.result
  if (regression) {
    diagnostics.push(`回归秩 ${regression.rank}/${regression.designColumns}，残差自由度 ${formatNumber(regression.dfResidual, 0)}，条件数 ${formatNumber(regression.conditionNumber, 1)}。`)
    if (regression.rank < regression.designColumns) diagnostics.push('设计矩阵秩亏，结果不可解释，已按失败处理。')
  }
  const mixed = nodes.mixed?.result
  if (mixed) {
    diagnostics.push(`混合模型方法 ${mixed.method}，收敛 ${mixed.converged ? '是' : '否'}，随机截距方差 ${formatNumber(mixed.varianceComponents?.groupVariance, 3)}${mixed.singular ? '（奇异拟合，需谨慎解释）' : ''}。`)
  }
  return [
    {
      key: 'scope',
      title: { zh: '研究与数据截止', en: 'Study and data cut-off' },
      body: `研究：${redact(meta?.study?.name || '未命名研究')}。报告生成于 ${today}；数据截止以本次运行的输入版本为准。`,
    },
    {
      key: 'inputs',
      title: { zh: '输入版本', en: 'Input versions' },
      body: `运行 ${results.runId}；来源 hash ${String(results.sourceHash || '—').slice(0, 16)}；` +
        `分析集 ${results.analysisSet.subset}，独立人数 ${formatValue('subjects', results.analysisSet.subjects)}，观测 ${formatValue('observations', results.analysisSet.observations)}，排除 ${results.analysisSet.excluded} 人。`,
    },
    {
      key: 'flow',
      title: { zh: '样本流', en: 'Sample flow' },
      body: `纳入 ${formatValue('subjects', results.analysisSet.subjects)} 名参与者；已按方案声明排除 ${results.analysisSet.excluded} 人（逐人明细只在本地界面查看，不写入报告）。`,
    },
    {
      key: 'qc',
      title: { zh: '质控与排除', en: 'Quality control and exclusions' },
      body: `已按方案声明排除 ${results.analysisSet.excluded} 人（逐人明细只在本地界面查看，不写入报告）；` +
        `本次运行警告 ${(results.warnings || []).length} 条` +
        ((results.warnings || []).length ? `：${(results.warnings || []).slice(0, 3).map(redact).join('；')}` : '') +
        `；未执行或失败节点 ${notRun.length + failed.length + cancelled.length} 个。` +
        '质控清单（如作答时长、规律作答标记）不在运行快照内，需在录入端单独核对。',
    },
    {
      key: 'methods',
      title: { zh: '分析方法', en: 'Analysis methods' },
      body: `执行节点：${executed.length ? executed.join('、') : '无'}。` +
        (regression?.formula ? `回归公式：${redact(regression.formula)}；平方和类型 ${['', 'I', 'II', 'III'][regression.sumsOfSquares] || regression.sumsOfSquares}。` : '') +
        (mixed?.formula ? `混合模型：${redact(mixed.formula)}（${mixed.method}）。` : ''),
    },
    {
      key: 'results',
      title: { zh: '主要结果', en: 'Main results' },
      body: results.tables.length
        ? `本报告包含 ${results.tables.length} 张表：${results.tables.map(table => `${table.title.zh}（表 ${table.number}）`).join('、')}。数值以表格为准，正文不复述未计算的内容。`
        : '本次运行没有产出表格。',
    },
    {
      key: 'diagnostics',
      title: { zh: '诊断与敏感性', en: 'Diagnostics' },
      body: diagnostics.length ? diagnostics.join(' ') : '本次运行没有模型级诊断输出。',
    },
    {
      key: 'limits',
      title: { zh: '局限与未执行节点', en: 'Limitations and nodes not run' },
      body: [
        notRun.length ? `未执行：${notRun.join('；')}。` : '',
        failed.length ? `失败：${failed.join('；')}。` : '',
        cancelled.length ? `取消：${cancelled.join('；')}。` : '',
        meta?.status && meta.status !== 'ok' ? `运行状态为 ${meta.status}，不能当作完整结论。` : '',
      ].filter(Boolean).join(' ') || '所有声明节点均已执行。',
    },
  ]
}

export const REPORT_CSS = `
:root{--ink:#1f2328;--ink2:#4b5563;--line:#1f2328;--soft:#e5e7eb;--accent:#7c2d12}
*{box-sizing:border-box}
body{margin:0;padding:32px 40px 56px;color:var(--ink);background:#fff;font:15px/1.65 "Source Han Sans SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:18px;margin:28px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--soft)}
p{margin:6px 0}
.meta{color:var(--ink2);font-size:12.5px}
.table-figure{margin:14px 0 22px}
figcaption{font-weight:600;margin-bottom:4px}
.table-no{margin-right:6px}
.en-title{margin-left:8px;color:var(--ink2);font-weight:400;font-size:13px}
.table-meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin:2px 0 8px;color:var(--ink2);font-size:12.5px}
table.three-line{width:100%;border-collapse:collapse;font-size:12.5px;border-top:1.5px solid var(--line);border-bottom:1.5px solid var(--line)}
table.three-line thead th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;font-weight:600;vertical-align:bottom}
table.three-line thead th .en{display:block;font-weight:400;font-size:12px;color:var(--ink2)}
table.three-line thead th.num{text-align:center}
table.three-line td{padding:5px 8px;vertical-align:top}
table.three-line td.num{text-align:center;font-variant-numeric:tabular-nums}
table.three-line tbody tr:nth-child(even){background:#fafafa}
.note{color:var(--ink2);font-size:12.5px;margin:6px 0 0}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
figure.chart{margin:14px 0 22px}
figure.chart svg{display:block;max-width:100%;height:auto}
figure.chart figcaption{color:var(--ink2);font-size:12.5px;margin-top:4px}
:focus-visible{outline:2px solid #1b6ca8;outline-offset:2px}
a{color:#1b6ca8}
footer{margin-top:32px;color:var(--ink2);font-size:12px}
@media (max-width:720px){
  body{padding:16px 14px 40px;font-size:14px}
  h1{font-size:20px}
  h2{font-size:16px}
  table.three-line{font-size:12.5px}
  table.three-line thead th,table.three-line td{padding:4px 6px}
  .table-meta{flex-direction:column;gap:2px}
}
@media (prefers-color-scheme:dark){
  :root{--ink:#e8eaed;--ink2:#a7adb5;--line:#c9ced6;--soft:#3a3f45;--accent:#f0a37a}
  body{background:#17191c;color:var(--ink)}
  table.three-line{border-top-color:var(--line);border-bottom-color:var(--line)}
  table.three-line thead th{border-bottom-color:var(--line)}
  table.three-line tbody tr:nth-child(even){background:#1d2024}
  .table-meta,.note,footer,.meta{color:var(--ink2)}
  :focus-visible{outline-color:#7cc4ff}
  a{color:#7cc4ff}
}
@media print{
  @page{size:A4;margin:18mm 16mm}
  body{padding:0;font-size:10.5pt}
  h2{break-after:avoid}
  figure.table-figure,figure.chart{break-inside:avoid}
  table.three-line{break-inside:auto}
  table.three-line thead{display:table-header-group}
  table.three-line tr{break-inside:avoid}
  table.three-line tbody tr:nth-child(even){background:transparent}
  .table-scroll{overflow:visible}
}
`

/** 生成自包含 HTML 报告：内联样式、无外部资源、无私有路径。 */
export function renderHtmlReport({ meta, results, today }) {
  const sections = reportSections({ meta, results, today })
  const tables = results.tables.map(table => renderTableHtml(table)).join('\n')
  const body = sections.map(section => `<section id="${escapeHtml(section.key)}"><h2>${escapeHtml(section.title.zh)} <span class="meta">${escapeHtml(section.title.en)}</span></h2><p>${escapeHtml(section.body)}</p></section>`).join('\n')
  const warnings = (results.warnings || []).length
    ? `<section id="warnings"><h2>运行警告 <span class="meta">Warnings</span></h2><ul>${results.warnings.map(warning => `<li>${escapeHtml(redact(warning))}</li>`).join('')}</ul></section>`
    : ''
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(`${meta?.study?.name || '研究报告'} · ${results.runId}`)}</title>`,
    `<style>${REPORT_CSS}</style></head><body>`,
    `<h1>${escapeHtml(`${meta?.study?.name || '研究报告'}`)}</h1>`,
    `<p class="meta">运行 ${escapeHtml(results.runId || '—')} · 结果版本 ${escapeHtml(results.version)} · 生成 ${escapeHtml(today || new Date().toISOString().slice(0, 10))}</p>`,
    body,
    warnings,
    `<h2>表格 <span class="meta">Tables</span></h2>`,
    tables || '<p>本次运行没有产出表格。</p>',
    '<footer>本报告由本地模板生成，未调用外部服务；数值以运行目录中的表与模型文件为准，渲染格式不改变原始精度。</footer>',
    '</body></html>',
  ].join('\n')
}

/** 产物清单：每份产物都带 runId/nodeIds/hash/媒体类型与渲染环境。 */
export function artifactManifest({ results, artifacts = [], renderer = `node/${process.version}`, createdAt = new Date().toISOString() }) {
  return {
    schemaVersion: 1,
    resultsVersion: RESULTS_VERSION,
    runId: results.runId,
    nodeIds: results.nodeIds,
    sourceHash: results.sourceHash,
    createdAt,
    renderer,
    presentationRevision: 1,
    artifacts: artifacts.map(item => ({
      mediaType: item.mediaType,
      relativePath: item.relativePath,
      sha256: item.sha256,
      runId: results.runId,
      nodeIds: item.nodeIds || results.nodeIds,
      createdAt,
      renderer,
    })),
  }
}
