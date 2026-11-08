/**
 * 智能文件夹的增删改。
 *
 * 规则以 JSON 存在 rules 列里，读出来先过 normalizeRules，
 * 这样旧版本写进去的多余字段不会漏进查询。
 */
import type { DB } from '../db/index.js'
import { uuidv7 } from '../db/uuid.js'
import type { SmartFolder, SmartFolderRules } from '../../shared/types.js'
import { normalizeRules } from '../../shared/smart.js'

interface SmartRow {
  id: string
  name: string
  rules: string
  createdAt: number
}

function parseStored(raw: string): SmartFolderRules {
  try {
    return normalizeRules(JSON.parse(raw) as unknown)
  } catch {
    return {}
  }
}

function toFolder(row: SmartRow): SmartFolder {
  return {
    id: row.id,
    name: row.name,
    rules: parseStored(row.rules),
    createdAt: row.createdAt,
  }
}

export function listSmartFolders(db: DB): SmartFolder[] {
  const rows = db
    .prepare(
      `SELECT id, name, rules, created_at AS createdAt
       FROM smart_folders
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as SmartRow[]
  return rows.map(toFolder)
}

export function createSmartFolder(db: DB, name: string, rules: SmartFolderRules): SmartFolder {
  const trimmed = name.trim().slice(0, 80)
  if (!trimmed) throw new Error('名称不能为空')
  const normalized = normalizeRules(rules)
  const folder: SmartFolder = {
    id: uuidv7(),
    name: trimmed,
    rules: normalized,
    createdAt: Date.now(),
  }
  db.prepare(
    `INSERT INTO smart_folders (id, name, rules, created_at) VALUES (@id, @name, @rules, @createdAt)`,
  ).run({
    id: folder.id,
    name: folder.name,
    rules: JSON.stringify(normalized),
    createdAt: folder.createdAt,
  })
  return folder
}

export function renameSmartFolder(db: DB, id: string, name: string): void {
  const trimmed = name.trim().slice(0, 80)
  if (!trimmed) throw new Error('名称不能为空')
  const info = db.prepare(`UPDATE smart_folders SET name = ? WHERE id = ?`).run(trimmed, id)
  if (info.changes === 0) throw new Error('智能文件夹不存在')
}

export function deleteSmartFolder(db: DB, id: string): void {
  db.prepare(`DELETE FROM smart_folders WHERE id = ?`).run(id)
}
