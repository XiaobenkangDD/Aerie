import { useEffect, useLayoutEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { Annotation, IngestInfo, Item, OcrStatus, SimilarScan, SmartFolderRules } from '../../shared/types'
import { renderNameTemplate } from '../../shared/rename'
import { describeRules, normalizeRules } from '../../shared/smart'

const VIEWABLE = new Set([
  'jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico',
])
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v'])
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'])

export const LABEL_COLORS = [
  '#e5484d',
  '#f76808',
  '#f5c518',
  '#30a46c',
  '#4ecdc4',
  '#3b82f6',
  '#8b5cf6',
  '#e93d82',
]

function originalUrl(item: Item): string {
  return `aerie-file://local/${item.id}`
}

const STRIP_W = 76
const STRIP_GAP = 6
const STRIP_STEP = STRIP_W + STRIP_GAP

/** 相对原图像素。0.1 是缩到一成，8 是放到八倍。 */
const ZOOM_MIN = 0.1
const ZOOM_MAX = 8
const ZOOM_STEP = 1.25
export const VIEWER_ZOOM_EVENT = 'aerie-viewer-zoom'

function clampZoom(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

type DrawTool = 'view' | 'rect' | 'arrow' | 'text'
const ANNO_COLOR = '#f5c518'

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 把指针位置换成相对这张图的 0–1。用的是图当前的显示框，所以缩放之后仍然对准同一处。 */
function relativePoint(e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } {
  const box = e.currentTarget.getBoundingClientRect()
  return {
    x: clamp01(box.width > 0 ? (e.clientX - box.left) / box.width : 0),
    y: clamp01(box.height > 0 ? (e.clientY - box.top) / box.height : 0),
  }
}

function ArrowShape({ a, box }: { a: Annotation; box: { w: number; h: number } }): JSX.Element {
  const x1 = a.x * box.w
  const y1 = a.y * box.h
  const x2 = (a.x + a.w) * box.w
  const y2 = (a.y + a.h) * box.h
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const size = 12
  const px = -uy
  const py = ux
  const points = [
    `${x2},${y2}`,
    `${x2 - ux * size + px * size * 0.45},${y2 - uy * size + py * size * 0.45}`,
    `${x2 - ux * size - px * size * 0.45},${y2 - uy * size - py * size * 0.45}`,
  ].join(' ')
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={ANNO_COLOR} strokeWidth={2} />
      <polygon points={points} fill={ANNO_COLOR} />
    </g>
  )
}

export function Viewer({
  items,
  index,
  absIndex,
  totalCount,
  onAbsIndex,
  onClose,
}: {
  items: Item[]
  /** 当前窗口内的下标，用来取 items[index] 和底栏缩略图 */
  index: number
  /** 在整个筛选结果里的绝对下标 */
  absIndex: number
  totalCount: number
  onAbsIndex: (abs: number) => void
  onClose: () => void
}): JSX.Element | null {
  const item = items[index]
  const goLocal = (local: number): void => {
    const next = items[local]
    if (!next) return
    onAbsIndex(absIndex - index + local)
  }
  const [mode, setMode] = useState<'fit' | 'actual' | 'zoom'>('fit')
  const [zoom, setZoom] = useState(1)
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [tool, setTool] = useState<DrawTool>('view')
  const [annos, setAnnos] = useState<Annotation[]>([])
  const [draft, setDraft] = useState<Annotation | null>(null)
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null)
  const [playing, setPlaying] = useState(false)
  const [box, setBox] = useState({ w: 1, h: 1 })
  const frameRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [stripScroll, setStripScroll] = useState(0)
  const [stripWidth, setStripWidth] = useState(0)
  const annosRef = useRef<Annotation[]>([])
  const draftRef = useRef<Annotation | null>(null)
  const drawing = useRef<{ id: string; kind: 'rect' | 'arrow'; x: number; y: number } | null>(null)
  const shownId = useRef<string | undefined>(undefined)
  const saveGen = useRef(0)
  const zoomByRef = useRef<(factor: number) => void>(() => {})
  const zoomStateRef = useRef({ mode, zoom })
  annosRef.current = annos
  draftRef.current = draft
  shownId.current = item?.id
  zoomStateRef.current = { mode, zoom }

  zoomByRef.current = (factor: number) => {
    const current = items[index]
    if (!current || VIDEO.has(current.ext) || AUDIO.has(current.ext)) return
    const live = zoomStateRef.current
    let base = 0
    if (live.mode === 'zoom') base = live.zoom
    else if (live.mode === 'actual') base = 1
    else {
      const img = frameRef.current?.querySelector('img')
      if (img && natural.w > 0) {
        const shown = img.getBoundingClientRect().width
        if (shown > 1) base = shown / natural.w
      }
    }
    if (base <= 0) return
    const next = clampZoom(base * factor)
    // 同一帧里的连续滚轮要叠乘，不能每次都从上次渲染的倍率重算
    zoomStateRef.current = { mode: 'zoom', zoom: next }
    setMode('zoom')
    setZoom(next)
  }

  useEffect(() => {
    setMode('fit')
    setZoom(1)
    setNatural({ w: 0, h: 0 })
    setDraft(null)
    setTextDraft(null)
    drawing.current = null
    setAnnos([])
    if (!item || !VIEWABLE.has(item.ext)) return
    let cancelled = false
    void window.aerie.items.annotations(item.id).then((list) => {
      if (!cancelled) setAnnos(list)
    })
    return () => {
      cancelled = true
    }
  }, [item?.id, item?.ext])

  useLayoutEffect(() => {
    const el = frameRef.current
    if (!el) return
    const update = (): void => {
      const rect = el.getBoundingClientRect()
      const w = Math.max(1, rect.width)
      const h = Math.max(1, rect.height)
      // 尺寸没变就别 setState，否则观察自己的布局会转个不停
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [item?.id, mode, zoom, natural.w, natural.h])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (typing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (textDraft) {
          setTextDraft(null)
          return
        }
        onClose()
        return
      }
      if (e.key === 'ArrowLeft' && absIndex > 0) {
        e.preventDefault()
        onAbsIndex(absIndex - 1)
      }
      if (e.key === 'ArrowRight' && absIndex < totalCount - 1) {
        e.preventDefault()
        onAbsIndex(absIndex + 1)
      }
      if (e.key === ' ') {
        e.preventDefault()
        setPlaying((prev) => !prev)
        return
      }
      if (e.key === '0') setMode('fit')
      if (e.key === '1') setMode('actual')
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomByRef.current(ZOOM_STEP)
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        zoomByRef.current(1 / ZOOM_STEP)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [absIndex, totalCount, onClose, onAbsIndex, textDraft])

  useEffect(() => {
    const onZoom = (e: Event): void => {
      const detail = (e as CustomEvent<string>).detail
      if (detail === 'zoom-in') zoomByRef.current(ZOOM_STEP)
      else if (detail === 'zoom-out') zoomByRef.current(1 / ZOOM_STEP)
      else if (detail === 'zoom-reset') setMode('fit')
    }
    window.addEventListener(VIEWER_ZOOM_EVENT, onZoom)
    return () => window.removeEventListener(VIEWER_ZOOM_EVENT, onZoom)
  }, [])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const current = items[index]
      if (!current || VIDEO.has(current.ext) || AUDIO.has(current.ext)) return
      e.preventDefault()
      zoomByRef.current(e.deltaY < 0 ? 1.12 : 1 / 1.12)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [index, items])

  useEffect(() => {
    const ext = item?.ext
    const blocked =
      !playing ||
      tool !== 'view' ||
      textDraft !== null ||
      (ext != null && (VIDEO.has(ext) || AUDIO.has(ext)))
    if (blocked) return
    const timer = window.setInterval(() => {
      onAbsIndex(absIndex >= totalCount - 1 ? 0 : absIndex + 1)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [playing, tool, textDraft, item?.ext, absIndex, totalCount, onAbsIndex])

  useLayoutEffect(() => {
    const el = stripRef.current
    if (!el) return
    const target = Math.max(0, index * STRIP_STEP - (el.clientWidth - STRIP_W) / 2)
    el.scrollLeft = target
    setStripScroll(target)
    setStripWidth(el.clientWidth)
    const onWheel = (e: WheelEvent): void => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    const observer = new ResizeObserver(() => setStripWidth(el.clientWidth))
    observer.observe(el)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      observer.disconnect()
      el.removeEventListener('wheel', onWheel)
    }
  }, [index, item?.id])

  if (!item) return null

  const stripStart = Math.max(0, Math.floor(stripScroll / STRIP_STEP) - 6)
  const stripEnd = Math.min(items.length, stripStart + Math.ceil(stripWidth / STRIP_STEP) + 12)

  const kind = VIDEO.has(item.ext) ? 'video' : AUDIO.has(item.ext) ? 'audio' : VIEWABLE.has(item.ext) ? 'image' : 'other'
  const src = kind === 'other' ? `aerie-thumb://lg/${item.id}` : originalUrl(item)

  const fitted = mode === 'fit'
  const scale = mode === 'actual' ? 1 : zoom
  const pixelW = natural.w > 0 ? Math.round(natural.w * scale) : undefined
  const shownScale =
    mode === 'zoom' ? zoom : mode === 'actual' ? 1 : natural.w > 1 && box.w > 1 ? box.w / natural.w : 0
  const zoomable = kind !== 'video' && kind !== 'audio'
  const zoomLabel = shownScale > 0 ? `${Math.round(shownScale * 100)}%` : '—'
  const shapes = draft ? [...annos, draft] : annos

  const persist = (next: Annotation[]): void => {
    const gen = ++saveGen.current
    const id = item.id
    setAnnos(next)
    void window.aerie.items
      .setAnnotations(id, next)
      .then((saved) => {
        // 翻页或又画了一笔之后，旧的回写不能盖掉当前画面
        if (saveGen.current !== gen || shownId.current !== id) return
        setAnnos(saved)
      })
      .catch(() => undefined)
  }

  const pickTool = (next: DrawTool): void => {
    setTextDraft(null)
    setTool((prev) => (prev === next ? 'view' : next))
  }

  return (
    <div className="viewer" onClick={onClose}>
      <div className="viewer-top" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-title" title={`${item.name}.${item.ext}`}>
          <span className="viewer-name">
            {item.name}.{item.ext}
          </span>
        </div>
        <span className="viewer-index">
          {absIndex + 1} / {totalCount}
        </span>
        <button
          className={`btn-ghost sm ${playing ? 'is-on' : ''}`}
          title="空格"
          onClick={() => setPlaying((prev) => !prev)}
        >
          {playing ? '暂停' : '播放'}
        </button>
        <div className="seg" role="group" aria-label="缩放">
          <button
            className="viewer-zoom-step"
            aria-label="缩小"
            title="缩小（−）"
            disabled={!zoomable || shownScale <= 0 || shownScale <= ZOOM_MIN + 0.001}
            onClick={() => zoomByRef.current(1 / ZOOM_STEP)}
          >
            −
          </button>
          <button className={fitted ? 'is-on' : ''} title="适应窗口（0）" onClick={() => setMode('fit')}>
            适应
          </button>
          <span className="viewer-zoom-pct">{zoomable ? zoomLabel : '—'}</span>
          <button className={mode === 'actual' ? 'is-on' : ''} title="实际大小（1）" onClick={() => setMode('actual')}>
            100%
          </button>
          <button
            className="viewer-zoom-step"
            aria-label="放大"
            title="放大（+）"
            disabled={!zoomable || shownScale <= 0 || shownScale >= ZOOM_MAX - 0.001}
            onClick={() => zoomByRef.current(ZOOM_STEP)}
          >
            +
          </button>
        </div>
        {kind === 'image' && (
          <>
            <div className="seg" role="group" aria-label="标注">
              <button className={tool === 'rect' ? 'is-on' : ''} onClick={() => pickTool('rect')}>
                矩形
              </button>
              <button className={tool === 'arrow' ? 'is-on' : ''} onClick={() => pickTool('arrow')}>
                箭头
              </button>
              <button className={tool === 'text' ? 'is-on' : ''} onClick={() => pickTool('text')}>
                文字
              </button>
            </div>
            <button
              className="btn-ghost sm"
              disabled={annos.length === 0}
              onClick={() => {
                if (!confirm('清除这张图上的标注？')) return
                persist([])
              }}
            >
              清除
            </button>
          </>
        )}
        <button className="icon-btn viewer-close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="viewer-body">
        <button
          type="button"
          className="viewer-nav is-prev"
          aria-label="上一张"
          disabled={absIndex === 0}
          onClick={(e) => {
            e.stopPropagation()
            onAbsIndex(Math.max(0, absIndex - 1))
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14.5 5.5 8 12l6.5 6.5" />
          </svg>
        </button>
        <button
          type="button"
          className="viewer-nav is-next"
          aria-label="下一张"
          disabled={absIndex >= totalCount - 1}
          onClick={(e) => {
            e.stopPropagation()
            onAbsIndex(Math.min(totalCount - 1, absIndex + 1))
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9.5 5.5 16 12l-6.5 6.5" />
          </svg>
        </button>
      <div className="viewer-stage" ref={stageRef} onClick={(e) => e.stopPropagation()}>
        {kind === 'video' ? (
          <video key={item.id} src={src} controls autoPlay />
        ) : kind === 'audio' ? (
          <div className="viewer-audio">
            <img src={`aerie-thumb://lg/${item.id}`} alt="" />
            <audio key={item.id} src={src} controls autoPlay />
          </div>
        ) : (
          <div
            className={`viewer-frame ${fitted ? '' : 'is-zoomed'}`}
            ref={frameRef}
            style={fitted ? undefined : pixelW ? { width: pixelW } : undefined}
          >
            <img
              key={item.id}
              src={src}
              alt={item.name}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onDoubleClick={(e) => {
                if (tool !== 'view') return
                e.preventDefault()
                e.stopPropagation()
                setMode((prev) => (prev === 'fit' ? 'actual' : 'fit'))
              }}
            />
            {kind === 'image' && (
              <div
                className={`anno-layer ${tool === 'view' ? 'is-idle' : ''}`}
                onPointerDown={(e) => {
                  if (tool === 'view' || tool === 'text') {
                    if (tool === 'text') {
                      const point = relativePoint(e)
                      setTextDraft({ x: point.x, y: point.y, value: '' })
                    }
                    return
                  }
                  e.currentTarget.setPointerCapture(e.pointerId)
                  const point = relativePoint(e)
                  drawing.current = { id: crypto.randomUUID(), kind: tool, x: point.x, y: point.y }
                  const next = { id: drawing.current.id, kind: tool, x: point.x, y: point.y, w: 0, h: 0 }
                  draftRef.current = next
                  setDraft(next)
                }}
                onPointerMove={(e) => {
                  const start = drawing.current
                  if (!start) return
                  const point = relativePoint(e)
                  const next: Annotation =
                    start.kind === 'rect'
                      ? {
                          id: start.id,
                          kind: 'rect',
                          x: Math.min(start.x, point.x),
                          y: Math.min(start.y, point.y),
                          w: Math.abs(point.x - start.x),
                          h: Math.abs(point.y - start.y),
                        }
                      : {
                          id: start.id,
                          kind: 'arrow',
                          x: start.x,
                          y: start.y,
                          w: point.x - start.x,
                          h: point.y - start.y,
                        }
                  draftRef.current = next
                  setDraft(next)
                }}
                onPointerUp={() => {
                  const done = draftRef.current
                  drawing.current = null
                  draftRef.current = null
                  setDraft(null)
                  if (!done) return
                  if (done.kind === 'rect' && (done.w < 0.002 || done.h < 0.002)) return
                  if (done.kind === 'arrow' && Math.hypot(done.w, done.h) < 0.002) return
                  persist([...annosRef.current, done])
                }}
              >
                <svg viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none">
                  {shapes.map((shape) =>
                    shape.kind === 'rect' ? (
                      <rect
                        key={shape.id}
                        x={shape.x * box.w}
                        y={shape.y * box.h}
                        width={shape.w * box.w}
                        height={shape.h * box.h}
                        fill="rgba(245,197,24,0.14)"
                        stroke={ANNO_COLOR}
                        strokeWidth={2}
                      />
                    ) : shape.kind === 'arrow' ? (
                      <ArrowShape key={shape.id} a={shape} box={box} />
                    ) : null,
                  )}
                </svg>
                {annos
                  .filter((shape) => shape.kind === 'text' && shape.text)
                  .map((shape) => (
                    <div
                      key={shape.id}
                      className="anno-text"
                      style={{ left: `${shape.x * 100}%`, top: `${shape.y * 100}%` }}
                    >
                      {shape.text}
                    </div>
                  ))}
                {textDraft && (
                  <input
                    className="anno-input"
                    style={{ left: `${textDraft.x * 100}%`, top: `${textDraft.y * 100}%` }}
                    autoFocus
                    value={textDraft.value}
                    placeholder="回车保存"
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        const value = textDraft.value.trim()
                        const at = textDraft
                        setTextDraft(null)
                        if (!value) return
                        persist([
                          ...annosRef.current,
                          { id: crypto.randomUUID(), kind: 'text', x: at.x, y: at.y, w: 0, h: 0, text: value },
                        ])
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setTextDraft(null)
                      }
                    }}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
      </div>

      {item.palette.length > 0 && (
        <div className="viewer-palette" onClick={(e) => e.stopPropagation()}>
          {item.palette.map((hex) => (
            <span key={hex} style={{ background: `#${hex}` }} title={`#${hex}`} />
          ))}
        </div>
      )}

      <div
        className="viewer-strip"
        ref={stripRef}
        onClick={(e) => e.stopPropagation()}
        onScroll={(e) => setStripScroll(e.currentTarget.scrollLeft)}
      >
        <div className="viewer-strip-inner" style={{ width: items.length * STRIP_STEP }}>
          {items.slice(stripStart, stripEnd).map((thumb, offset) => {
            const thumbIndex = stripStart + offset
            return (
              <button
                key={thumb.id}
                type="button"
                className={`viewer-thumb ${thumbIndex === index ? 'is-on' : ''}`}
                style={{ transform: `translateX(${thumbIndex * STRIP_STEP}px)` }}
                title={thumb.name}
                onClick={() => goLocal(thumbIndex)}
              >
                <img src={`aerie-thumb://sm/${thumb.id}`} alt="" draggable={false} />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function RenameDialog({
  items,
  onClose,
  onApply,
}: {
  items: Item[]
  onClose: () => void
  onApply: (template: string, start: number, renameFiles: boolean) => void
}): JSX.Element {
  const [template, setTemplate] = useState('{name}')
  const [start, setStart] = useState(1)
  const [renameFiles, setRenameFiles] = useState(false)
  const preview = items.slice(0, 4).map((item, i) =>
    renderNameTemplate(template, { name: item.name, ext: item.ext, index: start + i }),
  )

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          onApply(template, start, renameFiles)
        }}
      >
        <div className="modal-title">批量重命名 {items.length} 项</div>
        <label className="field">
          <span>模板</span>
          <input value={template} onChange={(e) => setTemplate(e.target.value)} autoFocus />
        </label>
        <p className="modal-hint">{'{name}'} 原名，{'{index}'} 序号，{'{index:3}'} 补零，{'{ext}'} 扩展名</p>
        <label className="field">
          <span>起始序号</span>
          <input
            type="number"
            min={0}
            value={start}
            onChange={(e) => setStart(Number(e.target.value) || 0)}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={renameFiles}
            onChange={(e) => setRenameFiles(e.target.checked)}
          />
          同时重命名磁盘上的文件
        </label>
        <div className="rename-preview">
          {preview.map((name, i) => (
            <div key={items[i].id}>
              <span>{items[i].name}</span>
              <span>→ {name || '（空，会跳过）'}</span>
            </div>
          ))}
          {items.length > preview.length && <div className="modal-hint">还有 {items.length - preview.length} 项…</div>}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary">
            重命名
          </button>
        </div>
      </form>
    </div>
  )
}

export function SimilarDialog({
  scan,
  onClose,
  onTrash,
}: {
  scan: SimilarScan
  onClose: () => void
  onTrash: (ids: string[]) => void
}): JSX.Element {
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          相似图片
          <span className="modal-hint">
            比了 {scan.compared.toLocaleString()} 张
            {scan.approximate ? '，数量较多，只合并了完全相同的指纹' : '，汉明距离 6 以内算一组'}
          </span>
        </div>
        {scan.groups.length === 0 && <p className="modal-hint">没有找到重复或相似的图。</p>}
        <div className="similar-list">
          {scan.groups.map((group) => (
            <div key={group.items.map((i) => i.id).join()} className="similar-group">
              <div className="similar-head">
                <span>
                  {group.items.length} 张{group.distance === 0 ? '，指纹相同' : `，相差 ${group.distance} 位`}
                </span>
                <button
                  className="btn-ghost sm"
                  onClick={() => onTrash(group.items.slice(1).map((i) => i.id))}
                >
                  保留第一张，其余移入回收站
                </button>
              </div>
              <div className="similar-row">
                {group.items.map((item) => (
                  <div key={item.id} className="similar-card" title={item.name}>
                    <img src={`aerie-thumb://md/${item.id}`} alt={item.name} />
                    <span>{item.name}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

export function Menu({
  x,
  y,
  entries,
  onPick,
  onClose,
}: {
  x: number
  y: number
  entries: { id: string; label: string; danger?: boolean }[]
  onPick: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const left = Math.min(x, window.innerWidth - 200)
  const top = Math.min(y, window.innerHeight - entries.length * 32 - 12)

  return (
    <div ref={ref} className="menu" style={{ left, top }}>
      {entries.map((entry) => (
        <button
          key={entry.id}
          className={entry.danger ? 'is-danger' : ''}
          onClick={() => onPick(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  )
}

export function SideMenu({
  x,
  y,
  title,
  onRename,
  onDelete,
  onColor,
  onClose,
  onNewChild,
  onSetCover,
}: {
  x: number
  y: number
  title: string
  onRename: () => void
  onDelete: () => void
  onColor: (color: string | null) => void
  onClose: () => void
  onNewChild?: () => void
  onSetCover?: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])

  return (
    <div ref={ref} className="menu" style={{ left: Math.min(x, window.innerWidth - 220), top: y }}>
      <button onClick={onRename}>重命名「{title}」</button>
      <div className="color-dots">
        {LABEL_COLORS.map((color) => (
          <button key={color} style={{ background: color }} onClick={() => onColor(color)} />
        ))}
        <button className="color-none" onClick={() => onColor(null)} title="清除颜色">
          ×
        </button>
      </div>
      {onNewChild && <button onClick={onNewChild}>新建子文件夹</button>}
      {onSetCover && <button onClick={onSetCover}>用选中的素材做封面</button>}
      <button className="is-danger" onClick={onDelete}>
        删除
      </button>
    </div>
  )
}

function bytesToMbInput(bytes: number | undefined): string {
  if (bytes == null) return ''
  return String(Math.round((bytes / 1048576) * 100) / 100)
}

function mbInputToBytes(raw: string): number | undefined {
  if (!raw.trim()) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * 1048576)
}

function dateInputValue(ms: number | undefined): string {
  if (ms == null) return ''
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function dateStart(raw: string): number | undefined {
  if (!raw) return undefined
  const time = new Date(`${raw}T00:00:00`).getTime()
  return Number.isFinite(time) ? time : undefined
}

function dateEnd(raw: string): number | undefined {
  if (!raw) return undefined
  const time = new Date(`${raw}T23:59:59.999`).getTime()
  return Number.isFinite(time) ? time : undefined
}

/** 用当前筛选另存。大小和时间侧栏上没有入口，所以在这里补。 */
export function SmartFolderDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: SmartFolderRules
  onClose: () => void
  onSave: (name: string, rules: SmartFolderRules) => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [minMb, setMinMb] = useState(bytesToMbInput(initial.minSize))
  const [maxMb, setMaxMb] = useState(bytesToMbInput(initial.maxSize))
  const [from, setFrom] = useState(dateInputValue(initial.addedFrom))
  const [to, setTo] = useState(dateInputValue(initial.addedTo))
  const [takenFrom, setTakenFrom] = useState(dateInputValue(initial.takenFrom))
  const [takenTo, setTakenTo] = useState(dateInputValue(initial.takenTo))
  const summary = describeRules({
    ...initial,
    minSize: undefined,
    maxSize: undefined,
    addedFrom: undefined,
    addedTo: undefined,
    takenFrom: undefined,
    takenTo: undefined,
  })

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          onSave(
            name.trim(),
            normalizeRules({
              ...initial,
              minSize: mbInputToBytes(minMb),
              maxSize: mbInputToBytes(maxMb),
              addedFrom: dateStart(from),
              addedTo: dateEnd(to),
              takenFrom: dateStart(takenFrom),
              takenTo: dateEnd(takenTo),
            }),
          )
        }}
      >
        <div className="modal-title">保存智能文件夹</div>
        <p className="modal-hint">会记下当前的筛选。之后点它，就按这些条件重新查。</p>
        <label className="field">
          <span>名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="例如：三星以上的海报" />
        </label>
        <p className="modal-hint">当前条件：{summary}</p>
        <div className="field-row">
          <label className="field">
            <span>最小 MB</span>
            <input value={minMb} onChange={(e) => setMinMb(e.target.value)} inputMode="decimal" />
          </label>
          <label className="field">
            <span>最大 MB</span>
            <input value={maxMb} onChange={(e) => setMaxMb(e.target.value)} inputMode="decimal" />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>加入自</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>加入至</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>拍摄自</span>
            <input type="date" value={takenFrom} onChange={(e) => setTakenFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>拍摄至</span>
            <input type="date" value={takenTo} onChange={(e) => setTakenTo(e.target.value)} />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={!name.trim()}>
            保存
          </button>
        </div>
      </form>
    </div>
  )
}

/** 浏览器扩展要的端口和 token，以及 OCR 能不能用。 */
export function ConnectDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [info, setInfo] = useState<IngestInfo | null>(null)
  const [ocr, setOcr] = useState<OcrStatus | null>(null)
  const [hint, setHint] = useState('')

  const reload = (): void => {
    void window.aerie.ingest.info().then(setInfo)
    void window.aerie.ocr.status().then(setOcr)
  }

  useEffect(() => {
    reload()
  }, [])

  const copy = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setHint(`已复制${label}`)
    })
  }

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">收藏与识别</div>
        <p className="modal-hint">
          浏览器扩展把图片发到本机。服务只听 127.0.0.1，别人连不上。在 Chrome 打开
          chrome://extensions，加载仓库里的 extension 文件夹，把端口和 token 填进扩展弹窗。
        </p>
        <label className="field">
          <span>端口</span>
          <div className="token-row">
            <code>{info?.port ?? '…'}</code>
            <button
              type="button"
              className="btn-ghost sm"
              disabled={info?.port == null}
              onClick={() => info?.port != null && copy(String(info.port), '端口')}
            >
              复制
            </button>
          </div>
        </label>
        <label className="field">
          <span>Token</span>
          <div className="token-row">
            <code title={info?.token}>{info?.token || '…'}</code>
            <button
              type="button"
              className="btn-ghost sm"
              disabled={!info?.token}
              onClick={() => info?.token && copy(info.token, ' token')}
            >
              复制
            </button>
          </div>
        </label>
        <p className="modal-hint">
          {info?.listening
            ? `正在监听 ${info.host}:${info.port}`
            : info?.error || '收藏服务没起来'}
        </p>
        <p className="modal-hint">
          {ocr?.available
            ? ocr.pending > 0
              ? `画面文字识别进行中，还剩 ${ocr.pending} 张。识别完就能在搜索框里搜到图上的字。`
              : '画面文字会在导入后后台识别，搜索框能搜到图上的字。'
            : ocr?.reason || '正在确认画面文字识别…'}
        </p>
        {hint && <p className="modal-hint">{hint}</p>}
        <div className="modal-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              if (!confirm('换一个 token？扩展里旧的会失效。')) return
              void window.aerie.ingest.regenerate().then((next) => {
                setInfo(next)
                setHint('已更换 token')
              })
            }}
          >
            更换 token
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
