import { normalizeLogBatch } from '@renderer/utils/logText'

// Kept for text consumers; on-screen logs use VirtualLogViewport instead.
export function joinBoundedLogLines(lines: string[], maxLines: number): string {
  return normalizeLogBatch(lines, maxLines).join('\n')
}
