import { describe, expect, it } from 'vitest'
import {
  buildAssistantMessageFromResponse,
  buildAssistantMessageFromResult
} from './chatMessageUtils'
import { BUILT_IN_TAGGING_SKILL_ID } from './builtInSkills'

describe('buildAssistantMessageFromResponse', () => {
  it('extracts markdown image attachments and keeps the surrounding text', () => {
    const message = buildAssistantMessageFromResponse(
      'Done.\n\n![image](https://example.com/out.png)'
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'Done.',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/out.png',
          mimeType: 'image/png'
        }
      ]
    })
  })

  it('extracts markdown model attachments', () => {
    const message = buildAssistantMessageFromResponse(
      'Here is the mesh: [Generated 3D Model](https://example.com/model.glb)'
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'Here is the mesh:',
      attachments: [
        {
          type: 'model3d',
          url: 'https://example.com/model.glb',
          fileName: 'model.glb'
        }
      ]
    })
  })

  it('extracts mixed generated image and model attachments from a single response', () => {
    const message = buildAssistantMessageFromResponse(
      'Preview ready.\n\n![Generated PNG](https://example.com/preview.png)\n[Generated 3D Model](https://example.com/model.glb)'
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'Preview ready.',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/preview.png',
          mimeType: 'image/png'
        },
        {
          type: 'model3d',
          url: 'https://example.com/model.glb',
          fileName: 'model.glb'
        }
      ]
    })
  })

  it('keeps labeled model attachments even when the signed url has no file extension', () => {
    const message = buildAssistantMessageFromResponse(
      'Download: [Generated 3D Model](https://example.com/download?id=mesh-1)'
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'Download:',
      attachments: [
        {
          type: 'model3d',
          url: 'https://example.com/download?id=mesh-1',
          fileName: 'download'
        }
      ]
    })
  })

  it('extracts Hunyuan artifact lines and keeps diagnostics text', () => {
    const message = buildAssistantMessageFromResponse(
      [
        '[Hunyuan3D] model: type=UNKNOWN url=https://example.com/preview.png',
        '[Hunyuan3D] model: type=UNKNOWN url=https://example.com/result.glb',
        '',
        '[Hunyuan3D] Result URLs may expire after 1 day.'
      ].join('\n')
    )

    expect(message).toEqual({
      role: 'assistant',
      content: '[Hunyuan3D] Result URLs may expire after 1 day.',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/preview.png',
          mimeType: 'image/png'
        },
        {
          type: 'model3d',
          url: 'https://example.com/result.glb',
          fileName: 'result.glb'
        }
      ]
    })
  })

  it('keeps trailing diagnostics text when a generated model link also carries short-lived or credit notes', () => {
    const message = buildAssistantMessageFromResponse(
      '[Generated 3D Model](https://example.com/download?id=mesh-2)\n\n[Hunyuan3D] Result URLs may expire after 1 day.\n[Hunyuan3D] Credits consumed: 1.25'
    )

    expect(message).toEqual({
      role: 'assistant',
      content:
        '[Hunyuan3D] Result URLs may expire after 1 day.\n[Hunyuan3D] Credits consumed: 1.25',
      attachments: [
        {
          type: 'model3d',
          url: 'https://example.com/download?id=mesh-2',
          fileName: 'download'
        }
      ]
    })
  })

  it('treats generated OBJ zip packages as downloadable files instead of 3D model cards', () => {
    const message = buildAssistantMessageFromResponse(
      'OBJ package: [Generated OBJ Package](https://example.com/output.zip)'
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'OBJ package:',
      attachments: [
        {
          type: 'file',
          url: 'https://example.com/output.zip',
          fileName: 'output.zip',
          mimeType: 'application/zip'
        }
      ]
    })
  })

  it('treats extensionless OBJ package links as file attachments when the markdown label carries the zip extension', () => {
    const message = buildAssistantMessageFromResponse(
      'OBJ package: [Generated OBJ Package.zip](https://example.com/download?id=obj-package-1)'
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'OBJ package:',
      attachments: [
        {
          type: 'file',
          url: 'https://example.com/download?id=obj-package-1',
          fileName: 'Generated OBJ Package.zip',
          mimeType: 'application/zip'
        }
      ]
    })
  })

  it('extracts generated GIF markdown as an image attachment even when the signed url is extensionless', () => {
    const message = buildAssistantMessageFromResponse(
      'Preview:\n\n![Generated GIF](https://example.com/download?id=anim-1)'
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'Preview:',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/download?id=anim-1',
          mimeType: 'image/png'
        }
      ]
    })
  })

  it('extracts generated video markdown links as video attachments', () => {
    const response = 'Done: [Generated Video](https://example.com/download?id=clip-1)'

    expect(buildAssistantMessageFromResponse(response)).toEqual({
      role: 'assistant',
      content: 'Done:',
      attachments: [
        {
          type: 'video',
          url: 'https://example.com/download?id=clip-1',
          fileName: 'download',
          mimeType: 'video/mp4'
        }
      ]
    })
  })

  it('treats generic markdown links to video files as video attachments', () => {
    const message = buildAssistantMessageFromResponse(
      'Done: [clip.mp4](https://example.com/download?id=clip-1)'
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'Done:',
      attachments: [
        {
          type: 'video',
          url: 'https://example.com/download?id=clip-1',
          fileName: 'download',
          mimeType: 'video/mp4'
        }
      ]
    })
  })

  it('treats a direct video URL as an attachment-only response', () => {
    const message = buildAssistantMessageFromResponse('https://example.com/render.mp4')

    expect(message).toEqual({
      role: 'assistant',
      content: '',
      attachments: [
        {
          type: 'video',
          url: 'https://example.com/render.mp4',
          fileName: 'render.mp4',
          mimeType: 'video/mp4'
        }
      ]
    })
  })

  it('treats a direct image URL as an attachment-only response', () => {
    const message = buildAssistantMessageFromResponse('https://example.com/render.webp')

    expect(message).toEqual({
      role: 'assistant',
      content: '',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/render.webp',
          mimeType: 'image/png'
        }
      ]
    })
  })

  it('keeps plain text responses intact', () => {
    expect(buildAssistantMessageFromResponse('Plain text reply')).toEqual({
      role: 'assistant',
      content: 'Plain text reply'
    })
  })

  it('extracts markdown file link as file attachment', () => {
    const message = buildAssistantMessageFromResponse(
      'Here is the result: [output.zip](https://example.com/output.zip)'
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'Here is the result:',
      attachments: [
        {
          type: 'file',
          url: 'https://example.com/output.zip',
          fileName: 'output.zip',
          mimeType: 'application/zip'
        }
      ]
    })
  })

  it('treats a direct file URL as a file attachment', () => {
    const message = buildAssistantMessageFromResponse('https://example.com/report.pdf')

    expect(message).toEqual({
      role: 'assistant',
      content: '',
      attachments: [
        {
          type: 'file',
          url: 'https://example.com/report.pdf',
          fileName: 'report.pdf',
          mimeType: 'application/pdf'
        }
      ],
      modelName: undefined
    })
  })

  it('does not extract markdown links to pages without file extensions as file attachments', () => {
    const message = buildAssistantMessageFromResponse('Check [this page](https://example.com/docs)')

    expect(message).toEqual({
      role: 'assistant',
      content: 'Check [this page](https://example.com/docs)'
    })
  })

  it('preserves OCR result metadata when building assistant messages from structured results', () => {
    const message = buildAssistantMessageFromResult(
      {
        content: 'OCR finished.',
        attachments: [
          {
            type: 'file',
            url: 'file:///C:/demo/result.xlsx',
            fileName: 'result.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          }
        ],
        ocrResult: {
          kind: 'table',
          sourceImageUrl: 'file:///C:/demo/source.png',
          boxes: [{ id: 'box-1', x: 10, y: 20, width: 30, height: 40 }],
          sheets: [
            {
              id: 'sheet-1',
              name: 'Sheet 1',
              rows: 1,
              cols: 1,
              cells: [{ id: 'cell-1', row: 0, col: 0, text: 'Name', bboxIds: ['box-1'] }]
            }
          ]
        }
      },
      'ocr-model'
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'OCR finished.',
      attachments: [
        {
          type: 'file',
          url: 'local-media:///C:/demo/result.xlsx',
          fileName: 'result.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ocrResult: {
            kind: 'table',
            sourceImageUrl: 'file:///C:/demo/source.png',
            boxes: [{ id: 'box-1', x: 10, y: 20, width: 30, height: 40 }],
            sheets: [
              {
                id: 'sheet-1',
                name: 'Sheet 1',
                rows: 1,
                cols: 1,
                cells: [{ id: 'cell-1', row: 0, col: 0, text: 'Name', bboxIds: ['box-1'] }]
              }
            ]
          }
        }
      ],
      ocrResult: {
        kind: 'table',
        sourceImageUrl: 'file:///C:/demo/source.png',
        boxes: [{ id: 'box-1', x: 10, y: 20, width: 30, height: 40 }],
        sheets: [
          {
            id: 'sheet-1',
            name: 'Sheet 1',
            rows: 1,
            cols: 1,
            cells: [{ id: 'cell-1', row: 0, col: 0, text: 'Name', bboxIds: ['box-1'] }]
          }
        ]
      },
      modelName: 'ocr-model'
    })
  })

  it('keeps per-attachment OCR bundles distinct when multiple file attachments are returned', () => {
    const message = buildAssistantMessageFromResult({
      content: 'Two OCR exports are ready.',
      attachments: [
        {
          type: 'file',
          url: 'file:///C:/demo/result-a.csv',
          fileName: 'result-a.csv',
          mimeType: 'text/csv',
          ocrResult: {
            kind: 'table',
            text: 'Alpha'
          }
        },
        {
          type: 'file',
          url: 'file:///C:/demo/result-b.csv',
          fileName: 'result-b.csv',
          mimeType: 'text/csv',
          ocrResult: {
            kind: 'table',
            text: 'Beta'
          }
        }
      ]
    })

    expect(message.attachments).toEqual([
      {
        type: 'file',
        url: 'local-media:///C:/demo/result-a.csv',
        fileName: 'result-a.csv',
        mimeType: 'text/csv',
        ocrResult: {
          kind: 'table',
          text: 'Alpha'
        }
      },
      {
        type: 'file',
        url: 'local-media:///C:/demo/result-b.csv',
        fileName: 'result-b.csv',
        mimeType: 'text/csv',
        ocrResult: {
          kind: 'table',
          text: 'Beta'
        }
      }
    ])
    expect(message.ocrResult).toBeUndefined()
  })

  it('extracts markdown model attachments even when structured attachments are also present', () => {
    const message = buildAssistantMessageFromResult({
      content: `[Generated 3D Model](https://example.com/download?id=mesh-2)

[Hunyuan3D] Result URLs may expire after 1 day.`,
      attachments: [
        {
          type: 'file',
          url: 'file:///C:/demo/report.txt',
          fileName: 'report.txt',
          mimeType: 'text/plain'
        }
      ]
    })

    expect(message).toEqual({
      role: 'assistant',
      content: '[Hunyuan3D] Result URLs may expire after 1 day.',
      attachments: [
        {
          type: 'file',
          url: 'local-media:///C:/demo/report.txt',
          fileName: 'report.txt',
          mimeType: 'text/plain'
        },
        {
          type: 'model3d',
          url: 'https://example.com/download?id=mesh-2',
          fileName: 'download'
        }
      ]
    })
  })

  it('does not turn plain markdown page links into attachments when structured attachments are present', () => {
    const message = buildAssistantMessageFromResult({
      content: 'See [docs](https://example.com/docs)',
      attachments: [
        {
          type: 'file',
          url: 'file:///C:/demo/report.txt',
          fileName: 'report.txt',
          mimeType: 'text/plain'
        }
      ]
    })

    expect(message).toEqual({
      role: 'assistant',
      content: 'See [docs](https://example.com/docs)',
      attachments: [
        {
          type: 'file',
          url: 'local-media:///C:/demo/report.txt',
          fileName: 'report.txt',
          mimeType: 'text/plain'
        }
      ]
    })
  })

  it('strips duplicated attachment summary boilerplate when the same structured image is already attached', () => {
    const message = buildAssistantMessageFromResult({
      content: [
        '[Attached image] cyberpunk-style.png',
        'Metadata: fileName="cyberpunk-style.png"; mimeType="image/png"; sizeBytes=1234516',
        'image attached: cyberpunk-style.png (image/png)'
      ].join('\n'),
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/cyberpunk-style.png',
          fileName: 'cyberpunk-style.png',
          mimeType: 'image/png',
          sizeBytes: 1234516
        }
      ]
    })

    expect(message).toEqual({
      role: 'assistant',
      content: '',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/cyberpunk-style.png',
          fileName: 'cyberpunk-style.png',
          mimeType: 'image/png',
          sizeBytes: 1234516
        }
      ]
    })
  })

  it('preserves meaningful assistant text while removing duplicated attachment summary boilerplate', () => {
    const message = buildAssistantMessageFromResult({
      content: [
        '已完成风格转换。',
        '',
        '[Attached image] cyberpunk-style.png',
        'Metadata: fileName="cyberpunk-style.png"; mimeType="image/png"',
        'image attached: cyberpunk-style.png (image/png)'
      ].join('\n'),
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/cyberpunk-style.png',
          fileName: 'cyberpunk-style.png',
          mimeType: 'image/png'
        }
      ]
    })

    expect(message).toEqual({
      role: 'assistant',
      content: '已完成风格转换。',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/cyberpunk-style.png',
          fileName: 'cyberpunk-style.png',
          mimeType: 'image/png'
        }
      ]
    })
  })

  it('deduplicates identical structured and inline image attachments', () => {
    const message = buildAssistantMessageFromResult({
      content: 'Preview ready.\n\n![image](https://example.com/out.png)',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/out.png',
          fileName: 'out.png',
          mimeType: 'image/png'
        }
      ]
    })

    expect(message).toEqual({
      role: 'assistant',
      content: 'Preview ready.',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/out.png',
          fileName: 'out.png',
          mimeType: 'image/png'
        }
      ]
    })
  })

  it('normalizes structured built-in tagging results into sidecar-ready assistant text', () => {
    const message = buildAssistantMessageFromResult(
      {
        content: JSON.stringify({
          results: [
            {
              fileName: 'hero-shot.png',
              tags: ['hero-shot', 'cinematic'],
              tagsText: 'hero-shot, cinematic',
              caption: 'A cinematic hero shot.'
            }
          ]
        })
      },
      'wdtagger',
      {
        skillId: BUILT_IN_TAGGING_SKILL_ID
      }
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'hero-shot, cinematic',
      modelName: 'wdtagger'
    })
  })

  it('keeps OCR metadata when normalizing structured built-in tagging results', () => {
    const message = buildAssistantMessageFromResult(
      {
        content: JSON.stringify({
          results: [
            {
              fileName: 'invoice.png',
              tags: [],
              tagsText: '',
              caption: 'Invoice #42',
              ocrResult: {
                kind: 'document',
                text: 'Invoice #42'
              }
            }
          ]
        })
      },
      'paddle-ocr',
      {
        skillId: BUILT_IN_TAGGING_SKILL_ID
      }
    )

    expect(message).toEqual({
      role: 'assistant',
      content: 'Invoice #42',
      ocrResult: {
        kind: 'document',
        text: 'Invoice #42'
      },
      modelName: 'paddle-ocr'
    })
  })
})
