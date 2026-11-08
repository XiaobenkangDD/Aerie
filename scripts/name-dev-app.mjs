/**
 * 开发时实际启动的是 Electron.app。程序坞认的是这个文件夹的名字，
 * 只改 Info.plist 不会变。这里把文件夹改成「影巢.app」，下次启动下面就显示影巢。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const NAME = '影巢'
const dist = path.resolve('node_modules/electron/dist')
const legacy = path.join(dist, 'Electron.app')
const named = path.join(dist, `${NAME}.app`)

if (process.platform !== 'darwin') process.exit(0)

function executableOf(app) {
  return path.join(app, 'Contents/MacOS/Electron')
}

if (!fs.existsSync(executableOf(legacy)) && !fs.existsSync(executableOf(named))) {
  console.log('Electron 程序包缺失，正在重新下载…')
  execFileSync(process.execPath, [path.resolve('node_modules/electron/install.js')], { stdio: 'inherit' })
}

if (!fs.existsSync(legacy) && !fs.existsSync(named)) {
  console.error('Electron 程序包仍然缺失，无法启动。请在项目目录执行 npm install 后重试。')
  process.exit(1)
}

let renamed = false
if (fs.existsSync(legacy) && !fs.existsSync(named)) {
  fs.renameSync(legacy, named)
  renamed = true
}

const appPath = fs.existsSync(named) ? named : legacy
const plist = path.join(appPath, 'Contents/Info.plist')
const buddy = '/usr/libexec/PlistBuddy'

function read(key) {
  try {
    return execFileSync(buddy, ['-c', `Print ${key}`, plist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function write(key) {
  if (read(key) === NAME) return false
  const command = read(key) == null ? `Add ${key} string ${NAME}` : `Set ${key} ${NAME}`
  execFileSync(buddy, ['-c', command, plist])
  return true
}

const APP_ID = 'app.aerie.desktop'
const nameChanged = write('CFBundleName') || write('CFBundleDisplayName')
let idChanged = false
if (read('CFBundleIdentifier') !== APP_ID) {
  execFileSync(buddy, ['-c', `Set CFBundleIdentifier ${APP_ID}`, plist])
  idChanged = true
}
if (read('LSHasLocalizedDisplayName') !== 'true') {
  const command =
    read('LSHasLocalizedDisplayName') == null
      ? 'Add LSHasLocalizedDisplayName bool true'
      : 'Set LSHasLocalizedDisplayName true'
  execFileSync(buddy, ['-c', command, plist])
}

const resources = path.join(appPath, 'Contents/Resources')
const strings = Buffer.concat([
  Buffer.from([0xff, 0xfe]),
  Buffer.from(`"CFBundleDisplayName" = "${NAME}";\n"CFBundleName" = "${NAME}";\n`, 'utf16le'),
])
let stringsChanged = false
for (const entry of fs.readdirSync(resources)) {
  if (!entry.endsWith('.lproj')) continue
  const file = path.join(resources, entry, 'InfoPlist.strings')
  const prev = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0)
  if (!prev.equals(strings)) {
    fs.writeFileSync(file, strings)
    stringsChanged = true
  }
}

const iconSrc = path.resolve('build/icon.icns')
const iconDest = path.join(resources, 'electron.icns')
let iconChanged = false
if (fs.existsSync(iconSrc)) {
  const next = fs.readFileSync(iconSrc)
  const prev = fs.existsSync(iconDest) ? fs.readFileSync(iconDest) : Buffer.alloc(0)
  if (!next.equals(prev)) {
    fs.copyFileSync(iconSrc, iconDest)
    iconChanged = true
  }
}

const pathFile = path.resolve('node_modules/electron/path.txt')
const executable = `${path.basename(appPath)}/Contents/MacOS/Electron`
if (fs.readFileSync(pathFile, 'utf8') !== executable) {
  fs.writeFileSync(pathFile, executable)
}

if (renamed || nameChanged || idChanged || stringsChanged || iconChanged) {
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  if (fs.existsSync(lsregister)) {
    execFileSync(lsregister, ['-f', appPath], { stdio: 'ignore' })
  }
}
