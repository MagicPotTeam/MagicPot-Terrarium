import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import type { CanvasFileItem } from './types'
import {
  buildCanvasFileExportSuggestedName,
  buildCanvasGeneratedExportFile,
  getCanvasFileExportOptions,
  normalizeCanvasFileExportTargetPath
} from './canvasFileExportUtils'

function createFileItem(overrides: Partial<CanvasFileItem> = {}): CanvasFileItem {
  return {
    id: 'file-1',
    type: 'file',
    src: 'blob:file-1',
    fileName: 'brief.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileKind: 'word',
    x: 0,
    y: 0,
    width: 240,
    height: 160,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    editable: false,
    previewText: 'Brief summary',
    ...overrides
  }
}

describe('canvasFileExportUtils', () => {
  it('lists original and converted export options for word files', () => {
    expect(getCanvasFileExportOptions(createFileItem(), 'en-US')).toEqual([
      { format: 'original', label: 'Original file (.docx)' },
      { format: 'txt', label: 'Text (.txt)' },
      { format: 'md', label: 'Markdown (.md)' },
      { format: 'word', label: 'Word document (.docx)' }
    ])
  })

  it('omits duplicate original export entries for markdown files', () => {
    expect(
      getCanvasFileExportOptions(
        createFileItem({
          fileName: 'notes.md',
          mimeType: 'text/markdown',
          fileKind: 'markdown',
          editable: true
        }),
        'en-US'
      )
    ).toEqual([
      { format: 'md', label: 'Markdown (.md)' },
      { format: 'txt', label: 'Text (.txt)' },
      { format: 'word', label: 'Word document (.docx)' }
    ])
  })

  it('builds export filenames with a safe export suffix', () => {
    expect(buildCanvasFileExportSuggestedName(createFileItem(), 'txt')).toBe('brief-export.txt')
    expect(
      buildCanvasFileExportSuggestedName(
        createFileItem({
          fileName: 'brief:final?.docx'
        }),
        'word'
      )
    ).toBe('brief_final_-export.docx')
  })

  it('adds the expected extension to export target paths', () => {
    expect(
      normalizeCanvasFileExportTargetPath('D:/exports/brief-export', 'md', createFileItem())
    ).toBe('D:/exports/brief-export.md')
    expect(
      normalizeCanvasFileExportTargetPath('D:/exports/brief-export.doc', 'word', createFileItem())
    ).toBe('D:/exports/brief-export.docx')
  })

  it('creates docx exports with escaped paragraphs', async () => {
    const exportFile = await buildCanvasGeneratedExportFile(
      'Hello & welcome\nSecond line',
      'brief-export.docx',
      'word'
    )
    const zip = await JSZip.loadAsync(exportFile)
    const documentXml = await zip.file('word/document.xml')?.async('string')

    expect(exportFile.name).toBe('brief-export.docx')
    expect(documentXml).toContain('Hello &amp; welcome')
    expect(documentXml).toContain('Second line')
    expect(documentXml).toContain(
      '<w:p><w:r><w:t xml:space="preserve">Hello &amp; welcome</w:t></w:r></w:p>'
    )
  })
})
