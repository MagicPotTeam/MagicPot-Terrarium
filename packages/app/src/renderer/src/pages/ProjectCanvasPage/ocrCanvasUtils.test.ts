import { describe, expect, it } from 'vitest'

import {
  buildBboxToCellIdsMap,
  buildCanvasPreviewSheetsFromOcrResult,
  buildOcrResultHtml,
  isNormalizedOcrBox
} from './ocrCanvasUtils'

const sampleOcrResult = {
  kind: 'table' as const,
  text: 'Alpha',
  sourceImageUrl: 'file:///C:/demo/source.png',
  boxes: [
    { id: 'box-1', x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
    { id: 'box-2', x: 120, y: 240, width: 80, height: 32 }
  ],
  sheets: [
    {
      id: 'sheet-1',
      name: 'Sheet 1',
      rows: 1,
      cols: 2,
      cells: [
        { id: 'cell-1', row: 0, col: 0, text: 'Alpha', bboxIds: ['box-1'], confidence: 0.92 },
        { id: 'cell-2', row: 0, col: 1, text: 'Beta', bboxIds: ['box-1', 'box-2'] }
      ]
    }
  ]
}

describe('ocrCanvasUtils', () => {
  it('builds OCR HTML with cell and bbox mapping attributes', () => {
    const html = buildOcrResultHtml(sampleOcrResult, 'result.xlsx')

    expect(html).toContain('data-ocr-cell-id="cell-1"')
    expect(html).toContain('data-ocr-bbox-ids="box-1"')
    expect(html).toContain('data-ocr-bbox-ids="box-1,box-2"')
    expect(html).toContain('result.xlsx')
  })

  it('builds inverse bbox-to-cell mappings for hover linking', () => {
    expect(buildBboxToCellIdsMap(sampleOcrResult)).toEqual({
      'box-1': ['cell-1', 'cell-2'],
      'box-2': ['cell-2']
    })
  })

  it('converts OCR sheets into linked canvas spreadsheet previews', () => {
    expect(buildCanvasPreviewSheetsFromOcrResult(sampleOcrResult)).toEqual([
      {
        id: 'sheet-1',
        name: 'Sheet 1',
        rows: 1,
        cols: 2,
        cells: [
          {
            row: 1,
            col: 1,
            text: 'Alpha',
            ocrCellId: 'cell-1',
            ocrBboxIds: ['box-1']
          },
          {
            row: 1,
            col: 2,
            text: 'Beta',
            ocrCellId: 'cell-2',
            ocrBboxIds: ['box-1', 'box-2']
          }
        ]
      }
    ])
  })

  it('detects normalized OCR boxes', () => {
    expect(isNormalizedOcrBox(sampleOcrResult.boxes[0])).toBe(true)
    expect(isNormalizedOcrBox(sampleOcrResult.boxes[1])).toBe(false)
  })
})
