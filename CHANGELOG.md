# DSH 研究插件套件 · 变更日志

> 规则：每次改动/调整都在本文件追加一条，注明日期、插件、版本、问题 ID、改了什么、验证方式。
> 修复阶段的详细验收记录在 `reports/research-plugin-remediation-20261108/` 各阶段完成记录里。

## 2026-11-10 · 06 材料扫描与可审阅草案（材料侧）

- **research-core 1.4.0**（`materials.mjs`）
  - M01：中文/特殊字符标签不再被 slug 成 `-`；访视/任务 ID 改为 `visit-<sha12>` / `task-<sha12>`（类型前缀 + 来源/candidate 稳定 hash），label 保留原文；同名不同来源 ID 不同，显式改 label 不改既有 ID；任务默认 `visits: []`、`required: false`、`visitMapping: 'pending'`，只给 `suggestedVisits` 建议，不自动进入必需矩阵。
  - M02：扫描记录 attempted/notScanned 与 complete/incompleteReasons；file/byte/time/depth 上限或 permission 失败时 `complete=false`、`truncated` 同步；上一轮已知但本轮未遍历的文件标 `not_scanned`，不判 `removed`；覆盖率分母含已知未尝试文件（`coverage.files`，另给 `attemptedCoverageRatio`），报告显式声明扫描是否完整。
  - M03：解析缓存键加入 parser 版本、解析脚本/能力指纹（Python 路径、PDF 库）、规则与 parse limits；环境补齐后缓存键变化，自动重试同一文件的旧失败/未解析状态；新增 `retryUnparsed`/`retryPaths`/`retry` 显式重试。
  - M04：候选新增确认/拒绝/待映射状态（默认 `pending`，observed 不自动算接受）；`decisions.json` 持久化，重新扫描按来源 sha 保留有效决定，来源变化标 `needs_review`；preview 生成 `draftId` + `revision` 并保存快照，save 接受同一 `draftId`/`expectedRevision`、不重新随机；缺 studyId 时用材料目录指纹保证 preview→save 身份一致；更新以现有定义为基础合并，保留 `plugins`/`dataRoot`/`participantId`/已有访视与任务，列出草案未提到的行。
  - M05：`assessReadiness` 按 import/scoring/run/analysis 四阶段分别给出 state/blockers/pending；dryRun 非 `passed` 时 run 与 analysis 阻断，统计后端缺失时 analysis 阻断；`canStart` 只有在所有阶段 ok/not_applicable 时为真；支持 `analysisNotRequired`/`statisticsNotRequired` 让不需要统计的项目仅对相应任务就绪；统计环境优先读取真实配置后端，缺配置时才退回 Python 依赖探测。
- **study-ops 0.3.1**（`index.js` 路由）
  - `materials_scan` 应用持久候选决定并汇总扫描完整性与决定计数；新增 `retry` 参数。
  - 新增 `materials_decisions` 工具（list/set），提供可发现的候选确认入口。
  - `study_draft_preview` 返回/持久化 draftId+revision，更新预览先与现有定义合并并展示删除项；`study_draft_save` 支持 `draftId`，校验预览内容与现有文件版本后再写，更新同样走合并。
  - `prep_readiness` 输出四阶段状态与阶段阻断原因；路由读取 `config.statisticsBackend` / `config.dryRun`。
- 测试：新增 `tests/remediation-06.test.mjs` 5 例（M01-A/M02-A/M03-A/M04-A/M05-A，全合成材料，含 study-ops 路由级 M04/M05）；`cd D:\dsh-plugins\research-core; node --test "tests/*.test.mjs"` → **177 tests / 177 pass / 0 fail**（基线 172 + 新增 5，未改旧断言）。
- 范围说明：本轮只做材料侧 M01–M05；U01/U02 页面工作区/标签绑定与 07 隐私边界留给下一轮，本轮未改 `study-ops/client.js` 的页面绑定逻辑。

## 2026-11-10 · 05 自动分析与缓存

- **analysis-run 0.5.0 / engine 2.4.0**
  - A01：外部脚本字节在准备阶段冻结进 `plan.script.code` 与 fingerprint，快照写 `code/<name>`，执行只用快照。
  - A02：表文件记录 sha256；`cache_artifacts_ok` 校验 input 与所有表存在且 hash 一致，坏缓存跳过；新增 `forceRecompute`。
  - A03：自动请求指纹改为 study + 完整 plan + dataset hash；失败暂停键改为完整指纹。
  - A04：interval/初始 timeout/debounce 登记 disposers，`ctx.effect` 卸载时清理。
  - 测试：`tests/remediation-05.test.mjs` 4 例；全套 168/168。
- 记录：`05-完成记录.md`（A05 未做，A03/A04 调度测试未做）。

## 2026-11-10 · 04 量表分数与发布

- **scale-desk 0.3.0**：recordId 带 submissionId；`scores` 数据集；save/import/answer/score/export 后自动发布；outbox + `publishRetry`。
- **research-core 1.3.0**：analysis 支持 `type:'score'` 变量，缺失带 `missingReason`；manifest 记录 scores 代次。
- 测试：`tests/remediation-04.test.mjs` 4 例；全套 164/164。

## 2026-11-08 · 03 图表与 Office

- **analysis-run 0.4.0 / engine 2.3.0**：Office 小数不再归零；XLSX 数值类型 + number_format；图读 `meta.charts`；每表 analysisSet/types；`"001"` 保真。
- **research-core**：`tableFromGrid` 支持声明类型；箱线须取围栏内真实极值。
- 测试：`tests/remediation-03.test.mjs` 7 例；全套 160/160。

## 2026-11-08 · 02 统计输入与推断

- **analysis-run 0.3.0 / engine 2.2.0**：`module_columns` + `prepare_frame` 统一输入；每 scope 门槛；偏相关 df；Table1 按人去重；信度声明量尺与 corrected 题总；零方差 t 明确失败；节点 `analysisSet`。
- 测试：`tests/remediation-02.test.mjs` 10 例；全套 153/153。

## 2026-11-08 · 01 数据身份锁与健康

- **research-core 1.2.0**：实例断言、锁状态机、提交指针、`commitMany`、`reconcile`、复合人口学提交、健康错误区分。
- 测试：`tests/remediation-01.test.mjs` 11 例；core 143/143。

## 2026-11-10 · 05 补充（A05 句柄捕获）

- **analysis-run 0.5.0**：scheduleDebounced 在排队时捕获 studyState（cfg/context），回调与失败/成功状态都写到捕获的研究目录，不再用执行时的 current()；eadAutoState/writeAutoState 显式接收 cfg。A05 仍缺双研究交错集成测试。
- 验证：
ode --check + 全套 168/168。

## 2026-11-10 · 05 补充（自动调度 seam 与 A03/A04/A05 测试）

- **analysis-run 0.5.0**
  - 新增 `analysis-run/scheduler.mjs`：`createScheduler({ config, current, run, analysis, readAutoState, writeAutoState, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn })` 与纯函数 `requestedKey()`；requestedKey = sha256(JSON.stringify({ studyId, plan, datasetHash }))。
  - tick 只读一次 `current()` 并把快照用到结束；auto-state 键未变直接返回；否则比较最新 run 的 dataset hash 与 plan，去抖排一次 run；失败暂停键为完整 requestedKey，成功后写 auto-state。
  - 排队回调只用排队时捕获的 studyState（含 cfg.outputDir 与 context），不在回调里读 current()（A05）；dispose 清 interval、初始 timeout、debounce 并清空 disposer，之后 tick/schedule 不再启动任务（A04）。
  - `index.js` 改为注入 `createScheduler`，run 前 LOCKS/WRITES guard 与旧 `startAuto()` 接口保留，`autoTick` 动作与 status 的 autoError/autoTicks 不变；`runs(cfg, study)` 显式接收捕获的 context。
  - 新增测试 `research-core/tests/remediation-05-scheduler.test.mjs` 4 例，只测 scheduler 模块并用假时钟：A03-A（同 dataset 改 plan 触发一次、plan 不变不触发）、A03-B（失败暂停、plan 变后恢复）、A04-A（dispose 后推进假时钟不运行且无新 timer、新实例才工作）、A05-A（A 排队后 current 切 B，回调仍用 A 的 cfg.outputDir/context）。
  - 验证：`node --test "tests/*.test.mjs"` → 172 通过 / 0 失败（原 168 + 新增 4）；`node --check analysis-run/index.js`、`node --check analysis-run/scheduler.mjs` 通过。
