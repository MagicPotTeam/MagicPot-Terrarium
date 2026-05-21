import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CanvasTargetReport, CanvasTargetReportStage } from '@shared/canvasTarget'
import {
  buildCanvasTargetAgentFinalSummaryText,
  buildCanvasTargetAgentMessagePayload,
  materializeCanvasTargetAgentMessagePayload
} from './canvasTargetAgentArtifacts'

function decodeDataUrlText(dataUrl: string): string {
  const [, base64 = ''] = dataUrl.split(',')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

function createStage(overrides: Partial<CanvasTargetReportStage> = {}): CanvasTargetReportStage {
  return {
    id: 'stage-1',
    kind: 'model-check',
    label: 'Visual Check',
    status: 'success',
    modelId: 'glm-4.6v-flash',
    summary: 'Found one layout issue.',
    overview: 'The title is offset from the card body.',
    findings: [
      {
        id: 'finding-1',
        title: 'Title offset',
        summary: 'The title is shifted 8px to the right.',
        severity: 'warning',
        category: 'layout',
        itemIds: ['image-1'],
        evidence: ['The title center does not align with the card body center.'],
        suggestions: ['Center the title horizontally.'],
        sourceStageId: 'stage-1',
        sourceStageLabel: 'Visual Check',
        sourceModelId: 'glm-4.6v-flash'
      }
    ],
    responseContent: 'Detailed model output.',
    responseAttachments: [
      {
        type: 'image',
        url: 'data:image/png;base64,AAAA',
        fileName: 'reference.png',
        mimeType: 'image/png'
      }
    ],
    ...overrides
  }
}

function createReport(stage: CanvasTargetReportStage): CanvasTargetReport {
  return {
    id: 'report-1',
    contextPackId: 'context-pack-1',
    generatedAt: '2026-04-08T10:00:00.000Z',
    modelId: 'glm-4.6v-flash',
    summary: 'Completed one check.',
    overview: 'One warning was found in the selected canvas region.',
    findings: stage.findings,
    stages: [stage]
  }
}

describe('canvasTargetAgentArtifacts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds a draggable markdown attachment for stage results', () => {
    const stage = createStage()
    const payload = buildCanvasTargetAgentMessagePayload({
      report: createReport(stage),
      stage,
      isChineseUi: false,
      includeReportFile: true
    })

    expect(payload.content).toContain('Generated files for "Visual Check"')
    expect(payload.content).toContain('Source model: glm-4.6v-flash')
    expect(payload.content).toContain('double-click to inspect the full content')
    expect(payload.attachments).toHaveLength(2)
    expect(payload.attachments[0]).toMatchObject({
      type: 'file',
      fileName: 'canvas-target-Visual_Check.md',
      mimeType: 'text/markdown'
    })
    expect(payload.attachments[1]).toMatchObject({
      type: 'image',
      fileName: 'reference.png'
    })
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain('# Visual Check')
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain('## Stage Details')
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain('- **Model**: glm-4.6v-flash')
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain('## Findings')
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain('### Warning | Title offset')
  })

  it('adds an OCR export file that keeps the ocr payload for drag-and-drop', () => {
    const stage = createStage({
      label: 'OCR Table Check',
      responseAttachments: [],
      responseOcrResult: {
        kind: 'table',
        text: 'A1\tB1',
        sheets: [
          {
            id: 'sheet-1',
            name: 'Sheet 1',
            rows: 1,
            cols: 2,
            cells: [
              { id: 'cell-1', row: 0, col: 0, text: 'A1' },
              { id: 'cell-2', row: 0, col: 1, text: 'B1' }
            ]
          }
        ]
      }
    })

    const payload = buildCanvasTargetAgentMessagePayload({
      report: createReport(stage),
      stage,
      isChineseUi: true,
      includeReportFile: true
    })

    expect(payload.content).toContain('已生成“OCR Table Check”目标结果文件。')
    expect(payload.content).toContain('来源模型：glm-4.6v-flash')
    expect(payload.content).toContain('可拖到画布后，双击展开查看具体内容。')
    expect(payload.attachments).toHaveLength(2)
    expect(payload.attachments[1]).toMatchObject({
      type: 'file',
      fileName: 'canvas-target-OCR_Table_Check-ocr-table.json',
      mimeType: 'application/json'
    })
    expect(payload.attachments[1].ocrResult).toEqual(stage.responseOcrResult)
    expect(decodeDataUrlText(payload.attachments[1].url)).toContain('"kind": "table"')
  })

  it('publishes result attachments without generating a stage markdown report by default', () => {
    const stage = createStage({
      responseAttachments: [
        {
          type: 'image',
          url: 'data:image/png;base64,BBBB',
          fileName: 'result.png',
          mimeType: 'image/png'
        }
      ]
    })

    const payload = buildCanvasTargetAgentMessagePayload({
      report: createReport(stage),
      stage,
      isChineseUi: false
    })

    expect(payload.content).toContain('Generated target results for "Visual Check"')
    expect(payload.attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        fileName: 'result.png'
      })
    ])
    expect(payload.attachments).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileName: 'canvas-target-Visual_Check.md'
        })
      ])
    )
  })

  it('uses the consolidated report markdown for the final control summary stage', () => {
    const stage = createStage({
      kind: 'control-summary',
      label: 'Control Summary',
      responseAttachments: [],
      responseContent: 'Final summary content.'
    })
    const payload = buildCanvasTargetAgentMessagePayload({
      report: createReport(stage),
      stage,
      isChineseUi: false,
      includeReportFile: true
    })

    expect(payload.attachments).toHaveLength(1)
    expect(payload.attachments[0]).toMatchObject({
      fileName: 'canvas-target-report.md',
      mimeType: 'text/markdown'
    })
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain('# Canvas Target Report')
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain('## Report Details')
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain('## Stage Results')
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain('## Final Output')
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain('Final summary content.')
  })

  it('falls back to the MagicPot built-in capability label when no model produced the file', () => {
    const stage = createStage({
      modelId: undefined,
      responseAttachments: []
    })

    const payload = buildCanvasTargetAgentMessagePayload({
      report: createReport(stage),
      stage,
      isChineseUi: false,
      includeReportFile: true
    })

    expect(payload.content).toContain('Source capability: MagicPot built-in capability')
    expect(decodeDataUrlText(payload.attachments[0].url)).toContain(
      '- **Source capability**: MagicPot built-in capability'
    )
  })

  it('prefers the human-readable model label while preserving the underlying model id', () => {
    const stage = createStage({
      modelId: 'cd679259-1e30-41d8-8a87-b0e5b29f684d',
      responseAttachments: []
    })

    const payload = buildCanvasTargetAgentMessagePayload({
      report: createReport(stage),
      stage: {
        ...stage,
        displayModelLabel: 'GLM-4.6V-Flash'
      },
      isChineseUi: true,
      includeReportFile: true
    })

    const markdown = decodeDataUrlText(payload.attachments[0].url)
    expect(markdown).toContain('- **执行模型**：GLM-4.6V-Flash')
    expect(markdown).toContain('- **模型标识**：`cd679259-1e30-41d8-8a87-b0e5b29f684d`')
  })

  it('includes the local source image name, preview, and feedback in the stage markdown', () => {
    const stage = createStage({
      responseAttachments: [],
      inputSourceAttachments: [
        {
          type: 'image',
          url: 'local-media:///D:/assets/local-card.png',
          fileName: 'local-card.png',
          mimeType: 'image/png',
          sizeBytes: 10240,
          sourceWidth: 240,
          sourceHeight: 148
        }
      ]
    })

    const payload = buildCanvasTargetAgentMessagePayload({
      report: createReport(stage),
      stage,
      isChineseUi: false,
      includeReportFile: true
    })

    const markdown = decodeDataUrlText(payload.attachments[0].url)
    expect(markdown).toContain('## Source Assets')
    expect(markdown).toContain('- **Local file name**: `local-card.png`')
    expect(markdown).toContain('- **Resolution**: 240 x 148 px')
    expect(markdown).toContain('![local-card.png](<local-media:///D:/assets/local-card.png>)')
    expect(markdown).toContain('#### Model Feedback')
    expect(markdown).toContain('Detailed model output.')
  })

  it('keeps only the source images that actually returned mapped feedback in the consolidated report', () => {
    const modelStage = createStage({
      label: 'OCR Check',
      responseAttachments: [],
      responseContent: ['## accepted.png', '', 'Accepted OCR feedback.'].join('\n'),
      inputSourceAttachments: [
        {
          type: 'image',
          url: 'local-media:///D:/assets/accepted.png',
          fileName: 'accepted.png',
          mimeType: 'image/png'
        },
        {
          type: 'image',
          url: 'local-media:///D:/assets/rejected.png',
          fileName: 'rejected.png',
          mimeType: 'image/png'
        }
      ]
    })
    const finalStage = createStage({
      id: 'stage-summary',
      kind: 'control-summary',
      label: 'Control Summary',
      responseAttachments: [],
      responseContent: 'Final summary content.'
    })
    const report: CanvasTargetReport = {
      id: 'report-2',
      contextPackId: 'context-pack-2',
      generatedAt: '2026-04-08T10:00:00.000Z',
      modelId: 'glm-ocr',
      summary: 'OCR run completed.',
      overview: 'Only one source image returned OCR content.',
      findings: [],
      stages: [modelStage, finalStage]
    }

    const payload = buildCanvasTargetAgentMessagePayload({
      report,
      stage: finalStage,
      isChineseUi: false,
      includeReportFile: true
    })

    const markdown = decodeDataUrlText(payload.attachments[0].url)
    expect(markdown).toContain('##### accepted.png')
    expect(markdown).toContain('Accepted OCR feedback.')
    expect(markdown).not.toContain('##### rejected.png')
    expect(markdown).not.toContain('`rejected.png`')
  })

  it('returns the final control summary as plain chat text', () => {
    const stage = createStage({
      kind: 'control-summary',
      label: 'Control Summary',
      responseContent: 'Control model final summary.',
      summary: 'Short summary.'
    })

    expect(buildCanvasTargetAgentFinalSummaryText({ stage })).toBe('Control model final summary.')
  })

  it('keeps large structured report content in the markdown attachment without truncating it', () => {
    const hugeStructuredOutput = Array.from(
      { length: 4_500 },
      (_, index) => `Section ${index + 1}: detailed control summary paragraph ${index % 9}.`
    ).join('\n')
    const stage = createStage({
      kind: 'control-summary',
      label: 'Control Summary',
      responseContent: hugeStructuredOutput,
      summary: 'Short summary.'
    })

    const payload = buildCanvasTargetAgentMessagePayload({
      report: createReport(stage),
      stage,
      isChineseUi: false,
      includeReportFile: true
    })

    const markdown = decodeDataUrlText(payload.attachments[0].url)
    expect(markdown).toContain(hugeStructuredOutput.slice(0, 200))
    expect(markdown).toContain(hugeStructuredOutput.slice(-200))
    expect(markdown).not.toContain('[MagicPot truncated')
  })

  it('uses the concise stage summary in the chat thread when the full final summary is very large', () => {
    const hugeSummary = Array.from(
      { length: 4_500 },
      (_, index) => `Section ${index + 1}: detailed control summary paragraph ${index % 9}.`
    ).join('\n')
    const stage = createStage({
      kind: 'control-summary',
      label: 'Control Summary',
      responseContent: hugeSummary,
      summary: 'Short summary.'
    })

    expect(buildCanvasTargetAgentFinalSummaryText({ stage })).toBe('Short summary.')
  })

  it('still truncates obviously garbage final summary text before posting it back into the chat thread', () => {
    const hugeGarbageSummary = 'S'.repeat(70_000)
    const stage = createStage({
      kind: 'control-summary',
      label: 'Control Summary',
      responseContent: hugeGarbageSummary,
      summary: 'Short summary.'
    })

    const finalSummaryText = buildCanvasTargetAgentFinalSummaryText({ stage })
    expect(finalSummaryText.length).toBeLessThan(hugeGarbageSummary.length)
    expect(finalSummaryText).toContain('[MagicPot truncated')
  })

  it('materializes the report bundle into cached markdown and image attachments', async () => {
    const stage = createStage()
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'data:image/png;base64,AAAA') {
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    const writeTextFile = vi.fn(async ({ outputPath, filename, content }) => ({
      success: true,
      fullPath: `${outputPath}/${filename}`
    }))
    const saveImageToPath = vi.fn(async ({ outputPath, filename }) => ({
      success: true,
      fullPath: `${outputPath}/${filename}`
    }))

    vi.stubGlobal('fetch', fetchMock)

    const payload = await materializeCanvasTargetAgentMessagePayload({
      report: createReport(stage),
      stage,
      isChineseUi: false,
      includeReportFile: true,
      bundleRootDir: 'C:/bundle-cache',
      writeTextFile,
      saveImageToPath
    })

    expect(payload.attachments[0]).toMatchObject({
      type: 'file',
      fileName: 'canvas-target-Visual_Check.md',
      reportBundleRole: 'primary-report',
      reportBundleId: 'canvas-target-stage-1',
      reportBundleManifestUrl:
        'local-media:///C:/bundle-cache/.report_bundles/canvas-target-stage-1/manifest.json'
    })
    expect(payload.attachments[1]).toMatchObject({
      type: 'image',
      reportBundleRole: 'report-image',
      reportBundleId: 'canvas-target-stage-1'
    })
    expect(writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: 'C:/bundle-cache/.report_bundles/canvas-target-stage-1',
        filename: 'manifest.json'
      })
    )
    expect(saveImageToPath).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: 'C:/bundle-cache/.report_bundles/canvas-target-stage-1/images'
      })
    )
  })
})
