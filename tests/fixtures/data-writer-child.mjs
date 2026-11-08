/**
 * 子进程夹具：模拟另一个宿主进程在写/持锁/崩溃，用于 DATA-01 与遗留锁恢复。
 * 父进程用环境变量传项目路径与模式，子进程只输出一行 JSON。
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { openResearchData } from '../../data.mjs'

const studyPath = process.env.DATA_STUDY_PATH
const study = {
  id: process.env.DATA_STUDY_ID,
  path: studyPath,
  dataRoot: path.join(path.dirname(studyPath), 'data'),
  baseDir: path.dirname(studyPath),
  plugin: {},
}
const data = openResearchData({ study, instanceId: process.env.DATA_INSTANCE })
const mode = process.env.DATA_MODE

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 忽略 */ }
}

function output(value) { process.stdout.write(JSON.stringify(value)) }

if (mode === 'hold') {
  const lock = data.lock('demographics', { owner: 'child-A', timeoutMs: 300 })
  writeFileSync(process.env.DATA_MARKER, JSON.stringify({ at: Date.now(), transactionId: lock.transactionId }))
  sleep(1200)
  lock.release()
  output({ released: true })
} else if (mode === 'try') {
  try {
    const result = data.commit('demographics', { writer: process.env.DATA_WRITER || mode }, { owner: `child-${process.env.DATA_WRITER || 'B'}`, timeoutMs: 300 })
    output({ ok: true, revision: result.revision, generationId: result.generationId })
  } catch (error) {
    output({ ok: false, code: error.code, retryable: error.retryable, committed: error.committed })
  }
} else if (mode === 'die-holding') {
  const lock = data.lock('demographics', { owner: 'child-dead', timeoutMs: 300 })
  writeFileSync(process.env.DATA_MARKER, JSON.stringify({ at: Date.now(), transactionId: lock.transactionId }))
  // 故意不释放，模拟写进程崩溃。
  output({ ok: true, held: true })
  process.exit(0)
} else {
  output({ ok: false, code: 'unknown_mode' })
}
