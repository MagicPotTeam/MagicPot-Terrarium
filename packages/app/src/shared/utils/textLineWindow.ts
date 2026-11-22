/** Upstream-style line window for files.read: a 0-based first line and a line count. */
export const TEXT_LINE_WINDOW_LIMITS = { offset: 10_000_000, lines: 100_000 } as const

export type TextLineWindowRequest = { offset?: number; limit?: number }

export type TextLineWindow = {
  content: string
  lineOffset: number
  lineCount: number
  totalLines: number
}

export function wantsTextLineWindow(request: TextLineWindowRequest): boolean {
  return request.offset !== undefined || request.limit !== undefined
}

/**
 * Lines keep their own line endings, so joining a window and its neighbours gives back the
 * original text. An offset past the end returns an empty window with the real line count.
 */
export function selectTextLines(text: string, request: TextLineWindowRequest): TextLineWindow {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const start = Math.min(Math.max(0, Math.floor(request.offset ?? 0)), lines.length)
  const end =
    request.limit === undefined
      ? lines.length
      : Math.min(lines.length, start + Math.max(1, Math.floor(request.limit)))
  return {
    content: lines.slice(start, end).join(''),
    lineOffset: start,
    lineCount: end - start,
    totalLines: lines.length
  }
}
