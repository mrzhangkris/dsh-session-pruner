import { mkdir, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

const execFileAsync = promisify(execFile)

/**
 * dsh-session-pruner — 会话生命周期管理。
 *
 * 三层策略（对应会话库堆积的三个来源）：
 * 1. one-shot 子代理：跑完即弃，完成事件到达即归档（事件驱动热路径，
 *    秒级 + oneShotMinAgeMinutes 宽限），无需等扫描。
 * 2. 容量保底：全库会话数超过上限时，按「one-shot → continuable → main」的
 *    优先级 + 最后活动时间从旧到新清理，把总量钉死在上限内。
 * 3. 连带清理：每次删会话同步删除 session_projcache 里的缓存行（走
 *    storageDomain 写链，原子持久化），缓存不会残留膨胀——这正是不让
 *    projcache 回到 145MB 卡顿的关键。
 *
 * 安全保护：
 * - 仅删除「已结束」（日志含 session/end-seed）的会话，运行中的永不清理；
 * - main（主）会话默认永不自动删，仅容量超限且显式开启 cleanMain 才考虑；
 * - 每个删除动作都 try/catch，任何失败只记日志不影响其他清理。
 *
 * 触发双轨（事件为热路径，磁盘为权威，事件易失靠扫描兜底）：
 * - 事件：subagent/end + agent/disposed → 候选队列（500ms 批窗口 + 宽限）→ 秒级归档；
 * - 扫描：启动重扫 + intervalMinutes 慢周期对账（默认 60min），兜底事件丢失/手工清理。
 *
 * GUI 同步双轨：
 * - dirty-flag：host 归档写内存变更日志（archiveSeq），client 每 3s 轮询
 *   /plugins/dsh-session-pruner/archived，有变更才发 refresh RPC（主路径）；
 * - 兜底：client 每 uiRefreshSeconds 秒全量 refreshList + refreshSubagents。
 *
 * 配置（环境变量，缺省即下值）：
 * - DSH_SESSION_PRUNER_INTERVAL_MS  对账扫描周期，默认 60min
 * - DSH_SESSION_PRUNER_MAX          会话总量保底，默认 400
 * - DSH_SESSION_PRUNER_CLEAN_MAIN   超限时是否允许清 main，默认 0
 */

export const name = 'dsh-session-pruner'

export const inject = ['timer', 'storageDomain']

/** 设置面板命名空间：与 client 卡片配对键（client bundle 无法 import host 模块，故不导出）。 */
const NS = settingsNamespace('dsh-session-pruner')

/** 设置面板 schema（Host 侧声明，面板据此渲染表单；内部经 installSettingsSection 消费）。 */
const Config = z.object({
  /** 扫描间隔（分钟）：事件驱动为主路径，定时扫描降级为对账兜底 */
  intervalMinutes: z.number().min(1).max(1440).default(60),
  /** 会话总量保底 */
  maxSessions: z.number().min(50).max(100000).default(400),
  /** 容量超限时是否允许清理 main 会话 */
  cleanMain: z.boolean().default(false),
  /** GUI 会话列表兜底刷新间隔（秒）：dirty-flag 为主路径，此值为全量兜底周期 */
  uiRefreshSeconds: z.number().min(5).max(600).default(30),
  /** 归档保留小时数：归档目录中的会话保留 N 小时后物理删除 */
  archiveHours: z.number().min(1).max(720).default(24),
  /** 归档方式：archive = 先归档（可恢复）再到期删除；delete = 不归档直接物理删除 */
  archiveMode: z.union([z.const('archive'), z.const('delete')]).default('archive'),
  /** 可续子代理闲置 N 天归档（0 = 不启用） */
  continuableIdleDays: z.number().min(0).max(365).default(0),
  /** 主会话闲置 N 天归档（0 = 不启用） */
  mainIdleDays: z.number().min(0).max(365).default(0),
  /** one-shot 闲置归档阈值（分钟）：无论有无 end-seed，闲置超过 N 分钟即归档（防误删收尾/引用） */
  oneShotMinAgeMinutes: z.number().min(0).max(60).default(3),
  /** pin 白名单：这些会话 ID 永不自动清理（恢复会话/重点保留时用，面板每行一个） */
  pinnedIds: z.array(z.string()).default([]),
})

const DSH_HOME = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
/** 归档目录：会话移出 sessions 目录即归档（GUI 不再显示），保留 archiveHours 后物理删除。 */
const ARCHIVE_ROOT = join(DSH_HOME, 'sessions-archive')

/** 运行时可变状态：面板热更新直接改写这里，扫描循环即时感知。 */
const runtime = {
  archiveHours: Number(process.env.DSH_SESSION_PRUNER_ARCHIVE_HOURS) || 24,
  archiveMode: process.env.DSH_SESSION_PRUNER_ARCHIVE_MODE === 'delete' ? 'delete' : 'archive',
  continuableIdleDays: Number(process.env.DSH_SESSION_PRUNER_CONTINUABLE_IDLE_DAYS) || 0,
  mainIdleDays: Number(process.env.DSH_SESSION_PRUNER_MAIN_IDLE_DAYS) || 0,
  // oneShotMinAgeMinutes 允许 0（关闭宽限）：用 isFinite 而非 || 兜底，否则 '0' 被吞成 3
  oneShotMinAgeMs:
    (Number.isFinite(Number(process.env.DSH_SESSION_PRUNER_ONE_SHOT_MIN_AGE_MINUTES))
      ? Number(process.env.DSH_SESSION_PRUNER_ONE_SHOT_MIN_AGE_MINUTES)
      : 3) * 60 * 1000,
  intervalMs:
    (Number(process.env.DSH_SESSION_PRUNER_INTERVAL_MS) || 60 * 60 * 1000),
  maxSessions: Number(process.env.DSH_SESSION_PRUNER_MAX) || 400,
  cleanMain: process.env.DSH_SESSION_PRUNER_CLEAN_MAIN === '1',
  // pin 白名单（环境变量兜底，面板优先）：逗号分隔会话 ID，命中的永不清理
  pinned: new Set(
    (process.env.DSH_SESSION_PRUNER_PINNED_IDS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean)),
  disposeTimer: null,
}

/** 配置写入 runtime 的单一来源（apply 的 composition entry 与 settings onChange 共用，
 * 消除双源——旧版 apply 只写 3 字段、onChange 写 10 字段，覆盖不一致）。
 * c 中 undefined 的字段跳过：apply 场景保住环境变量兜底；onChange 场景 schema
 * resolve 已填满默认值，全量生效。uiRefreshSeconds 不进 runtime（client 侧直读）。 */
function applyRuntimeConfig(c) {
  if (c.intervalMinutes !== undefined) runtime.intervalMs = c.intervalMinutes * 60 * 1000
  if (c.maxSessions !== undefined) runtime.maxSessions = c.maxSessions
  if (c.cleanMain !== undefined) runtime.cleanMain = !!c.cleanMain
  if (c.archiveHours !== undefined) runtime.archiveHours = c.archiveHours
  if (c.archiveMode !== undefined) runtime.archiveMode = c.archiveMode === 'delete' ? 'delete' : 'archive'
  if (c.continuableIdleDays !== undefined) runtime.continuableIdleDays = c.continuableIdleDays
  if (c.mainIdleDays !== undefined) runtime.mainIdleDays = c.mainIdleDays
  if (c.oneShotMinAgeMinutes !== undefined) runtime.oneShotMinAgeMs = c.oneShotMinAgeMinutes * 60 * 1000
  if (Array.isArray(c.pinnedIds)) runtime.pinned = new Set(c.pinnedIds)
}

/** 清理优先级：one-shot 最先清，main 最后。 */
function priority(entry) {
  if (entry.origin !== 'subagent') return 2
  return entry.mode === 'one-shot' ? 0 : 1
}

/** 解压会话日志全文。dsh 日志是多 zstd frame 拼接，node zlib 只解单帧，
 * 因此调用系统 zstd 命令（原生支持多帧）。失败返回 null。 */
async function decompressLog(logPath) {
  try {
    const { stdout } = await execFileAsync('zstd', ['-dc', logPath], {
      maxBuffer: 512 * 1024 * 1024,
      timeout: 30_000,
    })
    return stdout
  } catch {
    // 纯文本回退（未压缩的 .jsonl 不会走到这；容忍坏帧文件）
    try {
      const buf = await readFile(logPath)
      // S5 修复：zstd 魔数 28 B5 2F FD——解压失败且文件仍是 zstd 头=坏帧，返回 null 不解析（避免二进制当 UTF-8 误判 ended）
      if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
        return null
      }
      return buf.toString('utf8')
    } catch {
      return null
    }
  }
}

/**
 * 解开会话日志，提取生命周期判定所需的三个字段。
 * origin: 'main' | 'subagent'；mode: 'one-shot' | 'continuable' | 'unknown'；
 * ended: 是否出现 session/end-seed（已结束）。
 */
function decodeSession(text) {
  let origin = 'main'
  let mode = 'unknown'
  let ended = false
  let parentSession
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    // 第一行是会话头（origin 字段）；其余行分别匹配事件类型。
    if (i === 0) {
      // 仅首行是会话头（origin/parentSession）；后续行按事件行处理，
      // 不因缺失 "type" 被误当 header 覆盖 origin（扁鹊🟠a）
      try {
        const h = JSON.parse(line)
        if (h.origin === 'subagent') origin = 'subagent'
        if (h.parentSession) parentSession = h.parentSession
      } catch { /* 忽略坏行 */ }
      continue
    }
    if (!line.includes('"type"')) continue // 非事件行跳过
    // ended 精判（审计修复）：先 includes 粗筛保性能，再 JSON.parse 校验 type——
    // 旧版纯字符串包含会把「用户消息文本里出现 session/end-seed 字样」的行
    // 误判为已结束，绕过运行中保护（如在本插件里讨论该字段名的开发会话）。
    if (line.includes('session/end-seed')) {
      try {
        if (JSON.parse(line).type === 'session/end-seed') ended = true
      } catch { /* 忽略坏行 */ }
    }
    if (!mode || mode === 'unknown') {
      if (line.includes('subagent/descriptor')) {
        try {
          const d = JSON.parse(line)
          const m = d.data?.mode
          if (m === 'one-shot' || m === 'continuable') mode = m
        } catch { /* 忽略 */ }
      }
    }
  }
  return { origin, mode, ended, ...(parentSession ? { parentSession } : {}) }
}

/** 扫描磁盘上全部会话目录，返回元信息数组。损坏/不可读的会话跳过。 */
async function scanSessions() {
  const found = []
  let wsNames = []
  try {
    wsNames = await readdir(SESSIONS_ROOT)
  } catch {
    return found
  }
  for (const ws of wsNames) {
    const wp = join(SESSIONS_ROOT, ws)
    let sids = []
    try {
      sids = await readdir(wp)
    } catch {
      continue
    }
    for (const sid of sids) {
      const dir = join(wp, sid)
      const log = join(dir, 'session.jsonl.zstd')
      const text = await decompressLog(log)
      if (text === null) continue
      let mtime = 0
      try {
        // S2 修复：DSH 追加写 session.jsonl.zstd（改文件内容）不更新目录 mtime，
        // 改用日志文件 mtime（最后写入时刻）判闲置；stat 失败回退目录 mtime
        mtime = (await stat(log)).mtimeMs
      } catch {
        try { mtime = (await stat(dir)).mtimeMs } catch { /* 目录可能已被删 */ }
      }
      // mtime 无法确定（两种 stat 都失败）→ 跳过该会话，安全优先
      if (mtime === 0) continue
      found.push({ ws, sid, dir, mtime, ...decodeSession(text) })
    }
  }
  return found
}

// ============ GUI dirty-flag 数据源（Step 2） ============
// 归档变更日志：内存单调 seq + 最近 N 条。client 每 3s 轮询
// /plugins/dsh-session-pruner/archived?since=N，有变更才发刷新 RPC。
// 内存是变更日志（非权威），重启丢没关系——client 兜底轮询会补齐。
const archiveLog = []
let archiveSeq = 0
const ARCHIVE_LOG_MAX = 200

function recordArchive(sessionId, parentSessionId) {
  archiveSeq++
  archiveLog.push({
    seq: archiveSeq,
    sessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
    at: Date.now(),
  })
  if (archiveLog.length > ARCHIVE_LOG_MAX) archiveLog.shift()
}

/** 归档目录现状 + 清理快照（status 路由数据源）。归档目录只做轻量 stat，
 * 清理数据来自 lastScanStatus（最近一轮扫描缓存）——路由永不触发全量 zstd 解压。 */
async function buildStatusSnapshot() {
  const archived = { count: 0, oldestExpiresAt: null }
  try {
    for (const ws of await readdir(ARCHIVE_ROOT)) {
      let sids = []
      try { sids = await readdir(join(ARCHIVE_ROOT, ws)) } catch { continue }
      for (const sid of sids) {
        try {
          const st = await stat(join(ARCHIVE_ROOT, ws, sid))
          archived.count++
          const expiresAt = st.mtimeMs + runtime.archiveHours * 3600 * 1000
          if (archived.oldestExpiresAt === null || expiresAt < archived.oldestExpiresAt) {
            archived.oldestExpiresAt = expiresAt
          }
        } catch { /* 并发物理删除则跳过 */ }
      }
    }
  } catch { /* 归档目录不存在（delete 模式/从未归档） */ }
  return {
    archiveMode: runtime.archiveMode,
    maxSessions: runtime.maxSessions,
    pinned: runtime.pinned.size,
    archived,
    total: lastScanStatus.total,
    overCapacity: Math.max(0, lastScanStatus.total - runtime.maxSessions),
    lastScanAt: lastScanStatus.generatedAt,
    lastScanRemoved: lastScanStatus.archivedCount,
    lastScanArchived: lastScanStatus.archived,
  }
}

/** 注册 dirty-flag 路由（webServer 晚绑定：未就绪时监听 internal/service 补挂）。 */
const WEB_SERVER_KEYS = ['webServer', 'httpServer']
function registerArchiveRoute(ctx) {
  const webServer = ctx.get?.(WEB_SERVER_KEYS[0]) ?? ctx.get?.(WEB_SERVER_KEYS[1])
  if (!webServer || typeof webServer.register !== 'function') return false
  try {
    webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-session-pruner/archived',
      handler: (req, res) => {
        let since = 0
        try {
          since = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('since')) || 0
        } catch { /* 非法 since 视为 0（全量） */ }
        // 携带 parentSessionId：client 据此刷新受影响父会话的子代理目录
        // （one-shot 归档后其父可能已不在 client byId 里，必须由 host 告知）
        const archived = archiveLog.filter((r) => r.seq > since).map((r) => ({
          sessionId: r.sessionId,
          ...(r.parentSessionId ? { parentSessionId: r.parentSessionId } : {}),
        }))
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ seq: archiveSeq, archived }))
      },
    })
    // 状态快照路由：归档目录现状 + 最近一轮清理（面板状态行数据源，轻量）
    webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-session-pruner/status',
      handler: (req, res) => {
        buildStatusSnapshot()
          .then((snap) => {
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(snap))
          })
          .catch((e) => {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: String(e) }))
          })
      },
    })
    return true
  } catch (e) {
    console.error('[dsh-session-pruner] route register failed:', e)
    return false
  }
}

/** 把会话目录移入归档（保留 工作区/会话ID 相对路径），随后连带清 projcache 行 + workspace 记账。
 * 移出 sessions 目录后 GUI 即不再显示；archiveHours 后由 pruneArchive 物理删除。
 * @returns {Promise<boolean>} 是否真的执行了归档（pin 拦截/IO 失败返回 false，调用方不计入清理数） */
async function archiveSession(ctx, entry, reason) {
  const sid = entry.sid
  // pin 白名单：所有清理路径（one-shot 闲置/事件/容量保底/闲置归档）的必经点统一拦截。
  // 放在函数入口而非各调用点——单点防护，新增清理路径不会漏。宁可不删不可误删。
  if (runtime.pinned.has(sid)) {
    console.log(`[dsh-session-pruner] pinned skip ${sid.slice(0, 12)} (${reason})`)
    return false
  }
  try {
    if (runtime.archiveMode === 'delete') {
      await rm(entry.dir, { recursive: true, force: true })
    } else {
      const destWs = join(ARCHIVE_ROOT, entry.ws)
      await mkdir(destWs, { recursive: true })
      const dest = join(destWs, sid)
      await rm(dest, { recursive: true, force: true }) // 幂等：目标已存在则先清
      await rename(entry.dir, dest)
      // 归档后 touch：把目录 mtime 刷成归档时刻。rename 保留原 mtime（最后活动
      // 时间），若不刷新，闲置多日的会话归档后 mtime 仍是很久以前 → pruneArchive
      // 按「mtime 早于 cutoff=now-24h」判定会把它立即物理删除，「归档保留 24h
      // 可恢复」形同虚设。touch 后 mtime=归档时刻，保留期从归档起算（正确语义）。
      // touch 失败不阻断归档：rename 已成功，只是保留期语义退化（下次扫描仍按旧
      // mtime 判），但至少不误删本次会话。
      try {
        const nowMs = Date.now()
        await utimes(dest, new Date(nowMs), new Date(nowMs))
      } catch { /* touch 失败可容忍 */ }
    }
  } catch (e) {
    console.error(`[dsh-session-pruner] archive failed ${sid}:`, e)
    return false
  }
  let cache = false
  try {
    const domain = ctx.storageDomain?.get('session_projcache')
    const table = domain && (typeof domain.table === 'function'
      ? domain.table('sessions')
      : domain.tables?.get?.('sessions'))
    if (table && typeof table.delete === 'function') {
      await table.delete(entry.sid)
      cache = true
    }
  } catch (e) {
    console.error(`[dsh-session-pruner] cache purge failed ${entry.sid}:`, e)
  }
  // workspace 记账清理：把 sessionId 从所属 workspace 的 sessionIds 移除，
  // 让 GUI 会话列表的数据源（workspace 域）与磁盘一致；删除会触发
  // domain/changed → host 推送 host/workspace-changed → client 工作区视图同步。
  try {
    const wsDomain = ctx.storageDomain?.get('workspace')
    const wsTable = wsDomain?.tables?.workspaces
    if (wsTable && typeof wsTable.update === 'function') {
      for (const [wsId, rec] of wsTable.entries()) {
        const ids = rec?.sessionIds
        if (Array.isArray(ids) && ids.includes(entry.sid)) {
          await wsTable.update(wsId, (record) =>
            record.sessionIds.includes(entry.sid)
              ? { ...record, sessionIds: record.sessionIds.filter((id) => id !== entry.sid) }
              : record)
          break
        }
      }
    }
  } catch (e) {
    console.error(`[dsh-session-pruner] workspace detach failed ${entry.sid}:`, e)
  }
  recordArchive(entry.sid, entry.parentSession)
  console.log(
    `[dsh-session-pruner] archived ${entry.sid.slice(0, 12)} ` +
      `(${entry.origin}/${entry.mode}) ${reason} cache=${cache}`,
  )
  return true
}

/** 物理删除归档目录中超过 archiveHours 的会话。
 * 注意：不看 runtime.archiveMode——归档目录里只会有 archive 模式时期移入的会话，
 * 「archive 模式下承诺的保留期」不因用户后来切到 delete 模式而作废；若在 delete
 * 模式下跳过，切换前归档的会话将永远残留在磁盘（审计修复：旧版提前 return）。 */
async function pruneArchive(ctx) {
  const cutoff = Date.now() - runtime.archiveHours * 3600 * 1000
  let removed = 0
  let wsList = []
  try {
    wsList = await readdir(ARCHIVE_ROOT)
  } catch {
    return // 归档目录尚不存在（首次归档前）
  }
  try {
    for (const ws of wsList) {
      const wp = join(ARCHIVE_ROOT, ws)
      let sids = []
      try {
        sids = await readdir(wp)
      } catch {
        continue
      }
      for (const sid of sids) {
        const dir = join(wp, sid)
        try {
          const st = await stat(dir)
          if (st.mtimeMs < cutoff) {
            await rm(dir, { recursive: true, force: true })
            removed++
          }
        } catch {
          continue
        }
      }
    }
  } catch (e) {
    console.error('[dsh-session-pruner] pruneArchive error:', e)
  }
  if (removed > 0) {
    console.log(`[dsh-session-pruner] archive pruned: ${removed} expired`)
  }
}

/** 单会话清理判定（不含 live/容量保底，runOnce 与 status 预览复用同一逻辑）。
 * 返回 { action: 'archive', reason } 或 { action: 'keep' }。 */
function classifySession(s, now) {
  // one-shot 子代理：闲置超过 oneShotMinAgeMinutes 即归档（有/无 end-seed 统一阈值）。
  if (s.origin === 'subagent' && s.mode === 'one-shot') {
    const ageMs = s.mtime ? now - s.mtime : Infinity
    if (ageMs > runtime.oneShotMinAgeMs) return { action: 'archive', reason: 'one-shot idle' }
    return { action: 'keep' } // 运行中保护：未结束且活跃（mtime 新）不清理
  }
  if (!s.ended) return { action: 'keep' } // 运行中保护：未结束的非 one-shot 永不清理
  // 闲置可续子代理 / 主会话：超过 idleDays 未活动 → 归档（可恢复）
  const idleMs = (s.origin === 'main' ? runtime.mainIdleDays : runtime.continuableIdleDays) * 86400000
  if (idleMs > 0 && s.mtime && now - s.mtime > idleMs) {
    return { action: 'archive', reason: `idle ${s.origin === 'main' ? 'main' : 'continuable'}` }
  }
  return { action: 'keep' }
}

/** 最近一轮扫描的清理快照（status 路由数据源；重扫时更新）。
 * archived = 本轮命中判定并实际归档的清单（审计/面板展示），非前瞻预测。 */
let lastScanStatus = { generatedAt: 0, total: 0, archivedCount: 0, archived: [] }

/** 主扫描：one-shot 清理 + 容量保底。 */
async function runOnce(ctx) {
  await pruneArchive(ctx)
  const all = await scanSessions()
  if (all.length === 0) return
  let removed = 0
  const now = Date.now()
  const archivedThisRun = []

  const keep = []
  for (const s of all) {
    const live = (() => {
      // S3 修复：fail-closed——store 查询异常视为 live（不可清理），宁可不删不可误删
      try { return !!ctx.get?.('sessions')?.get?.(s.sid) } catch { return true }
    })()
    if (live) {
      keep.push(s) // live 保护：内存 store 挂着的不清理
      continue
    }
    if (runtime.pinned.has(s.sid)) {
      keep.push(s) // pin 白名单：面板标记永不清理的会话
      continue
    }
    const verdict = classifySession(s, now)
    if (verdict.action === 'archive') {
      if (await archiveSession(ctx, s, verdict.reason)) {
        archivedThisRun.push({ sid: s.sid, origin: s.origin, mode: s.mode, reason: verdict.reason })
        removed++
        continue
      }
    }
    keep.push(s) // 未命中判定 / pin 拦截 / 归档失败 → 保留
  }

  // 2) 容量保底
  if (keep.length > runtime.maxSessions) {
    const excess = keep.length - runtime.maxSessions
    const sorted = [...keep].sort((a, b) => {
      const pa = priority(a)
      const pb = priority(b)
      return pa !== pb ? pa - pb : a.mtime - b.mtime
    })
    let trimmed = 0
    for (const s of sorted) {
      if (trimmed >= excess) break
      // 运行中保护：未结束（无 session/end-seed）的会话永不清理
      if (!s.ended) continue
      // live 保护：内存 session store 里仍挂着的会话（被打开/加载中）不清理
      try {
        if (ctx.get?.('sessions')?.get?.(s.sid)) continue
      } catch {
        continue // S3 fail-closed：store 异常视为 live，跳过该会话
      }
      if (s.origin === 'main' && !runtime.cleanMain) continue
      if (await archiveSession(ctx, s, 'capacity cap')) {
        archivedThisRun.push({ sid: s.sid, origin: s.origin, mode: s.mode, reason: 'capacity cap' })
        trimmed++
        removed++
      }
    }
  }

  // status 快照：本轮清理清单（面板「最近清理」数据源）
  lastScanStatus = { generatedAt: now, total: all.length, archivedCount: removed, archived: archivedThisRun.slice(0, 50) }

  console.log(
    `[dsh-session-pruner] scan done: ${all.length} total, removed ${removed}`,
  )
}

// ============ 事件驱动即时归档（Step 1：替代 30min 扫描的热路径） ============
// 原理（借鉴 dsh-agent-teams 调度器）：订阅子代理生命周期事件，完成即入待归档
// 候选；500ms 批窗口合并风暴；保留 oneShotMinAgeMinutes 宽限（定时复查）；
// 热路径不碰全量 zstd 解压——只在宽限到期后对【单个】候选会话解压判定。
// 定时扫描（runOnce）保留为启动重扫 + 慢周期对账兜底（事件易失，磁盘权威）。

/** 从内存会话事件里取 subagent/descriptor 的 mode（不回退磁盘）。 */
function descriptorModeFromEvents(events) {
  if (!Array.isArray(events)) return undefined
  for (const e of events) {
    if (e && e.type === 'subagent/descriptor') {
      const m = e.data && e.data.mode
      if (m === 'one-shot' || m === 'continuable') return m
    }
  }
  return undefined
}

/** 按 sid 定位会话目录（只遍历目录名，不解压日志）。找不到返回 null。 */
async function locateSession(sid) {
  let wsNames = []
  try {
    wsNames = await readdir(SESSIONS_ROOT)
  } catch {
    return null
  }
  for (const ws of wsNames) {
    try {
      const sids = await readdir(join(SESSIONS_ROOT, ws))
      if (sids.includes(sid)) return { ws, sid, dir: join(SESSIONS_ROOT, ws, sid) }
    } catch { /* 目录被并发删除则跳过 */ }
  }
  return null
}

/** 待归档候选：sid -> { reason, at }。 */
const candidates = new Map()
let candidateFlushTimer = null

/** 事件入队：同一 sid 只记一次；触发 500ms 批窗口。 */
function enqueueCandidate(sid) {
  if (candidates.has(sid)) return
  candidates.set(sid, { reason: 'event', at: Date.now() })
  scheduleCandidateFlush(500)
}

function scheduleCandidateFlush(delay) {
  if (candidateFlushTimer) return
  candidateFlushTimer = setTimeout(() => {
    candidateFlushTimer = null
    flushCandidates().catch((e) =>
      console.error('[dsh-session-pruner] event flush error:', e),
    )
  }, delay)
}

/** 批窗口处理：宽限到期才归档；未到期安排定时复查；live/非 one-shot/未结束跳过。 */
async function flushCandidates() {
  const minAge = runtime.oneShotMinAgeMs
  const now = Date.now()
  let nextAt = Infinity
  for (const [sid, c] of [...candidates.entries()]) {
    if (now - c.at < minAge) {
      nextAt = Math.min(nextAt, c.at + minAge)
      continue
    }
    candidates.delete(sid)
    await archiveCandidate(sid)
  }
  if (candidates.size > 0 && nextAt !== Infinity) {
    scheduleCandidateFlush(Math.max(1000, nextAt - Date.now()))
  }
}

/** 单个候选归档：live 保护 + ended + one-shot 判定，复用 archiveSession（幂等）。 */
async function archiveCandidate(sid) {
  const ctx = activeCtx
  if (!ctx) return
  try {
    if (ctx.get?.('sessions')?.get?.(sid)) return // live 保护：仍在内存 store 不归档
    const located = await locateSession(sid)
    if (!located) return // 已不在磁盘（可能已被归档/删除）
    const text = await decompressLog(join(located.dir, 'session.jsonl.zstd'))
    if (text === null) return
    const entry = { ...located, ...decodeSession(text) }
    if (!entry.ended) return // 未结束（运行中保护）
    if (!(entry.origin === 'subagent' && entry.mode === 'one-shot')) return
    await archiveSession(ctx, entry, 'one-shot event')
    console.log(`[dsh-session-pruner] event archived ${sid.slice(0, 12)} (one-shot done)`)
  } catch (e) {
    console.error(`[dsh-session-pruner] event archive failed ${sid.slice(0, 12)}:`, e)
  }
}
/** apply 时挂载的 host ctx（事件回调与候选归档共用）。 */
let activeCtx = null

export function apply(ctx, config) {
  activeCtx = ctx
  // composition entry 里的配置（面板设置经 installSettingsSection 的 onChange
  // 全量热更新，此处只覆盖 settings 服务就绪前的窗口）
  if (config) applyRuntimeConfig(config)

  // 事件驱动即时归档（Step 1）：子代理完成即入候选队列，宽限后归档——
  // 替代「等下一轮扫描」的热路径。双保险：subagent/end 为主，agent/disposed
  // 兜底（覆盖事件漏发/会话已 detach 无法内存判定 mode 的情况，由
  // archiveCandidate 的磁盘判定过滤）。监听随 ctx 生命周期自动清理。
  ctx.on?.('subagent/end', ({ id }) => {
    if (!id) return
    try {
      const session = ctx.get?.('sessions')?.get?.(id)
      if (!session) return // 已 detach：交给 agent/disposed 兜底
      if (session.header?.origin !== 'subagent') return
      if (descriptorModeFromEvents(session.events) !== 'one-shot') return
      enqueueCandidate(id)
    } catch (e) {
      console.error('[dsh-session-pruner] subagent/end handler error:', e)
    }
  })
  ctx.on?.('agent/disposed', ({ agent }) => {
    if (!agent?.id) return
    try {
      // 与 subagent/end 同款过滤：dispose 时 session 通常仍在 store，能内存判定
      // mode；已 detach 的才无脑入队（交给 archiveCandidate 磁盘判定把关）。
      const session = ctx.get?.('sessions')?.get?.(agent.id)
      if (session) {
        if (session.header?.origin !== 'subagent') return
        if (descriptorModeFromEvents(session.events) !== 'one-shot') return
      }
      enqueueCandidate(agent.id)
    } catch (e) {
      console.error('[dsh-session-pruner] agent/disposed handler error:', e)
    }
  })

  // GUI dirty-flag 路由（Step 2）：webServer 未就绪时晚绑定补挂。
  if (!registerArchiveRoute(ctx)) {
    ctx.on?.('internal/service', (name) => {
      if (WEB_SERVER_KEYS.includes(name)) registerArchiveRoute(ctx)
    })
  }

  const safeRun = () => {
    runOnce(ctx).catch((e) =>
      console.error('[dsh-session-pruner] scan error:', e),
    )
  }

  // 设置面板热加载：onChange 时用新配置立即改写运行时状态并重排定时器。
  let source = () => config
  try {
    installSettingsSection(ctx, NS, Config, config, {
      setSource: (current) => {
        source = current
      },
      onChange: () => {
        try {
          const c = source()
          applyRuntimeConfig(c)
          if (runtime.disposeTimer) runtime.disposeTimer()
          runtime.disposeTimer = ctx.timer.interval(safeRun, runtime.intervalMs)
          console.log(
            `[dsh-session-pruner] hot-reloaded: interval=${runtime.intervalMs / 60000}min ` +
              `cap=${runtime.maxSessions} cleanMain=${runtime.cleanMain} ` +
              `ui=${c.uiRefreshSeconds ?? 30}s arch=${runtime.archiveHours}h ` +
              `mode=${runtime.archiveMode} ` +
              `contIdle=${runtime.continuableIdleDays}d mainIdle=${runtime.mainIdleDays}d ` +
              `pinned=${runtime.pinned.size}`,
          )
        } catch (e) {
          console.error('[dsh-session-pruner] onChange error:', e)
        }
      },
    })
  } catch (e) {
    console.error('[dsh-session-pruner] settings section unavailable:', e)
  }

  // 启动后稍等（等 storageDomain 就绪），然后立即扫一次
  ctx.timer.setTimeout(safeRun, 5000)
  runtime.disposeTimer = ctx.timer.interval(safeRun, runtime.intervalMs)
  console.log(
    `[dsh-session-pruner] armed: interval=${runtime.intervalMs / 60000}min ` +
      `cap=${runtime.maxSessions} cleanMain=${runtime.cleanMain}`,
  )
}

// 测试钩子：供 test/e2e.js 直接驱动内部逻辑（对生产加载无影响）
export {
  runOnce,
  archiveSession,
  pruneArchive,
  scanSessions,
  decodeSession,
  decompressLog,
  classifySession,
  buildStatusSnapshot,
  enqueueCandidate,
  flushCandidates,
  locateSession,
  descriptorModeFromEvents,
}
// 测试钩子：e2e 注入 mock ctx（生产加载时 apply 会覆盖）
export function __setActiveCtxForTest(ctx) {
  activeCtx = ctx
}
// 测试钩子：暴露 runtime（e2e 直接改 runtime.pinned 等验证 pin/配置热路径；
// 生产代码只经 apply/onChange 写入）
export const __runtimeForTest = runtime
