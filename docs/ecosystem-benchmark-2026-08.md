# DSH 插件生态对标与事件驱动调研

> 2026-08-21 · dsh-session-pruner 开发过程中的生态调研。
> 触发背景：修完「可续子代理删除后界面不刷新」bug 后，用户要求看货架（CANDIDATES.md）
> 上可借鉴的 DSH 插件候选。A = awesome-dsh-plugin 同类插件对标；B = dsh-agent-teams
> 事件驱动实现剖析。本文档先落主线程本地依据，A/B 结果后补。

## 主线程本地查证：DSH 会话/子代理生命周期事件与 GUI 同步机制

### host 侧可订阅事件（插件 ctx.on 可监听）

| 事件 | 触发时机 | 用途 |
|---|---|---|
| `session/end-seed` | 会话写入结束种子（子代理完成/主会话结束） | 完成判定 |
| `session/disposed` | 会话从 live store 移除 | 即时感知会话不再 live |
| `session/created` | 会话创建 | host 推 `host/session-added` |
| `agent/disposed` | agent 释放 | 子代理结束 |
| `subagent/end` / `subagent/start` | 子代理结束/开始 | 子代理生命周期 |
| `domain/changed` | storageDomain 变化（workspace 域） | host 推 workspace/archive 帧 |

### host → client 帧（client-runtime 处理）

| 帧 | 含义 | client 行为 |
|---|---|---|
| `host/session-added` | 会话创建 | mergeSummary（upsert） |
| `host/session-removed` | 会话从 live store 移除 | **durable 子代理保留（resumable 设计），其余移除** |
| `host/session-status` | 运行状态变化 | 状态更新 |
| `host/workspace-changed` | workspace 域变化 | 工作区视图同步（侧边栏） |
| `host/archived-sessions-changed` | archivedSessionIds 集合变化 | installArchived → sessionVisible 排除 |

### 关键结论（本地依据）

1. **主会话归档的 GUI 隐藏已是即时的**：pruner 归档时从 workspace 域 sessionIds detach →
   `domain/changed` → host 推 `host/workspace-changed` → client 侧边栏即时隐藏。无需轮询。
2. **子代理归档不经过 workspace 域**（子代理不在 workspace sessionIds 记账中）→ GUI 显示靠
   `summaries`（sessions.list 轮询）+ `catalogs`（subagents.list 轮询，刚修复）。
3. **archivedSessionIds 机制**（`ctx.workspace.archiveSession(sid)`，host workspace 服务）：
   - 语义：registry-global 隐藏集合，保留 workspace 记账（unarchive 可恢复位置）；只增不减。
   - 前置条件：session 必须仍可被 persistence 找到（**须在移目录之前调用**）。
   - 对 pruner：主会话已被 detach 覆盖，子代理不受益，集合膨胀有风险 → **不推荐使用**。
4. **事件驱动方向**：host 侧 `ctx.on('session/disposed'/'subagent/end')` 可实现即时感知；
   当前 30min 扫描对清理场景足够（归档不紧急），事件驱动主要价值在即时性，详见 B 调研。

## A：awesome-dsh-plugin 同类插件对标表（2026-08-21 补充，web 实际调研）

> 调研源：[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 清单（Sessions & Messages / Memory / Development & Runtime 三个分类全扫），
> 从 ~60 个「会话管理/归档/删除/清理」候选中筛出与 pruner 最同类的 14 个，逐仓拉 README + 源码（client/host 双半身）核实机制。
> 用户原话锚点：pruner =「one-shot 子代理完成即归档、可续子代理/主会话闲置归档、容量保底 400、归档保留 24h 物理删、连带清 projcache、GUI 会话列表每 N 秒轮询刷新」；
> 刚修 bug =「GUI 刷新只刷主列表、不刷子代理目录，已归档可续子代理条目陈留界面」。

### 对标表

| 插件 | 仓库/包名 | 核心功能 | 清理机制 | 状态存储 | GUI/UI 同步 | 可借鉴点 |
|---|---|---|---|---|---|---|
| **dsh-background-agents** | PerryLink/dsh-background-agents | 可续后台子代理（启动/消息/打断/列表/结果）+ **闲置归档** + 每父会话容量上限 + Web 侧栏面板 + 团队房间 | **定时清扫**：`idleTimeoutMinutes=120` 闲置窗口 + `idleSweepIntervalMs=60000` 清扫周期 + `autoArchive` 开关；归档后可唤醒；**与 pruner 完全同构** | 结构化 `background-agents/fact` 事件（`ignorable:true`）追加进父会话日志 + `backgroundAgents` 会话投影折叠；无独立数据库 | **零轮询**：客户端 `sessions.list.subscribe()` + `session.projections.faceOf('backgroundAgents').subscribe()` 投影 face 订阅；打开子代理前 `await sessions.refreshSubagents(parentId)` | 生态内最接近 pruner 的实现：闲置归档参数化、容量上限、投影驱动 GUI、全走官方 subagent seam（startContinuable/followup/interrupt/listChildren） |
| **dsh-subagent-monitor** | Mombrane/dsh-subagent-monitor | 子代理实时监视面板（卡片/树形缩进/秒表/终态五色） | 无清理（纯监视）；每根会话上限 200 行淘汰最旧 | host 内存事件仓库（Map<runId,row>）⊕ 合并持久目录 `subagents.listDescendants`（label/mode/depth + 重启回填） | **1s 轮询**自建 `GET /api/subagent-monitor/snapshot?sessionId=<根会话>`（回环无鉴权）；ARCHITECTURE.md 明说**「浏览器半身没有 host 事件推送通道」→ 轮询是生态常态** | 快照路由以**根会话为 key 返回整棵子代理森林**——主列表与子代理目录应同源、一次轮询双视图齐刷（正是 pruner bug 的解法方向）；「已结束」中性态处理重启后结局未观测的行 |
| **dsh-task-dag** | LeemanCheung/dsh-task-dag | 会话+子代理+workflow 实时 DAG（纯浏览器只读可视化） | 无 | 无（不建库不持久化；节点拖拽位置仅当前页 React state） | **零轮询**：直接反应客户端 catalog 快照 `SessionListState.byId`/`parentId`/`subagentsByParent`；手动 Refresh 刷新观察的 subagent catalog | 子代理目录的数据源是 **client 运行时 store（subagentsByParent）**——订阅它即自动同步，不需要自建轮询；文档明说"no polling loop" |
| dsh-session-manager（dream12347，最全） | dream12347/dsh-session-manager | 回收站(10条自动淘汰)/恢复归档/统计/暂停/未读/已读/fork/工作区分组排序/压缩阈值 | 删除先走官方归档通道（侧边栏立即隐藏）→ 文件移回收站 → storageDomain 记录条目；`ctx.agents` 拒绝删运行中会话 | 回收站条目存 storageDomain JSON（`~/.dsh/storages/dsh_delete_session.json`）+ 回收站目录；**已删 id 存浏览器 localStorage 防刷新复活** | 管理抽屉订阅 `sessions.list`（ObservableSnapshot）实时列表；侧栏未读点用 **MutationObserver 装饰官方树节点**（官方行元素无 session id 属性，按标题文本匹配） | 删除链路「先归档→移走→记账」；localStorage 防复活清单；ObservableSnapshot 订阅（响应式优于轮询） |
| dsh-session-manager（hkkz9522） | hkkz9522/dsh-session-manager | 删除+归档/取消归档管理面板 | 删除链：`agent.cancel` → `scope.dispose` → 摘除 agents 注册表僵尸条目 → `sessions.flush` → detach session store（**`session/disposed` 事件 → 所有客户端移除行**）→ 清 workspace 记账+归档集 → 删磁盘目录 | 磁盘会话目录 + workspace registry 状态 | **unarchive 经 workspace registry 持久化队列，`host/archived-sessions-changed` 帧让每个客户端同步**（事件驱动，非轮询） | 事件驱动同步范式：**状态变更走官方通道，客户端自动收帧**，无需自建刷新 |
| dsh-session-unarchive | dylan121322/dsh-session-unarchive | 纯插件实现取消归档（零文件补丁） | 无 | workspace.json 的 `global.archivedSessionIds` | 调 workspace registry 运行时方法（`enqueueOperation/requireState/setState`，内置 archiveSession 同一 API）改集合 → **DSH workspace stream 自动广播 `host/archived-sessions-changed`** → 客户端 store 与内置侧边栏自动刷新，零额外接线 | **归档/取消归档的官方事件通道实证**（与 hkkz9522 双源互证）；升级韧性：运行时方法加载时探测，改名即 500 不损坏 registry |
| dsh-archive-manager | jasonrale/dsh-archive-manager | 归档面板：继续会话/取消归档/彻底删除（live agent 拆解+物理删日志）/搜索 | 删除=完整 live-agent teardown + 物理删日志；**热重载后运行中的会话拒绝删除**（提示重启） | 磁盘会话目录 | 分组/排序/拖拽与官方侧边栏**实时双向同步**（依赖 `workspaceRegistry.enqueueOperation` + client-runtime service shapes） | 「native view sync」= 依赖官方内部形状做双向同步，无自绘状态 |
| dsh-plugin-session-delete | lsz-asd/dsh-plugin-session-delete | 头部垃圾桶+行菜单删除 + agent 工具 `workbench_session_delete` | 删除链：会话日志+**投影缓存**+workspace 记账（经 storageDomain 内存/磁盘一致）；**先 flush live 会话再 detach**（防 dispose 回写重建日志目录）；**先删磁盘日志确认成功再解除记账**（防半删除脱离分组）；同时清理**原始 UUID 与 `session-` 前缀两种 id** | session log + projcache + storageDomain 记账 | 侧边栏经官方归档通道隐藏 | **projcache 清理的删除顺序纪律**（v0.3.1 变更日志可对照 pruner 连带清 projcache 的实现） |
| dsh-projection-guard | DamonKoy/dsh-projection-guard | 守护 `session_projcache.json` | 运行时包装 `sessionProjectionCache.put()`，**逐行 JSON 降级**——单个坏投影单元只丢该行，不再卡死全缓存 | session_projcache.json | 启动自愈：扫缺 title 的持久化会话，冷读日志回填 title 投影（projcache 是冷启动标题回退的关键） | projcache 可靠性双招：逐行降级 + 启动回填；pruner 清理 projcache 时注意别把健康行也删了 |
| dsh-session-flow | YeqingTang/dsh-session-flow | 跨会话归档工作台 + 血缘树 + 健康监控（活跃/工具执行/静默/疑似卡死四级）+ 摘要 | 无自动清理（缓存管理可清索引/时间线缓存，不动 DSH 数据） | 自建索引/时间线缓存 + 会话日志 | 血缘树**离线档案+运行时实时双通道**；实时跟踪 **3s 轮询**；健康监控徽标+详情条 | 闲置判定可参考「静默/疑似卡死」分类（对照 pruner 的闲置判定阈值）；血缘树 UI 形态（子代理目录的展示范式） |
| dsh-api | lilming123/dsh-api | HTTP 控制面：workspace/list、语言、**SSE 事件流** | 无 | 无 | **SSE `/dsh-api/events`**：`agent-idle`（agent/status running→idle 转换）、`approval-needed`、25s heartbeat、`server-stopping` | **事件驱动替代轮询的实证**：闲置归档可钩 agent/status 转换事件而非定时扫；同机 loopback 绑定 |
| dsh-session-doctor | mayf3/dsh-session-doctor | 诊断/解卡/读取会话（5 工具） | 无自动清理；解卡=`agent.cancel({keepInbox:true})` 中止卡住活动保留排队消息 | 无（只读 sessionQuery + live agents） | 无 GUI | 卡死/闲置判定信号：agent status + inbox 排队数 + 最后事件（`sessionQuery.listEvents`） |
| session-titler | JohnXu22786/session-titler | 两阶段会话标题（忙时关键词→闲置时廉价模型精炼+摘要） | 无 | 无 | 无 | **idle pacemaker**：`idleDelayMs=5000` 闲置检测触发第二阶段——闲置判定的现成思路 |
| dsh-restart-recover | fakechris/dsh-harness-ops#dsh-restart-recover | 重启后自动续接被打断的 turn | 无 | 无 | 无 | **host 侧 `agent/created` 事件监听**，明说「无浏览器时序竞态」——host 事件监听优于浏览器端轮询 |

### 最有价值的借鉴点（具体到机制/代码思路）

**① 子代理目录同步：从「只刷主列表的轮询」升级为「官方 client store 订阅 / 主动刷新 API」（直接对治刚修的 bug）**
- dsh-background-agents 客户端（`src/client/index.ts`）的做法：
  ```ts
  // 订阅 sessions.list（ObservableSnapshot），任何会话状态变化触发面板刷新
  this.stopList = this.sessions.list.subscribe(() => { this.refresh() })
  // 订阅会话投影 face —— host 更新投影缓存后客户端 face 推送，零轮询
  const face = this.sessions.binding(id)?.session.projections.faceOf('backgroundAgents')
  this.stopFace = face.subscribe(() => { this.refresh() })
  // 打开子代理前强制刷新该父会话的子代理 catalog
  await sessions.refreshSubagents(parentSessionId)
  ```
- dsh-task-dag 证实子代理目录的权威数据源是 client 运行时 store `SessionListState.subagentsByParent`（label/mode/activity/catalog health），**订阅即自动同步，无需自建轮询**（"sends no polling requests"）。
- 结论：pruner 的轮询刷新应**覆盖全部视图**——要么同源快照一次拉全（主列表+子代理目录，参考 subagent-monitor 以根会话为 key 的 snapshot 路由），要么归档动作后主动调 `sessions.refreshSubagents(parentId)` 让目录即时收敛；纯浏览器端轮询只刷主列表必然出现本次 bug 的「目录陈留」。

**② 归档/取消归档走官方 workspace registry 运行时方法 → 免费获得 `host/archived-sessions-changed` 广播（事件驱动，所有客户端自动一致）**
- dylan121322 与 hkkz9522 双源互证：改 archivedSessionIds 集合（`enqueueOperation/requireState/setState`，与内置 archiveSession 同一内部 API）→ DSH 自身 workspace stream 检测变化并广播 `host/archived-sessions-changed` → 客户端 store 与内置侧边栏自动刷新，**零额外接线**。
- 与本仓既有结论的关系：既有文档已确认「主会话归档 detach 后 `domain/changed` → `host/workspace-changed` → 侧边栏即时隐藏」；本机制是同族（host 状态变更 → 官方帧广播）。对子代理（不经 workspace 域），对应机制是借鉴点①的 refreshSubagents/catalog 订阅。

**③ 闲置归档清扫器参数化 + 事件驱动闲置检测（dsh-background-agents 模式 + dsh-api 的 `agent-idle` 事件）**
- background-agents 的闲置清扫与 pruner 完全同构：`idleTimeoutMinutes`（闲置窗口）+ `idleSweepIntervalMs`（清扫周期）+ `autoArchive`（开关），归档事实以结构化事件写日志、投影折叠、重启从日志重建——**全部走官方 seam，无自绘生命周期**。
- 闲置检测的另一条路：`agent/status` 事件存在 `running→idle` 转换（dsh-api 的 `agent-idle` SSE 实证；fakechris 用 `agent/created` 监听避开浏览器时序竞态）——pruner 可从「纯定时扫描」升级为「**agent/status 转换事件触发判定 + 定时扫描兜底**」双通道；当前 30min 扫描对清理场景仍够用，事件的价值主要在 GUI 即时一致。

**（附赠）projcache 清理的删除顺序纪律（lsz-asd v0.3.1 + DamonKoy）**
- 先 flush live 会话再 detach（防 dispose 阶段回写/重建日志目录）；先删磁盘日志并确认成功再解除记账（防半删除脱离分组）；同时清理原始 UUID 与 `session-` 前缀两种 id 形式——可直接对照 pruner 的「连带清 projcache」实现补漏。

### 关键信息来源

- 清单本体：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>（README，Sessions & Messages / Memory / Development & Runtime 分类）
- 深挖仓库（按上述对标表顺序）：
  - <https://github.com/PerryLink/dsh-background-agents>（README + src/client/index.ts + src/projection.ts）
  - <https://github.com/Mombrane/dsh-subagent-monitor>（README + ARCHITECTURE.md §2.2/§2.3/§2.4/§3.2）
  - <https://github.com/LeemanCheung/dsh-task-dag>（README Architecture 节）
  - <https://github.com/dream12347/dsh-session-manager>（README 工作原理表）
  - <https://github.com/hkkz9522/dsh-session-manager>（README Implementation notes）
  - <https://github.com/dylan121322/dsh-session-unarchive>（README Architecture）
  - <https://github.com/jasonrale/dsh-archive-manager>（README）
  - <https://github.com/lsz-asd/dsh-plugin-session-delete>（README 变更日志 v0.3.1）
  - <https://github.com/DamonKoy/dsh-projection-guard>（README）
  - <https://github.com/YeqingTang/dsh-session-flow>（README）
  - <https://github.com/lilming123/dsh-api>（README /dsh-api/events 节）
  - <https://github.com/mayf3/dsh-session-doctor>（README）
  - <https://github.com/JohnXu22786/session-titler>（README）
  - <https://github.com/fakechris/dsh-harness-ops/tree/main/plugins/dsh-restart-recover>（README）
- 生态其他同类（未深挖，备查）：hkkz9522 之外还有 `Semidia/dsh-session-manager`（纯客户端，一行补丁给行元素加 `data-session-id`）、`MuWinds/dsh-archived-sessions`、`keepermttl/dsh-archive-viewer`、`MichengAI/dsh-archive-manager`、`AKS1st/dsh-archived-conversations`、`Coprexist/dsh-session-recovery`（磁盘级恢复删除会话）、`guo6x/dsh-housekeeper` / `zoahdev/dsh-disk-audit`（环境/磁盘清理）、`x2802490130-prog/dsh-shield`（删除进回收站）。

## 调研完成情况

- [x] A：awesome-dsh-plugin 同类插件对标表（2026-08-21 完成，web 实际调研）
- [x] B：dsh-agent-teams 事件驱动实现剖析 + 迁移可行性 → 结论落地为 [event-driven-migration-report.md](./event-driven-migration-report.md)，实现已随 v0.2.0 上线（事件驱动即时归档 + dirty-flag GUI 同步）
