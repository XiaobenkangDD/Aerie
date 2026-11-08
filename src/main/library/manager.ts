/**
 * 库管理器
 *
 * 一次只打开一个库（和 Eagle 一致，避免多库状态混乱）。
 * 库文件夹结构：
 *
 *   <name>.aerie/
 *   ├── library.json     库自身元信息（人类可读，便于手工排查）
 *   ├── aerie.db         SQLite
 *   ├── aerie.db-wal
 *   └── thumbs/{sm,md,lg}/
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, closeDatabase, type DB } from '../db/index.js'
import type { Library, LibraryCreateOptions, StorageMode } from '../../shared/types.js'
import { readRecent, writeRecent } from './recent.js'
import { LIBRARY_EXT, resolveLibraryRoot } from './locate.js'
import { BrowserWindow } from 'electron'
import { ThumbCache, setThumbCache } from '../thumbs/cache.js'
import { startBackfill, stopBackfill } from '../analyze/backfill.js'
import { refreshPresence } from './presence.js'
import { startOcrBackfill, stopOcrBackfill } from '../analyze/ocr.js'
import { startIngest, stopIngest } from '../ingest/server.js'
import { startWatching, stopWatching } from './watch-runtime.js'
import { IPC } from '../../shared/types.js'
import { syncAppMenu } from '../menu.js'
import { clearUndo } from './undo.js'

/** 库文件夹后缀。用 .aerie 而不是 .library，避免和 Eagle 混淆。 */
export { LIBRARY_EXT }

interface LibraryFile {
  id: string
  name: string
  createdAt: number
  storageMode: StorageMode
  /** 文件格式版本，与 db schema 版本独立 */
  formatVersion: number
  /** 缩略图磁盘预算（字节）。缺省 2GB。 */
  thumbBudgetBytes?: number
}

interface OpenState {
  db: DB
  info: Library
  /** 库根目录 */
  root: string
  /** 缩略图目录 */
  thumbsDir: string
}

let state: OpenState | null = null

export function currentLibrary(): Library | null {
  return state ? state.info : null
}

export function getDb(): DB {
  if (!state) throw new Error('没有打开的库')
  return state.db
}

export function getRoot(): string {
  if (!state) throw new Error('没有打开的库')
  return state.root
}

export function getThumbsDir(): string {
  if (!state) throw new Error('没有打开的库')
  return state.thumbsDir
}

// ────────────────────────────────────────────────────────────
// 创建
// ────────────────────────────────────────────────────────────

export function createLibrary(opts: LibraryCreateOptions): Library {
  const parent = opts.path
  if (!fs.existsSync(parent)) {
    throw new Error(`目录不存在：${parent}`)
  }

  const root = path.join(parent, `${opts.name}${LIBRARY_EXT}`)
  if (fs.existsSync(root)) {
    throw new Error(`同名库已存在：${root}`)
  }

  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(path.join(root, 'thumbs', 'sm'), { recursive: true })
  fs.mkdirSync(path.join(root, 'thumbs', 'md'), { recursive: true })
  fs.mkdirSync(path.join(root, 'thumbs', 'lg'), { recursive: true })

  const file: LibraryFile = {
    id: randomUUID(),
    name: opts.name,
    createdAt: Date.now(),
    storageMode: opts.storageMode,
    formatVersion: 1,
  }
  fs.writeFileSync(path.join(root, 'library.json'), JSON.stringify(file, null, 2), 'utf8')

  // 建库后立即打开，验证一切正常
  return openLibrary(root)
}

// ────────────────────────────────────────────────────────────
// 打开
// ────────────────────────────────────────────────────────────

export function openLibrary(root: string): Library {
  const resolved = resolveLibraryRoot(root)
  const metaPath = path.join(resolved, 'library.json')

  const file = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as LibraryFile
  if (!file.id || !file.name) {
    throw new Error(`library.json 格式不正确：${metaPath}`)
  }

  // 先关掉旧的
  if (state) closeLibrary()

  const db = openDatabase(path.join(resolved, 'aerie.db'))
  const thumbsDir = path.join(resolved, 'thumbs')
  for (const s of ['sm', 'md', 'lg']) {
    fs.mkdirSync(path.join(thumbsDir, s), { recursive: true })
  }

  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL').get() as { n: number }
  ).n

  const info: Library = {
    id: file.id,
    name: file.name,
    path: resolved,
    createdAt: file.createdAt,
    itemCount: count,
    storageMode: file.storageMode ?? 'reference',
  }

  state = { db, info, root: resolved, thumbsDir }

  // 缩略图缓存：容量上限按库配置，缺省 2GB
  const cache = new ThumbCache(thumbsDir, file.thumbBudgetBytes ?? undefined)
  setThumbCache(cache)
  startSweepTimer(cache)

  // 记入最近列表
  const recent = readRecent().filter((r) => r.path !== resolved)
  recent.unshift({ path: resolved, name: info.name, openedAt: Date.now() })
  writeRecent(recent.slice(0, 12))

  // 引用模式下原文件可能已经被挪走。分块异步检查，不挡开库。
  void refreshPresence(db).catch(() => undefined)

  // 给升级前导入的图补指纹和拍摄时间。失败不影响开库。
  startBackfill(db)
  // 等开库时的指纹补算先跑一会儿，再识别画面文字。
  scheduleOcr(db)
  if (info.storageMode === 'copy') {
    fs.mkdirSync(path.join(resolved, 'files'), { recursive: true })
  }

  startWatching({
    db,
    libraryRoot: resolved,
    thumbsDir,
    libraryId: info.id,
    storageMode: info.storageMode,
  })
  startIngest({
    db,
    libraryId: info.id,
    inboxDir: path.join(resolved, 'inbox'),
    libraryRoot: resolved,
    storageMode: info.storageMode,
    thumbsDir,
    onImported: () => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.ingestSaved)
      }
    },
  })

  syncAppMenu(true, resolved)
  return info
}

// ────────────────────────────────────────────────────────────
// 关闭
// ────────────────────────────────────────────────────────────

export function closeLibrary(): void {
  clearUndo()
  if (!state) return
  // 先停掉还会写库的后台任务，再关连接
  stopWatching()
  stopIngest()
  cancelScheduledOcr()
  stopOcrBackfill()
  stopBackfill()
  closeDatabase(state.db)
  state = null
  setThumbCache(null)
  stopSweepTimer()
  syncAppMenu(false, null)
}

// ────────────────────────────────────────────────────────────
// 缩略图定时清扫
// ────────────────────────────────────────────────────────────
//
// 打开库 30 秒后先扫一次（此时启动的 I/O 高峰已过），
// 之后每 30 分钟扫一次。sweep 内部还有 10 分钟节流，
// 所以实际开销很低——大部分时候只是读一遍目录就发现没超预算。
let sweepTimer: NodeJS.Timeout | null = null
let ocrTimer: NodeJS.Timeout | null = null

function scheduleOcr(db: DB): void {
  cancelScheduledOcr()
  ocrTimer = setTimeout(() => {
    ocrTimer = null
    startOcrBackfill(db)
  }, 2000)
  ocrTimer.unref?.()
}

function cancelScheduledOcr(): void {
  if (ocrTimer) {
    clearTimeout(ocrTimer)
    ocrTimer = null
  }
}

function startSweepTimer(cache: ThumbCache): void {
  stopSweepTimer()
  const kick = setTimeout(() => {
    void cache.sweep().catch(() => undefined)
  }, 30_000)
  const loop = setInterval(() => {
    void cache.sweep().catch(() => undefined)
  }, 30 * 60 * 1000)
  // 不要因为定时器把进程钉住不退出
  kick.unref?.()
  loop.unref?.()
  sweepTimer = loop
}

function stopSweepTimer(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

/** 刷新条目计数（导入/删除后调用） */
export function refreshCount(): Library | null {
  if (!state) return null
  const count = (
    state.db.prepare('SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL').get() as { n: number }
  ).n
  state.info = { ...state.info, itemCount: count }
  return state.info
}
