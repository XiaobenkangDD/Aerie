/**
 * 主进程入口
 *
 * 安全基线（比 Eagle 严格得多）：
 * - contextIsolation: true     渲染进程拿不到 Node
 * - nodeIntegration: false     没有 require
 * - sandbox: true              渲染进程在沙箱里
 * - 自定义协议 aerie-thumb://  缩略图走协议，不暴露 file:// 全盘读取
 *
 * Eagle 用的是 nodeIntegration: true（渲染进程直接 fs.existsSync），
 * 这意味着一个 XSS 就能读用户整个硬盘。我们不走这条路。
 */
import { app, BrowserWindow, nativeImage, protocol, net, session } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { registerIpc, resolveItemFile, resolveThumbPath } from './ipc/routes.js'
import { closeLibrary, getDb, getThumbsDir, openLibrary } from './library/manager.js'
import { getThumbCache } from './thumbs/cache.js'
import { ensureThumbForItem } from './thumbs/service.js'
import { IPC, type ThumbSize } from '../shared/types.js'
import { readRecent } from './library/recent.js'
import { syncAppMenu } from './menu.js'

// 数据目录继续用 Aerie，已经记下的库不会因为改显示名而换文件夹。
// 程序坞和菜单栏显示「影巢」，由 npm run dev 写进 Electron.app。
app.setName('Aerie')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 开发模式下 electron-vite 注入的环境变量 */
const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

// ────────────────────────────────────────────────────────────
// 自定义协议：aerie-thumb://<size>/<itemId>
// ────────────────────────────────────────────────────────────
//
// 为什么不用 file://：
// file:// 一旦注册为可加载，渲染进程就能拼出任意路径读全盘。
// 自定义协议只暴露 thumbs 目录，且 itemId 有 UUID 格式校验。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aerie-thumb',
    // corsEnabled 不能省：只声明 supportFetchAPI 时 fetch() 会因跨源被拦，
    // 只有 <img src> 能加载。后面做 pHash / 导出时要用 fetch 取字节。
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: false,
    },
  },
  {
    scheme: 'aerie-file',
    // 原图和视频。stream 让大文件可以边下边播，而不是整文件进内存。
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
])

function registerThumbProtocol(): void {
  protocol.handle('aerie-thumb', async (request) => {
    try {
      const url = new URL(request.url)
      // aerie-thumb://md/<uuid> → host=md, pathname=/<uuid>
      const size = url.hostname || 'md'
      // 去掉可能的 cache-bust 查询串，只留 uuid
      const itemId = url.pathname.replace(/^\//, '').split('?')[0] ?? ''
      const file = resolveThumbPath(itemId, size)

      if (!file) return new Response('bad request', { status: 400 })

      // 缓存未命中就按需重建：可能是刚导入还没生成，也可能刚被 LRU 淘汰。
      // 没有这一步，淘汰就等于把缩略图永久弄坏了。
      if (!fs.existsSync(file)) {
        const rebuilt = await ensureThumbForItem(
          getDb(),
          getThumbsDir(),
          itemId,
          size as ThumbSize,
        )
        if (!rebuilt) return new Response('not found', { status: 404 })
      }

      // 记录访问时间，供 LRU 淘汰排序。失败不影响加载。
      getThumbCache()?.touch(file)

      const res = await net.fetch(`file://${file}`)
      // 补上 CORS 头：net.fetch(file://) 返回的响应没有这些头，
      // 渲染进程里 fetch() 会因跨源被判失败（<img> 不受影响）。
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'image/webp',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

// ────────────────────────────────────────────────────────────
// 窗口
// ────────────────────────────────────────────────────────────

const FILE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  pdf: 'application/pdf',
}

/**
 * aerie-file://local/<itemId>
 *
 * 和缩略图协议同一条原则：渲染进程只拿得到库里登记过的文件，
 * 拼不出任意磁盘路径。视频要能拖动进度条，所以要认 Range。
 */
function registerFileProtocol(): void {
  protocol.handle('aerie-file', (request) => {
    try {
      const url = new URL(request.url)
      const itemId = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const hit = resolveItemFile(itemId)
      if (!hit) return new Response('not found', { status: 404 })
      return serveLocalFile(hit.filePath, hit.ext, request)
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

function serveLocalFile(filePath: string, ext: string, request: Request): Response {
  const stat = fs.statSync(filePath)
  const type = FILE_MIME[ext.toLowerCase()] ?? 'application/octet-stream'
  const common: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  }
  const range = request.headers.get('range')
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range)
    if (!match) return new Response(null, { status: 416, headers: common })
    const start = Number(match[1])
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
    if (!Number.isFinite(start) || start < 0 || start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: common })
    }
    const stream = fs.createReadStream(filePath, { start, end })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...common,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
      },
    })
  }
  const stream = fs.createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...common, 'Content-Length': String(stat.size) },
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: '影巢',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#141416',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  // 首帧渲染完成再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  const publishFullscreen = (): void => {
    mainWindow?.webContents.send(IPC.windowFullscreen, mainWindow.isFullScreen())
  }
  mainWindow.on('enter-full-screen', publishFullscreen)
  mainWindow.on('leave-full-screen', publishFullscreen)
  mainWindow.webContents.on('did-finish-load', publishFullscreen)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ────────────────────────────────────────────────────────────
// 生命周期
// ────────────────────────────────────────────────────────────

// 单实例：第二次启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerThumbProtocol()
    registerFileProtocol()

    // 收紧权限：这个 app 不需要摄像头、麦克风、定位
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = ['clipboard-read', 'clipboard-sanitized-write']
      callback(allowed.includes(permission))
    })

    registerIpc()
    if (process.platform === 'darwin' && app.dock) {
      const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'icon.png'))
      if (!icon.isEmpty()) app.dock.setIcon(icon)
    }
    app.setAboutPanelOptions({
      applicationName: '影巢',
      applicationVersion: app.getVersion(),
      copyright: '本地素材库',
    })
    syncAppMenu(false)
    createWindow()

    // 命令行传入库路径时自动打开（便于 `aerie /path/to/lib.aerie`）
    const arg = process.argv.slice(1).find((a) => a.endsWith('.aerie'))
    if (arg) {
      try {
        openLibrary(arg)
      } catch {
        // 打不开就让用户手动选
      }
    } else {
      // 自动重开上次的库，减少一次点击
      const tempRoot = os.tmpdir()
      for (const entry of readRecent()) {
        // 测试写在临时目录里的库不自动打开，免得盖住用户自己的库
        if (entry.path === tempRoot || entry.path.startsWith(tempRoot + path.sep)) continue
        try {
          openLibrary(entry.path)
          break
        } catch {
          // 这一条打不开就试下一条，不让坏记录挡住真正的库
        }
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 退出前把 WAL 合并回主库，避免残留 -wal 文件
  app.on('before-quit', () => {
    closeLibrary()
  })
}
