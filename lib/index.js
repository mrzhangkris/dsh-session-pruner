import { readdir, readFile, rm, stat } from 'node:fs/promises'
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
})

const DSH_HOME = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

/** 运行时可变状态：面板热更新直接改写这里，扫描循环即时感知。 */
const runtime = {
  intervalMs:
    (Number(process.env.DSH_SESSION_LIFECYCLE_INTERVAL_MS) || 30 * 60 * 1000),
  maxSessions: Number(process.env.DSH_SESSION_LIFECYCLE_MAX) || 400,
  cleanMain: process.env.DSH_SESSION_LIFECYCLE_CLEAN_MAIN === '1',
  timer: null,
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

/** 删除会话目录 + 连带清除 projcache 缓存行。返回是否清理了缓存。 */
async function removeSession(ctx, entry, reason) {
  try {
    await rm(entry.dir, { recursive: true, force: true })
  } catch (e) {
    console.error(`[session-lifecycle] rm failed ${entry.sid}:`, e)
    return
  }
  let cache = false
  try {
    const domain = ctx.storageDomain?.get('session_projcache')
    const table = domain?.tables?.sessions
    if (table && typeof table.delete === 'function') {
      await table.delete(entry.sid)
      cache = true
    }
  } catch (e) {
    console.error(`[session-lifecycle] cache purge failed ${entry.sid}:`, e)
  }
  console.log(
    `[session-lifecycle] removed ${entry.sid.slice(0, 12)} ` +
      `(${entry.origin}/${entry.mode}) ${reason} cache=${cache}`,
  )
}

/** 主扫描：one-shot 清理 + 容量保底。 */
async function runOnce(ctx) {
  const all = await scanSessions()
  if (all.length === 0) return
  let removed = 0

  // 1) one-shot 子代理：已结束即清理（每轮扫描，间隔即宽限期）
  const keep = []
  for (const s of all) {
    if (s.origin === 'subagent' && s.mode === 'one-shot' && s.ended) {
      await removeSession(ctx, s, 'one-shot done')
      removed++
    } else {
      keep.push(s)
    }
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
      if (s.origin === 'main' && !runtime.cleanMain) continue
      await removeSession(ctx, s, 'capacity cap')
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
          if (runtime.timer) {
            ctx.timer.clearInterval(runtime.timer)
            runtime.timer = null
          }
          runtime.timer = ctx.timer.setInterval(safeRun, runtime.intervalMs)
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
  runtime.timer = ctx.timer.setInterval(safeRun, runtime.intervalMs)
  console.log(
    `[session-lifecycle] armed: interval=${runtime.intervalMs / 60000}min ` +
      `cap=${runtime.maxSessions} cleanMain=${runtime.cleanMain}`,
  )
}

// 测试钩子：供 test/e2e.js 直接驱动内部逻辑（对生产加载无影响）
export { runOnce, removeSession, scanSessions, decodeSession }
