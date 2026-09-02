# 测试文档（TESTING）

> 验证矩阵、运行方式、验证金字塔、发布 checklist。设计依据看
> [DESIGN.md](./DESIGN.md)，当前状态看 [PROJECT-STATUS.md](./PROJECT-STATUS.md)。

## 1. 自动化测试矩阵

```sh
npm test   # = poc-audit + e2e（无网络依赖，仅需系统 zstd）
```

| 文件 | 性质 | 覆盖场景 | 守住的回归（历史缺陷）|
|---|---|---|---|
| `test/poc-audit.js` | 纯逻辑断言，不碰磁盘 | PoC1: 内容文本含 `session/end-seed` 不误判 ended（JSON.parse 精判）；PoC1b: 真 end-seed 判 ended；PoC2: dry-run 无双源（静态断言 import lib）；PoC3: pruneArchive 不因 delete 模式早退（静态断言）；**PoC4 a-e: isLive 五场景**（在 store→live / 不在 store→可清理 / **服务重载窗口→live** / 无 get→live / 抛异常→live） | 审计🔴a（ended 误判）、🟠c（双源漂移）、🟠b 前半（归档孤儿）、🔴b（live fail-open）|
| `test/e2e.js` | 隔离环境全链路（临时 DSH_HOME + zstd 构造 fake 会话） | 识别→runOnce 归档→事件驱动秒级归档→**pin 拦截**→status 快照 | 归档链路、事件路径、pin、status 数据正确性 |
| `test/dry-run.js` | 只读扫描**真实**会话库 | 分类统计（识别逻辑与生产同源） | 生产数据下的识别健康度（手动诊断工具） |

**e2e mockCtx 语义**（0.3.2 起）：`get: (name) => name === 'sessions' ? { get: () => undefined } : undefined`
——「服务存在、store 空」。⚠️ 无 `get` 的 mock 会被 isLive 判为 live（fail-closed）
而无法验证清理路径——**e2e 能跑通恰恰依赖 mock 提供正确的服务语义**。

## 2. 验证金字塔（改动分层验证）

| 层 | 验证什么 | 工具 | 何时跑 |
|---|---|---|---|
| 单元 | 逻辑正确性 | `npm test`（poc + e2e） | 每次改动后 |
| V0 | 组合树挂载 | `verify-plugin.sh` 内置（--dump-config grep 插件行）| 改 patch/组合 |
| V2 | 真实启动加载 | `bash ~/.dsh/skills/scripts/verify-plugin.sh web dsh-session-pruner`（守护模式：kickstart + 健康检查 + guard 日志断言插件无报错）| 改 lib/ 后 |
| V3 | UI 渲染与交互 | 独立端口起验证实例 + 浏览器实测（渲染/保存/dirty 判定/badge）| 改 client.js 后 |

**V2 依赖 profile 同步**（源码 → `~/.dsh/profiles/web/node_modules`）：

```bash
mv ~/.dsh/profiles/web/node_modules/dsh-session-pruner /tmp/old-backup
cd ~/.dsh/profiles/web && pnpm install --frozen-lockfile
diff -r node_modules/dsh-session-pruner/lib <源码>/lib      # 逐字节一致
grep '"version"' node_modules/dsh-session-pruner/package.json # 与源码一致
```

⚠️ `pnpm install --frozen-lockfile` 对 `file:` 依赖**不重拷**（lockfile directory
指针未变即视为满足）——必须删掉强制重装，双校验过了才算同步（改进笔记 2026-09-02）。

## 3. V3 浏览器验证清单（改 client.js 后）

1. 卡片渲染：header 副标题 / 状态行 / 6 常规字段 / 高级折叠条 / 保存按钮
2. dirty 判定：改常规字段 → header「未保存」亮、高级 badge **不**亮；改高级字段收起 → badge 亮
3. 保存链路：改 pin textarea → 保存 → host 日志 `pinned=N` 热加载；放弃更改 → dirty 清
4. status 轮询：状态行 30s 内出现真实数据（归档数/总量/最近清理）

**截图注意**（改进笔记 2026-09-03）：screenshot 工具对 >1100px 视口会拼接黑区，
视口压 ≤1100 一次成型；裁剪坐标用 marker 校准法（fixed 色块反推映射）。

## 4. 发布 checklist（SemVer → tag → npm → 生产）

```bash
# 1. CHANGELOG 定稿（unreleased → 日期）+ package.json bump
# 2. release commit + tag + push
git commit -m 'release: vX.Y.Z ...' && git tag -a vX.Y.Z -m 'Release X.Y.Z' && git push origin main vX.Y.Z
# 3. npm（本地若指向镜像源必须加 --registry）
npm publish --registry https://registry.npmjs.org/
# 4. GitHub Release（gh release create vX.Y.Z --notes "..."）
# 5. 生产同步（§2 的 mv+install+diff 流程）+ kickstart + verify-plugin.sh
launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web
bash ~/.dsh/skills/scripts/verify-plugin.sh web dsh-session-pruner
# 6. 发布后验证：npm view dsh-session-pruner@X.Y.Z + 生产 /status 路由返回新行为
```

版本策略：Security/修复 → patch；新功能（backward-compatible）→ minor。
纯重构不发版时可攒 unreleased 段。

## 5. 手工诊断

- 库健康度：`node test/dry-run.js`（分类统计 + 解析失败计数）
- 生产状态：`curl http://127.0.0.1:3080/plugins/dsh-session-pruner/status`
- 归档目录：`ls ~/.dsh/sessions-archive/`（工作区/sid 结构，mtime = 归档时刻）
- 日志：guard 的 `~/.dsh/guard/logs/server-*.out.log`（armed/hot-reloaded/archived 行）
