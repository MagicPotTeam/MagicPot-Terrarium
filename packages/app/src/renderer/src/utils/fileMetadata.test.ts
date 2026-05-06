import { describe, expect, it } from 'vitest'
import {
  buildFileMetaLine,
  detectDisplayFileKind,
  getFileBadgeText,
  isBasicEditableFile,
  normalizeFileMimeType
} from './fileMetadata'

describe('fileMetadata', () => {
  it('normalizes office and archive mime types from file names', () => {
    expect(normalizeFileMimeType('slides.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
    expect(normalizeFileMimeType('budget.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    expect(normalizeFileMimeType('table.csv')).toBe('text/csv')
    expect(normalizeFileMimeType('archive.zip', 'application/octet-stream')).toBe('application/zip')
  })

  it('detects display kinds for common file types', () => {
    expect(detectDisplayFileKind('notes.md')).toBe('markdown')
    expect(detectDisplayFileKind('table.csv')).toBe('excel')
    expect(detectDisplayFileKind('budget.xlsx')).toBe('excel')
    expect(detectDisplayFileKind('report.pdf')).toBe('pdf')
    expect(detectDisplayFileKind('bundle.zip')).toBe('archive')
  })

  it('builds readable metadata lines with badge and editability', () => {
    expect(getFileBadgeText('brief.docx')).toBe('DOCX')
    expect(
      buildFileMetaLine({
        fileName: 'brief.docx',
        mimeType: 'application/octet-stream',
        editable: false
      })
    ).toBe('Word | DOCX | Read only')
    expect(
      buildFileMetaLine({
        fileName: 'budget.xlsx',
        mimeType: 'application/octet-stream',
        editable: false
      })
    ).toBe('Excel | XLSX | Read only')
    expect(
      buildFileMetaLine({
        fileName: 'table.csv',
        mimeType: 'text/csv',
        editable: true
      })
    ).toBe('Excel | CSV | Editable')
    expect(
      buildFileMetaLine({
        fileName: 'notes.md',
        mimeType: 'text/markdown',
        editable: true
      })
    ).toBe('Markdown | MD | Editable')

    expect(
      buildFileMetaLine({
        fileName: 'attachment',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        editable: false
      })
    ).toBe('PowerPoint | PPTX | Read only')
  })

  it('identifies text files as basic editable canvas files', () => {
    expect(isBasicEditableFile('notes.txt')).toBe(true)
    expect(isBasicEditableFile('draft.md', 'application/octet-stream')).toBe(true)
    expect(isBasicEditableFile('table.csv', 'text/csv')).toBe(true)
    expect(isBasicEditableFile('brief.docx')).toBe(false)
  })
})
