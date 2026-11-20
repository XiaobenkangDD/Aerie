/**
 * 导入器
 *
 * 流程：扫描 → 落库 → 后台生成缩略图
 *
 * 设计要点：
 * - 落库用事务批量插入，几千个文件也不会一条条刷盘
 * - file_path 有唯一索引，重复导入自动跳过，不会产生副本
 * - 缩略图在落库之后异步生成，用户不用等全部跑完就能看到网格
 */
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '../db/uuid.js'
import type { DB } from '../db/index.js'
import type { ImportProgress, ImportResult, ImportRequest, StorageMode } from '../../shared/types.js'
import { ensureThumb, thumbQueue, SIZES } from '../thumbs/pipeline.js'
import { describeRaster, isRasterExt } from '../analyze/raster.js'
import { isInside } from '../library/paths.js'

/**
 * 支持的扩展名。
 *
 * 这份清单参考了 Eagle 的 config.js，但去掉了纯工程格式（.blend/.dwg/.skp 之类
 * 在 QuickLook 下往往没有缩略图）。实际能不能出图由 QuickLook 决定，
 * 这里只是第一道过滤。
 */
export const SUPPORTED_EXTS = new Set([
  // 图片
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'gif', 'avif', 'bmp', 'ico', 'icns',
  'tif', 'tiff', 'heic', 'heif', 'jxl', 'svg', 'psd', 'psdt', 'psb', 'ai', 'ait', 'eps',
  'xd', 'sketch', 'fig', 'af', 'afdesign', 'afphoto', 'afpub', 'pxd', 'cdr', 'skt',
  'indd', 'indt', 'idml', 'graffle', 'xmind', 'mindnode', 'insp', 'insp', 'tga', 'dds',
  // RAW
  'arw', 'cr2', 'cr3', 'crw', 'dng', 'raf', 'rw2', 'orf', 'nef', 'nrw', 'raw',
  '3fr', 'erf', 'srw', 'sr2', 'pef', 'x3f', 'mrw', 'hif',
  // 文档
  'pdf', 'key', 'pages', 'numbers', 'ppt', 'pptx', 'potx', 'doc', 'docx',
  'xls', 'xlsx', 'txt', 'rtf', 'md', 'csv', 'html', 'mhtml', 'url',
  // 音频
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
  // 视频
  'mp4', 'mkv', 'mov', 'm4v', 'webm', 'avi', 'mts', 'wmv', 'flv', 'm2ts',
  'f4v', 'mpg', 'ts', '3gp',
  // 字体
  'ttf', 'otf', 'ttc', 'woff', 'woff2',
  // 3D
  'glb', 'gltf', 'fbx', 'obj', '3ds', '3mf', 'dae', 'ifc', 'ply', 'stl', 'hdr', 'exr',
])

export interface ImportContext {
  db: DB
  thumbsDir: string
  /** 库根目录。扫描时整段跳过，避免把缩略图和库内副本再导一遍。 */
  libraryRoot: string
  storageMode: StorageMode
  onProgress: (p: ImportProgress) => void
  /** 缩略图和指纹都写完之后。用来再启动画面识别，避免和缩略图抢 CPU。 */
  onSettled?: () => void
}

interface Candidate {
  id: string
  filePath: string
  sourcePath: string
  name: string
  ext: string
  size: number
  mtime: number
}

/** 复制模式的落点：按 id 分桶，避免几万个文件堆在同一个目录。 */
function copyDestination(libraryRoot: string, id: string, ext: string): string {
  return path.join(libraryRoot, 'files', id.slice(0, 2), `${id}.${ext}`)
}

/** 分批把已入库的 file_path / source_path 装进 Set，给扫描去重用。 */
function loadKnownPaths(db: DB, paths: string[]): Set<string> {
  const known = new Set<string>()
  const unique = [...new Set(paths.filter(Boolean))]
  const BATCH = 400
  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH)
    const placeholders = slice.map((_, j) => `@p${j}`).join(',')
    const params: Record<string, string> = {}
    for (let j = 0; j < slice.length; j++) params[`p${j}`] = slice[j]!
    const rows = db
      .prepare(
        `SELECT file_path AS p FROM items WHERE file_path IN (${placeholders})
         UNION
         SELECT source_path AS p FROM items WHERE source_path IN (${placeholders})`,
      )
      .all(params) as { p: string | null }[]
    for (const row of rows) if (row.p) known.add(row.p)
  }
  return known
}

/** 扫描路径，收集所有可导入文件 */
function scan(paths: string[], recursive: boolean, libraryRoot: string): Omit<Candidate, 'id'>[] {
  const out: Omit<Candidate, 'id'>[] = []
  const seen = new Set<string>()
  // 用户点名要导入的路径，哪怕在库里面（浏览器收藏的 inbox）也要收。
  // 扫到旁边的 .aerie 则整段跳过，避免把缩略图再导一遍。
  const explicit = new Set(paths.map((p) => path.resolve(p)))

  const visit = (p: string): void => {
    let st: fs.Stats
    try {
      st = fs.statSync(p)
    } catch {
      return
    }

    if (st.isDirectory()) {
      if (!recursive) return
      const absDir = path.resolve(p)
      if (!explicit.has(absDir) && (isInside(absDir, libraryRoot) || path.basename(absDir).endsWith('.aerie'))) {
        return
      }
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        // 跳过隐藏文件和 macOS 的元数据
        if (e.name.startsWith('.')) continue
        if (e.name === 'node_modules') continue
        visit(path.join(p, e.name))
      }
      return
    }

    if (!st.isFile()) return
    if (st.size === 0) return

    const ext = path.extname(p).slice(1).toLowerCase()
    if (!SUPPORTED_EXTS.has(ext)) return

    const abs = path.resolve(p)
    if (seen.has(abs)) return
    seen.add(abs)

    out.push({
      filePath: abs,
      sourcePath: abs,
      name: path.basename(p, path.extname(p)),
      ext,
      size: st.size,
      mtime: Math.floor(st.mtimeMs),
    })
  }

  for (const p of paths) visit(p)
  return out
}

/**
 * 执行导入。
 * 返回时数据库已经写完，但缩略图还在后台跑。
 */
export async function runImport(
  req: ImportRequest,
  ctx: ImportContext,
): Promise<ImportResult> {
  const { db, thumbsDir, onProgress, libraryRoot, storageMode } = ctx

  onProgress({ done: 0, total: 0, current: '', phase: 'scanning' })

  const found = scan(req.paths, req.recursive, libraryRoot)
  const total = found.length

  if (total === 0) {
    onProgress({ done: 0, total: 0, current: '', phase: 'done' })
    return { imported: 0, skipped: 0, failed: 0, errors: [] }
  }

  // 批量查已入库路径，避免「每个文件一次 SELECT」。
  // file_path / source_path 都有索引；分批 IN 比逐条 OR 查询稳得多。
  const knownPaths = loadKnownPaths(
    db,
    found.flatMap((c) => [c.filePath, c.sourcePath]),
  )
  const insert = db.prepare(`
    INSERT INTO items (id, name, ext, file_path, source_path, file_size, width, height, mtime, added_at, star, has_thumb)
    VALUES (@id, @name, @ext, @filePath, @sourcePath, @fileSize, NULL, NULL, @mtime, @addedAt, 0, 0)
    ON CONFLICT(file_path) DO NOTHING
  `)

  let imported = 0
  let skipped = 0
  let failed = 0
  const insertedIds: { id: string; filePath: string; ext: string }[] = []
  const ready: Candidate[] = []

  for (let i = 0; i < found.length; i++) {
    const c = found[i]
    if (!c) continue
    if (knownPaths.has(c.filePath) || knownPaths.has(c.sourcePath)) {
      skipped++
      continue
    }
    const id = uuidv7()
    let filePath = c.filePath
    // 已经在库目录里的（比如浏览器收藏先落到 inbox）不再拷一份。
    if (storageMode === 'copy' && !isInside(c.filePath, libraryRoot)) {
      if (i % 8 === 0) {
        onProgress({ done: i, total, current: c.name, phase: 'copying' })
      }
      filePath = copyDestination(libraryRoot, id, c.ext)
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.copyFileSync(c.filePath, filePath)
      } catch {
        failed++
        continue
      }
    }
    ready.push({ ...c, id, filePath })
  }

  const insertMany = db.transaction((rows: Candidate[]) => {
    const now = Date.now()
    for (const c of rows) {
      try {
        const info = insert.run({
          id: c.id,
          name: c.name,
          ext: c.ext,
          filePath: c.filePath,
          sourcePath: c.sourcePath,
          fileSize: c.size,
          mtime: c.mtime,
          addedAt: now,
        })
        if (info.changes > 0) {
          imported++
          insertedIds.push({ id: c.id, filePath: c.filePath, ext: c.ext })
        } else {
          skipped++
          if (c.filePath !== c.sourcePath) fs.rmSync(c.filePath, { force: true })
        }
      } catch (err) {
        if (c.filePath !== c.sourcePath) fs.rmSync(c.filePath, { force: true })
        if (String(err).includes('UNIQUE')) {
          skipped++
          continue
        }
        failed++
      }
    }
  })

  onProgress({ done: 0, total: ready.length, current: '', phase: 'importing' })
  insertMany(ready)

  // 后台生成缩略图 + 读尺寸
  const setMeta = db.prepare(
    `UPDATE items SET width = ?, height = ?, has_thumb = ?, phash = ?, palette = ?, hue = ?, taken_at = ? WHERE id = ?`,
  )
  let done = 0
  // 目录只建一次，别在每张图的热路径上 mkdir
  fs.mkdirSync(path.join(thumbsDir, 'md'), { recursive: true })

  const jobs = insertedIds.map((it) =>
    thumbQueue.run(async () => {
      let width: number | null = null
      let height: number | null = null
      let hasThumb = 0
      let phash: string | null = null
      let palette: string | null = null
      let hue: string | null = null
      let taken = 0
      if (isRasterExt(it.ext)) {
        const thumbPath = path.join(thumbsDir, 'md', `${it.id}.webp`)
        const facts = await describeRaster(it.filePath, { thumbPath, thumbPx: SIZES.md })
        if (facts) {
          width = facts.width
          height = facts.height
          hasThumb = facts.thumbWritten ? 1 : 0
          phash = facts.fingerprint?.phash ?? null
          palette = facts.fingerprint?.palette ?? null
          hue = facts.fingerprint?.hue ?? null
          taken = facts.takenAt ?? 0
        }
        if (!hasThumb) {
          const res = await ensureThumb(thumbsDir, it.id, it.filePath, it.ext, 'md')
          hasThumb = res.ok ? 1 : 0
        }
      } else {
        const res = await ensureThumb(thumbsDir, it.id, it.filePath, it.ext, 'md')
        hasThumb = res.ok ? 1 : 0
      }
      try {
        setMeta.run(width, height, hasThumb, phash, palette, hue, taken, it.id)
      } catch {
        // 库可能已被关闭
      }
      done++
      if (done % 8 === 0 || done === insertedIds.length) {
        onProgress({
          done,
          total: insertedIds.length,
          current: path.basename(it.filePath),
          phase: 'thumbs',
        })
      }
    }),
  )

  // 落库后立刻返回，网格可以先出来。尺寸、缩略图、指纹在后台写。
  if (insertedIds.length === 0) {
    onProgress({ done: 0, total: 0, current: '', phase: 'done' })
    ctx.onSettled?.()
    return { imported, skipped, failed, errors: [] }
  }

  void Promise.allSettled(jobs).then(() => {
    onProgress({
      done: insertedIds.length,
      total: insertedIds.length,
      current: '',
      phase: 'done',
    })
    ctx.onSettled?.()
  })

  return { imported, skipped, failed, errors: [] }
}
