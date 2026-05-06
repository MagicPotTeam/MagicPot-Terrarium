import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeCanvasTargetLocalVisualStage } from './canvasTargetLocalVisualStage'

describe('canvasTargetLocalVisualStage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('formats a local model stage result as markdown for the control model', async () => {
    const previousApi = window.api
    ;(window as typeof window & { api?: unknown }).api = {
      svcFs: {
        readImageFromPath: vi
          .fn()
          .mockImplementation(async ({ fullPath }: { fullPath: string }) => ({
            image: new Uint8Array([1, 2, 3]),
            filename: fullPath.endsWith('snapshot.png') ? 'snapshot.png' : 'source.png'
          }))
      }
    } as unknown as typeof window.api

    const runVisualAnalysis = vi.fn().mockResolvedValue({
      modelId: 'agent-local:vision-1',
      modelName: 'Local Vision',
      provider: 'CPUExecutionProvider',
      warnings: [],
      imageCount: 2,
      pairMode: 'cross_group',
      groups: [
        { kind: 'source_assets', label: 'Source assets', imageCount: 1 },
        { kind: 'selection_snapshot', label: 'Selection snapshot', imageCount: 1 }
      ],
      pairResults: [
        {
          leftImageId: 'left',
          leftName: 'source.png',
          leftGroupKind: 'source_assets',
          leftGroupLabel: 'Source assets',
          rightImageId: 'right',
          rightName: 'snapshot.png',
          rightGroupKind: 'selection_snapshot',
          rightGroupLabel: 'Selection snapshot',
          visualSimilarity: 0.9231,
          robustnessSimilarity: 0.9012
        }
      ]
    })

    try {
      const result = await executeCanvasTargetLocalVisualStage({
        duplicateCheckSvc: { runVisualAnalysis },
        modelId: 'agent-local:vision-1',
        modelLabel: 'Local Vision',
        attachmentGroups: [
          {
            kind: 'source_assets',
            label: 'Source assets',
            attachments: [
              {
                type: 'image',
                url: 'local-media:///tmp/source.png',
                fileName: 'source.png',
                mimeType: 'image/png'
              }
            ]
          },
          {
            kind: 'selection_snapshot',
            label: 'Selection snapshot',
            attachments: [
              {
                type: 'image',
                url: 'local-media:///tmp/snapshot.png',
                fileName: 'snapshot.png',
                mimeType: 'image/png'
              }
            ]
          }
        ],
        stageLabel: 'Local model pass',
        stagePrompt: 'Compare the source and snapshot.',
        referenceNotes: ['Use the local model backend.'],
        userNotes: 'Focus on layout similarity.',
        preferredOutputFormats: ['markdown'],
        isChineseUi: false
      })

      expect(runVisualAnalysis).toHaveBeenCalledWith({
        modelId: 'agent-local:vision-1',
        images: [
          expect.objectContaining({
            name: 'source.png',
            groupKind: 'source_assets'
          }),
          expect.objectContaining({
            name: 'snapshot.png',
            groupKind: 'selection_snapshot'
          })
        ]
      })
      expect(result.fallbackReason).toBeUndefined()
      expect(result.content).toContain('# Local Model Analysis Result')
      expect(result.content).toContain('Control-stage prompt')
      expect(result.content).toContain(
        '| source.png (Source assets) | snapshot.png (Selection snapshot) | 0.923 | 0.901 |'
      )
    } finally {
      ;(window as typeof window & { api?: unknown }).api = previousApi
    }
  })

  it('returns a clear fallback when no compatible image inputs can be loaded', async () => {
    const result = await executeCanvasTargetLocalVisualStage({
      duplicateCheckSvc: {
        runVisualAnalysis: vi.fn()
      },
      modelId: 'agent-local:vision-1',
      modelLabel: 'Local Vision',
      attachmentGroups: [
        {
          kind: 'source_assets',
          label: 'Source assets',
          attachments: [
            {
              type: 'file',
              url: 'file:///tmp/report.csv',
              fileName: 'report.csv',
              mimeType: 'text/csv'
            }
          ]
        }
      ],
      preferredOutputFormats: ['markdown'],
      isChineseUi: false
    })

    expect(result.fallbackReason).toBe('Local model stage had no compatible image inputs')
    expect(result.content).toContain('No compatible image inputs were available')
  })
})
