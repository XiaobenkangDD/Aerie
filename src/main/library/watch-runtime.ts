/**
 * 监视文件夹里一有变动，就用现有导入再扫一遍。
 *
 * macOS 的 fs.watch 支持递归。短时间内的一串事件合成一次扫描，
 * 避免拷进几十张图时导入几十次。
 *
 * 有 filename 时只导变动路径；没有（或需要兜底）时才整树重扫。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from '../db/index.js'
import { BrowserWindow } from 'electron'
import { IPC, type StorageMode } from '../../shared/types.js'
import { runImport } from '../importer/importer.js'
import { startOcrBackfill } from '../analyze/ocr.js'
import { listWatchFolders } from './watch.js'

interface Session {
  db: DB
  libraryRoot: string
  thumbsDir: string
  libraryId: string
  storageMode: StorageMode
  watchers: fs.FSWatcher[]
}

let session: Session | null = null
let timer: NodeJS.Timeout | null = null
let running = false
/** 待导入的绝对路径。监视根目录本身表示「整树重扫」。 */
const dirty = new Set<string>()

export function startWatching(next: Omit<Session, 'watchers'>): void {
  stopWatching()
  session = { ...next, watchers: [] }
  arm()
}

export function stopWatching(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  dirty.clear()
  if (session) {
    for (const watcher of session.watchers) watcher.close()
  }
  session = null
}

/** 增删监视路径之后重新挂上 fs.watch。 */
export function reloadWatchers(): void {
  if (!session) return
  arm()
}

function arm(): void {
  if (!session) return
  for (const watcher of session.watchers) watcher.close()
  session.watchers = []
  for (const row of listWatchFolders(session.db)) {
    try {
      const root = row.path
      const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
        if (typeof filename === 'string' && filename.length > 0) {
          schedule(path.resolve(root, filename))
        } else {
          // 平台偶发不给文件名：退回整树，别漏文件
          schedule(root)
        }
      })
      session.watchers.push(watcher)
    } catch {
      // 文件夹被删了或没有权限，留在列表里等用户自己去掉
    }
  }
}

function schedule(target: string): void {
  if (!session) return
  dirty.add(target)
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const paths = [...dirty]
    dirty.clear()
    void flush(paths)
  }, 1000)
  timer.unref?.()
}

/** 若同时脏了父目录和子路径，只保留父目录，少扫一遍。 */
function coalesce(paths: string[]): string[] {
  const abs = [...new Set(paths.map((p) => path.resolve(p)))].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  )
  const kept: string[] = []
  for (const p of abs) {
    if (kept.some((parent) => p === parent || p.startsWith(parent + path.sep))) continue
    kept.push(p)
  }
  return kept
}

async function flush(paths: string[]): Promise<void> {
  if (!session || running || paths.length === 0) {
    if (paths.length > 0) {
      for (const p of paths) dirty.add(p)
      if (!timer && session) schedule(paths[0]!)
    }
    return
  }
  const current = session
  running = true
  try {
    let imported = 0
    const targets = coalesce(paths)
    for (const target of targets) {
      if (session !== current) return
      let st: fs.Stats | null = null
      try {
        st = fs.statSync(target)
      } catch {
        // 文件被删了：不必导入；整树监视根被删则跳过
        continue
      }
      const recursive = st.isDirectory()
      const result = await runImport(
        { libraryId: current.libraryId, paths: [target], recursive },
        {
          db: current.db,
          thumbsDir: current.thumbsDir,
          libraryRoot: current.libraryRoot,
          storageMode: current.storageMode,
          onProgress: () => undefined,
          onSettled: () => {
            if (session === current) startOcrBackfill(current.db)
          },
        },
      )
      imported += result.imported
    }
    if (imported > 0 && session === current) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.importProgress, {
          done: imported,
          total: imported,
          current: '',
          phase: 'done',
        })
      }
    }
  } catch {
    // 关库或扫描失败：下一轮变动还会再试
  } finally {
    running = false
    if (dirty.size > 0 && session === current) {
      const again = [...dirty]
      dirty.clear()
      void flush(again)
    }
  }
}
