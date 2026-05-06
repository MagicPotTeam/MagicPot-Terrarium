import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasAssetIntake } from './useCanvasAssetIntake'
import { useCanvasLayerRuntime } from './useCanvasLayerRuntime'
import { useCanvasMediaRuntime } from './useCanvasMediaRuntime'
import { useProjectCanvasPageRuntimeState } from './useProjectCanvasPageRuntimeState'

function buildElectronFile(name: string, type: string, fullPath: string): File {
  const file = new File(['payload'], name, { type }) as File & { path?: string }
  file.path = fullPath
  return file
}

describe('useProjectCanvasPageRuntimeState model split undo flow', () => {
  const notifyError = vi.fn()
  const notifyWarning = vi.fn()
  const notifySuccess = vi.fn()

  beforeEach(() => {
    notifyError.mockReset()
    notifyWarning.mockReset()
    notifySuccess.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores canonical local-media URLs for imported local files, videos, and models', async () => {
    const nextZIndexRef = { current: 1 }
    const setGroups = vi.fn()
    const setGroupBranches = vi.fn()
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectUrlMock = vi.fn((value: Blob | MediaSource) => {
      const fileName = value instanceof File ? value.name : 'asset'
      return `blob:mock-${fileName}`
    })
    const revokeObjectUrlMock = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectUrlMock
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectUrlMock
    })
    const originalCreateElement = document.createElement.bind(document)
    const metadataVideo = {
      preload: '',
      onloadedmetadata: null as null | (() => void),
      onerror: null as null | (() => void),
      videoWidth: 1280,
      videoHeight: 720,
      _src: '',
      set src(value: string) {
        this._src = value
        queueMicrotask(() => this.onloadedmetadata?.())
      },
      get src() {
        return this._src
      }
    }
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions
    ) => {
      if (tagName === 'video') {
        return metadataVideo as unknown as HTMLVideoElement
      }
      return originalCreateElement(tagName, options)
    }) as typeof document.createElement)

    try {
      const { result } = renderHook(() => {
        const runtime = useProjectCanvasPageRuntimeState()
        const mediaRuntime = useCanvasMediaRuntime({
          canvasActiveRef: { current: true },
          items: runtime.items,
          lastClickedIdRef: runtime.lastClickedIdRef,
          setItems: runtime.setItems,
          setSelectedIds: runtime.setSelectedIds,
          setTool: runtime.setTool
        })
        const assetIntake = useCanvasAssetIntake({
          getCenterPosition: () => ({ x: 100, y: 120 }),
          getCanvasPointFromClient: () => null,
          nextZIndexRef,
          setItemsWithHistory: runtime.setItemsWithHistory,
          setGroups,
          setGroupBranches,
          setSelectedIds: runtime.setSelectedIds,
          setTool: runtime.setTool,
          notifyError,
          notifyWarning,
          notifySuccess,
          activateModel3DRender: mediaRuntime.activateModel3DRender
        })

        return {
          ...runtime,
          ...assetIntake
        }
      })

      await act(async () => {
        await result.current.addFileToCanvas(
          buildElectronFile('brief.md', 'text/markdown', 'C:/MagicPot/brief.md')
        )
        await result.current.addModel3DToCanvas(
          buildElectronFile('scene.glb', 'model/gltf-binary', 'C:/MagicPot/scene.glb')
        )
        result.current.addVideoToCanvas(
          buildElectronFile('clip.mp4', 'video/mp4', 'C:/MagicPot/clip.mp4')
        )
        await Promise.resolve()
      })

      expect(result.current.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'file',
            src: 'local-media:///C:/MagicPot/brief.md',
            fileName: 'brief.md'
          }),
          expect.objectContaining({
            type: 'model3d',
            src: 'local-media:///C:/MagicPot/scene.glb',
            fileName: 'scene.glb'
          }),
          expect.objectContaining({
            type: 'video',
            src: 'local-media:///C:/MagicPot/clip.mp4',
            fileName: 'clip.mp4'
          })
        ])
      )
      expect(createObjectUrlMock).toHaveBeenCalled()
      expect(revokeObjectUrlMock).toHaveBeenCalledWith('blob:mock-clip.mp4')
    } finally {
      createElementSpy.mockRestore()
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, 'createObjectURL', {
          configurable: true,
          writable: true,
          value: originalCreateObjectURL
        })
      } else {
        delete (URL as Partial<typeof URL>).createObjectURL
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, 'revokeObjectURL', {
          configurable: true,
          writable: true,
          value: originalRevokeObjectURL
        })
      } else {
        delete (URL as Partial<typeof URL>).revokeObjectURL
      }
    }
  })

  it('keeps blob URLs for imported files that do not expose an Electron path', async () => {
    const nextZIndexRef = { current: 1 }
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectUrlMock = vi.fn(() => 'blob:mock-transient-file')
    const revokeObjectUrlMock = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectUrlMock
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectUrlMock
    })

    try {
      const { result } = renderHook(() => {
        const runtime = useProjectCanvasPageRuntimeState()
        const assetIntake = useCanvasAssetIntake({
          getCenterPosition: () => ({ x: 100, y: 120 }),
          getCanvasPointFromClient: () => null,
          nextZIndexRef,
          setItemsWithHistory: runtime.setItemsWithHistory,
          setGroups: vi.fn(),
          setGroupBranches: vi.fn(),
          setSelectedIds: runtime.setSelectedIds,
          setTool: runtime.setTool,
          notifyError,
          notifyWarning,
          notifySuccess
        })

        return {
          ...runtime,
          ...assetIntake
        }
      })

      await act(async () => {
        await result.current.addFileToCanvas(
          new File(['# fallback'], 'fallback.md', {
            type: 'text/markdown'
          })
        )
      })

      expect(result.current.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'file',
            src: 'blob:mock-transient-file',
            fileName: 'fallback.md'
          })
        ])
      )
    } finally {
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, 'createObjectURL', {
          configurable: true,
          writable: true,
          value: originalCreateObjectURL
        })
      } else {
        delete (URL as Partial<typeof URL>).createObjectURL
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, 'revokeObjectURL', {
          configurable: true,
          writable: true,
          value: originalRevokeObjectURL
        })
      } else {
        delete (URL as Partial<typeof URL>).revokeObjectURL
      }
    }
  })

  it('keeps split model items when undoing a drag commit before deferred activation settles', () => {
    vi.useFakeTimers()

    const canvasContainer = document.createElement('div')
    Object.defineProperty(canvasContainer, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 1200,
        bottom: 800,
        width: 1200,
        height: 800
      })
    })

    const canvasActiveRef = { current: true }
    const nextZIndexRef = { current: 1 }
    const lastViewportPointRef = { current: null as { x: number; y: number } | null }
    const tryHandleCanvasExternalDropRef = {
      current: vi.fn(() => false)
    }

    const { result } = renderHook(() => {
      const runtime = useProjectCanvasPageRuntimeState()
      const mediaRuntime = useCanvasMediaRuntime({
        canvasActiveRef,
        items: runtime.items,
        lastClickedIdRef: runtime.lastClickedIdRef,
        setItems: runtime.setItems,
        setSelectedIds: runtime.setSelectedIds,
        setTool: runtime.setTool
      })
      const assetIntake = useCanvasAssetIntake({
        getCenterPosition: () => ({ x: 100, y: 120 }),
        getCanvasPointFromClient: () => null,
        nextZIndexRef,
        setItemsWithHistory: runtime.setItemsWithHistory,
        setGroups: runtime.setGroups,
        setGroupBranches: runtime.setGroupBranches,
        setSelectedIds: runtime.setSelectedIds,
        setTool: runtime.setTool,
        notifyError,
        notifyWarning,
        notifySuccess,
        activateModel3DRender: mediaRuntime.activateModel3DRender
      })
      const layerRuntime = useCanvasLayerRuntime({
        canvasContainerRef: { current: canvasContainer },
        lastViewportPointRef,
        selectedIds: runtime.selectedIds,
        setItems: runtime.setItems,
        setItemsWithHistory: runtime.setItemsWithHistory,
        setSelectedIds: runtime.setSelectedIds,
        tryHandleCanvasExternalDropRef
      })

      return {
        ...runtime,
        ...assetIntake,
        ...layerRuntime
      }
    })

    act(() => {
      result.current.addModel3DUrlToCanvas('https://example.com/split-a.fbx', {
        fileName: 'split-a.fbx',
        offsetX: -80,
        select: false
      })
      result.current.addModel3DUrlToCanvas('https://example.com/split-b.fbx', {
        fileName: 'split-b.fbx',
        offsetX: 80,
        select: true
      })
    })

    expect(result.current.items.map((item) => item.id)).toHaveLength(2)
    expect(result.current.items.every((item) => item.type === 'model3d')).toBe(true)

    const draggedItem = result.current.items[0]

    act(() => {
      result.current.handleDragEnd(draggedItem.id, draggedItem.x + 48, draggedItem.y + 24)
    })

    expect(result.current.items.find((item) => item.id === draggedItem.id)).toMatchObject({
      x: draggedItem.x + 48,
      y: draggedItem.y + 24
    })

    act(() => {
      result.current.handleUndo()
    })

    expect(result.current.items.map((item) => item.id)).toEqual([
      draggedItem.id,
      result.current.items[1]?.id ?? ''
    ])
    expect(result.current.items.find((item) => item.id === draggedItem.id)).toMatchObject({
      x: draggedItem.x,
      y: draggedItem.y,
      type: 'model3d'
    })
    expect(result.current.items).toHaveLength(2)
  })
})
