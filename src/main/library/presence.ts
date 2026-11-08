/**
 * 引用模式下原图还在用户自己的目录里，移动或删除之后索引会悬空。
 *
 * missing = 1 表示上次检查时路径已经不存在。接回只改索引里的路径，不搬文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db/index.js'

export interface PresenceScan {
  checked: number
  missing: number
}

const CHUNK = 400

/**
 * 分块检查原文件是否还在。每块之间让出事件循环，大库不会把主进程卡死。
 */
export async function refreshPresence(db: DB): Promise<PresenceScan> {
  const write = db.prepare(`UPDATE items SET missing = ? WHERE id = ?`)
  let checked = 0
  let missing = 0
  let afterId = ''

  for (;;) {
    const rows = db
      .prepare(
        `SELECT id, file_path AS filePath, missing FROM items
         WHERE deleted_at IS NULL AND id > ?
         ORDER BY id
         LIMIT ?`,
      )
      .all(afterId, CHUNK) as { id: string; filePath: string; missing: number }[]
    if (rows.length === 0) break

    const updates: { gone: number; id: string }[] = []
    for (const row of rows) {
      const gone = fs.existsSync(row.filePath) ? 0 : 1
      if (gone) missing++
      if (gone !== row.missing) updates.push({ gone, id: row.id })
      afterId = row.id
      checked++
    }
    if (updates.length > 0) {
      db.transaction((list: { gone: number; id: string }[]) => {
        for (const u of list) write.run(u.gone, u.id)
      })(updates)
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  return { checked, missing }
}

/** 把一条素材的路径改到新文件。尺寸和指纹清掉，等后台重算。 */
export function relinkItem(db: DB, id: string, filePath: string): void {
  const abs = path.resolve(filePath)
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new Error('文件不存在')
  }
  if (!st.isFile()) throw new Error('请选择文件，而不是文件夹')
  const ext = path.extname(abs).slice(1).toLowerCase()
  const name = path.basename(abs, path.extname(abs))
  try {
    const info = db
      .prepare(
        `UPDATE items
         SET file_path = ?, name = ?, ext = ?, file_size = ?, mtime = ?,
             missing = 0, width = NULL, height = NULL, taken_at = NULL,
             phash = NULL, palette = NULL, hue = NULL, has_thumb = 0
         WHERE id = ?`,
      )
      .run(abs, name, ext || 'bin', st.size, Math.floor(st.mtimeMs), id)
    if (info.changes === 0) throw new Error('素材不存在')
  } catch (err) {
    if (err instanceof Error && err.message === '素材不存在') throw err
    if (String(err).includes('UNIQUE')) throw new Error('这个文件已经在库里')
    throw err
  }
}

export interface RelinkFolderResult {
  linked: number
  stillMissing: number
  ids: string[]
}

/**
 * 在文件夹里按「显示名.扩展名」把丢失的原文件接回来。
 * 同名文件出现多次时不猜，留给用户单独定位。
 */
export function relinkFolder(db: DB, dir: string): RelinkFolderResult {
  const root = path.resolve(dir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('请选择文件夹')
  }

  const index = new Map<string, string[]>()
  const walk = (folder: string, depth: number): void => {
    if (depth > 8) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(folder, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.aerie')) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const key = entry.name.toLowerCase()
      const list = index.get(key)
      if (list) list.push(full)
      else index.set(key, [full])
    }
  }
  walk(root, 0)

  const missingRows = db
    .prepare(`SELECT id, name, ext FROM items WHERE deleted_at IS NULL AND missing = 1`)
    .all() as { id: string; name: string; ext: string }[]

  const ids: string[] = []
  for (const item of missingRows) {
    const hits = index.get(`${item.name}.${item.ext}`.toLowerCase()) ?? []
    if (hits.length !== 1) continue
    try {
      relinkItem(db, item.id, hits[0]!)
      ids.push(item.id)
    } catch {
      // 已经在库里，或文件在扫描后又没了
    }
  }

  const still = db
    .prepare(`SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND missing = 1`)
    .get() as { n: number }

  return { linked: ids.length, stillMissing: still.n, ids }
}
