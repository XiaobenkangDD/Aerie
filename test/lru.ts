/**
 * 缩略图 LRU 缓存测试
 *
 * 覆盖：预算内不动、超预算淘汰到 80%、按 atime 从旧到新、
 * 同样新旧时先删大的、条目删除时清理三档、touch 更新 atime。
 *
 * 跑法：npm run test:lru
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ThumbCache } from '../src/main/thumbs/cache.js'

let passed = 0
let failed = 0

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, actual === expected, `实际=${String(actual)} 期望=${String(expected)}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aerie-lru-'))
const SIZES = ['sm', 'md', 'lg'] as const

function reset(): void {
  for (const s of SIZES) {
    fs.rmSync(path.join(root, s), { recursive: true, force: true })
    fs.mkdirSync(path.join(root, s), { recursive: true })
  }
}

/** 造一个指定大小、指定 atime 的假缩略图 */
function makeFile(size: 'sm' | 'md' | 'lg', name: string, bytes: number, atimeMs: number): string {
  const f = path.join(root, size, `${name}.webp`)
  fs.writeFileSync(f, Buffer.alloc(bytes, 1))
  const t = new Date(atimeMs)
  fs.utimesSync(f, t, t)
  return f
}

function exists(size: 'sm' | 'md' | 'lg', name: string): boolean {
  return fs.existsSync(path.join(root, size, `${name}.webp`))
}

async function main(): Promise<void> {
  const now = Date.now()
  const HOUR = 3600_000

  // ── 1. 预算内：不删任何东西 ──
  console.log('\n[1] 预算内不淘汰')
  reset()
  for (let i = 0; i < 5; i++) makeFile('md', `a${i}`, 1000, now - i * HOUR)
  {
    const cache = new ThumbCache(root, 10_000)
    const r = await cache.sweep(true)
    eq('ran', r.ran, true)
    eq('skippedReason', r.skippedReason, 'under-budget')
    eq('删除数', r.deletedFiles, 0)
    eq('总字节', r.afterBytes, 5000)
    ok('文件都还在', [0, 1, 2, 3, 4].every((i) => exists('md', `a${i}`)))
  }

  // ── 2. 超预算：淘汰到 80% ──
  console.log('\n[2] 超预算淘汰到 80%')
  reset()
  // 10 个 × 1000 = 10000，预算 6000 → 目标 4800 → 至少要删到剩 4 个
  for (let i = 0; i < 10; i++) makeFile('md', `b${i}`, 1000, now - i * HOUR)
  {
    const cache = new ThumbCache(root, 6000)
    const r = await cache.sweep(true)
    eq('删除数', r.deletedFiles, 6)
    eq('淘汰后字节', r.afterBytes, 4000)
    eq('释放字节', r.freedBytes, 6000)
    ok('剩 4 个', [0, 1, 2, 3].every((i) => exists('md', `b${i}`)))
    ok(
      '旧的被删（b9/b8/b7…）',
      [6, 7, 8, 9].every((i) => !exists('md', `b${i}`)),
    )
  }

  // ── 3. 严格按 atime 从旧到新 ──
  console.log('\n[3] 按 atime 从旧到新淘汰')
  reset()
  // 故意乱序创建：atime 越早 = 越久没访问 = 越该删
  makeFile('md', 'newest', 1000, now)
  makeFile('md', 'oldest', 1000, now - 100 * HOUR)
  makeFile('md', 'middle', 1000, now - 50 * HOUR)
  {
    const cache = new ThumbCache(root, 2000) // 目标 1600 → 删 2 个
    const r = await cache.sweep(true)
    eq('删除数', r.deletedFiles, 2)
    ok('最旧的被删', !exists('md', 'oldest'))
    ok('次旧的被删', !exists('md', 'middle'))
    ok('最新的保留', exists('md', 'newest'))
  }

  // ── 4. 同样新旧时先删大的 ──
  console.log('\n[4] 同 atime 时先删大的')
  reset()
  const same = now - 10 * HOUR
  makeFile('md', 'small', 500, same)
  makeFile('md', 'huge', 5000, same)
  makeFile('md', 'tiny', 500, same)
  {
    // 总共 6000，预算 5000 → 目标 4000，必须删 1 个
    const cache = new ThumbCache(root, 5000)
    const r = await cache.sweep(true)
    eq('删除数', r.deletedFiles, 1)
    ok('大的被删（一次腾更多空间）', !exists('md', 'huge'))
    ok('小的都保留', exists('md', 'small') && exists('md', 'tiny'))
  }

  // ── 5. removeItem 清掉三档 ──
  console.log('\n[5] 删除条目时清理三档缩略图')
  reset()
  const id = '01a1ba3c-1331-7034-80af-c6ab94b32c00'
  makeFile('sm', id, 100, now)
  makeFile('md', id, 100, now)
  makeFile('lg', id, 100, now)
  makeFile('md', 'other', 100, now)
  {
    const cache = new ThumbCache(root, 1_000_000)
    await cache.removeItem(id)
    ok('sm 已删', !exists('sm', id))
    ok('md 已删', !exists('md', id))
    ok('lg 已删', !exists('lg', id))
    ok('别的条目没受影响', exists('md', 'other'))
  }

  // ── 6. touch 更新 atime ──
  console.log('\n[6] touch 更新访问时间')
  reset()
  const oldFile = makeFile('md', 'touched', 1000, now - 100 * HOUR)
  {
    const cache = new ThumbCache(root, 1_000_000)
    const before = fs.statSync(oldFile).atimeMs
    cache.touch(oldFile)
    const after = fs.statSync(oldFile).atimeMs
    ok('atime 变新了', after > before, `${Math.round((after - before) / 1000)}s`)
    ok('确实接近现在', Math.abs(after - Date.now()) < 5000)
  }

  // ── 7. 节流：短时间内重复 sweep 直接跳过 ──
  console.log('\n[7] sweep 节流')
  reset()
  for (let i = 0; i < 10; i++) makeFile('md', `c${i}`, 1000, now - i * HOUR)
  {
    const cache = new ThumbCache(root, 6000)
    const first = await cache.sweep(true)
    eq('第一次跑了', first.ran, true)
    const second = await cache.sweep() // 不 force
    eq('第二次跳过', second.ran, false)
    eq('跳过原因', second.skippedReason, 'throttled')
  }

  // ── 8. stats 统计正确 ──
  console.log('\n[8] stats 统计')
  reset()
  makeFile('sm', 's1', 100, now)
  makeFile('sm', 's2', 100, now)
  makeFile('md', 'm1', 1000, now)
  makeFile('lg', 'l1', 5000, now)
  {
    const cache = new ThumbCache(root, 10_000)
    const st = await cache.stats()
    eq('总字节', st.totalBytes, 6200)
    eq('文件数', st.fileCount, 4)
    eq('sm 数量', st.bySize.sm.count, 2)
    eq('sm 字节', st.bySize.sm.bytes, 200)
    eq('md 字节', st.bySize.md.bytes, 1000)
    eq('lg 字节', st.bySize.lg.bytes, 5000)
    eq('未超预算', st.overBudget, false)
  }

  // ── 9. 空目录不炸 ──
  console.log('\n[9] 空库不崩')
  reset()
  {
    const cache = new ThumbCache(root, 1000)
    const st = await cache.stats()
    eq('总字节', st.totalBytes, 0)
    const r = await cache.sweep(true)
    eq('ran', r.ran, true)
    eq('删除数', r.deletedFiles, 0)
  }

  // ── 10. 目录不存在也不炸 ──
  console.log('\n[10] 缩略图目录不存在时不崩')
  {
    const cache = new ThumbCache(path.join(root, 'not-exist'), 1000)
    const st = await cache.stats()
    eq('总字节', st.totalBytes, 0)
    const r = await cache.sweep(true)
    eq('ran', r.ran, true)
    eq('删除数', r.deletedFiles, 0)
  }

  fs.rmSync(root, { recursive: true, force: true })

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
