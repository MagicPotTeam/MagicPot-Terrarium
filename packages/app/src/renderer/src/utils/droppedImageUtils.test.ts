import { beforeEach, describe, expect, it, vi } from 'vitest'

const getViewMock = vi.fn()
const readImageFromPathMock = vi.fn()
const readFileFromPathMock = vi.fn()
const { loadImageFromSrcMock } = vi.hoisted(() => ({
  loadImageFromSrcMock: vi.fn()
}))
const originalGetContext = HTMLCanvasElement.prototype.getContext
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL

vi.mock('./windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getView: getViewMock
    },
    svcFs: {
      readImageFromPath: readImageFromPathMock,
      readFileFromPath: readFileFromPathMock
    }
  })
}))

vi.mock('@renderer/pages/ProjectCanvasPage/canvasAssetIntakeHelpers', () => ({
  loadImageFromSrc: loadImageFromSrcMock
}))

import {
  AGENT_IMAGE_DRAG_MIME,
  getDroppedAttachmentFile,
  getDroppedTextContent,
  getDroppedImageDropError,
  getDroppedImageFile,
  getQuickAppWorkflowImportError,
  hasInternalCanvasImageCropSourceAttachment,
  INTERNAL_IMAGE_DRAG_PREFIX,
  isImageOnlyInternalDragPayload,
  materializeInternalImageDragAttachment,
  parseInternalImageDragPayload,
  QAPP_IMAGE_DRAG_MIME,
  UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE
} from './droppedImageUtils'
import { DEFAULT_PARAMS } from '@renderer/pages/ChatPage/hy3d/types'

const createDataTransfer = (data: Record<string, string>, files: File[] = []) =>
  ({
    files,
    getData: (key: string) => data[key] || ''
  }) as unknown as DataTransfer

describe('droppedImageUtils', () => {
  beforeEach(() => {
    getViewMock.mockReset()
    readImageFromPathMock.mockReset()
    readFileFromPathMock.mockReset()
    loadImageFromSrcMock.mockReset()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL
    vi.unstubAllGlobals()
  })

  it('parses internal payloads from the quick app mime type', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:demo',
          promptId: 'prompt-1'
        })
      })
    )

    expect(payload).toEqual({
      objectUrl: 'blob:demo',
      promptId: 'prompt-1',
      fileItem: undefined,
      sourceCanvasId: undefined,
      itemTypes: undefined,
      attachments: undefined,
      ocrResult: undefined,
      previewImageUrl: undefined,
      textContent: undefined,
      sourceWidth: undefined,
      sourceHeight: undefined
    })
  })

  it('parses internal payloads from the canvas text fallback', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        'text/plain': `${INTERNAL_IMAGE_DRAG_PREFIX}${JSON.stringify({
          objectUrl: 'blob:canvas',
          promptId: 'prompt-2'
        })}`
      })
    )

    expect(payload).toEqual({
      objectUrl: 'blob:canvas',
      promptId: 'prompt-2',
      fileItem: undefined,
      sourceCanvasId: undefined,
      itemTypes: undefined,
      attachments: undefined,
      ocrResult: undefined,
      previewImageUrl: undefined,
      textContent: undefined,
      sourceWidth: undefined,
      sourceHeight: undefined
    })
  })

  it('preserves internal drag item types when provided', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:canvas-file',
          itemTypes: ['file', 'image', 'unknown']
        })
      })
    )

    expect(payload).toEqual({
      objectUrl: 'blob:canvas-file',
      promptId: undefined,
      fileItem: undefined,
      sourceCanvasId: undefined,
      itemTypes: ['file', 'image'],
      attachments: undefined,
      ocrResult: undefined,
      previewImageUrl: undefined,
      textContent: undefined,
      sourceWidth: undefined,
      sourceHeight: undefined
    })
  })

  it('parses internal drag attachments and preview images when provided', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:canvas-selection',
          previewImageUrl: 'data:image/png;base64,preview',
          attachments: [
            {
              type: 'file',
              url: 'local-media:///C:/demo/spec.md',
              fileName: 'spec.md',
              mimeType: 'text/markdown',
              sizeBytes: 42
            }
          ]
        })
      })
    )

    expect(payload).toEqual({
      objectUrl: 'blob:canvas-selection',
      promptId: undefined,
      fileItem: undefined,
      sourceCanvasId: undefined,
      itemTypes: undefined,
      attachments: [
        {
          type: 'file',
          url: 'local-media:///C:/demo/spec.md',
          fileName: 'spec.md',
          mimeType: 'text/markdown',
          sizeBytes: 42,
          reportBundleId: undefined,
          reportBundleRole: undefined,
          reportBundleRefName: undefined,
          reportBundleManifestUrl: undefined,
          reportBundleLabel: undefined
        }
      ],
      ocrResult: undefined,
      previewImageUrl: 'data:image/png;base64,preview',
      textContent: undefined,
      sourceWidth: undefined,
      sourceHeight: undefined
    })
  })

  it('parses attachment-level OCR metadata from internal drag attachments', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          itemTypes: ['file'],
          attachments: [
            {
              type: 'file',
              url: 'local-media:///C:/demo/result.csv',
              fileName: 'result.csv',
              mimeType: 'text/csv',
              ocrResult: {
                kind: 'table',
                text: 'Beta'
              }
            }
          ]
        })
      })
    )

    expect(payload?.attachments).toEqual([
      {
        type: 'file',
        url: 'local-media:///C:/demo/result.csv',
        fileName: 'result.csv',
        mimeType: 'text/csv',
        sizeBytes: undefined,
        ocrResult: {
          kind: 'table',
          text: 'Beta'
        },
        reportBundleId: undefined,
        reportBundleRole: undefined,
        reportBundleRefName: undefined,
        reportBundleManifestUrl: undefined,
        reportBundleLabel: undefined
      }
    ])
  })

  it('preserves report bundle metadata from internal drag attachments', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          itemTypes: ['file'],
          attachments: [
            {
              type: 'file',
              url: 'local-media:///C:/demo/report.md',
              fileName: 'report.md',
              mimeType: 'text/markdown',
              reportBundleId: 'bundle-1',
              reportBundleRole: 'primary-report',
              reportBundleRefName: 'report.md',
              reportBundleManifestUrl: 'local-media:///C:/demo/manifest.json',
              reportBundleLabel: 'Canvas Check'
            }
          ]
        })
      })
    )

    expect(payload?.attachments).toEqual([
      {
        type: 'file',
        url: 'local-media:///C:/demo/report.md',
        fileName: 'report.md',
        mimeType: 'text/markdown',
        sizeBytes: undefined,
        ocrResult: undefined,
        reportBundleId: 'bundle-1',
        reportBundleRole: 'primary-report',
        reportBundleRefName: 'report.md',
        reportBundleManifestUrl: 'local-media:///C:/demo/manifest.json',
        reportBundleLabel: 'Canvas Check'
      }
    ])
  })

  it('parses OCR result metadata from internal drag payloads when provided', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          itemTypes: ['file'],
          ocrResult: {
            kind: 'table',
            sourceImageUrl: 'file:///C:/demo/source.png',
            boxes: [{ id: 'box-1', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
            sheets: [
              {
                id: 'sheet-1',
                name: 'Sheet 1',
                rows: 1,
                cols: 1,
                cells: [{ id: 'cell-1', row: 0, col: 0, text: 'Alpha', bboxIds: ['box-1'] }]
              }
            ]
          }
        })
      })
    )

    expect(payload).toEqual({
      objectUrl: undefined,
      promptId: undefined,
      fileItem: undefined,
      sourceCanvasId: undefined,
      itemTypes: ['file'],
      attachments: undefined,
      ocrResult: {
        kind: 'table',
        sourceImageUrl: 'file:///C:/demo/source.png',
        boxes: [{ id: 'box-1', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
        sheets: [
          {
            id: 'sheet-1',
            name: 'Sheet 1',
            rows: 1,
            cols: 1,
            cells: [{ id: 'cell-1', row: 0, col: 0, text: 'Alpha', bboxIds: ['box-1'] }]
          }
        ]
      },
      previewImageUrl: undefined,
      textContent: undefined,
      sourceWidth: undefined,
      sourceHeight: undefined
    })
  })

  it('preserves source dimensions when drag payload includes them', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:original-sized',
          sourceWidth: 2048,
          sourceHeight: 1152
        })
      })
    )

    expect(payload).toEqual({
      objectUrl: 'blob:original-sized',
      promptId: undefined,
      fileItem: undefined,
      sourceCanvasId: undefined,
      itemTypes: undefined,
      attachments: undefined,
      ocrResult: undefined,
      previewImageUrl: undefined,
      textContent: undefined,
      sourceWidth: 2048,
      sourceHeight: 1152
    })
  })

  it('preserves the source canvas id when internal drags originate from a canvas', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:canvas-image',
          sourceCanvasId: 'canvas-1'
        })
      })
    )

    expect(payload).toEqual({
      objectUrl: 'blob:canvas-image',
      promptId: undefined,
      fileItem: undefined,
      sourceCanvasId: 'canvas-1',
      itemTypes: undefined,
      attachments: undefined,
      ocrResult: undefined,
      previewImageUrl: undefined,
      textContent: undefined,
      sourceWidth: undefined,
      sourceHeight: undefined
    })
  })

  it('extracts dropped text from internal quick app payloads when available', () => {
    expect(
      getDroppedTextContent(
        createDataTransfer({
          [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
            objectUrl: 'blob:text-card',
            itemTypes: ['text'],
            textContent: 'Dragged prompt text'
          })
        })
      )
    ).toBe('Dragged prompt text')
  })

  it('does not expose internal image payload text as composer drop text', () => {
    expect(
      getDroppedTextContent(
        createDataTransfer({
          [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
            itemTypes: ['image'],
            textContent: 'caption context',
            attachments: [
              {
                type: 'image',
                url: 'local-media:///C:/MagicPot/source.jpg',
                fileName: 'source.png',
                mimeType: 'image/png',
                metadata: {
                  magicpotCanvasCropSource: {
                    url: 'local-media:///C:/MagicPot/source.jpg',
                    fileName: 'source.png',
                    sourceWidth: 100,
                    sourceHeight: 80,
                    crop: { x: 10, y: 20, width: 30, height: 40 }
                  }
                }
              }
            ]
          }),
          'text/plain': 'caption context'
        })
      )
    ).toBeNull()
  })

  it('detects internal canvas crop metadata so callers can avoid full-image fallbacks', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'local-media:///C:/MagicPot/source.jpg',
          itemTypes: ['image'],
          attachments: [
            {
              type: 'image',
              url: 'local-media:///C:/MagicPot/source.jpg',
              fileName: 'source.png',
              mimeType: 'image/png',
              metadata: {
                magicpotCanvasCropSource: {
                  url: 'local-media:///C:/MagicPot/source.jpg',
                  fileName: 'source.png',
                  sourceWidth: 100,
                  sourceHeight: 80,
                  crop: { x: 10, y: 20, width: 30, height: 40 }
                }
              }
            }
          ]
        })
      })
    )

    expect(payload).toBeTruthy()
    expect(payload && hasInternalCanvasImageCropSourceAttachment(payload)).toBe(true)
  })

  it('parses hidden text content for internal drag payloads without exposing it as dropped text', () => {
    const payload = parseInternalImageDragPayload(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:hidden-context',
          hiddenTextContent: 'Canvas asset manifest:\n- type=image; order=1'
        })
      })
    )

    expect(payload).toEqual({
      objectUrl: 'blob:hidden-context',
      promptId: undefined,
      fileItem: undefined,
      sourceCanvasId: undefined,
      itemTypes: undefined,
      attachments: undefined,
      ocrResult: undefined,
      previewImageUrl: undefined,
      textContent: undefined,
      hiddenTextContent: 'Canvas asset manifest:\n- type=image; order=1',
      sourceWidth: undefined,
      sourceHeight: undefined
    })
    expect(
      getDroppedTextContent(
        createDataTransfer({
          [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
            objectUrl: 'blob:hidden-context',
            hiddenTextContent: 'Canvas asset manifest:\n- type=image; order=1'
          })
        })
      )
    ).toBeNull()
  })

  it('prefers comfy file items for quick app result drags', async () => {
    getViewMock.mockResolvedValue({
      result: new Uint8Array([1, 2, 3, 4])
    })

    const file = await getDroppedImageFile(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:stale-result',
          promptId: 'prompt-3',
          fileItem: {
            filename: 'result.png',
            type: 'output'
          }
        })
      })
    )

    expect(getViewMock).toHaveBeenCalledWith({
      filename: 'result.png',
      type: 'output'
    })
    expect(file?.name).toBe('result.png')
    expect(file?.type).toBe('image/png')
    expect(file?.size).toBe(4)
  })

  it('loads agent local-media drags through the fs service', async () => {
    readImageFromPathMock.mockResolvedValue({
      image: new Uint8Array([9, 8, 7]),
      filename: 'agent.png'
    })

    const file = await getDroppedImageFile(
      createDataTransfer({
        [AGENT_IMAGE_DRAG_MIME]: 'local-media:///C:/demo/agent.png'
      })
    )

    expect(readImageFromPathMock).toHaveBeenCalledWith({
      fullPath: 'C:/demo/agent.png'
    })
    expect(file?.name).toBe('agent.png')
    expect(file?.type).toBe('image/png')
  })

  it('recrops lightweight internal canvas image attachments from the original source', async () => {
    readImageFromPathMock.mockResolvedValue({
      image: new Uint8Array([9, 8, 7]),
      filename: 'source.jpg'
    })
    const bitmap = {
      width: 100,
      height: 80,
      close: vi.fn()
    } as unknown as ImageBitmap
    const createImageBitmapMock = vi.fn().mockResolvedValue(bitmap)
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)
    const drawImage = vi.fn()
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        drawImage
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,Y2xlYXI=')

    const file = await getDroppedImageFile(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          itemTypes: ['image'],
          attachments: [
            {
              type: 'image',
              url: 'local-media:///C:/MagicPot/source.jpg',
              fileName: 'source.png',
              mimeType: 'image/png',
              sourceWidth: 30,
              sourceHeight: 40,
              metadata: {
                magicpotCanvasCropSource: {
                  url: 'local-media:///C:/MagicPot/source.jpg',
                  fileName: 'source.png',
                  sourceWidth: 100,
                  sourceHeight: 80,
                  crop: { x: 10, y: 20, width: 30, height: 40 }
                }
              }
            }
          ]
        })
      })
    )

    expect(readImageFromPathMock).toHaveBeenCalledWith({
      fullPath: 'C:/MagicPot/source.jpg'
    })
    expect(createImageBitmapMock).toHaveBeenCalled()
    expect(drawImage).toHaveBeenCalledWith(bitmap, 10, 20, 30, 40, 0, 0, 30, 40)
    expect(bitmap.close).toHaveBeenCalled()
    expect(file?.name).toBe('source.png')
    expect(file?.type).toBe('image/png')
    expect(file?.size).toBeGreaterThan(0)
  })

  it('recrops through the canvas image loader if file payload decoding fails', async () => {
    readImageFromPathMock.mockRejectedValue(new Error('source missing'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fallbackImage = document.createElement('img')
    loadImageFromSrcMock.mockResolvedValue({
      img: fallbackImage,
      width: 100,
      height: 80
    })
    const drawImage = vi.fn()
    HTMLCanvasElement.prototype.getContext = (() =>
      ({
        drawImage
      }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,Y2FudmFz')

    const materialized = await materializeInternalImageDragAttachment({
      type: 'image',
      url: 'local-media:///C:/MagicPot/source.jpg',
      fileName: 'source.png',
      mimeType: 'image/png',
      sourceWidth: 30,
      sourceHeight: 40,
      metadata: {
        magicpotCanvasCropSource: {
          url: 'local-media:///C:/MagicPot/source.jpg',
          fileName: 'source.png',
          sourceWidth: 100,
          sourceHeight: 80,
          crop: { x: 10, y: 20, width: 30, height: 40 }
        }
      }
    })

    expect(readImageFromPathMock).toHaveBeenCalledWith({
      fullPath: 'C:/MagicPot/source.jpg'
    })
    expect(loadImageFromSrcMock).toHaveBeenCalledWith('local-media:///C:/MagicPot/source.jpg')
    expect(drawImage).toHaveBeenCalledWith(fallbackImage, 10, 20, 30, 40, 0, 0, 30, 40)
    expect(materialized).toEqual(
      expect.objectContaining({
        type: 'image',
        url: 'data:image/png;base64,Y2FudmFz',
        fileName: 'source.png',
        mimeType: 'image/png',
        sourceWidth: 30,
        sourceHeight: 40
      })
    )
    expect(materialized).not.toBeNull()
    if (!materialized) {
      throw new Error('Expected cropped image attachment to materialize')
    }
    expect(materialized.metadata).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      '[DropImage] failed to decode cropped canvas source through file payload; retrying canvas loader:',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('drops cropped canvas attachments instead of falling back to the full source on crop failure', async () => {
    readImageFromPathMock.mockRejectedValue(new Error('source missing'))
    loadImageFromSrcMock.mockRejectedValue(new Error('loader missing'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const materialized = await materializeInternalImageDragAttachment({
      type: 'image',
      url: 'local-media:///C:/MagicPot/source.jpg',
      fileName: 'source.png',
      mimeType: 'image/png',
      sourceWidth: 30,
      sourceHeight: 40,
      metadata: {
        magicpotCanvasCropSource: {
          url: 'local-media:///C:/MagicPot/source.jpg',
          fileName: 'source.png',
          sourceWidth: 100,
          sourceHeight: 80,
          crop: { x: 10, y: 20, width: 30, height: 40 }
        }
      }
    })

    expect(materialized).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      '[DropImage] failed to crop internal canvas image from original source:',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('keeps legacy objectUrl precedence for non-cropped internal image attachments', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('data:image/png;base64,b3ZlcnZpZXc=')
      return {
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const file = await getDroppedImageFile(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'data:image/png;base64,b3ZlcnZpZXc=',
          itemTypes: ['image'],
          attachments: [
            {
              type: 'image',
              url: 'data:image/png;base64,aXRlbQ==',
              fileName: 'item.png',
              mimeType: 'image/png'
            }
          ]
        })
      })
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(file?.name).toBe('qapp-image.png')
    expect(file?.size).toBe(3)
  })

  it('materializes dropped local-media file attachments through the fs service', async () => {
    readFileFromPathMock.mockResolvedValue({
      data: new Uint8Array([115, 104, 101, 101, 116]),
      filename: 'result.xlsx'
    })

    const file = await getDroppedAttachmentFile(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          itemTypes: ['file'],
          attachments: [
            {
              type: 'file',
              url: 'local-media:///C:/demo/result.xlsx',
              fileName: 'result.xlsx',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }
          ]
        })
      })
    )

    expect(readFileFromPathMock).toHaveBeenCalledWith({
      fullPath: 'C:/demo/result.xlsx'
    })
    expect(file?.name).toBe('result.xlsx')
    expect(file?.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('falls back to fetch for remote dropped file attachments', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['report'], { type: 'text/plain' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const file = await getDroppedAttachmentFile(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          itemTypes: ['file'],
          attachments: [
            {
              type: 'file',
              url: 'https://example.com/report.txt',
              fileName: 'report.txt',
              mimeType: 'text/plain'
            }
          ]
        })
      })
    )

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/report.txt')
    expect(file?.name).toBe('report.txt')
    expect(file?.type).toBe('text/plain')
  })

  it('rejects non-image internal drags for image-only consumers', () => {
    expect(
      isImageOnlyInternalDragPayload({
        objectUrl: 'blob:file-card',
        itemTypes: ['file']
      })
    ).toBe(false)
  })

  it('returns a clear quick app error for unsupported internal workflow sources', () => {
    const message = getQuickAppWorkflowImportError({
      objectUrl: 'blob:model3d-card',
      itemTypes: ['model3d']
    })

    expect(message).toContain('3D')
    expect(message).toContain('.mpqapp')
  })

  it('accepts internal 3d drags when Hunyuan quick app provenance is present', () => {
    expect(
      getQuickAppWorkflowImportError({
        objectUrl: 'blob:model3d-card',
        itemTypes: ['model3d'],
        hy3dQuickAppKey: '~builtin/hunyuan3d/uv',
        hy3dParams: {
          ...DEFAULT_PARAMS,
          apiAction: 'SubmitHunyuanTo3DUVJob'
        }
      })
    ).toBeNull()
  })

  it('returns the unified file error for unsupported internal file drags', () => {
    expect(
      getQuickAppWorkflowImportError({
        objectUrl: 'blob:file-card',
        itemTypes: ['file']
      })
    ).toBe(UNSUPPORTED_INTERNAL_FILE_DROP_MESSAGE)
  })

  it('returns a clear quick app error when workflow metadata is missing', () => {
    const message = getQuickAppWorkflowImportError({
      objectUrl: 'blob:canvas-image',
      itemTypes: ['image']
    })

    expect(message).toContain('工作流信息')
  })

  it('accepts quick app image result drags when workflow metadata is present', () => {
    expect(
      getQuickAppWorkflowImportError({
        objectUrl: 'blob:qapp-image',
        promptId: 'prompt-5',
        itemTypes: ['image']
      })
    ).toBeNull()
  })

  it('accepts quick app video result drags when prompt history is available', () => {
    expect(
      getQuickAppWorkflowImportError({
        objectUrl: 'blob:qapp-video',
        promptId: 'prompt-6',
        itemTypes: ['video']
      })
    ).toBeNull()
  })

  it('rejects unsupported files for image-only drops with a specific message', () => {
    const message = getDroppedImageDropError(
      createDataTransfer({}, [
        new File(['doc'], 'brief.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }),
        new File(['notes'], 'note.txt', { type: 'text/plain' }),
        new File(['vector'], 'icon.svg', { type: 'image/svg+xml' })
      ])
    )

    expect(message).toContain('当前图片输入只支持图片文件')
    expect(message).toContain('.docx')
    expect(message).toContain('.txt')
    expect(message).toContain('.svg')
  })

  it('accepts svg files when the caller explicitly allows them', async () => {
    const svgFile = new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'icon.svg', {
      type: 'image/svg+xml'
    })

    expect(getDroppedImageDropError(createDataTransfer({}, [svgFile]), { allowSvg: true })).toBe(
      null
    )
    await expect(
      getDroppedImageFile(createDataTransfer({}, [svgFile]), { allowSvg: true })
    ).resolves.toBe(svgFile)
  })

  it('rejects model3d internal drags for image-only drops with a specific message', () => {
    const message = getDroppedImageDropError(
      createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          objectUrl: 'blob:model3d-card',
          itemTypes: ['model3d']
        })
      })
    )

    expect(message).toContain('3D')
    expect(message).toContain('当前图片输入只支持图片内容')
  })
  it('rejects internal file drags for image-only drops with the image-only file message', () => {
    expect(
      getDroppedImageDropError(
        createDataTransfer({
          [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
            objectUrl: 'blob:file-card',
            itemTypes: ['file']
          })
        })
      )
    ).toBe('当前图片输入只支持图片内容，不能拖入文件。')
  })
})
