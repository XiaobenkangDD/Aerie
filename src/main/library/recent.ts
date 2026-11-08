/**
 * 最近打开的库列表
 *
 * 存在 app.getPath('userData')/recent.json，属于应用级状态，不在任何库里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface RecentEntry {
  path: string
  name: string
  openedAt: number
}

function file(): string {
  return path.join(app.getPath('userData'), 'recent.json')
}

export function readRecent(): RecentEntry[] {
  try {
    const raw = fs.readFileSync(file(), 'utf8')
    const parsed = JSON.parse(raw) as RecentEntry[]
    if (!Array.isArray(parsed)) return []
    // 过滤掉已经不存在的路径
    return parsed.filter(
      (r) => r && typeof r.path === 'string' && fs.existsSync(path.join(r.path, 'library.json')),
    )
  } catch {
    return []
  }
}

export function writeRecent(entries: RecentEntry[]): void {
  try {
    const f = file()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(entries, null, 2), 'utf8')
  } catch {
    // 记不住最近列表不算致命错误
  }
}
