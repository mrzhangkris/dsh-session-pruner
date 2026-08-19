// dry-run 自测：只读扫描当前会话库，验证插件识别逻辑
// 不删除任何东西
import { readdir, readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
const DSH_HOME = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

async function decompressLog(logPath) {
  try {
    const { stdout } = await execFileAsync('zstd', ['-dc', logPath], {
      maxBuffer: 512 * 1024 * 1024,
      timeout: 30_000,
    })
    return stdout
  } catch {
    try {
      return (await readFile(logPath)).toString('utf8')
    } catch {
      return null
    }
  }
}

function decodeSession(text) {
  let origin = 'main'
  let mode = 'unknown'
  let ended = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (i === 0 || !line.includes('"type"')) {
      try {
        const h = JSON.parse(line)
        if (h.origin === 'subagent') origin = 'subagent'
      } catch {}
      continue
    }
    if (line.includes('session/end-seed')) ended = true
    if (!mode || mode === 'unknown') {
      if (line.includes('subagent/descriptor')) {
        try {
          const d = JSON.parse(line)
          const m = d.data?.mode
          if (m === 'one-shot' || m === 'continuable') mode = m
        } catch {}
      }
    }
  }
  return { origin, mode, ended }
}

const stats = { main: 0, sub_one_shot: 0, sub_cont: 0, sub_unknown: 0 }
const noEnd = []
const errs = []
let total = 0

for (const ws of await readdir(SESSIONS_ROOT)) {
  const wp = join(SESSIONS_ROOT, ws)
  let sids = []
  try { sids = await readdir(wp) } catch { continue }
  for (const sid of sids) {
    const log = join(wp, sid, 'session.jsonl.zstd')
    const text = await decompressLog(log)
    if (text === null) { errs.push(sid); continue }
    const info = decodeSession(text)
    total++
    if (info.origin === 'subagent') {
      if (info.mode === 'one-shot') stats.sub_one_shot++
      else if (info.mode === 'continuable') stats.sub_cont++
      else stats.sub_unknown++
    } else stats.main++
    if (!info.ended) noEnd.push(sid.slice(0, 12))
  }
}

console.log('TOTAL:', total)
console.log('分类:', stats)
console.log('未结束(运行中,保护不清):', noEnd.length, noEnd.slice(0, 5))
console.log('解析失败:', errs.length)
// 模拟 one-shot 清理动作：应删 0（当前无 one-shot）
console.log('dry-run: 按当前策略会删除', stats.sub_one_shot, '个（当前库无 one-shot，预期 0）')
