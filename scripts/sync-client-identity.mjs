/**
 * 把 client-identity.mjs 的浏览器实现同步进四个插件 client bundle。
 *
 * 浏览器的 `__ModuleLoader__` 只分发启动图里的包，不能 require 一个不在
 * 图里的 ESM；四个 client.js 又是手写 bundle，没有构建步骤。因此共享逻辑
 * 以预置段原样嵌入（四个 bundle 共用同一个 window 单例），源文件仍是
 * research-core/client-identity.mjs，测试会核对两边一致。
 *
 * 运行：node research-core/scripts/sync-client-identity.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', '..')
const sourcePath = path.join(root, 'research-core', 'client-identity.mjs')
const clients = [
  path.join(root, 'study-ops', 'client.js'),
  path.join(root, 'scale-desk', 'client.js'),
  path.join(root, 'demographic-coder', 'client.js'),
  path.join(root, 'analysis-run', 'client.js'),
]
const BEGIN = '// #region browser-core'
const END = '// #endregion browser-core'
const MARK_BEGIN = '/* @dsh-generated: client-identity prelude begin */'
const MARK_END = '/* @dsh-generated: client-identity prelude end */'

const source = readFileSync(sourcePath, 'utf8')
const start = source.indexOf(BEGIN)
const end = source.indexOf(END)
if (start < 0 || end < 0) throw new Error('client-identity.mjs 缺少 browser-core 标记')
const core = source.slice(start + BEGIN.length, end).trimEnd()

const prelude = `${MARK_BEGIN}
;(function (global) {
  if (global.__DSH_RESEARCH_CLIENT_IDENTITY__) return
${core}
  global.__DSH_RESEARCH_CLIENT_IDENTITY__ = DSH_RESEARCH_CLIENT_IDENTITY
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
    // 去掉替换后可能留下的空行
    next = next.replace(new RegExp(MARK_END + '\\n\\n+'), MARK_END + '\n')
  } else {
    // 插到 bundle 首个 `window.__ModuleLoader__.load` 之前；保留文件头注释。
    const anchor = text.indexOf('window.__ModuleLoader__.load')
    if (anchor < 0) throw new Error(`找不到 __ModuleLoader__.load：${file}`)
    next = text.slice(0, anchor) + prelude + '\n' + text.slice(anchor)
  }
  writeFileSync(file, next, 'utf8')
  console.log('synced', path.relative(root, file))
}
