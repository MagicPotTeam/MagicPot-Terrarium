const LOG_JOIN_SEPARATOR = '\n'

export function joinBoundedLogLines(lines: string[], maxLines: number): string {
  return lines.slice(-maxLines).join(LOG_JOIN_SEPARATOR)
}
