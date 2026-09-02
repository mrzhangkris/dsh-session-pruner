// dry-run 自测：只读扫描当前会话库，验证插件识别逻辑
// 不删除任何东西
// 识别/解压逻辑直接复用 lib（测试钩子导出），杜绝双源漂移——
// 旧版自带一份 decodeSession 副本，lib 修复（如扁鹊🟠a）后 dry-run 仍跑旧逻辑，
// 统计结果不代表生产行为。
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeSession, decompressLog } from '../lib/index.js'

const DSH_HOME = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

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
console.log('dry-run: 当前库 one-shot 数', stats.sub_one_shot, '（仅统计，不执行清理）')
