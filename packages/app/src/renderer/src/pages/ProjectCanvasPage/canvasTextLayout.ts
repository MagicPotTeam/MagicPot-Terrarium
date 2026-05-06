export const CANVAS_TEXT_PADDING = 12
export const CANVAS_TEXT_LINE_HEIGHT = 1.5
export const CANVAS_TEXT_WRAP = 'char' as const
export const CANVAS_TEXT_MIN_WIDTH = 120
export const CANVAS_TEXT_MAX_WIDTH = 500
export const CANVAS_TEXT_MIN_HEIGHT = 40

type CanvasTextWrapMode = 'char' | 'word' | 'none'

type MeasureCanvasTextOptions = {
  text: string
  fontSize: number
  fontFamily: string
  fontWeight?: 'normal' | 'bold'
  lineHeight?: number
  wrap?: CanvasTextWrapMode
}

type MeasureCanvasTextHeightOptions = MeasureCanvasTextOptions & {
  width: number
}

type MeasureCanvasAnnotationTextHeightOptions = {
  text: string
  width: number
  fontSize: number
  fontWeight?: 'normal' | 'bold'
  fontFamily?: string
}

let canvasTextMeasureRoot: HTMLDivElement | null = null

function normalizeCanvasTextValue(text: string) {
  return text.replace(/\r\n/g, '\n')
}

function getCanvasTextMeasureRoot() {
  if (typeof document === 'undefined') {
    return null
  }

  if (canvasTextMeasureRoot?.isConnected) {
    return canvasTextMeasureRoot
  }

  const parent = document.body ?? document.documentElement
  if (!parent) {
    return null
  }

  const root = document.createElement('div')
  root.setAttribute('data-canvas-text-measure-root', 'true')
  Object.assign(root.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap',
    contain: 'layout style paint'
  })
  parent.appendChild(root)
  canvasTextMeasureRoot = root
  return root
}

function estimateWrappedCanvasTextLineCount(
  line: string,
  maxCharsPerLine: number,
  wrap: CanvasTextWrapMode
) {
  if (!line.length) {
    return 1
  }

  if (wrap !== 'word') {
    return Math.max(1, Math.ceil(line.length / maxCharsPerLine))
  }

  const segments = line.split(/(\s+)/).filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return 1
  }

  let lineCount = 1
  let currentChars = 0

  for (const segment of segments) {
    const remaining = segment.length

    if (currentChars === 0 && remaining > maxCharsPerLine) {
      lineCount += Math.floor((remaining - 1) / maxCharsPerLine)
      currentChars = remaining % maxCharsPerLine
      if (currentChars === 0) {
        currentChars = maxCharsPerLine
      }
      continue
    }

    if (currentChars + remaining <= maxCharsPerLine) {
      currentChars += remaining
      continue
    }

    lineCount += 1
    currentChars = 0

    if (remaining > maxCharsPerLine) {
      lineCount += Math.floor((remaining - 1) / maxCharsPerLine)
      currentChars = remaining % maxCharsPerLine
      if (currentChars === 0) {
        currentChars = maxCharsPerLine
      }
      continue
    }

    currentChars = remaining
  }

  return Math.max(1, lineCount)
}

function estimateCanvasTextMetrics(options: MeasureCanvasTextOptions & { width?: number }) {
  const normalizedText = normalizeCanvasTextValue(options.text)
  const fontSize = Math.max(1, options.fontSize || 16)
  const lineHeight = options.lineHeight ?? CANVAS_TEXT_LINE_HEIGHT
  const wrap = options.wrap ?? CANVAS_TEXT_WRAP
  const charWidth = fontSize * 0.5
  const lines = normalizedText.length ? normalizedText.split('\n') : ['']

  if (wrap === 'none' || options.width == null || !Number.isFinite(options.width)) {
    const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0)
    return {
      width: longestLine * charWidth,
      height: Math.max(1, lines.length) * fontSize * lineHeight
    }
  }

  const innerWidth = Math.max(1, options.width)
  const maxCharsPerLine = Math.max(1, Math.floor(innerWidth / Math.max(charWidth, 1)))
  const lineCount = lines.reduce(
    (count, line) => count + estimateWrappedCanvasTextLineCount(line, maxCharsPerLine, wrap),
    0
  )

  return {
    width: innerWidth,
    height: Math.max(1, lineCount) * fontSize * lineHeight
  }
}

function measureCanvasTextMetricsWithDom(options: MeasureCanvasTextOptions & { width?: number }) {
  const root = getCanvasTextMeasureRoot()
  if (!root) {
    return null
  }

  const element = document.createElement('div')
  const normalizedText = normalizeCanvasTextValue(options.text)
  const wrap = options.wrap ?? CANVAS_TEXT_WRAP
  Object.assign(element.style, {
    display: wrap === 'none' ? 'inline-block' : 'block',
    width: wrap === 'none' ? 'auto' : `${Math.max(1, options.width ?? 1)}px`,
    maxWidth: 'none',
    minWidth: '0',
    padding: '0',
    margin: '0',
    border: '0',
    boxSizing: 'content-box',
    whiteSpace: wrap === 'none' ? 'pre' : 'pre-wrap',
    overflowWrap: wrap === 'char' ? 'anywhere' : 'break-word',
    wordBreak: wrap === 'char' ? 'break-all' : 'normal',
    fontFamily: options.fontFamily,
    fontSize: `${Math.max(1, options.fontSize || 16)}px`,
    fontWeight: options.fontWeight ?? 'normal',
    lineHeight: String(options.lineHeight ?? CANVAS_TEXT_LINE_HEIGHT)
  })
  element.textContent = normalizedText || ' '
  root.appendChild(element)

  const rect = element.getBoundingClientRect()
  root.removeChild(element)

  if (
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    (normalizedText.length > 0 && rect.width === 0 && rect.height === 0)
  ) {
    return null
  }

  return {
    width: rect.width,
    height: rect.height
  }
}

function measureCanvasTextMetrics(options: MeasureCanvasTextOptions & { width?: number }) {
  return measureCanvasTextMetricsWithDom(options) ?? estimateCanvasTextMetrics(options)
}

export function measureCanvasTextNaturalWidth(options: MeasureCanvasTextOptions): number {
  return measureCanvasTextMetrics({
    ...options,
    wrap: 'none'
  }).width
}

export function measureCanvasTextBoxHeight(options: MeasureCanvasTextHeightOptions): number {
  const measuredHeight = measureCanvasTextMetrics({
    text: options.text,
    width: Math.max(10, options.width - CANVAS_TEXT_PADDING * 2),
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    fontWeight: options.fontWeight,
    lineHeight: options.lineHeight,
    wrap: options.wrap
  }).height
  return Math.max(CANVAS_TEXT_MIN_HEIGHT, measuredHeight + CANVAS_TEXT_PADDING * 2)
}

export function measureCanvasAnnotationTextHeight(
  options: MeasureCanvasAnnotationTextHeightOptions
): number {
  return measureCanvasTextMetrics({
    text: options.text,
    width: Math.max(10, options.width),
    fontSize: options.fontSize,
    fontFamily: options.fontFamily ?? 'system-ui, sans-serif',
    fontWeight: options.fontWeight,
    lineHeight: 1.0,
    wrap: 'char'
  }).height
}

export function measureCanvasTextBoxSize(options: MeasureCanvasTextOptions): {
  width: number
  height: number
} {
  const naturalWidth = measureCanvasTextNaturalWidth(options)
  const width = Math.max(
    CANVAS_TEXT_MIN_WIDTH,
    Math.min(CANVAS_TEXT_MAX_WIDTH, naturalWidth + CANVAS_TEXT_PADDING * 2)
  )

  return {
    width,
    height: measureCanvasTextBoxHeight({
      ...options,
      width
    })
  }
}

type GetInlineTextEditorViewportSizeOptions = {
  width: number
  height: number
  stageScale: number
  stageWidth: number
  stageHeight: number
  screenMargin: number
  bottomClearance: number
  isTextItem: boolean
}

export function getInlineTextEditorViewportSize(options: GetInlineTextEditorViewportSizeOptions): {
  width: number
  height: number
  maxWidth: number
  maxHeight: number
} {
  const minWidth = options.isTextItem ? 200 : 10
  const minHeight = options.isTextItem ? 60 : 10
  const requestedWidth = Math.max(options.width * options.stageScale, minWidth)
  const requestedHeight = Math.max(options.height * options.stageScale, minHeight)
  const maxWidth = Math.max(minWidth, options.stageWidth - options.screenMargin * 2)
  const maxHeight = Math.max(
    minHeight,
    options.stageHeight - options.screenMargin - options.bottomClearance
  )

  return {
    width: Math.min(requestedWidth, maxWidth),
    height: Math.min(requestedHeight, maxHeight),
    maxWidth,
    maxHeight
  }
}
