import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

const execFileAsync = promisify(execFile)

/**
 * dsh-session-lifecycle — 会话生命周期管理。
 *
 * 三层策略（对应会话库堆积的三个来源）：
 * 1. one-shot 子代理：跑完即弃，完成后下一轮扫描即清理（历史无价值）。
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
 * 配置（环境变量，缺省即下值）：
 * - DSH_SESSION_LIFECYCLE_INTERVAL_MS  扫描周期，默认 6h
 * - DSH_SESSION_LIFECYCLE_MAX          会话总量保底，默认 400
 * - DSH_SESSION_LIFECYCLE_CLEAN_MAIN   超限时是否允许清 main，默认 0
 */

export const name = 'session-lifecycle'

export const inject = ['timer', 'storageDomain']

/** 设置面板命名空间：与 client 卡片配对键。 */
export const NS = settingsNamespace('session-lifecycle')

/** 设置面板 schema（Host 侧声明，面板据此渲染表单）。 */
export const Config = z.object({
  /** 扫描间隔（分钟） */
  intervalMinutes: z.number().min(1).max(1440).default(30),
  /** 会话总量保底 */
  maxSessions: z.number().min(50).max(100000).default(400),
  /** 容量超限时是否允许清理 main 会话 */
  cleanMain: z.boolean().default(false),
  /** GUI 会话列表刷新间隔（秒）：client 轮询 refreshList 周期 */
  uiRefreshSeconds: z.number().min(5).max(600).default(30),
  /** 归档保留小时数：归档目录中的会话保留 N 小时后物理删除 */
  archiveHours: z.number().min(1).max(720).default(24),
  /** 归档方式：archive = 先归档（可恢复）再到期删除；delete = 不归档直接物理删除 */
  archiveMode: z.union([z.literal('archive'), z.literal('delete')]).default('archive'),
  /** 可续子代理闲置 N 天归档（0 = 不启用） */
  continuableIdleDays: z.number().min(0).max(365).default(0),
  /** 主会话闲置 N 天归档（0 = 不启用） */
  mainIdleDays: z.number().min(0).max(365).default(0),
})

const DSH_HOME = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
/** 归档目录：会话移出 sessions 目录即归档（GUI 不再显示），保留 archiveHours 后物理删除。 */
const ARCHIVE_ROOT = join(DSH_HOME, 'sessions-archive')

/** 运行时可变状态：面板热更新直接改写这里，扫描循环即时感知。 */
const runtime = {
  archiveHours: Number(process.env.DSH_SESSION_LIFECYCLE_ARCHIVE_HOURS) || 24,
  archiveMode: process.env.DSH_SESSION_LIFECYCLE_ARCHIVE_MODE === 'delete' ? 'delete' : 'archive',
  continuableIdleDays: Number(process.env.DSH_SESSION_LIFECYCLE_CONTINUABLE_IDLE_DAYS) || 0,
  mainIdleDays: Number(process.env.DSH_SESSION_LIFECYCLE_MAIN_IDLE_DAYS) || 0,
  intervalMs:
    (Number(process.env.DSH_SESSION_LIFECYCLE_INTERVAL_MS) || 30 * 60 * 1000),
  maxSessions: Number(process.env.DSH_SESSION_LIFECYCLE_MAX) || 400,
  cleanMain: process.env.DSH_SESSION_LIFECYCLE_CLEAN_MAIN === '1',
  disposeTimer: null,
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
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    // 第一行是会话头（origin 字段）；其余行分别匹配事件类型。
    if (i === 0 || !line.includes('"type"')) {
      try {
        const h = JSON.parse(line)
        if (h.origin === 'subagent') origin = 'subagent'
      } catch { /* 忽略坏行 */ }
      continue
    }
    if (line.includes('session/end-seed')) ended = true
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
  return { origin, mode, ended }
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
        mtime = (await stat(dir)).mtimeMs
      } catch { /* 目录可能已被删 */ }
      found.push({ ws, sid, dir, mtime, ...decodeSession(text) })
    }
  }
  return found
}

/** 把会话目录移入归档（保留 工作区/会话ID 相对路径），随后连带清 projcache 行 + workspace 记账。
 * 移出 sessions 目录后 GUI 即不再显示；archiveHours 后由 pruneArchive 物理删除。 */
async function archiveSession(ctx, entry, reason) {
  const sid = entry.sid
  try {
    if (runtime.archiveMode === 'delete') {
      await rm(entry.dir, { recursive: true, force: true })
    } else {
      const destWs = join(ARCHIVE_ROOT, entry.ws)
      await mkdir(destWs, { recursive: true })
      const dest = join(destWs, sid)
      await rm(dest, { recursive: true, force: true }) // 幂等：目标已存在则先清
      await rename(entry.dir, dest)
    }
  } catch (e) {
    console.error(`[session-lifecycle] archive failed ${sid}:`, e)
    return
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
    console.error(`[session-lifecycle] cache purge failed ${entry.sid}:`, e)
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
    console.error(`[session-lifecycle] workspace detach failed ${entry.sid}:`, e)
  }
  console.log(
    `[session-lifecycle] archived ${entry.sid.slice(0, 12)} ` +
      `(${entry.origin}/${entry.mode}) ${reason} cache=${cache}`,
  )
}

/** 物理删除归档目录中超过 archiveHours 的会话（0 = 不归档，不会走到这）。 */
async function pruneArchive(ctx) {
  if (runtime.archiveMode !== 'archive') return
  const cutoff = Date.now() - runtime.archiveHours * 3600 * 1000
  let removed = 0
  try {
    for (const ws of await readdir(ARCHIVE_ROOT)) {
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
    console.error('[session-lifecycle] pruneArchive error:', e)
  }
  if (removed > 0) {
    console.log(`[session-lifecycle] archive pruned: ${removed} expired`)
  }
}

/** 主扫描：one-shot 清理 + 容量保底。 */
async function runOnce(ctx) {
  await pruneArchive(ctx)
  const all = await scanSessions()
  if (all.length === 0) return
  let removed = 0
  const now = Date.now()

  // 1) 已完成 one-shot 子代理：立即归档/删除（结果已回传主会话，过程无价值）
  // 2) 闲置可续子代理 / 主会话：超过 idleDays 未活动 → 归档（可恢复）
  const keep = []
  for (const s of all) {
    if (!s.ended) {
      keep.push(s) // 运行中保护：未结束永不清理
      continue
    }
    if (s.origin === 'subagent' && s.mode === 'one-shot') {
      await archiveSession(ctx, s, 'one-shot done')
      removed++
      continue
    }
    const idleMs = (s.origin === 'main' ? runtime.mainIdleDays : runtime.continuableIdleDays) * 86400000
    if (idleMs > 0 && s.mtime && now - s.mtime > idleMs) {
      await archiveSession(ctx, s, `idle ${s.origin === 'main' ? 'main' : 'continuable'}`)
      removed++
      continue
    }
    keep.push(s)
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
        if (ctx.get('sessions')?.get?.(s.sid)) continue
      } catch { /* store 不可用时跳过检查 */ }
      if (s.origin === 'main' && !runtime.cleanMain) continue
      await archiveSession(ctx, s, 'capacity cap')
      trimmed++
      removed++
    }
  }

  console.log(
    `[session-lifecycle] scan done: ${all.length} total, removed ${removed}`,
  )
}

export function apply(ctx, config) {
  // 面板配置优先，其次环境变量（已在 runtime 初始化时读取）
  if (config) {
    if (config.intervalMinutes !== undefined) {
      runtime.intervalMs = config.intervalMinutes * 60 * 1000
    }
    if (config.maxSessions !== undefined) runtime.maxSessions = config.maxSessions
    if (config.cleanMain !== undefined) runtime.cleanMain = !!config.cleanMain
  }

  const safeRun = () => {
    runOnce(ctx).catch((e) =>
      console.error('[session-lifecycle] scan error:', e),
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
        console.log('[session-lifecycle] debug: onChange fired')
        try {
          const c = source()
          runtime.intervalMs = (c.intervalMinutes ?? 30) * 60 * 1000
          runtime.maxSessions = c.maxSessions ?? 400
          runtime.cleanMain = !!c.cleanMain
          runtime.archiveHours = c.archiveHours ?? 24
          runtime.archiveMode = c.archiveMode === 'delete' ? 'delete' : 'archive'
          runtime.continuableIdleDays = c.continuableIdleDays ?? 0
          runtime.mainIdleDays = c.mainIdleDays ?? 0
          if (runtime.disposeTimer) runtime.disposeTimer()
          runtime.disposeTimer = ctx.timer.interval(safeRun, runtime.intervalMs)
          console.log(
            `[session-lifecycle] hot-reloaded: interval=${(c.intervalMinutes ?? 30)}min ` +
              `cap=${c.maxSessions ?? 400} cleanMain=${!!c.cleanMain}`,
          )
        } catch (e) {
          console.error('[session-lifecycle] onChange error:', e)
        }
      },
    })
  } catch (e) {
    console.error('[session-lifecycle] settings section unavailable:', e)
  }

  // 启动后稍等（等 storageDomain 就绪），然后立即扫一次
  ctx.timer.setTimeout(safeRun, 5000)
  runtime.disposeTimer = ctx.timer.interval(safeRun, runtime.intervalMs)
  console.log(
    `[session-lifecycle] armed: interval=${runtime.intervalMs / 60000}min ` +
      `cap=${runtime.maxSessions} cleanMain=${runtime.cleanMain}`,
  )
}

// 测试钩子：供 test/e2e.js 直接驱动内部逻辑（对生产加载无影响）
export { runOnce, archiveSession, pruneArchive, scanSessions, decodeSession }
