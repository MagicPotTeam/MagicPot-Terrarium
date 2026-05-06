import { describe, expect, it } from 'vitest'
import {
  buildFileMetaLabel,
  detectDisplayFileKind,
  formatFileSize,
  getFileBadgeText,
  guessMimeTypeFromFileName,
  isBasicEditableFile,
  normalizeFileMimeType
} from './fileDisplay'

describe('fileDisplay', () => {
  it('guesses office mime types from the file name', () => {
    expect(guessMimeTypeFromFileName('deck.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
    expect(guessMimeTypeFromFileName('notes.doc')).toBe('application/msword')
    expect(guessMimeTypeFromFileName('sheet.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    expect(guessMimeTypeFromFileName('table.csv')).toBe('text/csv')
  })

  it('normalizes generic binary mime types from the file name', () => {
    expect(normalizeFileMimeType('deck.pptx', 'application/octet-stream')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
    expect(normalizeFileMimeType('notes.docx', undefined)).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    expect(normalizeFileMimeType('sheet.xls', 'application/octet-stream')).toBe(
      'application/vnd.ms-excel'
    )
  })

  it('detects the display kind from file names and mime types', () => {
    expect(detectDisplayFileKind('notes.md')).toBe('markdown')
    expect(detectDisplayFileKind(undefined, 'application/msword')).toBe('word')
    expect(detectDisplayFileKind('table.csv')).toBe('excel')
    expect(detectDisplayFileKind('sheet.xlsx')).toBe('excel')
    expect(detectDisplayFileKind('slides.ppt')).toBe('powerpoint')
    expect(detectDisplayFileKind('report.pdf')).toBe('pdf')
    expect(detectDisplayFileKind('archive.zip')).toBe('archive')
  })

  it('builds a stable badge text when only mime type is available', () => {
    expect(getFileBadgeText(undefined, 'application/vnd.ms-powerpoint')).toBe('PPT')
    expect(getFileBadgeText(undefined, 'application/vnd.ms-excel')).toBe('XLS')
    expect(getFileBadgeText('table.csv')).toBe('CSV')
    expect(getFileBadgeText('notes.txt')).toBe('TXT')
  })

  it('formats file sizes across units', () => {
    expect(formatFileSize(900)).toBe('900 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('builds a readable metadata label', () => {
    expect(
      buildFileMetaLabel({
        fileName: 'outline.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 12_345,
        includeBadge: true
      })
    ).toBe('Word | DOCX | 12 KB')

    expect(
      buildFileMetaLabel({
        fileName: 'budget.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        includeBadge: true
      })
    ).toBe('Excel | XLSX')

    expect(
      buildFileMetaLabel({
        fileName: 'table.csv',
        mimeType: 'text/csv',
        includeBadge: true
      })
    ).toBe('Excel | CSV')

    expect(
      buildFileMetaLabel({
        fileName: 'draft.md',
        mimeType: 'text/markdown',
        editable: true
      })
    ).toBe('Markdown | Editable')

    expect(
      buildFileMetaLabel({
        fileName: 'attachment',
        mimeType: 'application/vnd.ms-powerpoint',
        includeBadge: true
      })
    ).toBe('PowerPoint | PPT')
  })

  it('identifies editable plain text files', () => {
    expect(isBasicEditableFile('notes.txt')).toBe(true)
    expect(isBasicEditableFile('readme.md', 'application/octet-stream')).toBe(true)
    expect(isBasicEditableFile('table.csv', 'application/octet-stream')).toBe(true)
    expect(isBasicEditableFile('brief.docx')).toBe(false)
  })
})
