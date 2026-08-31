## 0.2.3 (2026-08-31)

### Changed
- 统一 one-shot 归档阈值：删除写死的 ONE_SHOT_GRACE_MS（无 end-seed 兜底 1 小时），有/无 end-seed 统一由 oneShotMinAgeMinutes 控制（默认 3 分钟），UI 配置真正生效
- 配置项语义更新：oneShotMinAgeMinutes 从「最小存活宽限」改为「闲置归档阈值」
- client 设置面板文案同步新语义

### Fixed
- dry-run 输出陈旧文案修正（不再误报「当前库无 one-shot」）
- 文档同步：README/DEVELOPMENT-GUIDE 行为说明 + 判定组合去重

## 0.2.2 (2026-08-29)

### Changed
- package.json repository.url 加 git+ 前缀（消除 npm publish 规范化警告）
- .graphify/ 图谱缓存移出源码仓库（进 .gitignore）


## 0.2.1 (2026-08-29)

### Fixed
- 文档一致性：README 日志示例/表格默认值对齐 v0.2.0 代码（扫描间隔 30min→60min、cap 100→400）
- DEVELOPMENT-GUIDE 代码示例对齐（name 改名遗漏、schema 默认值）

# Changelog

## 0.2.0 (2026-08-28)

### Added
- 事件驱动即时归档（Step 1）：subagent/end + agent/disposed 秒级归档，无需等待 30min 扫描
- GUI dirty-flag 变更驱动刷新（Step 2）：归档 3s 内同步到界面，无变更零 RPC

### Fixed
- 事件处理器 ctx.sessions 未注入报错（cannot get property "sessions" without inject）
- 子代理归档后 better-sidebar 面板/官方目录不自动刷新——refresh 无 await 竞态
- pruneArchive 归档保留期判定：rename 不更新 mtime，闲置久才归档的会话归档后立即被物理删除
- dirty-flag host 重启后 seq 归零，Math.max 保留旧值→主路径永久失效
- 客户端面板默认值 30 vs host 60 不一致、字段校验张冠李戴、onReset 兜底写死 400
- e2e 测试 mockCtx 无 get 方法（ctx.get 回归）

### Changed
- 全面统一命名：内部标识 session-lifecycle → dsh-session-pruner（NS、entry id、日志前缀、环境变量 DSH_SESSION_PRUNER_*）
- 配置段自动迁移（settings.yaml 的 session-lifecycle: → dsh-session-pruner:）
- client 依赖 `@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-slots` 等