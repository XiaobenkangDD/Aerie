/**
 * 一张光栅图只解码一次。
 *
 * metadata 只读文件头，拿宽高和拍摄时间。
 * 缩略图、指纹和色板从同一次 rotate() 上 clone，像素只解一遍。
 */
import fs from 'node:fs'
import sharp from 'sharp'
import { dHashFromGray, dominantHue, paletteFromRgb } from '../../shared/image.js'
import { takenAtFromExif } from './exif-date.js'
import type { Fingerprint } from './fingerprint.js'

export const RASTER_EXTS = [
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'gif', 'avif',
  'tif', 'tiff', 'heic', 'heif', 'svg', 'bmp', 'ico', 'jxl',
]

const RASTER = new Set(RASTER_EXTS)

export function isRasterExt(ext: string): boolean {
  return RASTER.has(ext.toLowerCase())
}

export interface RasterFacts {
  width: number | null
  height: number | null
  takenAt: number | null
  fingerprint: Fingerprint | null
  thumbWritten: boolean
}

export async function describeRaster(
  filePath: string,
  opts?: { thumbPath?: string; thumbPx?: number },
): Promise<RasterFacts | null> {
  try {
    const base = sharp(filePath, { failOn: 'none', animated: false }).rotate()
    const meta = await base.metadata()
    const takenAt =
      meta.exif && meta.exif.length > 0 ? takenAtFromExif(meta.exif) : null

    let fingerprint: Fingerprint | null = null
    let thumbWritten = false
    try {
      const grayP = base.clone().resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer()
      const rgbP = base.clone().resize(24, 24, { fit: 'fill' }).removeAlpha().raw().toBuffer()
      const thumbP =
        opts?.thumbPath && opts.thumbPx
          ? base
              .clone()
              .resize(opts.thumbPx, opts.thumbPx, { fit: 'inside', withoutEnlargement: true })
              .webp({ quality: 82, effort: 4 })
              .toFile(opts.thumbPath)
              .then(() => {
                thumbWritten = fs.existsSync(opts.thumbPath!) && fs.statSync(opts.thumbPath!).size > 0
              })
              .catch(() => undefined)
          : Promise.resolve()
      const [gray, rgb] = await Promise.all([grayP, rgbP, thumbP]).then(
        ([grayBuf, rgbBuf]) => [grayBuf, rgbBuf] as const,
      )
      const phash = dHashFromGray(gray, 9, 8)
      const colors = paletteFromRgb(rgb, 3)
      const hue = dominantHue(colors)
      if (phash && hue && colors.length > 0) {
        fingerprint = { phash, palette: colors.map((color) => color.hex).join(','), hue }
      }
    } catch {
      // 像素读失败时仍把文件头里的尺寸和日期留下
    }

    return {
      width: meta.width ?? null,
      height: meta.height ?? null,
      takenAt,
      fingerprint,
      thumbWritten,
    }
  } catch {
    return null
  }
}
