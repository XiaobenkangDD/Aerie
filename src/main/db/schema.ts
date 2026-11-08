/**
 * Aerie 库数据库结构（单一事实来源）
 *
 * 为什么是 .ts 而不是 .sql：
 * .sql 需要构建工具支持 ?raw 导入，Vite 可以但 esbuild / Node 不行。
 * 内联成模板字符串后，任何工具链都能直接用，测试脚本也不例外。
 */

export const SCHEMA_SQL = `-- Aerie 库数据库结构
--
-- 设计要点：
-- 1. WAL 模式：读写并发，缩略图生成时不阻塞 UI 查询
-- 2. FTS5 + trigram：中文可以子串搜索（unicode61 分词器切不开中文）
-- 3. 层级标签/文件夹：parent_id 自引用 + WITH RECURSIVE 查询
-- 4. 原图不入库：file_path 是引用，用户随时能在访达里找到

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ── 元信息（schema 版本等）────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 条目 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  ext        TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  file_size  INTEGER NOT NULL DEFAULT 0,
  width      INTEGER,
  height     INTEGER,
  mtime      INTEGER NOT NULL,
  added_at   INTEGER NOT NULL,
  annotation TEXT,
  url        TEXT,
  star       INTEGER NOT NULL DEFAULT 0,
  phash      TEXT,
  has_thumb  INTEGER NOT NULL DEFAULT 0,
  -- 移入回收站的时间。NULL 表示仍在库里。不删原文件。
  deleted_at INTEGER,
  -- 主色，逗号分隔的 RRGGBB（无 #）。导入后异步写入。
  palette    TEXT,
  -- 用于侧栏色块筛选的主色相，见 shared/image.ts
  hue        TEXT,
  -- 画面标注 JSON。坐标是相对原图的 0–1。老库靠迁移补列，这里只保证新库一开始就有。
  annotations TEXT,
  -- 画面文字。NULL = 还没识别，空串 = 识别过但没有字。不建索引，搜索走独立 FTS。
  ocr_text   TEXT,
  -- 1 = 上次检查时原文件已经不在记录的路径上。老库靠迁移补列。
  missing    INTEGER NOT NULL DEFAULT 0,
  -- 拍摄时间，毫秒。NULL = 还没读，0 = 读过但没有 EXIF。
  taken_at   INTEGER,
  -- 复制进库之前的原路径。引用模式和 file_path 相同。用来认出「这个文件已经拷过」。
  source_path TEXT
);

-- file_path 唯一：同一文件不会重复导入
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_path   ON items(file_path);
CREATE INDEX        IF NOT EXISTS idx_items_ext    ON items(ext);
CREATE INDEX        IF NOT EXISTS idx_items_added  ON items(added_at DESC);
CREATE INDEX        IF NOT EXISTS idx_items_name   ON items(name COLLATE NOCASE);
CREATE INDEX        IF NOT EXISTS idx_items_star   ON items(star);
CREATE INDEX        IF NOT EXISTS idx_items_phash  ON items(phash) WHERE phash IS NOT NULL;

-- 复合索引：游标分页专用。
--
-- 游标分页的 WHERE 是 (sortCol, id) > (key, id) 的元组比较，
-- 必须让 sortCol 和 id 在同一个索引里，SQLite 才能直接定位到起点，
-- 否则仍会全表扫描。这是压测里深翻页 936ms 的根因。
-- 复合索引 (sortCol, id)：给「滚动条拖到任意位置」用。
--
-- 为什么必须是复合的：seek 的查询是
--   SELECT <sortCol>, id FROM items ORDER BY <sortCol> DESC, id DESC LIMIT 1 OFFSET n
-- 只有 (sortCol, id) 复合索引能让它变成纯覆盖索引扫描（不回表、不临时排序）。
-- 实测 100 万条 offset 900k：
--   (added_at, id) 复合索引  → 6.6ms
--   (added_at) 单列 + rowid  → 117ms（触发 TEMP B-TREE 排 50 万行）
--   直接 SELECT *            → 514ms（每行都回表）
--
-- 代价：每个索引约 40 字节/行，5 个 = 200 字节/行，1M 条约 200MB。
-- 换来的是任意位置跳转都在 10ms 内，值。
CREATE INDEX IF NOT EXISTS idx_items_cursor_added ON items(added_at, id);
CREATE INDEX IF NOT EXISTS idx_items_cursor_name  ON items(name COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_items_cursor_size  ON items(file_size, id);
CREATE INDEX IF NOT EXISTS idx_items_cursor_mtime ON items(mtime, id);
CREATE INDEX IF NOT EXISTS idx_items_cursor_star  ON items(star, id);

-- ── 标签 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  color     TEXT,
  parent_id TEXT REFERENCES tags(id) ON DELETE CASCADE
);

-- 同一父级下标签名唯一。parent_id 为 NULL 时用空串占位，
-- 因为 SQLite 的 UNIQUE 把多个 NULL 视为互不相同。
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_unique
  ON tags(name COLLATE NOCASE, IFNULL(parent_id, ''));
CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);

-- ── 文件夹 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS folders (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  color          TEXT,
  parent_id      TEXT REFERENCES folders(id) ON DELETE CASCADE,
  -- 指定封面。空则用文件夹里排序最前的一张。老库由 ensureV6 补列。
  cover_item_id  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique
  ON folders(name COLLATE NOCASE, IFNULL(parent_id, ''));
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

-- ── 关联表 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);

CREATE TABLE IF NOT EXISTS item_folders (
  item_id    TEXT NOT NULL REFERENCES items(id)   ON DELETE CASCADE,
  folder_id  TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  -- 文件夹内的手动排序。拖拽重排时整段重写。
  sort_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, folder_id)
);
CREATE INDEX IF NOT EXISTS idx_item_folders_folder ON item_folders(folder_id);

-- ── 全文索引 ──────────────────────────────────────────────
-- trigram 分词器：中文按 3 字符滑窗建索引，支持子串匹配。
-- unicode61 会把整句中文当一个词，搜"长发"匹配不到"黑色长发"。
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  name,
  annotation,
  content     = 'items',
  content_rowid = 'rowid',
  tokenize    = 'trigram'
);

-- 保持 FTS 与主表同步
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, name, annotation)
  VALUES (new.rowid, new.name, IFNULL(new.annotation, ''));
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, name, annotation)
  VALUES ('delete', old.rowid, old.name, IFNULL(old.annotation, ''));
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF name, annotation ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, name, annotation)
  VALUES ('delete', old.rowid, old.name, IFNULL(old.annotation, ''));
  INSERT INTO items_fts(rowid, name, annotation)
  VALUES (new.rowid, new.name, IFNULL(new.annotation, ''));
END;

-- 智能文件夹。规则是 JSON，条件翻译成查询参数，不另写 SQL。
-- 这是新表，CREATE IF NOT EXISTS 对老库是安全的，不依赖 items 上后来才有的列。
-- 监视文件夹。只存绝对路径，变动后走普通导入。
CREATE TABLE IF NOT EXISTS watch_folders (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS smart_folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  rules      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 画面文字的全文索引。独立成表，是为了不改 items_fts 的列：
-- 外部内容表加列要整表重建，老库很容易迁坏。
CREATE VIRTUAL TABLE IF NOT EXISTS items_ocr_fts USING fts5(
  item_id UNINDEXED,
  ocr_text,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS items_ocr_ad AFTER DELETE ON items BEGIN
  DELETE FROM items_ocr_fts WHERE item_id = old.id;
END;
`
