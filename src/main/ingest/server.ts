/**
 * 给浏览器扩展用的本地收藏服务。
 *
 * 只绑 127.0.0.1，不绑 0.0.0.0——否则同一局域网的人都能往库里塞文件。
 * 每次请求都要带库里的随机 token，扩展里的 token 由用户从设置里复制。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { DB } from '../db/index.js'
import type { IngestInfo, StorageMode } from '../../shared/types.js'
import { runImport } from '../importer/importer.js'
import { updateItem } from '../library/mutate.js'
import { startOcrBackfill } from '../analyze/ocr.js'

const HOST = '127.0.0.1' as const
const PREFERRED_PORT = 47321
const PORT_TRIES = 8
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tif',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

export interface IngestOptions {
  db: DB
  libraryId: string
  /** 下载下来的图片先落到这里，再走现有导入 */
  inboxDir: string
  libraryRoot: string
  storageMode: StorageMode
  thumbsDir: string
  /** 导入完成。用来补 OCR，并通知界面刷新。 */
  onImported?: () => void
}

let server: http.Server | null = null
let active: IngestOptions | null = null
let port: number | null = null
let listenError: string | null = null
let chain: Promise<unknown> = Promise.resolve()

export function ingestInfo(db: DB | null): IngestInfo {
  return {
    listening: server !== null && server.listening,
    host: HOST,
    port,
    token: db ? readToken(db) : '',
    error: listenError,
  }
}

export function regenerateIngestToken(db: DB): IngestInfo {
  const token = randomBytes(24).toString('hex')
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('ingest_token', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(token)
  return ingestInfo(db)
}

export function stopIngest(): void {
  const current = server
  server = null
  active = null
  port = null
  if (!current) return
  current.close()
}

export function startIngest(options: IngestOptions): void {
  stopIngest()
  listenError = null
  active = options
  // 先把 token 生成好，界面打开设置时不用再等
  readToken(options.db)
  listenFrom(PREFERRED_PORT, 0)
}

function listenFrom(start: number, attempt: number): void {
  if (!active) return
  if (attempt >= PORT_TRIES) {
    listenError = `127.0.0.1:${start} 起的端口都占用了，浏览器收藏暂不可用。`
    return
  }
  const next = start + attempt
  const created = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      send(res, 500, { ok: false, error: err instanceof Error ? err.message : '收藏失败' })
    })
  })
  created.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      created.close()
      listenFrom(start, attempt + 1)
      return
    }
    listenError = err.message
    if (server === created) server = null
  })
  created.listen(next, HOST, () => {
    server = created
    port = next
    listenError = null
    // 不要因为这个辅助端口把退出挂住
    created.unref()
  })
}

function readToken(db: DB): string {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'ingest_token'`).get() as
    | { value: string }
    | undefined
  if (row?.value) return row.value
  const token = randomBytes(24).toString('hex')
  db.prepare(`INSERT INTO meta (key, value) VALUES ('ingest_token', ?)`).run(token)
  return token
}

function tokenOk(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  })
  res.end(json)
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    send(res, 204, {})
    return
  }
  const url = new URL(req.url ?? '/', `http://${HOST}`)
  if (req.method !== 'POST' || url.pathname !== '/ingest') {
    send(res, 404, { ok: false, error: '未知接口' })
    return
  }
  const options = active
  if (!options || !server) {
    send(res, 503, { ok: false, error: '库没有打开' })
    return
  }

  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  if (!tokenOk(token, readToken(options.db))) {
    send(res, 401, { ok: false, error: 'token 不对。请从影巢设置里重新复制。' })
    return
  }

  const raw = await readBody(req, 64 * 1024)
  let payload: { imageUrl?: unknown; pageUrl?: unknown; title?: unknown }
  try {
    payload = JSON.parse(raw) as { imageUrl?: unknown; pageUrl?: unknown; title?: unknown }
  } catch {
    send(res, 400, { ok: false, error: '请求不是 JSON' })
    return
  }
  if (typeof payload.imageUrl !== 'string' || !payload.imageUrl.trim()) {
    send(res, 400, { ok: false, error: '需要图片地址' })
    return
  }

  const pageUrl = typeof payload.pageUrl === 'string' ? payload.pageUrl.trim().slice(0, 2000) : ''
  const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 500) : ''

  // 串行：better-sqlite3 的事务不能和另一个导入叠在同一条连接上
  const result = await enqueue(() =>
    saveImage(options, payload.imageUrl as string, pageUrl, title),
  )
  send(res, 200, { ok: true, ...result })
  options.onImported?.()
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function saveImage(
  options: IngestOptions,
  imageUrl: string,
  pageUrl: string,
  title: string,
): Promise<{ imported: number; id: string | null }> {
  assertPublicHttp(imageUrl)
  fs.mkdirSync(options.inboxDir, { recursive: true })
  const saved = await downloadImage(imageUrl, options.inboxDir)
  const imported = await runImport(
    { libraryId: options.libraryId, paths: [saved], recursive: false },
    {
      db: options.db,
      thumbsDir: options.thumbsDir,
      libraryRoot: options.libraryRoot,
      storageMode: options.storageMode,
      onProgress: () => undefined,
      onSettled: () => startOcrBackfill(options.db),
    },
  )
  const row = options.db.prepare(`SELECT id FROM items WHERE file_path = ?`).get(saved) as
    | { id: string }
    | undefined
  if (row && (pageUrl || title)) {
    updateItem(options.db, row.id, {
      ...(pageUrl ? { url: pageUrl } : {}),
      ...(title ? { annotation: title } : {}),
    })
  }
  return { imported: imported.imported, id: row?.id ?? null }
}

function assertPublicHttp(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('图片地址不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只接受 http 或 https 图片')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.includes(':')
  if (blocked) throw new Error('不下载内网或本机地址')
  return url
}

async function downloadImage(raw: string, inboxDir: string): Promise<string> {
  const response = await fetch(raw, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'image/*,*/*;q=0.8' },
  })
  if (!response.ok) throw new Error(`下载失败（${response.status}）`)
  if (response.url) assertPublicHttp(response.url)

  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const ext = MIME_EXT[type] ?? extFromUrl(raw)
  if (!ext) throw new Error('链接不是图片')

  const reader = response.body?.getReader()
  if (!reader) throw new Error('下载没有内容')
  const chunks: Buffer[] = []
  let received = 0
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    received += step.value.byteLength
    if (received > MAX_IMAGE_BYTES) {
      await reader.cancel()
      throw new Error('图片超过 32MB，已取消')
    }
    chunks.push(Buffer.from(step.value))
  }
  const file = path.join(inboxDir, `web-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`)
  fs.writeFileSync(file, Buffer.concat(chunks))
  return file
}

function extFromUrl(raw: string): string | null {
  try {
    const ext = path.extname(new URL(raw).pathname).slice(1).toLowerCase()
    return Object.values(MIME_EXT).includes(ext) ? ext : null
  } catch {
    return null
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
