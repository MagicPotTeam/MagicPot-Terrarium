import { CSSProperties, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LOG_HISTORY_NOTICE, MAX_LOG_LINES, MAX_LOG_CHARACTERS } from '@renderer/utils/logText'

export const LOG_ROW_HEIGHT = 20
export const LOG_OVERSCAN = 5
const FALLBACK_HEIGHT = 200
const TAIL_THRESHOLD = 20

interface VirtualLogViewportProps {
  /** Normalized, bounded physical rows, not raw stream entries. */
  lines: readonly string[]
  firstIndex?: number
  generation?: number
  tailRequest?: number
  label: string
  emptyText?: string
  style?: CSSProperties
  lineColor?: (line: string) => string | undefined
}

export default function VirtualLogViewport({
  lines,
  firstIndex = 0,
  generation = 0,
  tailRequest = 0,
  label,
  emptyText = 'No logs yet.',
  style,
  lineColor
}: VirtualLogViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const followTail = useRef(true)
  const previous = useRef({ firstIndex, generation, tailRequest })
  const [height, setHeight] = useState(FALLBACK_HEIGHT)
  const [top, setTop] = useState(0)
  // Keep horizontal extent stable while virtual rows enter/leave the DOM. A tab
  // occupies at most four cells; two cells per code point also covers wide glyphs.
  const width = useMemo(
    () =>
      lines.reduce(
        (max, line) => Math.max(max, line.length * 2 + (line.match(/\t/g)?.length ?? 0) * 4),
        0
      ),
    [lines]
  )

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => setHeight(viewport.clientHeight || FALLBACK_HEIGHT)
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(viewport)
    window.addEventListener('resize', measure)
    // Older embedded browsers may not provide ResizeObserver; panel dragging is
    // not a window resize, so use a low-frequency measurement fallback as well.
    const fallback = observer ? undefined : setInterval(measure, 500)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      if (fallback !== undefined) clearInterval(fallback)
    }
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const reset = generation !== previous.current.generation || lines.length === 0
    if (reset || tailRequest !== previous.current.tailRequest) followTail.current = true
    const maxTop = Math.max(0, lines.length * LOG_ROW_HEIGHT - (viewport.clientHeight || height))
    const removed = firstIndex - previous.current.firstIndex
    const nextTop = followTail.current
      ? maxTop
      : Math.max(0, Math.min(maxTop, top - removed * LOG_ROW_HEIGHT))
    viewport.scrollTop = nextTop
    if (reset) viewport.scrollLeft = 0
    setTop(nextTop)
    previous.current = { firstIndex, generation, tailRequest }
    // top is captured at the latest user scroll; scrolling alone must not run this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, firstIndex, generation, tailRequest, height])

  const visibleCount = Math.ceil(height / LOG_ROW_HEIGHT) + 1
  const firstVisible = Math.min(Math.floor(top / LOG_ROW_HEIGHT), Math.max(0, lines.length - 1))
  const start = Math.max(0, firstVisible - LOG_OVERSCAN)
  const end = Math.min(lines.length, firstVisible + visibleCount + LOG_OVERSCAN)

  return (
    <div
      ref={viewportRef}
      role="log"
      aria-label={label}
      aria-live="off"
      tabIndex={0}
      title={`${LOG_HISTORY_NOTICE} (${MAX_LOG_LINES} rows / ${MAX_LOG_CHARACTERS} characters)`}
      onScroll={(event) => {
        const viewport = event.currentTarget
        // Layout may clamp scrollTop before ResizeObserver updates React height.
        // Read the live viewport size so that clamp does not disable follow-tail.
        const maxTop = Math.max(
          0,
          lines.length * LOG_ROW_HEIGHT - (viewport.clientHeight || height)
        )
        followTail.current = maxTop - viewport.scrollTop <= TAIL_THRESHOLD
        setTop(viewport.scrollTop)
      }}
      style={{
        ...style,
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: 'auto',
        overflowAnchor: 'none',
        fontFamily: '"Cascadia Code", "Consolas", "Courier New", monospace',
        fontSize: 13,
        lineHeight: `${LOG_ROW_HEIGHT}px`,
        whiteSpace: 'pre',
        tabSize: 4
      }}
    >
      {lines.length === 0 ? (
        <div style={{ paddingLeft: 8 }}>{emptyText}</div>
      ) : (
        <div
          style={{
            height: lines.length * LOG_ROW_HEIGHT,
            minWidth: '100%',
            width: `${width}ch`,
            position: 'relative'
          }}
        >
          <div style={{ position: 'absolute', top: start * LOG_ROW_HEIGHT, left: 8 }}>
            {lines.slice(start, end).map((line, index) => (
              <div
                key={`${generation}-${firstIndex + start + index}`}
                data-log-row={firstIndex + start + index}
                style={{ height: LOG_ROW_HEIGHT, color: lineColor?.(line) }}
              >
                {line || '\u00a0'}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
