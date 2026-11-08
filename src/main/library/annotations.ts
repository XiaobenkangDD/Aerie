/**
 * 画面标注的读写。
 *
 * 存在 items.annotations，一条 JSON。不单独建表：标注总是跟着这一张图走，
 * 删条目时不用再清一张关联表。列表查询刻意不 SELECT 这一列。
 */
import { randomUUID } from 'node:crypto'
import type { DB } from '../db/index.js'
import type { Annotation, AnnotationKind } from '../../shared/types.js'

const KINDS = new Set<AnnotationKind>(['rect', 'arrow', 'text'])

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 渲染进程传来的标注不可信：越界的比例收进 0–1，空文字丢掉。
 * 箭头的 w/h 是偏移，收的是两个端点，而不是把偏移本身夹成正数。
 */
export function sanitizeAnnotations(input: unknown): Annotation[] {
  if (!Array.isArray(input)) return []
  const out: Annotation[] = []

  for (const raw of input.slice(0, 100)) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (typeof row.kind !== 'string' || !KINDS.has(row.kind as AnnotationKind)) continue
    const kind = row.kind as AnnotationKind
    const id =
      typeof row.id === 'string' && row.id.trim()
        ? row.id.trim().slice(0, 64)
        : randomUUID()
    const x = clamp01(Number(row.x))
    const y = clamp01(Number(row.y))
    let w = Number(row.w)
    let h = Number(row.h)
    if (!Number.isFinite(w)) w = 0
    if (!Number.isFinite(h)) h = 0

    if (kind === 'text') {
      const text = typeof row.text === 'string' ? row.text.trim().slice(0, 400) : ''
      if (!text) continue
      out.push({ id, kind, x, y, w: 0, h: 0, text })
      continue
    }

    if (kind === 'rect') {
      w = Math.max(0, w)
      h = Math.max(0, h)
      if (x + w > 1) w = 1 - x
      if (y + h > 1) h = 1 - y
      // 比 0.2% 还小的框多半是手抖，不存
      if (w < 0.002 || h < 0.002) continue
      out.push({ id, kind, x, y, w, h })
      continue
    }

    const x2 = clamp01(x + w)
    const y2 = clamp01(y + h)
    w = x2 - x
    h = y2 - y
    if (Math.hypot(w, h) < 0.002) continue
    out.push({ id, kind, x, y, w, h })
  }

  return out
}

export function getAnnotations(db: DB, id: string): Annotation[] {
  const row = db.prepare(`SELECT annotations FROM items WHERE id = ?`).get(id) as
    | { annotations: string | null }
    | undefined
  if (!row?.annotations) return []
  try {
    return sanitizeAnnotations(JSON.parse(row.annotations) as unknown)
  } catch {
    return []
  }
}

export function setAnnotations(db: DB, id: string, annotations: unknown): Annotation[] {
  const clean = sanitizeAnnotations(annotations)
  const info = db
    .prepare(`UPDATE items SET annotations = ? WHERE id = ?`)
    .run(clean.length > 0 ? JSON.stringify(clean) : null, id)
  if (info.changes === 0) throw new Error('素材不存在')
  return clean
}
