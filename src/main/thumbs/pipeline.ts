/**
 * 缩略图管线
 *
 * 核心策略：**能用系统的就用系统**
 *
 * 1. 光栅图（jpg/png/webp/gif/avif/tiff/heic）→ sharp，快且质量可控
 * 2. 其它所有格式（psd/ai/pdf/视频/字体/3D…）→ macOS QuickLook（qlmanage）
 *
 * 第二条是关键。Eagle 为 130+ 格式各自接了一堆库（libheif、pdf.js、dcraw…），
 * 而 macOS 的 QuickLook 本身就支持 PSD、AI、PDF、视频、字体、Sketch、Keynote…
 * 直接借系统的能力，格式覆盖瞬间拉满，还不用背这些库的体积。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import type { ThumbSize } from '../../shared/types.js'

const execFileAsync = promisify(execFile)

/** 三档尺寸。md 用于网格，lg 用于大图预览，sm 用于列表。 */
export const SIZES: Record<ThumbSize, number> = {
  sm: 256,
  md: 512,
  lg: 1280,
}

/** sharp 能直接处理的格式，其余走 QuickLook */
const SHARP_EXTS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'gif', 'avif',
  'tif', 'tiff', 'heic', 'heif', 'svg', 'bmp', 'ico', 'jxl',
])

export interface ThumbResult {
  ok: boolean
  /** 生成方式，便于排查 */
  via: 'sharp' | 'quicklook' | 'cache' | 'failed'
  reason?: string
}

/**
 * 并发生成缩略图。
 *
 * 为什么限并发：sharp 内部已经用 libvips 的多线程，
 * 再叠上几十个任务会把 CPU 打满，UI 直接卡死。
 * 4 个并发在 M 系列芯片上能跑满又留出余量。
 */
export class ThumbQueue {
  private running = 0
  private waiting: (() => void)[] = []
  private readonly concurrency: number

  constructor(concurrency = 4) {
    this.concurrency = concurrency
  }

  private async acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
  }

  private release(): void {
    this.running--
    const next = this.waiting.shift()
    if (next) next()
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

export const thumbQueue = new ThumbQueue(4)

/**
 * 为一个条目生成指定尺寸的缩略图。
 * 已存在则直接返回（缓存命中）。
 */
export async function ensureThumb(
  thumbsDir: string,
  itemId: string,
  filePath: string,
  ext: string,
  size: ThumbSize,
): Promise<ThumbResult> {
  const dir = path.join(thumbsDir, size)
  const out = path.join(dir, `${itemId}.webp`)

  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    return { ok: true, via: 'cache' }
  }

  if (!fs.existsSync(filePath)) {
    return { ok: false, via: 'failed', reason: '原文件不存在' }
  }

  fs.mkdirSync(dir, { recursive: true })
  const px = SIZES[size]
  const lower = ext.toLowerCase()

  // 先试 sharp
  if (SHARP_EXTS.has(lower)) {
    try {
      await sharp(filePath, { failOn: 'none', animated: false })
        .rotate() // 按 EXIF 方向摆正
        .resize(px, px, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toFile(out)
      if (fs.existsSync(out) && fs.statSync(out).size > 0) {
        return { ok: true, via: 'sharp' }
      }
    } catch {
      // sharp 失败就落到 QuickLook，不直接放弃
    }
  }

  // 兜底：系统 QuickLook
  const ql = await quickLook(filePath, px, out)
  if (ql) return { ok: true, via: 'quicklook' }

  return { ok: false, via: 'failed', reason: 'sharp 与 QuickLook 均失败' }
}

/**
 * 用 macOS QuickLook 生成缩略图。
 *
 * qlmanage -t -s <px> -o <outdir> <file>
 * 输出文件名是 <basename>.png，所以要先输出到临时目录再转 webp。
 */
async function quickLook(filePath: string, px: number, out: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aerie-ql-'))
  try {
    await execFileAsync(
      'qlmanage',
      ['-t', '-s', String(px), '-o', tmp, filePath],
      { timeout: 20_000 },
    )

    const produced = fs.readdirSync(tmp).filter((f) => f.toLowerCase().endsWith('.png'))
    if (produced.length === 0) return false

    const src = path.join(tmp, produced[0])
    if (fs.statSync(src).size === 0) return false

    await sharp(src)
      .resize(px, px, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toFile(out)

    return fs.existsSync(out) && fs.statSync(out).size > 0
  } catch {
    return false
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** 读取图片的宽高。失败返回 null（不阻塞导入）。 */
export async function probeDimensions(
  filePath: string,
  ext: string,
): Promise<{ width: number | null; height: number | null }> {
  if (!SHARP_EXTS.has(ext.toLowerCase())) return { width: null, height: null }
  try {
    const meta = await sharp(filePath, { failOn: 'none' }).metadata()
    return { width: meta.width ?? null, height: meta.height ?? null }
  } catch {
    return { width: null, height: null }
  }
}
