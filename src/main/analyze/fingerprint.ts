/**
 * 给一张图算感知哈希和主色。
 *
 * 只处理 sharp 能直接解码的光栅图。PSD、视频、字体不算——
 * 那些格式的「看起来像不像」没有一个稳定的像素定义，硬算只会得到 QuickLook 预览的哈希，
 * 和原图对不上，反而让重复检测误报。
 */
import { describeRaster } from './raster.js'

export interface Fingerprint {
  phash: string
  /** 逗号分隔的 RRGGBB */
  palette: string
  hue: string
}

export async function fingerprintFile(filePath: string): Promise<Fingerprint | null> {
  const facts = await describeRaster(filePath)
  return facts?.fingerprint ?? null
}
