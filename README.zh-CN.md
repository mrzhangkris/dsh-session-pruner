# dsh-session-pruner

**DSH 会话生命周期管理插件** — 全类型会话生命周期管理：one-shot 完成即归档、可续子代理与主会话闲置归档、容量保底、连带清理 projcache 缓存。从源头杜绝会话库堆积导致的卡顿。

> 每类会话都有明确的归宿：跑完的一次性子代理自动归档、闲置的可续子代理/主会话归档、总量超限按优先级回收。**先归档（可恢复）再到期删除**，GUI 30 秒内自动同步，全程面板配置、热加载生效。

[English](README.md) · [Apache-2.0](LICENSE) · [npm](https://www.npmjs.com/package/dsh-session-pruner) · [![npm version](https://img.shields.io/npm/v/dsh-session-pruner.svg)](https://www.npmjs.com/package/dsh-session-pruner) · [更新日志](CHANGELOG.md)

## 背景

DSH（DeepSeek Harness）的 `session_projcache.json` 缓存每个会话的完整投影（token 统计、context 压力等），且存储后端每次写入都**全量序列化 + 原子替换**。当会话库堆积上千个子代理会话时：

- 缓存膨胀到 100MB+，每次 checkpoint 全量重写 → 主进程 CPU 250%+
- 单线程事件循环被占满 → **所有会话加载卡顿，甚至 `GET /` 超时**

管理会话生命周期（本插件）是治本：会话不堆积 → 缓存条目不产生 → 卡顿不复发。

## 功能：全类型生命周期

| 会话类型 | 触发 | 动作 | 默认 |
|---|---|---|---|
| **one-shot 子代理** | `subagent/end` / `agent/disposed` 事件（+ 宽限） | 秒级归档（事件驱动） | 事件 + 3 分钟宽限 |
| **continuable 子代理** | 闲置超过 N 天 | 归档（可恢复） | 关闭（0 天） |
| **主会话（main）** | 闲置超过 N 天 | 归档（可恢复） | 关闭（0 天） |
| **任意类型** | 总量超过容量保底 | 按「one-shot → continuable → main」+ 最旧回收 | 400 个 |
| **归档目录** | 保留超过 N 小时 | 物理删除 | 24 小时 |

> **行为说明（v0.2.3+）**：one-shot 子代理统一按 `oneShotMinAgeMinutes`（默认 3 分钟）闲置阈值归档，有/无 end-seed 阈值一致。早期版本中「未写 end-seed 的 one-shot 需闲置满 1 小时才归档」的兜底已移除。

### 归档机制（可恢复）

被清理的会话**先移入 `~/.dsh/sessions-archive/`**（保留 工作区/会话ID 结构）——GUI 立即消失（列表只读 sessions 目录），但文件还在，可手动恢复：

```sh
# 恢复：mv 回 sessions 目录
mv ~/.dsh/sessions-archive/<工作区>/<会话ID> ~/.dsh/sessions/<工作区>/

# ⚠️ 恢复后请立即 pin（或打开）该会话——打开前它不受 live 保护，
# 一个扫描周期内若命中闲置判定（如 one-shot 超阈值、main 超闲置天数）
# 会被再次归档。把会话 ID 加入设置卡片的「Pin 白名单」即可。
```

也可选「直接删除」（不归档，不可恢复）。

### 安全保护（双保险）

- **运行中的会话绝不动**：live 会话（内存 session store 里还挂着、被打开/加载中）跳过——且 live 检查 **fail-closed**：store 查询异常时视为 live，不确定时绝不删除
- **闲置 = 最后一次日志写入**：闲置按会话日志文件 mtime（最后写入时刻）判定，而非目录 mtime——DSH 追加写 `session.jsonl.zstd`，活跃会话的 mtime 持续刷新，永不被误判闲置
- **one-shot**：完成的一次性子代理统一按 `oneShotMinAgeMinutes` 闲置阈值归档（有无 end-seed 同阈值）；容量保底额外跳过缺 `session/end-seed` 的会话
- 主会话默认不参与容量回收（可配置）
- 单点失败隔离：每个动作独立 try/catch

## 工作原理

```
双轨触发（事件为热路径，磁盘为权威）
  ┌─ 事件驱动（秒级）：subagent/end + agent/disposed
  │     ├─ 500ms 批窗口合并风暴 → oneShotMinAge 宽限复查
  │     └─ 单会话判定（内存优先，磁盘只解压一个）→ 归档
  └─ 定时对账（兜底，默认 60min）
        ├─ pruneArchive：归档目录超期物理删除
        ├─ 遍历 ~/.dsh/sessions/*/ 解压会话日志（系统 zstd，多帧）
        │     ├─ origin: main | subagent       （会话头）
        │     ├─ mode: one-shot | continuable  （subagent/descriptor 事件）
        │     └─ ended: 是否含 session/end-seed
        ├─ one-shot 闲置超阈值 ──→ 归档（archiveMode）
        ├─ continuable/main 闲置 N 天 ──→ 归档
        ├─ 总量 > cap ──→ 按优先级+最旧 归档（跳过运行中/live）
        └─ 每次归档连带：删 projcache 行 + workspace 记账
```

GUI 同步双轨（变更驱动为主，全量兜底为辅）：
- **dirty-flag（主路径）**：host 每次归档写内存变更日志（单调 seq）；client 每 3s
  轮询 `/plugins/dsh-session-pruner/archived`，只有有变更才发 `refreshList()`
  + `refreshSubagents()`——侧边栏/任务管理面板秒级一致，无变更零 RPC。
- **全量兜底**：client 每 `uiRefreshSeconds` 秒刷新两套数据源——主会话列表
  `refreshList()` + 各父会话子代理目录 `refreshSubagents()`（dirty-flag
  失效（host 旧版/路由不可用）时兜底，无需刷新页面）。

## 安装

### 从 npm（推荐）

```sh
dsh plugin --profile web add dsh-session-pruner
```

### 从源码（开发）

```sh
dsh plugin --profile web add /path/to/dsh-session-pruner
```

安装后重启 dsh web 生效（`launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web`）。

## 配置（设置面板，热加载）

安装后打开 **设置 → 插件配置 → 会话生命周期管理** 卡片，10 项配置保存即热加载（无需重启）：

| 字段 | 默认 | 说明 |
|---|---|---|
| 扫描间隔（分钟） | 60 | 对账兜底周期（事件驱动为主路径） |
| 容量保底（会话数） | 400 | 超限按优先级+最旧回收 |
| 界面兜底刷新间隔（秒） | 30 | dirty-flag 为主（3s 变更检测），此为全量兜底 |
| 归档保留（小时） | 24 | 归档目录到期物理删除 |
| 归档方式 | 归档 | 归档（可恢复）/ 直接删除（不可恢复） |
| 可续子代理闲置归档（天） | 0 | 超过 N 天未活动归档，0 = 关闭 |
| 主会话闲置归档（天） | 0 | 超过 N 天未活动归档，0 = 关闭 |
| 超限时清理主会话 | 关 | 容量超限时 main 参与回收 |
| one-shot 闲置归档阈值（分钟） | 3 | 所有 one-shot 闲置超 N 分钟即归档（有/无 end-seed 统一） |
| Pin 白名单（每行一个会话 ID） | 空 | 名单内会话永不自动清理（恢复会话后建议立即 pin） |

卡片展开后还有**实时状态行**（30s 轮询）：归档数量与最早到期时间、会话总量（含超限提示）、最近一轮清理数量与时间、已固定数量。

环境变量（兜底，面板配置优先）：`DSH_SESSION_PRUNER_INTERVAL_MS` / `_MAX` / `_CLEAN_MAIN` / `_ARCHIVE_HOURS` / `_ARCHIVE_MODE` / `_CONTINUABLE_IDLE_DAYS` / `_MAIN_IDLE_DAYS` / `_ONE_SHOT_MIN_AGE_MINUTES` / `_PINNED_IDS`（逗号分隔）。

## 日志

输出在 guard 的 `server-*.out.log`：

```
[dsh-session-pruner] armed: interval=60min cap=400 cleanMain=false
[dsh-session-pruner] hot-reloaded: interval=60min cap=400 ... contIdle=0d mainIdle=0d
[dsh-session-pruner] archived a1b2c3d4 (subagent/one-shot) one-shot idle cache=true
[dsh-session-pruner] archive pruned: 2 expired
```

`cache=true/false` 表示 projcache 缓存行是否连带清理成功。

## 测试

```sh
node test/dry-run.js   # 只读扫描全库，验证识别逻辑（不删除）
node test/e2e.js       # 构造 fake one-shot 会话，验证真实清理链路
```

## 实现要点

- **多帧 zstd**：DSH 会话日志是多 zstd frame 拼接（append 写入），Node `zlib` 只解单帧，插件调用系统 `zstd` 命令（macOS: `brew install zstd`）
- **缓存行删除**：`storageDomain.get('session_projcache').table('sessions').delete(id)` 走官方写链（原子持久化 + 内存同步）
- **workspace 记账**：归档时同步从 workspace 域移除 sessionId，数据源与磁盘一致
- **零 npm 依赖**：纯 Node 内置 + cordis 运行时注入
- **面板与热加载**：`installSettingsSection` + 手写 client 卡片（`__ModuleLoader__` bundle），`onChange` 即时重排定时器

## 开发文档

[`docs/DEVELOPMENT-GUIDE.md`](docs/DEVELOPMENT-GUIDE.md) — DSH 插件开发实践指南（架构、Host/Client、设置面板、部署运维、10 个坑与解法），为后续插件开发打基础。

## 已知限制

- 扫描间隔内完成的 one-shot 子代理最长存活一个扫描周期
- 依赖系统 `zstd` 命令
- 根治性修复在上游：projcache 陈旧会话淘汰 / storage-json 增量写，见 [deepseek-harness Discussion #1550](https://github.com/deepseek-ai/deepseek-harness/discussions/1550)

## 许可证

[Apache-2.0](LICENSE)
