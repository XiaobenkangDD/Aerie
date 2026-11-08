/**
 * 用 macOS Vision 识别画面里的文字，导入之后在后台补。
 *
 * 不引入 tesseract 这类引擎：swift 解释执行一段很短的脚本，
 * 调用系统自带的 VNRecognizeTextRequest。失败就停，不挡开库。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DB } from '../db/index.js'
import type { OcrStatus } from '../../shared/types.js'
import { setOcrText } from '../library/ocr-index.js'

/** 只对光栅图跑。svg 是矢量，Vision 也读不出稳定的字。 */
export const OCR_EXTS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'gif', 'avif',
  'tif', 'tiff', 'heic', 'heif', 'bmp', 'ico', 'jxl',
])

const extList = [...OCR_EXTS]
let generation = 0
let currentChild: ChildProcess | null = null
let blockedReason: string | null = null

export function stopOcrBackfill(): void {
  generation++
  currentChild?.kill('SIGKILL')
  currentChild = null
}

export function ocrStatus(db: DB | null): OcrStatus {
  if (process.platform !== 'darwin') {
    return {
      available: false,
      reason: '画面文字识别只用 macOS 自带的 Vision，当前系统会跳过。',
      pending: 0,
    }
  }
  if (blockedReason) {
    return { available: false, reason: blockedReason, pending: 0 }
  }
  return {
    available: true,
    reason: null,
    pending: db ? countPending(db) : 0,
  }
}

function countPending(db: DB): number {
  const keys = extList.map(() => '?').join(', ')
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items
       WHERE ocr_text IS NULL AND deleted_at IS NULL AND ext IN (${keys})`,
    )
    .get(...extList) as { n: number }
  return row.n
}

/**
 * 开发时脚本在源码树里；打包后 electron-builder 把它放到 Resources/ocr.swift。
 * 两处都找，避免只在某一种启动方式下能识别。
 */
export function ocrScriptPath(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resources ? path.join(resources, 'ocr.swift') : '',
    path.resolve(process.cwd(), 'src/main/analyze/ocr.swift'),
    // electron-vite 开发构建的入口在 out/main，源码在上两级
    path.resolve(here, '../../src/main/analyze/ocr.swift'),
  ].filter((file) => file.length > 0)
  return candidates.find((file) => fs.existsSync(file)) ?? null
}

function runSwift(
  script: string,
  imagePath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('swift', [script, imagePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    currentChild = child
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 40_000) stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4_000) stderr += chunk
    })
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (currentChild === child) currentChild = null
      resolve({ code, stdout, stderr: stderr.trim() })
    }
    child.on('error', (err) => {
      stderr = err.message
      finish(err.message.includes('ENOENT') ? 127 : 1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

/**
 * 打开库或导入结束后调用。已经在跑的一轮作废，重新看还有哪些图没识别。
 * 关库时 generation 变了，循环自己停，不会往已关闭的连接上写。
 */
function isEnvironmentFailure(code: number, stderr: string): boolean {
  if (code === 127) return true
  // swift 解释器或脚本本身坏了。单张图读失败走的是退出码 2，不进这里。
  return /command not found|no such module|unable to locate swift/i.test(stderr)
    || /:\d+:\d+: error:/.test(stderr)
}

export function startOcrBackfill(db: DB): void {
  if (process.platform !== 'darwin') return
  // 重开一轮就再试一次。用户装好命令行工具后，重开库即可，不用重启应用。
  blockedReason = null
  const token = ++generation
  const alive = (): boolean => token === generation

  void (async () => {
    const script = ocrScriptPath()
    if (!script) {
      blockedReason = '找不到 OCR 脚本，已跳过画面文字识别。'
      return
    }

    const keys = extList.map(() => '?').join(', ')
    const pick = db.prepare(
      `SELECT id, file_path AS filePath FROM items
       WHERE ocr_text IS NULL AND deleted_at IS NULL AND ext IN (${keys})
       ORDER BY added_at DESC
       LIMIT 40`,
    )

    let visionFails = 0
    for (;;) {
      if (!alive()) return
      let batch: { id: string; filePath: string }[]
      try {
        batch = pick.all(...extList) as { id: string; filePath: string }[]
      } catch {
        return
      }
      if (batch.length === 0) return

      for (const row of batch) {
        if (!alive()) return
        if (!fs.existsSync(row.filePath)) {
          try {
            setOcrText(db, row.id, '')
          } catch {
            return
          }
          continue
        }

        const result = await runSwift(script, row.filePath)
        if (!alive()) return

        if (isEnvironmentFailure(result.code, result.stderr)) {
          const detail = result.stderr.replace(/\s+/g, ' ').slice(0, 160)
          blockedReason = detail
            ? `画面文字识别不可用：${detail}`
            : '没有找到 swift，画面文字识别已跳过。装好 Xcode 命令行工具后重开库即可。'
          return
        }

        try {
          // 非 0 是这张图读不了或 Vision 拒了这一张。记空串，避免每次开库都重试。
          setOcrText(db, row.id, result.code === 0 ? result.stdout : '')
        } catch {
          return
        }

        if (result.code === 1) {
          visionFails++
          // 连续多张都是 Vision 报错，多半是系统能力不可用，停下来告诉用户
          if (visionFails >= 3) {
            const detail = result.stderr.replace(/\s+/g, ' ').slice(0, 160)
            blockedReason = detail
              ? `画面文字识别不可用：${detail}`
              : '画面文字识别连续失败，已跳过。'
            return
          }
        } else {
          visionFails = 0
        }

        // 每张之间让出主进程，缩略图 IPC 还能插进来
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  })().catch(() => undefined)
}
