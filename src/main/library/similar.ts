/**
 * 找出看起来像的图。
 *
 * 「重复项」视图只按完全相同的指纹过滤，这里再做近邻：
 * 汉明距离在阈值以内的归成一组。
 */
import type { DB } from '../db/index.js'
import type { HueId, Item, SimilarScan } from '../../shared/types.js'
import { clusterByHamming } from '../../shared/image.js'

export function findSimilar(db: DB, maxDistance = 6): SimilarScan {
  const rows = db
    .prepare(
      `SELECT id, phash FROM items
       WHERE deleted_at IS NULL AND phash IS NOT NULL`,
    )
    .all() as { id: string; phash: string }[]

  const { groups, approximate } = clusterByHamming(rows, maxDistance)
  const shown = groups.slice(0, 80)
  const wanted = shown.flatMap((g) => g.ids)
  const byId = new Map<string, Item>()

  if (wanted.length > 0) {
    const placeholders = wanted.map(() => '?').join(', ')
    const raw = db.prepare(`SELECT * FROM items WHERE id IN (${placeholders})`).all(...wanted) as Row[]
    for (const row of raw) byId.set(row.id, rowToItem(row))
  }

  return {
    compared: rows.length,
    approximate,
    groups: shown
      .map((g) => ({
        distance: g.distance,
        items: g.ids.map((id) => byId.get(id)).filter((item): item is Item => !!item),
      }))
      .filter((g) => g.items.length > 1),
  }
}

interface Row {
  id: string
  name: string
  ext: string
  file_path: string
  file_size: number
  width: number | null
  height: number | null
  mtime: number
  added_at: number
  annotation: string | null
  url: string | null
  star: number
  phash: string | null
  has_thumb: number
  deleted_at: number | null
  palette: string | null
  hue: string | null
  missing: number
  taken_at: number | null
}

function rowToItem(r: Row): Item {
  return {
    id: r.id,
    name: r.name,
    ext: r.ext,
    filePath: r.file_path,
    fileSize: r.file_size,
    width: r.width,
    height: r.height,
    mtime: r.mtime,
    addedAt: r.added_at,
    annotation: r.annotation,
    url: r.url,
    star: r.star,
    phash: r.phash,
    hasThumb: r.has_thumb === 1,
    deletedAt: r.deleted_at,
    palette: r.palette ? r.palette.split(',').filter((part) => /^[0-9a-f]{6}$/i.test(part)) : [],
    hue: (r.hue as HueId | null) ?? null,
    missing: r.missing === 1,
    takenAt: r.taken_at != null && r.taken_at > 0 ? r.taken_at : null,
  }
}
