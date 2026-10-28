import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasAssetIntake } from './useCanvasAssetIntake'
import { useCanvasLayerRuntime } from './useCanvasLayerRuntime'
import { useCanvasMediaRuntime } from './useCanvasMediaRuntime'
import { useProjectCanvasPageRuntimeState } from './useProjectCanvasPageRuntimeState'

import type { CanvasImageItem, CanvasTextItem } from './types'

const makeText = (id: string, text: string): CanvasTextItem => ({
  id,
  type: 'text',
  text,
  fontSize: 16,
  fontFamily: 'sans-serif',
  fill: '#fff',
  x: 0,
  y: 0,
  width: 100,
  height: 32,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  zIndex: 0,
  locked: false
})

function buildElectronFile(name: string, type: string, fullPath: string): File {
  const file = new File(['payload'], name, { type }) as File & { path?: string }
  file.path = fullPath
  return file
}

describe('history state transitions', () => {
  it('records one snapshot per edit under StrictMode and preserves edit order', () => {
    const { result } = renderHook(() => useProjectCanvasPageRuntimeState(), {
      wrapper: StrictMode
    })
    const first = makeText('text', 'first')
    const second = makeText('text', 'second')

    act(() => {
      result.current.setItemsWithHistory([first])
      result.current.setItemsWithHistory([second])
    })

    expect(result.current.items).toEqual([second])
    expect(result.current.historyCount).toBe(2)
    expect(result.current.historySnapshots.map((entry) => entry.items)).toEqual([[first], []])
  })

  it('undoes and redoes without duplicate or lost states', () => {
    const { result } = renderHook(() => useProjectCanvasPageRuntimeState(), {
      wrapper: StrictMode
    })
    const first = makeText('text', 'first')
    const second = makeText('text', 'second')
    act(() => result.current.setItemsWithHistory([first]))
    act(() => result.current.setItemsWithHistory([second]))

    act(() => result.current.handleUndo())
    expect(result.current.items).toEqual([first])
    expect(result.current.historyCount).toBe(1)
    act(() => result.current.handleRedo())
    expect(result.current.items).toEqual([second])
    expect(result.current.historyCount).toBe(2)
  })

  it('never attaches the other source pixels when undoing or redoing an image replacement', () => {
    const { result } = renderHook(() => useProjectCanvasPageRuntimeState(), {
      wrapper: StrictMode
    })
    const redImage = Object.assign(document.createElement('img'), {
      src: 'blob:red',
      rgba: new Uint8ClampedArray([255, 0, 0, 255])
    })
    const blueImage = Object.assign(document.createElement('img'), {
      src: 'blob:blue',
      rgba: new Uint8ClampedArray([0, 0, 255, 255])
    })
    const red: CanvasImageItem = {
      id: 'replaced-image',
      type: 'image',
      src: redImage.src,
      image: redImage,
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      zIndex: 0,
      locked: false
    }
    const blue: CanvasImageItem = { ...red, src: blueImage.src, image: blueImage }
    const blueCopy: CanvasImageItem = { ...blue, id: 'blue-copy' }
    act(() => result.current.setItems([red, blueCopy]))
    act(() => result.current.setItemsWithHistory([blue, blueCopy]))

    act(() => result.current.handleUndo())
    const restoredRed = result.current.items[0] as CanvasImageItem
    expect(restoredRed.src).toBe(redImage.src)
    expect(restoredRed.image).toBeUndefined()
    // The renderer may decode the restored source again, but must not display the blue asset.
    act(() => result.current.setItems([{ ...restoredRed, image: redImage }, blueCopy]))
    expect((result.current.items[0] as CanvasImageItem).image).toBe(redImage)

    act(() => result.current.handleRedo())
    const restoredBlue = result.current.items[0] as CanvasImageItem
    expect(restoredBlue.src).toBe(blueImage.src)
    expect(restoredBlue.image).toBe(blueImage)
    expect((restoredBlue.image as typeof blueImage).rgba).toEqual(
      new Uint8ClampedArray([0, 0, 255, 255])
    )

    act(() => result.current.restoreHistoryRevision(0))
    const historyRed = result.current.items[0] as CanvasImageItem
    expect(historyRed.src).toBe(redImage.src)
    expect(historyRed.image).toBeUndefined()
  })

  it('restores a valid history index without mutating the original snapshot and ignores invalid indexes', () => {
    const { result } = renderHook(() => useProjectCanvasPageRuntimeState(), {
      wrapper: StrictMode
    })
    const first = makeText('text', 'first')
    const second = makeText('text', 'second')
    act(() => result.current.setItemsWithHistory([first]))
    act(() => result.current.setItemsWithHistory([second]))
    const original = structuredClone(result.current.historySnapshots)

    act(() => result.current.restoreHistoryRevision(1))
    expect(result.current.items).toEqual([first])
    expect(result.current.historySnapshots).toEqual(original)
    expect(result.current.selectedHistoryRevision).toBe(1)
    const afterValid = result.current.items
    act(() => result.current.restoreHistoryRevision(999))
    expect(result.current.items).toBe(afterValid)
    expect(result.current.historyRevision).toBe(3)
  })

  it('clears the selected history node after a later edit or undo/redo', () => {
    const { result } = renderHook(() => useProjectCanvasPageRuntimeState())
    const first = makeText('text', 'first')
    const second = makeText('text', 'second')
    act(() => result.current.setItemsWithHistory([first]))
    act(() => result.current.setItemsWithHistory([second]))

    act(() => result.current.restoreHistoryRevision(1))
    expect(result.current.selectedHistoryRevision).toBe(1)

    act(() => result.current.setItemsWithHistory([makeText('text', 'third')]))
    expect(result.current.selectedHistoryRevision).toBeNull()

    act(() => result.current.restoreHistoryRevision(2))
    expect(result.current.selectedHistoryRevision).toBe(2)
    act(() => result.current.handleUndo())
    expect(result.current.selectedHistoryRevision).toBeNull()
  })
})

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

  it('skips selectedIds updates only when a new Set preserves identical members and order', () => {
    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount += 1
      return useProjectCanvasPageRuntimeState()
    })

    expect(renderCount).toBe(1)

    act(() => {
      result.current.setSelectedIds(new Set(['image-a', 'image-b']))
    })

    expect(renderCount).toBe(2)
    const selectedIds = result.current.selectedIds
    const selectedIdsRefCurrent = result.current.selectedIdsRef.current

    act(() => {
      result.current.setSelectedIds(new Set(['image-a', 'image-b']))
    })

    expect(renderCount).toBe(2)
    expect(result.current.selectedIds).toBe(selectedIds)
    expect(result.current.selectedIdsRef.current).toBe(selectedIdsRefCurrent)

    act(() => {
      result.current.setSelectedIds(new Set(['image-b', 'image-a']))
    })

    expect(renderCount).toBe(3)
    expect(result.current.selectedIds).not.toBe(selectedIds)
    expect(result.current.selectedIdsRef.current).not.toBe(selectedIdsRefCurrent)
    expect([...result.current.selectedIds]).toEqual(['image-b', 'image-a'])
  })

  it('stores canonical local-media URLs for imported local files, videos, and models', async () => {
    const nextZIndexRef = { current: 1 }
    const setGroups = vi.fn()
    const setGroupBranches = vi.fn()
    const originalElectronFile = window.electronFile
    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: {
        authorizeLocalMediaFile: vi.fn(
          async (file: File) => (file as File & { path?: string }).path ?? ''
        )
      }
    })
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
    let metadataCallback: (() => void) | null = null
    const metadataVideo = {
      preload: '',
      get onloadedmetadata() {
        return metadataCallback
      },
      set onloadedmetadata(value: (() => void) | null) {
        metadataCallback = value
      },
      onerror: null as null | (() => void),
      videoWidth: 1280,
      videoHeight: 720,
      _src: '',
      set src(value: string) {
        this._src = value
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
      await vi.waitFor(() => expect(metadataCallback).toBeTypeOf('function'))
      await act(async () => {
        metadataCallback?.()
      })
      await vi.waitFor(() =>
        expect(result.current.items.some((item) => item.type === 'video')).toBe(true)
      )

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
      Object.defineProperty(window, 'electronFile', {
        configurable: true,
        value: originalElectronFile
      })
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
