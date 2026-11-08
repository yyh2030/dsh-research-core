# @local/research-core

[English](README.en.md) · 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)写的研究插件共享核心:研究身份与绑定、统一数据访问层、流程与 observation、结果渲染与图表。它是 Host 侧的库,没有独立界面。

版本 1.2.0 · 需要 DSH ≥ 0.2.2-rc.1 · MIT 许可

本仓库同时是这套研究插件的总览。

## 套件总览

| 包 | 版本 | 一句话 | 仓库 |
|---|---|---|---|
| `@local/research-core` | 1.2.0 | 共享核心:身份、数据、流程、结果、图表 | [dsh-research-core](https://github.com/yyh2030/dsh-research-core) |
| `@local/study-ops` | 0.3.0 | 实验运行台:进度矩阵、异常、预约与随访 | [dsh-study-ops](https://github.com/yyh2030/dsh-study-ops) |
| `@local/scale-desk` | 0.2.0 | 量表计分台:定义、录入、计分与校验 | [dsh-scale-desk](https://github.com/yyh2030/dsh-scale-desk) |
| `@local/demographic-coder` | 1.2.0 | 人口学变量录入:导入问卷、编码、导出 | [dsh-demographic-coder](https://github.com/yyh2030/dsh-demographic-coder) |
| `@local/analysis-run` | 0.2.0 | 分析直通:方案向导、分析模块、可复现快照 | [dsh-analysis-run](https://github.com/yyh2030/dsh-analysis-run) |

数据流向大致是:人口学/量表插件把数据写进核心的数据集,运行台读核心投影看进度与异常,分析直通从已提交的代次里汇合出一张分析表。四个业务插件都通过相对路径 `../research-core/…` 引用本仓库,所以五个仓库必须放在同一层目录里。

### 安装顺序

1. `research-core`(先克隆,四个插件都依赖它);
2. `study-ops`(参与者与任务记录是所有下游数据的骨架);
3. `scale-desk`;
4. `demographic-coder`;
5. `analysis-run`。

后四个没有安装上的先后依赖,新装一个插件后重启 `dsh web` 即可。研究的连接与切换由核心统一协调,任一插件忙时会拒绝切换,不会切到一半。

## 为什么需要它

四个插件各自都需要回答同样几个问题:这次调用属于哪个研究、这份数据是哪个已提交版本、谁在写、坏了没有、报告里的三线表和图表怎么画。在抽出核心之前,这些逻辑在插件里各写一份,于是出现两类问题。

一类是身份问题。插件各自记一个"当前研究"时,任一插件切换研究会把其他插件一起带走,两个工作区不能并行;旧页面可能读到或写到刚切过去的研究。核心把"研究"从全局变量改成调用身份上的绑定:页面有 `pageId`,会话有 `sessionId`,后台任务用自己保存的 `instanceId`,切换只影响发起切换的那个页面或会话。

一类是数据问题。直接用 CSV 当权威存储时,写到一半中断会留下半份数据,修正只能覆盖原文件,事后无法回答"这个分数是用哪一版作答算出来的"。核心用提交边界、代次与 manifest 把这件事变成可查询的状态。

## 能做什么

### 研究身份与绑定(`index.mjs` / `host.mjs`)

- 五层身份分工明确:`studyId`(研究逻辑标识,搬家可保留)、`instanceId`(本地数据实例)、`studyRevision`(研究定义内容 hash)、`bindingRevision`(该页面/会话/工作区的绑定代次)、`dataRevision`(数据集版本)。
- 解析顺序:页面/会话显式绑定 → 会话 cwd 所属已登记工作区 → cwd 下的 `.dsh/study.json`、`study.json`、`_lab/study.json` → 插件 profile 里的旧 `studyPath`。只读解析不写盘,只有显式连接或首次写入候选研究时才落地绑定记录。
- 页面写入必须携带绑定令牌 `rc1.<instanceId>.<scopeHash>.<bindingRevision>.<studyRevision前16位>`;令牌过期、属于别的页面、或研究定义被外部改动都返回 `binding_conflict`(409),不会自动改写到另一个研究。
- canonical 路径用 `realpath` 最长存在前缀解析,Windows 上统一小写做键,所以 junction、符号链接、大小写拼写不会把同一目录当成两个研究。
- 同一进程里所有插件共享一份核心实例(`globalThis[Symbol.for('dsh.research.core.v1')]`),插件加载顺序不影响结果。

### 数据核心(`data.mjs`)

- 目录结构:`generations/<dataset>/g000001-<hash8>/`、唯一的提交边界 `current.json`、`transactions/`(staging 与锁)、`audit/changes.json`;`participants/`、`demographics/`、`observations/`、`tasks/` 是兼容平面文件,可重建、非权威。
- 提交顺序是校验 → staging → 逐文件 hash → manifest → 重命名代次目录 → 写 `current.json`。写 `current.json` 之前中断,读者仍看到旧代;之后中断,新代已完整。
- 已提交代次不可修改,修正用 `corrects` 指向旧代次;`inputs` 记录这份数据依赖了哪些数据集和版本。
- `read` / `commit` / `history` / `changesSince` / `health` / `recoverPreview` / `recover` / `backup` / `restorePreflight` / `restore`。
- 锁文件 `transactions/lock-<dataset hash>.json` 记录进程、主机、启动时刻与 owner。不按 TTL 抢锁,只有"同主机 + 同一启动实例 + 原进程已退出"或"启动实例不同"才归档为 stale 后重试,其他情况返回可重试的 `dataset_conflict`。
- 来源健康状态:`unconfigured` / `missing` / `empty` / `ok` / `invalid` / `unreadable` / `conflict`。已提交代次损坏不会显示成"尚未录入"。

### 流程与 observation(`flow.mjs`)

- 参与者状态 `registered` / `enrolled` / `exited` / `completed` / `screening_failed`;采集状态 `not_due` / `missing` / `received` / `entered` / `complete` / `conflict`;质量状态 `unchecked` / `valid` / `invalid` / `unscorable` / `unknown`。采集与质量分开,所以"收到了但没法计分"和"还没到期"不会混成一种状态。
- 重复作答保留全部原值,裁决选一份并留理由,可撤销。
- 编号一律按字符串处理,前导零保留。

### 材料接入与研究草案(`materials.mjs`)

- `scanMaterials` 扫描材料目录并保存派生索引:清单、解析状态、覆盖率、候选、冲突与缺项。只读材料、不联网、不移动文件;本地解析失败会明确列为未覆盖。
- `assessReadiness` 把覆盖、配置草案、统计环境、演练四块分开判定,列出阻断项与待核实项。
- `buildStudyDraft` / `diffStudyDraft` / `writeStudyDraft` 生成研究定义草案并预览 diff:只采用已确认且非待映射的候选,不自动批准计分冲突。
- `.docx` / `.xlsx` 的解析走 `materials_parse.py`,需要本机 Python。

### 分析表汇合(`analysis.mjs`)

`openAnalysis({ data, study })` 只从已提交代次取数,一人一行,列由 `plan.variables` 声明(participant / demographics / task 三类)。人口学同号多行直接以 `duplicate_record` 中止;未裁决的多份作答记为 `conflict` 并计数。返回行数、列数、冲突数、缺人口学人数与各数据集的 revision 与 contentHash。它不做统计,只负责把数据汇成一张可分析的表。

### 结果渲染(`results.mjs`)

- 三线表(`tableFromGrid` / `renderTableHtml` 与配套 CSS)、结果对象构建(`buildResults`)、HTML 报告(`renderHtmlReport`)、产物清单(`artifactManifest`)。
- `formatP` / `formatCI` / `formatNumber` 只用于显示格式化,p 值在模型与 CSV 中保持全精度。
- `redact` 可在文本层面去掉本地路径、文件名与链接。

### 图表(`charts.mjs`)

`pointRangeChart`、`forestChart`、`pairedChart`、`distributionChart` 生成自包含 SVG;`renderPng` 与 `renderPdf` 调用本机无头 Chrome/Edge 栅格化或打印(可用 `DSH_CHROME` 指定可执行文件)。找不到栅格化器时不静默降级,`pngAvailability` 会说明原因,SVG 仍然可用。

### 隐私边界(`privacy.mjs`)

- `evaluatePrivacy({ mode, tools, attachments })`:会话里存在 `read`、`shell`、`pwsh`、`web_fetch`、`browser`、`mcp`、附件等旁路能力时,返回 `enforceable: false` 并列出具体旁路,不宣称严格本地。
- `modelSafe(summary)` 去掉姓名、联系方式、编号、本地路径与原始值,只留汇总与允许的字段。
- `assertOutboundAllowed(policy, payload)` 拒绝越权字段、逐人原始值与超限载荷。
- `describeStorageLocation(path)` 给出同步盘或网络共享的路径事实,不承诺检测完备。

## 安装

五个仓库是私有仓库,需要先有访问权限。因为业务插件用相对路径引用核心,它们必须在同一层目录:

```powershell
git clone https://github.com/yyh2030/dsh-research-core.git
git clone https://github.com/yyh2030/dsh-study-ops.git
git clone https://github.com/yyh2030/dsh-scale-desk.git
git clone https://github.com/yyh2030/dsh-demographic-coder.git
git clone https://github.com/yyh2030/dsh-analysis-run.git
```

在同一个父目录里克隆完成后,把四个业务插件装进 profile:

```powershell
dsh plugin --profile <profile> add link:<父目录>\dsh-study-ops
dsh plugin --profile <profile> add link:<父目录>\dsh-scale-desk
dsh plugin --profile <profile> add link:<父目录>\dsh-demographic-coder
dsh plugin --profile <profile> add link:<父目录>\dsh-analysis-run
```

也可以直接用 git 形式,但四个插件与核心仍需保持同级目录(它们解析的是 `../research-core/…` 这一相对路径):

```powershell
dsh plugin --profile <profile> add git+https://github.com/yyh2030/dsh-study-ops.git
```

`research-core` 本身不是 profile 依赖:它不注册 Cordis bundle,不进入 profile 的 `bundles` 列表,只需要在磁盘上与四个插件并列存在。装完重启承载 `dsh web` 的进程;客户端面板的改动还需要刷新页面。

## 配置

核心没有自己的配置文件。可配置项只有两个来源:

- 环境变量 `DSH_RESEARCH_STORE`:覆盖持久记录的目录。默认 `%DSH_HOME%\storages\research-core\`。
- 插件通过 `hostBinding(ctx, { plugin, version, config, hooks })` 传入的钩子:`loadStudy`、`currentIdentity`、`prepareSwitch`、`busy`、`emptyBase`。

持久记录只有两个文件,内容都是路径与标识,不含研究数据:

| 文件 | 内容 |
|---|---|
| `instances.json` | instanceId ↔ canonical 研究配置路径、studyId、名称、首次/最近时间 |
| `bindings.json` | `page:<pageId>`、`session:<sessionId>`、`workspace:<pathKey>` → 研究路径、instanceId、bindingRevision、来源 |

两个文件都用原子重命名写入。

## 数据与隐私

- 不联网,不发任何外部请求;所有读写都在本机文件系统内完成。
- 不存姓名与联系方式:核心只处理编号、状态、日期与数值,姓名不参与入组判断,也不进入绑定记录。
- 会话与页面的绑定记录只保存路径与标识。同步盘或网络共享上的 dataRoot 会被 `describeStorageLocation` 标出路径事实,是否可接受由使用者判断。
- 隐私结论不夸大:只要会话里有 shell、浏览器、附件这类旁路能力,`evaluatePrivacy` 就报 `enforceable: false`,不会给出一个"严格本地"的假结论。

## 已知限制

- 不是 Cordis Service,不新增界面,也不做统计。
- 跨进程只做原子文件写入,不提供分布式锁。
- 长任务在锁外执行,期间靠插件的 `busy()` 阻止被切走;插件自己的写入由各自的数据集版本比较保护。
- 严格本地取决于会话能力:`strict-local` 只在没有旁路能力时才可执行。
- PNG 与 PDF 需要本机无头 Chrome/Edge(或 `DSH_CHROME`);没有时只有 SVG 与 HTML。
- `materials_parse.py` 依赖本机 Python;没有 Python 时 `.docx` / `.xlsx` 会列为未覆盖,而不是猜测内容。
- 既有私有研究的历史迁移尚未实现。

## 自测

```powershell
cd dsh-research-core
node --test "tests/*.test.mjs"
```

`tests/harness.mjs` 是一个不带端口的假宿主:加载真实插件模块、捕获它注册的路由与工具,再用伪造 req/res 直接调用,所以覆盖的是"请求 → 身份 → 核心 → 插件 → 文件"整条链。同一个测试目录里也有四个业务插件的路由级测试与真实子进程夹具,用于跨进程重启和并发写。

## 许可

MIT，见仓库根目录 `LICENSE`（Copyright © 2026 Yuhui YANG）。许可只覆盖插件代码，不覆盖研究数据：被试信息、问卷作答、研究定义与由它们派生的数据仍归研究方所有，不随本许可授权。
