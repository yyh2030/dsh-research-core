/**
 * 分析直通客户端渲染冒烟：把 Panel 用最小 React 替身渲染一遍，覆盖向导编辑态。
 * 目的：页面空白通常是渲染期抛错，node --check 抓不到。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

function shim() {
  const frames = []
  const forced = { values: null }
  function render(node) {
    if (node === null || node === undefined || node === false || node === true) return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { for (const child of node) render(child); return }
    if (typeof node !== 'object' || !node.type) throw new Error('意外的节点：' + String(node))
    const { type, props, children } = node
    if (typeof type === 'function') {
      if (type.prototype && typeof type.prototype.render === 'function') {
        const instance = new type(props)
        if (type.getDerivedStateFromError) instance.state = { ...(instance.state || {}), error: null }
        render(instance.render())
        return
      }
      frames.push({ forced: frames.length === 0 ? forced.values : null, index: 0 })
      try { render(type(props)) } finally { frames.pop() }
      return
    }
    for (const child of children) render(child)
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    Fragment: Symbol('Fragment'),
    Component: class { constructor(props) { this.props = props; this.state = {} } },
    useState(initial) {
      const frame = frames[frames.length - 1]
      const list = frame && frame.forced
      let value = initial
      if (list && frame.index < list.length) value = list[frame.index]
      if (frame) frame.index += 1
      return [value, () => {}]
    },
    useEffect() {},
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useRef(initial) { return { current: initial } },
    useLayoutEffect() {},
    useReducer(reducer, initial) { return [initial, () => {}] },
    useImperativeHandle() {},
    useDebugValue() {},
  }
  return { React, render, forced }
}

function loadClient() {
  const source = readFileSync('D:/dsh-plugins/analysis-run/client.js', 'utf8')
  let spec
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { spec = value } }, crypto: { getRandomValues: () => {} }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { createElement: () => ({ remove() {} }), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, sandbox)
  return spec
}

const status = {
  study: { id: 'local-private-research', name: '本机私有研究', dataRoot: 'D:/yyh-lab', revision: 'abc' },
  mode: 'generic', binding: null, busy: null, pendingChanges: false, planRevision: '1', exclusionsRevision: '1',
  modules: [{ id: 'descriptives', label: '描述统计' }, { id: 'regression', label: '组间回归 / ANCOVA' }],
  runs: [], exclusions: [], backends: {}, python: { configured: true }, paths: { outputDir: 'D:/yyh-lab/analysis' },
  source: { columns: ['subjectid', 'AUC_T2', 'AUC_T0', 'salience', 'intervention'] },
  plan: { dataPath: 'D:/yyh-lab/analysis/merged/dataset.csv', idColumn: 'subjectid', outcome: 'AUC_T2', layout: 'wide', groupColumns: ['salience'], covariates: ['AUC_T0'], analyses: ['descriptives', 'regression'] },
}

test('分析直通：向导编辑态与结果态都能渲染', () => {
  const { React, render, forced } = shim()
  const spec = loadClient()
  const app = spec.factory(name => {
    if (name === 'react') return React
    throw new Error('未知模块：' + name)
  })
  let panel, slots = {}
  const ctx = {
    effect: fn => fn(),
    slots: { inject: (name, fn) => fn(), register: (meta, renderFn) => { if (meta.key === 'analysis-run') panel = renderFn } },
  }
  app.apply(ctx)
  assert.ok(panel, '没有注册主面板')

  const cases = [
    { name: '结果态（无运行）', values: [status, null, status.plan, '', 'tables', '', false, '', '', '', '', '', 'results', false, null, false, null] },
    { name: '向导编辑态', values: [status, null, status.plan, '', 'tables', '', false, '', '', '', '', '', 'plan', true, null, false, null] },
    { name: '自定义脚本编辑态', values: [status, null, { ...status.plan, analyses: ['script'], script: { code: 'save("x", pd.DataFrame({"n": [1]}))' } }, '', 'tables', '', false, '', '', '', '', '', 'plan', true, null, false, null] },
  ]
  for (const item of cases) {
    forced.values = item.values
    assert.doesNotThrow(() => render(panel()), item.name)
  }
})
