/**
 * 缩略图缓存：容量上限 + LRU 淘汰
 *
 * 为什么必须有这个
 * ────────────────────────────────────────────────────────────
 * 缩略图是本项目真正的磁盘消耗方，不是数据库：
 *
 *   md 档（512px）约 18 KB/张 → 100 万条 ≈ 17 GB
 *   三档全生成（256+512+1280）≈ 41 GB
 *
 * Eagle 官方 FAQ 承认超过 100 万文件会 OOM，磁盘也是同一个道理。
 * 不设上限的话，库越大越接近把用户的盘写满，而且没有任何回收机制。
 *
 * 策略
 * ────────────────────────────────────────────────────────────
 * 1. 容量预算（默认 2 GB，可按库配置）
 * 2. 超过预算就按「最后访问时间」从旧到新删，删到 80% 为止（滞回，
 *    避免每生成一张就触发一次淘汰）
 * 3. 同等新旧时优先删大的：一次能腾出更多空间，删除次数更少
 *
 * 为什么用文件 atime 而不是自己记一张表
 * ────────────────────────────────────────────────────────────
 * atime 天然跨进程、跨重启持久，不需要额外维护一份可能损坏的索引。
 * 但 macOS 上 atime 未必随读取更新（取决于挂载参数），所以访问时显式
 * utimes 一次。为了不把 I/O 打满，同一文件一小时内只 touch 一次。
 *
 * 被淘汰的缩略图不是数据丢失——原图还在，下次滚动到那里会重新生成。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ThumbSize } from '../../shared/types.js'

const ALL_SIZES: ThumbSize[] = ['sm', 'md', 'lg']

/** 默认预算 2 GB。可用环境变量覆盖（主要给测试用）。 */
const DEFAULT_BUDGET = (() => {
  const mb = Number(process.env.AERIE_THUMB_BUDGET_MB)
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024)
  return 2 * 1024 * 1024 * 1024
})()

/** 删到预算的这个比例就停手，留出滞回空间 */
const TARGET_RATIO = 0.8

/** 同一文件两次 touch 的最小间隔 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000

/** 两次全量扫描的最小间隔（全量扫描要 stat 每个文件，不能太频繁） */
const MIN_SWEEP_INTERVAL_MS = 10 * 60 * 1000

/** 内存中记录「最近 touch 过」的文件，避免频繁 stat */
const MAX_TOUCH_ENTRIES = 50_000

export interface SizeStat {
  bytes: number
  count: number
}

export interface ThumbStats {
  totalBytes: number
  fileCount: number
  budgetBytes: number
  /** 是否已超出预算 */
  overBudget: boolean
  bySize: Record<ThumbSize, SizeStat>
}

export interface SweepResult {
  /** 是否真的执行了扫描（可能因为节流或已在运行而跳过） */
  ran: boolean
  skippedReason?: 'busy' | 'throttled' | 'under-budget'
  beforeBytes: number
  afterBytes: number
  deletedFiles: number
  freedBytes: number
  elapsedMs: number
}

/**
 * 一个库对应一个实例。
 *
 * 生命周期与打开的库绑定：切换库时新建，关闭时丢弃。
 * 不放在模块级单例里，否则同时打开两个库会互相干扰。
 */
export class ThumbCache {
  private readonly root: string
  private readonly budgetBytes: number
  /** 文件路径 → 上次 touch 的时间戳 */
  private readonly touched = new Map<string, number>()
  private sweeping = false
  private lastSweepAt = 0

  constructor(thumbsDir: string, budgetBytes: number = DEFAULT_BUDGET) {
    this.root = thumbsDir
    this.budgetBytes = budgetBytes
  }

  get budget(): number {
    return this.budgetBytes
  }

  /**
   * 记录一次访问，用于 LRU 排序。
   *
   * 同步执行且吞掉所有异常：这是在协议处理的热路径上，
   * 缓存目录不可写也不能让缩略图加载失败。
   */
  touch(file: string): void {
    const now = Date.now()
    const last = this.touched.get(file)
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return

    this.touched.set(file, now)
    // 防止长期运行后无限增长
    if (this.touched.size > MAX_TOUCH_ENTRIES) this.touched.clear()

    try {
      const st = fs.statSync(file)
      // 只更新 atime，保留 mtime
      fs.utimesSync(file, new Date(now), st.mtime)
    } catch {
      // 文件可能刚被淘汰掉了，忽略
    }
  }

  /** 删除某个条目的全部缩略图（条目被删除时调用） */
  async removeItem(itemId: string): Promise<void> {
    await Promise.all(
      ALL_SIZES.map(async (size) => {
        const f = path.join(this.root, size, `${itemId}.webp`)
        try {
          await fsp.unlink(f)
        } catch {
          // 不存在就算了
        }
        this.touched.delete(f)
      }),
    )
  }

  /** 统计当前占用。会 stat 所有文件，大库上可能耗时几百毫秒。 */
  async stats(): Promise<ThumbStats> {
    const bySize = {} as Record<ThumbSize, SizeStat>
    for (const s of ALL_SIZES) bySize[s] = { bytes: 0, count: 0 }

    let totalBytes = 0
    let fileCount = 0

    for (const size of ALL_SIZES) {
      const dir = path.join(this.root, size)
      let names: string[]
      try {
        names = await fsp.readdir(dir)
      } catch {
        continue // 目录还不存在
      }
      for (const name of names) {
        if (!name.endsWith('.webp')) continue
        try {
          const st = await fsp.stat(path.join(dir, name))
          if (!st.isFile()) continue
          bySize[size].bytes += st.size
          bySize[size].count++
          totalBytes += st.size
          fileCount++
        } catch {
          // 扫描期间被删了
        }
      }
    }

    return {
      totalBytes,
      fileCount,
      budgetBytes: this.budgetBytes,
      overBudget: totalBytes > this.budgetBytes,
      bySize,
    }
  }

  /**
   * 按 LRU 淘汰，直到降到预算的 80%。
   *
   * force=false 时有节流：距离上次扫描不足 10 分钟就直接跳过。
   */
  async sweep(force = false): Promise<SweepResult> {
    const started = Date.now()

    if (this.sweeping) {
      return {
        ran: false,
        skippedReason: 'busy',
        beforeBytes: 0,
        afterBytes: 0,
        deletedFiles: 0,
        freedBytes: 0,
        elapsedMs: 0,
      }
    }
    if (!force && started - this.lastSweepAt < MIN_SWEEP_INTERVAL_MS) {
      return {
        ran: false,
        skippedReason: 'throttled',
        beforeBytes: 0,
        afterBytes: 0,
        deletedFiles: 0,
        freedBytes: 0,
        elapsedMs: 0,
      }
    }

    this.sweeping = true
    try {
      const entries = await this.collect()
      const beforeBytes = entries.reduce((n, e) => n + e.size, 0)

      if (beforeBytes <= this.budgetBytes) {
        this.lastSweepAt = started
        return {
          ran: true,
          skippedReason: 'under-budget',
          beforeBytes,
          afterBytes: beforeBytes,
          deletedFiles: 0,
          freedBytes: 0,
          elapsedMs: Date.now() - started,
        }
      }

      // 从旧到新删；同样新旧时先删大的，一次腾更多空间
      entries.sort((a, b) => (a.atime === b.atime ? b.size - a.size : a.atime - b.atime))

      const target = Math.floor(this.budgetBytes * TARGET_RATIO)
      let current = beforeBytes
      let deletedFiles = 0
      let freedBytes = 0

      for (const e of entries) {
        if (current <= target) break
        try {
          await fsp.unlink(e.file)
          current -= e.size
          freedBytes += e.size
          deletedFiles++
          this.touched.delete(e.file)
        } catch {
          // 删不掉就跳过，别让整个 sweep 中断
        }
      }

      this.lastSweepAt = started
      return {
        ran: true,
        beforeBytes,
        afterBytes: current,
        deletedFiles,
        freedBytes,
        elapsedMs: Date.now() - started,
      }
    } finally {
      this.sweeping = false
    }
  }

  /** 收集所有缩略图的大小与访问时间 */
  private async collect(): Promise<
    { file: string; size: number; atime: number; size_rank: number }[]
  > {
    const out: { file: string; size: number; atime: number; size_rank: number }[] = []

    for (let rank = 0; rank < ALL_SIZES.length; rank++) {
      const size = ALL_SIZES[rank]
      const dir = path.join(this.root, size)
      let names: string[]
      try {
        names = await fsp.readdir(dir)
      } catch {
        continue
      }

      // 分批 stat，避免一次性堆出十万个 promise
      const BATCH = 256
      for (let i = 0; i < names.length; i += BATCH) {
        const slice = names.slice(i, i + BATCH)
        const stats = await Promise.all(
          slice.map(async (name) => {
            if (!name.endsWith('.webp')) return null
            const file = path.join(dir, name)
            try {
              const st = await fsp.stat(file)
              if (!st.isFile()) return null
              return { file, size: st.size, atime: st.atimeMs, size_rank: rank }
            } catch {
              return null
            }
          }),
        )
        for (const s of stats) if (s) out.push(s)
      }
    }

    return out
  }
}

/** 当前打开的库对应的缓存实例 */
let current: ThumbCache | null = null

export function setThumbCache(cache: ThumbCache | null): void {
  current = cache
}

export function getThumbCache(): ThumbCache | null {
  return current
}
