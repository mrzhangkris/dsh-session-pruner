# dsh-session-pruner 事件驱动迁移评估报告

> 任务：评估能否借鉴 dsh-agent-teams 的「事件驱动调度器」（监听子代理完成事件 → 即时归档 + 触发 GUI 刷新），替代 pruner 现在的「30 分钟定时扫描 + 210 秒 GUI 轮询」。
>
> 分析依据：
> - `dsh-agent-teams` v0.1.10 源码（git clone 于 `/tmp/dsh-agent-teams`）
> - 本地 DSH 安装 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
> - `dsh-session-pruner` 现有源码 `lib/index.js` / `lib/client.js`
>
> 日期：2026 年（分析时点）

---

## 0. 结论先行

**值得改，而且收益明确**，但要拆成两步、并保留兜底：

| 环节 | 现状 | 事件驱动后 | 手段 |
|---|---|---|---|
| Host 侧归档判定 | 每 30min 全盘扫描，**每个会话都 zstd 解压全文** | 子代理完成事件到达即归档（秒级），热路径**不再解压任何日志** | `subagent/end` / `agent/disposed` / `session/event` |
| GUI 刷新 | 每 210s 盲轮询 `refreshList` + `refreshSubagents` RPC | 归档后 2–5s 内刷新，且只在「有变更」时发 RPC | HTTP dirty-flag 短轮询（agent-teams 同款）或 `settings/document-updated` 推送 |
| 兜底 | （无，全靠 30min 扫描） | 启动重扫 + 慢周期对账（60–120min） | 保留现有 scan 作安全网 |

**关键澄清**：agent-teams 的「事件驱动」只指 **Host 侧调度器**——它确实不再轮询状态；但它的 **GUI 仍然是轮询**（1s 一次打一个极轻的 HTTP 路由 `/plugins/dsh-agent-teams/state`，见 `src/client/activity-monitor.ts:164 ACTIVITY_POLL_MS = 1000`）。所以对 pruner 的 GUI 同步，正确借鉴对象是 agent-teams 的「轻量路由 + 短轮询 + 变更才做重活」模式，而不是幻想存在一条现成的「插件自定义事件 → 浏览器推送」通道（下面会证明该通道是白名单锁死的）。

---

## 1. dsh-agent-teams 事件驱动调度器实现剖析

### 1.1 一句话机制

> 「**每次 idle 边和每次任务图变更，都尝试一次原子领取，并唤醒被选中的可续成员**。」（`src/scheduler.ts:1-10` 模块注释）

DSH 可续子代理拥有显式的 idle/running 生命周期（与 Claude Code 那种「队友自己轮询共享任务表」不同），所以调度器不需要维持一个常驻轮询回合：**订阅 `agent/status` 事件，成员 turn 结束变 idle 的那一瞬间就是「有空」的边，立刻给它派下一件活**。

### 1.2 它监听的 DSH 事件/钩子（全部）

| 事件 | 位置 | 用途 |
|---|---|---|
| `ctx.on('agent/status', ({agent, status}) => …)` | `src/scheduler.ts:258-262` | **唯一的状态事件钩子**。成员从 running→idle 时同步成员状态并触发 `kickMember` 派活 |
| `ctx.on('internal/service', …)` | `src/index.ts:246-251` | webServer/workspace 服务晚绑定时补注册 HTTP 路由（非调度核心） |
| `ctx.subagents.registerContinuableSetup(childCtx => …)` | `src/members.ts:196-233` | 每个新/冷恢复的可续子代理挂模型选择桥（spawn 时生效） |
| 补丁式改写 `ctx.subagents.listChildren/listDescendants/followup` | `src/members.ts:426-467` | 退休成员守卫：从 `list_agents` 可见性和 followup 冷恢复入口双重排除已退休成员 |

### 1.3 「idle/running 显式边」到底怎么实现——**事件 + 实时注册表，零轮询**

三个机制拼起来，全部是**读实时内存状态 / 收事件推送**，没有任何 `setInterval` 轮询：

1. **Agent 注册表实时状态**（`src/scheduler.ts:66-69`）：
   ```ts
   function isMemberAvailable(ctx, member) {
     const live = ctx.agents.get(member.id as SessionId)
     return live === undefined || live.status === 'idle'
   }
   ```
   `ctx.agents.get(id)` 是 dsh-agent 的 `AgentRegistry`（`dsh-agent/lib/index.js:689 get()`），纯内存实时表。`undefined` = 该成员不在线（冷态，仍可被 followup 冷恢复）；`status === 'idle'` = turn 已结束。**这就是「显式 idle 边」**。

2. **状态同步 + 唤醒联动**（`src/scheduler.ts:239-256`）：
   ```ts
   const next = status === 'running' ? 'working' : 'idle'
   if (current.status === next) return
   current.status = next          // 写盘（团队状态文件）
   await writeTeam(stateRoot, fresh)
   ...
   if (status === 'idle') await runtime.kickMember(workspace, located.id, member.name)
   ```
   收到 `agent/status` → 把磁盘上的成员状态改成 working/idle → **若变 idle，立刻尝试给它派下一件活**（幂等：没活就什么都不做）。

3. **唤醒手段**（`src/members.ts:373-390`）：`ctx.subagents.followup(captain, childId, [{type:'text',text}], {source:{kind:'plugin'}, signal})` —— 给可续子代理的 FIFO inbox 投递一条消息作为它的下一回合。`followup` 对冷态成员会自动冷恢复。返回 false（成员没了/不可续）则回滚这次派活。

4. **活动快照**（`src/members.ts:478-489`）把两种来源并起来：
   ```ts
   const entries = await ctx.subagents.listChildren(captainSessionId)
   const live = ctx.agents.get(entry.id)
   activity.set(entry.id, live === undefined ? 'ready' : live.status)
   ```
   `listChildren`（持久化发现 durable 成员）+ `agents` 注册表（真实活动态）→ 三态 `running / idle / ready`（ready = 磁盘上有、当前不在线）。

### 1.4 任务状态机怎么驱动唤醒

- **任务状态**：`pending → claimed → in_progress → completed`（`claimed`/`in_progress` 是「已领取但可能没跑完」的中间态）。
- **成员状态**：`idle ↔ working`（磁盘持久化）。
- **派活条件**（`src/scheduler.ts:76-82`）：`pending` + 无未满足依赖 + （有 assignee 就指派给自己 / 无 assignee 归公共池）。
- **原子领取**：`withTeamLock`（文件锁，`src/state.ts`）内 `beginTaskAttempt` 生成 `attemptId`，作为**能力令牌**——成员后续所有 update 必须带当前 attempt_id，被转派/重试后旧 attempt 的写入会被拒（`stale-attempt`），防「迟到结果覆盖新主人」。
- **丢失回合自愈**（`src/scheduler.ts:183-191`，注释直说「model stopped early, interrupt settlement, or process restart」）：一个 idle/ready 成员仍持有 `claimed/in_progress` 任务 → 撤销旧 capability、`attempt+1`、重新唤醒同一成员。
- **唤醒失败回滚**（`src/scheduler.ts:220-234`）：`deliverToMember` 返回 false → 在锁内只回滚自己这次派活（`attemptId` 匹配才回滚，并发队长交接不误伤）。

### 1.5 用到的 DSH 公开 API / 事件清单（含代码位置）

| DSH 能力 | agent-teams 用法 | 位置 |
|---|---|---|
| `ctx.on('agent/status')` | 状态边订阅 | `src/scheduler.ts:258` |
| `ctx.agents.get(id)` | 实时 idle/running 判定 | `src/scheduler.ts:66-69, 239` |
| `ctx.subagents.followup(parent, childId, content, opts)` | 唤醒成员（冷恢复） | `src/members.ts:381` |
| `ctx.subagents.startContinuable({provider,label,request:{prompt,parent,persona,toolFilter,agentOptions}})` | 生成 durable 可续成员 | `src/members.ts:336-351` |
| `ctx.subagents.listChildren / listDescendants` | 发现 durable 成员 + 退休守卫补丁 | `src/members.ts:433-456, 482` |
| `ctx.subagents.interrupt(childId, {kind:'ancestor',agent})` | 中断成员回合 | `src/members.ts:401` |
| `ctx.subagents.registerContinuableSetup(childCtx=>…)` | 冷恢复时挂模型选择 | `src/members.ts:196` |
| `@deepseek-ai/dsh-subagent` 的 `foldSubagentDescriptor` | 从会话事件后缀折叠出 descriptor（mode/label） | `src/members.ts:18, 199-200` |
| `session.append(type, data)`（受限：`KNOWN_SESSION_EVENT_TYPES` 白名单） | 把团队事件写进队长会话做监控面 | `src/events.ts:45-60` |
| HTTP 路由注册（webServer/httpServer service） | GUI 快照路由 `/plugins/dsh-agent-teams/state` | `src/index.ts:175-195` |

### 1.6 可复用的「重启恢复」设计

事件只是触发器，**磁盘状态才是权威**（`src/state.ts` 的 team.json + inbox/*.jsonl，文件锁保证并发安全）。文档原话（`docs/usage.md:83`）：「调度是事件驱动而非常驻轮询；队长离线时无法冷恢复成员，任务和消息保留在磁盘，待队长恢复或调用状态工具后继续投递。」——事件丢了没关系，下次任何触发（agent/status、工具调用）都会重新对账。**pruner 的迁移也应照此：事件驱动热路径 + 磁盘/启动对账兜底。**

---

## 2. DSH 会话/子代理生命周期事件清单（host 侧 + client 侧）

以下全部在本机安装里逐一验证过代码位置。

### 2.1 Host 侧可订阅事件（插件 `ctx.on(...)` 可用）

| 事件名 | 触发时机 | 载荷 | 位置 |
|---|---|---|---|
| `agent/status` | AgentLoop 每次 phase 迁移且 status 变化（idle 含 maintenance） | `{agent, status: 'idle'\|'running'}` | `dsh-agent-loop/lib/index.js:380-388`（`setPhase` 里 `dispatch.emit`） |
| `agent/created` | 代理进入注册表（announce） | `{agent}` | `dsh-agent/lib/index.js:683` |
| `agent/disposed` | 代理离开注册表（回合结束 teardown、重启、被移除） | `{agent}` | `dsh-agent/lib/index.js:638-648`（`emitDisposed`） |
| `session/created` | 会话进入内存 store（enter+announce） | `Session` | `dsh-session/lib/index.js:1750` |
| `session/disposed` | 会话从内存 store 移除 | `Session` | `dsh-session/lib/index.js:1770` |
| `session/event` | **已挂载会话**每次 append（firehose）；构造函数种子的历史不重发 | `(session, event)`，event = `{type,seq,time,data}` | `dsh-session/lib/index.js:1471-1476` |
| `subagent/start` | 每个一次性 run 开始 / 每个可续 activation 开始（父作用域分发） | `{runId, provider, id, local}`（id=子会话 id） | `dsh-subagent/lib/index.js:199-210`（`observeRun`） |
| `subagent/end` | 同上，run 结算（正常/错误） | `{runId, provider, id, local, stopReason, lastAssistantMessage?}` | `dsh-subagent/lib/index.js:199-210` |
| `settings/document-updated` | 设置文档 revision 变化 | `(ns, revision)` | `dsh-settings/lib/index.js:520-526`（`emitDocumentUpdated`） |

会话日志内的事件类型（`KNOWN_SESSION_EVENT_TYPES`，`dsh-session/lib/index.js:1054-1110`）与 pruner 相关者：`turn/start`、`turn/end`、`session/end-seed`、`subagent/descriptor`、`tool-workflow/agent-start`、`tool-workflow/agent-end`、`agent/inbox/spliced` 等。

**作用域说明**：`agent/*`、`session/*`、`subagent/*` 都带 subject carrier 分发（agent/session 作主题），但 app 根（apiproxy 就在根上监听 `agent/status`/`session/created`/`session/disposed` 转发给 client）与根级插件都能收到——agent-teams 在插件 ctx 上 `ctx.on('agent/status')` 已实战证明可达。`subagent/end` 按父代理作用域分发（`createLifecycleEmitter`，`dsh-subagent/lib/index.js:166-180`），根级插件同样可达，建议迁移时用 e2e 断言一次。

### 2.2 Client 侧 host 推送帧（浏览器接收，`dsh-client-runtime/lib/client.js`）

| 帧类型 | 来源 host 事件 | client 处理 | 位置 |
|---|---|---|---|
| `host/session-added` | `session/created` | 插入/更新 summary 行 | client `:8362`；host `dsh-host-apiproxy/lib/index.js:3625` |
| `host/session-removed` | `session/disposed` | **子代理行不删除**（`durableSubagent` 判定 origin==='subagent' → 只标 `running:false` 保留行）；main 行才 `remove` | client `:8377-8408`；host `:3635` |
| `host/session-status` | `agent/status` | 更新 running 标志 | client `:8410`；host `:3641` |
| `host/agent-error` | `agent/error` | 显示错误 | client `:8419` |
| `host/workspace-changed` / `-removed` | `domain/changed`(workspace) | 只 upsert **workspace 注册表**，**不刷新会话列表 summaries** | client `:9632-9633` |
| `host/archived-sessions-changed` | workspace 域归档集合变化 | 安装归档列表 | client `:9637` |
| `host/remote-event` | **白名单** `API_REMOTE_FORWARDED_EVENTS`（`dsh-api-remotes/lib/index.js:18-31`，仅 11 个内置事件，插件**不能**追加） | `ctx.remote.$dispatch(event, args)` | client `:10518`；host `:3698` |

### 2.3 对 pruner 最关键的三个事实

1. **会话列表 summaries 只被三种东西更新**：`session.list` RPC（`refreshList`，读内存 + 持久化 meta）、`host/session-added`、`host/session-removed`（main 行）/`host/session-status`。pruner 现有「workspace detach → host/workspace-changed」**不会**让列表刷新（见上表），这就是 GUI 必须轮询的结构性原因。
2. **子代理行是「删不掉的」**：`host/session-removed` 对 origin==='subagent' 的行只标 `running:false`（`durableSubagent` 分支），行要等 `refreshList`（持久化重读）才消失；目录树条目要等 `refreshSubagents(parent)` RPC 重查磁盘才消失。→ **GUI 同步子代理归档，绕不开一次 `refreshList`/`refreshSubagents` 调用**，区别只是「盲轮询」还是「有变更才调」。
3. **没有插件可用的「自定义事件 → 浏览器推送」通道**：`host/remote-event` 白名单锁死。插件侧可行的推送只有：a) 借用白名单里的事件（如 `settings/document-updated`——见 3.3 方案 B）；b) 自建 HTTP 路由 + 客户端短轮询（agent-teams 方案）。

---

## 3. pruner 事件驱动迁移方案

### 3.1 现状问题量化（为什么值得动）

- **判定延迟**：`runOnce` 由 `ctx.timer.interval(safeRun, 30min)` 驱动（`lib/index.js:408`）。子代理完成到归档最坏 **30 分钟**；GUI 再等 **210 秒**轮询——用户刚修的 bug 就是这个叠加延迟。
- **扫描成本**：`scanSessions`（`lib/index.js:149-178`）对**每个会话**执行 `zstd -dc` 全量解压（`decompressLog`，`lib/index.js:92-108`，maxBuffer 512MB/会话、超时 30s）。会话多时这是每次扫描几百 MB 的解压量，纯属为「不知道谁变了」买单。
- **可复用信息被浪费**：判定字段（origin/mode/ended）其实在**内存里就有**——`ctx.sessions.get(id).header.origin`、`session.events` 里的 `session/end-seed`、`subagent/descriptor` 的 mode、`subagent/end` 的 stopReason，全都不用碰磁盘。

### 3.2 Host 侧：事件驱动归档（改动集中在 `lib/index.js`）

新增订阅（挂在 `apply` 里，与现有 `timer` 并存）：

```
ctx.on('subagent/end', ({id, stopReason}) => {
  // id = 子会话 id；过滤：descriptor mode === 'one-shot'（subagent/end 对可续 activation 也发）
  // 用 ctx.sessions.get(id) 读内存判定（不回退磁盘）：
  //   - header.origin === 'subagent'
  //   - events 里有 subagent/descriptor 且 mode==='one-shot'（可借用 foldSubagentDescriptor）
  // 满足 → scheduleArchive(id, reason=stopReason)   // 见下
})

ctx.on('agent/disposed', ({agent}) => {
  // 一次性子代理回合结束离开注册表；与 subagent/end 互为冗余保险（双保险防事件漏发）
  scheduleArchive(agent.id, 'disposed')
})

ctx.on('session/event', (session, event) => {
  // 只匹配 turn/end、session/end-seed → 更新该会话「最后活动」内存 LRU（替代 mtime 启发式）
  // session/end-seed → 该会话已结束（ended=true 的权威来源）
})

ctx.on('session/created', () => {
  // 轻量容量检查：ctx.sessions.list().length + persistence meta 计数（无解压）
  // 超 maxSessions → 触发容量清理（沿用现有 priority/mtime 排序逻辑，只对冷会话）
})
```

`scheduleArchive(id, reason)` 要点：

- **保留 3 分钟宽限**（`oneShotMinAgeMinutes`）：`setTimeout` 到点后复查「仍 ended 且不在 store / 未被复用」才归档——现有安全语义不丢。
- **从内存判 ended**：`ctx.sessions.get(id)` 还在时看 `session.events` 有无 `session/end-seed`；不在时（已 dispose）看磁盘上该**单个**会话的日志（只解压一个，不是全量）。
- **幂等**：与现有 `archiveSession` 完全复用（rm force / rename 覆盖、projcache 连带删、workspace detach）。
- **批量防风暴**：把待归档 id 收进一个 500ms 批窗口，串行执行（可借鉴 agent-teams `serializeMember`，`src/scheduler.ts:109-122`）。

保留的兜底（**不建议删**）：

1. 启动后 5s 的 `runOnce`（现有 `lib/index.js:407`）——重启期间错过的清理一次补齐。
2. 慢周期对账扫描：现有 `interval` 保留，默认建议从 30min 提到 **60–120min**（事件是主路径，扫描降级为安全网；顺带覆盖「会话被其它方式删除/手工清理」等事件源外变化）。

**收益**：热路径零 zstd 解压；子代理完成后 **≤3min（宽限）+ 秒级** 归档，替代「≤30min + 全量解压」。

### 3.3 Client 侧：GUI 刷新（210s 盲轮询 → 变更驱动）

**方案 A（推荐，agent-teams 实战同款）——HTTP dirty-flag 短轮询**：

- Host：注册路由 `/plugins/dsh-session-pruner/archived`（参照 `src/index.ts:175-195` 的 webServer.register），返回自上次以来的归档清单：`{since: n, archived: [{sessionId, parentSessionId, origin}]}`，host 内存维护一个单调递增的 `archiveSeq` 与最近 N 条记录（disk 为权威、内存只是变更日志，重启丢也没关系——client 兜底轮询会补齐）。
- Client：每 **2–5s** 打一次这个路由（一个 `fetch`，极轻）；**只有** `archived` 非空时才调 `refreshList()` + `refreshSubagents(affected parents)`，否则什么都不做。
- 语义：把 210s 盲轮询变成「变更才做重活」的 dirty-flag 轮询。延迟 2–5s，成本≈0（agent-teams 是 1s 打一次同类路由，生产验证过）。

**方案 B（零轮询推送，进取但需验证）——借 `settings/document-updated` 白名单通道**：

- 已核实：host `dsh-settings` 发 `(ns, revision)`（`dsh-settings/lib/index.js:526`），在 `API_REMOTE_FORWARDED_EVENTS` 白名单内（`dsh-api-remotes/lib/index.js:18-31`）→ apiproxy 转成 `host/remote-event` → client `ctx.get('remote').$on('settings/document-updated', …)`（`dsh-client-ui-settings/lib/client.js:1342` 就是这么订阅的）。
- pruner host 每归档一批，`ctx.emit('settings/document-updated', NS, revision+1)`；client 订阅并过滤 `ns === 'session-lifecycle'` → 触发 `refreshList` + `refreshSubagents`。
- 风险与验证点：a) 该事件同时会触发官方 settings mirror 重载（一次 describe RPC，罕见、可接受）；b) 需 e2e 验证插件 `ctx.emit` 能到达 apiproxy 的转发监听（`ctx.emit` 是全局 dispatch，预期可达）；c) 事件丢失无感知——所以**无论如何都保留一条慢兜底轮询（如 5–10min）**。

**两条路径共同的兜底**：保留现有 `refreshList` 轮询，但间隔放宽（如 300s），仅在推送失效时兜底。

### 3.4 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| 事件丢失（崩溃/重启/漏发） | 事件是易失的 | 启动重扫 + 慢周期对账扫描（60–120min）；归档动作幂等 |
| 事件风暴（fan-out 大批子代理同时完成） | 大量归档 + 批量 workspace detach | 500ms 批窗口 + 串行执行；workspace detach 由「逐会话遍历所有 workspace」改成「一次收集、一次更新」（现在 `archiveSession` 里每个都全表遍历，见 `lib/index.js:214-231`） |
| `agent/status` 高频 | 每个 phase 迁移都发（含 maintenance） | 只处理「running→idle 且是子代理会话」的边，其余直接 return |
| `session/event` firehose 高频 | 每个 append 都发 | 只匹配 `turn/end`、`session/end-seed` 两个 type |
| 刚完成的一击子代理还在 store 里 | 直接归档可能误删收尾 | 保留 `oneShotMinAgeMinutes` 宽限；延迟归档期间会话被复用则取消 |
| `subagent/end` 对可续 activation 也发 | 载荷里没有 mode | 用 `foldSubagentDescriptor` / descriptor mode 过滤 one-shot（agent-teams 同款做法，`src/members.ts:199-201`） |
| 作用域事件到不了插件 ctx | 理论风险 | agent/status 已被 agent-teams 实战证明可达；subagent/end 同机制（parent carrier），加一条 e2e 断言 |
| 方案 B 推送不可靠/误伤 settings | 借用他人事件通道 | 以方案 A 为主；B 作为增强；兜底轮询保留 |
| 容量保底判定 | 事件驱动后仍需总计数 | `session/created` 触发轻量计数（内存 store + persistence meta，无解压）；或并入慢周期对账 |

### 3.5 测试与验证路径

- 扩展 `test/e2e.js`：新增断言「**子代理完成后（不等待 30min 扫描）秒级归档**」——跑一个 one-shot 子代理、等 `subagent/end`、断言磁盘目录被移入归档。
- 新增事件订阅冒烟：启动后打印收到的前几个 `agent/status` / `subagent/end`（验证作用域可达）。
- 回归：`test/dry-run.js`（只读自测）保持全绿；方案 B 若采用，加「emit 后 client 收到 remote event」断言。
- 配置默认值调整：`intervalMinutes` 默认 30 → 建议 60（兜底）；`uiRefreshSeconds` 语义从「同步周期」改为「兜底周期」。

---

## 4. 结论

**值得改，分两步走，风险可控。**

1. **Host 事件驱动归档（Step 1，改动集中在 `lib/index.js`，收益最大）**：
   - 判定延迟 30min → 秒级（+3min 宽限）；
   - 热路径彻底消灭「全量 zstd 解压」这个最大的隐形成本；
   - 安全语义（end-seed / live 保护 / 宽限 / 幂等归档）全部保留，只是触发器从定时器换成事件；
   - 需要同时保留：启动重扫 + 慢周期对账（重启恢复依赖磁盘权威，这是 agent-teams 明示的设计哲学）。

2. **GUI 变更驱动刷新（Step 2，`lib/client.js` + 一个新路由）**：
   - 首选 agent-teams 同款「轻量 HTTP 路由 + 2–5s dirty-flag 短轮询 + 变更才发 RPC」——已验证该插件生产可用；
   - `settings/document-updated` 推送可作为零轮询增强，但需 e2e 验证且保留兜底轮询；
   - 不要幻想「自定义事件推送」——`host/remote-event` 白名单锁死，插件不可扩展。

3. **不建议**：
   - 完全移除所有扫描（重启恢复仍需对账，agent-teams 自己也是「事件触发 + 磁盘权威」双轨）；
   - 用「把冷会话 enter 进 store 再 dispose」去伪造 `host/session-removed` 推送——会先触发 `session/created` 造成 GUI 闪烁，且 `session/disposed` 对子代理行本就不删除（`durableSubagent` 分支），治不了目录树条目。

一句话：**事件驱动解决「判得快」，dirty-flag 解决「显得快」，磁盘对账解决「丢得起」**——三者合起来正是 agent-teams 调度器的完整形态，pruner 可以原样借鉴。
