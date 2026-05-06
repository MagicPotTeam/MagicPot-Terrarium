import JSZip from 'jszip'
import { sanitizeFilePart } from './canvasExportNamingUtils'
import type { CanvasFileItem } from './types'
import { getFileExtension } from './types'

export type CanvasFileExportFormat = 'original' | 'txt' | 'md' | 'word'

type CanvasFileExportOption = {
  format: CanvasFileExportFormat
  label: string
}

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const WORD_DOCUMENT_XML_NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'mc:Ignorable="w14 wp14"'
].join(' ')

function isChineseUiLanguage(language?: string | null): boolean {
  return (language || '').toLowerCase().startsWith('zh')
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildWordDocumentParagraphs(text: string): string {
  const normalizedText = text.replace(/\r\n/g, '\n')
  const lines = normalizedText.split('\n')

  if (lines.length === 0) {
    return '<w:p/>'
  }

  return lines
    .map((line) => {
      if (!line) {
        return '<w:p/>'
      }

      return `<w:p><w:r><w:t xml:space="preserve">${escapeXmlText(line)}</w:t></w:r></w:p>`
    })
    .join('')
}

async function buildWordDocumentBlob(text: string): Promise<Blob> {
  const zip = new JSZip()
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${WORD_DOCUMENT_XML_NAMESPACES}>
  <w:body>
    ${buildWordDocumentParagraphs(text)}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="${DOCX_MIME_TYPE}"/>
</Types>`
  )
  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )
  zip.folder('word')?.file('document.xml', documentXml)

  return zip.generateAsync({
    type: 'blob',
    mimeType: DOCX_MIME_TYPE
  })
}

export function getCanvasFileExportFormats(item: CanvasFileItem): CanvasFileExportFormat[] {
  if (item.fileKind === 'word' || item.fileKind === 'powerpoint') {
    return ['original', 'txt', 'md', 'word']
  }

  if (item.fileKind === 'markdown') {
    return ['md', 'txt', 'word']
  }

  if (item.fileKind === 'text') {
    return ['txt', 'md', 'word']
  }

  return ['original']
}

export function getCanvasFileExportOptions(
  item: CanvasFileItem,
  language?: string | null
): CanvasFileExportOption[] {
  const isChinese = isChineseUiLanguage(language)
  const sourceExtension = getFileExtension(item.fileName) || ''

  return getCanvasFileExportFormats(item).map((format) => {
    if (format === 'original') {
      return {
        format,
        label: isChinese
          ? `原始文件 (${sourceExtension || '原格式'})`
          : `Original file (${sourceExtension || 'source format'})`
      }
    }

    if (format === 'txt') {
      return {
        format,
        label: isChinese ? '文本 (.txt)' : 'Text (.txt)'
      }
    }

    if (format === 'md') {
      return {
        format,
        label: 'Markdown (.md)'
      }
    }

    return {
      format,
      label: isChinese ? 'Word 文档 (.docx)' : 'Word document (.docx)'
    }
  })
}

export function getCanvasFileExportExtension(
  format: CanvasFileExportFormat,
  item: CanvasFileItem
): string {
  if (format === 'original') {
    return getFileExtension(item.fileName) || ''
  }

  if (format === 'txt') return '.txt'
  if (format === 'md') return '.md'
  return '.docx'
}

export function getCanvasFileExportMimeType(
  format: CanvasFileExportFormat,
  item: CanvasFileItem
): string {
  if (format === 'original') {
    return item.mimeType || 'application/octet-stream'
  }

  if (format === 'txt') return 'text/plain;charset=utf-8'
  if (format === 'md') return 'text/markdown;charset=utf-8'
  return DOCX_MIME_TYPE
}

export function getCanvasFileExportDialogTitle(
  format: CanvasFileExportFormat,
  language?: string | null
): string {
  const isChinese = isChineseUiLanguage(language)

  if (format === 'original') {
    return isChinese ? '导出文件' : 'Export file'
  }

  if (format === 'txt') {
    return isChinese ? '导出为文本' : 'Export as text'
  }

  if (format === 'md') {
    return isChinese ? '导出为 Markdown' : 'Export as Markdown'
  }

  return isChinese ? '导出为 Word 文档' : 'Export as Word document'
}

export function buildCanvasFileExportSuggestedName(
  item: CanvasFileItem,
  format: CanvasFileExportFormat
): string {
  const sourceExtension = getFileExtension(item.fileName)
  const rawBaseName = sourceExtension
    ? item.fileName.slice(0, -sourceExtension.length)
    : item.fileName
  const baseName = sanitizeFilePart(rawBaseName || 'document')
  const nextExtension = getCanvasFileExportExtension(format, item)

  return `${baseName}-export${nextExtension}`
}

export function normalizeCanvasFileExportTargetPath(
  filePath: string,
  format: CanvasFileExportFormat,
  item: CanvasFileItem
): string {
  const currentExtension = getFileExtension(filePath)
  const requiredExtension = getCanvasFileExportExtension(format, item)

  if (!requiredExtension) {
    return filePath
  }

  if (!currentExtension) {
    return `${filePath}${requiredExtension}`
  }

  if (format === 'word' && currentExtension === '.doc') {
    return `${filePath}x`
  }

  return filePath
}

export async function buildCanvasGeneratedExportFile(
  text: string,
  targetFileName: string,
  format: Exclude<CanvasFileExportFormat, 'original'>
): Promise<File> {
  const normalizedText = text.replace(/\r\n/g, '\n')

  if (format === 'word') {
    const blob = await buildWordDocumentBlob(normalizedText)
    return new File([blob], targetFileName, {
      type: DOCX_MIME_TYPE
    })
  }

  return new File([normalizedText], targetFileName, {
    type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
  })
}
