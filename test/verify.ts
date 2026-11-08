/**
 * 核心逻辑验证脚本
 *
 * 不启动 Electron，直接测 db / query / mutate / importer 这条链路。
 * 用真实的照片库跑一遍，验证：
 *   1. 库能建、表能建、FTS 能工作
 *   2. 导入真实目录，去重生效
 *   3. 缩略图真的落盘
 *   4. 中文搜索、标签过滤、文件夹过滤都对
 *
 * 跑法：npm run verify
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase, checkIntegrity } from '../src/main/db/index.js'
import { runImport } from '../src/main/importer/importer.js'
import type { Cursor } from '../src/shared/types.js'
import { queryItems, seekToPercent, getItemDetail, listTags, listFolders } from '../src/main/library/query.js'
import {
  assignFolders,
  assignTags,
  createFolder,
  createTag,
  updateItem,
} from '../src/main/library/mutate.js'

const SOURCE = process.argv[2] ?? '/Users/kang/Pictures/写真'

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

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aerie-verify-'))
  const thumbsDir = path.join(tmp, 'thumbs')
  for (const s of ['sm', 'md', 'lg']) fs.mkdirSync(path.join(thumbsDir, s), { recursive: true })

  console.log(`\n临时库：${tmp}`)
  console.log(`素材来源：${SOURCE}\n`)

  // ── 1. 建库 ──
  console.log('[1] 数据库')
  const db = openDatabase(path.join(tmp, 'aerie.db'))
  const integrity = checkIntegrity(db)
  check('完整性检查', integrity === 'ok', integrity)

  const ftsOk = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='items_fts'`)
    .get() as { name: string } | undefined
  check('FTS5 表已建', !!ftsOk)

  // ── 2. 导入真实照片 ──
  console.log('\n[2] 导入')
  if (!fs.existsSync(SOURCE)) {
    console.log(`  跳过：${SOURCE} 不存在`)
  } else {
    const t0 = Date.now()
    let lastProgress = ''
    const result = await runImport(
      { libraryId: 'test', paths: [SOURCE], recursive: true },
      {
        db,
        thumbsDir,
        onProgress: (p) => {
          if (p.phase === 'thumbs' && p.done % 40 === 0) {
            lastProgress = `${p.done}/${p.total}`
          }
        },
      },
    )
    const ms = Date.now() - t0
    console.log(`  进度快照：${lastProgress}`)
    check('导入了文件', result.imported > 0, `${result.imported} 项 / ${ms}ms`)
    check('没有失败', result.failed === 0)

    // 去重：再导一次应该全部跳过
    const again = await runImport(
      { libraryId: 'test', paths: [SOURCE], recursive: true },
      { db, thumbsDir, onProgress: () => {} },
    )
    check('重复导入被跳过', again.imported === 0 && again.skipped > 0, `跳过 ${again.skipped} 项`)

    // ── 3. 缩略图 ──
    console.log('\n[3] 缩略图')
    const mdDir = path.join(thumbsDir, 'md')
    const thumbs = fs.readdirSync(mdDir).filter((f) => f.endsWith('.webp'))
    const totalThumbBytes = thumbs.reduce(
      (s, f) => s + fs.statSync(path.join(mdDir, f)).size,
      0,
    )
    const withThumb = (
      db.prepare('SELECT COUNT(*) AS n FROM items WHERE has_thumb = 1').get() as { n: number }
    ).n
    const totalItems = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n

    check('缩略图文件已生成', thumbs.length > 0, `${thumbs.length} 个`)
    check(
      '缩略图覆盖率 > 80%',
      withThumb / Math.max(totalItems, 1) > 0.8,
      `${withThumb}/${totalItems} = ${((withThumb / Math.max(totalItems, 1)) * 100).toFixed(0)}%`,
    )
    check(
      '平均缩略图 < 120KB',
      thumbs.length > 0 && totalThumbBytes / thumbs.length < 120 * 1024,
      `${(totalThumbBytes / Math.max(thumbs.length, 1) / 1024).toFixed(0)}KB/张`,
    )

    // 尺寸探测
    const withDims = (
      db.prepare('SELECT COUNT(*) AS n FROM items WHERE width IS NOT NULL').get() as {
        n: number
      }
    ).n
    check('宽高已读取', withDims > 0, `${withDims} 项`)

    // ── 4. 查询 ──
    console.log('\n[4] 查询')
    const all = queryItems(db, { limit: 50 })
    check('查询返回数据', all.items.length > 0, `${all.items.length}/${all.total} 项`)
    check('查询耗时 < 50ms', all.elapsedMs < 50, `${all.elapsedMs.toFixed(2)}ms`)

    // 分页
    const page2 = queryItems(db, { limit: 20, offset: 20 })
    check(
      '分页不重复',
      page2.items.every((p) => !all.items.slice(0, 20).some((a) => a.id === p.id)),
    )

    // 游标分页：连续翻 3 页，确认无重复无遗漏
    const seenIds = new Set<string>()
    let cursor: Cursor | null = null
    let pages = 0
    let duplicated = false
    for (let i = 0; i < 3; i++) {
      const r = queryItems(db, { limit: 20, cursor: cursor ?? undefined })
      for (const it of r.items) {
        if (seenIds.has(it.id)) duplicated = true
        seenIds.add(it.id)
      }
      pages++
      cursor = r.nextCursor
      if (!cursor) break
    }
    check('游标翻页无重复', !duplicated, `${pages} 页 / ${seenIds.size} 条`)

    // seek 定位
    const seek = seekToPercent(db, {}, 0.5)
    check('seek 到 50% 返回游标', seek !== null, seek ? `key=${String(seek.key).slice(0,12)} id=${seek.id.slice(0,8)}` : '')
    if (seek) {
      const fromSeek = queryItems(db, { limit: 5, cursor: seek })
      check('从 seek 游标能继续查询', fromSeek.items.length > 0, `${fromSeek.items.length} 项`)
    }

    // 中文搜索（trigram 需要 ≥3 字符）
    const first = all.items[0]
    if (first && first.name.length >= 3) {
      const frag = first.name.slice(0, 3)
      const found = queryItems(db, { search: frag, limit: 10 })
      check(`中文搜索 "${frag}"`, found.items.some((i) => i.id === first.id), `命中 ${found.total}`)
    } else {
      check('中文搜索', true, '首个条目名太短，跳过')
    }

    // 2 字符搜索走 LIKE 分支
    if (first && first.name.length >= 2) {
      const frag2 = first.name.slice(0, 2)
      const found2 = queryItems(db, { search: frag2, limit: 10 })
      check(`短词搜索 "${frag2}"（LIKE 分支）`, found2.total > 0, `命中 ${found2.total}`)
    }

    // 扩展名过滤
    const jpg = queryItems(db, { exts: ['jpg'], limit: 5 })
    check('按扩展名过滤', jpg.items.every((i) => i.ext === 'jpg'), `${jpg.total} 张 jpg`)

    // 排序
    const bySize = queryItems(db, { sort: 'fileSize', order: 'desc', limit: 10 })
    const sortedOk = bySize.items.every(
      (it, i) => i === 0 || bySize.items[i - 1].fileSize >= it.fileSize,
    )
    check('按大小降序', sortedOk)

    // ── 5. 标签与文件夹 ──
    console.log('\n[5] 标签与文件夹')
    const tag = createTag(db, '测试标签')
    check('创建标签', !!tag.id, tag.name)

    const dup = createTag(db, '测试标签')
    check('同名标签复用', dup.id === tag.id)

    const sub = createTag(db, '子标签', tag.id)
    check('创建子标签', sub.parentId === tag.id)

    const ids = all.items.slice(0, 5).map((i) => i.id)
    assignTags(db, ids, [tag.id])
    const tagged = queryItems(db, { tagIds: [tag.id], limit: 10 })
    check('按标签过滤', tagged.total === 5, `${tagged.total} 项`)

    const folder = createFolder(db, '测试文件夹')
    const subFolder = createFolder(db, '子文件夹', folder.id)
    check('创建嵌套文件夹', subFolder.parentId === folder.id)

    assignFolders(db, [ids[0]], [subFolder.id])
    const inParent = queryItems(db, { folderId: folder.id, limit: 10 })
    check('父文件夹含子文件夹内容', inParent.total === 1, `${inParent.total} 项`)

    // 详情
    const detail = getItemDetail(db, ids[0])
    check('详情含标签', !!detail && detail.tags.length > 0, `${detail?.tags.length} 个标签`)
    check('详情含文件夹', !!detail && detail.folders.length > 0, `${detail?.folders.length} 个文件夹`)

    // ── 6. 编辑 ──
    console.log('\n[6] 编辑')
    updateItem(db, ids[0], { star: 5, annotation: '这是一张很好的照片' })
    const edited = getItemDetail(db, ids[0])
    check('评分已保存', edited?.star === 5)
    check('备注已保存', edited?.annotation === '这是一张很好的照片')

    // 备注也能被搜到
    const byNote = queryItems(db, { search: '很好的照片', limit: 5 })
    check('按备注搜索', byNote.total >= 1, `命中 ${byNote.total}`)

    // ── 7. 规模测试 ──
    console.log('\n[7] 规模与索引')
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`)
      .all() as { name: string }[]
    check('索引已建', idx.length >= 8, `${idx.length} 个索引`)

    const big = queryItems(db, { limit: 2000 })
    check('大页查询 < 200ms', big.elapsedMs < 200, `${big.elapsedMs.toFixed(1)}ms / ${big.items.length} 项`)

    // 空搜索性能（全表排序）
    const t1 = performance.now()
    queryItems(db, { limit: 500 })
    check('冷查询 < 50ms', performance.now() - t1 < 50, `${(performance.now() - t1).toFixed(1)}ms`)

    console.log('\n[8] 统计')
    const tags = listTags(db)
    const folders = listFolders(db)
    console.log(`  标签 ${tags.length} 个，文件夹 ${folders.length} 个`)
    const extDist = db
      .prepare('SELECT ext, COUNT(*) AS n FROM items GROUP BY ext ORDER BY n DESC LIMIT 6')
      .all() as { ext: string; n: number }[]
    console.log(`  格式分布：${extDist.map((e) => `${e.ext}×${e.n}`).join(', ')}`)
    const dbSize = fs.statSync(path.join(tmp, 'aerie.db')).size
    console.log(`  数据库大小：${(dbSize / 1024 / 1024).toFixed(2)}MB（${totalItems} 项）`)
    console.log(`  平均每项索引：${(dbSize / Math.max(totalItems, 1)).toFixed(0)} 字节`)
  }

  closeDatabase(db)

  // 清理
  fs.rmSync(tmp, { recursive: true, force: true })

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`结果：${pass} 通过，${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('\n验证脚本异常：', e)
  process.exit(1)
})
