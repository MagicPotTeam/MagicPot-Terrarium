import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useCanvasExternalDrop } from './useCanvasExternalDrop'
import type { CanvasDragPayload } from './projectCanvasPageShared'
import type { CanvasImageItem, CanvasItem } from './types'

vi.mock('./canvasPageLocalStateUtils', () => ({
  resolveActiveAgentScope: (projectId: string) => `${projectId}.agent-active`
}))

const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')

afterEach(() => {
  if (originalElementFromPoint) {
    Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint)
  } else {
    Reflect.deleteProperty(document, 'elementFromPoint')
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function createImage(id: string, overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id,
    type: 'image',
    src: `local-media:///C:/MagicPot/${id}.png`,
    fileName: `${id}.png`,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function renderExternalDrop(items: CanvasItem[], selectedIds = new Set<string>()) {
  const canvas = document.createElement('div')
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({})
  })
  const workspace = document.createElement('div')
  workspace.dataset.agentWorkspaceRoot = 'destination'
  const dropTarget = document.createElement('div')
  workspace.append(dropTarget)
  const elementFromPoint = vi.fn<(clientX: number, clientY: number) => Element | null>(
    () => dropTarget
  )
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: elementFromPoint
  })
  const handleSendCanvasItemsToAgent = vi.fn()
  const resetDraggedItemNode = vi.fn()
  const buildCanvasDragPayload = vi.fn((targetItems: CanvasItem[]): CanvasDragPayload => ({
    sourceCanvasId: 'source',
    objectUrl: targetItems[0]?.type === 'image' ? targetItems[0].src : undefined
  }))
  const setCanvasDragPayload = vi.fn()
  const options = {
    canvasId: 'source',
    items,
    selectedIds,
    canvasContainerRef: { current: canvas },
    buildCanvasDragPayload,
    setCanvasDragPayload,
    getCanvasImageDragObjectUrl: (item: CanvasImageItem) => item.src,
    resetDraggedItemNode,
    handleSendCanvasItemsToAgent
  }
  const hook = renderHook(() => useCanvasExternalDrop(options))

  return {
    ...hook,
    buildCanvasDragPayload,
    dropTarget,
    elementFromPoint,
    handleSendCanvasItemsToAgent,
    resetDraggedItemNode,
    setCanvasDragPayload,
    workspace
  }
}

describe('useCanvasExternalDrop Agent attachment source', () => {
  it('sends the dragged image rather than a previously selected image', () => {
    const selected = createImage('selected')
    const dragged = createImage('dragged')
    const selectedIds = new Set([selected.id])
    const { result, handleSendCanvasItemsToAgent, resetDraggedItemNode } = renderExternalDrop(
      [selected, dragged],
      selectedIds
    )

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(true)
    expect(handleSendCanvasItemsToAgent).toHaveBeenCalledExactlyOnceWith(
      [dragged],
      'destination.agent-active'
    )
    expect(resetDraggedItemNode).toHaveBeenCalledWith(dragged)
    expect(selectedIds).toEqual(new Set([selected.id]))
  })

  it('sends an unselected dragged image even when the selection is empty', () => {
    const dragged = createImage('dragged')
    const { result, handleSendCanvasItemsToAgent } = renderExternalDrop([dragged])

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(true)
    expect(handleSendCanvasItemsToAgent).toHaveBeenCalledExactlyOnceWith(
      [dragged],
      'destination.agent-active'
    )
  })

  it('preserves multi-selection order when the dragged image belongs to the selection', () => {
    const first = createImage('first')
    const dragged = createImage('dragged')
    const unselected = createImage('unselected')
    const { result, handleSendCanvasItemsToAgent } = renderExternalDrop(
      [first, unselected, dragged],
      new Set([dragged.id, 'deleted-item', first.id])
    )

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(true)
    expect(handleSendCanvasItemsToAgent).toHaveBeenCalledExactlyOnceWith(
      [first, dragged],
      'destination.agent-active'
    )
  })

  it('sends the dragged image when selected IDs only refer to removed items', () => {
    const dragged = createImage('dragged')
    const { result, handleSendCanvasItemsToAgent } = renderExternalDrop(
      [dragged],
      new Set(['deleted-item'])
    )

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(true)
    expect(handleSendCanvasItemsToAgent).toHaveBeenCalledExactlyOnceWith(
      [dragged],
      'destination.agent-active'
    )
  })

  it.each(['', '   '])('does not consume an image drop with source %j', (src) => {
    const dragged = createImage('empty-source', { src })
    const { result, handleSendCanvasItemsToAgent, resetDraggedItemNode } = renderExternalDrop(
      [dragged],
      new Set([dragged.id])
    )

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(false)
    expect(handleSendCanvasItemsToAgent).not.toHaveBeenCalled()
    expect(resetDraggedItemNode).not.toHaveBeenCalled()
  })

  it('does not substitute the selection for a removed dragged item', () => {
    const selected = createImage('selected')
    const { result, handleSendCanvasItemsToAgent, resetDraggedItemNode } = renderExternalDrop(
      [selected],
      new Set([selected.id])
    )

    expect(result.current.tryHandleCanvasExternalDrop('deleted-item', 150, 50)).toBe(false)
    expect(handleSendCanvasItemsToAgent).not.toHaveBeenCalled()
    expect(resetDraggedItemNode).not.toHaveBeenCalled()
  })

  it('leaves unsupported text drags to the canvas interaction handler', () => {
    const text: CanvasItem = {
      ...createImage('text'),
      type: 'text',
      text: 'Not an external media drag',
      fontSize: 14,
      fontFamily: 'sans-serif',
      fill: '#000000'
    }
    const { result, handleSendCanvasItemsToAgent, resetDraggedItemNode } = renderExternalDrop(
      [text],
      new Set([text.id])
    )

    expect(result.current.tryHandleCanvasExternalDrop(text.id, 150, 50)).toBe(false)
    expect(handleSendCanvasItemsToAgent).not.toHaveBeenCalled()
    expect(resetDraggedItemNode).not.toHaveBeenCalled()
  })

  it('does not send media while the pointer is still inside the canvas', () => {
    const dragged = createImage('dragged')
    const { result, elementFromPoint, handleSendCanvasItemsToAgent } = renderExternalDrop([dragged])

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 50, 50)).toBe(false)
    expect(elementFromPoint).not.toHaveBeenCalled()
    expect(handleSendCanvasItemsToAgent).not.toHaveBeenCalled()
  })

  it('does not treat a drop outside the document as an Agent drop', () => {
    const dragged = createImage('dragged')
    const { result, elementFromPoint, handleSendCanvasItemsToAgent, resetDraggedItemNode } =
      renderExternalDrop([dragged])
    elementFromPoint.mockReturnValue(null)

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(false)
    expect(handleSendCanvasItemsToAgent).not.toHaveBeenCalled()
    expect(resetDraggedItemNode).not.toHaveBeenCalled()
  })

  it.each(['video', 'model3d', 'file'] as const)(
    'keeps the existing %s Agent drop support bound to the dragged item',
    (type) => {
      const selected = createImage('selected')
      const dragged: CanvasItem =
        type === 'video'
          ? {
              ...createImage('dragged'),
              type,
              src: 'local-media:///C:/MagicPot/video.mp4',
              fileName: 'video.mp4',
              playing: false,
              muted: false,
              volume: 1
            }
          : type === 'model3d'
            ? {
                ...createImage('dragged'),
                type,
                src: 'local-media:///C:/MagicPot/model.glb',
                fileName: 'model.glb'
              }
            : {
                ...createImage('dragged'),
                type,
                src: 'local-media:///C:/MagicPot/notes.txt',
                fileName: 'notes.txt',
                fileKind: 'text',
                mimeType: 'text/plain'
              }
      const { result, handleSendCanvasItemsToAgent } = renderExternalDrop(
        [selected, dragged],
        new Set([selected.id])
      )

      expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(true)
      expect(handleSendCanvasItemsToAgent).toHaveBeenCalledExactlyOnceWith(
        [dragged],
        'destination.agent-active'
      )
    }
  )

  it('keeps a cropped dragged image intact for the Agent materialization pipeline', () => {
    const selected = createImage('selected')
    const dragged = createImage('dragged', {
      promptId: 'dragged-prompt',
      crop: { x: 10, y: 20, width: 30, height: 40 },
      sourceWidth: 400,
      sourceHeight: 300
    })
    const { result, handleSendCanvasItemsToAgent } = renderExternalDrop(
      [selected, dragged],
      new Set([selected.id])
    )

    result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)

    expect(handleSendCanvasItemsToAgent.mock.calls[0][0][0]).toBe(dragged)
    expect(dragged.crop).toEqual({ x: 10, y: 20, width: 30, height: 40 })
  })
})

describe('useCanvasExternalDrop synthetic drop source', () => {
  function installDragEventDoubles() {
    vi.stubGlobal('DataTransfer', class {})
    vi.stubGlobal(
      'DragEvent',
      class extends MouseEvent {
        readonly dataTransfer: DataTransfer | null

        constructor(type: string, init: DragEventInit) {
          super(type, init)
          this.dataTransfer = init.dataTransfer ?? null
        }
      }
    )
  }

  it('builds a non-Agent drop from the dragged image and its prompt, not the selection', () => {
    installDragEventDoubles()
    const selected = createImage('selected', { promptId: 'selected-prompt' })
    const dragged = createImage('dragged', { promptId: 'dragged-prompt' })
    const {
      result,
      buildCanvasDragPayload,
      dropTarget,
      handleSendCanvasItemsToAgent,
      resetDraggedItemNode,
      setCanvasDragPayload
    } = renderExternalDrop([selected, dragged], new Set([selected.id]))
    dropTarget.remove()
    dropTarget.addEventListener('dragover', (event) => event.preventDefault())
    const drop = vi.fn((event: Event) => event.preventDefault())
    dropTarget.addEventListener('drop', drop)

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(true)
    expect(buildCanvasDragPayload).toHaveBeenCalledExactlyOnceWith([dragged], {
      objectUrl: dragged.src,
      promptId: 'dragged-prompt'
    })
    expect(setCanvasDragPayload).toHaveBeenCalledWith(
      expect.any(DataTransfer),
      expect.objectContaining({ objectUrl: dragged.src })
    )
    expect(drop).toHaveBeenCalledOnce()
    expect(resetDraggedItemNode).toHaveBeenCalledExactlyOnceWith(dragged)
    expect(handleSendCanvasItemsToAgent).not.toHaveBeenCalled()
  })

  it('does not reset a dragged image if the synthetic target rejects dragover', () => {
    installDragEventDoubles()
    const dragged = createImage('dragged')
    const { result, dropTarget, resetDraggedItemNode } = renderExternalDrop([dragged])
    dropTarget.remove()
    const drop = vi.fn()
    dropTarget.addEventListener('drop', drop)

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(false)
    expect(drop).not.toHaveBeenCalled()
    expect(resetDraggedItemNode).not.toHaveBeenCalled()
  })

  it('does not consume a drop when dragover is accepted but the drop itself is not', () => {
    installDragEventDoubles()
    const dragged = createImage('dragged')
    const { result, dropTarget, resetDraggedItemNode } = renderExternalDrop([dragged])
    dropTarget.remove()
    dropTarget.addEventListener('dragover', (event) => event.preventDefault())
    const drop = vi.fn()
    dropTarget.addEventListener('drop', drop)

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(false)
    expect(drop).toHaveBeenCalledOnce()
    expect(resetDraggedItemNode).not.toHaveBeenCalled()
  })

  it('leaves the operation untouched when DragEvent is unavailable', () => {
    installDragEventDoubles()
    vi.stubGlobal('DragEvent', undefined)
    const dragged = createImage('dragged')
    const { result, dropTarget, resetDraggedItemNode, setCanvasDragPayload } = renderExternalDrop([
      dragged
    ])
    dropTarget.remove()

    expect(result.current.tryHandleCanvasExternalDrop(dragged.id, 150, 50)).toBe(false)
    expect(setCanvasDragPayload).not.toHaveBeenCalled()
    expect(resetDraggedItemNode).not.toHaveBeenCalled()
  })
})
