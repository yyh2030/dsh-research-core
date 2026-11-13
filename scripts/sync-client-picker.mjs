/**
 * 把 client-study-picker.mjs 的浏览器实现同步进四个插件 client bundle。
 * 与 sync-client-identity.mjs 相同：手写 bundle 无构建步骤，用预置段共享。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')
const sourcePath = path.join(root, 'research-core', 'client-study-picker.mjs')
const clients = [
  path.join(root, 'study-ops', 'client.js'),
  path.join(root, 'scale-desk', 'client.js'),
  path.join(root, 'demographic-coder', 'client.js'),
  path.join(root, 'analysis-run', 'client.js'),
]
const BEGIN = '// #region browser-picker'
const END = '// #endregion browser-picker'
const MARK_BEGIN = '/* @dsh-generated: study-picker prelude begin */'
const MARK_END = '/* @dsh-generated: study-picker prelude end */'

const source = readFileSync(sourcePath, 'utf8')
const start = source.indexOf(BEGIN)
const end = source.indexOf(END)
if (start < 0 || end < 0) throw new Error('client-study-picker.mjs 缺少 browser-picker 标记')
const core = source.slice(start + BEGIN.length, end).trimEnd()

const prelude = `${MARK_BEGIN}
;(function (global) {
  if (global.__DSH_RESEARCH_PICKER__) return
${core}
  global.__DSH_RESEARCH_PICKER__ = DSH_RESEARCH_PICKER
})(typeof window !== 'undefined' ? window : globalThis)
${MARK_END}
`

for (const file of clients) {
  const text = readFileSync(file, 'utf8')
  const existingStart = text.indexOf(MARK_BEGIN)
  const existingEnd = text.indexOf(MARK_END)
  let next
  if (existingStart >= 0 && existingEnd > existingStart) {
    next = text.slice(0, existingStart) + prelude + text.slice(existingEnd + MARK_END.length)
    next = next.replace(new RegExp(MARK_END + '\\n\\n+'), MARK_END + '\n')
  } else {
    const anchor = text.indexOf('window.__ModuleLoader__.load')
    if (anchor < 0) throw new Error(`找不到 __ModuleLoader__.load：${file}`)
    next = text.slice(0, anchor) + prelude + '\n' + text.slice(anchor)
  }
  writeFileSync(file, next, 'utf8')
  console.log('synced picker', path.relative(root, file))
}
