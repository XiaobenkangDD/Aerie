/**
 * 跟像素有关、但又不碰 sharp 的纯函数。
 *
 * 放在 shared 里是因为主进程要算指纹，渲染进程要画色块，
 * 测试也要能不启动 Electron 就验证汉明距离和色相。
 */
import type { HueId } from './types.js'

export const HUES: { id: HueId; label: string; color: string }[] = [
  { id: 'red', label: '红', color: '#e5484d' },
  { id: 'orange', label: '橙', color: '#f76808' },
  { id: 'yellow', label: '黄', color: '#f5c518' },
  { id: 'green', label: '绿', color: '#30a46c' },
  { id: 'cyan', label: '青', color: '#4ecdc4' },
  { id: 'blue', label: '蓝', color: '#3b82f6' },
  { id: 'purple', label: '紫', color: '#8b5cf6' },
  { id: 'pink', label: '粉', color: '#e93d82' },
  { id: 'brown', label: '棕', color: '#a18072' },
  { id: 'white', label: '白', color: '#f4f4f5' },
  { id: 'gray', label: '灰', color: '#8b8b96' },
  { id: 'black', label: '黑', color: '#2a2a2e' },
]

const CHROMA = new Set<HueId>([
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
  'brown',
])

/** 把 RGB 收成十二色相里的一个。灰、白、黑优先于色相，避免浅灰被算成某种颜色。 */
export function hueFromRgb(r: number, g: number, b: number): HueId {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d < 0.08) {
    if (l > 0.88) return 'white'
    if (l < 0.12) return 'black'
    return 'gray'
  }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (max === R) h = ((G - B) / d) % 6
  else if (max === G) h = (B - R) / d + 2
  else h = (R - G) / d + 4
  h *= 60
  if (h < 0) h += 360

  if (h >= 15 && h < 50 && l < 0.55 && s < 0.75) return 'brown'
  if (h < 15 || h >= 345) return 'red'
  if (h < 40) return 'orange'
  if (h < 70) return 'yellow'
  if (h < 165) return 'green'
  if (h < 195) return 'cyan'
  if (h < 255) return 'blue'
  if (h < 290) return 'purple'
  return 'pink'
}

export interface BucketColor {
  hex: string
  hue: HueId
  count: number
}

/**
 * 从一块 RGB 裸像素里挑出出现最多的几种颜色。
 *
 * 量化步长取 24：24×24 的小图再按 24 级分桶，颜色数不会爆炸，
 * 又不会把「大红」和「暗红」合成同一个桶。
 */
export function paletteFromRgb(rgb: Buffer, channels = 3): BucketColor[] {
  const buckets = new Map<string, { r: number; g: number; b: number; count: number }>()
  for (let i = 0; i + 2 < rgb.length; i += channels) {
    const r = quantize(rgb[i])
    const g = quantize(rgb[i + 1])
    const b = quantize(rgb[i + 2])
    const key = `${r},${g},${b}`
    const hit = buckets.get(key)
    if (hit) hit.count++
    else buckets.set(key, { r, g, b, count: 1 })
  }

  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 5)
  return ranked.map((c) => ({
    hex: toHex(c.r, c.g, c.b),
    hue: hueFromRgb(c.r, c.g, c.b),
    count: c.count,
  }))
}

/** 有彩色占得住脚时用它，否则退回出现最多的那个（多半是白底或黑底）。 */
export function dominantHue(colors: BucketColor[]): HueId | null {
  if (colors.length === 0) return null
  const top = colors[0]
  const chroma = colors.find((c) => CHROMA.has(c.hue))
  if (chroma && chroma.count >= top.count * 0.2) return chroma.hue
  return top.hue
}

function quantize(v: number): number {
  return Math.min(255, Math.round(v / 24) * 24)
}

function toHex(r: number, g: number, b: number): string {
  return [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
}

/**
 * 9×8 灰度图做差值哈希，得到 64 bit，写成 16 位十六进制。
 *
 * 每一行比较相邻两个像素，左边更亮记 1。
 * 对缩放、轻度压缩、亮度整体偏移都比较稳，正好用来找「看起来一样」的图。
 */
export function dHashFromGray(pixels: Buffer, width: number, height: number): string | null {
  if (width < 2 || height < 1 || pixels.length < width * height) return null
  let bits = 0n
  let i = 0
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width - 1; x++) {
      if (pixels[row + x] > pixels[row + x + 1]) bits |= 1n << BigInt(63 - i)
      i++
    }
  }
  return bits.toString(16).padStart(16, '0')
}

/** 两个 16 位十六进制指纹的汉明距离。格式不对时返回 64（视为完全不同）。 */
export function hammingHex(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64
  const xh = (parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0
  const xl = (parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0
  return popcount(xh) + popcount(xl)
}

function popcount(v: number): number {
  let n = v >>> 0
  n = n - ((n >>> 1) & 0x55555555)
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  n = (n + (n >>> 4)) & 0x0f0f0f0f
  n = n + (n >>> 8)
  n = n + (n >>> 16)
  return n & 0x3f
}

export interface HashGroup {
  ids: string[]
  distance: number
}

/**
 * 按汉明距离把指纹分成组。
 *
 * 4000 张以内做两两比较（约 800 万次，主线程上大约一两秒）。
 * 再大就只合并完全相同的指纹：近邻是平方复杂度，不能让一次点击卡住库。
 */
export function clusterByHamming(
  rows: { id: string; phash: string }[],
  maxDistance: number,
): { groups: HashGroup[]; approximate: boolean } {
  const usable = rows.filter((r) => /^[0-9a-f]{16}$/i.test(r.phash))
  const limit = Math.max(0, Math.min(16, Math.round(maxDistance)))

  if (usable.length > 4000 || limit === 0) {
    return { groups: exactGroups(usable), approximate: usable.length > 4000 }
  }

  const parent = usable.map((_, i) => i)
  const rank = usable.map(() => 0)
  const dist = usable.map(() => 0)

  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }

  const unite = (a: number, b: number, d: number): void => {
    let ra = find(a)
    let rb = find(b)
    if (ra === rb) {
      dist[ra] = Math.max(dist[ra], d)
      return
    }
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra]
    parent[rb] = ra
    dist[ra] = Math.max(dist[ra], dist[rb], d)
    if (rank[ra] === rank[rb]) rank[ra]++
  }

  const parsed = usable.map((r) => ({
    hi: parseInt(r.phash.slice(0, 8), 16) >>> 0,
    lo: parseInt(r.phash.slice(8), 16) >>> 0,
  }))

  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const d = popcount((parsed[i].hi ^ parsed[j].hi) >>> 0) + popcount((parsed[i].lo ^ parsed[j].lo) >>> 0)
      if (d <= limit) unite(i, j, d)
    }
  }

  const buckets = new Map<number, { ids: string[]; distance: number }>()
  for (let i = 0; i < usable.length; i++) {
    const root = find(i)
    const hit = buckets.get(root)
    if (hit) hit.ids.push(usable[i].id)
    else buckets.set(root, { ids: [usable[i].id], distance: dist[root] })
  }

  const groups = [...buckets.values()]
    .filter((g) => g.ids.length > 1)
    .sort((a, b) => b.ids.length - a.ids.length || a.distance - b.distance)

  return { groups, approximate: false }
}

function exactGroups(rows: { id: string; phash: string }[]): HashGroup[] {
  const map = new Map<string, string[]>()
  for (const r of rows) {
    const key = r.phash.toLowerCase()
    const arr = map.get(key)
    if (arr) arr.push(r.id)
    else map.set(key, [r.id])
  }
  return [...map.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ({ ids, distance: 0 }))
    .sort((a, b) => b.ids.length - a.ids.length)
}
