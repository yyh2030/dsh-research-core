/**
 * 09 B01：干净临时目录安装/解包后，插件不再依赖 D:/dsh-plugins 相邻源码。
 * 复制 research-core 与 analysis-run 到临时目录，用 node_modules/@local/research-core
 * （junction，等价 npm 安装后的目录布局）解析包名导入，真实 import 两个入口。
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

test('B01 干净目录 + 包名依赖可加载核心与业务插件', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-r09-'))
  try {
    cpSync('D:/dsh-plugins/research-core', path.join(root, 'research-core'), { recursive: true })
    cpSync('D:/dsh-plugins/analysis-run', path.join(root, 'analysis-run'), { recursive: true })
    rmSync(path.join(root, 'analysis-run', 'node_modules'), { recursive: true, force: true })
    mkdirSync(path.join(root, 'node_modules', '@local'), { recursive: true })
    symlinkSync(path.join(root, 'research-core'), path.join(root, 'node_modules', '@local', 'research-core'), 'junction')

    const plugin = await import(pathToFileURL(path.join(root, 'analysis-run', 'index.js')).href)
    const core = await import(pathToFileURL(path.join(root, 'research-core', 'analysis.mjs')).href)
    assert.equal(plugin.name, 'analysis-run')
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(typeof core.openAnalysis, 'function')

    // 业务插件清单声明了核心依赖，且源码不再出现 ../research-core 相对导入
    const manifest = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(path.join(root, 'analysis-run', 'package.json'), 'utf8')))
    assert.equal(manifest.dependencies['@local/research-core'], 'file:../research-core')
    const source = await import('node:fs').then(fs => fs.readFileSync(path.join(root, 'analysis-run', 'index.js'), 'utf8'))
    assert.doesNotMatch(source, /\.\.\/research-core\//)
    assert.match(source, /@local\/research-core/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
