import type { LocalDocumentLocator, ReadLocalFileResponse } from '@shared/api/svcAgentLocalFiles'

export const LOCAL_FILE_PREVIEW_MAX_CHARS = 64 * 1024

export type LocalFileVisualPreview = Readonly<{
  text: string
  escaped: boolean
  truncated: boolean
}>

export function localDocumentLocationLabel(locator: LocalDocumentLocator): string {
  switch (locator.kind) {
    case 'pdf-item':
      return `Page ${locator.page}`
    case 'docx-paragraph':
      return `Paragraph ${locator.paragraph + 1}`
    case 'docx-table-cell':
      return `Table ${locator.table + 1}, row ${locator.row + 1}, column ${locator.column + 1}`
    case 'xlsx-cell':
      return `Sheet ${locator.sheet}, ${locator.cell}`
    case 'pptx-shape':
      return `Slide ${locator.slide}, shape ${locator.shape + 1}, paragraph ${locator.paragraph + 1}`
  }
}

export function formatLocalDocumentPreview(file: ReadLocalFileResponse): string {
  if (!file.document) return file.content
  let previous: string | undefined
  return file.document.segments
    .map((segment) => {
      const label = localDocumentLocationLabel(segment.locator)
      const prefix = label === previous ? '' : `${previous === undefined ? '' : '\n'}[${label}]\n`
      previous = label
      return prefix + segment.text
    })
    .join('')
}

function requiresVisibleToken(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x00ad ||
    code === 0x034f ||
    code === 0x061c ||
    code === 0x180e ||
    code === 0x200b ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    code === 0xfeff ||
    (code >= 0xfff9 && code <= 0xfffb)
  )
}

/**
 * A bounded display derivative, never an attachment, path, grant or sanitised instruction.
 * Preserve ordinary Unicode, line breaks, tabs and ZWJ/ZWNJ used by scripts and emoji.
 * Visible tokens expose selected controls; they do not prevent all Unicode confusables.
 */
export function formatLocalFilePreview(value: string): LocalFileVisualPreview {
  if (typeof value !== 'string') return { text: '', escaped: false, truncated: false }
  const parts: string[] = []
  let index = 0
  let length = 0
  let escaped = false
  while (index < value.length && length < LOCAL_FILE_PREVIEW_MAX_CHARS) {
    const code = value.codePointAt(index)!
    const width = code > 0xffff ? 2 : 1
    const controlled = requiresVisibleToken(code)
    const part = controlled
      ? `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`
      : value.slice(index, index + width)
    // Never cut a marker or surrogate pair, nor scan the unseen remainder.
    if (length + part.length > LOCAL_FILE_PREVIEW_MAX_CHARS) break
    parts.push(part)
    length += part.length
    escaped ||= controlled
    index += width
  }
  return { text: parts.join(''), escaped, truncated: index < value.length }
}
