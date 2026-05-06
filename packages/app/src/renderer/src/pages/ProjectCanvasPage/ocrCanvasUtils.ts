import type { OCRBoundingBox, OCRResult, OCRTableCell } from '@shared/api/svcLLMProxy'
import type { CanvasFilePreviewSheet } from './types'

export const CANVAS_OCR_HOVER_EVENT = 'canvas-ocr-hover'

export type CanvasOcrHoverDetail = {
  bundleId: string
  bboxIds: string[]
  cellIds: string[]
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const formatConfidence = (confidence?: number): string | null => {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return null
  }

  const normalized = confidence <= 1 ? confidence * 100 : confidence
  return `${Math.max(0, Math.min(100, Math.round(normalized)))}%`
}

const buildCellMarkup = (
  cell: OCRTableCell | undefined,
  rowIndex: number,
  colIndex: number
): string => {
  const bboxIds = cell?.bboxIds?.filter(Boolean) || []
  const confidenceLabel = formatConfidence(cell?.confidence)
  const titleParts = [
    `R${rowIndex + 1}C${colIndex + 1}`,
    confidenceLabel ? `Confidence ${confidenceLabel}` : null
  ].filter(Boolean)

  return [
    `<td class="mp-ocr-cell"`,
    cell?.id ? ` data-ocr-cell-id="${escapeHtml(cell.id)}"` : '',
    bboxIds.length > 0 ? ` data-ocr-bbox-ids="${escapeHtml(bboxIds.join(','))}"` : '',
    titleParts.length > 0 ? ` title="${escapeHtml(titleParts.join(' | '))}"` : '',
    '>',
    `<div class="mp-ocr-cell-text">${escapeHtml(cell?.text || '') || '&nbsp;'}</div>`,
    confidenceLabel
      ? `<div class="mp-ocr-cell-meta">${escapeHtml(confidenceLabel)}</div>`
      : '<div class="mp-ocr-cell-meta">&nbsp;</div>',
    '</td>'
  ].join('')
}

const buildTableMarkup = (ocrResult: OCRResult): string => {
  if (!ocrResult.sheets?.length) {
    const fallbackText = ocrResult.text?.trim() || 'No structured table rows were returned.'
    return `<div class="mp-ocr-empty">${escapeHtml(fallbackText)}</div>`
  }

  return ocrResult.sheets
    .map((sheet, sheetIndex) => {
      const cellMap = new Map<string, OCRTableCell>()
      for (const cell of sheet.cells) {
        cellMap.set(`${cell.row}:${cell.col}`, cell)
      }

      const rows = Array.from({ length: Math.max(sheet.rows, 1) }, (_, rowIndex) => {
        const columns = Array.from({ length: Math.max(sheet.cols, 1) }, (_, colIndex) =>
          buildCellMarkup(cellMap.get(`${rowIndex}:${colIndex}`), rowIndex, colIndex)
        )
        return `<tr>${columns.join('')}</tr>`
      })

      return `
        <section class="mp-ocr-sheet" data-ocr-sheet-index="${sheetIndex}">
          <div class="mp-ocr-sheet-title">${escapeHtml(sheet.name || `Sheet ${sheetIndex + 1}`)}</div>
          <div class="mp-ocr-sheet-meta">${sheet.rows} x ${sheet.cols}</div>
          <div class="mp-ocr-table-wrap">
            <table class="mp-ocr-table">
              <tbody>${rows.join('')}</tbody>
            </table>
          </div>
        </section>
      `
    })
    .join('')
}

export const buildOcrResultHtml = (ocrResult: OCRResult, attachmentName?: string): string => {
  const title =
    ocrResult.kind === 'table'
      ? 'OCR Table View'
      : ocrResult.kind === 'document'
        ? 'OCR Document View'
        : 'OCR Result View'
  const subtitle = attachmentName || (ocrResult.kind === 'table' ? 'Structured OCR output' : null)
  const boxCount = ocrResult.boxes?.length || 0

  return `
    <style>
      .mp-ocr-root {
        font-family: "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
        color: #0f172a;
        min-height: 100%;
        padding: 18px;
        box-sizing: border-box;
      }
      .mp-ocr-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 16px;
      }
      .mp-ocr-title {
        font-size: 16px;
        font-weight: 700;
        line-height: 1.2;
      }
      .mp-ocr-subtitle {
        margin-top: 4px;
        font-size: 12px;
        color: #475569;
      }
      .mp-ocr-badge {
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(37, 99, 235, 0.12);
        color: #1d4ed8;
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
      }
      .mp-ocr-sheet + .mp-ocr-sheet {
        margin-top: 16px;
      }
      .mp-ocr-sheet-title {
        font-size: 13px;
        font-weight: 700;
      }
      .mp-ocr-sheet-meta {
        margin-top: 2px;
        margin-bottom: 8px;
        font-size: 11px;
        color: #64748b;
      }
      .mp-ocr-table-wrap {
        overflow: auto;
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.35);
        background: rgba(255, 255, 255, 0.88);
      }
      .mp-ocr-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .mp-ocr-cell {
        min-width: 96px;
        padding: 10px 12px;
        border: 1px solid rgba(203, 213, 225, 0.9);
        vertical-align: top;
        background: rgba(255, 255, 255, 0.95);
        transition: background-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
      }
      .mp-ocr-cell:hover,
      .mp-ocr-cell.is-active {
        background: rgba(254, 249, 195, 0.92);
        box-shadow: inset 0 0 0 1px rgba(202, 138, 4, 0.75);
      }
      .mp-ocr-cell.is-active {
        transform: translateY(-1px);
      }
      .mp-ocr-cell-text {
        font-size: 13px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .mp-ocr-cell-meta {
        margin-top: 8px;
        font-size: 11px;
        color: #64748b;
      }
      .mp-ocr-empty {
        padding: 16px;
        border-radius: 14px;
        border: 1px dashed rgba(148, 163, 184, 0.9);
        background: rgba(255, 255, 255, 0.8);
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
      }
    </style>
    <div class="mp-ocr-root">
      <div class="mp-ocr-header">
        <div>
          <div class="mp-ocr-title">${escapeHtml(title)}</div>
          ${
            subtitle
              ? `<div class="mp-ocr-subtitle">${escapeHtml(subtitle)}</div>`
              : '<div class="mp-ocr-subtitle">Hover cells to highlight their OCR boxes.</div>'
          }
        </div>
        <div class="mp-ocr-badge">${boxCount} boxes</div>
      </div>
      ${buildTableMarkup(ocrResult)}
    </div>
  `
}

export const buildBboxToCellIdsMap = (ocrResult: OCRResult): Record<string, string[]> => {
  const mapping: Record<string, string[]> = {}

  for (const sheet of ocrResult.sheets || []) {
    for (const cell of sheet.cells) {
      for (const bboxId of cell.bboxIds || []) {
        if (!bboxId) continue
        if (!mapping[bboxId]) {
          mapping[bboxId] = []
        }
        if (!mapping[bboxId].includes(cell.id)) {
          mapping[bboxId].push(cell.id)
        }
      }
    }
  }

  return mapping
}

export const buildCanvasPreviewSheetsFromOcrResult = (
  ocrResult: OCRResult
): CanvasFilePreviewSheet[] =>
  (ocrResult.sheets || []).map((sheet, sheetIndex) => ({
    id: sheet.id || `ocr-sheet-${sheetIndex + 1}`,
    name: sheet.name || `Sheet ${sheetIndex + 1}`,
    rows: Math.max(sheet.rows, 1),
    cols: Math.max(sheet.cols, 1),
    cells: (sheet.cells || []).map((cell) => ({
      row: cell.row + 1,
      col: cell.col + 1,
      text: cell.text,
      ...(cell.id ? { ocrCellId: cell.id } : {}),
      ...(cell.bboxIds?.length ? { ocrBboxIds: cell.bboxIds.filter(Boolean) } : {})
    }))
  }))

export const isNormalizedOcrBox = (box: OCRBoundingBox): boolean => {
  const maxEdge = Math.max(box.x + box.width, box.y + box.height)
  return maxEdge <= 1.05
}
