# DSH 插件开发实践指南

> 基于 **dsh-session-pruner**（会话生命周期管理插件）的真实开发全过程整理。
> 覆盖 DSH 插件开发的完整链路：架构、Host/Client 两侧、设置面板、数据访问、
> 部署运维，以及所有踩过的坑。**给后续 DSH 插件开发打基础。**

## 0. 插件全景

DSH（DeepSeek Harness）插件 = **一个 npm 包 + cordis.patch.yml**：

```
my-plugin/
├── package.json          # name + dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 把插件挂进 profile 的 loader 树
├── lib/
│   ├── index.js          # Host 半侧（Node 运行）
│   └── client.js         # 浏览器半侧（__ModuleLoader__ 加载）
└── docs/                 # 文档
```

- **Host 半侧**：跑在 dsh 进程里（Node），`export function apply(ctx)` 是入口。
- **Client 半侧**：跑在浏览器里，`window.__ModuleLoader__.load({ id, factory })` 加载。
- **两半侧在同一个包**，通过 `package.json` 的 `exports["./client"]` + `dsh.client` 声明关联。

### 为什么这么设计

dsh 采用 cordis 插件体系：`cordis.patch.yml` 把插件 entry 插进 profile 的 loader 树，
dsh 启动时按 `dsh.profile.bundles` 列表（profile package.json 里）逐个应用 bundle 的 patch。
**不是扫 node_modules，是 bundles 白名单**——这是改名后插件消失的根因（见坑 9）。

## 1. 插件骨架

### package.json 关键字段

```jsonc
{
  "name": "dsh-session-pruner",
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" }
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime"] }
  }
}
```

- `dsh.client.inject`：client 依赖的**平台模块**（module table 里的），不是服务名。
- `files` 决定 npm 发布内容，**lib 和 cordis.patch.yml 必须包含**。

### cordis.patch.yml

```yaml
# 把插件挂进 profile
- insert:
    - id: dsh-session-pruner        # entry id（全局唯一）
      name: 'dsh-session-pruner'   # 包名
```

### Host 入口

```js
export const name = 'dsh-session-pruner'          // cordis 插件名
export const inject = ['timer', 'storageDomain'] // 注入的服务（见坑 1）
export function apply(ctx, config) { ... }    // 入口
```

## 2. Host 半侧开发

### 2.1 服务注入 —— 坑 1（最致命）

**cordis 的 ctx 服务属性必须 inject 声明才能访问**：

```js
// ❌ 崩溃：cannot get property "settings" without inject
console.log(ctx.settings)

// ✅ 正确：加进 inject 数组
export const inject = ['timer', 'storageDomain', 'settings']
```

**未声明直接访问 `ctx.xxx` 会在 apply 时抛错 → 整个插件树加载失败 → dsh 启动崩溃 →
guard 健康检查失败 → 自动回滚 → 插件被移除**（连锁反应，见坑 8）。
规避：`ctx.get('serviceName')` 动态获取**不需要** inject 声明（client 端同理）。

### 2.2 定时器 —— 坑 2

```js
// ❌ cordis TimerService 没有 clearInterval！
ctx.timer.clearInterval(timer)

// ✅ ctx.interval() 返回 disposer，调用即停止
const dispose = ctx.timer.interval(callback, ms)
// 改参数时：dispose() 后重新 interval()
```

`ctx.timer.setInterval` 是 deprecated 别名，返回的也是 disposer（不是原生 timer id）。

### 2.3 设置面板（插件配置页卡片）

官方机制：**Host 注册 settings 命名空间 + Client 注册同 key 卡片**，自动配对。

```js
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const NS = settingsNamespace('dsh-session-pruner')  // 命名空间 = 配对 key
export const Config = z.object({
  intervalMinutes: z.number().min(1).max(1440).default(60),
})

installSettingsSection(ctx, NS, Config, config, {
  setSource: (current) => { source = current },
  onChange: () => { /* 热加载：改配置即时生效 */ },
})
```

**关键点**：
- **NS 是配置段的持久化 key**（settings.yaml 的 `dsh-session-pruner:` 段）——**改名会丢配置**。
- `onChange` 注册时立即触发一次；之后每次保存触发 → 热加载闭环。
- settings 服务未挂载时 `installSettingsSection` **静默跳过**（不报错）——卡片不出现，
  插件本身照常工作（用 compose 配置）。

### 2.4 schemastery schema —— 坑 3

```js
// ❌ z.literal is not a function（schemastery 没有 literal）
archiveMode: z.union([z.literal('archive'), z.literal('delete')])

// ✅ 用 z.const
archiveMode: z.union([z.const('archive'), z.const('delete')]).default('archive')
```

schemastery 常用：`z.object / z.string / z.number / z.boolean / z.union / z.const / z.array`。
字段的 `.default()` 是默认值，**默认值在 user 层未覆盖时生效**。

### 2.5 数据访问（storageDomain）—— 坑 4

```js
// 拿已打开的域（session_projcache 由 dsh 的投影缓存服务打开）
const domain = ctx.storageDomain.get('session_projcache')
// ❌ domain.tables 是 Map，不是对象！
const table = domain.tables.sessions
// ✅ 用 table() 方法
const table = domain.table('sessions')
// KvTable API：get / set / delete / update / entries / keys / size
await table.delete(sessionId)   // 原子持久化，写链
await table.update(key, (rec) => ({ ...rec, ... }))  // 读改写
```

- `storageDomain.get(name)` 返回 `DomainImpl | undefined`——**域没 open 时是 undefined**，
  必须判空。
- 删除/更新走官方写链（内存 + 介质原子同步），**不要直接改文件**。

### 2.6 会话日志解析 —— 坑 5（zstd 多帧）

```js
// ❌ node zlib 只解单帧！dsh 日志是多 frame 拼接（append 写入），解出来只有前几行
zstdDecompressSync(buf)

// ✅ 用系统 zstd 命令（原生支持多帧）
execFile('zstd', ['-dc', logPath])
```

dsh 的会话日志 `session.jsonl.zstd` 是**多个 zstd frame 拼接**（每次 flush 追加一帧），
node zlib 的 `zstdDecompressSync`/流式都只处理第一帧。dsh 内部为此写了私有解码器
（依赖 node zlib 私有结构，不可移植）——插件直接调系统 `zstd` 最稳。

### 2.7 常用事件

- `session/disposed`：会话从 store detach → apiproxy 推 `host/session-removed` → client 自动移除列表项
- `session/event`：会话事件流
- `domain/changed`：storage 域变更（workspace 域变更 → host 推 workspace-changed）
- **冷会话（已 end-seed）不在内存 store**——删它们不会触发任何 host 推送，
  client 列表靠 `refreshList()` 重拉。

### 2.8 session/end-seed 语义 —— 坑 11（判定陷阱）

**`session/end-seed` 不是「会话完成」标记，只在会话真正 dispose 时才写入**。
大量子代理完成工作（最后事件 `assistant/message → step/end → turn/end`）但会话对象
没被 dispose（live 残留、进程重启丢 dispose）→ 磁盘上永远没有 end-seed。

以此为「完成判定」会**永远清理不了这些会话**（运行中保护一直拦着 → 堆积）。

**正确判定组合**：
1. `ended`（有 end-seed）→ 视为完成
2. **兜底**：`turn/end` 后 mtime 闲置超过宽限（如 1h）→ 视为死会话
3. **最小存活宽限**：即使判定完成，mtime 距今 <N 分钟（默认 3）→ 不清理（防误删收尾/引用）
4. live 保护：内存 store 挂着的不清理

## 3. Client 半侧开发

### 3.1 bundle 格式（手写，无构建链）

```js
window.__ModuleLoader__.load({
  id: 'dsh-session-pruner',        // 必须与包名一致
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const { createElement: h, useEffect, useState } = require('react');
    // require 从 loader module table 拿平台模块
    // 不能用 JSX——手写 createElement
    function apply(ctx) { ... }
    exports.apply = apply;
    exports.name = 'dsh-session-pruner';
    exports.inject = ['slots', 'settingsScope'];
    return module.exports;
  },
});
```

**不需要 tsdown/构建链**——手写即可（react 等从 module table require）。
官方构建模板（tsdown.client.ts）依赖 DSH 源码 checkout，本机没有时手写最实际。

### 3.2 设置卡片注册

```js
function apply(ctx) {
  ctx.slots.inject('settings.plugin.item', () => {
    const scope = ctx.settingsScope.bind({ namespace: NS });  // NS 与 Host 一致
    return ctx.slots.register({
      name: 'settings.plugin.item',
      key: NS,                       // 配对 Host namespace
      inject: () => ({ scope }),     // face 直接进组件 props
    }, LifecycleCard);
  });
}
```

- 卡片组件 `props.scope` = SettingsScope（`getSnapshot()/subscribe()/set()/unset()`）
- **官方卡片结构**：`li` 卡片默认折叠 → header button（名称+描述+chevron）→
  body（ValueField 字段 + footer：discard/save）。样式用 `--dsw-alias-*` CSS 变量。

### 3.3 client 服务获取 —— 坑 6

```js
// ❌ ctx.sessions 未 inject 会崩（同坑 1）
// ✅ ctx.get('sessions') 动态获取，不需要 inject
const svc = ctx.get('sessions')
if (svc && typeof svc.refreshList === 'function') svc.refreshList()
```

### 3.4 GUI 会话列表同步

host 删冷会话后 client 列表不感知（无推送）。方案：
- client 定时 `ctx.get('sessions').refreshList()`（session.list RPC 读磁盘，轻量）
- 间隔做成面板可配（settingsScope 订阅，改值即时重建 interval）

## 4. 部署运维

### 4.1 安装（link 开发模式）

```sh
dsh plugin --profile web add /path/to/plugin   # 会 pnpm add link: 进 profile
# 重启：launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web
```

**link 方式**：改插件代码 → 重启 dsh 即生效（不用重新 add）。

### 4.2 profile bundles 注册 —— 坑 7

改名/重建后插件消失，**根因是 profile package.json 的 `dsh.profile.bundles` 列表丢了插件**：

```jsonc
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", ..., "dsh-session-pruner"] } }
```

**bundle patch 应用 = bundles 白名单，不是扫 node_modules**。手动补回即可。

### 4.3 guard 回滚 —— 坑 8（最痛）

**任何插件启动崩溃 → dsh 健康检查失败 → guard 自动回滚 profile 到旧快照 → 插件被移除。
** 回滚后的 lockfile 可能丢失 integrity（见坑 10），需要恢复良好快照：

```sh
# 恢复良好快照（~/.dsh/rollbacks/web/ 下有各时间点快照）
cp ~/.dsh/rollbacks/web/<good-snapshot>/package.json ~/.dsh/profiles/web/
cp ~/.dsh/rollbacks/web/<good-snapshot>/pnpm-lock.yaml ~/.dsh/profiles/web/
dsh plugin --profile web add /path/to/plugin
```

**开发铁律**：改插件后先 `node --check lib/index.js && node --check lib/client.js`，
再重启。任何 apply 顶层抛错都会引发回滚灾难。

### 4.4 pnpm lockfile integrity —— 坑 10

GitHub tarball 依赖（如 `dsh-at-file`）在旧 lockfile 里可能无 integrity →
`pnpm install/add` 触发 supply-chain 检查失败：

```sh
pnpm clean --lockfile && pnpm install   # 重建 lockfile，自动补 integrity
```

重建后验证：`grep -A4 "dsh-at-file" pnpm-lock.yaml | grep integrity`。

### 4.5 验证清单

| 检查 | 命令 |
|---|---|
| 插件加载 | `grep armed <最新 server-*.out.log>` |
| 配置生效 | `grep hot-reloaded <最新 server-*.out.log>` |
| client bundle | `curl -s http://127.0.0.1:3080/ \| grep -o '"id":"<插件名>","url":"[^"]*"'` |
| 启动错误 | `grep Error <最新 server-*.err.log>` |
| profile 注册 | `dsh --profile web --dump-config \| grep <插件名>` |

## 5. 坑汇总表

| # | 坑 | 症状 | 解法 |
|---|---|---|---|
| 1 | ctx 服务未 inject 访问 | apply 崩 → 插件树加载失败 → guard 回滚 | inject 声明或 `ctx.get()` |
| 2 | cordis timer 无 clearInterval | onChange 抛 TypeError | `ctx.interval()` 返回 disposer |
| 3 | schemastery 无 z.literal | 插件加载失败（Config 顶层抛错） | `z.const()` |
| 4 | domain.tables 是 Map | 删缓存行静默失败 | `domain.table(name)` |
| 5 | zstd 多帧 | node zlib 解出前几行 | 系统 `zstd -dc` |
| 6 | client ctx 服务未 inject | client apply 崩（卡片不出现） | `ctx.get()` |
| 7 | bundles 白名单丢插件 | 插件消失（dump-config 无 entry） | 手动加回 bundles |
| 8 | guard 回滚 | 插件崩溃 → profile 回滚 → 插件被移除 | 恢复良好快照 + 重装 |
| 9 | 改名丢配置/消失 | NS 变配置丢；包名变 bundles 丢 | NS 不变；补 bundles |
| 10 | tarball 无 integrity | pnpm 操作 supply-chain 拒绝 | `pnpm clean --lockfile` 重建 |
| 11 | end-seed 非完成标记 | 判定卡死永远清理不了 | end-seed + mtime 闲置兜底 + 最小存活宽限 |

## 6. 测试模式

- **dry-run**：只读扫描会话库，验证识别逻辑（不删除）——生产数据安全演练。
- **e2e**：构造 fake 会话（zstd 压缩）→ 跑真实清理逻辑 → 验证删除/归档路径。
- 测试钩子：`export { runOnce, ... }` 导出内部函数供测试驱动（对生产加载无影响）。

## 7. 命名与发布规范

- 包名：`dsh-` + 功能名词（kebab-case），如 `dsh-session-pruner`、`dsh-archive-manager`。
- 卡片显示名：中文（用户偏好）或英文均可，与包名解耦。
- GitHub：仓库名 = 包名，加 `dsh-plugin` topic（官方可发现性机制，dsh-plugin-hub 市场自动收录）。
- npm：`npm publish`（files 含 lib + cordis.patch.yml；repository/author 字段齐全）。
