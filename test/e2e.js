// e2e：构造假的 one-shot 子代理会话 → 跑真实 runOnce → 验证被识别并删除
// 关键：DSH_HOME 指向临时目录（import 前设置），全程隔离，绝不碰真实会话库。
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpHome = await mkdtemp(join(tmpdir(), 'dsh-pruner-e2e-'))
// 必须在动态 import 之前设置：lib/index.js 在模块加载时读取 DSH_HOME。
// oneShotMinAgeMinutes=0 关闭 3 分钟宽限：测试会话刚创建（mtime 最新），
// 否则会因「完成不足 3 分钟」被跳过，断言永远失败。
process.env.DSH_HOME = tmpHome
process.env.DSH_SESSION_PRUNER_ONE_SHOT_MIN_AGE_MINUTES = '0'

const { runOnce, scanSessions, enqueueCandidate, __setActiveCtxForTest } = await import('../lib/index.js')

const TEST_WS = '--e2e-test--'
const TEST_SID = 'e2e-fake-one-shot-0001'
const TEST_DIR = join(tmpHome, 'sessions', TEST_WS, TEST_SID)

// 1) 构造测试会话：session 头(subagent) + descriptor(one-shot) + end-seed
const now = Date.now()
const lines = [
  JSON.stringify({ type: 'session', version: 0, id: TEST_SID, createdAt: now, cwd: '/e2e', origin: 'subagent', delegationDepth: 1, agentPreset: 'default' }),
  JSON.stringify({ type: 'subagent/descriptor', seq: 0, time: now, data: { version: 2, mode: 'one-shot', provider: 'spawn', label: 'e2e fake' } }),
  JSON.stringify({ type: 'session/end-seed', seq: 1, time: now, data: {} }),
]
await mkdir(TEST_DIR, { recursive: true })
// 用 shell 方式压缩：写明文 → zstd 压 → 删明文
const plainPath = join(TEST_DIR, 'plain.jsonl')
await writeFile(plainPath, lines.join('\n') + '\n')
execFileSync('zstd', ['-q', '-f', plainPath, '-o', join(TEST_DIR, 'session.jsonl.zstd')])
await rm(plainPath)

console.log('构造测试会话:', TEST_SID)

// 2) 扫描确认识别
const scanned = await scanSessions()
const hit = scanned.find((s) => s.sid === TEST_SID)
console.log('识别结果:', hit ? `${hit.origin}/${hit.mode} ended=${hit.ended}` : '未找到!')
if (!hit || hit.origin !== 'subagent' || hit.mode !== 'one-shot' || !hit.ended) {
  console.error('❌ 识别失败')
  await rm(tmpHome, { recursive: true, force: true })
  process.exit(1)
}

// 3) 跑真实 runOnce（mock storageDomain：缓存清理不可用也不阻塞删除）
const mockCtx = { storageDomain: { get: () => undefined } }
await runOnce(mockCtx)

// 4) 验证已删除
const exists = await import('node:fs/promises').then((m) => m.access(TEST_DIR).then(() => true).catch(() => false))
if (exists) {
  console.error('❌ 删除失败：目录仍在')
  await rm(tmpHome, { recursive: true, force: true })
  process.exit(1)
}
console.log('✅ one-shot 会话已按策略删除')

// 6) 事件驱动即时归档路径（Step 1）：subagent/end 事件 → 秒级归档（不等扫描）
const TEST_SID2 = 'e2e-fake-event-0002'
const TEST_DIR2 = join(tmpHome, 'sessions', TEST_WS, TEST_SID2)
await mkdir(TEST_DIR2, { recursive: true })
const plainPath2 = join(TEST_DIR2, 'plain.jsonl')
await writeFile(plainPath2, lines.map((l) => l.replace(TEST_SID, TEST_SID2)).join('\n') + '\n')
execFileSync('zstd', ['-q', '-f', plainPath2, '-o', join(TEST_DIR2, 'session.jsonl.zstd')])
await rm(plainPath2)

__setActiveCtxForTest(mockCtx)
enqueueCandidate(TEST_SID2) // 模拟 subagent/end 事件到达
// 宽限 0（环境变量已设）→ 500ms 批窗口后自动 flush 并归档
await new Promise((r) => setTimeout(r, 1500))
const exists2 = await import('node:fs/promises').then((m) => m.access(TEST_DIR2).then(() => true).catch(() => false))
if (exists2) {
  console.error('❌ 事件驱动归档失败：目录仍在（未走秒级路径）')
  await rm(tmpHome, { recursive: true, force: true })
  process.exit(1)
}
console.log('✅ 事件驱动路径：one-shot 完成事件 → 秒级归档（未等定时扫描）')

// 7) 清理临时 DSH_HOME
await rm(tmpHome, { recursive: true, force: true })
console.log('✅ e2e 通过')
