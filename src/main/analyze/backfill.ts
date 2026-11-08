/**
 * 打开库之后，给还没有指纹或拍摄时间的旧图补算。
 *
 * 导入新文件时就会算，这里补的是升级前已经在库里的图。
 * 关掉库时作废这一轮，避免往已经 close 的连接上写。
 * 一张光栅图只走一次 describeRaster，不再分别开文件算指纹和日期。
 */
import type { DB } from '../db/index.js'
import { describeRaster, isRasterExt, RASTER_EXTS } from './raster.js'

let generation = 0

export function stopBackfill(): void {
  generation++
}

export function startBackfill(db: DB): void {
  const token = ++generation
  const alive = (): boolean => token === generation

  void (async () => {
    const pending = db
      .prepare(
        `SELECT id, file_path AS filePath, ext,
                phash IS NULL AS needHash,
                taken_at IS NULL AS needTaken
         FROM items
         WHERE deleted_at IS NULL
           AND (
             taken_at IS NULL
             OR (phash IS NULL AND lower(ext) IN (${RASTER_EXTS.map((ext) => `'${ext}'`).join(',')}))
           )`,
      )
      .all() as {
      id: string
      filePath: string
      ext: string
      needHash: number
      needTaken: number
    }[]

    const writeHash = db.prepare(
      `UPDATE items SET phash = ?, palette = ?, hue = ? WHERE id = ? AND phash IS NULL`,
    )
    const writeTaken = db.prepare(
      `UPDATE items SET taken_at = ? WHERE id = ? AND taken_at IS NULL`,
    )

    let cursor = 0
    const worker = async (): Promise<void> => {
      while (alive()) {
        const row = pending[cursor++]
        if (!row) return
        if (!isRasterExt(row.ext)) {
          // 非光栅图没有指纹。拍摄时间写 0，下次就不再扫到它。
          if (row.needTaken) {
            try {
              writeTaken.run(0, row.id)
            } catch {
              return
            }
          }
          continue
        }
        const facts = await describeRaster(row.filePath)
        if (!alive() || !facts) continue
        try {
          if (row.needHash && facts.fingerprint) {
            writeHash.run(
              facts.fingerprint.phash,
              facts.fingerprint.palette,
              facts.fingerprint.hue,
              row.id,
            )
          }
          if (row.needTaken) writeTaken.run(facts.takenAt ?? 0, row.id)
        } catch {
          return
        }
      }
    }

    await Promise.all([worker(), worker()])
  })().catch(() => undefined)
}
