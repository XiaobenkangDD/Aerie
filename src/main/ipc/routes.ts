/**
 * IPC 路由
 *
 * 所有跨进程调用都集中在这里注册，便于一眼看清主进程暴露了什么能力。
 * 渲染进程拿不到任何 Node 能力（contextIsolation: true），
 * 只能用这里显式暴露的方法。
 */
import { ipcMain, dialog, shell, BrowserWindow, clipboard } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '../../shared/types.js'
import type {
  Annotation,
  ImportProgress,
  ImportRequest,
  LibraryCreateOptions,
  QueryOptions,
  SmartFolderRules,
} from '../../shared/types.js'
import {
  createLibrary,
  openLibrary,
  closeLibrary,
  currentLibrary,
  getDb,
  getRoot,
  getThumbsDir,
  refreshCount,
} from '../library/manager.js'
import { readRecent } from '../library/recent.js'
import {
  extStats,
  getItemDetail,
  libraryStats,
  listFolders,
  listTags,
  queryItems,
  queryItemIds,
  seekToRow,
} from '../library/query.js'
import {
  assignFolders,
  assignTags,
  createFolder,
  createTag,
  deleteFolder,
  deleteItems,
  deleteTag,
  renameFolder,
  renameItems,
  renameTag,
  reorderInFolder,
  restoreItems,
  setFolderColor,
  setFolderCover,
  setTagColor,
  trashItems,
  trashedIds,
  unassignFolders,
  unassignTags,
  updateItem,
  updateItems,
} from '../library/mutate.js'
import { exportItems } from '../library/export-files.js'
import { findSimilar } from '../library/similar.js'
import { getAnnotations, setAnnotations } from '../library/annotations.js'
import { refreshPresence, relinkFolder, relinkItem } from '../library/presence.js'
import { startBackfill } from '../analyze/backfill.js'
import { addWatchFolder, listWatchFolders, removeWatchFolder } from '../library/watch.js'
import {
  folderLinks,
  performUndo,
  rememberStars,
  rememberTrash,
  snapshotFolderLinks,
  snapshotTagLinks,
  tagLinks,
  undoAddedFolders,
  undoAddedTags,
  undoRemovedFolders,
  undoRemovedTags,
} from '../library/undo.js'
import { reloadWatchers } from '../library/watch-runtime.js'
import {
  createSmartFolder,
  deleteSmartFolder,
  listSmartFolders,
  renameSmartFolder,
} from '../library/smart.js'
import { ocrStatus, startOcrBackfill } from '../analyze/ocr.js'
import { ingestInfo, regenerateIngestToken } from '../ingest/server.js'
import { runImport } from '../importer/importer.js'
import { ensureThumb } from '../thumbs/pipeline.js'
import { getThumbCache } from '../thumbs/cache.js'

/** 需要已打开库的操作统一走这个包装，给出可读的错误 */
function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  const db = getDb()
  return fn(db)
}

export function registerIpc(): void {
  // ── 库 ──────────────────────────────────────────────────
  ipcMain.handle(IPC.libraryOpen, (_e, p: string) => openLibrary(p))

  ipcMain.handle(IPC.libraryCreate, (_e, opts: LibraryCreateOptions) => createLibrary(opts))

  ipcMain.handle(IPC.libraryClose, () => {
    closeLibrary()
  })

  ipcMain.handle(IPC.libraryCurrent, () => currentLibrary())

  ipcMain.handle(IPC.libraryRecent, () => readRecent())

  ipcMain.handle(IPC.libraryStats, () => withDb((db) => libraryStats(db)))

  ipcMain.handle(IPC.libraryExtStats, () => withDb((db) => extStats(db)))

  // ── 查询 ────────────────────────────────────────────────
  ipcMain.handle(IPC.itemsSeek, (_e, opts: QueryOptions, row: number) =>
    withDb((db) => seekToRow(db, opts, row)),
  )

  ipcMain.handle(IPC.itemsQuery, (_e, opts: QueryOptions) =>
    withDb((db) => queryItems(db, opts)),
  )

  ipcMain.handle(IPC.itemsQueryIds, (_e, opts: QueryOptions) =>
    withDb((db) => queryItemIds(db, opts)),
  )

  ipcMain.handle(IPC.itemsGet, (_e, id: string) => withDb((db) => getItemDetail(db, id)))

  ipcMain.handle(IPC.itemsUpdate, (_e, id: string, patch: Parameters<typeof updateItem>[2]) =>
    withDb((db) => {
      if (patch.star !== undefined) rememberStars(db, [id], patch.star)
      updateItem(db, id, patch)
    }),
  )

  ipcMain.handle(IPC.itemsUpdateMany, (_e, ids: string[], patch: { star?: number }) =>
    withDb((db) => {
      if (patch.star !== undefined) rememberStars(db, ids, patch.star)
      updateItems(db, ids, patch)
    }),
  )

  ipcMain.handle(IPC.itemsTrash, (_e, ids: string[]) => {
    const n = withDb((db) => {
      rememberTrash(db, ids)
      return trashItems(db, ids)
    })
    refreshCount()
    return n
  })

  ipcMain.handle(IPC.itemsRestore, (_e, ids: string[]) => {
    const n = withDb((db) => restoreItems(db, ids))
    refreshCount()
    return n
  })

  ipcMain.handle(IPC.itemsPurge, async (_e, ids: string[]) => {
    const n = await purgeIds(ids)
    refreshCount()
    return n
  })

  ipcMain.handle(IPC.itemsEmptyTrash, async () => {
    const ids = withDb((db) => trashedIds(db))
    const n = await purgeIds(ids)
    refreshCount()
    return n
  })

  ipcMain.handle(
    IPC.itemsRenameBatch,
    (_e, ids: string[], template: string, start: number, renameFiles: boolean) =>
      withDb((db) => renameItems(db, ids, template, start, renameFiles === true)),
  )

  ipcMain.handle(
    IPC.itemsReorder,
    (_e, folderId: string, itemIds: string[], beforeId: string | null) =>
      withDb((db) => reorderInFolder(db, folderId, itemIds, beforeId)),
  )

  ipcMain.handle(IPC.itemsSimilar, (_e, maxDistance?: number) =>
    withDb((db) => findSimilar(db, typeof maxDistance === 'number' ? maxDistance : 6)),
  )

  ipcMain.handle(IPC.itemsOpen, (_e, id: string) => {
    const row = withDb(
      (db) => db.prepare('SELECT file_path FROM items WHERE id = ?').get(id) as { file_path: string } | undefined,
    )
    if (!row || !fs.existsSync(row.file_path)) throw new Error('原文件不在了')
    return shell.openPath(row.file_path)
  })

  ipcMain.handle(IPC.itemsCopyPaths, (_e, ids: string[]) => {
    const rows = withDb((db) => {
      const stmt = db.prepare('SELECT file_path FROM items WHERE id = ?')
      return ids
        .map((id) => stmt.get(id) as { file_path: string } | undefined)
        .filter((r): r is { file_path: string } => !!r)
        .map((r) => r.file_path)
    })
    clipboard.writeText(rows.join('\n'))
  })

  ipcMain.handle(IPC.itemsExport, (_e, ids: string[], destDir: string) =>
    withDb((db) => exportItems(db, ids, destDir)),
  )

  ipcMain.handle(IPC.itemsAnnotations, (_e, id: string) =>
    withDb((db) => getAnnotations(db, id)),
  )

  ipcMain.handle(IPC.itemsAnnotationsSet, (_e, id: string, annotations: Annotation[]) =>
    withDb((db) => setAnnotations(db, id, annotations)),
  )

  ipcMain.handle(IPC.itemsPresence, () => withDb((db) => refreshPresence(db))) // async，分块让出主进程

  ipcMain.handle(IPC.itemsRelink, (_e, id: string, filePath: string) =>
    withDb((db) => {
      relinkItem(db, id, filePath)
      forgetThumbs(id)
      startBackfill(db)
    }),
  )

  ipcMain.handle(IPC.itemsRelinkFolder, (_e, dir: string) =>
    withDb((db) => {
      const result = relinkFolder(db, dir)
      for (const id of result.ids) forgetThumbs(id)
      if (result.linked > 0) startBackfill(db)
      return { linked: result.linked, stillMissing: result.stillMissing }
    }),
  )

  ipcMain.handle(IPC.smartList, () => withDb((db) => listSmartFolders(db)))

  ipcMain.handle(IPC.smartCreate, (_e, name: string, rules: SmartFolderRules) =>
    withDb((db) => createSmartFolder(db, name, rules)),
  )

  ipcMain.handle(IPC.smartRename, (_e, id: string, name: string) =>
    withDb((db) => renameSmartFolder(db, id, name)),
  )

  ipcMain.handle(IPC.smartDelete, (_e, id: string) => withDb((db) => deleteSmartFolder(db, id)))

  ipcMain.handle(IPC.watchList, () => withDb((db) => listWatchFolders(db)))

  ipcMain.handle(IPC.watchAdd, (_e, dir: string) =>
    withDb((db) => {
      const row = addWatchFolder(db, dir, getRoot())
      reloadWatchers()
      return row
    }),
  )

  ipcMain.handle(IPC.watchRemove, (_e, id: string) =>
    withDb((db) => {
      removeWatchFolder(db, id)
      reloadWatchers()
    }),
  )

  ipcMain.handle(IPC.ocrStatus, () => {
    try {
      return ocrStatus(getDb())
    } catch {
      return ocrStatus(null)
    }
  })

  ipcMain.handle(IPC.ingestInfo, () => {
    try {
      return ingestInfo(getDb())
    } catch {
      return ingestInfo(null)
    }
  })

  ipcMain.handle(IPC.ingestRegenerate, () => withDb((db) => regenerateIngestToken(db)))

  // 彻底从索引移除。原文件不动，只清缩略图。
  async function purgeIds(ids: string[]): Promise<number> {
    const n = withDb((db) =>
      deleteItems(db, ids, {
        deleteFiles: false,
        unlink: (p) => fs.unlinkSync(p),
      }),
    )
    const cache = getThumbCache()
    if (cache) await Promise.all(ids.map((id) => cache.removeItem(id)))
    return n
  }

  // ── 缩略图缓存 ──────────────────────────────────────────
  ipcMain.handle(IPC.thumbsStats, async () => {
    const cache = getThumbCache()
    if (!cache) throw new Error('没有打开的库')
    return cache.stats()
  })

  ipcMain.handle(IPC.thumbsSweep, async (_e, force?: boolean) => {
    const cache = getThumbCache()
    if (!cache) throw new Error('没有打开的库')
    return cache.sweep(force === true)
  })

  // ── 标签 ────────────────────────────────────────────────
  ipcMain.handle(IPC.tagsList, () => withDb((db) => listTags(db)))
  ipcMain.handle(IPC.tagsCreate, (_e, name: string, parentId?: string | null) =>
    withDb((db) => createTag(db, name, parentId ?? null)),
  )
  ipcMain.handle(IPC.tagsRename, (_e, id: string, name: string) =>
    withDb((db) => renameTag(db, id, name)),
  )
  ipcMain.handle(IPC.tagsDelete, (_e, id: string) => withDb((db) => deleteTag(db, id)))
  ipcMain.handle(IPC.tagsSetColor, (_e, id: string, color: string | null) =>
    withDb((db) => setTagColor(db, id, color)),
  )
  ipcMain.handle(IPC.tagsAssign, (_e, itemIds: string[], tagIds: string[]) =>
    withDb((db) => {
      const before = snapshotTagLinks(db, itemIds, tagIds)
      assignTags(db, itemIds, tagIds)
      undoAddedTags(db, itemIds, tagIds, before)
    }),
  )
  ipcMain.handle(IPC.tagsUnassign, (_e, itemIds: string[], tagIds: string[]) =>
    withDb((db) => {
      const removed = tagLinks(db, itemIds, tagIds)
      unassignTags(db, itemIds, tagIds)
      undoRemovedTags(removed)
    }),
  )

  // ── 文件夹 ──────────────────────────────────────────────
  ipcMain.handle(IPC.foldersList, () => withDb((db) => listFolders(db)))
  ipcMain.handle(IPC.foldersCreate, (_e, name: string, parentId?: string | null) =>
    withDb((db) => createFolder(db, name, parentId ?? null)),
  )
  ipcMain.handle(IPC.foldersRename, (_e, id: string, name: string) =>
    withDb((db) => renameFolder(db, id, name)),
  )
  ipcMain.handle(IPC.foldersDelete, (_e, id: string) => withDb((db) => deleteFolder(db, id)))
  ipcMain.handle(IPC.foldersSetColor, (_e, id: string, color: string | null) =>
    withDb((db) => setFolderColor(db, id, color)),
  )
  ipcMain.handle(IPC.foldersAssign, (_e, itemIds: string[], folderIds: string[]) =>
    withDb((db) => {
      const before = snapshotFolderLinks(db, itemIds, folderIds)
      assignFolders(db, itemIds, folderIds)
      undoAddedFolders(db, itemIds, folderIds, before)
    }),
  )
  ipcMain.handle(IPC.foldersUnassign, (_e, itemIds: string[], folderIds: string[]) =>
    withDb((db) => {
      const removed = folderLinks(db, itemIds, folderIds)
      unassignFolders(db, itemIds, folderIds)
      undoRemovedFolders(removed)
    }),
  )
  ipcMain.handle(IPC.foldersSetCover, (_e, folderId: string, itemId: string) =>
    withDb((db) => setFolderCover(db, folderId, itemId)),
  )

  ipcMain.handle(IPC.undoLast, () => {
    const label = withDb((db) => performUndo(db))
    if (label) refreshCount()
    return label
  })

  // ── 导入 ────────────────────────────────────────────────
  ipcMain.handle(IPC.importStart, async (e, req: ImportRequest) => {
    const db = getDb()
    const thumbsDir = getThumbsDir()

    const win = BrowserWindow.fromWebContents(e.sender)
    const onProgress = (p: ImportProgress): void => {
      win?.webContents.send(IPC.importProgress, p)
    }

    const result = await runImport(req, {
      db,
      thumbsDir,
      libraryRoot: getRoot(),
      storageMode: currentLibrary()?.storageMode ?? 'reference',
      onProgress,
      onSettled: () => {
        startOcrBackfill(db)
        void getThumbCache()?.sweep(true).catch(() => undefined)
      },
    })
    refreshCount()

    return result
  })

  ipcMain.handle(IPC.importPaste, async (e) => {
    const paths = clipboardPaths()
    if (paths.length === 0) throw new Error('剪贴板里没有图片或文件')
    const db = getDb()
    const thumbsDir = getThumbsDir()
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await runImport(
      { libraryId: currentLibrary()?.id ?? '', paths, recursive: false },
      {
        db,
        thumbsDir,
        libraryRoot: getRoot(),
        storageMode: currentLibrary()?.storageMode ?? 'reference',
        onProgress: (p) => win?.webContents.send(IPC.importProgress, p),
        onSettled: () => {
          startOcrBackfill(db)
          void getThumbCache()?.sweep(true).catch(() => undefined)
        },
      },
    )
    refreshCount()
    return result
  })

  // ── 缩略图 ──────────────────────────────────────────────
  // 正常情况下渲染进程直接用 aerie-thumb:// 协议拿图，
  // 这个通道是给"缩略图还没生成但用户已经看到卡片"的兜底。
  ipcMain.handle(IPC.thumbEnsure, async (_e, itemId: string) => {
    const db = getDb()
    const row = db
      .prepare('SELECT file_path, ext FROM items WHERE id = ?')
      .get(itemId) as { file_path: string; ext: string } | undefined
    if (!row) return false
    const res = await ensureThumb(getThumbsDir(), itemId, row.file_path, row.ext, 'md')
    if (res.ok) {
      db.prepare('UPDATE items SET has_thumb = 1 WHERE id = ?').run(itemId)
    }
    return res.ok
  })

  // 菜单栏的「粘贴」在文字框里走这里，避免抢走从剪贴板导入素材的快捷键。
  ipcMain.handle(IPC.editPaste, (e) => {
    e.sender.paste()
  })

  ipcMain.handle(IPC.editUndo, (e) => {
    e.sender.undo()
  })

  // ── 对话框 ──────────────────────────────────────────────
  ipcMain.handle(IPC.dialogPickFiles, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = win
      ? await dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          title: '选择要导入的文件',
        })
      : await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          title: '选择要导入的文件',
        })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(IPC.dialogPickFolder, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: '选择要导入的文件夹',
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.dialogPickNewLibrary, async (e, title?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      title: title?.trim() || '选择库的存放位置',
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.dialogPickExport, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择导出位置',
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // ── 系统 ────────────────────────────────────────────────
  ipcMain.handle(IPC.shellReveal, (_e, p: string) => {
    if (fs.existsSync(p)) shell.showItemInFolder(p)
  })

}

/** 剪贴板：图片优先，其次文件 URL，最后是一段真实存在的绝对路径。 */
function clipboardPaths(): string[] {
  const image = clipboard.readImage()
  if (!image.isEmpty()) {
    const dir = path.join(getRoot(), 'inbox')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `paste-${Date.now()}.png`)
    fs.writeFileSync(file, image.toPNG())
    return [file]
  }

  const fileUrl = clipboard.read('public.file-url').trim()
  if (fileUrl.startsWith('file:')) {
    try {
      const local = fileURLToPath(fileUrl)
      if (fs.existsSync(local)) return [local]
    } catch {
      // 不是合法的 file URL
    }
  }

  const lines = clipboard
    .readText()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/') && fs.existsSync(line))
  return lines
}

/** 接回新文件后清掉旧缩略图，否则缓存命中会一直显示原来的图。 */
function forgetThumbs(id: string): void {
  if (!ITEM_ID.test(id)) return
  let dir: string
  try {
    dir = getThumbsDir()
  } catch {
    return
  }
  for (const size of ['sm', 'md', 'lg']) {
    try {
      fs.rmSync(path.join(dir, size, `${id}.webp`), { force: true })
    } catch {
      // 这张缩略图本来就没有
    }
  }
}

const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 只允许按库里的 id 取原文件，渲染进程拼不出任意路径。 */
export function resolveItemFile(itemId: string): { filePath: string; ext: string } | null {
  if (!ITEM_ID.test(itemId)) return null
  try {
    const row = getDb()
      .prepare('SELECT file_path, ext FROM items WHERE id = ?')
      .get(itemId) as { file_path: string; ext: string } | undefined
    if (!row) return null
    const filePath = path.resolve(row.file_path)
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null
    return { filePath, ext: row.ext }
  } catch {
    return null
  }
}

/** 供协议处理器复用的路径查询 */
export function resolveThumbPath(itemId: string, size: string): string | null {
  const safeSize = ['sm', 'md', 'lg'].includes(size) ? size : 'md'
  // itemId 只允许 UUID 形态，避免路径穿越
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return null
  return path.join(getThumbsDir(), safeSize, `${itemId}.webp`)
}
