/**
 * 05 自动调度 seam 回归（A03/A04/A05）。
 *
 * 只测 scheduler.mjs：用假时钟注入 setTimeoutFn/setIntervalFn，
 * 不加载插件、不写真实研究数据、不启动真实定时器。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createScheduler, requestedKey } from '../../analysis-run/scheduler.mjs'

const flush = async () => { for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve)) }

/** 可以推进、查询、清空的假时钟；只实现 scheduler 用到的四个计时 API。 */
class FakeClock {
  constructor() { this.now = 0; this.nextId = 1; this.timers = new Map() }
  setTimeout(fn, ms) {
    const id = this.nextId += 1
    this.timers.set(id, { fn, at: this.now + Math.max(0, Number(ms) || 0), every: 0 })
    return id
  }
  setInterval(fn, ms) {
    const every = Math.max(1, Number(ms) || 1)
    const id = this.nextId += 1
    this.timers.set(id, { fn, at: this.now + every, every })
    return id
  }
  clearTimeout(id) { this.timers.delete(id) }
  clearInterval(id) { this.timers.delete(id) }
  count() { return this.timers.size }
  async advance(ms) {
    const target = this.now + Math.max(0, Number(ms) || 0)
    for (;;) {
      let selected = null
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue
        if (!selected || timer.at < selected.timer.at || (timer.at === selected.timer.at && id < selected.id)) selected = { id, timer }
      }
      if (!selected) break
      this.now = selected.timer.at
      if (selected.timer.every) selected.timer.at += selected.timer.every
      else this.timers.delete(selected.id)
      selected.timer.fn()
      await flush()
    }
    this.now = target
  }
}

function timers(clock) {
  return {
    setTimeoutFn: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeoutFn: id => clock.clearTimeout(id),
    setIntervalFn: (fn, ms) => clock.setInterval(fn, ms),
    clearIntervalFn: id => clock.clearInterval(id),
  }
}

function makeStudy(id, outputDir) {
  return {
    cfg: { outputDir, labDir: outputDir, pythonPath: 'python' },
    context: {
      id,
      configured: true,
      dataRoot: `C:/fake/${id}/data`,
      identity: { id, name: id, dataRoot: `C:/fake/${id}/data` },
    },
  }
}

const planV1 = { source: { type: 'core' }, analyses: ['descriptives'], outcome: 'y', dataPath: 'core:derived' }
const planV2 = { ...planV1, analyses: ['descriptives', 'ttest'] }

test('A03-A 同一 dataset 上 plan 变了触发一次 run；plan 不变不触发', async () => {
  const clock = new FakeClock()
  const studyState = makeStudy('A', 'C:/fake/A/analysis')
  let plan = planV1
  let autoState = { requestedKey: 'stale-key' }
  const written = []
  const calls = []
  const latest = { plan: planV1, dataset: { hash: 'dataset-v1' } }

  const scheduler = createScheduler({
    config: { debounceMs: 100 },
    current: () => studyState,
    run: async (payload, state) => { calls.push({ payload, state }); return { ok: true } },
    analysis: {
      planFor: async () => plan,
      runs: async () => [{ runId: 'run-1' }],
      latestMeta: async () => latest,
      dataset: async () => ({ hash: 'dataset-v1' }),
      instanceId: async () => 'instance-1',
      blocked: () => false,
    },
    readAutoState: async () => ({ ...autoState }),
    writeAutoState: async (cfg, value) => { written.push({ cfg, value }); autoState = { ...value } },
    ...timers(clock),
  })

  // 数据 hash 与最新 run 相同、plan 也相同：不排任务。
  await scheduler.tick()
  assert.equal(scheduler.state().pending, false, 'plan 与数据都没变时不应排队')
  assert.equal(calls.length, 0)
  assert.equal(clock.count(), 0, '不应创建 debounce timer')

  // 只改 plan：dataset hash 仍是 dataset-v1，但完整指纹变了。
  plan = planV2
  await scheduler.tick()
  assert.equal(scheduler.state().pending, true, 'plan 变化应排队一次')
  assert.equal(scheduler.state().requestedKey, requestedKey({ studyId: 'A', plan: planV2, datasetHash: 'dataset-v1' }))

  await clock.advance(100)
  assert.equal(calls.length, 1, '去抖结束后只运行一次')
  assert.equal(calls[0].state, studyState, 'run 必须收到 tick 捕获的 state')
  assert.equal(written.length, 1)
  assert.equal(written[0].cfg.outputDir, 'C:/fake/A/analysis')
  assert.equal(written[0].value.requestedKey, requestedKey({ studyId: 'A', plan: planV2, datasetHash: 'dataset-v1' }), '成功运行写回的键必须是完整指纹')

  // 方案保持 planV2：auto-state 的键已匹配，再 tick 不再触发。
  await scheduler.tick()
  assert.equal(scheduler.state().pending, false)
  assert.equal(calls.length, 1, 'plan 不变时不得再触发 run')
  scheduler.dispose()
})

test('A03-B run 失败后暂停；plan 变化（指纹变）后恢复触发', async () => {
  const clock = new FakeClock()
  const studyState = makeStudy('A', 'C:/fake/A/analysis')
  let plan = planV1
  let fail = true
  let runCount = 0
  const autoState = {}

  const scheduler = createScheduler({
    config: { debounceMs: 100 },
    current: () => studyState,
    run: async () => {
      runCount += 1
      if (fail) throw new Error('boom')
      return { ok: true }
    },
    analysis: {
      planFor: async () => plan,
      runs: async () => [],
      latestMeta: async () => null,
      dataset: async () => ({ hash: 'dataset-v1' }),
      instanceId: async () => 'instance-1',
      blocked: () => false,
    },
    readAutoState: async () => ({ ...autoState }),
    writeAutoState: async (_cfg, value) => { Object.assign(autoState, value) },
    ...timers(clock),
  })

  await scheduler.tick()
  assert.equal(scheduler.state().pending, true)
  await clock.advance(100)
  assert.equal(runCount, 1)
  assert.equal(scheduler.state().error, 'boom')
  assert.equal(scheduler.state().pending, false)
  assert.equal(scheduler.state().pausedKey, requestedKey({ studyId: 'A', plan: planV1, datasetHash: 'dataset-v1' }), '暂停键必须是完整 requestedKey')

  // 同一 plan / 同一数据：暂停键命中，不再排任务。
  await scheduler.tick()
  assert.equal(scheduler.state().pending, false)
  await clock.advance(100)
  assert.equal(runCount, 1, '失败暂停后相同指纹不得重试')

  // 改 plan → 指纹变化 → 恢复。
  plan = planV2
  fail = false
  await scheduler.tick()
  assert.equal(scheduler.state().pending, true, 'plan 变化后应从暂停中恢复')
  await clock.advance(100)
  assert.equal(runCount, 2)
  assert.equal(scheduler.state().pausedKey, null)
  assert.equal(scheduler.state().error, '')
  scheduler.dispose()
})

test('A04-A dispose 取消已排队的 debounce；只有新实例能继续工作', async () => {
  const clock = new FakeClock()
  const studyState = makeStudy('A', 'C:/fake/A/analysis')
  const calls = []

  const build = () => createScheduler({
    config: { autoRun: true, debounceMs: 100, autoPollMs: 1000 },
    current: () => studyState,
    run: async (payload, state) => { calls.push({ payload, state }); return { ok: true } },
    analysis: {
      planFor: async () => planV1,
      runs: async () => [],
      latestMeta: async () => null,
      dataset: async () => ({ hash: 'dataset-v1' }),
      instanceId: async () => 'instance-1',
      blocked: () => false,
    },
    readAutoState: async () => ({}),
    writeAutoState: async () => {},
    ...timers(clock),
  })

  const first = build()
  assert.equal(first.state().started, true)
  await clock.advance(50) // 初始 timeout 触发 tick，tick 排 debounce
  assert.equal(first.state().pending, true)
  assert.equal(calls.length, 0)

  first.dispose()
  assert.equal(first.state().disposed, true)
  assert.equal(first.state().pending, false)
  assert.equal(clock.count(), 0, 'dispose 后不应留下 interval/timeout/debounce')

  await clock.advance(5000)
  assert.equal(calls.length, 0, 'dispose 后推进时钟不得运行任务')
  assert.equal(clock.count(), 0, 'dispose 后不得再创建 timer')
  await first.tick()
  assert.equal(first.state().pending, false, 'dispose 后 tick 不得启动任务')
  assert.equal(calls.length, 0)

  // 旧实例已作废；新实例重新启用后照常排队并运行。
  const second = build()
  await clock.advance(50)
  assert.equal(second.state().pending, true)
  await clock.advance(100)
  assert.equal(calls.length, 1, '新实例应重新工作')
  assert.equal(calls[0].state, studyState)
  second.dispose()
})

test('A05-A 排队后切到 B：回调仍只用排队时捕获的 A（cfg.outputDir 与 context）', async () => {
  const clock = new FakeClock()
  const studyA = makeStudy('A', 'C:/fake/A/analysis')
  const studyB = makeStudy('B', 'C:/fake/B/analysis')
  let active = studyA
  const reads = []
  const writes = []
  const calls = []
  const autoState = {}

  const scheduler = createScheduler({
    config: { debounceMs: 100 },
    current: () => active,
    run: async (payload, state) => { calls.push({ payload, state }); return { ok: true } },
    analysis: {
      planFor: async cfg => (cfg.outputDir.includes('/A/') ? planV1 : planV2),
      runs: async () => [],
      latestMeta: async () => null,
      dataset: async () => ({ hash: 'dataset-a' }),
      instanceId: async () => 'instance-a',
      blocked: () => false,
    },
    readAutoState: async cfg => { reads.push(cfg); return { ...autoState } },
    writeAutoState: async (cfg, value) => { writes.push({ cfg, value }); Object.assign(autoState, value) },
    ...timers(clock),
  })

  await scheduler.tick() // 在 A 上排队
  assert.equal(scheduler.state().pending, true)
  active = studyB // 排队后切到 B

  await clock.advance(100)
  assert.equal(calls.length, 1, '排队任务必须执行一次')
  assert.equal(calls[0].state, studyA, 'run 收到的必须是 A 的捕获快照')
  assert.equal(calls[0].state.cfg.outputDir, 'C:/fake/A/analysis', '不得使用 B 的 outputDir')
  assert.equal(calls[0].state.context.identity.id, 'A')
  assert.equal(reads.at(-1).outputDir, 'C:/fake/A/analysis', 'auto-state 读写也必须用 A 的 cfg')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].cfg.outputDir, 'C:/fake/A/analysis')
  assert.equal(writes[0].value.requestedKey, requestedKey({ studyId: 'A', plan: planV1, datasetHash: 'dataset-a' }))
  scheduler.dispose()
})
