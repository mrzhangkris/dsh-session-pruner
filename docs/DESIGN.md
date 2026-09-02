# 设计文档（DESIGN）

> 面向维护者：每个设计的「为什么」——决策、备选、理由。怎么实现看
> [DEVELOPMENT-GUIDE.md](./DEVELOPMENT-GUIDE.md)，怎么验证看 [TESTING.md](./TESTING.md)，
> 当前状态看 [PROJECT-STATUS.md](./PROJECT-STATUS.md)。

## 1. 问题定位

DSH 的 `session_projcache.json` 缓存每个会话的完整投影，存储后端每次写入
**全量序列化 + 原子替换**。会话库堆积 → 缓存膨胀（实测 100MB+）→ 每次写
全量重写 → 事件循环饱和 → 全部会话加载卡顿。根因是会话只增不减。

**本插件 = 会话生命周期管理**：让每类会话有明确归宿，从源头止住堆积。
上游的根治修复（缓存增量写/陈旧行淘汰）见
[deepseek-harness #1550](https://github.com/deepseek-ai/deepseek-harness/discussions/1550)，
本插件是用户侧治本方案。

## 2. 核心设计决策

### 2.1 三层清理策略（按会话来源分而治之）

| 层 | 对象 | 触发 | 为什么 |
|---|---|---|---|
| 1 | one-shot 子代理 | 闲置超 `oneShotMinAgeMinutes`（默认 3min），事件驱动秒级归档 | 结果已回传主会话，过程日志价值低、量大（堆积主源）|
| 2 | continuable / main | 闲置超 N 天（默认关闭，opt-in）| 保留价值高，交还给用户决定 |
| 3 | 任意 | 总量超 `maxSessions` 保底 | 兜住「闲置配置全关」时的无限增长 |

**备选**：只做容量保底（简单）——被否：等堆积到上限才清，缓存已经膨胀过。
**备选**：one-shot 也按天闲置——被否：one-shot 完成即弃，分钟级阈值才止得住
高频 spawn 的堆积速度。

### 2.2 双轨触发（事件热路径 + 扫描对账）

```
事件（秒级，易失）  subagent/end + agent/disposed → 候选队列 → 500ms 批窗 + 宽限 → 归档
扫描（60min，权威） 启动重扫 + 定时对账 → 兜底事件丢失/host 重启丢 dispose
```

**为什么双轨**：事件快但易失（host 重启窗口、事件漏发），磁盘扫描慢但权威。
事件路径的判定与扫描路径**共用** `classifySession`/`isLive`（单一来源），
两边行为永远一致。

**v0.2.3 的语义统一**：one-shot 有/无 `end-seed` 统一按闲置阈值归档。
原因：`session/end-seed` 只在真正 dispose 时写入，live 残留/进程重启丢
dispose 的会话磁盘上永远没有 end-seed，按 end-seed 判「完成」会永远清不掉
（详见 DEVELOPMENT-GUIDE 坑 11）。闲置 mtime 是唯一可靠信号。

### 2.3 两段式删除（归档 → 保留期 → 物理删除）

归档 = `mv` 到 `~/.dsh/sessions-archive/`（GUI 即失，文件仍在）→
保留 `archiveHours`（默认 24h）→ 物理删除。可选 `delete` 模式直接物理删除。

**为什么**：自动清理的最大风险是误删用户还要的东西，软删除 + 保留期给
反悔窗口。恢复 = `mv` 回 sessions 目录（`sessions.list` RPC 会扫磁盘，冷会话
自动回列表，无需记账回补）。**恢复后未打开的窗口期会被再次归档——必须
立即 pin 或打开**（README 已警示）。

归档后 touch 目录 mtime：`rename` 保留原 mtime（= 最后活动时间），不刷新
则闲置多日的会话归档后立即被 pruneArchive 按「早于 cutoff」物理删——保留期
必须从归档时刻起算。

### 2.4 安全保护矩阵（fail-closed 哲学）

| 保护 | 实现 | 失效防线 |
|---|---|---|
| live | `isLive`：内存 store 挂着的跳过 | 单一来源，三路径共用 |
| 运行中 | 非 one-shot 必须有 end-seed；容量保底同样检查 | `classifySession` |
| pin | `pinnedIds` 白名单 | **archiveSession 入口单点拦截**——所有清理路径必经，新增路径不会漏 |
| 单点失败 | 每动作独立 try/catch | 一次失败不影响其他清理 |

**fail-closed 的完整语义（两次审计换来的）**：
- S3（2026-08）：查询**抛异常**视为 live ✓
- 审计🔴b（2026-09）：**cordis `registry.get` strict 模式在 provider fiber
  非 active（服务重载窗口）时返回 `undefined` 而非抛异常**——旧版只防异常，
  该窗口 live 保护整体失效（delete 模式最坏批量 rm）。教训：
  **fail-closed 必须同时覆盖「异常」和「空值」**——查不到 ≠ 不存在。

`isLive` 现语义：只有「服务可用且会话确实不在 store」才可清理；服务缺失/
接口缺失/查询异常一律视为 live。宁可积压等下轮扫描，不可不确定时删。

### 2.5 配置系统三层 + 单一写入路径

```
环境变量（DSH_SESSION_PRUNER_*，无 settings 服务时的兜底）
  ↓ apply(config)——composition entry，覆盖 settings 就绪前的窗口
    ↓ installSettingsSection → scope.get()（schema 默认 + base + 用户层）
      → onChange → applyRuntimeConfig(c)
```

**applyRuntimeConfig 是配置写入 runtime 的唯一函数**（apply 与 onChange 共用；
undefined 字段跳过——apply 场景保住 env 兜底，onChange 场景 schema 已填满）。
旧版 apply 写 3 字段、onChange 写 10 字段的覆盖不一致已消除（0.3.2）。

### 2.6 GUI 同步双轨（变更驱动为主）

- **dirty-flag 主路径**：host 归档写内存单调 seq 日志；client 每 3s 轮询
  `/archived`，有变更才发 `refreshList/refreshSubagents` RPC——无变更零开销
- **全量兜底**：每 `uiRefreshSeconds` 秒无条件刷新（覆盖路由不可用/host 旧版）
- **status 路由**（0.3.0）：面板状态行（归档数/到期/总量/最近清理），
  **轻量设计**：归档目录 readdir+stat 实时 + `lastScanStatus` 扫描快照缓存，
  路由绝不触发全量 zstd 解压，30s 轮询无压力

**备选**：WebSocket/SSE 推送——被否：DSH 插件 API 无推送能力，轮询是生态
惯例（agent-teams 同款 1s 轮询模式）。

### 2.7 零捆绑依赖

运行时模块（`@deepseek-ai/dsh-settings`、`schemastery`）由 DSH 宿主提供，
插件自身不声明 dependencies。代价：宿主若移除这些模块插件会崩——这是 DSH
插件生态的约定（宿主 API 的一部分），换来的是安装零依赖树。

## 3. 关键不变量（维护者必守）

1. **所有清理路径必经 `archiveSession`**（pin 单点拦截的前提）
2. **判定逻辑单一来源**：`classifySession`（清什么）/ `isLive`（活没活）/
   `decodeSession`（日志解析）——禁止在任何调用点重写，dry-run 双源漂移的
   教训（CHANGELOG 0.3.0）
3. **fail-closed 覆盖空值与异常**：任何「查不到/不可判定」一律不删
4. **archiveSession 返回布尔**，调用方按返回值计数（归档失败不虚增）
5. **新增清理路径时**：runOnce 更新 `lastScanStatus`、走 isLive/pin 检查、
   e2e 补场景

## 4. 已知权衡

- 默认配置下 main 会话不清理（cleanMain=false + mainIdleDays=0）——安全默认
  的代价：插件只管住 subagent 一半，main 堆积需用户 opt-in
- 容量保底极端场景失效：全 live/全未 ended 时清不动（正确方向：保命优先）
- 事件丢失的 one-shot 最坏等一个 intervalMinutes 才被兜底扫描发现
- 连带清理 projcache 是治本关键，但 projcache 行重建发生在会话再次加载时——
  归档后恢复的会话首次打开会重建缓存（可接受）
