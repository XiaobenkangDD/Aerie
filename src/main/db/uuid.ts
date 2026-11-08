/**
 * UUIDv7 生成器
 *
 * 为什么不用 randomUUID()（v4）：
 * v4 是纯随机，字典序毫无意义。而我们的分页排序是
 * `ORDER BY added_at DESC, id DESC`——
 * 同一批导入的所有条目 added_at 是同一毫秒，决胜全靠 id。
 * 用 v4 的话，用户看到的顺序是随机的，不是导入顺序。
 *
 * UUIDv7 的前 48 位是毫秒时间戳，剩余位在同一毫秒内用递增序号填充，
 * 所以「字典序 == 时间序」，且同一毫秒内也保持单调。
 *
 * 布局（128 位）：
 *   0-47     unix_ts_ms       48 位时间戳
 *   48-51    version = 0111   固定 7
 *   52-63    rand_a           12 位，用递增序号填（保证同毫秒单调）
 *   64-65    variant = 10     固定
 *   66-127   rand_b           62 位随机
 *
 * 顺带的好处：未来做多设备同步/合并时，时间有序 id 天然可排序，
 * 不用额外维护 seq 列。
 */
import { randomBytes } from 'node:crypto'

let lastMs = -1
let seq = 0

/** 同一毫秒最多能容纳的序号数（12 位） */
const MAX_SEQ = 0xfff

export function uuidv7(): string {
  let now = Date.now()

  if (now > lastMs) {
    lastMs = now
    seq = 0
  } else {
    seq++
    if (seq > MAX_SEQ) {
      // 同一毫秒内超过 4096 个（批量导入大库时可能发生）：
      // 借下一秒的时间戳，保证 id 仍然单调递增。
      // 代价是 added_at 可能比真实时间早几毫秒，可忽略。
      lastMs++
      now = lastMs
      seq = 0
    }
  }

  const ts = now.toString(16).padStart(12, '0')
  const randA = seq.toString(16).padStart(3, '0')

  const b = randomBytes(8)
  // variant: 最高两位固定为 10
  const variantByte = ((b[0] & 0x3f) | 0x80).toString(16).padStart(2, '0')
  const randB = b.toString('hex').slice(2, 16) // 14 个 hex 字符

  const hex = ts + '7' + randA + variantByte + randB

  // 8-4-4-4-12
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  )
}

/** 从 UUIDv7 里取出时间戳（毫秒）。不是 v7 或格式不对则返回 null。 */
export function uuidv7Time(id: string): number | null {
  const hex = id.replace(/-/g, '')
  if (hex.length !== 32 || hex[12] !== '7') return null
  return parseInt(hex.slice(0, 12), 16)
}
