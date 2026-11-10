/**
 * 05 阶段回归：脚本快照进入指纹与缓存产物校验（A01/A02）。
 * 全部合成临时研究；脚本使用引擎自带 SCRIPT_RUNNER。
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

function engine(request) {
  const result = spawnSync(PYTHON, ['-X', 'utf8', ENGINE, '--request-json', JSON.stringify(request)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const marker = String(result.stdout).lastIndexOf('===JSON===')
  if (marker < 0) throw new Error('引擎没有返回结果：' + String(result.stderr).slice(-500))
  return JSON.parse(result.stdout.slice(marker + 10))
}

function fixture(rows, header) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rc-r05-'))
  const csv = path.join(root, 'data.csv')
  writeFileSync(csv, [header.join(','), ...rows].join('\n') + '\n')
  return { root, csv }
}

function run(csv, plan, extra = {}) {
  const outputDir = path.join(path.dirname(csv), extra.name || 'out')
  mkdirSync(outputDir, { recursive: true })
  return engine({ action: 'run', study: { id: 'synthetic', name: 'synthetic' }, plan: { dataPath: csv, idColumn: 'id', outcome: 'y', layout: 'wide', groupColumns: [], covariates: [], pairedColumns: [], gate: { minSubjects: 2 }, ...plan }, outputDir, exclusions: [], ...extra })
}

const scriptText = value => `import pandas as pd\nsave("result", pd.DataFrame({"value": [${value}]}))\n`

test('A01-A 外部脚本内容进入指纹：输出改 999 后必须新 run', () => {
  const { root, csv } = fixture(['1,1', '2,2', '3,3'], ['id', 'y'])
  const script = path.join(root, 'custom.py')
  writeFileSync(script, scriptText(1))
  const plan = { analyses: ['script'], script: { file: script } }
  const first = run(csv, plan, { name: 'a01' })
  assert.equal(first.ok, true, JSON.stringify(first).slice(0, 400))
  assert.equal(first.reused, undefined)
  const firstTable = readFileSync(path.join(first.runDir, 'tables', 'script.csv'), 'utf8')
  assert.match(firstTable, /^1\r?$/m)

  writeFileSync(script, scriptText(999))
  const second = run(csv, plan, { name: 'a01' })
  assert.equal(second.ok, true)
  assert.equal(second.reused, undefined, '脚本改了不能复用旧缓存')
  assert.notEqual(second.runId, first.runId)
  const secondTable = readFileSync(path.join(second.runDir, 'tables', 'script.csv'), 'utf8')
  assert.match(secondTable, /^999\r?$/m)

  // 本次执行使用的是快照 content，原文件后续再改不影响第一次快照
  const snapshot = readFileSync(path.join(first.runDir, 'code', 'custom.py'), 'utf8')
  assert.match(snapshot, /\[1\]/, '第一次快照必须保存脚本字节')
  const meta = JSON.parse(readFileSync(path.join(first.runDir, 'meta.json'), 'utf8'))
  assert.ok(meta.fingerprint, 'fingerprint 必须存在')
})

test('A01-B 快照内容与指纹一致：同一文件同内容才复用', () => {
  const { root, csv } = fixture(['1,1', '2,2', '3,3'], ['id', 'y'])
  const script = path.join(root, 'same.py')
  writeFileSync(script, scriptText(5))
  const plan = { analyses: ['script'], script: { file: script } }
  const first = run(csv, plan, { name: 'a01b' })
  const second = run(csv, plan, { name: 'a01b' })
  assert.equal(second.reused, true, '同内容同方案应复用缓存')
  assert.equal(second.runId, first.runId)
})

test('A02-A 表产物被删除后不复用坏缓存，新 run 可成功', () => {
  const { csv } = fixture(['1,1', '2,2', '3,3'], ['id', 'y'])
  const plan = { analyses: ['descriptives'] }
  const first = run(csv, plan, { name: 'a02a' })
  assert.equal(first.ok, true)
  const tablePath = path.join(first.runDir, 'tables', 'descriptives.csv')
  readFileSync(tablePath)
  writeFileSync(tablePath, '') // 模拟被删/截断

  const second = run(csv, plan, { name: 'a02a' })
  assert.equal(second.ok, true)
  assert.equal(second.reused, undefined, '产物损坏不得返回 reused')
  assert.notEqual(second.runId, first.runId)
  const rebuilt = readFileSync(path.join(second.runDir, 'tables', 'descriptives.csv'), 'utf8')
  assert.match(rebuilt, /mean/)
})

test('A02-B 默认复用；forceRecompute 产生新 run', () => {
  const { csv } = fixture(['1,1', '2,2', '3,3'], ['id', 'y'])
  const plan = { analyses: ['descriptives'] }
  const first = run(csv, plan, { name: 'a02b' })
  const cached = run(csv, plan, { name: 'a02b' })
  assert.equal(cached.reused, true)
  assert.equal(cached.runId, first.runId)
  const forced = run(csv, plan, { name: 'a02b', forceRecompute: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.reused, undefined)
  assert.notEqual(forced.runId, first.runId)
})
