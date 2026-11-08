/**
 * 监视文件夹只记路径。真正盯着磁盘的是 watch-runtime。
 * 新文件进来后走现有导入，不会另写一套入库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DB } from '../db/index.js'
import type { WatchFolder } from '../../shared/types.js'
import { isInside } from './paths.js'

export function listWatchFolders(db: DB): WatchFolder[] {
  return db
    .prepare(`SELECT id, path, created_at AS createdAt FROM watch_folders ORDER BY created_at`)
    .all() as WatchFolder[]
}

export function addWatchFolder(db: DB, dir: string, libraryRoot: string): WatchFolder {
  const abs = path.resolve(dir)
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new Error('文件夹不存在')
  }
  if (!st.isDirectory()) throw new Error('请选择文件夹')
  if (isInside(abs, libraryRoot)) throw new Error('库文件夹本身不用监视')
  const id = randomUUID()
  const createdAt = Date.now()
  try {
    db.prepare(`INSERT INTO watch_folders (id, path, created_at) VALUES (?, ?, ?)`).run(id, abs, createdAt)
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new Error('这个文件夹已经在监视')
    throw err
  }
  return { id, path: abs, createdAt }
}

export function removeWatchFolder(db: DB, id: string): void {
  db.prepare(`DELETE FROM watch_folders WHERE id = ?`).run(id)
}
