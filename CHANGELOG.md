# Changelog

## 0.3.2 (2026-09-03)

### Security
- live 检查改 isLive 单一来源（fail-closed 完整化）：cordis registry.get 在 provider fiber 非 active（sessions 服务重载窗口）时返回 undefined 而非抛异常，旧版 try/catch 只覆盖抛异常路径——该窗口内 live 保护整体失效，delete 模式下最坏批量物理删除（不可恢复）。现在「服务缺失/接口缺失/查询异常」一律视为 live，宁可不删不可误删（runOnce 主循环/容量保底/事件路径三处共用，顺带消除三处重复）；agent/disposed 服务缺失时无脑入队也由 isLive 兜住

### Changed
- 配置应用单一来源：提取 `applyRuntimeConfig`，`apply` 的 composition entry 与 settings `onChange` 共用（旧版 apply 只写 3 字段、onChange 写 10 字段，覆盖不一致——settings 就绪前窗口内 archiveHours/archiveMode 等用 env 值）；undefined 字段跳过，apply 场景保住环境变量兜底
- client dirty 判定去重：数字/枚举/列表原子判定（numDirty/modeDirty/pinnedDirty），高级区 badge 与总 dirty 共用 `advDirty`，不再两处展开同 4 字段
- 清理冗余：`NS`/`Config` 去掉无外部消费方的多余 export（client bundle 无法 import host 模块）；删除 client 的 `require('react/jsx-runtime')` 迁移遗迹与 host 的 `debug: onChange fired` 调试日志；JSDoc 与 const 挤行的格式修正
- `package.json` 加 `scripts.test`（poc 回归 + e2e），贡献者可直接 `npm test`
- 文档体系化：新增 DESIGN（设计决策与不变量）/ TESTING（测试矩阵与验证金字塔）/ PROJECT-STATUS（新会话交接快照），DEVELOPMENT-GUIDE 同步 isLive 坑 12 与单一来源清单，README 双语挂文档导航

## 0.3.1 (2026-09-02)

### Changed
- 设置卡片渐进披露重构（UX 减负）：常用 6 项（归档保留/归档方式/one-shot 阈值/可续与主会话闲置/Pin 白名单）默认可见，4 项低频兜底（扫描间隔/容量保底/界面兜底刷新/超限清 main）收进「高级设置」折叠区——默认视图从 10 个字段减半；高级项有未保存更改时折叠标题显示「有未保存更改」标记，防止改了忘存

## 0.3.0 (2026-09-02)

### Added
- Pin 白名单（产品化）：`pinnedIds` 配置（面板每行一个 / env `_PINNED_IDS` 逗号分隔），名单内会话永不自动清理；拦截点在 `archiveSession` 入口——所有清理路径（one-shot 闲置/事件/容量保底/闲置归档）单点防护，新增路径不会漏
- 面板实时状态行（归档可见性）：卡片展开显示归档数量与最早到期时间、会话总量（含超限）、最近一轮清理数量与时间、已固定数量——`GET /plugins/dsh-session-pruner/status` 轻量路由（readdir+stat + 扫描快照缓存，绝不触发全量 zstd 解压），client 30s 轮询
- 清理判定抽为 `classifySession` 单一来源（runOnce 与预览复用），`archiveSession` 返回布尔（顺带修复：归档失败也计入 removed 的计数瑕疵）
- README 恢复指引补充：恢复后立即 pin 或打开，避免打开前窗口期被再次归档

### Fixed
- 审计🔴a ended 判定改 JSON.parse 精判（先 includes 粗筛保性能）：旧版纯字符串包含会把「用户消息文本里出现 `session/end-seed` 字样」的行误判为已结束，绕过运行中保护——最讽刺的真实场景是在 DSH 里讨论/开发本插件的会话，闲置归档与容量保底路径可误删
- 审计🟠b pruneArchive 不再因 archiveMode=delete 提前 return：从 archive 切到 delete 后，切换前已归档的会话会永久残留磁盘（保留期承诺作废）；归档目录的到期清理与当前归档模式无关
- 审计🟠c dry-run 复用 lib 的 decodeSession/decompressLog（decompressLog 新增测试钩子导出）：旧版 dry-run 内嵌副本仍是扁鹊🟠a 头行判定修复前的逻辑，统计结果不代表生产行为
- client 面板 intervalMinutes hint 文案改为「定时对账扫描周期」：原文案误写为 one-shot 存活时间（实为 oneShotMinAgeMinutes 语义），误导用户改错字段
- 文档漂移：README 双语表格/安全保护段/原理图同步 v0.2.3+ 事件驱动语义（中文版全面落后 + 英文版 blockquote 误用中文 + v0.3+ 笔误实为 v0.2.3+）

## 0.2.4 (2026-08-31)

### Fixed
- S2 严重缺陷：scanSessions 闲置判定改用日志文件 mtime（DSH 追加写日志不更新目录 mtime → 运行中会话被误判闲置归档；delete 模式直接物理删除）
- S3 安全加固：live 保护改为 fail-closed（store 异常视为 live 跳过，不误删）
- S5 边界健壮：zstd 解压失败回退前检测魔数，避免二进制当 UTF-8 误判 ended
- 扁鹊审查：decodeSession 头行判定仅限 i===0，防止事件行误当 header 覆盖 origin
- S8 client 面板默认值（间隔 30→60），S9 保存失败重读重置
- README Safety 段同步：运行中保护由 live 检查 + 日志 mtime 保证

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