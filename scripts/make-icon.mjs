/**
 * 把 build/icon.svg 收成 Dock 和打包要用的 png / icns。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()
const svg = fs.readFileSync(path.join(root, 'build/icon.svg'))
const master = await sharp(svg).resize(1024, 1024).png().toBuffer()
fs.writeFileSync(path.join(root, 'build/icon.png'), master)

const iconset = path.join(os.tmpdir(), `aerie-icon-${process.pid}.iconset`)
fs.mkdirSync(iconset, { recursive: true })
const specs = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]
for (const [name, size] of specs) {
  await sharp(master).resize(size, size).png().toFile(path.join(iconset, name))
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'build/icon.icns')])
fs.rmSync(iconset, { recursive: true, force: true })
