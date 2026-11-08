/**
 * 最近操作的撤回。
 *
 * 只留在内存里，关库或换库就清空。最多 30 步。
 * 记的是操作前的状态：回收站记被移入的 id，评分记原来的星级，
 * 加入文件夹或标签只记这次新加上的关系。
 */
import type { DB } from '../db/index.js'
import { assignFolders, assignTags, restoreItems } from './mutate.js'

interface Step {
  label: string
  apply: (db: DB) => void
}

const stack: Step[] = []
const MAX = 30
let applying = false

export function clearUndo(): void {
  stack.length = 0
}

function push(step: Step): void {
  if (applying) return
  stack.push(step)
  if (stack.length > MAX) stack.shift()
}

export function performUndo(db: DB): string | null {
  const step = stack.pop()
  if (!step) return null
  applying = true
  try {
    step.apply(db)
  } finally {
    applying = false
  }
  return step.label
}

function placeholders(ids: string[]): string {
  return ids.map(() => '?').join(',')
}

export function rememberTrash(db: DB, ids: string[]): void {
  if (ids.length === 0) return
  const rows = db
    .prepare(
      `SELECT id FROM items WHERE deleted_at IS NULL AND id IN (${placeholders(ids)})`,
    )
    .all(...ids) as { id: string }[]
  const live = rows.map((row) => row.id)
  if (live.length === 0) return
  push({
    label: '已撤回移入回收站',
    apply: (database) => {
      restoreItems(database, live)
    },
  })
}

export function rememberStars(db: DB, ids: string[], next: number): void {
  if (ids.length === 0) return
  const star = Math.max(0, Math.min(5, Math.round(next)))
  const rows = db
    .prepare(`SELECT id, star FROM items WHERE id IN (${placeholders(ids)})`)
    .all(...ids) as { id: string; star: number }[]
  const changed = rows.filter((row) => row.star !== star)
  if (changed.length === 0) return
  push({
    label: '已撤回评分',
    apply: (database) => {
      const stmt = database.prepare('UPDATE items SET star = ? WHERE id = ?')
      database.transaction(() => {
        for (const row of changed) stmt.run(row.star, row.id)
      })()
    },
  })
}

interface Link {
  itemId: string
  otherId: string
}

function links(
  db: DB,
  table: 'item_folders' | 'item_tags',
  otherColumn: 'folder_id' | 'tag_id',
  itemIds: string[],
  otherIds: string[],
): Link[] {
  if (itemIds.length === 0 || otherIds.length === 0) return []
  return db
    .prepare(
      `SELECT item_id AS itemId, ${otherColumn} AS otherId
       FROM ${table}
       WHERE item_id IN (${placeholders(itemIds)})
         AND ${otherColumn} IN (${placeholders(otherIds)})`,
    )
    .all(...itemIds, ...otherIds) as Link[]
}

function keyOf(link: Link): string {
  return `${link.itemId}\0${link.otherId}`
}

export function snapshotFolderLinks(db: DB, itemIds: string[], folderIds: string[]): Set<string> {
  return new Set(links(db, 'item_folders', 'folder_id', itemIds, folderIds).map(keyOf))
}

export function snapshotTagLinks(db: DB, itemIds: string[], tagIds: string[]): Set<string> {
  return new Set(links(db, 'item_tags', 'tag_id', itemIds, tagIds).map(keyOf))
}

export function undoAddedFolders(
  db: DB,
  itemIds: string[],
  folderIds: string[],
  before: Set<string>,
): void {
  const added = links(db, 'item_folders', 'folder_id', itemIds, folderIds).filter(
    (link) => !before.has(keyOf(link)),
  )
  if (added.length === 0) return
  push({
    label: '已撤回加入文件夹',
    apply: (database) => {
      const stmt = database.prepare(
        'DELETE FROM item_folders WHERE item_id = ? AND folder_id = ?',
      )
      database.transaction(() => {
        for (const link of added) stmt.run(link.itemId, link.otherId)
      })()
    },
  })
}

export function undoRemovedFolders(removed: Link[]): void {
  if (removed.length === 0) return
  push({
    label: '已撤回移出文件夹',
    apply: (database) => {
      for (const link of removed) assignFolders(database, [link.itemId], [link.otherId])
    },
  })
}

export function undoAddedTags(
  db: DB,
  itemIds: string[],
  tagIds: string[],
  before: Set<string>,
): void {
  const added = links(db, 'item_tags', 'tag_id', itemIds, tagIds).filter(
    (link) => !before.has(keyOf(link)),
  )
  if (added.length === 0) return
  push({
    label: '已撤回添加标签',
    apply: (database) => {
      const stmt = database.prepare('DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?')
      database.transaction(() => {
        for (const link of added) stmt.run(link.itemId, link.otherId)
      })()
    },
  })
}

export function undoRemovedTags(removed: Link[]): void {
  if (removed.length === 0) return
  push({
    label: '已撤回移除标签',
    apply: (database) => {
      for (const link of removed) assignTags(database, [link.itemId], [link.otherId])
    },
  })
}

export function folderLinks(db: DB, itemIds: string[], folderIds: string[]): Link[] {
  return links(db, 'item_folders', 'folder_id', itemIds, folderIds)
}

export function tagLinks(db: DB, itemIds: string[], tagIds: string[]): Link[] {
  return links(db, 'item_tags', 'tag_id', itemIds, tagIds)
}
