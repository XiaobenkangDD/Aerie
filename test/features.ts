/**
 * 不依赖真实照片库的功能测试：回收站、筛选、重命名、排序、指纹。
 *
 * 跑法：npm run test:features
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { openDatabase, closeDatabase, SCHEMA_VERSION } from '../src/main/db/index.js'
import { libraryStats, listFolders, queryItemIds, queryItems, seekToRow } from '../src/main/library/query.js'
import {
  assignFolders,
  assignTags,
  createFolder,
  createTag,
  renameItems,
  reorderInFolder,
  restoreItems,
  setFolderCover,
  trashItems,
} from '../src/main/library/mutate.js'
import { createSmartFolder, deleteSmartFolder, renameSmartFolder } from '../src/main/library/smart.js'
import { getAnnotations, setAnnotations } from '../src/main/library/annotations.js'
import { setOcrText } from '../src/main/library/ocr-index.js'
import { fingerprintFile } from '../src/main/analyze/fingerprint.js'
import { describeRaster } from '../src/main/analyze/raster.js'
import { clusterByHamming, dHashFromGray, hammingHex, hueFromRgb } from '../src/shared/image.js'
import { clearUndo, performUndo, rememberTrash } from '../src/main/library/undo.js'
import { renderNameTemplate } from '../src/shared/rename.js'
import { describeRules, normalizeRules, rulesToQuery } from '../src/shared/smart.js'
import { resolveLibraryRoot } from '../src/main/library/locate.js'
import { refreshPresence, relinkFolder } from '../src/main/library/presence.js'
import { parseExifDate, takenAtFromExif } from '../src/main/analyze/exif-date.js'
import { runImport } from '../src/main/importer/importer.js'
import { addWatchFolder, listWatchFolders, removeWatchFolder } from '../src/main/library/watch.js'

let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function insert(
  db: ReturnType<typeof openDatabase>,
  id: string,
  name: string,
  ext = 'png',
  extra: { size?: number; added?: number; star?: number; hue?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO items (id, name, ext, file_path, file_size, mtime, added_at, star, has_thumb, hue)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, ?)`,
  ).run(
    id,
    name,
    ext,
    `/tmp/${id}.${ext}`,
    extra.size ?? 10,
    extra.added ?? 1,
    extra.star ?? 0,
    extra.hue ?? null,
  )
}

async function main(): Promise<void> {
  console.log('\n[纯函数]')
  check('汉明距离相同为 0', hammingHex('0000000000000000', '0000000000000000') === 0)
  check('汉明距离一位', hammingHex('0000000000000000', '0000000000000001') === 1)
  check('纯红', hueFromRgb(220, 20, 20) === 'red')
  check('近白', hueFromRgb(250, 250, 250) === 'white')
  check(
    '重命名模板补零',
    renderNameTemplate('{name}-{index:3}', { name: '猫', ext: 'jpg', index: 4 }) === '猫-004',
  )

  const clustered = clusterByHamming(
    [
      { id: 'a', phash: 'ffffffffffffffff' },
      { id: 'b', phash: 'fffffffffffffffe' },
      { id: 'c', phash: '0000000000000000' },
    ],
    4,
  )
  check('近邻被分到一组', clustered.groups.length === 1 && clustered.groups[0].ids.length === 2)
  check('完全不同的不进组', !clustered.groups[0].ids.includes('c'))

  const photoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aerie-locate-'))
  const photos = path.join(photoRoot, '写真')
  const aerieDir = path.join(photos, '写真.aerie')
  const sub = path.join(photos, 'album')
  fs.mkdirSync(aerieDir, { recursive: true })
  fs.mkdirSync(sub)
  fs.writeFileSync(path.join(aerieDir, 'library.json'), '{}')
  check('选中照片目录会找到里面的库', resolveLibraryRoot(photos) === aerieDir)
  check('选中子文件夹会找到旁边的库', resolveLibraryRoot(sub) === aerieDir)
  check('直接选中库文件夹', resolveLibraryRoot(aerieDir) === aerieDir)
  fs.rmSync(photoRoot, { recursive: true, force: true })

  console.log('\n[数据库]')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aerie-features-'))
  const db = openDatabase(path.join(tmp, 'aerie.db'))
  insert(db, '11111111-1111-7111-8111-111111111111', '甲')
  insert(db, '22222222-2222-7222-8222-222222222222', '乙')
  insert(db, '33333333-3333-7333-8333-333333333333', '丙')
  const ids = [
    '11111111-1111-7111-8111-111111111111',
    '22222222-2222-7222-8222-222222222222',
    '33333333-3333-7333-8333-333333333333',
  ]

  check('默认不含回收站', queryItems(db, { limit: 10 }).total === 3)
  check('移入回收站', trashItems(db, [ids[0]]) === 1)
  check('活动列表少一项', queryItems(db, { limit: 10 }).total === 2)
  check('回收站里能看到', queryItems(db, { scope: 'trash', limit: 10 }).total === 1)
  check('还原', restoreItems(db, [ids[0]]) === 1)
  check('还原后回到列表', queryItems(db, { limit: 10 }).total === 3)

  db.prepare(`UPDATE items SET phash = ? WHERE id = ?`).run('aaaaaaaaaaaaaaaa', ids[0])
  db.prepare(`UPDATE items SET phash = ? WHERE id = ?`).run('aaaaaaaaaaaaaaaa', ids[1])
  check('重复项视图', queryItems(db, { scope: 'duplicates', limit: 10 }).total === 2)

  const folder = createFolder(db, '专辑')
  assignFolders(db, [ids[0], ids[2], ids[1]], [folder.id])
  reorderInFolder(db, folder.id, [ids[2]], ids[0])
  const ordered = queryItems(db, { folderId: folder.id, sort: 'manual', order: 'asc', limit: 10 })
  check(
    '拖拽后排到目标前面',
    ordered.items.map((item) => item.id).join() === [ids[2], ids[0], ids[1]].join(),
    ordered.items.map((item) => item.name).join(' '),
  )

  const renamed = renameItems(db, [ids[0]], '封面-{index}', 7, false)
  check('只改显示名', renamed.renamed === 1 && queryItems(db, { search: '封面-7', limit: 5 }).total === 1)

  console.log('\n[智能文件夹]')
  check('脚本还在', fs.existsSync(path.resolve('src/main/analyze/ocr.swift')))
  const cleaned = normalizeRules({ hue: 'nope', minStar: 9, keyword: '  海报  ', exts: ['.PNG', 'bad ext'] })
  check('规则会丢掉不合法的色相', cleaned.hue === undefined && cleaned.minStar === 5)
  check('扩展名去掉点并小写', cleaned.exts?.join() === 'png')
  const swapped = normalizeRules({ minSize: 8, maxSize: 2 })
  check('大小上下限写反时对调', swapped.minSize === 2 && swapped.maxSize === 8)

  const tag = createTag(db, '海报标签')
  const matchId = '44444444-4444-7444-8444-444444444444'
  const base = { size: 200, added: 2_000, star: 4, hue: 'red' }
  insert(db, matchId, '红色海报', 'png', base)
  insert(db, '55555555-5555-7555-8555-555555555555', '红色海报', 'png', { ...base, star: 1 })
  insert(db, '66666666-6666-7666-8666-666666666666', '红色海报', 'jpg', base)
  insert(db, '77777777-7777-7777-8777-777777777771', '红色海报', 'png', { ...base, size: 50 })
  insert(db, '77777777-7777-7777-8777-777777777772', '红色海报', 'png', { ...base, added: 100 })
  insert(db, '77777777-7777-7777-8777-777777777773', '红色海报', 'png', { ...base, hue: 'blue' })
  const inFolder = '77777777-7777-7777-8777-777777777774'
  const tagged = '77777777-7777-7777-8777-777777777775'
  insert(db, inFolder, '红色海报', 'png', base)
  insert(db, tagged, '红色海报', 'png', base)
  assignFolders(db, [inFolder], [folder.id])
  assignTags(db, [tagged], [tag.id])

  const rules = normalizeRules({
    exts: ['png'],
    minStar: 3,
    hue: 'red',
    keyword: '红色海报',
    uncategorized: true,
    untagged: true,
    minSize: 100,
    maxSize: 5_000,
    addedFrom: 1_000,
    addedTo: 9_000,
  })
  const smart = createSmartFolder(db, '精选海报', rules)
  const matched = queryItems(db, rulesToQuery(smart.rules, { limit: 20 }))
  check('组合规则只命中一张', matched.total === 1 && matched.items[0]?.id === matchId, `实际 ${matched.total}`)

  const byTag = queryItems(db, rulesToQuery({ ...rules, untagged: undefined, tagIds: [tag.id] }, { limit: 20 }))
  check('标签条件能命中', byTag.items.some((item) => item.id === tagged))

  renameSmartFolder(db, smart.id, '精选')
  const renamedSmart = db.prepare(`SELECT name FROM smart_folders WHERE id = ?`).get(smart.id) as { name: string }
  check('能改名', renamedSmart.name === '精选')
  deleteSmartFolder(db, smart.id)
  check('删除后列表里没有', !db.prepare('SELECT id FROM smart_folders WHERE id = ?').get(smart.id))

  const seekA = '88888888-8888-7888-8888-888888888881'
  const seekB = '88888888-8888-7888-8888-888888888882'
  insert(db, seekA, '排序甲', 'png', { size: 20, added: 10 })
  insert(db, seekB, '排序乙', 'png', { size: 30, added: 20 })
  insert(db, '88888888-8888-7888-8888-888888888883', '排序丙', 'png', { size: 5, added: 30 })
  const seekOpts = { search: '排序', minSize: 15, sort: 'addedAt' as const, order: 'asc' as const }
  const seekPage = queryItems(db, { ...seekOpts, limit: 10 })
  const cursor = seekToRow(db, seekOpts, 1)
  const seekNext = queryItems(db, { ...seekOpts, limit: 10, cursor: cursor ?? undefined })
  check(
    '大小筛选的 seek 和查询对齐',
    seekPage.items[1]?.id === seekB && seekNext.items[0]?.id === seekB,
    seekPage.items.map((item) => item.name).join(' '),
  )
  const idList = queryItemIds(db, seekOpts)
  check('queryIds 与筛选结果同序', idList[0] === seekPage.items[0]?.id && idList[1] === seekB)
  const statsOnce = libraryStats(db)
  check('统计有活动项', statsOnce.active > 0)
  check('统计重复项非负', statsOnce.duplicates >= 0)

  console.log('\n[标注与画面文字]')
  const saved = setAnnotations(db, matchId, [
    { id: 'r', kind: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    { id: 'a', kind: 'arrow', x: 0.5, y: 0.5, w: -0.2, h: 0.1 },
    { id: 't', kind: 'text', x: 2, y: -1, w: 0, h: 0, text: ' 说明 ' },
  ])
  const textAnno = saved.find((anno) => anno.kind === 'text')
  check('矩形按比例保存', saved.some((anno) => anno.kind === 'rect' && anno.w === 0.3 && anno.h === 0.4))
  check('文字坐标夹到 0–1', textAnno?.x === 1 && textAnno.y === 0 && textAnno.text === '说明')
  check('读得回来', getAnnotations(db, matchId).length === 3)
  setAnnotations(db, matchId, [])
  check('可以清空', getAnnotations(db, matchId).length === 0)

  const ocrId = '99999999-9999-7999-8999-999999999999'
  insert(db, ocrId, '没有这个词', 'png')
  setOcrText(db, ocrId, '独角鲸草图说明')
  check('搜得到画面文字', queryItems(db, { search: '独角鲸', limit: 10 }).items.some((item) => item.id === ocrId))
  check('两个字以内走备注和画面文字', queryItems(db, { search: '鲸', limit: 10 }).items.some((item) => item.id === ocrId))
  db.prepare('DELETE FROM items WHERE id = ?').run(ocrId)
  check('删掉条目后画面文字也不再命中', queryItems(db, { search: '独角鲸', limit: 10 }).total === 0)

  console.log('\n[老库迁移]')
  const legacyFile = path.join(tmp, 'legacy.db')
  const raw = new Database(legacyFile)
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '2');
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      file_size INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      mtime INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      annotation TEXT,
      url TEXT,
      star INTEGER NOT NULL DEFAULT 0,
      phash TEXT,
      has_thumb INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      palette TEXT,
      hue TEXT
    );
    INSERT INTO items (id, name, ext, file_path, file_size, mtime, added_at)
    VALUES ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', '老条目', 'png', '/tmp/old-aerie.png', 10, 1, 1);
    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      parent_id TEXT
    );
  `)
  raw.close()
  const migrated = openDatabase(legacyFile)
  const cols = migrated.prepare(`PRAGMA table_info(items)`).all() as { name: string }[]
  check('老库补上画面文字列', cols.some((col) => col.name === 'ocr_text'))
  check('老库补上标注列', cols.some((col) => col.name === 'annotations'))
  check('老库补上缺失列', cols.some((col) => col.name === 'missing'))
  check('老库补上拍摄时间列', cols.some((col) => col.name === 'taken_at'))
  const folderCols = migrated.prepare(`PRAGMA table_info(folders)`).all() as { name: string }[]
  check('老库补上封面列', folderCols.some((col) => col.name === 'cover_item_id'))
  const version = migrated.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }
  check('版本升到当前', version.value === String(SCHEMA_VERSION))
  setOcrText(migrated, 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', '老库里的字')
  check(
    '迁完还能搜画面文字',
    queryItems(migrated, { search: '老库里', limit: 5 }).total === 1,
  )
  closeDatabase(migrated)

  console.log('\n[指纹]')
  const red = path.join(tmp, 'red.png')
  const red2 = path.join(tmp, 'red-copy.png')
  await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toFile(red)
  await sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 190, g: 40, b: 36 } },
  })
    .png()
    .toFile(red2)
  const a = await fingerprintFile(red)
  const facts = await describeRaster(red)
  const stepped = sharp(red, { failOn: 'none', animated: false }).rotate()
  const gray = await stepped.clone().resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer()
  check('一次解码的尺寸', facts?.width === 64 && facts?.height === 48)
  check('一次解码的指纹和分步一致', facts?.fingerprint?.phash === dHashFromGray(gray, 9, 8) && facts?.fingerprint?.phash === a?.phash)
  const thumbPath = path.join(tmp, 'red-thumb.webp')
  const withThumb = await describeRaster(red, { thumbPath, thumbPx: 64 })
  check('一次解码写出缩略图', !!withThumb?.thumbWritten && fs.existsSync(thumbPath))
  const b = await fingerprintFile(red2)
  check('能算出指纹', !!a && !!b && a.hue === 'red')
  if (a && b) {
    const dist = hammingHex(a.phash, b.phash)
    check('同色块距离很小', dist <= 6, `距离 ${dist}`)
  }

  console.log('\n[原文件与拍摄时间]')
  check(
    'EXIF 日期',
    parseExifDate('2020:01:02 03:04:05') === new Date(2020, 0, 2, 3, 4, 5).getTime(),
  )
  check('非法 EXIF 日期', parseExifDate('2020:13:02 03:04:05') === null)

  const exif = Buffer.alloc(70)
  exif.write('Exif\0\0', 0, 'ascii')
  const tiff = 6
  exif.write('II', tiff, 'ascii')
  exif.writeUInt16LE(0x002a, tiff + 2)
  exif.writeUInt32LE(8, tiff + 4)
  const ifd0 = tiff + 8
  exif.writeUInt16LE(1, ifd0)
  exif.writeUInt16LE(0x8769, ifd0 + 2)
  exif.writeUInt16LE(4, ifd0 + 4)
  exif.writeUInt32LE(1, ifd0 + 6)
  const exifIfdOff = 26
  exif.writeUInt32LE(exifIfdOff, ifd0 + 10)
  const exifIfd = tiff + exifIfdOff
  exif.writeUInt16LE(1, exifIfd)
  exif.writeUInt16LE(0x9003, exifIfd + 2)
  exif.writeUInt16LE(2, exifIfd + 4)
  exif.writeUInt32LE(20, exifIfd + 6)
  const textOff = exifIfdOff + 18
  exif.writeUInt32LE(textOff, exifIfd + 10)
  exif.write('2020:01:02 03:04:05\0', tiff + textOff, 'ascii')
  const shot = new Date(2020, 0, 2, 3, 4, 5).getTime()
  check('读出拍摄时间', takenAtFromExif(exif) === shot)
  check('没有 Exif 头也能读', takenAtFromExif(exif.subarray(tiff)) === shot)

  const land = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbb1'
  const port = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbb2'
  const square = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbb3'
  const missingId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbb4'
  insert(db, land, '横图', 'jpg')
  insert(db, port, '竖图', 'jpg')
  insert(db, square, '方图', 'jpg')
  insert(db, missingId, 'photo', 'jpg')
  const sizeOf = db.prepare(`UPDATE items SET width = ?, height = ? WHERE id = ?`)
  sizeOf.run(400, 200, land)
  sizeOf.run(200, 400, port)
  sizeOf.run(300, 304, square)
  check('横图', queryItems(db, { orientation: 'landscape', limit: 20 }).items.some((item) => item.id === land))
  check(
    '竖图不含横图',
    !queryItems(db, { orientation: 'portrait', limit: 20 }).items.some((item) => item.id === land),
  )
  check('竖图', queryItems(db, { orientation: 'portrait', limit: 20 }).items.some((item) => item.id === port))
  check('接近正方形', queryItems(db, { orientation: 'square', limit: 20 }).items.some((item) => item.id === square))

  const when = db.prepare(`UPDATE items SET taken_at = ? WHERE id = ?`)
  when.run(new Date(2021, 0, 1).getTime(), land)
  when.run(new Date(2019, 0, 1).getTime(), port)
  const byTaken = queryItems(db, { sort: 'takenAt', order: 'desc', limit: 50 }).items.filter(
    (item) => item.takenAt,
  )
  check('拍摄时间降序', byTaken[0]?.id === land && byTaken[1]?.id === port)

  db.prepare(`UPDATE items SET file_path = ? WHERE id = ?`).run(path.join(tmp, 'not-there.jpg'), missingId)
  const scan = await refreshPresence(db)
  check('扫出缺失', scan.missing >= 1)
  check(
    '缺失视图',
    queryItems(db, { scope: 'missing', limit: 50 }).items.some((item) => item.id === missingId),
  )
  check('统计含缺失', libraryStats(db).missing >= 1)

  const back = path.join(tmp, 'relink')
  fs.mkdirSync(back)
  fs.writeFileSync(path.join(back, 'photo.jpg'), 'jpeg')
  const linked = relinkFolder(db, back)
  check('按文件名接回', linked.linked === 1 && linked.ids.includes(missingId))
  const moved = queryItems(db, { search: 'photo', limit: 10 }).items.find((item) => item.id === missingId)
  check('接回后不再缺失', !!moved && !moved.missing && moved.filePath === path.join(back, 'photo.jpg'))

  const ruled = normalizeRules({ orientation: 'landscape', takenFrom: 200, takenTo: 100 })
  check(
    '横竖和拍摄时间会收进规则',
    ruled.orientation === 'landscape' && ruled.takenFrom === 100 && ruled.takenTo === 200,
  )
  check('不认识的方向丢掉', normalizeRules({ orientation: 'wide' }).orientation === undefined)
  check('说明里有竖图', describeRules({ orientation: 'portrait' }) === '竖图')
  const byRule = queryItems(
    db,
    rulesToQuery(
      { orientation: 'landscape', takenFrom: new Date(2020, 6, 1).getTime() },
      { limit: 30 },
    ),
  )
  check(
    '规则里的横图和拍摄时间',
    byRule.items.some((item) => item.id === land) && !byRule.items.some((item) => item.id === port),
  )

  console.log('\n[复制进库]')
  const srcDir = path.join(tmp, 'originals')
  const libRoot = path.join(tmp, 'copy.aerie')
  fs.mkdirSync(srcDir)
  fs.mkdirSync(path.join(libRoot, 'thumbs'), { recursive: true })
  const original = path.join(srcDir, 'wide.png')
  await sharp({
    create: { width: 8, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toFile(original)
  const copied = await runImport(
    { libraryId: 'copy-test', paths: [srcDir], recursive: true },
    {
      db,
      thumbsDir: path.join(libRoot, 'thumbs'),
      libraryRoot: libRoot,
      storageMode: 'copy',
      onProgress: () => undefined,
    },
  )
  const copyRow = db
    .prepare(`SELECT file_path AS filePath, source_path AS sourcePath FROM items WHERE source_path = ?`)
    .get(original) as { filePath: string; sourcePath: string }
  check('复制进库', copied.imported === 1 && copyRow.sourcePath === original && copyRow.filePath !== original)
  check('副本在库里', copyRow.filePath.startsWith(path.join(libRoot, 'files')) && fs.existsSync(copyRow.filePath))
  const again = await runImport(
    { libraryId: 'copy-test', paths: [srcDir], recursive: true },
    {
      db,
      thumbsDir: path.join(libRoot, 'thumbs'),
      libraryRoot: libRoot,
      storageMode: 'copy',
      onProgress: () => undefined,
    },
  )
  check('同一原图不再拷第二次', again.imported === 0 && again.skipped === 1)

  const inbox = path.join(libRoot, 'inbox', 'inside.png')
  fs.mkdirSync(path.dirname(inbox), { recursive: true })
  fs.copyFileSync(original, inbox)
  const kept = await runImport(
    { libraryId: 'copy-test', paths: [inbox], recursive: false },
    {
      db,
      thumbsDir: path.join(libRoot, 'thumbs'),
      libraryRoot: libRoot,
      storageMode: 'copy',
      onProgress: () => undefined,
    },
  )
  const keptRow = db.prepare(`SELECT file_path AS filePath FROM items WHERE source_path = ?`).get(inbox) as {
    filePath: string
  }
  check('库内文件不再复制一份', kept.imported === 1 && keptRow.filePath === inbox)

  const watched = addWatchFolder(db, srcDir, libRoot)
  check('能监视文件夹', listWatchFolders(db).some((row) => row.id === watched.id))
  let rejected = false
  try {
    addWatchFolder(db, libRoot, libRoot)
  } catch {
    rejected = true
  }
  check('不监视库自己', rejected)
  removeWatchFolder(db, watched.id)
  check('能停止监视', !listWatchFolders(db).some((row) => row.id === watched.id))

  console.log('\n[撤销与封面]')
  const undoId = 'abababab-abab-7aba-8aba-abababababab'
  insert(db, undoId, '撤回用', 'png')
  rememberTrash(db, [undoId])
  trashItems(db, [undoId])
  const trashed = db.prepare('SELECT deleted_at AS deletedAt FROM items WHERE id = ?').get(undoId) as {
    deletedAt: number | null
  }
  const undone = performUndo(db)
  const restored = db.prepare('SELECT deleted_at AS deletedAt FROM items WHERE id = ?').get(undoId) as {
    deletedAt: number | null
  }
  check('撤销回收站', trashed.deletedAt != null && undone === '已撤回移入回收站' && restored.deletedAt == null)
  clearUndo()

  const coverFolder = createFolder(db, '封面夹')
  const coverA = 'cdcdcdcd-cdcd-7cdc-8cdc-cdcdcdcdcdcd'
  const coverB = 'dededede-dede-7ded-8ded-dededededede'
  insert(db, coverA, '封面甲', 'png')
  insert(db, coverB, '封面乙', 'png')
  assignFolders(db, [coverA], [coverFolder.id])
  const autoCover = listFolders(db).find((folder) => folder.id === coverFolder.id)
  check('没有指定时用文件夹里的第一张', autoCover?.coverItemId === coverA)
  setFolderCover(db, coverFolder.id, coverB)
  const pickedCover = listFolders(db).find((folder) => folder.id === coverFolder.id)
  check('指定封面', pickedCover?.coverItemId === coverB)
  const child = createFolder(db, '子夹', coverFolder.id)
  check('能建子文件夹', child.parentId === coverFolder.id)

  closeDatabase(db)
  fs.rmSync(tmp, { recursive: true, force: true })

  console.log(`\n${pass} 通过，${fail} 失败\n`)
  if (fail > 0) process.exit(1)
}

void main()
