/**
 * 监视文件夹里一有变动，就用现有导入再扫一遍。
 *
 * macOS 的 fs.watch 支持递归。短时间内的一串事件合成一次扫描，
 * 避免拷进几十张图时导入几十次。
 */
import fs from 'node:fs'
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
      const watcher = fs.watch(row.path, { recursive: true }, () => schedule(row.path))
      session.watchers.push(watcher)
    } catch {
      // 文件夹被删了或没有权限，留在列表里等用户自己去掉
    }
  }
}

function schedule(dir: string): void {
  if (!session) return
  dirty.add(dir)
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const dirs = [...dirty]
    dirty.clear()
    void flush(dirs)
  }, 1000)
  timer.unref?.()
}

async function flush(dirs: string[]): Promise<void> {
  if (!session || running || dirs.length === 0) {
    if (dirs.length > 0) {
      for (const dir of dirs) dirty.add(dir)
      if (!timer && session) schedule(dirs[0])
    }
    return
  }
  const current = session
  running = true
  try {
    let imported = 0
    for (const dir of dirs) {
      if (session !== current) return
      const result = await runImport(
        { libraryId: current.libraryId, paths: [dir], recursive: true },
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
  }
}
