# dsh-session-pruner

**DSH 会话生命周期管理插件** — 从源头杜绝会话库堆积导致的 `session_projcache` 缓存膨胀与 Web 卡顿。

> 子代理会话按需保留：一次性（one-shot）跑完自动清理，可续（continuable）与主会话保留，总量超限自动回收最旧的。每删一个会话连带清理投影缓存行，缓存永远保持小体积。

[English](README.en.md) · [Apache-2.0](LICENSE)

## 背景

DSH（DeepSeek Harness）的 `session_projcache.json` 缓存每个会话的完整投影（token 统计、context 压力等），且存储后端每次写入都**全量序列化 + 原子替换**。当会话库堆积上千个子代理会话时：

- 缓存膨胀到 100MB+，每次 checkpoint 全量重写 → 主进程 CPU 250%+
- 单线程事件循环被占满 → **所有会话加载卡顿，甚至 `GET /` 超时**

清理会话库（本插件）是治本：会话不堆积 → 缓存条目不产生 → 卡顿不复发。

## 功能

三层策略，对应会话库堆积的三个来源：

| 策略 | 行为 | 默认 |
|---|---|---|
| **one-shot 自动清理** | `mode=one-shot` 的子代理（一次性任务）日志出现 `session/end-seed` 后，下一轮扫描即删除 | 扫描间隔 30min |
| **容量保底** | 全库会话数超上限时，按「one-shot → continuable → main」优先级 + 最后活动时间从旧到新清理 | 400 个 |
| **连带清缓存** | 每次删会话同步删除 `session_projcache` 对应缓存行（走 storageDomain 写链，原子持久化） | 开 |

### 安全保护

- **运行中的会话永不清理**：仅删除日志含 `session/end-seed`（已结束）的会话
- **主会话默认永不自动删**：仅容量超限且显式开启 `CLEAN_MAIN=1` 才考虑
- **单点失败隔离**：每个删除动作独立 try/catch，失败只记日志不阻断其他清理
- 可续子代理（continuable）与主会话长期保留，只被容量保底按最旧回收

## 工作原理

```
扫描（定时）
  └─ 遍历 ~/.dsh/sessions/*/ 解压会话日志（zstd）
      ├─ origin: main | subagent      （会话头）
      ├─ mode: one-shot | continuable （subagent/descriptor 事件）
      └─ ended: 是否含 session/end-seed
          │
          ├─ one-shot + ended  ──→ 删除会话目录 + 删 projcache 行
          └─ 总量 > cap         ──→ 按优先级+最旧 批量回收（跳过运行中）
```

## 安装

```sh
dsh plugin --profile web add <repo-path-or-url>
# 重启 dsh web 生效（guard 自动拉起）
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_SESSION_LIFECYCLE_INTERVAL_MS` | `1800000`（30min） | 扫描周期 |
| `DSH_SESSION_LIFECYCLE_MAX` | `400` | 会话总量保底 |
| `DSH_SESSION_LIFECYCLE_CLEAN_MAIN` | `0` | 容量超限时是否允许清 main（`1` 开启） |

macOS + launchd 部署时，环境变量加在 `~/Library/LaunchAgents/com.deepseek.dsh-web.plist` 的 `EnvironmentVariables` 中，然后：

```sh
launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web
```

## 日志

启动后 5 秒执行首轮扫描，之后按间隔周期扫描（输出在 guard 的 `server-*.out.log`）：

```
[session-lifecycle] armed: interval=0.5h cap=400 cleanMain=false
[session-lifecycle] removed 1a2b3c4d5e6f (subagent/one-shot) one-shot done cache=true
[session-lifecycle] scan done: 158 total, removed 0
```

`cache=true/false` 表示是否成功连带清理了 projcache 缓存行。

## 测试

```sh
node test/dry-run.js   # 只读扫描全库，验证识别逻辑（不删除）
node test/e2e.js       # 构造 fake one-shot 会话，验证真实清理链路
```

## 实现要点

- **多帧 zstd**：DSH 会话日志是多 zstd frame 拼接（append 写入），Node 的 `zlib` 只解单帧，插件调用系统 `zstd` 命令解压（macOS: `brew install zstd`）
- **缓存行删除**：经 `ctx.storageDomain.get('session_projcache').tables.sessions.delete(id)` 走官方写链（原子持久化 + 内存同步），拿不到句柄时跳过并告警，不阻断会话删除
- **零依赖**：纯 Node 内置模块 + cordis 运行时（`timer` / `storageDomain` 注入），无 npm 依赖

## 已知限制

- 扫描间隔内完成的 one-shot 子代理最长存活一个扫描周期（默认 30min）
- 依赖系统 `zstd` 命令（跨平台需相应安装）
- 根治性修复在上游：projcache 陈旧会话淘汰 / storage-json 增量写，见 [deepseek-harness Discussion #1550](https://github.com/deepseek-ai/deepseek-harness/discussions/1550)

## 许可证

[Apache-2.0](LICENSE)
