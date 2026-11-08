# @local/research-core

本地研究核心（Host 侧，无界面）。它回答两个问题：

1. **这次调用属于哪个研究？** → 研究身份与绑定（01 阶段，`index.mjs` / `host.mjs`）。
2. **这份数据属于哪个实例、哪一个已提交版本、谁在写、坏了没有？** → 统一数据访问层与隐私边界
   （02 阶段，`data.mjs` / `privacy.mjs`）。

版本：1.1.0 · 01 阶段交付身份与绑定，02 阶段交付数据核心与隐私边界。

## 为什么需要它

改造前四个插件共用一个 profile 级"唯一活动研究"：任一插件的 `connect()` 会把全部插件一起切走，
页面只带一份全局版本号。结果是两个工作区不能并行、旧页面可能读到/写到别的页面刚切过去的研究。

核心把"研究"从一个全局变量改成**调用身份上的绑定**：

- 页面（浏览器标签页）有一个 `pageId`，显式连接后持有自己的绑定令牌；
- 会话（Agent 工具调用）按 `sessionId` 绑定，并用该会话 cwd 推断工作区；
- 后台任务使用自己保存的 `instanceId`；
- 切换研究只影响发起切换的那个页面或会话。

## 身份分层

| 名称 | 含义 | 谁产生 |
|---|---|---|
| `studyId` | 研究逻辑标识，搬家可保留 | 研究定义 JSON |
| `instanceId` | 本地数据实例身份；同一目录的别名视为同一实例，克隆到新路径则是新实例 | 核心的实例登记表 |
| `studyRevision` | 研究定义内容 hash（sha256 前 32 位）；配置改动即变化 | 每次读取定义时计算 |
| `bindingRevision` | 该页面/会话/工作区的绑定代次；换成另一个研究时 +1 | 显式连接时更新 |
| `dataRevision` | 数据集版本；各插件仍用自己既有的数据集 hash/版本比较，不与配置版本混用 | 插件 |

canonical 路径用 `realpath` 最长存在前缀解析，再在 Windows 上统一小写做键，
所以 junction／符号链接／大小写拼写不会把同一目录当成两个研究。

## 解析顺序

按 01 文档第 2 节：

1. 页面/会话自己的显式绑定记录；
2. 会话 cwd 所属已登记工作区的绑定记录；
3. 会话 cwd 下的约定项目配置（`.dsh/study.json`、`study.json`、`_lab/study.json`），只读候选；
4. 插件 profile 配置里的旧 `studyPath`，标记为「旧配置来源」，仅作首次接入候选；
5. 以上都没有 → 空研究（`state: 'empty'`），界面显示空白并可接入。

**只读解析不写盘。** 只有显式连接，或第一次写入一个候选研究时，才落地绑定记录。

## 绑定令牌

```
rc1.<instanceId>.<scopeHash>.<bindingRevision>.<studyRevision前16位>
```

- 页面写入必须携带令牌。令牌属于别的页面、绑定代次过期、研究定义被外部改动，都返回
  `binding_conflict`（HTTP 409），**不会**自动改写到另一个研究。
- 页面没有令牌 → `binding_required`（409）。
- 绑定的研究定义文件消失 → `study_missing`（409）。
- 会话（工具调用）由宿主按 `Agent.id` 认证身份，不需要令牌；请求里带 `studyId/studyRevision`
  时只做一致性核对，不能用来冒充别的会话。

## 插件接入

```js
import { hostBinding } from '../research-core/host.mjs'

const binding = hostBinding(ctx, {
  plugin: 'study-ops',
  version: '0.3.0',
  config,
  hooks: {
    loadStudy: studyPath => loadStudyContext({ studyPath }, { pluginKey: 'ops' }),
    currentIdentity: () => ({ studyId, studyPath, dataRoot, revision }),
    prepareSwitch: studyPath => ({ commit, rollback }),  // 同步；切换失败必须能回滚
    busy: () => busy > 0,                                // 有写入/计算时禁止被切走
    emptyBase: () => process.cwd(),                      // 未配置研究的默认根（可选）
  },
})
binding.dispatch(ctx)                                    // 卸载时注销插件登记

// 读：解析 + 必要时切换到该身份的研究，再执行
const { binding: view, data } = await binding.read(actor, () => readAction())

// 写：先校验令牌/版本，再执行
const { binding: view, data } = await binding.write(actor, { token }, () => writeAction())

// 长任务：切换在锁内，执行在锁外；capture 在锁内捕获插件状态
await binding.write(actor, expected, (_view, state) => longRun(state), { holdLock: false, capture: () => current() })

// 显式连接/创建（UI 与工具同一实现）
const view = binding.connect(actor, { studyPath })   // 或 { studyPath, create: true, definition }
await binding.activate(actor)
```

同一进程里所有插件共享一份核心实例（`globalThis[Symbol.for('dsh.research.core.v1')]`），
所以插件加载顺序不影响结果，也不需要额外的 profile 行。

### 并发

核心用一个进程内队列串行化"解析 → 切换 → 执行"。插件同一时间只加载一个研究，
但下一次请求由调用身份决定加载哪一个。长任务（本地分析）在锁外执行，
期间插件的 `busy()` 阻止别的页面把它切走；插件的写入本身由各自的数据集版本比较保护。

## 持久记录

默认 `%DSH_HOME%\storages\research-core\`：

| 文件 | 内容 |
|---|---|
| `instances.json` | instanceId ↔ canonical 研究配置路径、studyId、名称、首次/最近时间 |
| `bindings.json` | `page:<pageId>`、`session:<sessionId>`、`workspace:<pathKey>` → 研究路径、instanceId、bindingRevision、来源 |

均为原子重命名写入；`DSH_RESEARCH_STORE` 可把目录改到别处（验收测试用）。

## 这不是什么

- 不是 Cordis Service，不新增第五个界面；
- 不做统计、不改研究数据；
- 不迁移既有私有研究（那是 08 阶段）；
- 跨进程只做原子文件写入，不做分布式锁。

## 02：本地数据核心（`data.mjs`）

```js
import { openResearchData } from '../research-core/data.mjs'

const data = openResearchData({ study, instanceId })   // study 是 loadStudyContext 的结果
data.read('demographics')                              // { value, revision, contentHash, health }
data.commit('demographics', value, {
  owner: 'demographic-coder',
  expectedRevision: readBack.contentHash,              // 读后写：版本不符返回 dataset_conflict
  corrects: previousGenerationId,                      // 修正写新代，不覆盖旧代
  inputs: [{ dataset: 'participants', revision: 'sha256:…' }],
  mirrors: [{ relativePath: 'demographics/demographics.csv', text: csvText, role: 'csv' }],
})
data.history('demographics')   // 代次历史（含 corrects / inputs）
data.changesSince(seq)         // durable 变化记录
data.health()                  // 每个数据集的来源健康
data.recoverPreview() / data.recover()
data.backup(dir) / data.restorePreflight(folder) / data.restore(folder)
```

### 目录与提交模型

```
<dataRoot>/
  study-instance.json              # 实例认领：studyId + instanceId
  generations/<dataset>/
    g000001-<hash8>/{manifest.json,data.json,…}
    current.json                   # 唯一的提交边界（原子重命名写入）
  transactions/                    # staging 与锁；stale/ 归档
  audit/changes.json               # durable 变化记录
  participants/ demographics/ observations/ tasks/   # 兼容平面文件（可重建，非权威）
```

- `revision` 是递增代次，不看 mtime；`contentHash` 是数据字节的 sha256。
- 提交顺序：校验 → staging → 逐文件 hash → manifest → 重命名代次目录 → **写 `current.json`**。
  写 `current.json` 之前中断，读者仍看到旧代；之后中断，新代已完整。
- 同一操作里的多个文件以同一次 `current.json` 写入为提交边界。
- 已提交代次不可修改；修正用 `corrects` 指向旧代次。
- 变化记录先落盘再通知订阅者（`onChange`），重启按 `changesSince` 对账。

### 锁

锁文件 `transactions/lock-<dataset hash>.json` 记录进程、主机、启动时刻、事务 ID、owner。
**不按 TTL 抢锁**：只有"同主机 + 同一启动实例 + 原进程已退出"或"启动实例不同（重启过）"才归档为
`transactions/stale/` 并重试；其他情况返回 `dataset_conflict`（`retryable: true, committed: false`）。

### 来源健康

`unconfigured / missing / empty / ok / invalid / unreadable / conflict`。
已提交代次损坏是 `invalid`/`conflict`，不会显示成"尚未录入"；兼容平面文件损坏时即使没有已提交代次，
整体状态也升级为 `invalid`。

### 隐私边界（`privacy.mjs`）

```js
import { evaluatePrivacy, modelSafe, assertOutboundAllowed, describeStorageLocation } from '../research-core/privacy.mjs'

evaluatePrivacy({ mode: 'strict-local', tools: agentVisibleToolNames, attachments })
// → { enforceable, bypasses:[{tool,reason}], note }
```

- 会话里存在 `read`/`shell`/`pwsh`/`web_fetch`/`browser`/附件等旁路能力时，
  `enforceable: false` 并列出旁路——**不宣称严格本地**。
- `modelSafe(summary)` 去掉姓名/联系方式/编号/本地路径/原始值，只留汇总与允许的字段。
- `assertOutboundAllowed(policy, payload)` 拒绝越权字段、逐人原始值、超限载荷。
- `describeStorageLocation(path)` 给出同步盘/网络共享的**路径事实**，不承诺检测完备。

## 自测

```powershell
cd research-core
node --test "tests/*.test.mjs"
```

`tests/harness.mjs` 是一个不带端口的假宿主：加载真实插件模块、捕获它注册的路由与工具，
再用伪造 req/res 直接调用，因此测试覆盖的是"请求 → 身份 → 核心 → 插件 → 文件"整条链，
而不是只测核心的几个纯函数。`tests/fixtures/` 里有真实子进程夹具，用于跨进程重启与并发写。

