/**
 * 缩略图服务：把「数据库 → 管线 → 缓存」串起来
 *
 * 为什么需要这一层
 * ────────────────────────────────────────────────────────────
 * 缩略图原本只在导入时生成。但一旦引入 LRU 淘汰，被淘汰的缩略图
 * 就必须能按需重建——否则「淘汰」等于「永久损坏」，用户滚回去
 * 只会看到一片空白。
 *
 * 所以协议处理器在缓存未命中时要能反向查到原文件并重新生成。
 * 这一层负责：查库、去重并发、调管线、记账。
 */
import fsp from 'node:fs/promises'
import type { DB } from '../db/index.js'
import type { ThumbSize } from '../../shared/types.js'
import { ensureThumb, thumbQueue } from './pipeline.js'
import { getThumbCache } from './cache.js'

/**
 * 正在生成中的任务。
 *
 * 同一张图可能同时被多个 <img> 请求（网格里同一个 item 只出现一次，
 * 但快速滚动时骨架屏和真实卡片会各请求一次）。没有这张表就会
 * 对同一个文件并发跑两遍 sharp，白白浪费 CPU 还可能写出半个文件。
 */
const inflight = new Map<string, Promise<boolean>>()

/**
 * 失败记录，带 TTL。
 *
 * 没有它的话，一张坏图（文件损坏、格式不支持）会在每次滚动经过时
 * 都重跑一遍 sharp + QuickLook，白白吃掉几百毫秒 CPU。
 * TTL 让用户修好文件后仍然能重试。
 */
const failures = new Map<string, number>()
const FAILURE_TTL_MS = 5 * 60 * 1000

function recentlyFailed(key: string): boolean {
  const at = failures.get(key)
  if (at === undefined) return false
  if (Date.now() - at > FAILURE_TTL_MS) {
    failures.delete(key)
    return false
  }
  return true
}

/**
 * 确保某个条目的缩略图存在，返回文件路径；失败返回 null。
 *
 * 不抛异常：这是给协议处理器用的，任何失败都应该退化成 404，
 * 而不是把渲染进程的请求搞崩。
 */
export async function ensureThumbForItem(
  db: DB,
  thumbsDir: string,
  itemId: string,
  size: ThumbSize,
): Promise<string | null> {
  const file = `${thumbsDir}/${size}/${itemId}.webp`

  // 命中缓存：一次异步 stat 即可（协议层不再先 existsSync）
  try {
    const st = await fsp.stat(file)
    if (st.size > 0) return file
  } catch {
    // 落到下面重建
  }

  const key = `${size}:${itemId}`
  if (recentlyFailed(key)) return null

  const existing = inflight.get(key)
  if (existing) {
    const ok = await existing
    return ok ? file : null
  }

  const task = (async (): Promise<boolean> => {
    const row = db
      .prepare('SELECT file_path, ext FROM items WHERE id = ?')
      .get(itemId) as { file_path: string; ext: string } | undefined
    if (!row) return false

    // 走队列限并发，避免一次滚动打满 CPU
    const result = await thumbQueue.run(() =>
      ensureThumb(thumbsDir, itemId, row.file_path, row.ext, size),
    )

    if (!result.ok) {
      failures.set(key, Date.now())
      return false
    }

    if (result.ok) {
      // 生成成功就记一次访问时间，刚用过的排在 LRU 最新端
      getThumbCache()?.touch(file)
      // 生成后检查预算：批量补图很容易一次性超出
      void getThumbCache()?.sweep().catch(() => undefined)
    }
    return result.ok
  })()

  inflight.set(key, task)
  try {
    const ok = await task
    return ok ? file : null
  } finally {
    inflight.delete(key)
  }
}
