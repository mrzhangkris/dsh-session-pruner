// PoC：验证审查发现的三个 bug 候选（只读逻辑，不碰真实会话库）
import { decodeSession } from '../lib/index.js'

let fail = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' → ' + detail : ''}`)
  if (!cond) fail++
}

// ---- PoC 1：用户消息文本包含 "session/end-seed" 字样 → ended 误判 ----
// 场景：用户在 DSH 里让 agent 开发/讨论 dsh-session-pruner 本身，
// 消息内容（type:message 行）里出现 "session/end-seed" 字符串。
const poc1 = [
  JSON.stringify({ type: 'session', id: 's-main-1', origin: 'main' }),
  JSON.stringify({ type: 'message/user', data: { text: '帮我看看 session/end-seed 的解析逻辑有没有 bug' } }),
].join('\n')
const r1 = decodeSession(poc1)
check('PoC1 内容文本含 session/end-seed 被误判 ended',
  r1.ended === false,
  r1.ended === false ? 'ended=false（安全）' : `ended=true（运行中保护被内容绕过！）`)

// 对照：真 end-seed 事件行
const poc1b = [
  JSON.stringify({ type: 'session', id: 's-main-2', origin: 'main' }),
  JSON.stringify({ type: 'session/end-seed', data: {} }),
].join('\n')
check('PoC1b 真实 end-seed 事件行判 ended=true',
  decodeSession(poc1b).ended === true)

// ---- PoC 2：dry-run 与 lib 的 decodeSession 漂移（扁鹊🟠a 修复未同步）----
// dry-run.js 现在直接 import lib 的 decodeSession/decompressLog（测试钩子导出），
// 双源消除后永不漂移。静态断言 dry-run 源码不再内嵌本地副本：
const drySrc = await (await import('node:fs/promises')).readFile(
  new URL('./dry-run.js', import.meta.url), 'utf8')
const reusesLib = /from '\.\.\/lib\/index\.js'/.test(drySrc)
  && /function decodeSession/.test(drySrc) === false
check('PoC2 dry-run 复用 lib 的 decodeSession（无双源）',
  reusesLib,
  reusesLib ? 'dry-run import lib 实现，统计即生产行为' : 'dry-run 仍内嵌本地副本，存在漂移风险')

// ---- PoC 3：archiveMode 切 archive→delete 后，已归档会话永不物理删除 ----
// lib/index.js pruneArchive: `if (runtime.archiveMode !== 'archive') return`
// 逻辑级验证：读源码即可确认，无需运行时。这里验证 runOnce 在 delete 模式下
// 是否跳过 pruneArchive——通过导出的 pruneArchive + 临时 runtime 检查不可行
// （runtime 未导出），改为静态断言：检查源码文本。
const src = await (await import('node:fs/promises')).readFile(
  new URL('../lib/index.js', import.meta.url), 'utf8')
const hasEarlyReturn = /function pruneArchive[\s\S]{0,120}archiveMode !== 'archive'/.test(src)
check('PoC3 pruneArchive 在 delete 模式下提前 return（旧归档残留）',
  !hasEarlyReturn,
  hasEarlyReturn ? '确认：delete 模式跳过 pruneArchive，切换前归档的会话永不被清理' : '未发现')

// ---- PoC 4：live 检查 fail-closed（审计🔴b：sessions 服务重载窗口 fail-open）----
// cordis registry.get strict 模式在 provider fiber 非 active 时返回 undefined 不抛——
// 旧版 `!!ctx.get?.('sessions')?.get?.(sid)` 在该窗口判定非 live（可清理），
// delete 模式下最坏批量 rm。isLive 必须把「服务缺失」视为 live。
const { isLive } = await import('../lib/index.js')
const inStore = isLive({ get: (n) => (n === 'sessions' ? { get: (id) => (id === 'live-1' ? { id } : undefined) } : undefined) }, 'live-1')
const notInStore = isLive({ get: (n) => (n === 'sessions' ? { get: () => undefined } : undefined) }, 'gone-1')
const svcReload = isLive({ get: () => undefined }, 'any-1') // 服务重载窗口：get('sessions')=undefined
const noGet = isLive({}, 'any-1') // ctx 无 get（最保守场景）
const throws = isLive({ get: () => { throw new Error('inject missing') } }, 'any-1')
check('PoC4a 会话在 store → live', inStore === true)
check('PoC4b 会话不在 store → 非 live（可清理）', notInStore === false)
check('PoC4c sessions 服务重载窗口（get 返回 undefined）→ 视为 live（fail-closed）',
  svcReload === true, svcReload === true ? '重载窗口不清理，等下轮扫描兜底' : 'fail-open：重载窗口可批量清理（delete 模式不可恢复）！')
check('PoC4d ctx 无 get → 视为 live（fail-closed）', noGet === true)
check('PoC4e 查询抛异常 → 视为 live（fail-closed）', throws === true)

console.log(fail === 0 ? '\n全部候选被否定' : `\n${fail} 个候选确认为真`)
process.exit(fail === 0 ? 0 : 1)
