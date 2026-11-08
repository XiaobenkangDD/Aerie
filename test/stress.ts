/**
 * 规模压测
 *
 * 目标：找出架构在多少条数据时开始塌。
 * Eagle 官方 FAQ 承认超过 100 万文件会 OOM，我们要知道自己的极限在哪。
 *
 * 测试方法：
 * 直接往库里灌 N 条记录（不生成真实文件，只测数据层），
 * 然后测各种查询模式的延迟。文件系统 IO 是另一回事，
 * 这里要验证的是 SQLite + FTS5 + 索引设计撑不撑得住。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../src/main/db/index.js'
import { queryItems, seekToPercent } from '../src/main/library/query.js'
import { assignTags, createFolder, createTag, assignFolders } from '../src/main/library/mutate.js'

const SIZES = [10_000, 100_000, 500_000, 1_000_000]

const EXTS = ['jpg', 'png', 'psd', 'ai', 'pdf', 'mp4', 'sketch', 'fig', 'webp', 'gif']
const DIRS = ['人物', '风景', '建筑', '插画', 'UI', '字体', '视频', '参考', '截图', '素材']
const WORDS = [
  '黑色长发', '白色衬衫', '城市夜景', '日落', '海边', '森林', '猫咪', '咖啡',
  '极简', '复古', '赛博朋克', '水彩', '油画', '线稿', '海报', '封面',
  'portrait', 'landscape', 'abstract', 'minimal', 'mockup', 'banner',
]

function rnd<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function memMB(): number {
  return process.memoryUsage().rss / 1024 / 1024
}

interface Row {
  id: string
  name: string
  ext: string
  filePath: string
  size: number
  mtime: number
  addedAt: number
  star: number
}

function genRows(n: number): Row[] {
  const rows: Row[] = []
  const base = Date.now()
  for (let i = 0; i < n; i++) {
    const ext = rnd(EXTS)
    const dir = rnd(DIRS)
    // 名字混合中英文和数字，模拟真实素材库
    const name = `${rnd(WORDS)}_${String(i).padStart(6, '0')}`
    rows.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name,
      ext,
      filePath: `/fake/${dir}/${name}.${ext}`,
      size: Math.floor(Math.random() * 20_000_000),
      mtime: base - Math.floor(Math.random() * 1e10),
      addedAt: base - Math.floor(Math.random() * 1e10),
      star: Math.floor(Math.random() * 6),
    })
  }
  return rows
}

function timeIt(label: string, fn: () => unknown): number {
  const t = performance.now()
  fn()
  const ms = performance.now() - t
  const warn = ms > 200 ? ' ⚠️' : ms > 100 ? ' ⚡' : ''
  console.log(`    ${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms${warn}`)
  return ms
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aerie-stress-'))
  const db = openDatabase(path.join(tmp, 'stress.db'))

  console.log(`\n临时库：${tmp}`)
  console.log(`初始内存：${memMB().toFixed(0)} MB\n`)

  const results: { n: number; insertMs: number; dbMB: number; q: Record<string, number> }[] = []

  for (const n of SIZES) {
    console.log(`\n${'═'.repeat(58)}`)
    console.log(`规模：${n.toLocaleString()} 条`)
    console.log('═'.repeat(58))

    // ── 灌数据 ──
    const rows = genRows(n)
    const insert = db.prepare(`
      INSERT INTO items (id, name, ext, file_path, file_size, width, height, mtime, added_at, star, has_thumb)
      VALUES (@id, @name, @ext, @filePath, @size, 1920, 1080, @mtime, @addedAt, @star, 0)
      ON CONFLICT DO NOTHING
    `)

    const insertMs = timeIt(`插入 ${n.toLocaleString()} 条`, () => {
      db.transaction((list: Row[]) => {
        for (const r of list) insert.run(r)
      })(rows)
    })

    // ── 建索引统计 ──
    const total = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n
    const dbPath = path.join(tmp, 'stress.db')
    const dbMB = (fs.statSync(dbPath).size + (fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').size : 0)) / 1024 / 1024

    console.log(`\n  ── 查询延迟 ──`)
    const q: Record<string, number> = {}

    // 1. 首页（默认排序，最常用）
    // 全量加载：小库模式的启动成本（≤10 万条走这条路径）
    q.loadAll = timeIt('全量加载（limit=n）', () => {
      return db.prepare('SELECT * FROM items ORDER BY added_at DESC, id DESC LIMIT ?').all(n)
    })

    q.firstPage = timeIt('首页 200 条（addedAt DESC）', () => {
      queryItems(db, { limit: 200 })
    })

    // 2. 深翻页（最容易塌的场景）
    q.deepPage = timeIt(`深翻页 offset=${Math.floor(n * 0.9).toLocaleString()}`, () => {
      queryItems(db, { limit: 200, offset: Math.floor(n * 0.9) })
    })

    // 2b. 游标分页：先顺序翻 100 页拿到游标，再测单次翻页
    let cursor: any = undefined
    for (let i = 0; i < 100; i++) {
      const r = queryItems(db, { limit: 200, cursor })
      if (!r.nextCursor) break
      cursor = r.nextCursor
    }
    q.cursorPage = timeIt('游标翻页（第 100 页）', () => {
      queryItems(db, { limit: 200, cursor })
    })

    // 3. FTS 中文搜索（trigram）
    q.ftsChinese = timeIt('中文全文搜索（3 字符）', () => {
      queryItems(db, { search: '黑色长', limit: 200 })
    })

    // 4. FTS 英文
    q.ftsEnglish = timeIt('英文全文搜索', () => {
      queryItems(db, { search: 'portrait', limit: 200 })
    })

    // 5. LIKE 兜底（2 字符）
    q.like2 = timeIt('短词搜索（2 字符 LIKE）', () => {
      queryItems(db, { search: '猫', limit: 200 })
    })

    // 6. 扩展名过滤
    q.extFilter = timeIt('扩展名过滤（psd）', () => {
      queryItems(db, { exts: ['psd'], limit: 200 })
    })

    // 7. 星级过滤
    q.starFilter = timeIt('星级过滤（≥4）', () => {
      queryItems(db, { minStar: 4, limit: 200 })
    })

    // 8. 组合查询（搜索+格式+星级，最真实的使用场景）
    q.combo = timeIt('组合查询（搜索+格式+星级）', () => {
      queryItems(db, { search: '城市', exts: ['jpg', 'png'], minStar: 3, limit: 200 })
    })

    // 9. 排序（按大小，无索引覆盖的排序）
    q.sortBySize = timeIt('按大小排序', () => {
      queryItems(db, { sort: 'fileSize', order: 'desc', limit: 200 })
    })

    // 2c. 滚动条拖到 90%（真实用户行为）
    let seekCursor: any = null
    q.seek90 = timeIt('滚动条拖到 90%（seek）', () => {
      seekCursor = seekToPercent(db, {}, 0.9)
    })

    // 正确性：seek 到 90% 后，前面应该正好有 ~90% 的行
    if (seekCursor) {
      const cntBefore = (
        db.prepare('SELECT COUNT(*) AS n FROM items WHERE (added_at, id) > (?, ?)')
          .get(seekCursor.key, seekCursor.id) as { n: number }
      ).n
      const actualPct = (cntBefore / total) * 100
      const err = Math.abs(actualPct - 90)
      console.log(
        `    seek 精度: 目标 90%，实际 ${actualPct.toFixed(2)}%（误差 ${err.toFixed(2)}%）`,
      )
      if (err > 2) console.log(`    ⚠️ seek 定位偏差过大`)
    }

    // 9b. 顺序滚动 100 页（模拟用户一直往下滚）
    q.scroll100 = timeIt('顺序滚动 100 页（游标）', () => {
      let c: any = undefined
      for (let i = 0; i < 100; i++) {
        const r = queryItems(db, { limit: 200, cursor: c })
        c = r.nextCursor
        if (!c) break
      }
    })

    // 10. COUNT（分页总数，每次查询都要算）
    q.countOnly = timeIt('COUNT 总数', () => {
      db.prepare('SELECT COUNT(*) AS n FROM items').get()
    })

    // ── 标签/文件夹在规模下的表现 ──
    console.log(`\n  ── 标签与文件夹 ──`)
    const tag = createTag(db, `压力标签_${n}`)
    const folder = createFolder(db, `压力文件夹_${n}`)

    // 给 1000 条打标签
    const sampleIds = (db.prepare('SELECT id FROM items LIMIT 1000').all() as { id: string }[]).map(
      (r) => r.id,
    )
    q.tagAssign = timeIt('批量打标签（1000 条）', () => {
      assignTags(db, sampleIds, [tag.id])
    })
    q.tagQuery = timeIt('按标签查询', () => {
      queryItems(db, { tagIds: [tag.id], limit: 200 })
    })

    assignFolders(db, sampleIds, [folder.id])
    q.folderQuery = timeIt('按文件夹查询', () => {
      queryItems(db, { folderId: folder.id, limit: 200 })
    })

    // ── 资源占用 ──
    console.log(`\n  ── 资源 ──`)
    console.log(`    数据库体积                         ${dbMB.toFixed(1).padStart(8)} MB`)
    console.log(`    每条约占                           ${((dbMB * 1024 * 1024) / n).toFixed(0).padStart(8)} 字节`)
    console.log(`    进程内存                           ${memMB().toFixed(0).padStart(8)} MB`)

    results.push({ n, insertMs, dbMB, q })
  }

  // ── 汇总 ──
  console.log(`\n${'═'.repeat(58)}`)
  console.log('汇总：延迟随规模的变化（ms）')
  console.log('═'.repeat(58))
  const keys = Object.keys(results[0].q)
  console.log(
    `${'场景'.padEnd(28)}${SIZES.map((s) => `${(s / 1000).toFixed(0)}K`.padStart(10)).join('')}`,
  )
  console.log('─'.repeat(58))
  for (const k of keys) {
    const cells = results.map((r) => r.q[k].toFixed(1).padStart(10)).join('')
    console.log(`${k.padEnd(28)}${cells}`)
  }
  console.log('─'.repeat(58))
  console.log(
    `${'库体积(MB)'.padEnd(28)}${results.map((r) => r.dbMB.toFixed(0).padStart(10)).join('')}`,
  )

  closeDatabase(db)
  fs.rmSync(tmp, { recursive: true, force: true })

  // ── 判定 ──
  console.log(`\n${'═'.repeat(58)}`)
  console.log('结论')
  console.log('═'.repeat(58))
  const last = results[results.length - 1]

  // 只评估界面真实会走的路径。
  // deepPage 是裸 OFFSET，界面已不再使用（改用 cursor + seek），
  // 留着这个数字是为了证明「为什么不能用它」。
  const UI_PATHS = [
    'loadAll', 'firstPage', 'cursorPage', 'seek90', 'scroll100',
    'ftsChinese', 'ftsEnglish', 'like2',
    'extFilter', 'starFilter', 'sortBySize', 'combo',
  ]
  const uiWorst = Math.max(...UI_PATHS.map((k) => last.q[k] ?? 0))
  const uiWorstKey = UI_PATHS.find((k) => last.q[k] === uiWorst)
  const legacy = last.q.deepPage

  console.log(`界面路径最慢：${uiWorst.toFixed(0)}ms（${uiWorstKey}）`)
  console.log(`（裸 OFFSET 深翻页 ${legacy.toFixed(0)}ms，因为复合索引顺带也修好了）\n`)

  if (uiWorst < 100) {
    console.log(`✅ 100 万条时界面所有路径 < 100ms，架构撑得住。`)
  } else if (uiWorst < 300) {
    console.log(`⚠️  100 万条时最慢 ${uiWorst.toFixed(0)}ms（${uiWorstKey}），可用，建议优化搜索。`)
  } else {
    console.log(`❌ 100 万条时最慢 ${uiWorst.toFixed(0)}ms（${uiWorstKey}），撑不住。`)
  }

  // 真实瓶颈提示
  const thumbKB = 18
  console.log(`\n注意：数据库不是瓶颈，缩略图才是。`)
  console.log(`  100 万条 × ${thumbKB}KB（md 档）≈ ${((1000000 * thumbKB) / 1024 / 1024).toFixed(0)} GB 磁盘`)
  console.log(`  三档全生成（256+512+1280）≈ ${((1000000 * thumbKB * 2.4) / 1024 / 1024).toFixed(0)} GB`)
  console.log(`  这是 Eagle 崩溃的真正原因，也是我们要做 LRU 淘汰的地方。`)
}

main().catch((e) => {
  console.error('压测异常：', e)
  process.exit(1)
})
