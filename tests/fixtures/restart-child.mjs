/**
 * 子进程夹具：在一个独立 Node 进程里连接或解析研究绑定。
 * 父子进程不共享内存，只能通过磁盘上的研究核心存储交换状态，
 * 因此它是"宿主重启后还能恢复"的真实进程边界证据。
 */
import { researchCore } from '../../index.mjs'

const core = researchCore({
  storeDir: process.env.RELAY_STORE,
  workspaces: [{ id: 'wa', path: process.env.RELAY_WSA }],
})

const mode = process.env.RELAY_MODE
const workspace = process.env.RELAY_WSA
const studyFile = process.env.RELAY_FILEA

if (mode === 'connect') {
  const page = core.connect({ kind: 'page', pageId: 'page-restart01' }, { studyPath: studyFile })
  const agent = core.connect({ kind: 'agent', sessionId: 's-restart', cwd: workspace }, { studyPath: studyFile })
  process.stdout.write(JSON.stringify({
    pageToken: page.token,
    pageInstance: page.instanceId,
    pageRevision: page.bindingRevision,
    agentInstance: agent.instanceId,
  }))
} else {
  const page = core.resolve({ kind: 'page', pageId: 'page-restart01' })
  const newcomer = core.resolve({ kind: 'agent', sessionId: 's-newcomer', cwd: workspace })
  process.stdout.write(JSON.stringify({
    state: page.state,
    token: page.token,
    instanceId: page.instanceId,
    revision: page.bindingRevision,
    studyId: page.studyId,
    newcomerState: newcomer.state,
    newcomerStudyId: newcomer.studyId,
    newcomerSource: newcomer.source,
  }))
}
