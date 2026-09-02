# 项目状态（PROJECT-STATUS）

> 给新会话/新维护者的交接快照：现在是什么状态、怎么继续干活。设计看
> [DESIGN.md](./DESIGN.md)，开发看 [DEVELOPMENT-GUIDE.md](./DEVELOPMENT-GUIDE.md)，
> 验证看 [TESTING.md](./TESTING.md)。

**更新：2026-09-03 · 版本 0.3.2**

## 1. 状态快照

| 项 | 状态 |
|---|---|
| 版本 | 0.3.2（npm / GitHub tag / 本地 profile / 生产 3080 四端一致）|
| 生产 | `dsh web` 守护进程（launchd `com.deepseek.dsh-web`，端口 3080），`file:` 依赖挂载 |
| 测试 | `npm test` 全绿（poc-audit 9 项 + e2e 全链路）|
| 工作区 | git clean，main 与 origin 同步 |
| 文档 | README 双语（带截图）+ DESIGN/DEVELOPMENT-GUIDE/TESTING/PROJECT-STATUS + 2 份历史调研 |

## 2. 代码地图

```
lib/index.js   host 侧：三层清理策略 + 双轨触发 + 安全矩阵（isLive/classifySession/
               archiveSession/pin 拦截/status 路由/applyRuntimeConfig）
lib/client.js  client 侧：设置卡片（渐进披露：6 常规 + 4 高级折叠）+ 状态行轮询
               + dirty-flag 会话列表刷新（手写 __ModuleLoader__ bundle，无构建链）
test/poc-audit.js  审计回归（9 项断言，每个对应一个历史缺陷）
test/e2e.js        隔离环境全链路（临时 DSH_HOME，绝不碰真实库）
test/dry-run.js    只读扫描真实库（诊断工具，复用 lib 实现）
cordis.patch.yml   profile 挂载补丁
```

## 3. 常用工作流

**改代码**：`npm test` 全绿 → mv+install 同步 profile（TESTING §2，frozen install 不重拷 file: 依赖！）→ `verify-plugin.sh web dsh-session-pruner`（V2）→ 改 client 则加 V3 浏览器验证 → 提交推送。

**发版**：TESTING §4 checklist（CHANGELOG → bump → tag → npm --registry → gh release → 生产同步）。

**改 DSH 环境相关**（verify-plugin.sh / guard / 环境变量注入）：改进笔记 2026-09-02/03 两条踩坑记录是必读。

## 4. Backlog（按优先级）

| 项 | 定级 | 说明 |
|---|---|---|
| client 热重载 interval 泄漏 | 低 | 插件热重载时 3s/30s 轮询 timer 不清理会累积；修复需 dispose 钩子 |
| runOnce 并发互斥 | 低 | 两轮扫描重叠靠幂等兜底（rm force/rename catch），仅日志噪音；修复加 in-flight 标志 |
| 完整清理预览 | 功能 | 「开启闲置归档前看会命中哪些」——轻量版已做（状态行），完整版需复用 classifySession 只读跑一遍 |
| 生产 YUQUE_TOKEN/GITHUB_TOKEN 由 guard 注入 | 环境约束 | 裸 shell 起 `dsh web` 会因 MCP env 校验崩溃，验证实例需复刻 guard 注入（boot-guard-launchd.sh）|

## 5. 历史脉络（关键事件索引）

- **0.2.4**（2026-08-31）：S2 mtime 判闲置 / S3 fail-closed（异常路径）/ S5 zstd 魔数 / 扁鹊🟠a 头行判定
- **0.3.0**（2026-09-02）：审计修复三连（🔴a ended 精判 / 🟠b 归档孤儿 / 🟠c dry-run 双源）+ **Pin 白名单** + **面板状态行** + classifySession 单一来源
- **0.3.1**（2026-09-02）：面板渐进披露（10 字段 → 6+4 折叠），高级区未保存 badge
- **0.3.2**（2026-09-03）：🔴b **isLive fail-closed 完整化**（cordis registry.get 服务重载窗口返回 undefined 不抛，旧版 fail-open，delete 模式最坏批量 rm）+ applyRuntimeConfig 单一来源 + 冗余清理 + 文档体系
- 工具链沉淀：verify-plugin.sh V2 守护模式（web profile 专用）、browser 截图 marker 校准法、file: 依赖发版同步 SOP——均在开发工作区《改进笔记.md》

## 6. 新会话开工检查

1. `git log --oneline -5` + `npm test` 确认基线
2. 读本文档 §4 backlog 决定做什么
3. 改动前看 DESIGN §3 关键不变量（所有清理路径必经 archiveSession / 判定单一来源 / fail-closed 覆盖空值与异常）
4. 验证流程别省：V2/V3 是纪律（工作区规则「全绿才算完」）
