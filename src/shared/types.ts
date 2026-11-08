/**
 * Aerie 共享类型定义
 *
 * 这份文件是主进程（Node）与渲染进程（浏览器）之间唯一的契约。
 * 任何跨进程传输的数据结构都必须在这里声明。
 */

// ────────────────────────────────────────────────────────────
// 库（Library）
// ────────────────────────────────────────────────────────────

/**
 * 一个库就是磁盘上的一个文件夹，结构：
 *
 *   <name>.aerie/
 *   ├── aerie.db          SQLite 数据库（元数据 + 索引）
 *   ├── thumbs/           缩略图缓存（可删除，会自动重建）
 *   └── ...               原图不在这里（引用式），除非用户选择复制模式
 *
 * 关键设计：**引用式存储**。
 * 默认不复制原图，只记录路径。这是与 Eagle 的核心差异——
 * 用户随时可以在访达里找到文件，不会被锁进私有库。
 */
export interface Library {
  id: string
  name: string
  /** 库文件夹的绝对路径 */
  path: string
  createdAt: number
  /** 打开时的统计 */
  itemCount: number
  /** 存储模式：reference 只记路径，copy 复制进库 */
  storageMode: StorageMode
}

export type StorageMode = 'reference' | 'copy'

export interface LibraryCreateOptions {
  name: string
  path: string
  storageMode: StorageMode
}

// ────────────────────────────────────────────────────────────
// 条目（Item）
// ────────────────────────────────────────────────────────────

export interface Item {
  id: string
  /** 显示名，不含扩展名 */
  name: string
  /** 扩展名，小写不带点，如 "jpg" */
  ext: string
  /** 绝对路径。copy 模式下指向库内副本 */
  filePath: string
  fileSize: number
  width: number | null
  height: number | null
  /** 文件修改时间 */
  mtime: number
  /** 加入库的时间 */
  addedAt: number
  annotation: string | null
  /** 来源网址（从网页收藏时记录） */
  url: string | null
  /** 0-5 星 */
  star: number
  /** 感知哈希，用于相似去重。null 表示还没算 */
  phash: string | null
  /** 缩略图是否已生成 */
  hasThumb: boolean
  /** 移入回收站的时间，null 表示仍在库中 */
  deletedAt: number | null
  /** 主色，RRGGBB，不含 # */
  palette: string[]
  /** 主色相，用于按颜色筛选 */
  hue: HueId | null
  /** 原文件不在记录的路径上 */
  missing: boolean
  /** 拍摄时间。null 表示没有 EXIF 或还没读到 */
  takenAt: number | null
}

/** 带关联数据的完整条目（详情面板用） */
export interface ItemDetail extends Item {
  tags: Tag[]
  folders: Folder[]
}

// ────────────────────────────────────────────────────────────
// 标签（Tag）
// ────────────────────────────────────────────────────────────

/**
 * 标签支持层级（parentId），这是 Eagle 没有的。
 * 例如：人物 > 女性 > 长发
 */
export interface Tag {
  id: string
  name: string
  /** #RRGGBB，null 表示未设色 */
  color: string | null
  parentId: string | null
  /** 直接挂在标签下的条目数 */
  count: number
}

// ────────────────────────────────────────────────────────────
// 文件夹（Folder）
// ────────────────────────────────────────────────────────────

/**
 * 文件夹是"收藏夹/相册"，与磁盘目录无关，支持嵌套。
 * 一个条目可以同时属于多个文件夹。
 */
export interface Folder {
  id: string
  name: string
  parentId: string | null
  color: string | null
  count: number
  /** 侧栏上显示的封面。指定的还在就用它，否则用文件夹里的第一张。 */
  coverItemId: string | null
}

// ────────────────────────────────────────────────────────────
// 智能文件夹
// ────────────────────────────────────────────────────────────

/**
 * 保存下来的筛选条件。
 *
 * 和侧栏里写死的「未分类 / 未标签」不同：这里的条件可以叠加，
 * 比如「png + 三星以上 + 未标签 + 大于 2MB」。
 * 查询时翻译成 QueryOptions，不另写一套 SQL。
 */
export interface SmartFolderRules {
  /** 扩展名，小写不带点 */
  exts?: string[]
  /** 最低星级，1–5 */
  minStar?: number
  hue?: HueId
  /** 关键词，走现有搜索（名称、备注、画面文字） */
  keyword?: string
  /** 标签 id，AND 语义，和普通筛选一致 */
  tagIds?: string[]
  uncategorized?: boolean
  untagged?: boolean
  /** 文件大小下限，字节，含 */
  minSize?: number
  /** 文件大小上限，字节，含 */
  maxSize?: number
  /** 加入时间起点，毫秒，含 */
  addedFrom?: number
  /** 加入时间终点，毫秒，含 */
  addedTo?: number
  /** 横图 / 竖图 / 方形 */
  orientation?: Orientation
  /** 拍摄时间起点，毫秒，含。0 和 NULL 都表示没有拍摄时间，不算在范围内 */
  takenFrom?: number
  /** 拍摄时间终点，毫秒，含 */
  takenTo?: number
}

export interface SmartFolder {
  id: string
  name: string
  rules: SmartFolderRules
  createdAt: number
}

/** 监视中的文件夹。里面新出现的文件会自动进库。 */
export interface WatchFolder {
  id: string
  path: string
  createdAt: number
}

// ────────────────────────────────────────────────────────────
// 画面标注
// ────────────────────────────────────────────────────────────

export type AnnotationKind = 'rect' | 'arrow' | 'text'

/**
 * 一条标注。坐标全部是相对原图宽高的 0–1。
 *
 * 为什么不存像素：同一张图在「适应窗口」和「实际大小」下像素位置完全不同，
 * 存比例后怎么缩放都还落在画面上的同一处。
 *
 * 矩形：x,y 是左上角，w,h 是宽高（都 ≥ 0）。
 * 箭头：x,y 是起点，w,h 是到终点的偏移（可以为负）。
 * 文字：x,y 是锚点，文字在 text 里。
 */
export interface Annotation {
  id: string
  kind: AnnotationKind
  x: number
  y: number
  w: number
  h: number
  text?: string
}

// ────────────────────────────────────────────────────────────
// 查询
// ────────────────────────────────────────────────────────────

export type SortField = 'addedAt' | 'name' | 'fileSize' | 'mtime' | 'star' | 'takenAt' | 'manual'
export type SortOrder = 'asc' | 'desc'

/** 十二色相。和调色板筛选、指纹里的 hue 字段是同一套名字。 */
export type HueId =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'brown'
  | 'white'
  | 'gray'
  | 'black'

/**
 * 侧栏里的智能视图。
 * active 是普通库（可再叠加文件夹和标签）。
 * 其余几项互斥，表示「未分类 / 未标签 / 已评分 / 重复 / 回收站」。
 */
export type ItemScope = 'active' | 'uncategorized' | 'untagged' | 'starred' | 'duplicates' | 'missing' | 'trash'

/** 按宽高比筛选。接近正方形（差在 2% 以内）算方形。 */
export type Orientation = 'landscape' | 'portrait' | 'square'

export interface QueryOptions {
  /** 全文搜索词（匹配名称、备注、画面文字） */
  search?: string
  /** 限定在这些标签内（AND 语义） */
  tagIds?: string[]
  /** 限定在这个文件夹内（含子文件夹） */
  folderId?: string
  /** 星级下限 */
  minStar?: number
  /** 扩展名过滤 */
  exts?: string[]
  /** 智能视图。缺省 active，并且始终排除回收站（trash 除外） */
  scope?: ItemScope
  /** 按主色相筛选 */
  hue?: HueId
  /** 横图 / 竖图 / 方形 */
  orientation?: Orientation
  /**
   * 只要未放进任何文件夹的。
   * 和 scope 分开，是因为智能文件夹要能「未分类 + 未标签」同时成立，
   * 而 scope 这几项是互斥的。
   */
  uncategorized?: boolean
  /** 只要没有任何标签的。原因同 uncategorized。 */
  untagged?: boolean
  /** 文件大小下限，字节，含 */
  minSize?: number
  /** 文件大小上限，字节，含 */
  maxSize?: number
  /** 加入时间起点，毫秒，含 */
  addedFrom?: number
  /** 加入时间终点，毫秒，含 */
  addedTo?: number
  /** 拍摄时间起点，毫秒，含 */
  takenFrom?: number
  /** 拍摄时间终点，毫秒，含 */
  takenTo?: number
  sort?: SortField
  order?: SortOrder
  offset?: number
  limit?: number
  /**
   * 游标分页：传上一页最后一条的排序键值，从它之后继续取。
   *
   * 为什么需要：OFFSET 是 O(n)，100 万条时深翻页要 900ms。
   * 游标分页是 O(log n)，走索引直接定位。
   * 虚拟滚动时顺序翻页用游标，随机跳转才退回 offset。
   */
  cursor?: Cursor
}

/** 游标：记录排序键的值，下次从它之后开始 */
export interface Cursor {
  /** 排序字段的值（addedAt/mtime/fileSize/star 是数字，name 是字符串） */
  key: number | string
  /**
   * 并列时的决胜 id。
   *
   * 为什么用 id 而不是 rowid：SQLite 里 (added_at, id) 是覆盖索引，
   * 按 (added_at, id) 排序可以纯索引扫描；换成 rowid 会触发
   * "TEMP B-TREE FOR LAST TERM OF ORDER BY"，百万条时慢 18 倍。
   */
  id: string
}

export interface QueryResult {
  items: Item[]
  /** 满足条件的总数（用于虚拟滚动的高度计算） */
  total: number
  /** 耗时毫秒，调试用 */
  elapsedMs: number
  /** 下一页的游标，null 表示已到底 */
  nextCursor: Cursor | null
}

// ────────────────────────────────────────────────────────────
// 导入
// ────────────────────────────────────────────────────────────

export interface ImportRequest {
  libraryId: string
  /** 要导入的文件或文件夹绝对路径 */
  paths: string[]
  /** 是否递归扫描子目录 */
  recursive: boolean
}

export interface ImportProgress {
  /** 已处理的文件数 */
  done: number
  /** 已发现的文件总数（扫描阶段结束后才准确） */
  total: number
  /** 当前正在处理的文件名 */
  current: string
  phase: 'scanning' | 'copying' | 'importing' | 'thumbs' | 'done' | 'error'
  error?: string
}

export interface ImportResult {
  imported: number
  skipped: number
  failed: number
  errors: string[]
}

export interface LibraryStats {
  active: number
  trash: number
  uncategorized: number
  untagged: number
  starred: number
  duplicates: number
  missing: number
}

export interface RenameResult {
  renamed: number
  skipped: number
}

export interface ExportResult {
  copied: number
  skipped: number
}

export interface PresenceScan {
  checked: number
  missing: number
}

export interface RelinkFolderResult {
  linked: number
  stillMissing: number
}

/** 一组视觉上接近的素材 */
export interface SimilarGroup {
  /** 组内最大汉明距离。0 表示指纹完全相同 */
  distance: number
  items: Item[]
}

export interface SimilarScan {
  groups: SimilarGroup[]
  /** 参与比较的已有指纹数量 */
  compared: number
  /**
   * 库太大时只按完全相同的指纹分组，不再做近邻比较。
   * 近邻是 O(n²)，超过几千张会卡住界面。
   */
  approximate: boolean
}

// ────────────────────────────────────────────────────────────
// IPC 通道名（单一事实来源，避免主/渲染两端拼错字符串）
// ────────────────────────────────────────────────────────────

export const IPC = {
  // 库
  libraryOpen: 'library:open',
  libraryCreate: 'library:create',
  libraryClose: 'library:close',
  libraryCurrent: 'library:current',
  libraryRecent: 'library:recent',

  // 查询
  itemsQuery: 'items:query',
  itemsSeek: 'items:seek',
  itemsGet: 'items:get',
  itemsUpdate: 'items:update',
  itemsDelete: 'items:delete',
  itemsTrash: 'items:trash',
  itemsRestore: 'items:restore',
  itemsPurge: 'items:purge',
  itemsEmptyTrash: 'items:empty-trash',
  itemsRenameBatch: 'items:rename-batch',
  itemsReorder: 'items:reorder',
  itemsSimilar: 'items:similar',
  itemsOpen: 'items:open',
  itemsCopyPaths: 'items:copy-paths',
  itemsExport: 'items:export',
  itemsUpdateMany: 'items:update-many',
  itemsAnnotations: 'items:annotations',
  itemsAnnotationsSet: 'items:annotations-set',
  itemsPresence: 'items:presence',
  itemsRelink: 'items:relink',
  itemsRelinkFolder: 'items:relink-folder',

  smartList: 'smart:list',
  smartCreate: 'smart:create',
  smartRename: 'smart:rename',
  smartDelete: 'smart:delete',

  watchList: 'watch:list',
  watchAdd: 'watch:add',
  watchRemove: 'watch:remove',

  ocrStatus: 'ocr:status',
  ingestInfo: 'ingest:info',
  ingestRegenerate: 'ingest:regenerate',
  /** 浏览器收藏写入库之后通知界面刷新 */
  ingestSaved: 'ingest:saved',

  libraryStats: 'library:stats',
  libraryExtStats: 'library:ext-stats',

  // 缩略图缓存
  thumbsStats: 'thumbs:stats',
  thumbsSweep: 'thumbs:sweep',

  // 标签
  tagsList: 'tags:list',
  tagsCreate: 'tags:create',
  tagsRename: 'tags:rename',
  tagsDelete: 'tags:delete',
  tagsSetColor: 'tags:set-color',
  tagsAssign: 'tags:assign',
  tagsUnassign: 'tags:unassign',

  // 文件夹
  foldersList: 'folders:list',
  foldersCreate: 'folders:create',
  foldersRename: 'folders:rename',
  foldersDelete: 'folders:delete',
  foldersSetColor: 'folders:set-color',
  foldersAssign: 'folders:assign',
  foldersUnassign: 'folders:unassign',
  foldersSetCover: 'folders:set-cover',

  // 导入
  importStart: 'import:start',
  importPaste: 'import:paste',
  importProgress: 'import:progress',

  // 缩略图
  thumbGet: 'thumb:get',
  thumbEnsure: 'thumb:ensure',

  // 系统
  dialogPickFiles: 'dialog:pick-files',
  dialogPickFolder: 'dialog:pick-folder',
  dialogPickNewLibrary: 'dialog:pick-new-library',
  dialogPickExport: 'dialog:pick-export',
  shellReveal: 'shell:reveal',

  /** 菜单栏点选或快捷键，主进程转给界面执行 */
  menuCommand: 'menu:command',
  /** 窗口进入或退出全屏。界面用来给红绿灯让位 */
  windowFullscreen: 'window:fullscreen',
  /** 把剪贴板贴进当前文字框。导入图片走 import:paste */
  editPaste: 'edit:paste',
  /** 文字框里的系统撤销。素材操作的撤回走 undoLast */
  editUndo: 'edit:undo',
  undoLast: 'undo:last',
} as const

/** 菜单栏发给界面的动作。文字框里的复制、剪切、重做仍走系统角色。 */
export type MenuCommand =
  | 'new-reference'
  | 'new-copy'
  | 'open-library'
  | 'open-recent'
  | 'close-library'
  | 'import-files'
  | 'import-folder'
  | 'paste-import'
  | 'paste'
  | 'undo'
  | 'export'
  | 'new-folder'
  | 'new-tag'
  | 'trash'
  | 'rename'
  | 'layout-grid'
  | 'layout-list'
  | 'layout-waterfall'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'focus-search'
  | 'select-all'
  | 'find-similar'
  | 'check-missing'
  | 'relink-folder'

/** 渲染进程暴露的 API 形状 */
// ────────────────────────────────────────────────────────────
// 缩略图缓存
// ────────────────────────────────────────────────────────────

export interface SizeStat {
  bytes: number
  count: number
}

export interface ThumbStats {
  totalBytes: number
  fileCount: number
  budgetBytes: number
  overBudget: boolean
  bySize: Record<ThumbSize, SizeStat>
}

export interface SweepResult {
  ran: boolean
  skippedReason?: 'busy' | 'throttled' | 'under-budget'
  beforeBytes: number
  afterBytes: number
  deletedFiles: number
  freedBytes: number
  elapsedMs: number
}

export interface AerieApi {
  library: {
    open(path: string): Promise<Library>
    create(opts: LibraryCreateOptions): Promise<Library>
    close(): Promise<void>
    current(): Promise<Library | null>
    recent(): Promise<{ path: string; name: string; openedAt: number }[]>
    stats(): Promise<LibraryStats>
    extStats(): Promise<{ ext: string; count: number }[]>
  }
  items: {
    /** 按行号定位（滚动条拖拽），返回该位置前一行的游标 */
    seek: (opts: QueryOptions, row: number) => Promise<Cursor | null>
    query(opts: QueryOptions): Promise<QueryResult>
    get(id: string): Promise<ItemDetail | null>
    update(id: string, patch: Partial<Pick<Item, 'name' | 'annotation' | 'star' | 'url'>>): Promise<void>
    updateMany(ids: string[], patch: Partial<Pick<Item, 'star'>>): Promise<void>
    /** 移入回收站。不碰原文件。 */
    trash(ids: string[]): Promise<number>
    restore(ids: string[]): Promise<number>
    /** 从索引里彻底删掉（仍不删原文件），并清掉缩略图 */
    purge(ids: string[]): Promise<number>
    emptyTrash(): Promise<number>
    /**
     * 按模板重命名。template 支持 {name} {ext} {index} {index:3}。
     * renameFiles 为 true 时同时改磁盘上的文件名。
     */
    renameBatch(ids: string[], template: string, start: number, renameFiles: boolean): Promise<RenameResult>
    /** 在某个文件夹内把 itemIds 挪到 beforeId 之前。beforeId 为空则放到末尾。 */
    reorder(folderId: string, itemIds: string[], beforeId: string | null): Promise<void>
    similar(maxDistance?: number): Promise<SimilarScan>
    open(id: string): Promise<void>
    copyPaths(ids: string[]): Promise<void>
    export(ids: string[], destDir: string): Promise<ExportResult>
    /** 读这条素材上的标注。列表查询不带它，避免把大段 JSON 送进网格。 */
    annotations(id: string): Promise<Annotation[]>
    /** 保存并返回收进 0–1 之后的结果，界面用它替换本地草稿。 */
    setAnnotations(id: string, annotations: Annotation[]): Promise<Annotation[]>
    /** 重新检查原文件还在不在。 */
    refreshPresence(): Promise<PresenceScan>
    /** 把一条丢失的素材指到新的文件。 */
    relink(id: string, filePath: string): Promise<void>
    /** 在文件夹里按文件名把丢失的原文件接回来。 */
    relinkFolder(dir: string): Promise<RelinkFolderResult>
  }
  smartFolders: {
    list(): Promise<SmartFolder[]>
    create(name: string, rules: SmartFolderRules): Promise<SmartFolder>
    rename(id: string, name: string): Promise<void>
    delete(id: string): Promise<void>
  }
  watch: {
    list(): Promise<WatchFolder[]>
    add(dir: string): Promise<WatchFolder>
    remove(id: string): Promise<void>
  }
  ocr: {
    status(): Promise<OcrStatus>
  }
  ingest: {
    info(): Promise<IngestInfo>
    regenerate(): Promise<IngestInfo>
    /** 扩展收藏成功后刷新网格 */
    onSaved(cb: () => void): () => void
  }
  tags: {
    list(): Promise<Tag[]>
    create(name: string, parentId?: string | null): Promise<Tag>
    rename(id: string, name: string): Promise<void>
    delete(id: string): Promise<void>
    setColor(id: string, color: string | null): Promise<void>
    assign(itemIds: string[], tagIds: string[]): Promise<void>
    unassign(itemIds: string[], tagIds: string[]): Promise<void>
  }
  folders: {
    list(): Promise<Folder[]>
    create(name: string, parentId?: string | null): Promise<Folder>
    rename(id: string, name: string): Promise<void>
    delete(id: string): Promise<void>
    setColor(id: string, color: string | null): Promise<void>
    assign(itemIds: string[], folderIds: string[]): Promise<void>
    unassign(itemIds: string[], folderIds: string[]): Promise<void>
    /** 用一条素材当文件夹封面 */
    setCover(folderId: string, itemId: string): Promise<void>
  }
  import: {
    start(req: ImportRequest): Promise<ImportResult>
    /** 把剪贴板里的图片或文件路径导入当前库 */
    paste(): Promise<ImportResult>
    onProgress(cb: (p: ImportProgress) => void): () => void
  }
  thumb: {
    /** 返回可直接放进 <img src> 的 data URL 或 file:// URL */
    get(itemId: string, size: ThumbSize): Promise<string | null>
  }
  thumbs: {
    /** 当前缩略图占用与预算 */
    stats(): Promise<ThumbStats>
    /** 按 LRU 淘汰到预算以内。force 跳过节流。 */
    sweep(force?: boolean): Promise<SweepResult>
  }
  files: {
    /**
     * 取拖进来的 File 对应的真实路径。
     *
     * Electron 32 起 File.path 被移除，必须走 webUtils.getPathForFile。
     * 没有它就没法知道用户拖的是哪个文件夹。
     */
    pathFor(file: File): string
  }
  dialog: {
    pickFiles(): Promise<string[]>
    pickFolder(): Promise<string | null>
    pickNewLibrary(title?: string): Promise<string | null>
    pickExportFolder(): Promise<string | null>
  }
  shell: {
    reveal(path: string): Promise<void>
  }
  menu: {
    onCommand(cb: (command: MenuCommand, arg?: string) => void): () => void
  }
  window: {
    onFullscreen(cb: (fullscreen: boolean) => void): () => void
  }
  edit: {
    /** 贴进当前聚焦的文字框，不导入素材 */
    paste(): Promise<void>
    /** 文字框里的系统撤销 */
    undo(): Promise<void>
  }
  undo: {
    /** 撤回最近一次回收站、评分、文件夹或标签操作。没有可撤回的步骤时返回 null */
    perform(): Promise<string | null>
  }
}

export type ThumbSize = 'sm' | 'md' | 'lg'

/** 本地收藏服务的状态。只监听 127.0.0.1，token 在库里随机生成。 */
export interface IngestInfo {
  listening: boolean
  host: '127.0.0.1'
  port: number | null
  token: string
  error: string | null
}

/**
 * 画面文字识别是否可用。
 * macOS 上用系统 Vision；其它系统或 swift 跑不起来时 available 为 false，
 * reason 直接给界面显示，导入不会因此失败。
 */
export interface OcrStatus {
  available: boolean
  reason: string | null
  /** 还没识别的光栅图数量 */
  pending: number
}
