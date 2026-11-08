/**
 * 写操作
 *
 * 全部同步执行（better-sqlite3 的特性），调用方不需要 await。
 * 每个批量操作包在事务里，避免部分成功导致数据不一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DB } from '../db/index.js'
import type { Folder, Item, RenameResult, Tag } from '../../shared/types.js'
import { renderNameTemplate, safeFileStem } from '../../shared/rename.js'

// ────────────────────────────────────────────────────────────
// 条目
// ────────────────────────────────────────────────────────────

export function updateItem(
  db: DB,
  id: string,
  patch: Partial<Pick<Item, 'name' | 'annotation' | 'star' | 'url'>>,
): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }

  if (patch.name !== undefined) {
    sets.push('name = @name')
    params.name = patch.name
  }
  if (patch.annotation !== undefined) {
    sets.push('annotation = @annotation')
    params.annotation = patch.annotation
  }
  if (patch.star !== undefined) {
    sets.push('star = @star')
    params.star = Math.max(0, Math.min(5, Math.round(patch.star)))
  }
  if (patch.url !== undefined) {
    sets.push('url = @url')
    params.url = patch.url
  }

  if (sets.length === 0) return
  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

export function updateItems(
  db: DB,
  ids: string[],
  patch: Partial<Pick<Item, 'star'>>,
): void {
  if (ids.length === 0 || patch.star === undefined) return
  const star = Math.max(0, Math.min(5, Math.round(patch.star)))
  const stmt = db.prepare('UPDATE items SET star = ? WHERE id = ?')
  db.transaction(() => {
    for (const id of ids) stmt.run(star, id)
  })()
}

/** 移入回收站。已经在回收站里的不重复计。 */
export function trashItems(db: DB, ids: string[]): number {
  if (ids.length === 0) return 0
  const now = Date.now()
  const stmt = db.prepare(
    'UPDATE items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
  )
  return db.transaction(() => {
    let n = 0
    for (const id of ids) n += stmt.run(now, id).changes
    return n
  })()
}

export function restoreItems(db: DB, ids: string[]): number {
  if (ids.length === 0) return 0
  const stmt = db.prepare(
    'UPDATE items SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL',
  )
  return db.transaction(() => {
    let n = 0
    for (const id of ids) n += stmt.run(id).changes
    return n
  })()
}

export function trashedIds(db: DB): string[] {
  return (
    db.prepare('SELECT id FROM items WHERE deleted_at IS NOT NULL').all() as { id: string }[]
  ).map((r) => r.id)
}

/**
 * 从库里移除条目。
 *
 * 注意：默认**不删原文件**。这是引用式存储的核心承诺——
 * 用户删的是「索引」，不是「照片」。要删原文件必须显式传 deleteFiles。
 */
export function deleteItems(
  db: DB,
  ids: string[],
  opts: { deleteFiles: boolean; unlink: (p: string) => void },
): number {
  if (ids.length === 0) return 0

  const del = db.transaction((list: string[]) => {
    let n = 0
    for (const id of list) {
      const row = db.prepare('SELECT file_path FROM items WHERE id = ?').get(id) as
        | { file_path: string }
        | undefined
      if (!row) continue
      if (opts.deleteFiles) {
        try {
          opts.unlink(row.file_path)
        } catch {
          // 文件可能已经被手动删掉了
        }
      }
      db.prepare('DELETE FROM items WHERE id = ?').run(id)
      n++
    }
    return n
  })

  return del(ids)
}

// ────────────────────────────────────────────────────────────
// 标签
// ────────────────────────────────────────────────────────────

export function createTag(db: DB, name: string, parentId: string | null = null): Tag {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('标签名不能为空')

  if (parentId) {
    const parent = db.prepare('SELECT id FROM tags WHERE id = ?').get(parentId)
    if (!parent) throw new Error('父标签不存在')
  }

  const existing = db
    .prepare(
      `SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND IFNULL(parent_id,'') = ?`,
    )
    .get(trimmed, parentId ?? '') as { id: string } | undefined

  if (existing) {
    const t = db
      .prepare(
        `SELECT id, name, color, parent_id AS parentId,
                (SELECT COUNT(*) FROM item_tags WHERE tag_id = tags.id) AS count
         FROM tags WHERE id = ?`,
      )
      .get(existing.id) as Tag
    return t
  }

  const id = randomUUID()
  db.prepare('INSERT INTO tags (id, name, color, parent_id) VALUES (?, ?, NULL, ?)').run(
    id,
    trimmed,
    parentId,
  )

  return { id, name: trimmed, color: null, parentId, count: 0 }
}

export function renameTag(db: DB, id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('标签名不能为空')
  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(trimmed, id)
}

export function deleteTag(db: DB, id: string): void {
  // ON DELETE CASCADE 会一并清掉 item_tags 和子标签
  db.prepare('DELETE FROM tags WHERE id = ?').run(id)
}

export function assignTags(db: DB, itemIds: string[], tagIds: string[]): void {
  const stmt = db.prepare(
    'INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
  )
  db.transaction(() => {
    for (const item of itemIds) for (const tag of tagIds) stmt.run(item, tag)
  })()
}

export function unassignTags(db: DB, itemIds: string[], tagIds: string[]): void {
  const stmt = db.prepare('DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?')
  db.transaction(() => {
    for (const item of itemIds) for (const tag of tagIds) stmt.run(item, tag)
  })()
}

// ────────────────────────────────────────────────────────────
// 文件夹
// ────────────────────────────────────────────────────────────

export function createFolder(db: DB, name: string, parentId: string | null = null): Folder {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('文件夹名不能为空')

  if (parentId) {
    const parent = db.prepare('SELECT id FROM folders WHERE id = ?').get(parentId)
    if (!parent) throw new Error('父文件夹不存在')
  }

  const existing = db
    .prepare(
      `SELECT id FROM folders WHERE name = ? COLLATE NOCASE AND IFNULL(parent_id,'') = ?`,
    )
    .get(trimmed, parentId ?? '') as { id: string } | undefined

  if (existing) {
    return db
      .prepare(
        `SELECT id, name, color, parent_id AS parentId, cover_item_id AS coverItemId,
                (SELECT COUNT(*) FROM item_folders WHERE folder_id = folders.id) AS count
         FROM folders WHERE id = ?`,
      )
      .get(existing.id) as Folder
  }

  const id = randomUUID()
  db.prepare('INSERT INTO folders (id, name, color, parent_id) VALUES (?, ?, NULL, ?)').run(
    id,
    trimmed,
    parentId,
  )

  return { id, name: trimmed, color: null, parentId, count: 0, coverItemId: null }
}

export function setFolderCover(db: DB, folderId: string, itemId: string): void {
  const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId)
  if (!folder) throw new Error('文件夹不存在')
  const item = db
    .prepare('SELECT id FROM items WHERE id = ? AND deleted_at IS NULL')
    .get(itemId)
  if (!item) throw new Error('找不到这张素材')
  db.prepare('UPDATE folders SET cover_item_id = ? WHERE id = ?').run(itemId, folderId)
}

export function renameFolder(db: DB, id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('文件夹名不能为空')
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(trimmed, id)
}

export function deleteFolder(db: DB, id: string): void {
  db.prepare('DELETE FROM folders WHERE id = ?').run(id)
}

export function assignFolders(db: DB, itemIds: string[], folderIds: string[]): void {
  const maxStmt = db.prepare(
    'SELECT IFNULL(MAX(sort_index), -1) AS m FROM item_folders WHERE folder_id = ?',
  )
  const stmt = db.prepare(
    `INSERT INTO item_folders (item_id, folder_id, sort_index)
     VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
  )
  db.transaction(() => {
    for (const f of folderIds) {
      let next = ((maxStmt.get(f) as { m: number }).m ?? -1) + 1
      for (const item of itemIds) {
        const info = stmt.run(item, f, next)
        if (info.changes > 0) next++
      }
    }
  })()
}

/**
 * 把 itemIds 按给定顺序插到 beforeId 前面。
 * beforeId 不在这个文件夹里时，整批放到末尾。
 */
export function reorderInFolder(
  db: DB,
  folderId: string,
  itemIds: string[],
  beforeId: string | null,
): void {
  const rows = db
    .prepare(
      `SELECT item_id FROM item_folders
       WHERE folder_id = ?
       ORDER BY sort_index ASC, item_id ASC`,
    )
    .all(folderId) as { item_id: string }[]

  const present = new Set(rows.map((r) => r.item_id))
  const moving = itemIds.filter((id) => present.has(id))
  if (moving.length === 0) return

  const movingSet = new Set(moving)
  const rest = rows.map((r) => r.item_id).filter((id) => !movingSet.has(id))
  let at = beforeId ? rest.indexOf(beforeId) : rest.length
  if (at < 0) at = rest.length
  rest.splice(at, 0, ...moving)

  const upd = db.prepare(
    'UPDATE item_folders SET sort_index = ? WHERE folder_id = ? AND item_id = ?',
  )
  db.transaction(() => {
    rest.forEach((id, i) => upd.run(i, folderId, id))
  })()
}

export function setTagColor(db: DB, id: string, color: string | null): void {
  db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(color, id)
}

export function setFolderColor(db: DB, id: string, color: string | null): void {
  db.prepare('UPDATE folders SET color = ? WHERE id = ?').run(color, id)
}

interface RenameRow {
  id: string
  name: string
  ext: string
  file_path: string
}

/**
 * 按模板改显示名。renameFiles 时连磁盘文件一起改，并回写 file_path。
 *
 * 磁盘改名放进同一个事务：中途失败会把已经改过的文件名挪回去，
 * 数据库这边由事务自己回滚。引用模式下这是显式选项，默认不动原文件。
 */
export function renameItems(
  db: DB,
  ids: string[],
  template: string,
  start: number,
  renameFiles: boolean,
): RenameResult {
  if (ids.length === 0) return { renamed: 0, skipped: 0 }
  const trimmed = template.trim()
  if (!trimmed) throw new Error('重命名模板不能为空')

  const lookup = db.prepare(
    'SELECT id, name, ext, file_path FROM items WHERE id = ?',
  )
  const rows = ids
    .map((id) => lookup.get(id) as RenameRow | undefined)
    .filter((r): r is RenameRow => !!r)

  const planned: { row: RenameRow; name: string; nextPath: string | null }[] = []
  const taken = new Set<string>()
  let skipped = ids.length - rows.length

  rows.forEach((row, i) => {
    const name = renderNameTemplate(trimmed, {
      name: row.name,
      ext: row.ext,
      index: start + i,
    }).trim()
    if (!name || name.includes('/') || name.includes('\\')) {
      skipped++
      return
    }

    let nextPath: string | null = null
    if (renameFiles) {
      const stem = safeFileStem(name)
      nextPath = path.join(path.dirname(row.file_path), `${stem}.${row.ext}`)
      const key = nextPath.toLowerCase()
      const sameFile = nextPath === row.file_path
      if (!sameFile && (taken.has(key) || fs.existsSync(nextPath))) {
        skipped++
        return
      }
      taken.add(key)
    }

    if (name === row.name && (nextPath === null || nextPath === row.file_path)) {
      skipped++
      return
    }
    planned.push({ row, name, nextPath })
  })

  const moved: { from: string; to: string }[] = []
  const update = db.prepare('UPDATE items SET name = ?, file_path = ? WHERE id = ?')

  try {
    db.transaction(() => {
      for (const op of planned) {
        let filePath = op.row.file_path
        if (op.nextPath && op.nextPath !== filePath) {
          renameFile(filePath, op.nextPath)
          moved.push({ from: op.nextPath, to: filePath })
          filePath = op.nextPath
        }
        update.run(op.name, filePath, op.row.id)
      }
    })()
  } catch (err) {
    for (const step of moved.reverse()) {
      try {
        renameFile(step.from, step.to)
      } catch {
        // 回滚文件名失败时只能留下现场，错误仍抛给调用方
      }
    }
    throw err
  }

  return { renamed: planned.length, skipped }
}

function renameFile(from: string, to: string): void {
  // 大小写不敏感的盘上，Foo.jpg → foo.jpg 直接 rename 可能被当成同一个文件
  if (from.toLowerCase() === to.toLowerCase() && from !== to) {
    const tmp = `${to}.${process.pid}.aerie-tmp`
    fs.renameSync(from, tmp)
    fs.renameSync(tmp, to)
    return
  }
  fs.renameSync(from, to)
}

export function unassignFolders(db: DB, itemIds: string[], folderIds: string[]): void {
  const stmt = db.prepare('DELETE FROM item_folders WHERE item_id = ? AND folder_id = ?')
  db.transaction(() => {
    for (const item of itemIds) for (const f of folderIds) stmt.run(item, f)
  })()
}
