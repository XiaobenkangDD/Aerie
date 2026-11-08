/**
 * 预加载脚本
 *
 * 这是渲染进程能看到的全部世界。没有任何 Node API 泄漏出去。
 * 每个方法都对应主进程里一个明确的 ipcMain.handle。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/types.js'
import type {
  AerieApi,
  Annotation,
  ImportProgress,
  MenuCommand,
  ImportRequest,
  Item,
  LibraryCreateOptions,
  QueryOptions,
  SmartFolderRules,
} from '../shared/types.js'

const api: AerieApi = {
  library: {
    open: (p) => ipcRenderer.invoke(IPC.libraryOpen, p),
    create: (opts: LibraryCreateOptions) => ipcRenderer.invoke(IPC.libraryCreate, opts),
    close: () => ipcRenderer.invoke(IPC.libraryClose),
    current: () => ipcRenderer.invoke(IPC.libraryCurrent),
    recent: () => ipcRenderer.invoke(IPC.libraryRecent),
    stats: () => ipcRenderer.invoke(IPC.libraryStats),
    extStats: () => ipcRenderer.invoke(IPC.libraryExtStats),
  },

  items: {
    seek: (opts: QueryOptions, row: number) => ipcRenderer.invoke(IPC.itemsSeek, opts, row),
    query: (opts: QueryOptions) => ipcRenderer.invoke(IPC.itemsQuery, opts),
    get: (id) => ipcRenderer.invoke(IPC.itemsGet, id),
    update: (id, patch: Partial<Pick<Item, 'name' | 'annotation' | 'star' | 'url'>>) =>
      ipcRenderer.invoke(IPC.itemsUpdate, id, patch),
    updateMany: (ids, patch) => ipcRenderer.invoke(IPC.itemsUpdateMany, ids, patch),
    trash: (ids) => ipcRenderer.invoke(IPC.itemsTrash, ids),
    restore: (ids) => ipcRenderer.invoke(IPC.itemsRestore, ids),
    purge: (ids) => ipcRenderer.invoke(IPC.itemsPurge, ids),
    emptyTrash: () => ipcRenderer.invoke(IPC.itemsEmptyTrash),
    renameBatch: (ids, template, start, renameFiles) =>
      ipcRenderer.invoke(IPC.itemsRenameBatch, ids, template, start, renameFiles),
    reorder: (folderId, itemIds, beforeId) =>
      ipcRenderer.invoke(IPC.itemsReorder, folderId, itemIds, beforeId),
    similar: (maxDistance) => ipcRenderer.invoke(IPC.itemsSimilar, maxDistance),
    open: (id) => ipcRenderer.invoke(IPC.itemsOpen, id),
    copyPaths: (ids) => ipcRenderer.invoke(IPC.itemsCopyPaths, ids),
    export: (ids, destDir) => ipcRenderer.invoke(IPC.itemsExport, ids, destDir),
    annotations: (id) => ipcRenderer.invoke(IPC.itemsAnnotations, id),
    setAnnotations: (id, annotations: Annotation[]) =>
      ipcRenderer.invoke(IPC.itemsAnnotationsSet, id, annotations),
    refreshPresence: () => ipcRenderer.invoke(IPC.itemsPresence),
    relink: (id, filePath) => ipcRenderer.invoke(IPC.itemsRelink, id, filePath),
    relinkFolder: (dir) => ipcRenderer.invoke(IPC.itemsRelinkFolder, dir),
  },

  smartFolders: {
    list: () => ipcRenderer.invoke(IPC.smartList),
    create: (name, rules: SmartFolderRules) => ipcRenderer.invoke(IPC.smartCreate, name, rules),
    rename: (id, name) => ipcRenderer.invoke(IPC.smartRename, id, name),
    delete: (id) => ipcRenderer.invoke(IPC.smartDelete, id),
  },

  watch: {
    list: () => ipcRenderer.invoke(IPC.watchList),
    add: (dir) => ipcRenderer.invoke(IPC.watchAdd, dir),
    remove: (id) => ipcRenderer.invoke(IPC.watchRemove, id),
  },

  ocr: {
    status: () => ipcRenderer.invoke(IPC.ocrStatus),
  },

  ingest: {
    info: () => ipcRenderer.invoke(IPC.ingestInfo),
    regenerate: () => ipcRenderer.invoke(IPC.ingestRegenerate),
    onSaved: (cb: () => void) => {
      const handler = (): void => cb()
      ipcRenderer.on(IPC.ingestSaved, handler)
      return () => ipcRenderer.off(IPC.ingestSaved, handler)
    },
  },

  tags: {
    list: () => ipcRenderer.invoke(IPC.tagsList),
    create: (name, parentId) => ipcRenderer.invoke(IPC.tagsCreate, name, parentId ?? null),
    rename: (id, name) => ipcRenderer.invoke(IPC.tagsRename, id, name),
    delete: (id) => ipcRenderer.invoke(IPC.tagsDelete, id),
    setColor: (id, color) => ipcRenderer.invoke(IPC.tagsSetColor, id, color),
    assign: (itemIds, tagIds) => ipcRenderer.invoke(IPC.tagsAssign, itemIds, tagIds),
    unassign: (itemIds, tagIds) => ipcRenderer.invoke(IPC.tagsUnassign, itemIds, tagIds),
  },

  folders: {
    list: () => ipcRenderer.invoke(IPC.foldersList),
    create: (name, parentId) => ipcRenderer.invoke(IPC.foldersCreate, name, parentId ?? null),
    rename: (id, name) => ipcRenderer.invoke(IPC.foldersRename, id, name),
    delete: (id) => ipcRenderer.invoke(IPC.foldersDelete, id),
    setColor: (id, color) => ipcRenderer.invoke(IPC.foldersSetColor, id, color),
    assign: (itemIds, folderIds) => ipcRenderer.invoke(IPC.foldersAssign, itemIds, folderIds),
    unassign: (itemIds, folderIds) =>
      ipcRenderer.invoke(IPC.foldersUnassign, itemIds, folderIds),
    setCover: (folderId, itemId) => ipcRenderer.invoke(IPC.foldersSetCover, folderId, itemId),
  },

  import: {
    start: (req: ImportRequest) => ipcRenderer.invoke(IPC.importStart, req),
    paste: () => ipcRenderer.invoke(IPC.importPaste),
    onProgress: (cb: (p: ImportProgress) => void) => {
      const handler = (_e: unknown, p: ImportProgress): void => cb(p)
      ipcRenderer.on(IPC.importProgress, handler)
      // 返回取消订阅函数，React 里在 useEffect cleanup 调用
      return () => ipcRenderer.off(IPC.importProgress, handler)
    },
  },

  thumb: {
    get: async (itemId, size) => `aerie-thumb://${size}/${itemId}`,
  },

  thumbs: {
    stats: () => ipcRenderer.invoke(IPC.thumbsStats),
    sweep: (force) => ipcRenderer.invoke(IPC.thumbsSweep, force),
  },

  files: {
    pathFor: (file) => webUtils.getPathForFile(file),
  },

  dialog: {
    pickFiles: () => ipcRenderer.invoke(IPC.dialogPickFiles),
    pickFolder: () => ipcRenderer.invoke(IPC.dialogPickFolder),
    pickNewLibrary: (title?: string) => ipcRenderer.invoke(IPC.dialogPickNewLibrary, title),
    pickExportFolder: () => ipcRenderer.invoke(IPC.dialogPickExport),
  },

  shell: {
    reveal: (p) => ipcRenderer.invoke(IPC.shellReveal, p),
  },

  menu: {
    onCommand: (cb: (command: MenuCommand, arg?: string) => void) => {
      const handler = (_e: unknown, command: MenuCommand, arg?: string): void => cb(command, arg)
      ipcRenderer.on(IPC.menuCommand, handler)
      return () => ipcRenderer.off(IPC.menuCommand, handler)
    },
  },

  window: {
    onFullscreen: (cb: (fullscreen: boolean) => void) => {
      const handler = (_e: unknown, fullscreen: boolean): void => cb(fullscreen)
      ipcRenderer.on(IPC.windowFullscreen, handler)
      return () => ipcRenderer.off(IPC.windowFullscreen, handler)
    },
  },

  edit: {
    paste: () => ipcRenderer.invoke(IPC.editPaste),
    undo: () => ipcRenderer.invoke(IPC.editUndo),
  },

  undo: {
    perform: () => ipcRenderer.invoke(IPC.undoLast),
  },
}

contextBridge.exposeInMainWorld('aerie', api)
