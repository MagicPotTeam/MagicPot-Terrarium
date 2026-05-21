import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'

import { theme } from '@renderer/theme'
import type {
  DesignInspectionApproval,
  DesignInspectionContextPack,
  DesignInspectionExecutionResult,
  DesignInspectionProposal
} from '@shared/designInspection'
import { createDesignInspectionTraceRecord } from './designInspectionTraceStorage'
import { beginGenerationTraceSession } from './generationTraceRuntime'
import { listGenerationTraceRecords } from './generationTraceStorage'

const {
  notifySuccess,
  notifyError,
  notifyWarning,
  notifyInfo,
  closeMessage,
  mockNavigate,
  mockDispatch,
  mockChatCompletion,
  mockLoadCanvasItems,
  mockListTargetSchemes,
  mockListTargetHistoryTargets,
  mockListProfiles,
  mockListQAppCfgs,
  mockSaveCanvasItems,
  mockCropOverlayConfirm,
  mockElectronInvoke
} = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  notifyInfo: vi.fn(),
  closeMessage: vi.fn(),
  mockNavigate: vi.fn(),
  mockDispatch: vi.fn(),
  mockChatCompletion: vi.fn(),
  mockLoadCanvasItems: vi.fn(),
  mockListTargetSchemes: vi.fn(),
  mockListTargetHistoryTargets: vi.fn(),
  mockListProfiles: vi.fn(),
  mockListQAppCfgs: vi.fn(),
  mockSaveCanvasItems: vi.fn(),
  mockCropOverlayConfirm: vi.fn(),
  mockElectronInvoke: vi.fn()
}))

vi.mock('react-konva', async () => {
  const ReactModule = await import('react')

  const getNodeRect = (selector: string) => {
    switch (selector) {
      case '#file-1':
        return { x: 40, y: 40, width: 220, height: 140 }
      case '#file-2':
        return { x: 280, y: 40, width: 220, height: 140 }
      case '#title-1':
        return { x: 40, y: 40, width: 180, height: 48 }
      case '#title-2':
        return { x: 56, y: 112, width: 180, height: 48 }
      case '#title-3':
        return { x: 44, y: 196, width: 180, height: 48 }
      default:
        return null
    }
  }

  const Stage = ReactModule.forwardRef(function MockStage(
    {
      children,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      onMouseLeave
    }: {
      children?: React.ReactNode
      onMouseDown?: (event: {
        evt: MouseEvent
        target: {
          getStage: () => unknown
        }
      }) => void
      onMouseMove?: (event: {
        evt: MouseEvent
        target: {
          getStage: () => unknown
        }
      }) => void
      onMouseUp?: (event: {
        evt: MouseEvent
        target: {
          getStage: () => unknown
        }
      }) => void
      onMouseLeave?: (event: {
        evt: MouseEvent
        target: {
          getStage: () => unknown
        }
      }) => void
    },
    ref: React.ForwardedRef<{
      getStage: () => unknown
      findOne: (selector: string) => unknown
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
    const lastPointerRef = ReactModule.useRef({ x: 0, y: 0 })

    const stageApi = ReactModule.useMemo(() => {
      const api = {
        getStage: () => api,
        findOne: (selector: string) => {
          const rect = getNodeRect(selector)
          if (!rect) return null

          return {
            getClientRect: () => rect,
            x: () => rect.x,
            y: () => rect.y,
            width: () => rect.width,
            height: () => rect.height,
            getLayer: () => ({ batchDraw: () => undefined }),
            toCanvas: () => document.createElement('canvas'),
            toDataURL: () => 'data:image/png;base64,mock-node'
          }
        },
        find: () => [],
        width: (value: number) => value,
        height: (value: number) => value,
        container: () => containerRef.current,
        getPointerPosition: () => lastPointerRef.current,
        getAbsoluteTransform: () => ({
          copy: () => ({
            invert: () => undefined,
            point: (point: { x: number; y: number }) => point
          })
        }),
        hasName: () => false,
        toDataURL: () => 'data:image/png;base64,mock-stage'
      }

      return api
    }, [])

    ReactModule.useImperativeHandle(ref, () => stageApi)

    const updatePointer = (event: React.MouseEvent<HTMLDivElement>) => {
      lastPointerRef.current = {
        x: event.clientX,
        y: event.clientY
      }
    }

    return (
      <div
        data-testid="mock-konva-stage"
        ref={containerRef}
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return
          updatePointer(event)
          onMouseDown?.({
            evt: event.nativeEvent,
            target: stageApi
          })
        }}
        onMouseMove={(event) => {
          if (event.target !== event.currentTarget) return
          updatePointer(event)
          onMouseMove?.({
            evt: event.nativeEvent,
            target: stageApi
          })
        }}
        onMouseUp={(event) => {
          if (event.target !== event.currentTarget) return
          updatePointer(event)
          onMouseUp?.({
            evt: event.nativeEvent,
            target: stageApi
          })
        }}
        onMouseLeave={(event) => {
          if (event.target !== event.currentTarget) return
          updatePointer(event)
          onMouseLeave?.({
            evt: event.nativeEvent,
            target: stageApi
          })
        }}
      >
        {children}
      </div>
    )
  })

  const Transformer = ReactModule.forwardRef(function MockTransformer(
    {
      children,
      shouldOverdrawWholeArea
    }: { children?: React.ReactNode; shouldOverdrawWholeArea?: boolean },
    ref: React.ForwardedRef<{
      nodes: (value: unknown[]) => unknown[]
      getLayer: () => { batchDraw: () => void }
    }>
  ) {
    const transformerApi = ReactModule.useMemo(
      () => ({
        nodes: (value: unknown[]) => value,
        getLayer: () => ({ batchDraw: () => undefined })
      }),
      []
    )

    ReactModule.useImperativeHandle(ref, () => transformerApi)

    return (
      <div
        data-testid="mock-transformer"
        data-overdraw-whole-area={shouldOverdrawWholeArea ? 'true' : 'false'}
      >
        {children}
      </div>
    )
  })

  return {
    Stage,
    Layer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Rect: () => null,
    Image: () => null,
    Transformer,
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
  default: {
    Text: class MockKonvaText {
      private readonly text: string

      private readonly fontSize: number

      private readonly lineHeight: number

      private readonly fixedWidth?: number

      constructor(config: {
        text?: string
        fontSize?: number
        lineHeight?: number
        width?: number
      }) {
        this.text = config.text || ''
        this.fontSize = config.fontSize || 16
        this.lineHeight = config.lineHeight || 1.5
        this.fixedWidth = config.width
      }

      width() {
        return this.fixedWidth ?? Math.max(24, this.text.length * this.fontSize * 0.6)
      }

      height() {
        const width = Math.max(1, this.width())
        const charsPerLine = Math.max(1, Math.floor(width / Math.max(8, this.fontSize * 0.6)))
        const lineCount = Math.max(1, Math.ceil(this.text.length / charsPerLine))
        return lineCount * this.fontSize * this.lineHeight
      }

      destroy() {
        return undefined
      }
    }
  }
}))

vi.mock('react-router-dom', () => ({
  useLocation: () => ({
    search: '?id=canvas-1'
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
            id: 'canvas-1',
            label: 'MagicPot Demo'
          }
        ]
      }
    })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
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
    notifyInfo,
    closeMessage
  })
}))

vi.mock('../../utils/windowUtils', () => ({
  api: () => ({
    svcLLMProxy: {
      chat: mockChatCompletion,
      listProfiles: mockListProfiles
    },
    svcDialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn()
    },
    svcFs: {
      saveImageToPath: vi.fn()
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
      listTargetSchemes: mockListTargetSchemes,
      listTargetHistoryTargets: mockListTargetHistoryTargets,
      saveTargetHistoryTarget: vi.fn()
    }
  })
}))

vi.mock('./canvasStorage', () => ({
  saveCanvasItems: mockSaveCanvasItems,
  loadCanvasItems: mockLoadCanvasItems,
  getProjectCanvasLocation: vi.fn().mockResolvedValue(null),
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
vi.mock('./components/Canvas3DStage', () => ({
  Canvas3DViewerSurface: () => null,
  default: () => null
}))
vi.mock('./components/ProjectCanvasWebGLImageLayer', () => ({
  PROJECT_CANVAS_WEBGL_IMAGE_RESIDENT_LIMIT: 96,
  PROJECT_CANVAS_WEBGL_TEXTURE_BUDGET_BYTES: 256 * 1024 * 1024,
  default: () => null
}))
vi.mock('./components/CanvasItemPlaceholder', () => ({
  default: ({
    item,
    onSelect,
    onDragEnd,
    onTransformEnd,
    onDoubleClick,
    onHoverChange
  }: {
    item: {
      id: string
      type?: string
      x: number
      y: number
      fontSize?: number
      fontFamily?: string
      fontWeight?: 'normal' | 'bold'
      rotation?: number
      scaleX?: number
      scaleY?: number
      ocrBoxId?: string
      label?: string
    }
    onSelect?: (additiveSelection?: boolean) => void
    onDragEnd?: (id: string, x: number, y: number, evt?: unknown) => void
    onTransformEnd?: (
      id: string,
      attrs: { x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number }
    ) => void
    onDoubleClick?: () => void
    onHoverChange?: (isHovering: boolean) => void
  }) =>
    item.type === 'image' ? (
      <div data-testid={`canvas-image-${item.id}`}>
        <button type="button" onClick={(event) => onSelect?.(event.shiftKey)}>
          {`Select ${item.id} x=${item.x} y=${item.y} rotation=${item.rotation ?? 0} scaleX=${item.scaleX ?? 1} scaleY=${item.scaleY ?? 1}`}
        </button>
        <button type="button" onClick={() => onDragEnd?.(item.id, item.x + 32, item.y + 24)}>
          Drag {item.id}
        </button>
        <button
          type="button"
          onClick={() =>
            onTransformEnd?.(item.id, {
              x: item.x + 10,
              y: item.y + 6,
              rotation: (item.rotation ?? 0) + 15,
              scaleX: (item.scaleX ?? 1) * 1.5,
              scaleY: (item.scaleY ?? 1) * 0.75
            })
          }
        >
          Transform {item.id}
        </button>
      </div>
    ) : item.type === 'model3d' ? (
      <div data-testid={`canvas-model3d-${item.id}`}>
        <button type="button" onClick={(event) => onSelect?.(event.shiftKey)}>
          {`Select ${item.id} x=${item.x} y=${item.y} rotation=${item.rotation ?? 0} scaleX=${item.scaleX ?? 1} scaleY=${item.scaleY ?? 1}`}
        </button>
        <button type="button" onClick={() => onDragEnd?.(item.id, item.x + 32, item.y + 24)}>
          Drag {item.id}
        </button>
        <button
          type="button"
          onClick={() =>
            onTransformEnd?.(item.id, {
              x: item.x + 10,
              y: item.y + 6,
              rotation: (item.rotation ?? 0) + 15,
              scaleX: (item.scaleX ?? 1) * 1.5,
              scaleY: (item.scaleY ?? 1) * 0.75
            })
          }
        >
          Transform {item.id}
        </button>
      </div>
    ) : item.type === 'file' ? (
      <div data-testid={`canvas-file-${item.id}`}>
        <button
          type="button"
          onClick={(event) => onSelect?.(event.shiftKey)}
          onDoubleClick={onDoubleClick}
        >
          Select {item.id}
        </button>
      </div>
    ) : item.type === 'text' ? (
      <div data-testid={`canvas-text-${item.id}`}>
        <button
          type="button"
          onClick={(event) => onSelect?.(event.shiftKey)}
          onDoubleClick={onDoubleClick}
        >
          {`Select ${item.id} x=${item.x} y=${item.y} font=${item.fontSize ?? 0} family=${item.fontFamily ?? ''} weight=${item.fontWeight ?? 'normal'}`}
        </button>
      </div>
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
vi.mock('./components/HtmlOverlay', () => ({ default: () => null }))
vi.mock('./components/Model3DViewerDialog', () => ({ default: () => null }))
vi.mock('./components/ProjectCanvasImageCropOverlay', async () => {
  const ReactModule = await import('react')

  return {
    default: ReactModule.forwardRef(function MockCanvasCropOverlay(
      {
        item,
        onConfirm
      }: {
        item: {
          id: string
          x: number
          y: number
          width: number
          height: number
          scaleX: number
          scaleY: number
          sourceWidth?: number
          sourceHeight?: number
        }
        onConfirm: (updates: {
          x: number
          y: number
          width: number
          height: number
          scaleX: number
          scaleY: number
          crop: { x: number; y: number; width: number; height: number }
        }) => void
      },
      ref: React.ForwardedRef<{ confirm: () => void }>
    ) {
      ReactModule.useImperativeHandle(
        ref,
        () => ({
          confirm: () => {
            const nextWidth = Math.max(40, item.width - 32)
            const nextHeight = Math.max(40, item.height - 24)
            mockCropOverlayConfirm()
            onConfirm({
              x: item.x + 12,
              y: item.y + 8,
              width: nextWidth,
              height: nextHeight,
              scaleX: item.scaleX * 1.15,
              scaleY: item.scaleY * 1.1,
              crop: {
                x: 10,
                y: 6,
                width: Math.max(1, (item.sourceWidth || item.width) - 20),
                height: Math.max(1, (item.sourceHeight || item.height) - 16)
              }
            })
          }
        }),
        [item, onConfirm]
      )

      return <div data-testid="mock-crop-overlay">{`Crop ${item.id}`}</div>
    })
  }
})
vi.mock('./components/ProjectCanvasImageInteractionOverlay', () => ({
  default: ({
    item,
    onSelect,
    onDragEnd,
    onTransformEnd
  }: {
    item: { id: string; x: number; y: number; rotation?: number; scaleX?: number; scaleY?: number }
    onSelect?: (additiveSelection?: boolean) => void
    onDragEnd?: (id: string, x: number, y: number, evt?: unknown) => void
    onTransformEnd?: (
      id: string,
      attrs: { x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number }
    ) => void
  }) => (
    <div data-testid={`canvas-image-${item.id}`}>
      <button onClick={(event) => onSelect?.(event.shiftKey)}>
        {`Select ${item.id} x=${item.x} y=${item.y} rotation=${item.rotation ?? 0} scaleX=${item.scaleX ?? 1} scaleY=${item.scaleY ?? 1}`}
      </button>
      <button onClick={() => onDragEnd?.(item.id, item.x + 32, item.y + 24)}>Drag {item.id}</button>
      <button
        onClick={() =>
          onTransformEnd?.(item.id, {
            x: item.x + 10,
            y: item.y + 6,
            rotation: (item.rotation ?? 0) + 15,
            scaleX: (item.scaleX ?? 1) * 1.5,
            scaleY: (item.scaleY ?? 1) * 0.75
          })
        }
      >
        Transform {item.id}
      </button>
    </div>
  )
}))
vi.mock('./components/ProjectCanvasMultiSelectionTransformOverlay', () => ({
  default: ({ items }: { items: Array<{ id: string }> }) => (
    <div
      data-testid="mock-multi-selection-transform-overlay"
      data-item-ids={items.map((item) => item.id).join(',')}
    />
  )
}))
vi.mock('./ProjectCanvasPageSelectionOverlays', () => ({
  default: ({
    tool,
    selectedIds,
    items,
    handleCropImage,
    handleGenerateCanvasItems
  }: {
    tool: string
    selectedIds: Set<string>
    items: Array<{ id: string; type: string }>
    handleCropImage: (item: { id: string; type: 'image' }) => void
    handleGenerateCanvasItems: (items: Array<{ id: string; type: string }>) => void
  }) => {
    const selectedItems = items.filter((item) => selectedIds.has(item.id))
    const selectedImage = items.find(
      (item): item is { id: string; type: 'image' } =>
        item.type === 'image' && selectedIds.has(item.id)
    )

    return (
      <>
        {selectedItems.length > 1 && (
          <button type="button" onClick={() => handleGenerateCanvasItems(selectedItems)}>
            Generate From Selection
          </button>
        )}
        {selectedImage && (
          <button type="button" onClick={() => handleCropImage(selectedImage)}>
            Crop Selected Image
          </button>
        )}
      </>
    )
  }
}))
vi.mock('./components/CanvasTextNode', () => ({
  default: ({
    item,
    onSelect
  }: {
    item: {
      id: string
      x: number
      y: number
      fontSize: number
      fontFamily: string
      fontWeight: 'normal' | 'bold'
    }
    onSelect: (additiveSelection?: boolean) => void
  }) => (
    <div role="button" onClick={(event) => onSelect(event.shiftKey)}>
      {`Select ${item.id} x=${item.x} y=${item.y} font=${item.fontSize} family=${item.fontFamily} weight=${item.fontWeight}`}
    </div>
  )
}))
vi.mock('./components/CanvasFileNode', () => ({
  default: ({
    item,
    onSelect,
    onDoubleClick
  }: {
    item: { id: string }
    onSelect: (additiveSelection?: boolean) => void
    onDoubleClick?: () => void
  }) => (
    <div role="button" onClick={(event) => onSelect(event.shiftKey)} onDoubleClick={onDoubleClick}>
      Select {item.id}
    </div>
  )
}))
vi.mock('./components/GroupPlaybackOverlay', () => ({ default: () => null }))
vi.mock('./Dialogs/LabelEditorDialog', () => ({ LabelEditorDialog: () => null }))
vi.mock('./Dialogs/ClearConfirmDialog', () => ({
  ClearConfirmDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Clear canvas dialog</div> : null
}))
vi.mock('./Dialogs/TextureImportDialog', () => ({ TextureImportDialog: () => null }))
vi.mock('./components/CanvasAnnotationNode', () => ({ default: () => null }))
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
vi.mock('./components/CanvasSelectionActionToolbar', () => ({
  default: ({
    selectedItems,
    onGenerateSelectedItems
  }: {
    selectedItems: Array<{ id: string }>
    onGenerateSelectedItems: (items: Array<{ id: string }>) => void
  }) => (
    <>
      <button onClick={() => onGenerateSelectedItems(selectedItems)}>
        Generate From Selection
      </button>
    </>
  )
}))
vi.mock('@renderer/utils/droppedImageUtils', () => ({
  AGENT_IMAGE_DRAG_MIME: 'application/x-ai-image',
  getDroppedImageFile: vi.fn(),
  parseInternalImageDragPayload: vi.fn(() => null)
}))

import ProjectCanvasPage from './ProjectCanvasPage'

function createFileItem(
  id: string,
  x: number
): {
  id: string
  type: 'file'
  src: string
  fileName: string
  mimeType: string
  fileKind: 'markdown'
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scaleX: number
  scaleY: number
  zIndex: number
  locked: boolean
  editable: boolean
  sizeBytes: number
  previewText: string
  content: string
} {
  return {
    id,
    type: 'file',
    src: `file:///C:/magicpot/${id}.md`,
    fileName: `${id}.md`,
    mimeType: 'text/markdown',
    fileKind: 'markdown',
    x,
    y: 40,
    width: 220,
    height: 140,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    editable: true,
    sizeBytes: 128,
    previewText: `Preview for ${id}`,
    content: `Content for ${id}`
  }
}

function createOfficeFileItem(
  id: string,
  overrides: Partial<{
    fileName: string
    mimeType: string
    fileKind: 'word' | 'excel' | 'powerpoint'
    previewText: string
    previewImages: Array<{ id: string; src: string; mimeType: string; fileName: string }>
  }> = {}
): {
  id: string
  type: 'file'
  src: string
  fileName: string
  mimeType: string
  fileKind: 'word' | 'excel' | 'powerpoint'
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scaleX: number
  scaleY: number
  zIndex: number
  locked: boolean
  editable: false
  sizeBytes: number
  previewText: string
  previewImages?: Array<{ id: string; src: string; mimeType: string; fileName: string }>
} {
  return {
    id,
    type: 'file',
    src: `blob:${id}`,
    fileName: 'brief.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileKind: 'word',
    x: 40,
    y: 40,
    width: 220,
    height: 140,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    editable: false,
    sizeBytes: 128,
    previewText: 'Short card preview',
    ...overrides
  }
}

function createTextItem(
  id: string,
  overrides: Partial<{
    text: string
    fontSize: number
    fontFamily: string
    fontWeight: 'normal' | 'bold'
    fill: string
    x: number
    y: number
    width: number
    height: number
  }> = {}
): {
  id: string
  type: 'text'
  text: string
  fontSize: number
  fontFamily: string
  fontWeight: 'normal' | 'bold'
  fill: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scaleX: number
  scaleY: number
  zIndex: number
  locked: boolean
} {
  return {
    id,
    type: 'text',
    text: `Text ${id}`,
    fontSize: 24,
    fontFamily: 'Inter',
    fontWeight: 'bold',
    fill: '#111111',
    x: 40,
    y: 40,
    width: 180,
    height: 48,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createImageItem(
  id: string,
  x: number,
  fileName: string
): {
  id: string
  type: 'image'
  src: string
  fileName: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scaleX: number
  scaleY: number
  zIndex: number
  locked: boolean
} {
  return {
    id,
    type: 'image',
    src: `file:///C:/magicpot/${fileName}`,
    fileName,
    x,
    y: 40,
    width: 160,
    height: 160,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createModel3DItem(
  id: string,
  x: number,
  fileName: string
): {
  id: string
  type: 'model3d'
  src: string
  fileName: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scaleX: number
  scaleY: number
  zIndex: number
  locked: boolean
} {
  return {
    id,
    type: 'model3d',
    src: `file:///C:/magicpot/${fileName}`,
    fileName,
    x,
    y: 40,
    width: 240,
    height: 240,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createAttachedCaptionItem(
  id: string,
  attachedToId: string,
  text: string
): {
  id: string
  type: 'annotation'
  shape: 'text-anno'
  stroke: string
  fillOpacity: number
  strokeWidth: number
  label: string
  text: string
  fontSize: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  scaleX: number
  scaleY: number
  zIndex: number
  locked: boolean
  attachedToId: string
  attachmentPlacement: 'bottom-center'
} {
  return {
    id,
    type: 'annotation',
    shape: 'text-anno',
    stroke: '#ffffff',
    fillOpacity: 0,
    strokeWidth: 1,
    label: '',
    text,
    fontSize: 20,
    x: 0,
    y: 0,
    width: 120,
    height: 32,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false,
    attachedToId,
    attachmentPlacement: 'bottom-center'
  }
}

function shiftClick(element: HTMLElement) {
  fireEvent.click(element, { shiftKey: true })
}

function createContextPack(): DesignInspectionContextPack {
  return {
    id: 'context-1',
    createdAt: '2026-03-27T15:40:00.000Z',
    task: 'Inspect the selected cards and keep only the approved spacing fix.',
    projectId: 'canvas-1',
    projectName: 'MagicPot Demo',
    structureFirst: true,
    selection: {
      itemIds: ['file-1', 'file-2'],
      groupIds: [],
      bounds: { x: 40, y: 40, width: 460, height: 140 }
    },
    selectionItems: [],
    canvasSnapshot: null,
    documents: [],
    references: [],
    rules: [],
    fallbackSignals: []
  }
}

function createProposal(): DesignInspectionProposal {
  return {
    id: 'proposal-1',
    contextPackId: 'context-1',
    generatedAt: '2026-03-27T15:41:00.000Z',
    summary: '\u5df2\u5e94\u7528 1 \u9879\u6279\u51c6\u7684\u4fee\u6b63\u3002',
    issues: [],
    actions: [
      {
        id: 'action-1',
        type: 'align-left',
        title: 'Align the second card',
        description: 'Move the second card onto the shared left edge.',
        executor: 'magicpot-internal',
        targetItemIds: ['file-2'],
        payload: { x: 40 },
        expectedImpact: 'The cards read as one aligned stack.'
      }
    ],
    rationale: 'Use geometry-first validation.',
    expectedResult: 'The second card aligns with the first.',
    executionPlan: [
      {
        step: 1,
        executor: 'magicpot-internal',
        actionIds: ['action-1'],
        description: 'Align the second card.'
      }
    ]
  }
}

function createApproval(): DesignInspectionApproval {
  return {
    id: 'approval-1',
    contextPackId: 'context-1',
    proposalId: 'proposal-1',
    status: 'approved',
    approvedActions: ['action-1'],
    userNotes: 'Keep the approved alignment fix.',
    createdAt: '2026-03-27T15:42:00.000Z',
    updatedAt: '2026-03-27T15:43:00.000Z'
  }
}

function createExecutionResult(): DesignInspectionExecutionResult {
  return {
    id: 'execution-1',
    contextPackId: 'context-1',
    proposalId: 'proposal-1',
    approvalId: 'approval-1',
    status: 'success',
    executor: 'magicpot-internal',
    appliedChanges: [],
    artifacts: [],
    trace: []
  }
}

function readTraceRecords(): Array<Record<string, unknown>> {
  return JSON.parse(localStorage.getItem('canvas.designInspectionTrace.canvas-1') ?? '[]')
}

describe('ProjectCanvasPage generation-first entry', () => {
  beforeEach(() => {
    localStorage.clear()
    class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      naturalWidth = 320
      naturalHeight = 240
      width = 320
      height = 240
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
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn()
    })
    notifySuccess.mockReset()
    notifyError.mockReset()
    notifyWarning.mockReset()
    notifyInfo.mockReset()
    closeMessage.mockReset()
    mockCropOverlayConfirm.mockReset()
    mockDispatch.mockReset()
    mockChatCompletion.mockReset()
    mockChatCompletion.mockResolvedValue(undefined)
    mockSaveCanvasItems.mockReset()
    mockSaveCanvasItems.mockResolvedValue(undefined)
    mockElectronInvoke.mockReset()
    mockElectronInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'screenshot:getShortcut') {
        return { success: true, shortcut: '`' }
      }
      return { success: true }
    })
    Object.defineProperty(window, 'electron', {
      configurable: true,
      writable: true,
      value: {
        ipcRenderer: {
          invoke: mockElectronInvoke
        }
      }
    })
    mockLoadCanvasItems.mockResolvedValue({
      items: [createFileItem('file-1', 40), createFileItem('file-2', 280)],
      groups: []
    })
    mockListProfiles.mockReset()
    mockListProfiles.mockResolvedValue({
      profiles: []
    })
    mockListTargetSchemes.mockReset()
    mockListTargetSchemes.mockResolvedValue({
      schemes: []
    })
    mockListTargetHistoryTargets.mockReset()
    mockListTargetHistoryTargets.mockResolvedValue({
      targets: []
    })
    mockListQAppCfgs.mockResolvedValue({
      qApps: []
    })

    const contextPack = createContextPack()
    const proposal = createProposal()
    const approval = createApproval()
    const executionResult = createExecutionResult()

    const record = createDesignInspectionTraceRecord({
      sessionId: 'session-1',
      contextPack,
      proposal,
      approval,
      executionResult,
      selectedActionIds: ['action-1'],
      notes: approval.userNotes
    })
    localStorage.setItem('canvas.designInspectionTrace.canvas-1', JSON.stringify([record]))
  })

  it('does not expose a standalone inspection history button in the page chrome', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    await screen.findByRole('button', { name: 'Select file-1' })

    expect(screen.queryByRole('button', { name: /\u68c0\u67e5\u8bb0\u5f55/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review History' })).toBeNull()
  })

  it('does not open the clear-canvas dialog when selecting an element', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    const firstFileButton = await screen.findByRole('button', { name: 'Select file-1' })
    fireEvent.click(firstFileButton)

    expect(screen.queryByRole('dialog', { name: 'Clear canvas dialog' })).toBeNull()
    expect(screen.queryByText('Clear canvas dialog')).toBeNull()
  })

  it('moves focus from an external input back to the canvas when the stage is pressed', async () => {
    const externalInput = document.createElement('textarea')
    document.body.appendChild(externalInput)
    externalInput.focus()

    try {
      render(
        <ThemeProvider theme={theme}>
          <ProjectCanvasPage />
        </ThemeProvider>
      )

      const stage = await screen.findByTestId('project-canvas-stage-root')

      expect(document.activeElement).toBe(externalInput)

      fireEvent.mouseDown(stage)

      await waitFor(() => {
        expect(document.activeElement).not.toBe(externalInput)
      })
    } finally {
      externalInput.remove()
    }
  })

  it('enables Ctrl+A after selecting an element even when focus started in another input', async () => {
    const externalInput = document.createElement('textarea')
    document.body.appendChild(externalInput)
    externalInput.focus()

    try {
      render(
        <ThemeProvider theme={theme}>
          <ProjectCanvasPage />
        </ThemeProvider>
      )

      const firstFileButton = await screen.findByRole('button', { name: 'Select file-1' })
      fireEvent.mouseDown(firstFileButton)
      fireEvent.click(firstFileButton)

      await waitFor(() => {
        expect(document.activeElement).not.toBe(externalInput)
      })

      fireEvent.keyDown(window, { key: 'a', ctrlKey: true })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Generate From Selection' })).toBeInTheDocument()
      })
    } finally {
      externalInput.remove()
    }
  })

  it('resets a conflicting screenshot shortcut so Ctrl+S remains available for canvas save', async () => {
    mockElectronInvoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'screenshot:getShortcut') {
        return { success: true, shortcut: 'CommandOrControl+S' }
      }
      if (channel === 'screenshot:setShortcut') {
        return { success: true, args }
      }
      return { success: true }
    })

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    await screen.findByRole('button', { name: 'Select file-1' })

    await waitFor(() => {
      expect(mockElectronInvoke).toHaveBeenCalledWith('screenshot:getShortcut')
      expect(mockElectronInvoke).toHaveBeenCalledWith(
        'screenshot:setShortcut',
        '`',
        expect.arrayContaining(['Ctrl+S'])
      )
    })

    expect(notifyWarning).toHaveBeenCalledWith(
      expect.stringContaining('截图快捷键 Ctrl+S 与画布快捷键冲突')
    )
  })

  it('deletes the selected element when Delete is pressed', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    const firstFileButton = await screen.findByRole('button', { name: 'Select file-1' })
    fireEvent.mouseDown(firstFileButton)
    fireEvent.click(firstFileButton)

    mockSaveCanvasItems.mockClear()
    fireEvent.keyDown(window, { key: 'Delete', code: 'Delete' })

    await waitFor(() => {
      expect(mockSaveCanvasItems).toHaveBeenCalled()
    })

    const [savedItems, savedCanvasId] = mockSaveCanvasItems.mock.calls.at(-1) ?? []
    expect(savedCanvasId).toBe('canvas-1')
    expect((savedItems ?? []).map((item: { id: string }) => item.id)).toEqual(['file-2'])
    expect(screen.queryByRole('button', { name: 'Select file-1' })).toBeNull()
  })

  it('restores a deleted element when Ctrl+Z is pressed', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    const firstFileButton = await screen.findByRole('button', { name: 'Select file-1' })
    fireEvent.mouseDown(firstFileButton)
    fireEvent.click(firstFileButton)

    mockSaveCanvasItems.mockClear()
    fireEvent.keyDown(window, { key: 'Delete', code: 'Delete' })

    await waitFor(() => {
      expect(mockSaveCanvasItems).toHaveBeenCalled()
    })

    let savedItems = mockSaveCanvasItems.mock.calls.at(-1)?.[0] as Array<{ id: string }> | undefined
    expect((savedItems ?? []).map((item) => item.id)).toEqual(['file-2'])

    mockSaveCanvasItems.mockClear()
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true })

    await waitFor(() => {
      expect(mockSaveCanvasItems).toHaveBeenCalled()
    })

    savedItems = mockSaveCanvasItems.mock.calls.at(-1)?.[0] as Array<{ id: string }> | undefined
    expect((savedItems ?? []).map((item) => item.id).sort()).toEqual(['file-1', 'file-2'])
  })

  it('keeps split 3D items on the canvas when Ctrl+Z undoes a drag', async () => {
    mockLoadCanvasItems.mockResolvedValueOnce({
      items: [],
      groups: [],
      figmaBinding: null
    })

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    act(() => {
      window.dispatchEvent(
        new CustomEvent('canvas:add-model3d', {
          detail: {
            src: 'https://example.com/split-a.fbx',
            fileName: 'split-a.fbx',
            projectId: 'canvas-1',
            select: false,
            offsetX: -140,
            width: 240,
            height: 240
          }
        })
      )
      window.dispatchEvent(
        new CustomEvent('canvas:add-model3d', {
          detail: {
            src: 'https://example.com/split-b.fbx',
            fileName: 'split-b.fbx',
            projectId: 'canvas-1',
            select: true,
            offsetX: 140,
            width: 240,
            height: 240
          }
        })
      )
    })

    const dragButtons = await screen.findAllByRole('button', { name: /Drag model-/ })
    expect(
      screen.getByRole('button', {
        name: /Select model-.* x=140 y=180 rotation=0 scaleX=1 scaleY=1/
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /Select model-.* x=420 y=180 rotation=0 scaleX=1 scaleY=1/
      })
    ).toBeInTheDocument()

    fireEvent.click(dragButtons[0])

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: /Select model-.* x=172 y=204 rotation=0 scaleX=1 scaleY=1/
        })
      ).toBeInTheDocument()
    })

    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true })

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: /Select model-.* x=140 y=180 rotation=0 scaleX=1 scaleY=1/
        })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', {
          name: /Select model-.* x=420 y=180 rotation=0 scaleX=1 scaleY=1/
        })
      ).toBeInTheDocument()
    })
  })

  it('shows generation entry for multi-selection instead of inspection actions', async () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    const firstFileButton = await screen.findByRole('button', { name: 'Select file-1' })
    const secondFileButton = await screen.findByRole('button', { name: 'Select file-2' })

    expect(mockLoadCanvasItems).toHaveBeenCalledWith('canvas-1')
    expect(container.querySelector('[data-testid="project-canvas-stage-root"]')).not.toBeNull()

    fireEvent.click(firstFileButton)
    shiftClick(secondFileButton)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate From Selection' })).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: 'Inspect Selection' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review History' })).toBeNull()
  })

  it('renders the DOM multi-selection transform overlay for multi-selection', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    const firstFileButton = await screen.findByRole('button', { name: 'Select file-1' })
    const secondFileButton = await screen.findByRole('button', { name: 'Select file-2' })

    fireEvent.click(firstFileButton)
    shiftClick(secondFileButton)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate From Selection' })).toBeInTheDocument()
    })

    expect(screen.getByTestId('mock-multi-selection-transform-overlay')).toHaveAttribute(
      'data-item-ids',
      'file-1,file-2'
    )
  })

  it('renders a marquee selection rect during drag and applies the selection on mouseup', async () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    const stageRoot = await screen.findByTestId('project-canvas-stage-root')
    Object.defineProperty(stageRoot, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 600,
        width: 1000,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })
    })

    const stageEventLayer = container.querySelector(
      '[data-project-canvas-stage-event-layer="dom"]'
    ) as HTMLElement | null
    expect(stageEventLayer).not.toBeNull()

    fireEvent.mouseDown(stageEventLayer!, {
      button: 0,
      clientX: 20,
      clientY: 20
    })
    fireEvent.mouseMove(stageEventLayer!, {
      buttons: 1,
      clientX: 540,
      clientY: 220
    })

    await waitFor(() => {
      const selectionRect = container.querySelector(
        '[data-canvas-selection-rect="svg"]'
      ) as SVGSVGElement | null
      expect(selectionRect).not.toBeNull()
      expect(selectionRect?.style.display).not.toBe('none')
      expect(selectionRect?.getAttribute('width')).toBe('520')
      expect(selectionRect?.getAttribute('height')).toBe('200')
    })

    fireEvent.mouseUp(stageEventLayer!, {
      button: 0,
      clientX: 540,
      clientY: 220
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate From Selection' })).toBeInTheDocument()
    })
  })

  it('updates image item coordinates when the page consumes an image drag result', async () => {
    mockLoadCanvasItems.mockResolvedValueOnce({
      items: [createImageItem('image-1', 80, 'drag-target.png')],
      groups: []
    })

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Select image-1 x=80 y=40 rotation=0 scaleX=1 scaleY=1'
      })
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Drag image-1' }))

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Select image-1 x=112 y=64 rotation=0 scaleX=1 scaleY=1'
        })
      ).toBeInTheDocument()
    })
  })

  it('updates image transform values when the page consumes an image transform result', async () => {
    mockLoadCanvasItems.mockResolvedValueOnce({
      items: [createImageItem('image-1', 80, 'transform-target.png')],
      groups: []
    })

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Select image-1 x=80 y=40 rotation=0 scaleX=1 scaleY=1'
      })
    )
    mockSaveCanvasItems.mockClear()
    fireEvent.click(await screen.findByRole('button', { name: 'Transform image-1' }))

    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Select image-1 x=90 y=46 rotation=15 scaleX=1.5 scaleY=0.75'
        })
      ).toBeInTheDocument()
    })

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await Promise.resolve()
    })

    await waitFor(() => {
      const [savedItems] = mockSaveCanvasItems.mock.calls.at(-1) ?? []
      expect(savedItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'image-1',
            x: 90,
            y: 46,
            rotation: 15,
            scaleX: 1.5,
            scaleY: 0.75
          })
        ])
      )
    })

    const [savedItems, savedCanvasId] = mockSaveCanvasItems.mock.calls.at(-1) ?? []
    expect(savedCanvasId).toBe('canvas-1')
    expect(savedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'image-1',
          x: 90,
          y: 46,
          rotation: 15,
          scaleX: 1.5,
          scaleY: 0.75
        })
      ])
    )
  })

  it('restores persisted image transform values when loading a transformed canvas item', async () => {
    mockLoadCanvasItems.mockResolvedValueOnce({
      items: [
        {
          ...createImageItem('image-1', 80, 'transform-restored.png'),
          x: 90,
          y: 46,
          rotation: 15,
          scaleX: 1.5,
          scaleY: 0.75
        }
      ],
      groups: []
    })

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    expect(
      await screen.findByRole('button', {
        name: 'Select image-1 x=90 y=46 rotation=15 scaleX=1.5 scaleY=0.75'
      })
    ).toBeInTheDocument()
  })

  it('switches from multi-selection back to a single crop target and only saves that image', async () => {
    mockLoadCanvasItems.mockResolvedValueOnce({
      items: [
        createImageItem('image-1', 80, 'crop-target.png'),
        createImageItem('image-2', 280, 'crop-peer.png')
      ],
      groups: []
    })

    const { container } = render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Select image-1 x=80 y=40 rotation=0 scaleX=1 scaleY=1'
      })
    )
    shiftClick(
      await screen.findByRole('button', {
        name: 'Select image-2 x=280 y=40 rotation=0 scaleX=1 scaleY=1'
      })
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Generate From Selection' })).toBeInTheDocument()
    })

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Select image-1 x=80 y=40 rotation=0 scaleX=1 scaleY=1'
      })
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Crop Selected Image' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Generate From Selection' })).toBeNull()
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Crop Selected Image' }))

    await waitFor(() => {
      expect(screen.getByTestId('mock-crop-overlay')).toBeInTheDocument()
    })

    const stageEventLayer = container.querySelector(
      '[data-project-canvas-stage-event-layer="dom"]'
    ) as HTMLElement | null
    expect(stageEventLayer).not.toBeNull()

    fireEvent.mouseDown(stageEventLayer!)

    await waitFor(() => {
      expect(mockCropOverlayConfirm).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('mock-crop-overlay')).toBeNull()
    })

    mockSaveCanvasItems.mockClear()

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockSaveCanvasItems).toHaveBeenCalled()
    })

    const [savedItems, savedCanvasId] = mockSaveCanvasItems.mock.calls.at(-1) ?? []
    expect(savedCanvasId).toBe('canvas-1')
    expect(savedItems).toHaveLength(2)

    const savedTargetImage = savedItems.find((item) => item.id === 'image-1')
    const savedPeerImage = savedItems.find((item) => item.id === 'image-2')

    expect(savedTargetImage).toEqual(
      expect.objectContaining({
        id: 'image-1',
        x: 92,
        y: 48,
        width: 128,
        height: 136,
        scaleX: 1.15,
        scaleY: 1.1,
        src: 'data:image/png;base64,mock-canvas',
        fileName: 'crop-target.png',
        sourceWidth: 300,
        sourceHeight: 224
      })
    )
    expect(savedTargetImage).not.toHaveProperty('crop')
    expect(savedPeerImage).toEqual(
      expect.objectContaining({
        id: 'image-2',
        x: 280,
        y: 40,
        width: 160,
        height: 160,
        scaleX: 1,
        scaleY: 1
      })
    )
    expect(savedPeerImage).not.toHaveProperty('crop')
    expect(savedItems.filter((item) => item.id === 'image-1')).toHaveLength(1)
    expect(savedItems.filter((item) => item.id === 'image-2')).toHaveLength(1)
  })

  it('opens a generation task-pack dialog before sending selected items', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    const firstFileButton = await screen.findByRole('button', { name: 'Select file-1' })
    const secondFileButton = await screen.findByRole('button', { name: 'Select file-2' })

    fireEvent.click(firstFileButton)
    shiftClick(secondFileButton)

    fireEvent.click(await screen.findByRole('button', { name: 'Generate From Selection' }))

    expect(await screen.findByText(/出图任务/)).toBeInTheDocument()
    expect(screen.getByText(/默认直接发送给默认 Agent/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送给 默认 Agent 生成候选图' })).toBeInTheDocument()
  })

  it('flushes pending canvas edits when the window loses focus', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    await screen.findByRole('button', { name: 'Select file-1' })

    mockSaveCanvasItems.mockClear()

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('canvas:add-image', {
          detail: {
            src: 'data:image/png;base64,cGVuZGluZy1jYW5kaWRhdGU=',
            fileName: 'pending-candidate.png',
            projectId: 'canvas-1',
            select: false
          }
        })
      )
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Select / })).toHaveLength(3)
    })

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockSaveCanvasItems).toHaveBeenCalled()
    })

    const [savedItems, savedCanvasId] = mockSaveCanvasItems.mock.calls.at(-1) ?? []
    expect(savedCanvasId).toBe('canvas-1')
    expect(savedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image',
          fileName: 'pending-candidate.png'
        })
      ])
    )
  })

  it('seeds the Agent conversation with the current canvas-target request when a check starts', async () => {
    mockListProfiles.mockResolvedValue({
      profiles: [
        {
          id: 'gemma',
          model_name: 'gemma',
          is_vision_model: true
        }
      ]
    })
    mockListTargetSchemes.mockResolvedValue({
      schemes: [
        {
          id: 'scheme-1',
          name: '未命名目标方案',
          description: '',
          enabled: true,
          files: [
            {
              id: 'rule-1',
              name: 'target-1.md',
              content: 'Rule 1'
            },
            {
              id: 'rule-2',
              name: 'check-2.md',
              content: 'Rule 2'
            }
          ],
          createdAt: '2026-04-07T00:00:00.000Z',
          updatedAt: '2026-04-07T00:00:00.000Z'
        }
      ]
    })

    const chatNewSessionEvents: Array<
      CustomEvent<{
        scope?: string
        initialMessage?: string
        initialMessages?: Array<{
          role?: string
          content?: string
        }>
      }>
    > = []

    const handleScopeReady = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: string; requestId?: string }>).detail
      window.dispatchEvent(new CustomEvent('chat:scope-ready', { detail }))
    }
    const handleCreatePane = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; requestId?: string }>).detail
      window.dispatchEvent(
        new CustomEvent('agent-workspace:pane-created', {
          detail: {
            projectId: detail?.projectId,
            paneId: 'agent-1',
            scope: 'canvas-1.agent-1',
            requestId: detail?.requestId
          }
        })
      )
    }
    const handleNewSession = (event: Event) => {
      const customEvent = event as CustomEvent<{
        scope?: string
        requestId?: string
        initialMessage?: string
        initialMessages?: Array<{
          role?: string
          content?: string
        }>
      }>
      chatNewSessionEvents.push(customEvent)
      window.dispatchEvent(
        new CustomEvent('chat:session-created', {
          detail: {
            scope: customEvent.detail?.scope,
            sessionId: 'session-1',
            requestId: customEvent.detail?.requestId
          }
        })
      )
    }

    window.addEventListener('chat:ping-scope-ready', handleScopeReady)
    window.addEventListener('agent-workspace:create-pane', handleCreatePane)
    window.addEventListener('chat:newSession', handleNewSession)

    try {
      render(
        <ThemeProvider theme={theme}>
          <ProjectCanvasPage />
        </ThemeProvider>
      )

      const firstFileButton = await screen.findByRole('button', { name: 'Select file-1' })
      const secondFileButton = await screen.findByRole('button', { name: 'Select file-2' })

      fireEvent.click(firstFileButton)
      shiftClick(secondFileButton)

      window.dispatchEvent(
        new CustomEvent('canvas:run-check-request', {
          detail: {
            canvasId: 'canvas-1'
          }
        })
      )

      await waitFor(() => {
        expect(notifyInfo).toHaveBeenCalled()
      })

      const canvasTargetDialog = await screen.findByRole('dialog')
      const canvasTargetTextboxes = await within(canvasTargetDialog).findAllByRole('textbox')
      const canvasTargetIntentInput = canvasTargetTextboxes.find((textbox) =>
        textbox.hasAttribute('required')
      )

      expect(canvasTargetIntentInput).toBeTruthy()
      if (!canvasTargetIntentInput) {
        throw new Error('Canvas check intent input was not found.')
      }

      fireEvent.change(canvasTargetIntentInput, {
        target: {
          value: '检查角色主体是否缺失'
        }
      })
      fireEvent.click(within(canvasTargetDialog).getByRole('button', { name: '开始执行' }))

      await waitFor(
        () => {
          expect(chatNewSessionEvents.length).toBeGreaterThan(0)
        },
        { timeout: 10000 }
      )

      const lastSessionEvent = chatNewSessionEvents.at(-1)
      expect(lastSessionEvent?.detail.initialMessage).toBeUndefined()
      expect(lastSessionEvent?.detail.initialMessages).toEqual([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('本次执行内容：\n检查角色主体是否缺失')
        })
      ])
    } finally {
      window.removeEventListener('chat:ping-scope-ready', handleScopeReady)
      window.removeEventListener('agent-workspace:create-pane', handleCreatePane)
      window.removeEventListener('chat:newSession', handleNewSession)
    }
  }, 15000)

  it('sends a condensed generation prompt without controller chatter or legacy completion hints', async () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')

    mockLoadCanvasItems.mockResolvedValueOnce({
      items: [
        createFileItem('file-1', 40),
        createFileItem('file-2', 280),
        createTextItem('note-1', {
          text: '制作要求：需要制作一个服装偏向流浪汉的男性角色'
        }),
        createAttachedCaptionItem('caption-file-2', 'file-2', '这里缺少 LV2')
      ],
      groups: [
        {
          id: 'group-1',
          name: '组合一',
          itemIds: ['file-1', 'file-2'],
          createdAt: '2026-03-28T00:00:00.000Z'
        }
      ]
    })

    try {
      render(
        <ThemeProvider theme={theme}>
          <ProjectCanvasPage />
        </ThemeProvider>
      )

      const firstFileButton = await screen.findByRole('button', { name: 'Select file-1' })
      const secondFileButton = await screen.findByRole('button', { name: 'Select file-2' })
      const noteButton = await screen.findByRole('button', { name: /Select note-1/ })

      fireEvent.click(firstFileButton)
      shiftClick(secondFileButton)
      shiftClick(noteButton)

      fireEvent.click(await screen.findByRole('button', { name: 'Generate From Selection' }))
      fireEvent.click(await screen.findByRole('button', { name: '发送给 默认 Agent 生成候选图' }))

      await waitFor(
        () => {
          const promptEvents = dispatchEventSpy.mock.calls
            .map(([event]) => event as CustomEvent<{ text?: string; hiddenText?: string }>)
            .filter(
              (event) =>
                event.type === 'send-to-agent' &&
                (Boolean(event.detail?.text) || Boolean(event.detail?.hiddenText))
            )

          expect(promptEvents.length).toBeGreaterThan(0)
        },
        { timeout: 10000 }
      )

      const finalPrompt = dispatchEventSpy.mock.calls
        .map(([event]) => event as CustomEvent<{ text?: string; hiddenText?: string }>)
        .filter(
          (event) =>
            event.type === 'send-to-agent' &&
            (Boolean(event.detail?.text) || Boolean(event.detail?.hiddenText))
        )
        .map((event) => event.detail?.text || event.detail?.hiddenText)
        .filter((text): text is string => Boolean(text))
        .at(-1)

      expect(finalPrompt).toBeTruthy()
      expect(finalPrompt).toContain(
        '请先理解需求和参考，再给出可继续推进的候选图方向、关键画面描述、生成要点和下一步建议。'
      )
      expect(finalPrompt).toMatch(/任务备注(?:（\d+）|：)/)
      expect(finalPrompt).toContain('制作要求：需要制作一个服装偏向流浪汉的男性角色')
      expect(finalPrompt).not.toContain('default-agent')
      expect(finalPrompt).not.toContain('不要替用户自动选择')
      expect(finalPrompt).not.toContain('组合一')
      expect(finalPrompt).not.toContain('LV2')
      expect(
        finalPrompt?.match(/制作要求：需要制作一个服装偏向流浪汉的男性角色/g) ?? []
      ).toHaveLength(1)
    } finally {
      dispatchEventSpy.mockRestore()
    }
  }, 15000)

  it('still sends to the default agent even when project-model storage exists', async () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent')

    localStorage.setItem(
      'project-style-models.canvas-1',
      JSON.stringify([
        {
          id: 'model-hero',
          label: 'Project Hero Model',
          description: 'cinematic hero pipeline',
          qAppKey: 'qapp-hero',
          qAppName: 'Hero QuickApp',
          createdAt: '2026-03-28T00:00:00.000Z'
        }
      ])
    )

    try {
      render(
        <ThemeProvider theme={theme}>
          <ProjectCanvasPage />
        </ThemeProvider>
      )

      const firstFileButton = await screen.findByRole('button', { name: 'Select file-1' })
      const secondFileButton = await screen.findByRole('button', { name: 'Select file-2' })

      fireEvent.click(firstFileButton)
      shiftClick(secondFileButton)

      fireEvent.click(await screen.findByRole('button', { name: 'Generate From Selection' }))
      fireEvent.click(await screen.findByRole('button', { name: '发送给 默认 Agent 生成候选图' }))

      await waitFor(
        () => {
          const eventTypes = dispatchEventSpy.mock.calls.map(([event]) => (event as Event).type)
          expect(eventTypes).toContain('send-to-agent')
        },
        { timeout: 10000 }
      )

      const eventTypes = dispatchEventSpy.mock.calls.map(([event]) => (event as Event).type)
      expect(eventTypes).not.toContain('qapp:switch')
      expect(eventTypes).not.toContain('qapp:apply-task-pack')
      expect(notifySuccess).toHaveBeenCalledWith('已发送给默认 Agent 生成候选图')
    } finally {
      dispatchEventSpy.mockRestore()
    }
  }, 15000)

  it('hydrates embedded office preview images when an older file node is opened', async () => {
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Expanded office preview text</w:t></w:r></w:p>
        </w:body>
      </w:document>`
    )
    zip.file('word/media/image1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

    const payload = await zip.generateAsync({ type: 'uint8array' })
    const responseBytes = new Uint8Array(payload.byteLength)
    responseBytes.set(payload)
    const responseBlob = new Blob([responseBytes], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })

    mockLoadCanvasItems.mockResolvedValueOnce({
      items: [createOfficeFileItem('file-1')],
      groups: []
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(responseBlob)
    } as unknown as Response)

    try {
      render(
        <ThemeProvider theme={theme}>
          <ProjectCanvasPage />
        </ThemeProvider>
      )

      const fileButton = await screen.findByRole('button', { name: 'Select file-1' })
      fireEvent.doubleClick(fileButton)

      await waitFor(() => {
        expect(screen.getByText(/内嵌图片/)).toBeInTheDocument()
        expect(screen.getByAltText('image1.png')).toBeInTheDocument()
      })
    } finally {
      fetchMock.mockRestore()
    }
  }, 15000)

  it('appends returned canvas images into the matching generation trace session', async () => {
    beginGenerationTraceSession({
      canvasId: 'canvas-1',
      sessionId: 'generation-session-1',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1'],
      routeChoice: { type: 'default-agent' },
      taskPack: {
        projectId: 'canvas-1',
        projectName: 'MagicPot Demo',
        selectedItemIds: ['file-1'],
        summary: {
          totalItems: 1,
          requirementDocs: 1,
          referenceDocs: 0,
          referenceImages: 0,
          styleReferenceImages: 0,
          taskNotes: 0,
          existingAssets: 0
        },
        requirementDocs: [
          {
            id: 'file-1',
            title: 'brief.docx',
            contentText: 'Need a cinematic character portrait.'
          }
        ],
        referenceDocs: [],
        referenceImages: [],
        styleReferenceImages: [],
        taskNotes: [],
        existingAssets: []
      },
      notes: 'Sent to default agent path in Agent workspace'
    })

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    await screen.findByRole('button', { name: 'Select file-1' })

    window.dispatchEvent(
      new CustomEvent('canvas:add-image', {
        detail: {
          src: 'data:image/png;base64,aW1hZ2Ux',
          fileName: 'candidate-1.png',
          projectId: 'canvas-1',
          generationSessionId: 'generation-session-1',
          select: false
        }
      })
    )

    await waitFor(() => {
      const records = listGenerationTraceRecords('canvas-1')
      expect(records).toHaveLength(1)
      expect(records[0]?.candidates).toHaveLength(1)
      expect(records[0]?.candidates[0]).toMatchObject({
        fileName: 'candidate-1.png',
        src: 'data:image/png;base64,aW1hZ2Ux'
      })
    })
  })

  it('opens generation history from the page chrome and lets the user approve a record', async () => {
    beginGenerationTraceSession({
      canvasId: 'canvas-1',
      sessionId: 'generation-history-1',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1'],
      routeChoice: { type: 'default-agent' },
      taskPack: {
        projectId: 'canvas-1',
        projectName: 'MagicPot Demo',
        selectedItemIds: ['file-1'],
        summary: {
          totalItems: 1,
          requirementDocs: 1,
          referenceDocs: 0,
          referenceImages: 0,
          styleReferenceImages: 0,
          taskNotes: 0,
          existingAssets: 0
        },
        requirementDocs: [
          {
            id: 'file-1',
            title: 'brief.docx',
            contentText: 'Need a cinematic character portrait.'
          }
        ],
        referenceDocs: [],
        referenceImages: [],
        styleReferenceImages: [],
        taskNotes: [],
        existingAssets: []
      },
      notes: 'Sent to default agent path in Agent workspace'
    })

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    await screen.findByRole('button', { name: 'Select file-1' })
    fireEvent.click(screen.getByRole('button', { name: /查看当前项目的出图记录/ }))
    fireEvent.click(await screen.findByRole('button', { name: '采纳本轮' }))

    await waitFor(() => {
      const records = listGenerationTraceRecords('canvas-1')
      expect(records[0]?.userDecision).toBe('approved')
    })
  })

  it('reopens the generation task-pack dialog from generation history', async () => {
    beginGenerationTraceSession({
      canvasId: 'canvas-1',
      sessionId: 'generation-history-2',
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      selectedItemIds: ['file-1', 'file-2'],
      routeChoice: { type: 'default-agent' },
      taskPack: {
        projectId: 'canvas-1',
        projectName: 'MagicPot Demo',
        selectedItemIds: ['file-1', 'file-2'],
        summary: {
          totalItems: 2,
          requirementDocs: 2,
          referenceDocs: 0,
          referenceImages: 0,
          styleReferenceImages: 0,
          taskNotes: 0,
          existingAssets: 0
        },
        requirementDocs: [
          {
            id: 'file-1',
            title: 'brief-1.docx',
            contentText: 'Need a cinematic character portrait.'
          },
          {
            id: 'file-2',
            title: 'brief-2.docx',
            contentText: 'Keep the cloth details readable.'
          }
        ],
        referenceDocs: [],
        referenceImages: [],
        styleReferenceImages: [],
        taskNotes: [],
        existingAssets: []
      },
      notes: 'Sent to default agent path in Agent workspace'
    })

    render(
      <ThemeProvider theme={theme}>
        <ProjectCanvasPage />
      </ThemeProvider>
    )

    await screen.findByRole('button', { name: 'Select file-1' })
    fireEvent.click(screen.getByRole('button', { name: /查看当前项目的出图记录/ }))
    fireEvent.click(await screen.findByRole('button', { name: '继续出图' }))

    expect(await screen.findByRole('button', { name: /默认 Agent/ })).toBeInTheDocument()
  }, 15000)
})
