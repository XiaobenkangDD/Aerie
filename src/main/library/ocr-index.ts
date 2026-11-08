/**
 * 把识别出的文字写进条目，并同步独立的 FTS 表。
 *
 * 不往 items_fts 里加列：那张表是 content=items 的外部内容表，
 * 加一列等于把整张 FTS 拆掉重建，老库很容易迁坏。
 * 这里另起一张 items_ocr_fts，搜索时和原来的名字/备注取并集。
 */
import type { DB } from '../db/index.js'

export function setOcrText(db: DB, itemId: string, text: string): void {
  const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, 20_000)
  const info = db.prepare(`UPDATE items SET ocr_text = ? WHERE id = ?`).run(cleaned, itemId)
  if (info.changes === 0) return

  // 先删再插：同一张图重跑识别时不能留着旧词。
  db.prepare(`DELETE FROM items_ocr_fts WHERE item_id = ?`).run(itemId)
  if (!cleaned) return
  db.prepare(`INSERT INTO items_ocr_fts (item_id, ocr_text) VALUES (?, ?)`).run(itemId, cleaned)
}
