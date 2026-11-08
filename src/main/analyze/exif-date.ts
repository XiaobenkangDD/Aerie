import sharp from 'sharp'

/** 读文件头里的拍摄时间。没有 EXIF 或不是图片时返回 null，不抛错。 */
export async function readTakenAt(filePath: string): Promise<number | null> {
  try {
    const meta = await sharp(filePath, { failOn: 'none', animated: false }).metadata()
    if (!meta.exif || meta.exif.length === 0) return null
    return takenAtFromExif(meta.exif)
  } catch {
    return null
  }
}

/**
 * 从 EXIF 里读拍摄时间。
 *
 * sharp 只给出原始 EXIF 字节，不解析日期。
 * 这里只找 DateTimeOriginal（0x9003），没有再退回修改时间（0x0132）。
 * 日期按本机时区理解：EXIF 本身不带时区。
 */
export function takenAtFromExif(buf: Buffer): number | null {
  if (buf.length < 16) return null
  const marker = buf.indexOf(Buffer.from('Exif\0\0', 'ascii'))
  const base = marker >= 0 ? marker + 6 : 0
  return readTiffDate(buf, base)
}

function readTiffDate(buf: Buffer, base: number): number | null {
  if (base + 8 > buf.length) return null
  const order = buf.toString('ascii', base, base + 2)
  const le = order === 'II'
  if (!le && order !== 'MM') return null
  const u16 = (offset: number): number => (le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset))
  const u32 = (offset: number): number => (le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset))
  if (u16(base + 2) !== 0x002a) return null

  const ifd0 = base + u32(base + 4)
  const exifIfd = ifdPointer(buf, base, ifd0, u16, u32)
  if (exifIfd != null) {
    const original = asciiTag(buf, base, exifIfd, 0x9003, u16, u32)
    const parsed = original ? parseExifDate(original) : null
    if (parsed) return parsed
  }
  const modified = asciiTag(buf, base, ifd0, 0x0132, u16, u32)
  return modified ? parseExifDate(modified) : null
}

function ifdPointer(
  buf: Buffer,
  base: number,
  ifd: number,
  u16: (offset: number) => number,
  u32: (offset: number) => number,
): number | null {
  if (ifd + 2 > buf.length) return null
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > buf.length) return null
    if (u16(entry) === 0x8769 && u16(entry + 2) === 4) {
      return base + u32(entry + 8)
    }
  }
  return null
}

function asciiTag(
  buf: Buffer,
  base: number,
  ifd: number,
  tag: number,
  u16: (offset: number) => number,
  u32: (offset: number) => number,
): string | null {
  if (ifd + 2 > buf.length) return null
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > buf.length) return null
    if (u16(entry) !== tag || u16(entry + 2) !== 2) continue
    const n = u32(entry + 4)
    if (n < 19) continue
    const at = n <= 4 ? entry + 8 : base + u32(entry + 8)
    if (at + 19 > buf.length) return null
    return buf.toString('ascii', at, at + 19)
  }
  return null
}

/** EXIF 日期形如 2020:01:02 03:04:05。非法日期返回 null。 */
export function parseExifDate(text: string): number | null {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return null
  }
  const time = new Date(year, month - 1, day, hour, minute, second).getTime()
  return Number.isFinite(time) ? time : null
}
