/**
 * 智能文件夹规则的纯函数。
 *
 * 放在 shared 里，是因为侧栏保存、主进程落库、测试都要得到同一份规则，
 * 不能各写一套「哪些字段算数」。
 */
import type { HueId, Orientation, QueryOptions, SmartFolderRules } from './types.js'
import { HUES } from './image.js'

const HUE_IDS = new Set<string>(HUES.map((hue) => hue.id))

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

/** 丢掉不认识的字段，把星级、大小、时间收到合法范围里。 */
export function normalizeRules(input: unknown): SmartFolderRules {
  const src = asRecord(input)
  const rules: SmartFolderRules = {}

  if (Array.isArray(src.exts)) {
    const exts = src.exts
      .filter((ext): ext is string => typeof ext === 'string')
      .map((ext) => ext.trim().toLowerCase().replace(/^\./, ''))
      .filter((ext) => /^[a-z0-9]{1,10}$/.test(ext))
    if (exts.length > 0) rules.exts = [...new Set(exts)].slice(0, 40)
  }

  if (typeof src.minStar === 'number' && Number.isFinite(src.minStar) && src.minStar > 0) {
    rules.minStar = Math.max(1, Math.min(5, Math.round(src.minStar)))
  }

  if (typeof src.hue === 'string' && HUE_IDS.has(src.hue)) {
    rules.hue = src.hue as HueId
  }

  if (src.orientation === 'landscape' || src.orientation === 'portrait' || src.orientation === 'square') {
    rules.orientation = src.orientation
  }

  if (typeof src.keyword === 'string' && src.keyword.trim()) {
    rules.keyword = src.keyword.trim().slice(0, 200)
  }

  if (Array.isArray(src.tagIds)) {
    const ids = src.tagIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0 && id.length < 80,
    )
    if (ids.length > 0) rules.tagIds = [...new Set(ids)].slice(0, 50)
  }

  if (src.uncategorized === true) rules.uncategorized = true
  if (src.untagged === true) rules.untagged = true

  if (typeof src.minSize === 'number' && Number.isFinite(src.minSize) && src.minSize > 0) {
    rules.minSize = Math.min(Math.floor(src.minSize), Number.MAX_SAFE_INTEGER)
  }
  if (typeof src.maxSize === 'number' && Number.isFinite(src.maxSize) && src.maxSize >= 0) {
    rules.maxSize = Math.min(Math.floor(src.maxSize), Number.MAX_SAFE_INTEGER)
  }
  if (rules.minSize != null && rules.maxSize != null && rules.minSize > rules.maxSize) {
    const swap = rules.minSize
    rules.minSize = rules.maxSize
    rules.maxSize = swap
  }

  if (typeof src.addedFrom === 'number' && Number.isFinite(src.addedFrom)) {
    rules.addedFrom = src.addedFrom
  }
  if (typeof src.addedTo === 'number' && Number.isFinite(src.addedTo)) {
    rules.addedTo = src.addedTo
  }
  if (rules.addedFrom != null && rules.addedTo != null && rules.addedFrom > rules.addedTo) {
    const swap = rules.addedFrom
    rules.addedFrom = rules.addedTo
    rules.addedTo = swap
  }

  if (typeof src.takenFrom === 'number' && Number.isFinite(src.takenFrom)) {
    rules.takenFrom = src.takenFrom
  }
  if (typeof src.takenTo === 'number' && Number.isFinite(src.takenTo)) {
    rules.takenTo = src.takenTo
  }
  if (rules.takenFrom != null && rules.takenTo != null && rules.takenFrom > rules.takenTo) {
    const swap = rules.takenFrom
    rules.takenFrom = rules.takenTo
    rules.takenTo = swap
  }

  return rules
}

/**
 * 把保存的规则译成查询参数。
 *
 * 只带上规则里真有的条件，再拼上排序和分页。
 * 不从 extra 里继承文件夹、搜索词，避免「点了智能文件夹却还套着上一次的文件夹」。
 */
export function rulesToQuery(
  rules: SmartFolderRules,
  extra: Pick<QueryOptions, 'sort' | 'order' | 'limit' | 'offset' | 'cursor'> = {},
): QueryOptions {
  const normalized = normalizeRules(rules)
  return {
    scope: 'active',
    sort: extra.sort,
    order: extra.order,
    limit: extra.limit,
    offset: extra.offset,
    cursor: extra.cursor,
    search: normalized.keyword,
    tagIds: normalized.tagIds,
    minStar: normalized.minStar,
    exts: normalized.exts,
    hue: normalized.hue,
    uncategorized: normalized.uncategorized,
    untagged: normalized.untagged,
    minSize: normalized.minSize,
    maxSize: normalized.maxSize,
    addedFrom: normalized.addedFrom,
    addedTo: normalized.addedTo,
    orientation: normalized.orientation,
    takenFrom: normalized.takenFrom,
    takenTo: normalized.takenTo,
  }
}

/** 侧栏悬停和保存对话框用的一行说明。 */
export function describeRules(rules: SmartFolderRules): string {
  const parts: string[] = []
  if (rules.keyword) parts.push(`关键词「${rules.keyword}」`)
  if (rules.exts?.length) parts.push(rules.exts.map((ext) => ext.toUpperCase()).join('、'))
  if (rules.minStar) parts.push(`${'★'.repeat(rules.minStar)} 及以上`)
  if (rules.hue) {
    parts.push(HUES.find((hue) => hue.id === rules.hue)?.label ?? rules.hue)
  }
  if (rules.orientation) {
    const label: Record<Orientation, string> = { landscape: '横图', portrait: '竖图', square: '方形' }
    parts.push(label[rules.orientation])
  }
  if (rules.tagIds?.length) parts.push(`${rules.tagIds.length} 个标签`)
  if (rules.uncategorized) parts.push('未分类')
  if (rules.untagged) parts.push('未标签')
  if (rules.minSize != null || rules.maxSize != null) {
    const mb = (bytes: number): string => `${Math.round((bytes / 1048576) * 10) / 10}MB`
    if (rules.minSize != null && rules.maxSize != null) parts.push(`${mb(rules.minSize)}–${mb(rules.maxSize)}`)
    else if (rules.minSize != null) parts.push(`≥ ${mb(rules.minSize)}`)
    else if (rules.maxSize != null) parts.push(`≤ ${mb(rules.maxSize)}`)
  }
  if (rules.addedFrom != null || rules.addedTo != null) parts.push('加入时间')
  if (rules.takenFrom != null || rules.takenTo != null) parts.push('拍摄时间')
  return parts.length > 0 ? parts.join(' · ') : '全部素材'
}
