/**
 * 查询层
 *
 * 性能是这类产品的生死线。三条关键设计：
 *
 * 1. **分页查询，永不 SELECT 全表**
 *    网格是虚拟滚动的，一次只要 limit 条。
 *
 * 2. **search 走 FTS5，短词走 LIKE**
 *    trigram 分词器要求查询串 ≥3 字符。1-2 字的中文查询退回 LIKE，
 *    在几万条规模下 LIKE 扫描也只有几毫秒。
 *
 * 3. **文件夹过滤用 WITH RECURSIVE 一次查完**
 *    避免在 JS 里递归查子文件夹，那是 N+1 查询。
 */
import type { DB } from '../db/index.js'
import type {
  Cursor,
  Folder,
  HueId,
  Item,
  ItemDetail,
  LibraryStats,
  QueryOptions,
  QueryResult,
  SortField,
  Tag,
} from '../../shared/types.js'

const SORT_COLUMNS: Record<Exclude<SortField, 'manual'>, string> = {
  addedAt: 'i.added_at',
  name: 'i.name COLLATE NOCASE',
  fileSize: 'i.file_size',
  mtime: 'i.mtime',
  star: 'i.star',
  takenAt: 'IFNULL(i.taken_at, 0)',
}

interface ItemRow {
  id: string
  name: string
  ext: string
  file_path: string
  file_size: number
  width: number | null
  height: number | null
  mtime: number
  added_at: number
  annotation: string | null
  url: string | null
  star: number
  phash: string | null
  has_thumb: number
  deleted_at: number | null
  palette: string | null
  hue: string | null
  missing: number
  taken_at: number | null
}

function toItem(r: ItemRow): Item {
  return {
    id: r.id,
    name: r.name,
    ext: r.ext,
    filePath: r.file_path,
    fileSize: r.file_size,
    width: r.width,
    height: r.height,
    mtime: r.mtime,
    addedAt: r.added_at,
    annotation: r.annotation,
    url: r.url,
    star: r.star,
    phash: r.phash,
    hasThumb: r.has_thumb === 1,
    deletedAt: r.deleted_at,
    palette: parsePalette(r.palette),
    hue: (r.hue as HueId | null) ?? null,
    missing: r.missing === 1,
    takenAt: r.taken_at != null && r.taken_at > 0 ? r.taken_at : null,
  }
}

function parsePalette(raw: string | null): string[] {
  if (!raw) return []
  return raw.split(',').filter((part) => /^[0-9a-f]{6}$/i.test(part))
}

/**
 * 查询和 seek 共用同一套过滤，避免滚动条跳转和网格内容对不上。
 * 返回 false 表示条件必然为空（比如文件夹已经被删掉）。
 */
function pushFilters(
  db: DB,
  opts: QueryOptions,
  where: string[],
  params: Record<string, unknown>,
): boolean {
  const scope = opts.scope ?? 'active'
  if (scope === 'trash') where.push(`i.deleted_at IS NOT NULL`)
  else where.push(`i.deleted_at IS NULL`)

  if (scope === 'uncategorized') {
    where.push(`NOT EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = i.id)`)
  } else if (scope === 'untagged') {
    where.push(`NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)`)
  } else if (scope === 'starred') {
    where.push(`i.star > 0`)
  } else if (scope === 'duplicates') {
    where.push(`i.phash IS NOT NULL AND i.phash IN (
      SELECT phash FROM items
      WHERE deleted_at IS NULL AND phash IS NOT NULL
      GROUP BY phash HAVING COUNT(*) > 1
    )`)
  } else if (scope === 'missing') {
    where.push(`i.missing = 1`)
  }

  if (opts.hue) {
    where.push(`i.hue = @hue`)
    params.hue = opts.hue
  }

  // 差在长边 2% 以内算方形，避免 1000×1002 这种被算成横图。
  if (opts.orientation === 'square') {
    where.push(
      `i.width > 0 AND i.height > 0 AND ABS(i.width - i.height) * 50 <= MAX(i.width, i.height)`,
    )
  } else if (opts.orientation === 'landscape' || opts.orientation === 'portrait') {
    const longer = opts.orientation === 'landscape' ? `i.width > i.height` : `i.height > i.width`
    where.push(
      `i.width > 0 AND i.height > 0 AND ${longer} AND ABS(i.width - i.height) * 50 > MAX(i.width, i.height)`,
    )
  }

  const search = opts.search?.trim()
  if (search) {
    if (search.length >= 3) {
      // 名字/备注在 items_fts，画面文字在独立的 items_ocr_fts。两路取并集。
      where.push(`(
        i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH @fts)
        OR i.id IN (SELECT item_id FROM items_ocr_fts WHERE items_ocr_fts MATCH @fts)
      )`)
      params.fts = `"${search.replace(/"/g, '""')}"`
    } else {
      where.push(
        `(i.name LIKE @like ESCAPE '\\' OR IFNULL(i.annotation,'') LIKE @like ESCAPE '\\' OR IFNULL(i.ocr_text,'') LIKE @like ESCAPE '\\')`,
      )
      params.like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    }
  }

  if (opts.tagIds?.length) {
    opts.tagIds.forEach((tagId, idx) => {
      where.push(`i.id IN (SELECT item_id FROM item_tags WHERE tag_id = @tag${idx})`)
      params[`tag${idx}`] = tagId
    })
  }

  if (opts.exts?.length) {
    const keys = opts.exts.map((_, i) => `@e${i}`).join(', ')
    opts.exts.forEach((e, i) => (params[`e${i}`] = e.toLowerCase()))
    where.push(`i.ext IN (${keys})`)
  }

  if (typeof opts.minStar === 'number' && opts.minStar > 0) {
    where.push(`i.star >= @minStar`)
    params.minStar = opts.minStar
  }

  // 和 scope 的「未分类 / 未标签」是同一句 SQL。
  // 分开写是为了智能文件夹能同时要求两者，scope 那几项做不到叠加。
  if (opts.uncategorized && scope !== 'uncategorized') {
    where.push(`NOT EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = i.id)`)
  }
  if (opts.untagged && scope !== 'untagged') {
    where.push(`NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)`)
  }

  if (typeof opts.minSize === 'number' && Number.isFinite(opts.minSize)) {
    where.push(`i.file_size >= @minSize`)
    params.minSize = Math.max(0, Math.floor(opts.minSize))
  }
  if (typeof opts.maxSize === 'number' && Number.isFinite(opts.maxSize)) {
    where.push(`i.file_size <= @maxSize`)
    params.maxSize = Math.max(0, Math.floor(opts.maxSize))
  }
  if (typeof opts.addedFrom === 'number' && Number.isFinite(opts.addedFrom)) {
    where.push(`i.added_at >= @addedFrom`)
    params.addedFrom = opts.addedFrom
  }
  if (typeof opts.addedTo === 'number' && Number.isFinite(opts.addedTo)) {
    where.push(`i.added_at <= @addedTo`)
    params.addedTo = opts.addedTo
  }
  if (typeof opts.takenFrom === 'number' && Number.isFinite(opts.takenFrom)) {
    where.push(`i.taken_at >= @takenFrom AND i.taken_at > 0`)
    params.takenFrom = opts.takenFrom
  }
  if (typeof opts.takenTo === 'number' && Number.isFinite(opts.takenTo)) {
    where.push(`i.taken_at <= @takenTo AND i.taken_at > 0`)
    params.takenTo = opts.takenTo
  }

  if (opts.folderId) {
    const ids = folderSubtree(db, opts.folderId)
    if (ids.length === 0) return false
    const keys = ids.map((_, i) => `@f${i}`).join(', ')
    ids.forEach((id, i) => (params[`f${i}`] = id))
    where.push(`i.id IN (SELECT item_id FROM item_folders WHERE folder_id IN (${keys}))`)
  }

  return true
}

/** 递归取某个文件夹及其所有子文件夹的 id */
function folderSubtree(db: DB, folderId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM folders WHERE id = ?
         UNION ALL
         SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
       )
       SELECT id FROM sub`,
    )
    .all(folderId) as { id: string }[]
  return rows.map((r) => r.id)
}

/**
 * 按百分比定位（滚动条拖拽用）。
 *
 * 原理：SQLite 的 OFFSET 慢，是因为要取「整行」（i.*）——每跳过一行都要回表。
 * 但如果只取排序键（sortCol, id），整个查询可以走覆盖索引，
 * 纯索引扫描跳过 N 条只需几毫秒：
 *
 *   SELECT added_at, id FROM items ORDER BY added_at DESC, id DESC LIMIT 1 OFFSET 900000
 *   → 覆盖索引，实测 1M 条时 6.6ms
 *
 * 拿到游标后，真正的分页用 cursor 走索引定位（0.5ms）。
 * 对比：直接 `SELECT * ... OFFSET 900000` 是 514ms，慢 78 倍。
 *
 * 前提是存在 (sortCol, id) 复合索引。只给最常用的 addedAt / name 建了，
 * 其它排序返回 null，UI 退回普通 offset（那些排序本身也快）。
 */
export function seekToPercent(db: DB, opts: QueryOptions, percent: number): Cursor | null {
  const total = countForSeek(db, opts)
  if (total === 0) return null
  const clamped = Math.max(0, Math.min(1, percent))
  return seekToRow(db, opts, Math.floor(clamped * total))
}

/**
 * 按「第几行」定位。
 *
 * 为什么不直接用百分比：百分比要来回乘除，浮点在边界上会漂 1 行
 * （438/634*634 未必正好是 438），用户看到的就是差一行。
 * 滚动条本来就是按行对齐的，直接把整数行号传进来最稳。
 */
export function seekToRow(db: DB, opts: QueryOptions, row: number): Cursor | null {
  const sortField = (opts.sort ?? 'addedAt') as SortField
  // 手动排序没有覆盖索引，大库里跳转退回 offset。文件夹通常远小于整库。
  if (sortField === 'manual' || !SEEK_INDEXED.has(sortField)) return null

  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (!pushFilters(db, opts, where, params)) return null

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM items i ${whereSql}`).get(params) as { n: number }
  ).n
  if (total === 0) return null

  const targetRow = Math.max(0, Math.min(row, total - 1))
  if (targetRow === 0) return null // 从头开始，不需要游标

  const sortCol = SORT_COLUMNS[sortField] ?? SORT_COLUMNS.addedAt
  const order = opts.order === 'asc' ? 'ASC' : 'DESC'

  // 取目标行的「前一行」作为游标。
  //
  // 游标语义是「严格在这个位置之后」((sortCol,id) < (curKey,curId))，
  // 若把目标行本身当游标，下一页会从 targetRow+1 开始，少一条。
  // 取前一行，下一页正好从 targetRow 开始。
  const off = targetRow - 1

  // 只选排序键 → 覆盖索引 → 纯索引扫描，不回表
  const hit = db
    .prepare(
      `SELECT ${sortCol} AS sortKey, i.id AS id FROM items i ${whereSql}
       ORDER BY ${sortCol} ${order}, i.id ${order}
       LIMIT 1 OFFSET @off`,
    )
    .get({ ...params, off }) as { sortKey: number | string; id: string } | undefined

  if (!hit) return null
  return { key: hit.sortKey, id: hit.id }
}

/** 按当前过滤条件统计总数（seek 用） */
function countForSeek(db: DB, opts: QueryOptions): number {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (!pushFilters(db, opts, where, params)) return 0
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return (db.prepare(`SELECT COUNT(*) AS n FROM items i ${whereSql}`).get(params) as { n: number }).n
}

/** 有 (sortCol, id) 复合索引的排序字段，可以做覆盖索引 seek */
const SEEK_INDEXED = new Set<SortField>(['addedAt', 'name', 'fileSize', 'mtime', 'star'])

/**
 * 列表只取网格用得到的列。
 *
 * 不选 ocr_text / annotations：识别文本和标注可能很长，
 * 小库模式会把十万条一次送过 IPC，这两列不该跟着走。
 */
const ITEM_FIELDS = `
  i.id, i.name, i.ext, i.file_path, i.file_size, i.width, i.height,
  i.mtime, i.added_at, i.annotation, i.url, i.star, i.phash, i.has_thumb,
  i.deleted_at, i.palette, i.hue, i.missing, i.taken_at`

export function queryItems(db: DB, opts: QueryOptions): QueryResult {
  const started = performance.now()

  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (!pushFilters(db, opts, where, params)) {
    return { items: [], total: 0, elapsedMs: performance.now() - started, nextCursor: null }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM items i ${whereSql}`).get(params) as { n: number }
  ).n

  const sortField = (opts.sort ?? 'addedAt') as SortField
  const manual = sortField === 'manual' && !!opts.folderId
  const fromSql = manual
    ? `items i LEFT JOIN item_folders ord ON ord.item_id = i.id AND ord.folder_id = @ordFolder`
    : `items i`
  if (manual) params.ordFolder = opts.folderId

  const sortCol = manual
    ? 'IFNULL(ord.sort_index, 0)'
    : (SORT_COLUMNS[sortField as Exclude<SortField, 'manual'>] ?? SORT_COLUMNS.addedAt)
  const order = opts.order === 'asc' ? 'ASC' : 'DESC'
  // 上限放到 10 万：小库模式需要一次把全部条目读进渲染进程。
  // 这不是「分页大小」，是「全量加载」的上界，与渲染端 FULL_LOAD_LIMIT 对齐。
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 100_000)

  // ── 分页：优先游标，其次 offset ──
  //
  // 游标分页的 SQL 形式：
  //   WHERE (sortKey, id) > (cursorKey, cursorId)   -- 升序
  //   WHERE (sortKey, id) < (cursorKey, cursorId)   -- 降序
  //
  // 用元组比较而不是 `key > c AND id > cid`，
  // 后者在 key 相等时会漏数据（正确写法是 key > c OR (key = c AND id > cid)）。
  // SQLite 支持行值比较，直接写元组即可。
  // 手动排序的键在关联表上，游标元组对不上 items 的覆盖索引，退回 offset
  const useCursor = !manual && opts.cursor !== undefined && opts.cursor !== null
  let cursorSql = ''
  if (useCursor && opts.cursor) {
    const cmp = order === 'ASC' ? '>' : '<'
    // 元组比较，决胜用 id（配合 (sortcol, id) 覆盖索引，纯索引定位）
    cursorSql = `AND (${sortCol}, i.id) ${cmp} (@curKey, @curId)`
    params.curKey = opts.cursor.key
    params.curId = opts.cursor.id
  }

  const whereAll = where.length
    ? `WHERE ${where.join(' AND ')} ${cursorSql}`
    : cursorSql
      ? `WHERE 1=1 ${cursorSql}`
      : ''

  // 游标分页时不需要 offset
  const offset = useCursor ? 0 : Math.max(opts.offset ?? 0, 0)

  // 总是多取一条，用来判断「还有没有下一页」。
  // 注意：不能用 page.length === limit 判断——正好取满时也会误判成有下一页。
  const rows = db
    .prepare(
      `SELECT ${ITEM_FIELDS} FROM ${fromSql} ${whereAll}
       ORDER BY ${sortCol} ${order}, i.id ${order}
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: limit + 1, offset }) as ItemRow[]

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  let nextCursor: Cursor | null = null
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]
    nextCursor = { key: cursorKeyOf(last, sortField), id: last.id }
  }

  return {
    items: page.map(toItem),
    total,
    elapsedMs: performance.now() - started,
    nextCursor,
  }
}

/** 从一行里取出排序键的值，用于生成游标 */
function cursorKeyOf(r: ItemRow, field: SortField): number | string {
  switch (field) {
    case 'name':
      return r.name
    case 'fileSize':
      return r.file_size
    case 'mtime':
      return r.mtime
    case 'star':
      return r.star
    case 'takenAt':
      return r.taken_at ?? 0
    case 'manual':
    case 'addedAt':
    default:
      return r.added_at
  }
}

export function getItemDetail(db: DB, id: string): ItemDetail | null {
  const row = db.prepare(`SELECT ${ITEM_FIELDS} FROM items i WHERE i.id = ?`).get(id) as
    | ItemRow
    | undefined
  if (!row) return null

  // 检视器只要「挂在这条上的标签/文件夹」，不需要全局 count。
  // 去掉相关 COUNT，方向键连按时少做很多聚合。
  const tags = db
    .prepare(
      `SELECT t.id, t.name, t.color, t.parent_id AS parentId, 0 AS count
       FROM tags t JOIN item_tags it ON it.tag_id = t.id
       WHERE it.item_id = ? ORDER BY t.name COLLATE NOCASE`,
    )
    .all(id) as Tag[]

  const folders = db
    .prepare(
      `SELECT f.id, f.name, f.color, f.parent_id AS parentId, 0 AS count,
              f.cover_item_id AS coverItemId
       FROM folders f JOIN item_folders it ON it.folder_id = f.id
       WHERE it.item_id = ? ORDER BY f.name COLLATE NOCASE`,
    )
    .all(id) as Folder[]

  return { ...toItem(row), tags, folders }
}

export function listTags(db: DB): Tag[] {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color, t.parent_id AS parentId,
              (SELECT COUNT(*) FROM item_tags it
                 JOIN items i ON i.id = it.item_id
                WHERE it.tag_id = t.id AND i.deleted_at IS NULL) AS count
       FROM tags t
       ORDER BY t.name COLLATE NOCASE`,
    )
    .all() as Tag[]
}

export function listFolders(db: DB): Folder[] {
  return db
    .prepare(
      `SELECT f.id, f.name, f.color, f.parent_id AS parentId,
              (SELECT COUNT(*) FROM item_folders it
                 JOIN items i ON i.id = it.item_id
                WHERE it.folder_id = f.id AND i.deleted_at IS NULL) AS count,
              CASE
                WHEN f.cover_item_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM items c
                  WHERE c.id = f.cover_item_id AND c.deleted_at IS NULL
                ) THEN f.cover_item_id
                ELSE (
                  SELECT jf.item_id FROM item_folders jf
                  JOIN items i ON i.id = jf.item_id
                  WHERE jf.folder_id = f.id AND i.deleted_at IS NULL
                  ORDER BY jf.sort_index ASC, i.added_at DESC
                  LIMIT 1
                )
              END AS coverItemId
       FROM folders f
       ORDER BY f.name COLLATE NOCASE`,
    )
    .all() as Folder[]
}

/** 扩展名分布，用于侧栏「类型」筛选 */
export function extStats(db: DB): { ext: string; count: number }[] {
  return db
    .prepare(
      `SELECT ext, COUNT(*) AS count FROM items
       WHERE deleted_at IS NULL
       GROUP BY ext ORDER BY count DESC`,
    )
    .all() as { ext: string; count: number }[]
}

export function libraryStats(db: DB): LibraryStats {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
  return {
    active: one(`SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL`),
    trash: one(`SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NOT NULL`),
    uncategorized: one(
      `SELECT COUNT(*) AS n FROM items i
       WHERE i.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = i.id)`,
    ),
    untagged: one(
      `SELECT COUNT(*) AS n FROM items i
       WHERE i.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)`,
    ),
    starred: one(`SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND star > 0`),
    duplicates: one(
      `SELECT COUNT(*) AS n FROM items
       WHERE deleted_at IS NULL AND phash IS NOT NULL AND phash IN (
         SELECT phash FROM items
         WHERE deleted_at IS NULL AND phash IS NOT NULL
         GROUP BY phash HAVING COUNT(*) > 1
       )`,
    ),
    missing: one(`SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL AND missing = 1`),
  }
}
