# @local/research-core

[中文](README.md) · English

The shared core for research plugins written for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): study identity and binding, a unified data access layer, flow and observations, result rendering and charts. It is a Host-side library with no UI of its own.

Version 1.2.0 · Requires DSH ≥ 0.2.2-rc.1 · MIT license

This repository also serves as the overview of the research plugin suite.

## Suite overview

| Package | Version | In one line | Repository |
|---|---|---|---|
| `@local/research-core` | 1.2.0 | Shared core: identity, data, flow, results, charts | [dsh-research-core](https://github.com/yyh2030/dsh-research-core) |
| `@local/study-ops` | 0.3.0 | Experiment operations desk: progress matrix, anomalies, scheduling and follow-up | [dsh-study-ops](https://github.com/yyh2030/dsh-study-ops) |
| `@local/scale-desk` | 0.2.0 | Scale scoring desk: definitions, entry, scoring and validation | [dsh-scale-desk](https://github.com/yyh2030/dsh-scale-desk) |
| `@local/demographic-coder` | 1.2.0 | Demographics entry: import questionnaires, code, export | [dsh-demographic-coder](https://github.com/yyh2030/dsh-demographic-coder) |
| `@local/analysis-run` | 0.2.0 | Analysis Runner: plan wizard, analysis modules, reproducible snapshots | [dsh-analysis-run](https://github.com/yyh2030/dsh-analysis-run) |

Data flows roughly like this: the demographics and scale plugins write data into the core's datasets, the ops desk reads core projections to see progress and anomalies, and analysis-run assembles an analysis table from committed generations. All four business plugins reference this repository through the relative path `../research-core/…`, so the five repositories must sit in the same parent directory.

### Installation order

1. `research-core` (clone first; all four plugins depend on it);
2. `study-ops` (participants and task records are the skeleton for all downstream data);
3. `scale-desk`;
4. `demographic-coder`;
5. `analysis-run`.

The last four have no ordering dependency among themselves; after installing a new plugin, restart `dsh web`. Study connection and switching are coordinated by the core: when any plugin is busy it refuses the switch, so you never end up half-switched.

## Why it exists

All four plugins need to answer the same few questions: which study does this call belong to, which committed version is this data, who is writing, is it broken, and how should the three-line tables and charts in the report be drawn. Before the core was extracted, each plugin wrote its own copy of this logic, which produced two classes of problems.

One is identity. When each plugin keeps its own "current study", switching studies in any one plugin drags the others along, two workspaces cannot run in parallel, and an old page may read from or write to the study that was just switched to. The core turns "the study" from a global variable into a binding on the call identity: pages have a `pageId`, sessions have a `sessionId`, background tasks use their own saved `instanceId`, and a switch only affects the page or session that initiated it.

One is data. When CSV is used directly as the authoritative store, an interrupted write leaves half a dataset, corrections can only overwrite the original file, and afterwards nobody can answer "which version of the answers produced this score". The core turns this into a queryable state through commit boundaries, generations and manifests.

## What it does

### Study identity and binding (`index.mjs` / `host.mjs`)

- Five layers of identity with clear roles: `studyId` (logical study identifier, survives relocation), `instanceId` (local data instance), `studyRevision` (content hash of the study definition), `bindingRevision` (binding generation of that page/session/workspace), `dataRevision` (dataset version).
- Resolution order: explicit page/session binding → registered workspace that owns the session cwd → `.dsh/study.json`, `study.json`, `_lab/study.json` under the cwd → legacy `studyPath` in the plugin profile. Read-only resolution never writes to disk; a binding record is only persisted on an explicit connect or the first write to a candidate study.
- Page writes must carry the binding token `rc1.<instanceId>.<scopeHash>.<bindingRevision>.<first 16 chars of studyRevision>`; an expired token, a token belonging to another page, or a study definition changed externally all return `binding_conflict` (409) and never silently rewrite to another study.
- Canonical paths are resolved with `realpath` over the longest existing prefix, and keys are lowercased on Windows, so junctions, symlinks and case differences do not make one directory look like two studies.
- All plugins in the same process share one core instance (`globalThis[Symbol.for('dsh.research.core.v1')]`); plugin load order does not affect the result.

### Data core (`data.mjs`)

- Directory layout: `generations/<dataset>/g000001-<hash8>/`, a single commit boundary `current.json`, `transactions/` (staging and locks), `audit/changes.json`; `participants/`, `demographics/`, `observations/`, `tasks/` are compatibility flat files that can be rebuilt and are not authoritative.
- Commit order is validate → staging → per-file hash → manifest → rename generation directory → write `current.json`. An interruption before `current.json` is written leaves readers on the old generation; an interruption after it leaves the new generation complete.
- Committed generations are immutable; corrections use `corrects` to point at the old generation, and `inputs` records which datasets and versions this data depended on.
- `read` / `commit` / `history` / `changesSince` / `health` / `recoverPreview` / `recover` / `backup` / `restorePreflight` / `restore`.
- The lock file `transactions/lock-<dataset hash>.json` records the process, host, start time and owner. Locks are not stolen on a TTL; only "same host + same start instance + original process has exited" or "different start instance" archives the lock as stale and retries, and anything else returns a retryable `dataset_conflict`.
- Source health states: `unconfigured` / `missing` / `empty` / `ok` / `invalid` / `unreadable` / `conflict`. A corrupted committed generation is never shown as "not yet entered".

### Flow and observations (`flow.mjs`)

- Participant states `registered` / `enrolled` / `exited` / `completed` / `screening_failed`; collection states `not_due` / `missing` / `received` / `entered` / `complete` / `conflict`; quality states `unchecked` / `valid` / `invalid` / `unscorable` / `unknown`. Collection and quality are separate, so "received but unscorable" and "not due yet" never collapse into one state.
- Duplicate responses keep every original value; adjudication picks one and records a reason, and can be revoked.
- Identifiers are always treated as strings, with leading zeros preserved.

### Materials intake and study drafts (`materials.mjs`)

- `scanMaterials` scans a materials directory and saves a derived index: inventory, parse status, coverage, candidates, conflicts and gaps. It only reads materials, never goes online and never moves files; local parse failures are explicitly listed as uncovered.
- `assessReadiness` judges coverage, configuration draft, statistical environment and dry run separately, and lists blockers and items to verify.
- `buildStudyDraft` / `diffStudyDraft` / `writeStudyDraft` generate a study definition draft and preview the diff: only confirmed, non-pending-mapping candidates are used, and scoring conflicts are never auto-approved.
- `.docx` / `.xlsx` parsing goes through `materials_parse.py` and needs a local Python.

### Analysis table assembly (`analysis.mjs`)

`openAnalysis({ data, study })` reads only from committed generations, one row per person, with columns declared by `plan.variables` (participant / demographics / task). Multiple demographics rows for the same ID abort with `duplicate_record`; unadjudicated duplicate responses are recorded as `conflict` and counted. It returns row count, column count, conflict count, the number of people without demographics, and the revision and contentHash of each dataset. It does no statistics; it only assembles the data into one analyzable table.

### Result rendering (`results.mjs`)

- Three-line tables (`tableFromGrid` / `renderTableHtml` plus accompanying CSS), result object construction (`buildResults`), HTML reports (`renderHtmlReport`), artifact manifests (`artifactManifest`).
- `formatP` / `formatCI` / `formatNumber` are for display formatting only; p values keep full precision in models and CSV.
- `redact` can strip local paths, file names and links at the text level.

### Charts (`charts.mjs`)

`pointRangeChart`, `forestChart`, `pairedChart`, `distributionChart` produce self-contained SVG; `renderPng` and `renderPdf` call a local headless Chrome/Edge to rasterize or print (use `DSH_CHROME` to point at an executable). When no rasterizer is found it does not silently degrade: `pngAvailability` explains why, and SVG remains available.

### Privacy boundary (`privacy.mjs`)

- `evaluatePrivacy({ mode, tools, attachments })`: when the session has bypass capabilities such as `read`, `shell`, `pwsh`, `web_fetch`, `browser`, `mcp` or attachments, it returns `enforceable: false` and lists the specific bypasses instead of claiming strict locality.
- `modelSafe(summary)` removes names, contact details, identifiers, local paths and raw values, keeping only summaries and permitted fields.
- `assertOutboundAllowed(policy, payload)` rejects unauthorized fields, per-person raw values and oversized payloads.
- `describeStorageLocation(path)` reports the path facts of a synced drive or network share without promising complete detection.

## Installation

The five repositories are private and require access first. Because the business plugins reference the core by relative path, they must sit in the same parent directory:

```powershell
git clone https://github.com/yyh2030/dsh-research-core.git
git clone https://github.com/yyh2030/dsh-study-ops.git
git clone https://github.com/yyh2030/dsh-scale-desk.git
git clone https://github.com/yyh2030/dsh-demographic-coder.git
git clone https://github.com/yyh2030/dsh-analysis-run.git
```

After cloning them into the same parent directory, install the four business plugins into a profile:

```powershell
dsh plugin --profile <profile> add link:<parent directory>\dsh-study-ops
dsh plugin --profile <profile> add link:<parent directory>\dsh-scale-desk
dsh plugin --profile <profile> add link:<parent directory>\dsh-demographic-coder
dsh plugin --profile <profile> add link:<parent directory>\dsh-analysis-run
```

You can also use the git form directly, but the four plugins and the core still need to stay in sibling directories (they resolve the relative path `../research-core/…`):

```powershell
dsh plugin --profile <profile> add git+https://github.com/yyh2030/dsh-study-ops.git
```

`research-core` itself is not a profile dependency: it registers no Cordis bundle, does not appear in the profile's `bundles` list, and only needs to exist on disk alongside the four plugins. After installing, restart the process hosting `dsh web`; client panel changes also require a page refresh.

## Configuration

The core has no configuration file of its own. There are only two sources of configuration:

- Environment variable `DSH_RESEARCH_STORE`: overrides the directory for persistent records. Defaults to `%DSH_HOME%\storages\research-core\`.
- Hooks passed by plugins through `hostBinding(ctx, { plugin, version, config, hooks })`: `loadStudy`, `currentIdentity`, `prepareSwitch`, `busy`, `emptyBase`.

Persistent records are just two files, both containing paths and identifiers, no study data:

| File | Contents |
|---|---|
| `instances.json` | instanceId ↔ canonical study configuration path, studyId, name, first/last time |
| `bindings.json` | `page:<pageId>`, `session:<sessionId>`, `workspace:<pathKey>` → study path, instanceId, bindingRevision, source |

Both files are written with atomic rename.

## Data and privacy

- No network access, no external requests; all reads and writes happen on the local filesystem.
- No names or contact details are stored: the core only handles identifiers, states, dates and numeric values; names play no part in enrollment decisions and never enter binding records.
- Session and page binding records store only paths and identifiers. A dataRoot on a synced drive or network share is flagged with path facts by `describeStorageLocation`; whether that is acceptable is up to the user.
- Privacy conclusions are not overstated: as long as the session has bypass capabilities such as shell, browser or attachments, `evaluatePrivacy` reports `enforceable: false` rather than a false "strictly local" conclusion.

## Known limitations

- Not a Cordis Service; adds no UI and does no statistics.
- Cross-process coordination is limited to atomic file writes; no distributed lock is provided.
- Long tasks run outside the lock and are protected from being switched away by the plugin's `busy()`; each plugin's own writes are protected by its dataset version comparison.
- Strict locality depends on session capabilities: `strict-local` is only enforceable when there are no bypass capabilities.
- PNG and PDF need a local headless Chrome/Edge (or `DSH_CHROME`); without it only SVG and HTML are available.
- `materials_parse.py` depends on a local Python; without Python, `.docx` / `.xlsx` are listed as uncovered rather than guessed at.
- Historical migration of existing private studies is not implemented yet.

## Self-test

```powershell
cd dsh-research-core
node --test "tests/*.test.mjs"
```

`tests/harness.mjs` is a fake host without a port: it loads the real plugin modules, captures the routes and tools they register, and calls them directly with fabricated req/res, so it covers the whole chain from request → identity → core → plugin → file. The same test directory also holds route-level tests for the four business plugins and real subprocess fixtures for cross-process restarts and concurrent writes.

## License

MIT, see `LICENSE` in the repository root (Copyright © 2026 Yuhui YANG). The license covers plugin code only, not research data: participant information, questionnaire responses, study definitions and data derived from them remain the property of the research party and are not licensed under it.
