import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { theme } from '@renderer/theme'
import { QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import type { ChatSession } from '../ChatPage/chatStorage'

const {
  notifySuccess,
  notifyError,
  notifyWarning,
  closeMessage,
  mockNavigate,
  mockDispatch,
  mockLoadCanvasItems,
  mockSaveCanvasItems,
  mockListQAppCfgs
} = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  closeMessage: vi.fn(),
  mockNavigate: vi.fn(),
  mockDispatch: vi.fn(),
  mockLoadCanvasItems: vi.fn(),
  mockSaveCanvasItems: vi.fn(),
  mockListQAppCfgs: vi.fn()
}))

vi.mock('react-konva', async () => {
  const ReactModule = await import('react')

  const Stage = ReactModule.forwardRef(function MockStage(
    { children }: { children?: React.ReactNode },
    ref: React.ForwardedRef<{
      getStage: () => unknown
      findOne: () => null
      find: () => unknown[]
      width: (value: number) => number
      height: (value: number) => number
      container: () => HTMLDivElement | null
      getPointerPosition: () => { x: number; y: number }
      getAbsoluteTransform: () => {
        copy: () => {
          invert: () => void
          point: (point: { x: number; y: number }) => { x: number; y: number }
        }
      }
      toDataURL: () => string
    }>
  ) {
    const containerRef = ReactModule.useRef<HTMLDivElement>(null)

    const stageApi = ReactModule.useMemo(() => {
      const api = {
        getStage: () => api,
        findOne: () => null,
        find: () => [],
        width: (value: number) => value,
        height: (value: number) => value,
        container: () => containerRef.current,
        getPointerPosition: () => ({ x: 0, y: 0 }),
        getAbsoluteTransform: () => ({
          copy: () => ({
            invert: () => undefined,
            point: (point: { x: number; y: number }) => point
          })
        }),
        toDataURL: () => 'data:image/png;base64,stage'
      }

      return api
    }, [])

    ReactModule.useImperativeHandle(ref, () => stageApi)

    return (
      <div data-testid="mock-konva-stage" ref={containerRef}>
        {children}
      </div>
    )
  })

  return {
    Stage,
    Layer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Rect: () => null,
    Image: () => null,
    Transformer: () => <div data-testid="mock-transformer" />,
    Line: () => null,
    Text: () => null,
    Ellipse: () => null,
    Arrow: () => null,
    Shape: () => null,
    Group: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  }
})

vi.mock('konva/lib/Stage', () => ({
  Stage: class {}
}))

vi.mock('konva', () => ({
  default: {}
}))

vi.mock('react-router-dom', () => ({
  useLocation: () => ({
    search: '?id=canvas-ocr-test'
  }),
  useNavigate: () => mockNavigate
}))

vi.mock('react-redux', () => ({
  useDispatch: () => mockDispatch,
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      layout: {
        openTabs: [
          {
            id: 'canvas-ocr-test',
            label: 'OCR Canvas'
          }
        ]
      }
    })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: {
      language: 'zh-CN'
    }
  })
}))

vi.mock('../../hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess,
    notifyError,
    notifyWarning,
    closeMessage
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess,
    notifyError,
    notifyWarning,
    closeMessage
  })
}))

vi.mock('../../utils/windowUtils', () => ({
  api: () => ({
    svcLLMProxy: {
      chat: vi.fn(),
      listProfiles: vi.fn().mockResolvedValue({ profiles: [] })
    },
    svcDialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn()
    },
    svcFs: {
      saveImageToPath: vi.fn(),
      readFileFromPath: vi.fn(async ({ fullPath }: { fullPath: string }) => ({
        data: new TextEncoder().encode(
          fullPath.includes('result-a.csv') ? 'name,value\nAlpha,1' : 'name,value\nBeta,2'
        ),
        filename: fullPath.split(/[\\/]/).pop() || 'attachment.csv'
      }))
    },
    svcHyper: {
      saveImageToDir: vi.fn(),
      writeImageToClipboard: vi.fn()
    },
    svcPhotoshop: {
      sendImageToPhotoshop: vi.fn()
    },
    svcState: {
      saveConfig: vi.fn(),
      getConfig: vi.fn().mockResolvedValue({})
    },
    svcAdobeBridge: {
      exportAsset: vi.fn()
    },
    svcDccBridge: {
      exportModel: vi.fn()
    },
    svcQApp: {
      listQAppCfgs: mockListQAppCfgs
    },
    svcTargetScheme: {
      listTargetSchemes: vi.fn().mockResolvedValue({ schemes: [] })
    }
  })
}))

vi.mock('./canvasStorage', () => ({
  saveCanvasItems: mockSaveCanvasItems,
  loadCanvasItems: mockLoadCanvasItems,
  clearCanvasItems: vi.fn().mockResolvedValue(undefined),
  exportCanvasFile: vi.fn(),
  importCanvasFile: vi.fn(),
  isCanvasFile: vi.fn().mockReturnValue(false)
}))

vi.mock('../../components/MaxSizeLayout', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('./components/canvasSync', () => ({
  scheduleCanvasSync: vi.fn(),
  cancelCanvasSync: vi.fn()
}))

vi.mock('./components/Model3DOverlay', () => ({ default: () => null }))
vi.mock('./components/VideoOverlay', () => ({ default: () => null }))
vi.mock('./components/CanvasItemPlaceholder', () => ({
  default: ({
    item,
    onHoverChange
  }: {
    item: {
      id: string
      type?: string
      fileName?: string
      ocrBoxId?: string
      label?: string
    }
    onHoverChange?: (isHovering: boolean) => void
  }) =>
    item.type === 'image' ? (
      <div data-testid={`canvas-image-${item.id}`}>{item.fileName || item.id}</div>
    ) : item.type === 'file' ? (
      <div data-testid={`canvas-file-${item.id}`}>{item.fileName || item.id}</div>
    ) : item.type === 'annotation' && item.ocrBoxId ? (
      <button
        type="button"
        data-testid={`ocr-hover-proxy-${item.ocrBoxId}`}
        onMouseEnter={() => onHoverChange?.(true)}
        onMouseLeave={() => onHoverChange?.(false)}
      >
        {item.label || item.ocrBoxId}
      </button>
    ) : null
}))
vi.mock('./components/Model3DViewerDialog', () => ({ default: () => null }))
vi.mock('./components/ProjectCanvasImageCropOverlay', () => ({
  default: () => null
}))
vi.mock('./components/CanvasTextNode', () => ({ default: () => null }))
vi.mock('./components/ProjectCanvasImageInteractionOverlay', () => ({
  default: ({ item }: { item: { id: string; fileName?: string } }) => (
    <div data-testid={`canvas-image-${item.id}`}>{item.fileName || item.id}</div>
  )
}))
vi.mock('./components/ProjectCanvasWebGLImageLayer', async () => {
  const ReactModule = await import('react')

  return {
    __esModule: true,
    PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT: 96,
    PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES: 256 * 1024 * 1024,
    default: ReactModule.forwardRef(function MockProjectCanvasWebGLImageLayer(
      {
        onReadyChange,
        onResidentIdsChange,
        onResolvedIdsChange,
        onMetricsChange
      }: {
        items: unknown[]
        onReadyChange?: (ready: boolean) => void
        onResidentIdsChange?: (residentIds: Set<string>) => void
        onResolvedIdsChange?: (resolvedIds: Set<string>) => void
        onMetricsChange?: (metrics: {
          isInitialized: boolean
          imageCount: number
          loadedImageCount: number
          residentImageCount: number
          pendingImageCount: number
          spriteCount: number
          renderCount: number
          lastRenderDurationMs: number | null
          lastUpdateReason: 'initialize' | 'items' | 'preview' | 'cleanup'
        }) => void
      },
      ref: React.ForwardedRef<{ syncItemPreview: () => void }>
    ) {
      ReactModule.useImperativeHandle(ref, () => ({
        syncItemPreview: () => undefined
      }))

      ReactModule.useEffect(() => {
        onReadyChange?.(true)
        onResidentIdsChange?.(new Set())
        onResolvedIdsChange?.(new Set())
        onMetricsChange?.({
          isInitialized: true,
          imageCount: 0,
          loadedImageCount: 0,
          residentImageCount: 0,
          pendingImageCount: 0,
          spriteCount: 0,
          renderCount: 0,
          lastRenderDurationMs: null,
          lastUpdateReason: 'initialize'
        })
      }, [onMetricsChange, onReadyChange, onResolvedIdsChange, onResidentIdsChange])

      return <div data-testid="mock-webgl-layer" />
    })
  }
})
vi.mock('./components/CanvasSelectionActionToolbar', () => ({
  default: () => null
}))
vi.mock('./components/GroupPlaybackOverlay', () => ({ default: () => null }))
vi.mock('./Dialogs/LabelEditorDialog', () => ({ LabelEditorDialog: () => null }))
vi.mock('./Dialogs/ClearConfirmDialog', () => ({ ClearConfirmDialog: () => null }))
vi.mock('./Dialogs/TextureImportDialog', () => ({ TextureImportDialog: () => null }))
vi.mock('./components/CanvasAnnotationOverlay', () => ({
  default: ({
    item,
    isEmphasized
  }: {
    item: { id: string; label?: string; ocrBoxId?: string }
    isEmphasized?: boolean
  }) => (
    <button
      type="button"
      data-testid={`ocr-box-${item.ocrBoxId || item.id}`}
      data-emphasized={isEmphasized ? 'true' : 'false'}
    >
      {item.label || item.ocrBoxId || item.id}
    </button>
  )
}))
vi.mock('./components/ColorWheelSquarePicker', () => ({
  default: () => null,
  ColorWheelSquarePicker: () => null,
  hexToRgb: vi.fn(),
  rgbToHex: vi.fn(),
  rgbToHsv: vi.fn(),
  hsvToRgb: vi.fn(),
  colorToHsv: vi.fn(),
  hsvToHex: vi.fn(),
  clamp01: vi.fn(),
  isColorLight: vi.fn()
}))

import ProjectCanvasPage from './ProjectCanvasPage'
import ChatMessageList from '../ChatPage/components/ChatMessageList'

const emptyFileList = {
  length: 0,
  item: () => null
} as unknown as FileList

const createDataTransferMock = () => {
  const data = new Map<string, string>()
  const target = {
    effectAllowed: 'none' as DataTransfer['effectAllowed'],
    files: emptyFileList,
    items: [] as unknown as DataTransferItemList,
    setData: (type: string, value: string) => {
      data.set(type, value)
    },
    getData: (type: string) => data.get(type) || ''
  }

  return { data, target: target as unknown as DataTransfer }
}

const renderChatMessageList = (currentSession: ChatSession) => (
  <ChatMessageList
    currentSession={currentSession}
    isLoading={false}
    editingMessageIndex={null}
    editingContent=""
    onSetEditingIndex={vi.fn()}
    onSetEditingContent={vi.fn()}
    onSendEditedMessage={vi.fn()}
    onPreviewImage={vi.fn()}
    onImageContextMenu={vi.fn()}
    onDownloadAttachment={vi.fn()}
    onSendModelToDcc={vi.fn()}
    chatContainerRef={React.createRef<HTMLDivElement>()}
    messagesEndRef={React.createRef<HTMLDivElement>()}
  />
)

describe('ProjectCanvasPage OCR agent drag/drop integration', () => {
  beforeEach(() => {
    localStorage.clear()

    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      naturalWidth = 640
      naturalHeight = 480
      width = 640
      height = 480
      crossOrigin = ''
      private _src = ''

      set src(value: string) {
        this._src = value
        this.onload?.()
      }

      get src() {
        return this._src
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)

        if (url.includes('result-a.csv')) {
          return new Response(new Blob(['name,value\nAlpha,1'], { type: 'text/csv' }), {
            status: 200
          })
        }

        if (url.includes('result-b.csv')) {
          return new Response(new Blob(['name,value\nBeta,2'], { type: 'text/csv' }), {
            status: 200
          })
        }

        return new Response('not found', { status: 404 })
      })
    )

    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((file: File) => `blob:${file.name}`)
    })
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn()
    })
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {
          return undefined
        }
        unobserve() {
          return undefined
        }
        disconnect() {
          return undefined
        }
      }
    )

    notifySuccess.mockReset()
    notifyError.mockReset()
    notifyWarning.mockReset()
    closeMessage.mockReset()
    mockDispatch.mockReset()
    mockNavigate.mockReset()
    mockLoadCanvasItems.mockReset()
    mockSaveCanvasItems.mockReset()
    mockListQAppCfgs.mockReset()

    mockLoadCanvasItems.mockResolvedValue({
      items: [],
      groups: [],
      figmaBinding: null
    })
    mockSaveCanvasItems.mockResolvedValue(undefined)
    mockListQAppCfgs.mockResolvedValue([])
  })

  it('drags the selected OCR attachment into the canvas and keeps hover linkage scoped to that bundle', async () => {
    render(
      <ThemeProvider theme={theme}>
        <>
          {renderChatMessageList({
            id: 'chat-ocr-bundles',
            title: 'OCR Bundles',
            messages: [
              {
                role: 'assistant',
                content: 'Choose the table you want to inspect.',
                attachments: [
                  {
                    type: 'file',
                    url: 'file:///C:/demo/result-a.csv',
                    fileName: 'result-a.csv',
                    mimeType: 'text/csv',
                    ocrResult: {
                      kind: 'table',
                      sourceImageUrl: 'file:///C:/demo/source-a.png',
                      boxes: [{ id: 'box-a', x: 0.1, y: 0.12, width: 0.22, height: 0.18 }],
                      sheets: [
                        {
                          id: 'sheet-a',
                          name: 'Sheet A',
                          rows: 1,
                          cols: 1,
                          cells: [
                            { id: 'cell-a', row: 0, col: 0, text: 'Alpha', bboxIds: ['box-a'] }
                          ]
                        }
                      ]
                    }
                  },
                  {
                    type: 'file',
                    url: 'file:///C:/demo/result-b.csv',
                    fileName: 'result-b.csv',
                    mimeType: 'text/csv',
                    ocrResult: {
                      kind: 'table',
                      sourceImageUrl: 'file:///C:/demo/source-b.png',
                      boxes: [{ id: 'box-b', x: 0.18, y: 0.24, width: 0.28, height: 0.16 }],
                      sheets: [
                        {
                          id: 'sheet-b',
                          name: 'Sheet B',
                          rows: 1,
                          cols: 1,
                          cells: [
                            { id: 'cell-b', row: 0, col: 0, text: 'Beta', bboxIds: ['box-b'] }
                          ]
                        }
                      ]
                    }
                  }
                ]
              }
            ]
          })}
          <ProjectCanvasPage />
        </>
      </ThemeProvider>
    )

    const { data, target: dataTransfer } = createDataTransferMock()
    const draggable = Array.from(document.querySelectorAll('[draggable="true"]')).find((element) =>
      element.textContent?.includes('result-b.csv')
    )

    expect(draggable).toBeTruthy()

    fireEvent.dragStart(draggable as Element, {
      dataTransfer
    })

    const dragPayload = JSON.parse(data.get(QAPP_IMAGE_DRAG_MIME) || '{}')
    expect(dragPayload.attachments?.[0]?.ocrResult?.sheets?.[0]?.cells?.[0]?.text).toBe('Beta')

    const canvasStage = screen.getByTestId('project-canvas-stage-root')

    fireEvent.dragOver(canvasStage, {
      dataTransfer,
      clientX: 320,
      clientY: 240
    })
    fireEvent.drop(canvasStage, {
      dataTransfer,
      clientX: 320,
      clientY: 240
    })

    await waitFor(() => {
      expect(screen.getByText('Beta')).toBeTruthy()
    })

    expect(screen.queryByText('Alpha')).toBeNull()
    expect(document.querySelector('[data-testid^="canvas-image-"]')).toBeTruthy()
    expect(document.querySelector('[data-testid^="canvas-file-"]')).toBeTruthy()

    const annotation = await screen.findByTestId('ocr-box-box-b')
    const annotationHoverProxy = screen.getByTestId('ocr-hover-proxy-box-b')
    const cellText = screen.getByText('Beta')
    const htmlCell = document.querySelector('[data-ocr-cell-id="cell-b"]') as HTMLElement | null
    const htmlHoverRoot = htmlCell?.closest('.mp-ocr-root')?.parentElement as HTMLElement | null

    expect(annotation.getAttribute('data-emphasized')).toBe('false')
    expect(htmlCell).toBeTruthy()
    expect(htmlHoverRoot).toBeTruthy()

    fireEvent.pointerOver(cellText)

    await waitFor(() => {
      expect(annotation.getAttribute('data-emphasized')).toBe('true')
    })

    fireEvent.pointerLeave(htmlHoverRoot as HTMLElement)

    await waitFor(() => {
      expect(annotation.getAttribute('data-emphasized')).toBe('false')
    })

    fireEvent.mouseEnter(annotationHoverProxy)

    await waitFor(() => {
      expect(
        document.querySelector('[data-ocr-cell-id="cell-b"]')?.classList.contains('is-active')
      ).toBe(true)
    })
  })

  it('ignores internal image drops that originated from the same canvas', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    const { data, target: dataTransfer } = createDataTransferMock()
    mockSaveCanvasItems.mockClear()
    data.set(
      QAPP_IMAGE_DRAG_MIME,
      JSON.stringify({
        objectUrl: 'blob:canvas-image',
        sourceCanvasId: 'canvas-ocr-test'
      })
    )

    const canvasStage = screen.getByTestId('project-canvas-stage-root')

    fireEvent.dragOver(canvasStage, {
      dataTransfer,
      clientX: 280,
      clientY: 180
    })
    fireEvent.drop(canvasStage, {
      dataTransfer,
      clientX: 280,
      clientY: 180
    })

    await waitFor(() => {
      expect(document.querySelector('[data-testid^="canvas-image-"]')).toBeNull()
    })
  })

  it('drops cached markdown report attachments with bundle metadata onto the canvas', async () => {
    render(
      <ThemeProvider theme={theme}>
        <>
          {renderChatMessageList({
            id: 'chat-report-bundle',
            title: 'Report Bundle',
            messages: [
              {
                role: 'assistant',
                content: '已生成“主控规划”目标结果文件。',
                attachments: [
                  {
                    type: 'file',
                    url: 'local-media:///C:/demo/.report_bundles/bundle-1/canvas-target-主控规划.md',
                    fileName: 'canvas-target-主控规划.md',
                    mimeType: 'text/markdown',
                    reportBundleId: 'bundle-1',
                    reportBundleRole: 'primary-report',
                    reportBundleRefName: 'canvas-target-主控规划.md',
                    reportBundleManifestUrl:
                      'local-media:///C:/demo/.report_bundles/bundle-1/manifest.json',
                    reportBundleLabel: '主控规划'
                  }
                ]
              }
            ]
          })}
          <ProjectCanvasPage />
        </>
      </ThemeProvider>
    )

    const { data, target: dataTransfer } = createDataTransferMock()
    const draggable = Array.from(document.querySelectorAll('[draggable="true"]')).find((element) =>
      element.textContent?.includes('canvas-target-主控规划.md')
    )

    expect(draggable).toBeTruthy()

    fireEvent.dragStart(draggable as Element, {
      dataTransfer
    })

    const dragPayload = JSON.parse(data.get(QAPP_IMAGE_DRAG_MIME) || '{}')
    expect(dragPayload.attachments?.[0]?.reportBundleId).toBe('bundle-1')
    expect(dragPayload.attachments?.[0]?.reportBundleRole).toBe('primary-report')

    const canvasStage = screen.getByTestId('project-canvas-stage-root')

    fireEvent.dragOver(canvasStage, {
      dataTransfer,
      clientX: 360,
      clientY: 260
    })
    fireEvent.drop(canvasStage, {
      dataTransfer,
      clientX: 360,
      clientY: 260
    })

    await waitFor(() => {
      expect(screen.getByText('canvas-target-主控规划.md')).toBeTruthy()
    })
  })

  it('preserves Hunyuan3D quick app provenance when dragging a canvas 3d model back out', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('canvas:add-model3d', {
          detail: {
            src: 'https://example.com/generated-model.glb',
            fileName: 'generated-model.glb',
            projectId: 'canvas-ocr-test',
            hy3dQuickAppKey: '~builtin/hunyuan3d/texture',
            hy3dParams: {
              apiAction: 'SubmitTextureTo3DJob',
              modelUrl: 'https://example.com/source-model.glb',
              texturePrompt: 'aged bronze'
            },
            hy3dMediaState: {
              conceptImages: [],
              textureRefImages: [
                {
                  type: 'image',
                  url: 'https://example.com/texture-ref.png',
                  fileName: 'texture-ref.png'
                }
              ],
              profileRefImage: null
            }
          }
        })
      )
      await Promise.resolve()
    })

    const dragButton = await waitFor(() =>
      document.querySelector('.blob-item-action-toolbar button[draggable="true"]')
    )

    expect(dragButton).toBeTruthy()

    const { data, target: dataTransfer } = createDataTransferMock()

    fireEvent.dragStart(dragButton as Element, {
      dataTransfer
    })

    const dragPayload = JSON.parse(data.get(QAPP_IMAGE_DRAG_MIME) || '{}')

    expect(dragPayload.itemTypes).toEqual(['model3d'])
    expect(dragPayload.hy3dQuickAppKey).toBe('~builtin/hunyuan3d/texture')
    expect(dragPayload.hy3dParams?.apiAction).toBe('SubmitTextureTo3DJob')
    expect(dragPayload.hy3dParams?.texturePrompt).toBe('aged bronze')
    expect(dragPayload.hy3dMediaState?.textureRefImages?.[0]?.url).toBe(
      'https://example.com/texture-ref.png'
    )
  })
})
