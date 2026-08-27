# Graph Report - .  (2026-08-21)

## Corpus Check
- Corpus is ~6,552 words - fits in a single context window. You may not need a graph.

## Summary
- 94 nodes · 172 edges · 7 communities detected
- Extraction: 95% EXTRACTED · 4% INFERRED · 1% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output
- Edge kinds: ON_BRANCH: 35 · MODIFIES: 34 · PARENT_OF: 34 · contains: 31 · calls: 7 · documents: 4 · archived_by: 3 · manages: 3 · enables: 2 · mentions: 2 · addresses: 1 · cites_upstream_issue: 1 · completion_marker_for: 1 · depends_on: 1 · follows: 1 · implements: 1 · maintains: 1 · moves_to: 1 · performs: 1 · proposes: 1 · rationale_for: 1 · requires: 1 · risk_for: 1 · supports: 1 · translation_of: 1 · uses_for_detection: 1 · uses_technique: 1


## Input Scope
- Requested: auto
- Resolved: committed (source: default-auto)
- Included files: 8 · Candidates: 11
- Excluded: 31 untracked · 2 ignored · 0 sensitive · 0 missing committed
- Recommendation: Use --scope all or graphify.yaml inputs.corpus for a knowledge-base folder.

## Graph Freshness
- Built from Git commit: `fdf52d9`
- Compare this hash to `git rev-parse HEAD` before trusting freshness-sensitive graph output.
## God Nodes (most connected - your core abstractions)
1. `dsh-session-pruner plugin` - 20 edges
2. `Archive-first recoverable deletion` - 5 edges
3. `scanSessions()` - 4 edges
4. `runOnce()` - 4 edges
5. `DSH 插件开发实践指南` - 4 edges
6. `decompressLog()` - 3 edges
7. `one-shot subagent` - 3 edges
8. `session/end-seed semantics` - 3 edges
9. `execFileAsync` - 2 edges
10. `decodeSession()` - 2 edges

## Surprising Connections (you probably didn't know these)
- `session/end-seed semantics` --completion_marker_for--> `one-shot subagent`  [AMBIGUOUS]
  docs/DEVELOPMENT-GUIDE.md → README.md
- `guard rollback protection` --risk_for--> `dsh-session-pruner plugin`  [INFERRED]
  docs/DEVELOPMENT-GUIDE.md → README.md
- `dsh-session-pruner 中文说明` --mentions--> `dsh-session-pruner plugin`  [EXTRACTED]
  README.zh-CN.md → README.md
- `dsh-session-pruner 中文说明` --translation_of--> `dsh-session-pruner README`  [INFERRED]
  README.zh-CN.md → README.md
- `dsh-session-pruner plugin` --uses_for_detection--> `session/end-seed semantics`  [EXTRACTED]
  README.md → docs/DEVELOPMENT-GUIDE.md

## Communities

### Community 0 - "Plugin Architecture & Docs"
Cohesion: 0.13
Nodes (22): ~/.dsh/sessions-archive/ directory, Archive-first recoverable deletion, Bundles whitelist registration, Projection cache bloat / event-loop stall, projcache row purge, Capacity cap recycling, continuable subagent, session/end-seed semantics (+14 more)

### Community 1 - "Host Entry & Runtime Config"
Cohesion: 0.15
Nodes (17): 2020895 feat: hot-reloaded 日志补全全部 8 项配置, a92d6c6 refactor: 更名 dsh-session-pruner（卡片显示名保持中文，NS/配置段不变）, b24c114 fix: schemastery 无 literal，枚举改 z.const, cf5e782 fix: pruneArchive 归档目录不存在时静默返回, ARCHIVE_ROOT, archiveSession(), Config, decodeSession() (+9 more)

### Community 2 - "Dry-run Stats Scanner"
Cohesion: 0.20
Nodes (19): main, 05d5faf debug: settings 服务状态与 onChange 触发日志, 136f7be fix: one-shot 完成判定放宽——turn/end 后闲置 1h（无 end-seed 的死会话兜底）即归档；live 保护前置, 25c6a92 fix: timer 改 disposer 模式（clearInterval 不存在）；卡片加标题+折叠下拉, 34d0f5b 0.1.1, 5908a1a test: e2e 隔离到临时 DSH_HOME，不触碰真实会话库, 5b1d2c3 feat: one-shot 最小存活宽限可配置（面板第 9 项 oneShotMinAgeMinutes，默认 3 分钟）, 5e513ed 0.1.2 (+11 more)

### Community 3 - "E2E Test Fixture"
Cohesion: 0.21
Nodes (10): 00b446f feat: 归档机制——清理的会话移入 sessions-archive 保留 N 小时（archiveHours 面板可配，0=立即删），到期物理删除；GUI 立即可见消失、可手动恢复, 1235279 feat: 全类型生命周期——archiveMode 归档/直接删下拉、continuable/main 闲置 N 天归档、归档保留小时；面板 8 字段, 15e5e63 feat: 插件配置卡片显示中文名「会话生命周期管理」, 1f6c19d feat: 清理后 GUI 同步——host 补 workspace 记账清理 + client 30s 轮询 refreshList, 25ebbc8 debug: projcache 域获取与 delete 结果日志, 7b05a55 fix: 补齐 draft/discard/dirty 的 uiRefreshSeconds（漏键导致输入框空白）, 85ff988 style: 卡片对齐官方 PluginCard（默认折叠+名称+描述+ValueField 字段+footer 按钮）, c02f7b6 feat: 界面刷新间隔可配置（uiRefreshSeconds，面板可调，client 动态重建轮询） (+2 more)

### Community 4 - "One-shot Lifecycle & Bundling"
Cohesion: 0.20
Nodes (9): 391f37d feat: 设置面板 + 热加载（installSettingsSection + client 卡片）, 3afa677 chore: package.json 补 keywords/license/repository（npm 发布准备）, 6069bf4 feat: dsh-session-lifecycle — one-shot 自动清理 + 容量保底 + 连带清 projcache, hit, lines, mockCtx, now, plainPath (+1 more)

### Community 5 - "Archive & Idle Policy"
Cohesion: 0.29
Nodes (6): decompressLog(), errs, execFileAsync, noEnd, SESSIONS_ROOT, stats

### Community 6 - "Settings Panel Client Card"
Cohesion: 1.00
Nodes (1): session_projcache.json

## Ambiguous Edges - Review These
- `session/end-seed semantics` → `one-shot subagent`  [AMBIGUOUS]
  docs/DEVELOPMENT-GUIDE.md · relation: completion_marker_for

## Knowledge Gaps
- **24 isolated node(s):** `inject`, `NS`, `Config`, `SESSIONS_ROOT`, `ARCHIVE_ROOT` (+19 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Settings Panel Client Card`** (1 nodes): `session_projcache.json`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `session/end-seed semantics` and `one-shot subagent`?**
  _Edge tagged AMBIGUOUS (relation: completion_marker_for) - confidence is low._
- **Are the 2 inferred relationships involving `dsh-session-pruner plugin` (e.g. with `guard rollback protection` and `Root fix upstream: projcache eviction / incremental writes`) actually correct?**
  _`dsh-session-pruner plugin` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `inject`, `NS`, `Config` to the rest of the system?**
  _24 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Plugin Architecture & Docs` be split into smaller, more focused modules?**
  _Cohesion score 0.1341991341991342 - nodes in this community are weakly interconnected._
- **Should `Host Entry & Runtime Config` be split into smaller, more focused modules?**
  _Cohesion score 0.14736842105263157 - nodes in this community are weakly interconnected._