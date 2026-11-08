/**
 * SQLite 连接与迁移
 *
 * 为什么用 better-sqlite3 而不是 node:sqlite：
 * 它是同步 API，主进程里读写不需要 await，代码简单且没有回调地狱；
 * 同时它是 Electron 生态里最成熟的选择，WAL + FTS5 都开箱可用。
 */
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from './schema.js'

export type DB = Database.Database

/** 当前 schema 版本。每次改表结构就 +1，并在 migrate() 里加一段升级逻辑。 */
export const SCHEMA_VERSION = 6

export function openDatabase(file: string): DB {
  const db = new Database(file)

  // WAL：读写并发。缩略图生成在写，UI 在查，不互相阻塞。
  db.pragma('journal_mode = WAL')
  // NORMAL：断电可能丢最后几个事务，但不会损坏库。比 FULL 快一个数量级。
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  // 5 秒锁等待，避免缩略图批量写入时 UI 查询直接报 SQLITE_BUSY
  db.pragma('busy_timeout = 5000')
  // 排序时给临时表多些内存
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -32000') // 32MB

  migrate(db)
  return db
}

function hasColumn(db: DB, table: string, name: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return cols.some((c) => c.name === name)
}

/**
 * v2：回收站、主色、文件夹内排序。
 *
 * 必须在读版本号之前跑，而且要幂等。
 * SCHEMA_SQL 里如果直接建「依赖新列」的索引，老库会在 ALTER 之前失败。
 * 所以新列和新索引都放在这里，CREATE TABLE 只保证全新库一开始就有这些列。
 *
 * 活数据用部分索引（WHERE deleted_at IS NULL）。
 * 否则「未删除」这个过滤条件会让 (added_at, id) 覆盖索引失效，
 * 百万条深翻页会从几毫秒退回到逐行回表。
 */
function ensureV2(db: DB): void {
  if (!hasColumn(db, 'items', 'deleted_at')) {
    db.exec(`ALTER TABLE items ADD COLUMN deleted_at INTEGER`)
  }
  if (!hasColumn(db, 'items', 'palette')) {
    db.exec(`ALTER TABLE items ADD COLUMN palette TEXT`)
  }
  if (!hasColumn(db, 'items', 'hue')) {
    db.exec(`ALTER TABLE items ADD COLUMN hue TEXT`)
  }
  if (!hasColumn(db, 'item_folders', 'sort_index')) {
    db.exec(`ALTER TABLE item_folders ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 0`)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_items_live_added ON items(added_at, id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_items_live_name  ON items(name COLLATE NOCASE, id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_items_live_size  ON items(file_size, id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_items_live_mtime ON items(mtime, id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_items_live_star  ON items(star, id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_items_trashed    ON items(deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_items_hue_live   ON items(hue) WHERE hue IS NOT NULL AND deleted_at IS NULL;
  `)
}

/**
 * v3：智能文件夹、画面标注、画面文字。
 *
 * annotations / ocr_text 是老表上的新列，不能在 SCHEMA_SQL 里给它们建索引——
 * 老库执行 CREATE TABLE IF NOT EXISTS 时不会补列，索引会在 ALTER 之前失败。
 * 这两列本身也不需要索引：标注只按 id 取，文字搜索走独立的 items_ocr_fts。
 */
function ensureV3(db: DB): void {
  if (!hasColumn(db, 'items', 'annotations')) {
    db.exec(`ALTER TABLE items ADD COLUMN annotations TEXT`)
  }
  if (!hasColumn(db, 'items', 'ocr_text')) {
    db.exec(`ALTER TABLE items ADD COLUMN ocr_text TEXT`)
  }
}

/**
 * v4：原文件是否还在、拍摄时间。
 * 索引放在补列之后。SCHEMA_SQL 里提前建索引，老库会在 ALTER 之前失败。
 */
function ensureV4(db: DB): void {
  if (!hasColumn(db, 'items', 'missing')) {
    db.exec(`ALTER TABLE items ADD COLUMN missing INTEGER NOT NULL DEFAULT 0`)
  }
  if (!hasColumn(db, 'items', 'taken_at')) {
    db.exec(`ALTER TABLE items ADD COLUMN taken_at INTEGER`)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_items_missing ON items(id) WHERE missing = 1 AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_items_taken ON items(taken_at, id) WHERE taken_at IS NOT NULL AND deleted_at IS NULL;
  `)
}

/** v5：复制模式记住原路径。索引放在补列之后，避免老库在 ALTER 之前建索引失败。 */
function ensureV5(db: DB): void {
  if (!hasColumn(db, 'items', 'source_path')) {
    db.exec(`ALTER TABLE items ADD COLUMN source_path TEXT`)
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source ON items(source_path) WHERE source_path IS NOT NULL;
  `)
}

/** v6：文件夹封面。只补列，不建索引。 */
function ensureV6(db: DB): void {
  if (!hasColumn(db, 'folders', 'cover_item_id')) {
    db.exec(`ALTER TABLE folders ADD COLUMN cover_item_id TEXT`)
  }
}

function migrate(db: DB): void {
  db.exec(SCHEMA_SQL)
  ensureV2(db)
  ensureV3(db)
  ensureV4(db)
  ensureV5(db)
  ensureV6(db)

  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined

  const current = row ? Number(row.value) : 0

  if (current === 0) {
    // 全新库
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    )
    return
  }

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `库版本 ${current} 高于当前程序支持的 ${SCHEMA_VERSION}，请升级影巢后再打开。`,
    )
  }

  // 未来版本升级逻辑写在这里：
  // if (current < 2) { db.exec(`ALTER TABLE ...`); }
  if (current < SCHEMA_VERSION) {
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(
      String(SCHEMA_VERSION),
    )
  }
}

/** 关闭前做一次 checkpoint，把 WAL 合并回主库，避免残留 -wal 文件。 */
export function closeDatabase(db: DB): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // 关闭阶段失败不该阻塞退出
  }
  db.close()
}

/** 快速健康检查 */
export function checkIntegrity(db: DB): string {
  const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
  return rows.map((r) => r.integrity_check).join('; ')
}
