import React, { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import type {
  Cursor,
  Folder,
  HueId,
  ImportProgress,
  Item,
  ItemDetail,
  ItemScope,
  Library,
  Orientation,
  StorageMode,
  WatchFolder,
  LibraryStats,
  OcrStatus,
  QueryOptions,
  SimilarScan,
  SmartFolder,
  SmartFolderRules,
  SortField,
  SortOrder,
  Tag,
  ThumbStats,
} from '../../shared/types'
import { HUES } from '../../shared/image'
import { describeRules, normalizeRules, rulesToQuery } from '../../shared/smart'
import {
  ConnectDialog,
  Menu,
  RenameDialog,
  SideMenu,
  SimilarDialog,
  SmartFolderDialog,
  VIEWER_ZOOM_EVENT,
  Viewer,
} from './overlays'

// ────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────

/**
 * 卡片拖拽用的自定义 MIME。
 *
 * 为什么不用 text/plain：窗口级的「拖文件进来导入」监听的是 Files 类型，
 * 用自定义类型能让两套拖拽互不干扰，不会把内部拖拽误判成导入。
 */
const ITEM_DRAG_MIME = 'application/x-aerie-items'

type BrowseLayout = 'grid' | 'list' | 'waterfall'

interface CardPlace {
  x: number
  y: number
}

/** 瀑布流里方向键按坐标找邻居，不再按固定列数跳。 */
function waterfallNeighbor(places: CardPlace[], index: number, key: string): number {
  const cur = places[index]
  if (!cur) return index
  const sameCol = (place: CardPlace): boolean => Math.abs(place.x - cur.x) < 4
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const down = key === 'ArrowDown'
    let best = index
    let bestY = down ? Infinity : -Infinity
    places.forEach((place, i) => {
      if (!sameCol(place)) return
      if (down && place.y > cur.y && place.y < bestY) {
        best = i
        bestY = place.y
      }
      if (!down && place.y < cur.y && place.y > bestY) {
        best = i
        bestY = place.y
      }
    })
    return best
  }
  const dir = key === 'ArrowLeft' ? -1 : 1
  let best = index
  let bestScore = Infinity
  places.forEach((place, i) => {
    const dx = place.x - cur.x
    if (dx * dir <= 4) return
    const score = Math.abs(place.y - cur.y) * 8 + Math.abs(dx)
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  })
  return best
}

/** Electron 会把主进程错误包一层 “Error invoking remote method”。界面上只留人话。 */
function explainIpc(err: unknown): string {
  const raw = err instanceof Error ? err.message : '打开失败'
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}

/** 搜索框、备注这类文字框。滑杆和按钮不算，全选和粘贴仍作用于素材。 */
function isTextField(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true
  if (!(el instanceof HTMLInputElement)) return false
  const skip = ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'reset', 'submit']
  return !skip.includes(el.type)
}

/** 侧栏可接收拖放的条目 */
type DropTarget = { kind: 'folder' | 'tag'; id: string }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

// ────────────────────────────────────────────────────────────
// 网格：自己实现虚拟滚动
// ────────────────────────────────────────────────────────────
//
// 为什么不引 react-window：图片网格是「列数随宽度变化」的二维虚拟化，
// 现成库要么只做一维，要么 API 别扭。自己算行高更直接。

interface GridProps {
  items: Item[]
  /**
   * 数据是否已全部在内存里。
   * true 时 items.length === total，滚到任何位置都有数据：
   * 不需要 seek、不会出现骨架、续页逻辑整段跳过。
   */
  complete: boolean
  /** items[0] 对应的绝对位置。seek 之后数组不再从 0 开始，必须记住这个偏移。 */
  windowStart: number
  total: number
  selected: Set<string>
  onSelect: (id: string, mods: { meta: boolean; shift: boolean }) => void
  /** 开始拖拽某张卡片，返回实际要拖的 id 列表（已选则整批拖） */
  onItemDragStart: (id: string) => string[]
  onOpen: (id: string) => void
  onContextMenu: (id: string, x: number, y: number) => void
  layout: BrowseLayout
  /** 瀑布流的卡片坐标，方向键用来找上下左右的邻居。网格模式传 null。 */
  onPlaces: (places: CardPlace[] | null) => void
  canReorder: boolean
  reorderHoverId: string | null
  onReorderHover: (id: string | null) => void
  onReorderDrop: (id: string, event: React.DragEvent) => void
  onLoadMore: () => void
  onSeek: (percent: number) => void
  /** 受控跳转：把这个绝对索引的行滚到视口顶部（seek 后用，保证内容与滚动条一致） */
  jumpTo: { index: number; seq: number } | null
  /** 把当前列数上报给 App，seek 时用来把目标对齐到整行 */
  onCols: (cols: number) => void
  cardSize: number
}

function Grid({
  items,
  complete,
  windowStart,
  total,
  selected,
  onSelect,
  onItemDragStart,
  onOpen,
  onContextMenu,
  layout,
  canReorder,
  reorderHoverId,
  onReorderHover,
  onReorderDrop,
  onLoadMore,
  onSeek,
  jumpTo,
  onCols,
  onPlaces,
  cardSize,
}: GridProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState({ w: 0, h: 0 })

  // 测量容器
  //
  // 用 useLayoutEffect 同步测一次，再挂 ResizeObserver 兜底。
  // 只用 ResizeObserver 不够可靠：它在某些时机（页面重载、StrictMode 双挂载）
  // 首帧不会回调，viewport 会一直停在初始值，导致列数算错、卡片排布错乱。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const measure = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      setViewport((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }

    measure() // 同步测量，首帧就是对的
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  const gap = layout === 'list' ? 4 : 12
  const pad = layout === 'list' ? 8 : 20
  const list = layout === 'list'
  // 瀑布流要知道每张图的高度，大库分页时前面的图不在内存里，算不出真实位置，退回等高网格。
  const masonry = layout === 'waterfall' && complete
  const cols = list
    ? 1
    : Math.max(
        1,
        Math.floor((Math.max(viewport.w, cardSize + pad * 2) - pad * 2 + gap) / (cardSize + gap)),
      )
  const cardW = list ? Math.max(240, viewport.w - pad * 2) : cardSize
  const cardH = list ? 56 : cardSize + 26 // 图 + 文件名
  const imgH = list ? 48 : cardSize

  const flow = useMemo(() => {
    if (!masonry) return null
    const colH: number[] = Array.from({ length: cols }, () => pad)
    const places: { idx: number; item: Item; x: number; y: number; w: number; h: number; imgH: number }[] = []
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx]
      if (!item) continue
      const ratio = item.width && item.height && item.width > 0 ? item.height / item.width : 1
      const imageH = Math.round(Math.min(cardW * 2.6, Math.max(72, cardW * ratio)))
      const h = imageH
      let col = 0
      for (let c = 1; c < cols; c++) if ((colH[c] ?? 0) < (colH[col] ?? 0)) col = c
      const y = colH[col] ?? pad
      places.push({ idx, item, x: pad + col * (cardW + gap), y, w: cardW, h, imgH: imageH })
      colH[col] = y + h + gap
    }
    return { places, totalH: Math.max(pad, ...colH) + pad }
  }, [masonry, items, cols, cardW, gap, pad])

  // 高度按总数算，这样滚动条长度反映整个库，而不是已加载的部分
  const rows = Math.ceil(total / cols)
  const totalH = flow ? flow.totalH : rows * (cardH + gap) + pad * 2

  // 只渲染可见行（上下各多渲染 3 行，滚动时不闪白）
  const startRow = Math.max(0, Math.floor((scrollTop - pad) / (cardH + gap)) - 3)
  const endRow = Math.min(
    rows,
    Math.ceil((scrollTop + viewport.h - pad) / (cardH + gap)) + 3,
  )

  const visible: { idx: number; item: Item | null; x: number; y: number; w: number; h: number; imgH: number }[] = []
  if (flow) {
    const top = scrollTop - 800
    const bottom = scrollTop + viewport.h + 800
    for (const place of flow.places) {
      if (place.y + place.h < top || place.y > bottom) continue
      visible.push(place)
    }
  } else {
    for (let r = startRow; r < endRow; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c
        if (idx >= total) break
        // 小库模式：idx 就是 items 下标，不可能落空
        // 大库模式：窗口可能不覆盖这个位置，落空就渲染骨架
        const item = complete ? (items[idx] ?? null) : (items[idx - windowStart] ?? null)
        visible.push({
          idx,
          item,
          x: pad + c * (cardW + gap),
          y: pad + r * (cardH + gap),
          w: cardW,
          h: cardH,
          imgH,
        })
      }
    }
  }

  useEffect(() => {
    onCols(cols)
  }, [cols, onCols])

  useEffect(() => {
    if (!flow) {
      onPlaces(null)
      return
    }
    const places: CardPlace[] = []
    for (const place of flow.places) places[place.idx] = { x: place.x, y: place.y }
    onPlaces(places)
  }, [flow, onPlaces])

  // 调试：暴露网格几何，便于自动化核对
  useEffect(() => {
    ;(window as unknown as { __grid?: unknown }).__grid = {
      viewportW: viewport.w,
      viewportH: viewport.h,
      cols,
      rows,
      scrollTop,
    }
  })

  // 受控跳转：seek 之后让目标行对齐到视口顶部
  //
  // 必须同时跟踪 cols：列数变了，同一个索引对应的行号就变了。
  // 只按 seq 判重的话，如果跳转时列数还是旧值（面板开合、滚动条出现都会改宽度），
  // 定位就会落在错误的行上，且之后不会再纠正。
  const jumpMark = useRef({ seq: -1, cols: -1 })
  useEffect(() => {
    if (!jumpTo) return
    if (jumpTo.seq === jumpMark.current.seq && cols === jumpMark.current.cols) return
    jumpMark.current = { seq: jumpTo.seq, cols }
    const el = scrollRef.current
    if (!el) return
    if (flow) {
      const box = flow.places.find((place) => place.idx === jumpTo.index)
      if (box) el.scrollTop = Math.max(0, box.y - pad)
      return
    }
    const row = Math.floor(jumpTo.index / cols)
    el.scrollTop = pad + row * (cardH + gap)
  }, [jumpTo, cols, cardH, gap, pad, flow])

  // 已加载窗口的绝对结束位置
  const windowEnd = windowStart + items.length

  // 滚到窗口末尾时自动续页（仅大库模式）
  const nearEnd = !complete && scrollTop + viewport.h > totalH - cardH * 3
  useEffect(() => {
    if (nearEnd && windowEnd < total) onLoadMore()
  }, [nearEnd, windowEnd, total, onLoadMore])

  // 拖滚动条跳到未加载区域：按位置 seek，而不是干等骨架
  const firstVisibleIdx = startRow * cols
  const lastVisibleIdx = endRow * cols
  // 只要可视区没有被已加载窗口「完全覆盖」就需要 seek。
  //
  // 这里借鉴 Eagle 的思路：它的窗口始终以「覆盖当前视野」为准，
  // 而不是等完全离开才补。用「完全离开」判断会漏掉半覆盖的情况——
  // 视野一半有内容一半是骨架，用户看到的就是残缺画面。
  //
  // 小库模式（complete）下 total === items.length，这个条件恒为 false，
  // seek 机制整段休眠——这正是它该有的样子：数据都在内存里，滚到哪都有。
  const needsSeek =
    !complete &&
    items.length > 0 &&
    total > items.length &&
    (firstVisibleIdx < windowStart || lastVisibleIdx > windowEnd)
  const seekTimer = useRef<number | null>(null)
  useEffect(() => {
    if (!needsSeek) return
    if (seekTimer.current) window.clearTimeout(seekTimer.current)
    // 防抖：拖动过程中不要每帧都查
    seekTimer.current = window.setTimeout(() => {
      onSeek(Math.min(1, Math.max(0, scrollTop / Math.max(1, totalH - viewport.h))))
    }, 120)
    return () => {
      if (seekTimer.current) window.clearTimeout(seekTimer.current)
    }
  }, [needsSeek, scrollTop, totalH, viewport.h, onSeek])

  return (
    <div
      ref={scrollRef}
      className="grid-scroll"
      onScroll={(e) => {
        const el = e.currentTarget
        setScrollTop(el.scrollTop)
        // 顺带重测：滚动条出现/面板开合时 ResizeObserver 不一定回调，
        // 滚动是高频事件，在这里校准最可靠
        const w = el.clientWidth
        const h = el.clientHeight
        setViewport((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
      }}
    >
      <div style={{ height: totalH, position: 'relative' }}>
        {visible.map(({ idx, item, x, y, w, h, imgH: placeImgH }) =>
          !item ? (
            <div
              key={`sk-${idx}`}
              className="card is-skeleton"
              style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
            >
              <div className="card-img" style={{ height: cardSize }} />
              <div className="card-name" />
            </div>
          ) : (
          <div
            key={item.id}
            data-id={item.id}
            data-idx={idx}
            className={`card ${list ? 'is-list' : ''} ${masonry ? 'is-flow' : ''} ${selected.has(item.id) ? 'is-selected' : ''} ${reorderHoverId === item.id ? 'is-drop' : ''} ${item.missing ? 'is-missing' : ''}`}
            style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
            onClick={(e) =>
              onSelect(item.id, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey })
            }
            onDoubleClick={() => onOpen(item.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              onContextMenu(item.id, e.clientX, e.clientY)
            }}
            draggable
            onDragOver={(e) => {
              if (!canReorder || !e.dataTransfer.types.includes(ITEM_DRAG_MIME)) return
              e.preventDefault()
              e.stopPropagation()
              onReorderHover(item.id)
            }}
            onDrop={(e) => {
              if (!canReorder) return
              e.preventDefault()
              e.stopPropagation()
              onReorderDrop(item.id, e)
            }}
            onDragEnd={() => onReorderHover(null)}
            onDragStart={(e) => {
              // dataTransfer 只能在 dragstart 里同步写，所以这里一次算好
              const ids = onItemDragStart(item.id)
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData(ITEM_DRAG_MIME, JSON.stringify(ids))
              // 某些投放目标只认 text/plain，给个占位说明拖了几项
              e.dataTransfer.setData('text/plain', `${ids.length} 项素材`)
            }}
          >
            <div className="card-img" style={{ height: placeImgH, width: list ? placeImgH : undefined }}>
              <span className="card-thumb-ph" aria-hidden="true">
                生成中
              </span>
              <img
                src={`aerie-thumb://md/${item.id}`}
                alt={item.name}
                loading="lazy"
                draggable={false}
                onError={(e) => {
                  // 缩略图还没生成或已被淘汰：露出底下的「生成中」，别留下空白灰块
                  e.currentTarget.classList.add('is-fail')
                }}
                onLoad={(e) => e.currentTarget.classList.remove('is-fail')}
              />
              <span className="card-ext">{item.ext}</span>
              <button
                type="button"
                className={`card-check-btn ${selected.has(item.id) ? 'is-on' : ''}`}
                aria-label={selected.has(item.id) ? '取消选择' : '选择'}
                title={selected.has(item.id) ? '取消选择' : '多选（等同 ⌘/Ctrl 点击）'}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(item.id, { meta: true, shift: e.shiftKey })
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {selected.has(item.id) ? '✓' : ''}
              </button>
              {item.missing && <span className="card-missing">缺失</span>}
              {item.star > 0 && <span className="card-star">★{item.star}</span>}
            </div>
            <div className="card-name" title={item.name}>
              {item.name}
            </div>
            {list && (
              <div className="card-meta">
                <span>{item.ext.toUpperCase()}</span>
                <span>{formatSize(item.fileSize)}</span>
                <span>{item.width && item.height ? `${item.width}×${item.height}` : ''}</span>
              </div>
            )}
          </div>
          ),
        )}
      </div>
    </div>
  )
}

const SCOPE_LABEL: Record<ItemScope, string> = {
  active: '全部素材',
  uncategorized: '未分类',
  untagged: '未标签',
  starred: '已评分',
  duplicates: '重复项',
  missing: '缺失',
  trash: '回收站',
}

function walkTree<T extends { id: string; name: string; parentId: string | null }>(
  rows: T[],
  parentId: string | null,
  depth: number,
): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = []
  for (const row of rows) {
    if (row.parentId !== parentId) continue
    out.push({ id: row.id, name: row.name, depth })
    out.push(...walkTree(rows, row.id, depth + 1))
  }
  return out
}

function NavIcon({ scope }: { scope: ItemScope }): React.JSX.Element {
  return (
    <svg className="nav-svg" viewBox="0 0 16 16" aria-hidden="true">
      {scope === 'active' && (
        <>
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </>
      )}
      {scope === 'uncategorized' && <path d="M2.2 5.2V12h11.6V5.2H8.1L6.8 3.4H2.2z" />}
      {scope === 'untagged' && (
        <>
          <path d="M2.4 8.1 7.8 2.7h5.3V8L7.8 13.3z" />
          <circle cx="11.1" cy="4.9" r="0.7" fill="currentColor" stroke="none" />
        </>
      )}
      {scope === 'starred' && (
        <polygon points="8,2.1 9.7,6 13.9,6.4 10.7,9.2 11.6,13.4 8,11.2 4.4,13.4 5.3,9.2 2.1,6.4 6.3,6" />
      )}
      {scope === 'duplicates' && (
        <>
          <rect x="2" y="4.2" width="8" height="8" rx="1" />
          <path d="M6 3.2h6.2A1 1 0 0 1 13.2 4.2V11" />
        </>
      )}
      {scope === 'missing' && (
        <>
          <circle cx="8" cy="8" r="5.2" />
          <path d="M5.6 5.6 10.4 10.4" />
        </>
      )}
      {scope === 'trash' && (
        <>
          <path d="M3.4 4.6h9.2" />
          <path d="M6.2 4.5V3.2h3.6v1.3" />
          <path d="M4.6 4.6 5.2 13h5.6l.6-8.4" />
        </>
      )}
    </svg>
  )
}

/** 菜单/提示里写快捷键用。macOS 显示符号，其它平台写 Ctrl/Alt。 */
const IS_APPLE = /Mac|iPhone|iPad/.test(navigator.platform)
const ACCEL = {
  openFiles: IS_APPLE ? '⌘O' : 'Ctrl+O',
  openFolder: IS_APPLE ? '⌥⌘O' : 'Ctrl+Alt+O',
  pasteImport: IS_APPLE ? '⇧⌘V' : 'Ctrl+Shift+V',
  search: IS_APPLE ? '⌘F' : 'Ctrl+F',
} as const

function ImportMenu({
  onFiles,
  onFolder,
  onPaste,
}: {
  onFiles: () => void
  onFolder: () => void
  onPaste: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const run = (fn: () => void): void => {
    setOpen(false)
    fn()
  }

  return (
    <div className="import-pop no-drag" ref={ref}>
      <button className="btn-primary sm" onClick={() => setOpen((v) => !v)}>
        导入
      </button>
      {open && (
        <div className="pop" role="menu">
          <button onClick={() => run(onFiles)}>
            <span>导入文件…</span>
            <kbd>{ACCEL.openFiles}</kbd>
          </button>
          <button onClick={() => run(onFolder)}>
            <span>导入文件夹…</span>
            <kbd>{ACCEL.openFolder}</kbd>
          </button>
          <button onClick={() => run(onPaste)}>
            <span>从剪贴板</span>
            <kbd>{ACCEL.pasteImport}</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

function StarSet({ onStar }: { onStar: (star: number) => void }): React.JSX.Element {
  const [hover, setHover] = useState(0)
  return (
    <div className="star-set" onMouseLeave={() => setHover(0)} role="group" aria-label="评分">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={n <= hover ? 'is-hot' : ''}
          title={`设为 ${n} 星`}
          onMouseEnter={() => setHover(n)}
          onClick={() => onStar(n)}
        >
          ★
        </button>
      ))}
      <button className="star-clear" title="清除评分" onClick={() => onStar(0)}>
        清除
      </button>
    </div>
  )
}

function BatchBar({
  count,
  scope,
  folders,
  tags,
  onStar,
  onFolder,
  onTag,
  onExport,
  onRename,
  onTrash,
  onRestore,
  onClear,
  onLeave,
}: {
  count: number
  scope: ItemScope
  folders: Folder[]
  tags: Tag[]
  onStar: (star: number) => void
  onFolder: (id: string) => void
  onTag: (id: string) => void
  onExport: () => void
  onRename: () => void
  onTrash: () => void
  onRestore: () => void
  onClear: () => void
  onLeave?: () => void
}): React.JSX.Element {
  const folderOptions = walkTree(folders, null, 0)
  const tagOptions = walkTree(tags, null, 0)
  return (
    <div className="batchbar">
      <span className="batch-count">已选 {count}</span>
      <StarSet onStar={onStar} />
      <select
        value=""
        disabled={folderOptions.length === 0}
        title={folderOptions.length === 0 ? '先在侧栏新建文件夹' : '加入文件夹'}
        onChange={(e) => {
          if (e.target.value) onFolder(e.target.value)
        }}
      >
        <option value="">{folderOptions.length === 0 ? '没有文件夹' : '加入文件夹'}</option>
        {folderOptions.map((row) => (
          <option key={row.id} value={row.id}>
            {`${'· '.repeat(row.depth)}${row.name}`}
          </option>
        ))}
      </select>
      <select
        value=""
        disabled={tagOptions.length === 0}
        title={tagOptions.length === 0 ? '先在侧栏新建标签' : '添加标签'}
        onChange={(e) => {
          if (e.target.value) onTag(e.target.value)
        }}
      >
        <option value="">{tagOptions.length === 0 ? '没有标签' : '添加标签'}</option>
        {tagOptions.map((row) => (
          <option key={row.id} value={row.id}>
            {`${'· '.repeat(row.depth)}${row.name}`}
          </option>
        ))}
      </select>
      <button className="btn-ghost sm" onClick={onRename}>
        重命名
      </button>
      <button className="btn-ghost sm" onClick={onExport}>
        导出
      </button>
      {onLeave && (
        <button className="btn-ghost sm" onClick={onLeave}>
          移出此文件夹
        </button>
      )}
      {scope === 'trash' && (
        <button className="btn-ghost sm" onClick={onRestore}>
          还原
        </button>
      )}
      <button className="btn-ghost sm" onClick={onTrash}>
        {scope === 'trash' ? '从索引删除' : '移入回收站'}
      </button>
      <button className="btn-ghost sm batch-clear" onClick={onClear}>
        取消选择
      </button>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 侧栏
// ────────────────────────────────────────────────────────────

/**
 * 侧栏拖放上下文。
 *
 * 把「当前高亮的是哪个目标 + 三个事件」打包传下去，
 * 比给每个 Row 传 4 个独立 prop 清爽，也避免层层透传时漏参数。
 */
interface DropApi {
  /** 当前悬停的投放目标，用于高亮 */
  target: DropTarget | null
  over: (t: DropTarget) => void
  leave: () => void
  drop: (t: DropTarget, e: React.DragEvent) => void
}

interface SidebarProps {
  library: Library
  tags: Tag[]
  folders: Folder[]
  smartFolders: SmartFolder[]
  stats: LibraryStats | null
  exts: { ext: string; count: number }[]
  scope: ItemScope
  activeFolder: string | null
  activeTags: string[]
  activeExt: string | null
  activeExts: string[]
  activeSmartId: string | null
  ocrReason: string | null
  onScope: (scope: ItemScope) => void
  onFolder: (id: string | null) => void
  onTag: (id: string) => void
  onExt: (ext: string | null) => void
  onSmart: (id: string) => void
  onSaveSmart: () => void
  onSmartMenu: (id: string, x: number, y: number) => void
  onNewFolder: () => void
  onNewTag: () => void
  onSideMenu: (kind: 'folder' | 'tag', id: string, x: number, y: number) => void
  onOpenConnect: () => void
  onSwitchLibrary: () => void
  onCloseLibrary: () => void
  dropApi: DropApi
}

function Sidebar({
  library,
  tags,
  folders,
  smartFolders,
  stats,
  exts,
  scope,
  activeFolder,
  activeTags,
  activeExt,
  activeExts,
  activeSmartId,
  ocrReason,
  onScope,
  onFolder,
  onTag,
  onExt,
  onSmart,
  onSaveSmart,
  onSmartMenu,
  onNewFolder,
  onNewTag,
  onSideMenu,
  onOpenConnect,
  onSwitchLibrary,
  onCloseLibrary,
  dropApi,
}: SidebarProps): React.JSX.Element {
  const [watches, setWatches] = useState<WatchFolder[]>([])
  const [watchError, setWatchError] = useState('')

  useEffect(() => {
    let cancel = false
    void window.aerie.watch.list().then((rows) => {
      if (!cancel) setWatches(rows)
    })
    return () => {
      cancel = true
    }
  }, [library.id])

  const reloadWatches = (): void => {
    void window.aerie.watch.list().then(setWatches)
  }
  const smart: { id: ItemScope; label: string; count?: number }[] = [
    { id: 'active', label: '全部素材', count: stats?.active },
    { id: 'uncategorized', label: '未分类', count: stats?.uncategorized },
    { id: 'untagged', label: '未标签', count: stats?.untagged },
    { id: 'starred', label: '已评分', count: stats?.starred },
    { id: 'duplicates', label: '重复项', count: stats?.duplicates },
    { id: 'missing', label: '缺失', count: stats?.missing },
    { id: 'trash', label: '回收站', count: stats?.trash },
  ]

  return (
    <aside className="sidebar">
      <div className="sidebar-head drag-region">
        <button
          className="lib-switch no-drag"
          title={`${library.path}\n点击切换资源库`}
          onClick={onSwitchLibrary}
        >
          <div className="lib-name">{library.name}</div>
          <div className="lib-count">{library.itemCount.toLocaleString()} 个素材</div>
        </button>
      </div>

      <div className="sidebar-body">
        <section>
          {smart.map((row) => (
            <button
              key={row.id}
              className={`nav-row ${scope === row.id && activeFolder === null && activeTags.length === 0 && activeSmartId === null ? 'is-active' : ''}`}
              onClick={() => onScope(row.id)}
            >
              <span className="nav-icon">
                <NavIcon scope={row.id} />
              </span>
              <span className="nav-label">{row.label}</span>
              {typeof row.count === 'number' && row.count > 0 && (
                <span className="nav-count">{row.count}</span>
              )}
            </button>
          ))}
        </section>

        <section>
          <div className="sec-head">
            <span>智能文件夹</span>
            <button className="sec-add" onClick={onSaveSmart} title="用当前筛选保存">
              +
            </button>
          </div>
          {smartFolders.length === 0 && <div className="empty-hint">把当前筛选存下来</div>}
          {smartFolders.map((folder) => (
            <button
              key={folder.id}
              className={`nav-row ${activeSmartId === folder.id ? 'is-active' : ''}`}
              title={describeRules(folder.rules)}
              onClick={() => onSmart(folder.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                onSmartMenu(folder.id, e.clientX, e.clientY)
              }}
            >
              <span className="nav-icon">✧</span>
              <span className="nav-label">{folder.name}</span>
            </button>
          ))}
        </section>

        <section>
          <div className="sec-head">
            <span>文件夹</span>
            <button className="sec-add" onClick={onNewFolder} title="新建文件夹">
              +
            </button>
          </div>
          {folders.length === 0 && <div className="empty-hint">还没有文件夹</div>}
          {folders
            .filter((f) => f.parentId === null)
            .map((f) => (
              <FolderRow
                key={f.id}
                folder={f}
                all={folders}
                depth={0}
                active={activeFolder}
                onPick={onFolder}
                onMenu={(id, x, y) => onSideMenu('folder', id, x, y)}
                dropApi={dropApi}
              />
            ))}
        </section>

        <section>
          <div className="sec-head">
            <span>标签</span>
            <button className="sec-add" onClick={onNewTag} title="新建标签">
              +
            </button>
          </div>
          {tags.length === 0 && <div className="empty-hint">还没有标签</div>}
          {tags
            .filter((t) => t.parentId === null)
            .map((t) => (
              <TagRow
                key={t.id}
                tag={t}
                all={tags}
                depth={0}
                active={activeTags}
                onPick={onTag}
                onMenu={(id, x, y) => onSideMenu('tag', id, x, y)}
                dropApi={dropApi}
              />
            ))}
        </section>

        <section>
          <div className="sec-head">
            <span>监视</span>
            <button
              className="sec-add"
              title="新文件自动进库"
              onClick={() => {
                void (async () => {
                  const dir = await window.aerie.dialog.pickFolder()
                  if (!dir) return
                  try {
                    await window.aerie.watch.add(dir)
                    setWatchError('')
                    reloadWatches()
                  } catch (err) {
                    setWatchError(explainIpc(err))
                  }
                })()
              }}
            >
              +
            </button>
          </div>
          {watches.length === 0 && <div className="empty-hint">新放进来的文件会自动导入</div>}
          {watches.map((row) => (
            <div key={row.id} className="nav-row" title={row.path}>
              <span className="nav-label">{row.path.split('/').pop()}</span>
              <button
                className="sec-add"
                title="停止监视"
                onClick={() => {
                  void window.aerie.watch.remove(row.id).then(reloadWatches)
                }}
              >
                ×
              </button>
            </div>
          ))}
          {watchError && <div className="watch-error">{watchError}</div>}
        </section>

        <section>
          <div className="sec-head">
            <span>格式</span>
            {(activeExt || activeExts.length > 0) && (
              <button className="sec-add" onClick={() => onExt(null)} title="清除格式筛选">
                ×
              </button>
            )}
          </div>
          {exts.slice(0, 12).map((row) => (
            <button
              key={row.ext}
              className={`nav-row ${activeExt === row.ext || activeExts.includes(row.ext) ? 'is-active' : ''}`}
              onClick={() => onExt(activeExt === row.ext ? null : row.ext)}
            >
              <span className="nav-label">{row.ext.toUpperCase()}</span>
              <span className="nav-count">{row.count}</span>
            </button>
          ))}
        </section>
      </div>

      <div className="sidebar-foot">
        <span className="mode-badge">{library.storageMode === 'reference' ? '引用模式' : '复制模式'}</span>
        <div className="foot-actions">
          <button onClick={onOpenConnect}>收藏与识别</button>
          <button onClick={onSwitchLibrary}>切换库</button>
          <button onClick={onCloseLibrary}>关闭库</button>
        </div>
        {ocrReason && <div className="empty-hint">{ocrReason}</div>}
      </div>
    </aside>
  )
}

function FolderRow({
  folder,
  all,
  depth,
  active,
  onPick,
  onMenu,
  dropApi,
}: {
  folder: Folder
  all: Folder[]
  depth: number
  active: string | null
  onPick: (id: string) => void
  onMenu: (id: string, x: number, y: number) => void
  dropApi: DropApi
}): React.JSX.Element {
  const children = all.filter((f) => f.parentId === folder.id)
  const me: DropTarget = { kind: 'folder', id: folder.id }
  const isOver = dropApi.target?.kind === 'folder' && dropApi.target.id === folder.id
  return (
    <>
      <button
        className={`nav-row ${active === folder.id ? 'is-active' : ''} ${isOver ? 'is-drop' : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => onPick(folder.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu(folder.id, e.clientX, e.clientY)
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(ITEM_DRAG_MIME)) return
          // 不 preventDefault 就不会触发 drop
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          dropApi.over(me)
        }}
        onDragLeave={() => dropApi.leave()}
        onDrop={(e) => dropApi.drop(me, e)}
      >
        {folder.coverItemId ? (
          <img
            className="folder-cover"
            src={`aerie-thumb://sm/${folder.coverItemId}`}
            alt=""
            style={folder.color ? { boxShadow: `inset 0 0 0 1px ${folder.color}` } : undefined}
          />
        ) : (
          <span className="nav-icon" style={{ color: folder.color ?? undefined }}>
            ▸
          </span>
        )}
        <span className="nav-label">{folder.name}</span>
        {folder.count > 0 && <span className="nav-count">{folder.count}</span>}
      </button>
      {children.map((c) => (
        <FolderRow
          key={c.id}
          folder={c}
          all={all}
          depth={depth + 1}
          active={active}
          onPick={onPick}
          onMenu={onMenu}
          dropApi={dropApi}
        />
      ))}
    </>
  )
}

function TagRow({
  tag,
  all,
  depth,
  active,
  onPick,
  onMenu,
  dropApi,
}: {
  tag: Tag
  all: Tag[]
  depth: number
  active: string[]
  onPick: (id: string) => void
  onMenu: (id: string, x: number, y: number) => void
  dropApi: DropApi
}): React.JSX.Element {
  const children = all.filter((t) => t.parentId === tag.id)
  const isOn = active.includes(tag.id)
  const me: DropTarget = { kind: 'tag', id: tag.id }
  const isOver = dropApi.target?.kind === 'tag' && dropApi.target.id === tag.id
  return (
    <>
      <button
        className={`nav-row ${isOn ? 'is-active' : ''} ${isOver ? 'is-drop' : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => onPick(tag.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu(tag.id, e.clientX, e.clientY)
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(ITEM_DRAG_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          dropApi.over(me)
        }}
        onDragLeave={() => dropApi.leave()}
        onDrop={(e) => dropApi.drop(me, e)}
      >
        <span className="tag-dot" style={{ background: tag.color ?? 'var(--accent)' }} />
        <span className="nav-label">{tag.name}</span>
        {tag.count > 0 && <span className="nav-count">{tag.count}</span>}
      </button>
      {children.map((c) => (
        <TagRow
          key={c.id}
          tag={c}
          all={all}
          depth={depth + 1}
          active={active}
          onPick={onPick}
          onMenu={onMenu}
          dropApi={dropApi}
        />
      ))}
    </>
  )
}

// ────────────────────────────────────────────────────────────
// 详情面板
// ────────────────────────────────────────────────────────────

function Inspector({
  item,
  onClose,
  onUpdate,
  onOpen,
  onMutate,
  onRelink,
}: {
  item: Item | null
  onClose: () => void
  onUpdate: (patch: Partial<Pick<Item, 'name' | 'annotation' | 'star' | 'url'>>) => void
  onOpen: () => void
  onMutate: () => void
  onRelink: (id: string) => void
}): React.JSX.Element | null {
  const [name, setName] = useState('')
  const [annotation, setAnnotation] = useState('')
  const [url, setUrl] = useState('')
  const [detail, setDetail] = useState<ItemDetail | null>(null)

  useEffect(() => {
    setName(item?.name ?? '')
    setAnnotation(item?.annotation ?? '')
    setUrl(item?.url ?? '')
  }, [item?.id, item?.name, item?.annotation, item?.url])

  useEffect(() => {
    if (!item) {
      setDetail(null)
      return
    }
    let cancelled = false
    void window.aerie.items.get(item.id).then((next) => {
      if (!cancelled) setDetail(next)
    })
    return () => {
      cancelled = true
    }
  }, [item?.id, item?.star, item?.name])

  if (!item) return null

  return (
    <aside className="inspector">
      <div className="insp-head">
        <span>属性</span>
        <button className="icon-btn" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="insp-preview" onClick={onOpen} title="打开大图">
        <img src={`aerie-thumb://lg/${item.id}`} alt={item.name} draggable={false} />
      </div>

      <div className="insp-body">
        {item.missing && (
          <div className="missing-banner">
            原文件不在记录的路径上。
            <button className="btn-ghost sm" onClick={() => onRelink(item.id)}>
              重新定位
            </button>
          </div>
        )}
        <label className="field">
          <span>名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const next = name.trim()
              if (next && next !== item.name) onUpdate({ name: next })
              else setName(item.name)
            }}
          />
        </label>

        {item.palette.length > 0 && (
          <div className="field">
            <span>主色</span>
            <div className="palette-row">
              {item.palette.map((hex) => (
                <i key={hex} style={{ background: `#${hex}` }} title={`#${hex}`} />
              ))}
            </div>
          </div>
        )}

        <label className="field">
          <span>来源</span>
          <input
            value={url}
            placeholder="https://"
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => onUpdate({ url: url.trim() || null })}
          />
        </label>

        <label className="field">
          <span>备注</span>
          <textarea
            rows={3}
            value={annotation}
            placeholder="写点什么…"
            onChange={(e) => setAnnotation(e.target.value)}
            onBlur={() => onUpdate({ annotation })}
          />
        </label>

        <div className="field">
          <span>评分</span>
          <div className="stars">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={`star ${n <= item.star ? 'is-on' : ''}`}
                onClick={() => onUpdate({ star: n === item.star ? 0 : n })}
              >
                ★
              </button>
            ))}
          </div>
        </div>

        <dl className="meta-list">
          <dt>格式</dt>
          <dd>{item.ext.toUpperCase()}</dd>
          <dt>尺寸</dt>
          <dd>{item.width && item.height ? `${item.width} × ${item.height}` : '—'}</dd>
          <dt>大小</dt>
          <dd>{formatSize(item.fileSize)}</dd>
          <dt>修改</dt>
          <dd>{new Date(item.mtime).toLocaleDateString('zh-CN')}</dd>
          <dt>拍摄</dt>
          <dd>
            {item.takenAt
              ? new Date(item.takenAt).toLocaleString('zh-CN', { hour12: false })
              : '—'}
          </dd>
        </dl>

        {detail && detail.tags.length > 0 && (
          <div className="field">
            <span>标签</span>
            <div className="chip-row">
              {detail.tags.map((tag) => (
                <button
                  key={tag.id}
                  className="chip"
                  onClick={() => {
                    void window.aerie.tags.unassign([item.id], [tag.id]).then(onMutate)
                  }}
                  title="移除标签"
                >
                  {tag.name} ×
                </button>
              ))}
            </div>
          </div>
        )}

        {detail && detail.folders.length > 0 && (
          <div className="field">
            <span>文件夹</span>
            <div className="chip-row">
              {detail.folders.map((folder) => (
                <button
                  key={folder.id}
                  className="chip"
                  title="移出此文件夹"
                  onClick={() => {
                    void window.aerie.folders.unassign([item.id], [folder.id]).then(onMutate)
                  }}
                >
                  {folder.name} ×
                </button>
              ))}
            </div>
          </div>
        )}

        <button className="btn-ghost full" onClick={onOpen}>
          打开大图
        </button>
        <button className="btn-ghost full" onClick={() => void window.aerie.items.open(item.id)}>
          用默认应用打开
        </button>
        <button
          className="btn-ghost full"
          onClick={() => window.aerie.shell.reveal(item.filePath)}
        >
          在访达中显示
        </button>
        <div className="path-hint" title={item.filePath}>
          {item.filePath}
        </div>
      </div>
    </aside>
  )
}

// ────────────────────────────────────────────────────────────
// 空状态 / 欢迎页
// ────────────────────────────────────────────────────────────

function Welcome({
  onOpen,
  onCreate,
  recent,
  onOpenRecent,
  error,
}: {
  onOpen: () => void
  onCreate: (mode: StorageMode) => void
  recent: { path: string; name: string }[]
  onOpenRecent: (path: string) => void
  error?: string
}): React.JSX.Element {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>影巢</h1>
        <p className="tagline">本地优先的素材库。文件始终属于你。</p>

          <div className="welcome-choices">
          <button className="choice is-primary" onClick={() => onCreate('reference')}>
            <span className="choice-title">引用库</span>
            <span className="choice-sub">原图留在原地，只建索引。删库不会删照片。</span>
          </button>
          <button className="choice" onClick={() => onCreate('copy')}>
            <span className="choice-title">复制库</span>
            <span className="choice-sub">导入时把文件拷进库里，适合要单独带走的素材。</span>
          </button>
        </div>
        <div className="welcome-actions">
          <button className="btn-ghost" onClick={onOpen}>
            打开已有库
          </button>
        </div>

        {recent.length > 0 && (
          <div className="recent">
            <div className="recent-head">最近打开</div>
            {recent.slice(0, 5).map((r) => (
              <button key={r.path} className="recent-row" onClick={() => onOpenRecent(r.path)} title={r.path}>
                <span className="recent-name">{r.name}</span>
                <span className="recent-path">{r.path}</span>
              </button>
            ))}
          </div>
        )}

        {error && <p className="welcome-error">{error}</p>}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 主应用
// ────────────────────────────────────────────────────────────

function App(): React.JSX.Element {
  const [library, setLibrary] = useState<Library | null>(null)
  const [recent, setRecent] = useState<{ path: string; name: string; openedAt: number }[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [total, setTotal] = useState(0)
  /**
   * 数据是否已全部在内存里。
   * true  → 小库模式：items 就是全部，Grid 只虚拟化 DOM，永不 seek
   * false → 大库模式：items 只是当前窗口，靠游标续页
   */
  const [complete, setComplete] = useState(true)
  /** 首次加载中（大库全量读取需要几百毫秒） */
  const [loading, setLoading] = useState(false)
  /** 缩略图磁盘占用，null 表示还没取到 */
  const [thumbStats, setThumbStats] = useState<ThumbStats | null>(null)
  /** 正在往窗口里拖东西 */
  const [dragging, setDragging] = useState(false)
  /** 侧栏当前悬停的投放目标 */
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  // 以下四项只在「大库模式」下有意义
  const [nextCursor, setNextCursor] = useState<Cursor | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  // items[0] 的绝对位置。seek 后窗口不再从 0 开始。
  const [windowStart, setWindowStart] = useState(0)
  const [jumpTo, setJumpTo] = useState<{ index: number; seq: number } | null>(null)
  // 网格列数（由 Grid 上报）。seek 时用来把目标对齐到整行起点。
  const colsRef = useRef(6)
  const [tags, setTags] = useState<Tag[]>([])
  const [folders, setFolders] = useState<Folder[]>([])

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search, 180)
  const [activeFolder, setActiveFolder] = useState<string | null>(null)
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [inspectorId, setInspectorId] = useState<string | null>(null)
  const [cardSize, setCardSize] = useState(168)
  const [layout, setLayout] = useState<BrowseLayout>('grid')
  const placesRef = useRef<CardPlace[] | null>(null)
  const onPlaces = useCallback((places: CardPlace[] | null) => {
    placesRef.current = places
  }, [])
  const [scope, setScope] = useState<ItemScope>('active')
  const [sort, setSort] = useState<SortField>('addedAt')
  const [order, setOrder] = useState<SortOrder>('desc')
  const [hue, setHue] = useState<HueId | null>(null)
  const [orientation, setOrientation] = useState<Orientation | null>(null)
  const [extFilter, setExtFilter] = useState<string | null>(null)
  const [extList, setExtList] = useState<string[] | null>(null)
  const [minStar, setMinStar] = useState(0)
  const [minSize, setMinSize] = useState<number | undefined>(undefined)
  const [maxSize, setMaxSize] = useState<number | undefined>(undefined)
  const [addedFrom, setAddedFrom] = useState<number | undefined>(undefined)
  const [addedTo, setAddedTo] = useState<number | undefined>(undefined)
  const [takenFrom, setTakenFrom] = useState<number | undefined>(undefined)
  const [takenTo, setTakenTo] = useState<number | undefined>(undefined)
  const [smartFlags, setSmartFlags] = useState<{ uncategorized?: boolean; untagged?: boolean }>({})
  const [smartFolders, setSmartFolders] = useState<SmartFolder[]>([])
  const [activeSmartId, setActiveSmartId] = useState<string | null>(null)
  const [smartMenu, setSmartMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [saveSmartOpen, setSaveSmartOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [ocrStatus, setOcrStatus] = useState<OcrStatus | null>(null)
  const [exts, setExts] = useState<{ ext: string; count: number }[]>([])
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [itemMenu, setItemMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [sideMenu, setSideMenu] = useState<{ x: number; y: number; kind: 'folder' | 'tag'; id: string } | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [similar, setSimilar] = useState<SimilarScan | null>(null)
  const [reorderHover, setReorderHover] = useState<string | null>(null)

  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [status, setStatus] = useState<string>('')
  const [welcomeError, setWelcomeError] = useState('')

  const lastClicked = useRef<string | null>(null)
  const resetBrowseRef = useRef<() => void>(() => {})

  // ── 启动时读取当前库 ──
  useEffect(() => {
    void (async () => {
      const [cur, rec] = await Promise.all([
        window.aerie.library.current(),
        window.aerie.library.recent(),
      ])
      setLibrary(cur)
      setRecent(rec)
      if (cur) await refreshAll()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


  // ── 查询 ──
  // 点中智能文件夹时，以保存的规则为准，避免和侧栏上一次的筛选叠出两套条件。
  // 用户再改筛选，就退出这条规则，改用当前控件。
  const widgetQuery = useMemo<QueryOptions>(
    () => ({
      search: debouncedSearch || undefined,
      folderId: scope === 'active' ? (activeFolder ?? undefined) : undefined,
      tagIds: activeTags.length > 0 ? activeTags : undefined,
      scope,
      hue: hue ?? undefined,
      orientation: orientation ?? undefined,
      exts: extList ?? (extFilter ? [extFilter] : undefined),
      minStar: minStar > 0 ? minStar : undefined,
      minSize,
      maxSize,
      addedFrom,
      addedTo,
      takenFrom,
      takenTo,
      uncategorized: smartFlags.uncategorized || undefined,
      untagged: smartFlags.untagged || undefined,
      sort,
      order,
    }),
    [
      debouncedSearch,
      activeFolder,
      activeTags,
      scope,
      hue,
      orientation,
      extFilter,
      extList,
      minStar,
      minSize,
      maxSize,
      addedFrom,
      addedTo,
      takenFrom,
      takenTo,
      smartFlags,
      sort,
      order,
    ],
  )

  const activeSmart = smartFolders.find((folder) => folder.id === activeSmartId) ?? null
  const query = useMemo<QueryOptions>(
    () => (activeSmart ? rulesToQuery(activeSmart.rules, { sort, order }) : widgetQuery),
    [activeSmart, sort, order, widgetQuery],
  )

  const applySmart = useCallback((folder: SmartFolder): void => {
    const rules = folder.rules
    setActiveSmartId(folder.id)
    setSearch(rules.keyword ?? '')
    setActiveTags(rules.tagIds ?? [])
    setActiveFolder(null)
    setHue(rules.hue ?? null)
    setOrientation(rules.orientation ?? null)
    setMinStar(rules.minStar ?? 0)
    if (rules.exts && rules.exts.length > 1) {
      setExtFilter(null)
      setExtList(rules.exts)
    } else {
      setExtList(null)
      setExtFilter(rules.exts?.[0] ?? null)
    }
    setMinSize(rules.minSize)
    setMaxSize(rules.maxSize)
    setAddedFrom(rules.addedFrom)
    setAddedTo(rules.addedTo)
    setTakenFrom(rules.takenFrom)
    setTakenTo(rules.takenTo)
    if (rules.uncategorized && rules.untagged) {
      setScope('active')
      setSmartFlags({ uncategorized: true, untagged: true })
    } else if (rules.uncategorized) {
      setScope('uncategorized')
      setSmartFlags({})
    } else if (rules.untagged) {
      setScope('untagged')
      setSmartFlags({})
    } else {
      setScope('active')
      setSmartFlags({})
    }
  }, [])

  const captureRules = useCallback((): SmartFolderRules => {
    if (activeSmart) return activeSmart.rules
    return normalizeRules({
      exts: extList ?? (extFilter ? [extFilter] : undefined),
      minStar: minStar > 0 ? minStar : undefined,
      hue: hue ?? undefined,
      orientation: orientation ?? undefined,
      keyword: search.trim() || undefined,
      tagIds: activeTags.length > 0 ? activeTags : undefined,
      uncategorized: scope === 'uncategorized' || smartFlags.uncategorized || undefined,
      untagged: scope === 'untagged' || smartFlags.untagged || undefined,
      minSize,
      maxSize,
      addedFrom,
      addedTo,
      takenFrom,
      takenTo,
    })
  }, [
    activeSmart,
    extList,
    extFilter,
    minStar,
    hue,
    orientation,
    search,
    activeTags,
    scope,
    smartFlags,
    minSize,
    maxSize,
    addedFrom,
    addedTo,
    takenFrom,
    takenTo,
  ])

  const resetSmartExtras = useCallback((): void => {
    setActiveSmartId(null)
    setExtList(null)
    setMinSize(undefined)
    setMaxSize(undefined)
    setAddedFrom(undefined)
    setAddedTo(undefined)
    setTakenFrom(undefined)
    setTakenTo(undefined)
    setSmartFlags({})
  }, [])

  // ── 加载策略 ──────────────────────────────────────────────
  //
  // 借鉴 Eagle 的做法：小库直接把全部条目读进内存，只虚拟化 DOM。
  // 这样滚动条就是「真实位置」，不存在 seek、窗口对齐、骨架屏这些
  // 因为分页才产生的复杂度——用户滚到哪里，数据就在那里。
  //
  // 代价是内存：一条精简 item 约 200 字节，10 万条 ≈ 20 MB，很安全。
  // Eagle 官方承认超过 100 万文件会 OOM，正是全量入内存的天花板。
  // 所以这里设阈值：超过 10 万条自动退回游标分页，保住大库不崩。
  const FULL_LOAD_LIMIT = 100_000
  const PAGE_SIZE = 300

  /**
   * 拉数据。两档策略，对应两种规模的库：
   *
   *   total ≤ 10万 → 一次全量读进内存（Eagle 的做法）
   *   total > 10万 → 游标分页，保住百万级不死
   *
   * 为什么阈值是 10 万：实测全量 IPC 耗时
   *   1 万 → 12ms / 10 万 → 141ms(SQL) + 446ms(IPC 18MB) / 50 万 → 1233ms / 100 万 → 2938ms
   * 10 万是「用户感知不到」与「内存/耗时可控」的平衡点。
   */
  const loadLibrary = useCallback(
    async (): Promise<{
      items: Item[]
      total: number
      nextCursor: Cursor | null
      /** 数据是否已经全部在内存里 */
      complete: boolean
    }> => {
      // 先探总数（只取 1 行，100 万条实测 0.1ms），避免无脑拉 10 万行
      const probe = await window.aerie.items.query({ ...query, limit: 1 })
      const total = probe.total
      if (total === 0) return { items: [], total: 0, nextCursor: null, complete: true }

      if (total <= FULL_LOAD_LIMIT) {
        const res = await window.aerie.items.query({ ...query, limit: total })
        return { items: res.items, total, nextCursor: null, complete: true }
      }

      const res = await window.aerie.items.query({ ...query, limit: PAGE_SIZE })
      return { items: res.items, total, nextCursor: res.nextCursor, complete: false }
    },
    [query],
  )

  // 查询变化 → 重置并加载
  useEffect(() => {
    if (!library) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      const r = await loadLibrary()
      if (cancelled) return
      setItems(r.items)
      setTotal(r.total)
      setNextCursor(r.nextCursor)
      setComplete(r.complete)
      setWindowStart(0)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [loadLibrary, library])

  // 重新加载（导入、删除、编辑后调用）
  const reload = useCallback(async (): Promise<void> => {
    if (!library) return
    setLoading(true)
    const r = await loadLibrary()
    setItems(r.items)
    setTotal(r.total)
    setNextCursor(r.nextCursor)
    setComplete(r.complete)
    setWindowStart(0)
    setLoading(false)
  }, [library, loadLibrary])

  // 缩略图占用：库变化时取一次，之后每分钟刷新
  useEffect(() => {
    if (!library) {
      setThumbStats(null)
      return
    }
    let cancelled = false
    const pull = (): void => {
      void window.aerie.thumbs
        .stats()
        .then((s) => {
          if (!cancelled) setThumbStats(s)
        })
        .catch(() => undefined)
    }
    pull()
    const timer = setInterval(pull, 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [library, items.length])

  // 滚动条跳转：先 seek 拿到该位置的游标，再从那里加载一页
  const handleSeek = useCallback(
    async (percent: number): Promise<void> => {
      if (!library) return
      const cols = colsRef.current
      const raw = Math.floor(percent * total)
      // 对齐到整行起点：否则窗口第一行会有几格在窗口外，显示成骨架
      const aligned = Math.floor(raw / cols) * cols

      // 直接传行号，不传百分比：百分比要来回乘除，浮点在边界上会漂 1 行
      const cursor = await window.aerie.items.seek(query, aligned)
      const res = await window.aerie.items.query({
        ...query,
        limit: PAGE_SIZE,
        cursor: cursor ?? undefined,
      })
      const target = aligned
      setWindowStart(target)
      setItems(res.items)
      setTotal(res.total)
      setNextCursor(res.nextCursor)
      // 让目标行对齐视口顶部，否则内容会和滚动条位置错位
      setJumpTo((prev) => ({ index: target, seq: (prev?.seq ?? 0) + 1 }))
    },
    [library, query, total],
  )

  // 续页：滚到底部时追加
  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingMore || !nextCursor || !library) return
    setLoadingMore(true)
    try {
      const res = await window.aerie.items.query({
        ...query,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      })
      setItems((prev) => [...prev, ...res.items])
      setNextCursor(res.nextCursor)
      setTotal(res.total)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, nextCursor, library, query])

  const refreshAll = useCallback(async (): Promise<void> => {
    const [cur, t, f, s, e, smart, ocr] = await Promise.all([
      window.aerie.library.current(),
      window.aerie.tags.list().catch(() => [] as Tag[]),
      window.aerie.folders.list().catch(() => [] as Folder[]),
      window.aerie.library.stats().catch(() => null),
      window.aerie.library.extStats().catch(() => [] as { ext: string; count: number }[]),
      window.aerie.smartFolders.list().catch(() => [] as SmartFolder[]),
      window.aerie.ocr.status().catch(() => null),
    ])
    setLibrary(cur)
    setTags(t)
    setFolders(f)
    setStats(s)
    setExts(e)
    setSmartFolders(smart)
    setOcrStatus(ocr)
  }, [])

  useEffect(() => {
    let doneTimer: number | null = null
    const unsub = window.aerie.import.onProgress((p) => {
      if (doneTimer) {
        window.clearTimeout(doneTimer)
        doneTimer = null
      }
      if (p.phase === 'done') {
        // 短暂停在「完成」，别一闪就消失
        setProgress({ ...p, done: Math.max(p.done, p.total, 1), total: Math.max(p.total, 1) })
        void refreshAll()
        void reload()
        doneTimer = window.setTimeout(() => {
          setProgress(null)
          doneTimer = null
        }, 1200)
        return
      }
      setProgress(p)
    })
    return () => {
      if (doneTimer) window.clearTimeout(doneTimer)
      unsub()
    }
  }, [refreshAll, reload])

  useEffect(() => {
    if (!library) return
    return window.aerie.ingest.onSaved(() => {
      void refreshAll()
      void reload()
    })
  }, [library, refreshAll, reload])

  // ── 选择逻辑（支持 Cmd 多选、Shift 连选）──
  const handleSelect = useCallback(
    (id: string, mods: { meta: boolean; shift: boolean }) => {
      setSelected((prev) => {
        const next = new Set(prev)
        if (mods.shift && lastClicked.current) {
          const a = items.findIndex((i) => i.id === lastClicked.current)
          const b = items.findIndex((i) => i.id === id)
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a]
            for (let i = lo; i <= hi; i++) next.add(items[i].id)
            return next
          }
        }
        if (mods.meta) {
          if (next.has(id)) next.delete(id)
          else next.add(id)
        } else {
          next.clear()
          next.add(id)
        }
        lastClicked.current = id
        return next
      })
    },
    [items],
  )

  // ── 导入 ──
  /** 统一的导入执行：文件列表和文件夹拖拽都走这里 */
  const runImportPaths = useCallback(
    async (paths: string[]): Promise<void> => {
      if (!library || paths.length === 0) return
      setStatus('扫描中…')
      const res = await window.aerie.import.start({
        libraryId: library.id,
        paths,
        recursive: true,
      })
      setStatus(`导入 ${res.imported} 项，跳过 ${res.skipped} 项`)
      await refreshAll()
      await reload()
      setTimeout(() => setStatus(''), 4000)
    },
    [library, refreshAll, reload],
  )

  const doImportFiles = useCallback(async (): Promise<void> => {
    if (!library) return
    const paths = await window.aerie.dialog.pickFiles()
    if (paths.length === 0) return
    await runImportPaths(paths)
  }, [library, runImportPaths])

  /** 从对话框选文件夹导入 */
  const doImportFolder = useCallback(async (): Promise<void> => {
    if (!library) return
    const dir = await window.aerie.dialog.pickFolder()
    if (!dir) return
    await runImportPaths([dir])
  }, [library, runImportPaths])

  // ── 卡片拖到侧栏（加入文件夹 / 打标签）──

  /** 拖起一张卡片：如果它在选区里，就整批拖 */
  const onItemDragStart = useCallback(
    (id: string): string[] => {
      return selected.has(id) ? Array.from(selected) : [id]
    },
    [selected],
  )

  const dropApi: DropApi = useMemo(
    () => ({
      target: dropTarget,
      over: (t) => {
        setDropTarget((prev) =>
          prev && prev.kind === t.kind && prev.id === t.id ? prev : t,
        )
      },
      leave: () => setDropTarget(null),
      drop: (t, e) => {
        e.preventDefault()
        e.stopPropagation()
        setDropTarget(null)

        let ids: string[] = []
        try {
          const raw = e.dataTransfer.getData(ITEM_DRAG_MIME)
          if (raw) ids = JSON.parse(raw) as string[]
        } catch {
          // 数据坏了就当没拖
        }
        if (ids.length === 0) return

        void (async () => {
          try {
            if (t.kind === 'folder') {
              const name = folders.find((f) => f.id === t.id)?.name ?? '文件夹'

              // 语义对齐 Eagle：默认「移动」，按住 Alt 才是「加入」。
              //
              // Eagle 的 classifySelected 里，非 Alt 时会先把条目从
              // 当前文件夹移除，再加入目标——因为文件夹在用户心里是
              // 「东西放在哪个格子」的空间隐喻，从 A 拖到 B 却两边都在
              // 会让人困惑。Alt 才是「同时属于两个格子」。
              //
              // 只有正在看某个文件夹时「移动」才有意义；在「全部素材」
              // 下没有来源文件夹可移除，退化成纯加入。
              const moving = !e.altKey && activeFolder !== null && activeFolder !== t.id

              if (moving) {
                await window.aerie.folders.unassign(ids, [activeFolder])
              }
              await window.aerie.folders.assign(ids, [t.id])

              setStatus(
                moving
                  ? `已把 ${ids.length} 项移到「${name}」（按住 Alt 拖是加入）`
                  : `已把 ${ids.length} 项加入「${name}」`,
              )
            } else {
              // 标签是「分类标记」而不是「位置」，所以永远是叠加，
              // 不存在「移走」这回事。这一点和 Eagle 不同——它侧栏
              // 的标签根本不接收拖放，我们做得更完整。
              await window.aerie.tags.assign(ids, [t.id])
              const name = tags.find((x) => x.id === t.id)?.name ?? '标签'
              setStatus(`已给 ${ids.length} 项打上「${name}」`)
            }
            await refreshAll()
            setTimeout(() => setStatus(''), 4000)
          } catch (err) {
            setStatus(`操作失败：${String(err)}`)
            setTimeout(() => setStatus(''), 6000)
          }
        })()
      },
    }),
    [dropTarget, folders, tags, activeFolder, refreshAll],
  )

  // ── 拖拽导入 ──
  //
  // 关键点：dragenter/dragleave 会在子元素之间反复触发，
  // 直接用它们控制遮罩会疯狂闪烁。用计数器抵消进出事件才稳定。
  const dragDepth = useRef(0)

  const onDragEnter = useCallback((e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current++
    if (dragDepth.current === 1) setDragging(true)
  }, [])

  const onDragOver = useCallback((e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    // 不 preventDefault 的话 drop 事件不会触发
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent): void => {
      // 内部卡片拖拽走自己的 MIME，这里只处理从系统拖进来的文件
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      if (!library) return

      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return

      // File.path 在 Electron 32 已移除，必须走 webUtils
      const paths: string[] = []
      for (const f of files) {
        try {
          const p = window.aerie.files.pathFor(f)
          if (p) paths.push(p)
        } catch {
          // 极少数情况下拿不到路径（比如从某些虚拟来源拖入）
        }
      }
      if (paths.length === 0) {
        setStatus('无法读取拖入文件的路径')
        setTimeout(() => setStatus(''), 3000)
        return
      }
      void runImportPaths(paths)
    },
    [library, runImportPaths],
  )

  // ── 库操作 ──
  const doCreateLibrary = useCallback(async (mode: StorageMode): Promise<void> => {
    const dir = await window.aerie.dialog.pickNewLibrary(
      mode === 'copy' ? '选择复制库的存放位置' : '选择引用库的存放位置',
    )
    if (!dir) return
    const name = dir.split('/').pop() ?? '影巢库'
    try {
      const lib = await window.aerie.library.create({
        name,
        path: dir,
        storageMode: mode,
      })
      resetBrowseRef.current()
      setWelcomeError('')
      setLibrary(lib)
      await refreshAll()
    } catch (err) {
      setWelcomeError(explainIpc(err))
    }
  }, [refreshAll])

  const doOpenLibrary = useCallback(async (): Promise<void> => {
    const dir = await window.aerie.dialog.pickNewLibrary('选择影巢库（.aerie 文件夹，或它所在的目录）')
    if (!dir) return
    try {
      const lib = await window.aerie.library.open(dir)
      setWelcomeError('')
      setLibrary(lib)
      await refreshAll()
    } catch (err) {
      setWelcomeError(explainIpc(err))
    }
  }, [refreshAll])

  // ── 新建标签 / 文件夹 ──
  const doNewTag = useCallback(async (): Promise<void> => {
    const name = prompt('标签名')
    if (!name?.trim()) return
    await window.aerie.tags.create(name.trim())
    await refreshAll()
  }, [refreshAll])

  const doNewFolder = useCallback(async (parentId?: string | null): Promise<void> => {
    const name = prompt(parentId ? '子文件夹名' : '文件夹名')
    if (!name?.trim()) return
    await window.aerie.folders.create(name.trim(), parentId ?? null)
    await refreshAll()
  }, [refreshAll])

  const flash = useCallback((text: string): void => {
    setStatus(text)
    window.setTimeout(() => setStatus(''), 4000)
  }, [])

  const resetBrowse = useCallback((): void => {
    setItems([])
    setSelected(new Set())
    setInspectorId(null)
    setViewerIndex(null)
    setScope('active')
    setActiveFolder(null)
    setActiveTags([])
    setExtFilter(null)
    setExtList(null)
    setHue(null)
    setOrientation(null)
    setMinStar(0)
    setSearch('')
    setActiveSmartId(null)
    setSmartFlags({})
    setMinSize(undefined)
    setMaxSize(undefined)
    setAddedFrom(undefined)
    setAddedTo(undefined)
    setTakenFrom(undefined)
    setTakenTo(undefined)
    setSort('addedAt')
    setStatus('')
  }, [])

  resetBrowseRef.current = resetBrowse

  const doCloseLibrary = useCallback(async (): Promise<void> => {
    await window.aerie.library.close()
    resetBrowse()
    setLibrary(null)
    setRecent(await window.aerie.library.recent())
  }, [resetBrowse])

  const doSwitchLibrary = useCallback(async (): Promise<void> => {
    const dir = await window.aerie.dialog.pickNewLibrary('选择要切换到的影巢库')
    if (!dir) return
    try {
      const lib = await window.aerie.library.open(dir)
      resetBrowse()
      setLibrary(lib)
      await refreshAll()
    } catch (err) {
      const current = await window.aerie.library.current()
      resetBrowse()
      setLibrary(current)
      if (current) await refreshAll()
      else setRecent(await window.aerie.library.recent())
      flash(explainIpc(err))
    }
  }, [resetBrowse, refreshAll, flash])

  const afterMutation = useCallback(async (): Promise<void> => {
    await refreshAll()
    await reload()
  }, [refreshAll, reload])

  const doRelinkOne = useCallback(
    async (id: string): Promise<void> => {
      const files = await window.aerie.dialog.pickFiles()
      const file = files[0]
      if (!file) return
      try {
        await window.aerie.items.relink(id, file)
        flash('已接回原文件')
        await afterMutation()
      } catch (err) {
        flash(explainIpc(err))
      }
    },
    [flash, afterMutation],
  )

  const doRelinkFolder = useCallback(async (): Promise<void> => {
    const dir = await window.aerie.dialog.pickFolder()
    if (!dir) return
    try {
      const res = await window.aerie.items.relinkFolder(dir)
      flash(`接回 ${res.linked} 项，仍缺失 ${res.stillMissing} 项`)
      await afterMutation()
    } catch (err) {
      flash(explainIpc(err))
    }
  }, [flash, afterMutation])

  const doRefreshPresence = useCallback(async (): Promise<void> => {
    const scan = await window.aerie.items.refreshPresence()
    flash(`检查了 ${scan.checked} 项，缺失 ${scan.missing} 项`)
    await afterMutation()
  }, [flash, afterMutation])

  const openViewer = useCallback(
    (id: string): void => {
      const idx = items.findIndex((item) => item.id === id)
      if (idx >= 0) setViewerIndex(idx)
    },
    [items],
  )

  const doTrash = useCallback(
    async (ids: string[]): Promise<void> => {
      if (ids.length === 0) return
      if (scope === 'trash') {
        const n = await window.aerie.items.purge(ids)
        flash(`已从索引移除 ${n} 项，原文件还在`)
      } else {
        const n = await window.aerie.items.trash(ids)
        flash(`已移入回收站 ${n} 项，原文件还在`)
      }
      setSelected(new Set())
      setInspectorId(null)
      setViewerIndex(null)
      await afterMutation()
    },
    [scope, flash, afterMutation],
  )

  const doPaste = useCallback(async (): Promise<void> => {
    if (!library) return
    try {
      const res = await window.aerie.import.paste()
      flash(`从剪贴板导入 ${res.imported} 项，跳过 ${res.skipped} 项`)
      await afterMutation()
    } catch (err) {
      flash(err instanceof Error ? err.message : '粘贴失败')
    }
  }, [library, flash, afterMutation])

  const doExport = useCallback(async (): Promise<void> => {
    const ids = [...selected]
    if (ids.length === 0) {
      flash('先选中素材')
      return
    }
    const dir = await window.aerie.dialog.pickExportFolder()
    if (!dir) return
    const res = await window.aerie.items.export(ids, dir)
    flash(`已复制 ${res.copied} 个文件到所选文件夹`)
  }, [selected, flash])

  const doRateSelected = useCallback(
    async (star: number): Promise<void> => {
      const ids = [...selected]
      if (ids.length === 0) return
      await window.aerie.items.updateMany(ids, { star })
      setItems((prev) => prev.map((item) => (selected.has(item.id) ? { ...item, star } : item)))
      flash(star > 0 ? `已把 ${ids.length} 项评为 ${star} 星` : `已清除 ${ids.length} 项的评分`)
      await refreshAll()
      if (minStar > 0 || scope === 'starred') await reload()
    },
    [selected, flash, refreshAll, minStar, scope, reload],
  )

  const doAssignFolder = useCallback(
    async (folderId: string): Promise<void> => {
      const ids = [...selected]
      if (ids.length === 0) return
      await window.aerie.folders.assign(ids, [folderId])
      const name = folders.find((folder) => folder.id === folderId)?.name ?? '文件夹'
      flash(`已把 ${ids.length} 项加入「${name}」`)
      await refreshAll()
    },
    [selected, folders, flash, refreshAll],
  )

  const doLeaveFolder = useCallback(async (): Promise<void> => {
    if (!activeFolder || selected.size === 0) return
    const ids = [...selected]
    const name = folders.find((folder) => folder.id === activeFolder)?.name ?? '文件夹'
    await window.aerie.folders.unassign(ids, [activeFolder])
    flash(`已从「${name}」移出 ${ids.length} 项`)
    setSelected(new Set())
    await afterMutation()
  }, [activeFolder, selected, folders, flash, afterMutation])

  const doAssignTag = useCallback(
    async (tagId: string): Promise<void> => {
      const ids = [...selected]
      if (ids.length === 0) return
      await window.aerie.tags.assign(ids, [tagId])
      const name = tags.find((tag) => tag.id === tagId)?.name ?? '标签'
      flash(`已给 ${ids.length} 项打上「${name}」`)
      await refreshAll()
    },
    [selected, tags, flash, refreshAll],
  )

  const doSimilar = useCallback(async (): Promise<void> => {
    setStatus('正在比较指纹…')
    try {
      const scan = await window.aerie.items.similar(6)
      setStatus('')
      setSimilar(scan)
    } catch (err) {
      flash(err instanceof Error ? err.message : '比较失败')
    }
  }, [flash])

  useEffect(() => {
    return window.aerie.window.onFullscreen((fullscreen) => {
      document.documentElement.classList.toggle('is-fullscreen', fullscreen)
    })
  }, [])

  // 菜单栏：快捷键由系统菜单接收，再转到这里，这样搜索框里的 ⌘V 仍是粘贴文字。
  useEffect(() => {
    return window.aerie.menu.onCommand((command, arg) => {
      const active = document.activeElement
      if (command === 'paste') {
        if (isTextField(active)) void window.aerie.edit.paste()
        else if (viewerIndex === null) void doPaste()
        return
      }
      if (command === 'undo') {
        if (isTextField(active)) {
          void window.aerie.edit.undo()
          return
        }
        void (async () => {
          try {
            const label = await window.aerie.undo.perform()
            if (!label) flash('没有可撤销的操作')
            else {
              flash(label)
              await afterMutation()
            }
          } catch (err) {
            flash(explainIpc(err))
          }
        })()
        return
      }
      if (command === 'select-all') {
        if (isTextField(active)) active.select()
        else setSelected(new Set(items.map((item) => item.id)))
        return
      }
      if (command === 'focus-search') {
        const input = document.querySelector<HTMLInputElement>('.search-input')
        input?.focus()
        input?.select()
        return
      }
      if (command === 'new-reference') {
        void doCreateLibrary('reference')
        return
      }
      if (command === 'new-copy') {
        void doCreateLibrary('copy')
        return
      }
      if (command === 'open-library') {
        void (library ? doSwitchLibrary() : doOpenLibrary())
        return
      }
      if (command === 'open-recent') {
        if (!arg) return
        void (async () => {
          try {
            const lib = await window.aerie.library.open(arg)
            resetBrowse()
            setWelcomeError('')
            setLibrary(lib)
            await refreshAll()
          } catch (err) {
            const current = await window.aerie.library.current()
            resetBrowse()
            setLibrary(current)
            if (current) {
              await refreshAll()
              flash(explainIpc(err))
            } else {
              setRecent(await window.aerie.library.recent())
              setWelcomeError(explainIpc(err))
            }
          }
        })()
        return
      }
      if (command === 'close-library') {
        void doCloseLibrary()
        return
      }
      if (command === 'import-files') {
        void doImportFiles()
        return
      }
      if (command === 'import-folder') {
        void doImportFolder()
        return
      }
      if (command === 'paste-import') {
        void doPaste()
        return
      }
      if (command === 'export') {
        void doExport()
        return
      }
      if (command === 'new-folder') {
        void doNewFolder()
        return
      }
      if (command === 'new-tag') {
        void doNewTag()
        return
      }
      if (command === 'trash') {
        if (selected.size === 0) flash('先选中素材')
        else void doTrash([...selected])
        return
      }
      if (command === 'rename') {
        if (selected.size === 0) flash('先选中素材')
        else setRenameOpen(true)
        return
      }
      if (command === 'layout-grid' || command === 'layout-list' || command === 'layout-waterfall') {
        setLayout(command.slice('layout-'.length) as BrowseLayout)
        return
      }
      if (command === 'zoom-in' || command === 'zoom-out' || command === 'zoom-reset') {
        if (viewerIndex != null) {
          window.dispatchEvent(new CustomEvent(VIEWER_ZOOM_EVENT, { detail: command }))
          return
        }
        if (command === 'zoom-in') setCardSize((size) => Math.min(280, size + 16))
        else if (command === 'zoom-out') setCardSize((size) => Math.max(100, size - 16))
        else setCardSize(168)
        return
      }
      if (command === 'find-similar') {
        void doSimilar()
        return
      }
      if (command === 'check-missing') {
        void doRefreshPresence()
        return
      }
      if (command === 'relink-folder') void doRelinkFolder()
    })
  }, [
    items,
    library,
    selected,
    viewerIndex,
    doPaste,
    afterMutation,
    doCreateLibrary,
    doSwitchLibrary,
    doOpenLibrary,
    resetBrowse,
    refreshAll,
    flash,
    doCloseLibrary,
    doImportFiles,
    doImportFolder,
    doExport,
    doNewFolder,
    doNewTag,
    doTrash,
    doSimilar,
    doRefreshPresence,
    doRelinkFolder,
  ])

  // ── 快捷键 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing =
        (e.target as HTMLElement).tagName === 'INPUT' ||
        (e.target as HTMLElement).tagName === 'TEXTAREA'

      if (e.key === 'Escape') {
        // 分层关掉：预览 → 菜单/对话框 → 检视器 → 选择。
        // 一次 Esc 清空选择，多选时太容易误触。
        if (viewerIndex !== null) {
          setViewerIndex(null)
          return
        }
        if (itemMenu || sideMenu || smartMenu || saveSmartOpen || connectOpen || renameOpen || similar) {
          setItemMenu(null)
          setSideMenu(null)
          setSmartMenu(null)
          setSaveSmartOpen(false)
          setConnectOpen(false)
          setRenameOpen(false)
          setSimilar(null)
          return
        }
        if (inspectorId) {
          setInspectorId(null)
          return
        }
        if (selected.size > 0) setSelected(new Set())
        return
      }
      if (viewerIndex !== null || renameOpen || similar) return
      if (
        !typing &&
        (e.target as HTMLElement).tagName !== 'SELECT' &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')
      ) {
        if (items.length === 0) return
        e.preventDefault()
        const cols = Math.max(1, colsRef.current)
        const currentId = inspectorId ?? items.find((item) => selected.has(item.id))?.id
        const index = currentId ? items.findIndex((item) => item.id === currentId) : -1
        const places = placesRef.current
        let nextIndex: number
        if (places && index >= 0 && places[index]) {
          nextIndex = waterfallNeighbor(places, index, e.key)
        } else {
          const step =
            e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -cols : cols
          nextIndex = Math.max(0, Math.min(items.length - 1, (index < 0 ? 0 : index) + (index < 0 ? 0 : step)))
        }
        const next = items[nextIndex]
        if (!next) return
        setSelected(new Set([next.id]))
        setInspectorId(next.id)
        lastClicked.current = next.id
        setJumpTo((prev) => ({ index: nextIndex, seq: (prev?.seq ?? 0) + 1 }))
        return
      }
      if (e.key === ' ' && !typing) {
        const id = inspectorId ?? items.find((i) => selected.has(i.id))?.id
        if (!id) return
        e.preventDefault()
        openViewer(id)
        return
      }
      if (/^[0-5]$/.test(e.key) && !typing && selected.size > 0) {
        e.preventDefault()
        const star = Number(e.key)
        const ids = [...selected]
        void window.aerie.items.updateMany(ids, { star }).then(async () => {
          setItems((prev) => prev.map((i) => (selected.has(i.id) ? { ...i, star } : i)))
          await refreshAll()
          if (minStar > 0 || scope === 'starred') await reload()
        })
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0 && !typing) {
        e.preventDefault()
        void doTrash([...selected])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    items,
    selected,
    inspectorId,
    viewerIndex,
    itemMenu,
    sideMenu,
    smartMenu,
    saveSmartOpen,
    connectOpen,
    renameOpen,
    similar,
    refreshAll,
    doTrash,
    openViewer,
    minStar,
    scope,
    reload,
  ])

  // 只读调试状态：自动化测试用来核对窗口与滚动位置是否一致
  useEffect(() => {
    ;(window as unknown as { __aerie?: unknown }).__aerie = {
      windowStart,
      loaded: items.length,
      total,
      hasNext: nextCursor !== null,
      complete,
      firstId: items[0]?.id ?? null,
    }
  }, [windowStart, items.length, total, nextCursor])

  const inspectorItem = inspectorId ? (items.find((i) => i.id === inspectorId) ?? null) : null

  // ── 未打开库 ──
  const selectedItems = items.filter((item) => selected.has(item.id))
  const narrowed =
    !!search ||
    activeTags.length > 0 ||
    !!hue ||
    !!orientation ||
    !!extFilter ||
    !!extList ||
    minStar > 0 ||
    minSize != null ||
    maxSize != null ||
    addedFrom != null ||
    addedTo != null ||
    takenFrom != null ||
    takenTo != null ||
    !!smartFlags.uncategorized ||
    !!smartFlags.untagged ||
    !!activeSmartId
  const clearNarrowed = (): void => {
    setActiveSmartId(null)
    setSearch('')
    setActiveTags([])
    setExtFilter(null)
    setExtList(null)
    setHue(null)
    setOrientation(null)
    setMinStar(0)
    setSmartFlags({})
    setMinSize(undefined)
    setMaxSize(undefined)
    setAddedFrom(undefined)
    setAddedTo(undefined)
    setTakenFrom(undefined)
    setTakenTo(undefined)
  }
  const filtered = narrowed || !!activeFolder || scope !== 'active'
  const canReorder = !!activeFolder && scope === 'active'
  const placeTitle = activeSmartId
    ? (smartFolders.find((folder) => folder.id === activeSmartId)?.name ?? '智能文件夹')
    : activeFolder
      ? (folders.find((folder) => folder.id === activeFolder)?.name ?? '文件夹')
      : activeTags.length > 0
        ? activeTags
            .map((id) => tags.find((tag) => tag.id === id)?.name ?? '')
            .filter(Boolean)
            .join('、') || '标签'
        : SCOPE_LABEL[scope]

  if (!library) {
    return (
      <Welcome
        onOpen={doOpenLibrary}
        onCreate={doCreateLibrary}
        recent={recent}
        error={welcomeError}
        onOpenRecent={(libraryPath) => {
          void (async () => {
            try {
              const lib = await window.aerie.library.open(libraryPath)
              setWelcomeError('')
              setLibrary(lib)
              await refreshAll()
            } catch (err) {
              setWelcomeError(explainIpc(err))
            }
          })()
        }}
      />
    )
  }

  return (
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Sidebar
        library={library}
        tags={tags}
        folders={folders}
        smartFolders={smartFolders}
        stats={stats}
        exts={exts}
        scope={scope}
        activeFolder={activeFolder}
        activeTags={activeTags}
        activeExt={extFilter}
        activeExts={extList ?? []}
        activeSmartId={activeSmartId}
        ocrReason={ocrStatus && !ocrStatus.available ? ocrStatus.reason : null}
        onScope={(next) => {
          resetSmartExtras()
          setScope(next)
          setActiveFolder(null)
          setActiveTags([])
        }}
        onFolder={(id) => {
          resetSmartExtras()
          setScope('active')
          setActiveFolder(id)
          setActiveTags([])
        }}
        onTag={(id) => {
          setActiveSmartId(null)
          setActiveTags((prev) =>
            prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
          )
        }}
        onExt={(ext) => {
          setActiveSmartId(null)
          setExtList(null)
          setExtFilter(ext)
        }}
        onSmart={(id) => {
          const folder = smartFolders.find((row) => row.id === id)
          if (folder) applySmart(folder)
        }}
        onSaveSmart={() => setSaveSmartOpen(true)}
        onSmartMenu={(id, x, y) => setSmartMenu({ id, x, y })}
        onNewFolder={doNewFolder}
        onNewTag={doNewTag}
        onSideMenu={(kind, id, x, y) => setSideMenu({ kind, id, x, y })}
        onOpenConnect={() => setConnectOpen(true)}
        onSwitchLibrary={() => void doSwitchLibrary()}
        onCloseLibrary={() => void doCloseLibrary()}
        dropApi={dropApi}
      />

      <main className="main">
        <header className="toolbar drag-region">
          <div className="toolbar-left no-drag">
            <h1 className="place-title" title={placeTitle}>
              {placeTitle}
            </h1>
            <ImportMenu
              onFiles={() => void doImportFiles()}
              onFolder={() => void doImportFolder()}
              onPaste={() => void doPaste()}
            />
          </div>

          <div className="toolbar-center no-drag">
            <div className="search-wrap">
              <span className="search-glyph" aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <circle cx="7" cy="7" r="4.2" />
                  <path d="M10.2 10.2 13.4 13.4" />
                </svg>
              </span>
              <input
                className="search-input"
                placeholder={`搜索名称、备注、画面文字  ${ACCEL.search}`}
                value={search}
                onChange={(e) => {
                  setActiveSmartId(null)
                  setSearch(e.target.value)
                }}
              />
              {search && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="清除搜索"
                  onClick={() => {
                    setActiveSmartId(null)
                    setSearch('')
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="toolbar-right no-drag">
            <div className="seg" role="group" aria-label="查看方式">
              <button className={layout === 'grid' ? 'is-on' : ''} onClick={() => setLayout('grid')}>
                网格
              </button>
              <button className={layout === 'list' ? 'is-on' : ''} onClick={() => setLayout('list')}>
                列表
              </button>
              <button
                className={layout === 'waterfall' ? 'is-on' : ''}
                onClick={() => setLayout('waterfall')}
              >
                瀑布
              </button>
            </div>
            {layout !== 'list' && (
              <input
                type="range"
                min={100}
                max={280}
                value={cardSize}
                onChange={(e) => setCardSize(Number(e.target.value))}
                className="size-slider"
                title="卡片大小"
              />
            )}
          </div>
        </header>

        <div className="filterbar">
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as SortField)
            }}
            title="排序"
          >
            <option value="addedAt">添加时间</option>
            <option value="mtime">修改时间</option>
            <option value="name">名称</option>
            <option value="fileSize">文件大小</option>
            <option value="star">评分</option>
            <option value="takenAt">拍摄时间</option>
            <option value="manual">自定义</option>
          </select>
          <button
            className="btn-ghost sm"
            onClick={() => setOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
            title="切换升降序"
          >
            {order === 'desc' ? '降序' : '升序'}
          </button>
          <select
            value={minStar}
            onChange={(e) => {
              setActiveSmartId(null)
              setMinStar(Number(e.target.value))
            }}
            title="最低评分"
          >
            <option value={0}>全部评分</option>
            <option value={1}>★ 及以上</option>
            <option value={2}>★★ 及以上</option>
            <option value={3}>★★★ 及以上</option>
            <option value={4}>★★★★ 及以上</option>
            <option value={5}>★★★★★</option>
          </select>
          <div className="seg" role="group" aria-label="画幅">
            {(
              [
                ['landscape', '横图'],
                ['portrait', '竖图'],
                ['square', '方形'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={orientation === id ? 'is-on' : ''}
                onClick={() => {
                  setActiveSmartId(null)
                  setOrientation((prev) => (prev === id ? null : id))
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="hue-row">
            {HUES.map((swatch) => (
              <button
                key={swatch.id}
                className={`hue ${hue === swatch.id ? 'is-on' : ''}`}
                style={{ background: swatch.color }}
                title={swatch.label}
                onClick={() => {
                  setActiveSmartId(null)
                  setHue((prev) => (prev === swatch.id ? null : swatch.id))
                }}
              />
            ))}
          </div>
          <div className="filter-actions">
            {narrowed && (
              <button className="btn-ghost sm" onClick={clearNarrowed}>
                清除筛选
              </button>
            )}
            <button className="btn-ghost sm" onClick={() => void doSimilar()}>
              查找相似
            </button>
            {scope === 'trash' && (stats?.trash ?? 0) > 0 && (
              <button
                className="btn-ghost sm"
                onClick={() => {
                  if (!confirm('清空回收站？只会去掉索引，不会删除原文件。')) return
                  void (async () => {
                    const n = await window.aerie.items.emptyTrash()
                    flash(`已清空 ${n} 项`)
                    setSelected(new Set())
                    await afterMutation()
                  })()
                }}
              >
                清空回收站
              </button>
            )}
            {scope === 'missing' && (
              <>
                <button className="btn-ghost sm" onClick={() => void doRefreshPresence()}>
                  重新检查
                </button>
                <button className="btn-ghost sm" onClick={() => void doRelinkFolder()}>
                  按文件夹接回
                </button>
              </>
            )}
          </div>
        </div>

        {selected.size > 0 && (
          <BatchBar
            count={selected.size}
            scope={scope}
            folders={folders}
            tags={tags}
            onStar={(star) => void doRateSelected(star)}
            onFolder={(id) => void doAssignFolder(id)}
            onTag={(id) => void doAssignTag(id)}
            onExport={() => void doExport()}
            onRename={() => setRenameOpen(true)}
            onTrash={() => void doTrash([...selected])}
            onRestore={() => {
              void window.aerie.items.restore([...selected]).then(async (n) => {
                flash(`已还原 ${n} 项`)
                setSelected(new Set())
                await afterMutation()
              })
            }}
            onClear={() => setSelected(new Set())}
            onLeave={activeFolder && scope === 'active' ? () => void doLeaveFolder() : undefined}
          />
        )}

        {progress && (
          <div className={`progress-bar ${progress.phase === 'done' ? 'is-done' : ''}`}>
            <div className="progress-text">
              {progress.phase === 'scanning' && '扫描中…'}
              {progress.phase === 'copying' && `复制进库 ${progress.done}/${progress.total}`}
              {progress.phase === 'importing' && `写入索引 ${progress.total} 项`}
              {progress.phase === 'thumbs' && `生成缩略图 ${progress.done}/${progress.total}`}
              {progress.phase === 'done' && '导入完成'}
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{
                  width:
                    progress.phase === 'done'
                      ? '100%'
                      : progress.total > 0
                        ? `${Math.round((progress.done / progress.total) * 100)}%`
                        : '10%',
                }}
              />
            </div>
          </div>
        )}

        <div className={`content ${loading ? 'is-busy' : ''}`} aria-busy={loading}>
          <Grid
            items={items}
            complete={complete}
            windowStart={windowStart}
            total={total}
            onLoadMore={() => void loadMore()}
            onSeek={(p) => void handleSeek(p)}
            jumpTo={jumpTo}
            onCols={(c) => {
              colsRef.current = c
            }}
            onPlaces={onPlaces}
            selected={selected}
            onSelect={(id, mods) => {
              handleSelect(id, mods)
              setInspectorId(id)
            }}
            onItemDragStart={onItemDragStart}
            onOpen={openViewer}
            onContextMenu={(id, x, y) => {
              setSelected((prev) => (prev.has(id) ? prev : new Set([id])))
              setInspectorId(id)
              setItemMenu({ id, x, y })
            }}
            layout={layout}
            canReorder={canReorder}
            reorderHoverId={reorderHover}
            onReorderHover={setReorderHover}
            onReorderDrop={(beforeId, event) => {
              setReorderHover(null)
              if (!activeFolder) return
              let ids: string[] = []
              try {
                const raw = event.dataTransfer.getData(ITEM_DRAG_MIME)
                if (raw) ids = JSON.parse(raw) as string[]
              } catch {
                return
              }
              if (ids.length === 0 || (ids.length === 1 && ids[0] === beforeId)) return
              void (async () => {
                await window.aerie.items.reorder(activeFolder, ids, beforeId)
                if (sort === 'manual' && order === 'asc') await reload()
                else {
                  setSort('manual')
                  setOrder('asc')
                }
                flash('已按拖拽顺序排列')
              })()
            }}
            cardSize={cardSize}
          />

          {loading && (
            <div className="empty-state is-loading">
              <p>正在读取素材…</p>
            </div>
          )}

          {!loading && items.length === 0 && (
            <div className="empty-state">
              <p>
                {scope === 'trash'
                  ? '回收站是空的'
                  : scope === 'missing'
                    ? '没有缺失的原文件'
                    : narrowed
                      ? '没有匹配的素材'
                      : activeFolder
                        ? '这个文件夹还没有素材'
                        : scope !== 'active'
                          ? `${SCOPE_LABEL[scope]}是空的`
                          : '这个库还是空的'}
              </p>
              {narrowed ? (
                <button className="btn-primary" onClick={clearNarrowed}>
                  清除筛选
                </button>
              ) : !filtered && scope === 'active' && !activeFolder ? (
                <>
                  <p className="empty-hint">
                    把文件拖进来，或用导入 / {ACCEL.pasteImport} 从剪贴板粘贴
                  </p>
                  <div className="empty-actions">
                    <button className="btn-primary" onClick={() => void doImportFolder()}>
                      导入文件夹
                    </button>
                    <button className="btn-ghost" onClick={() => void doImportFiles()}>
                      导入文件
                    </button>
                  </div>
                </>
              ) : (
                !filtered && (
                  <button className="btn-primary" onClick={() => void doImportFolder()}>
                    导入一个文件夹
                  </button>
                )
              )}
            </div>
          )}
        </div>

        <footer className="statusbar">
          <span>共 {total.toLocaleString()} 个素材</span>
          {selected.size > 0 && <span className="status-sel">已选 {selected.size}</span>}
          {thumbStats && thumbStats.fileCount > 0 && (
            <span
              className={thumbStats.overBudget ? 'thumb-cache is-over' : 'thumb-cache'}
              title={`缩略图缓存 ${thumbStats.fileCount.toLocaleString()} 个文件，预算 ${formatSize(thumbStats.budgetBytes)}。超出后按最久未使用自动清理，原图不受影响。`}
            >
              缩略图 {formatSize(thumbStats.totalBytes)}
            </span>
          )}
          {status && <span className="status-msg">{status}</span>}
        </footer>
      </main>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-title">松手导入</div>
            <div className="drop-sub">文件或文件夹都行，文件夹会递归扫描</div>
          </div>
        </div>
      )}

      <Inspector
        item={inspectorItem}
        onClose={() => setInspectorId(null)}
        onOpen={() => inspectorId && openViewer(inspectorId)}
        onMutate={() => void afterMutation()}
        onRelink={(id) => void doRelinkOne(id)}
        onUpdate={(patch) => {
          if (!inspectorId) return
          void (async () => {
            await window.aerie.items.update(inspectorId, patch)
            setItems((prev) =>
              prev.map((i) => (i.id === inspectorId ? { ...i, ...patch } : i)),
            )
          })()
        }}
      />

      {viewerIndex !== null && items.length > 0 && (
        <Viewer
          items={items}
          index={Math.min(viewerIndex, items.length - 1)}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}

      {renameOpen && selectedItems.length > 0 && (
        <RenameDialog
          items={selectedItems}
          onClose={() => setRenameOpen(false)}
          onApply={(template, start, renameFiles) => {
            const ids = selectedItems.map((item) => item.id)
            void (async () => {
              const res = await window.aerie.items.renameBatch(ids, template, start, renameFiles)
              setRenameOpen(false)
              flash(`已重命名 ${res.renamed} 项${res.skipped ? `，跳过 ${res.skipped} 项` : ''}`)
              await afterMutation()
            })()
          }}
        />
      )}

      {similar && (
        <SimilarDialog
          scan={similar}
          onClose={() => setSimilar(null)}
          onTrash={(ids) => {
            void (async () => {
              await doTrash(ids)
              setSimilar(null)
            })()
          }}
        />
      )}

      {saveSmartOpen && (
        <SmartFolderDialog
          initial={captureRules()}
          onClose={() => setSaveSmartOpen(false)}
          onSave={(name, rules) => {
            setSaveSmartOpen(false)
            void (async () => {
              const created = await window.aerie.smartFolders.create(name, rules)
              setSmartFolders((prev) => [...prev, created])
              applySmart(created)
              await refreshAll()
            })()
          }}
        />
      )}

      {connectOpen && <ConnectDialog onClose={() => setConnectOpen(false)} />}

      {smartMenu && (
        <Menu
          x={smartMenu.x}
          y={smartMenu.y}
          onClose={() => setSmartMenu(null)}
          entries={[
            { id: 'rename', label: '重命名' },
            { id: 'delete', label: '删除', danger: true },
          ]}
          onPick={(action) => {
            const id = smartMenu.id
            const current = smartFolders.find((folder) => folder.id === id)
            setSmartMenu(null)
            if (action === 'rename') {
              const name = prompt('新名称', current?.name ?? '')
              if (!name?.trim()) return
              void window.aerie.smartFolders.rename(id, name.trim()).then(() => refreshAll())
            }
            if (action === 'delete') {
              if (!confirm(`删除智能文件夹「${current?.name ?? ''}」？素材会留在库里。`)) return
              void window.aerie.smartFolders.delete(id).then(async () => {
                if (activeSmartId === id) setActiveSmartId(null)
                await refreshAll()
              })
            }
          }}
        />
      )}

      {itemMenu && (
        <Menu
          x={itemMenu.x}
          y={itemMenu.y}
          onClose={() => setItemMenu(null)}
          entries={[
            { id: 'view', label: '打开大图' },
            { id: 'open', label: '用默认应用打开' },
            { id: 'reveal', label: '在访达中显示' },
            { id: 'copy', label: '复制路径' },
            { id: 'rename', label: selected.size > 1 ? `重命名 ${selected.size} 项` : '重命名' },
            { id: 'export', label: '导出副本' },
            ...(activeFolder && scope === 'active'
              ? [{ id: 'leave', label: '移出此文件夹' }]
              : []),
            scope === 'trash'
              ? { id: 'restore', label: '还原' }
              : { id: 'trash', label: '移入回收站', danger: true },
            ...(scope === 'trash' ? [{ id: 'purge', label: '从索引删除', danger: true }] : []),
          ]}
          onPick={(action) => {
            const ids = [...selected]
            const id = itemMenu.id
            setItemMenu(null)
            if (action === 'view') openViewer(id)
            if (action === 'open') void window.aerie.items.open(id)
            if (action === 'reveal') {
              const item = items.find((row) => row.id === id)
              if (item) void window.aerie.shell.reveal(item.filePath)
            }
            if (action === 'copy') {
              void window.aerie.items.copyPaths(ids.length ? ids : [id])
              flash('已复制路径')
            }
            if (action === 'rename') setRenameOpen(true)
            if (action === 'export') void doExport()
            if (action === 'leave') void doLeaveFolder()
            if (action === 'trash' || action === 'purge') void doTrash(ids.length ? ids : [id])
            if (action === 'restore') {
              void window.aerie.items.restore(ids.length ? ids : [id]).then(async (n) => {
                flash(`已还原 ${n} 项`)
                setSelected(new Set())
                await afterMutation()
              })
            }
          }}
        />
      )}

      {sideMenu && (
        <SideMenu
          x={sideMenu.x}
          y={sideMenu.y}
          title={
            (sideMenu.kind === 'folder'
              ? folders.find((folder) => folder.id === sideMenu.id)?.name
              : tags.find((tag) => tag.id === sideMenu.id)?.name) ?? ''
          }
          onClose={() => setSideMenu(null)}
          onNewChild={
            sideMenu.kind === 'folder'
              ? () => {
                  const parentId = sideMenu.id
                  setSideMenu(null)
                  void doNewFolder(parentId)
                }
              : undefined
          }
          onSetCover={
            sideMenu.kind === 'folder' && selected.size > 0
              ? () => {
                  const folderId = sideMenu.id
                  const itemId = [...selected][0]
                  setSideMenu(null)
                  if (!itemId) return
                  void window.aerie.folders.setCover(folderId, itemId).then(async () => {
                    flash('已设为封面')
                    await refreshAll()
                  })
                }
              : undefined
          }
          onRename={() => {
            const current =
              sideMenu.kind === 'folder'
                ? folders.find((folder) => folder.id === sideMenu.id)?.name
                : tags.find((tag) => tag.id === sideMenu.id)?.name
            const name = prompt('新名称', current ?? '')
            const id = sideMenu.id
            const kind = sideMenu.kind
            setSideMenu(null)
            if (!name?.trim()) return
            void (async () => {
              if (kind === 'folder') await window.aerie.folders.rename(id, name.trim())
              else await window.aerie.tags.rename(id, name.trim())
              await refreshAll()
            })()
          }}
          onDelete={() => {
            const id = sideMenu.id
            const kind = sideMenu.kind
            const name =
              kind === 'folder'
                ? folders.find((folder) => folder.id === id)?.name
                : tags.find((tag) => tag.id === id)?.name
            if (!confirm(`删除${kind === 'folder' ? '文件夹' : '标签'}「${name ?? ''}」？素材会留在库里。`)) return
            setSideMenu(null)
            void (async () => {
              if (kind === 'folder') {
                await window.aerie.folders.delete(id)
                if (activeFolder === id) setActiveFolder(null)
              } else {
                await window.aerie.tags.delete(id)
                setActiveTags((prev) => prev.filter((tagId) => tagId !== id))
              }
              await refreshAll()
            })()
          }}
          onColor={(color) => {
            const id = sideMenu.id
            const kind = sideMenu.kind
            setSideMenu(null)
            void (async () => {
              if (kind === 'folder') await window.aerie.folders.setColor(id, color)
              else await window.aerie.tags.setColor(id, color)
              await refreshAll()
            })()
          }}
        />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
