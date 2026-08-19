// e2e：构造假的 one-shot 子代理会话 → 跑真实 runOnce → 验证被识别并删除
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { runOnce, scanSessions } from '../lib/index.js'

const DSH_HOME = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`
const TEST_WS = '--e2e-test--'
const TEST_SID = 'e2e-fake-one-shot-0001'
const TEST_DIR = join(DSH_HOME, 'sessions', TEST_WS, TEST_SID)

// 1) 构造测试会话：session 头(subagent) + descriptor(one-shot) + end-seed
const now = Date.now()
const lines = [
  JSON.stringify({ type: 'session', version: 0, id: TEST_SID, createdAt: now, cwd: '/e2e', origin: 'subagent', delegationDepth: 1, agentPreset: 'default' }),
  JSON.stringify({ type: 'subagent/descriptor', seq: 0, time: now, data: { version: 2, mode: 'one-shot', provider: 'spawn', label: 'e2e fake' } }),
  JSON.stringify({ type: 'session/end-seed', seq: 1, time: now, data: {} }),
]
await mkdir(TEST_DIR, { recursive: true })
// zstd 压缩（单帧即可，zstd 命令可解）
execFileSync('zstd', ['-q', '-f'], { input: lines.join('\n') + '\n', stdio: ['pipe', 'pipe', 'inherit'] })
const { writeFile: wf } = await import('node:fs/promises')
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
  process.exit(1)
}

// 3) 跑真实 runOnce（mock storageDomain：缓存清理不可用也不阻塞删除）
const mockCtx = { storageDomain: { get: () => undefined } }
await runOnce(mockCtx)

// 4) 验证已删除
const exists = await import('node:fs/promises').then((m) => m.access(TEST_DIR).then(() => true).catch(() => false))
if (exists) {
  console.error('❌ 删除失败：目录仍在')
  process.exit(1)
}
console.log('✅ one-shot 会话已按策略删除')

// 5) 清理测试工作区空目录
await rm(join(DSH_HOME, 'sessions', TEST_WS), { recursive: true, force: true })
console.log('✅ e2e 通过')
