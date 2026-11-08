/**
 * 把选中的文件复制到用户指定的目录。
 *
 * 这是「导出」，不是移动。源文件留在原地，符合引用式存储的承诺。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db/index.js'
import type { ExportResult } from '../../shared/types.js'
import { safeFileStem } from '../../shared/rename.js'

export function exportItems(db: DB, ids: string[], destDir: string): ExportResult {
  if (!destDir) throw new Error('没有选择导出目录')
  fs.mkdirSync(destDir, { recursive: true })

  const lookup = db.prepare('SELECT name, ext, file_path FROM items WHERE id = ?')
  let copied = 0
  let skipped = 0
  const used = new Set<string>()

  for (const id of ids) {
    const row = lookup.get(id) as { name: string; ext: string; file_path: string } | undefined
    if (!row || !fs.existsSync(row.file_path)) {
      skipped++
      continue
    }
    const stem = safeFileStem(row.name)
    let target = path.join(destDir, `${stem}.${row.ext}`)
    let n = 2
    while (used.has(target.toLowerCase()) || fs.existsSync(target)) {
      target = path.join(destDir, `${stem}-${n}.${row.ext}`)
      n++
      if (n > 999) break
    }
    if (fs.existsSync(target)) {
      skipped++
      continue
    }
    try {
      fs.copyFileSync(row.file_path, target)
      used.add(target.toLowerCase())
      copied++
    } catch {
      skipped++
    }
  }

  return { copied, skipped }
}
