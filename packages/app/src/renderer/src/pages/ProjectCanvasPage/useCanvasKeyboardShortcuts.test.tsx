import React, { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasKeyboardShortcuts } from './useCanvasKeyboardShortcuts'
import type { CanvasTool } from './projectCanvasPageShared'
import type { AnnotationShape, CanvasItem } from './types'
import type { SelectionRect } from './useCanvasTargetWorkflow'

const TOOL_SHORTCUTS = {
  export: 'Ctrl+S',
  select: 'V',
  hand: 'Space',
  freedraw: 'B',
  rect: 'U',
  arrow: '-',
  text: 'T'
}

const readFileFromPathMock = vi.fn()
const writeImageToClipboardMock = vi.fn()
const writeSvgToClipboardMock = vi.fn()

function createFileItem(x: number): CanvasItem {
  return {
    id: 'file-1',
    type: 'file',
    src: 'file:///C:/magicpot/file-1.md',
    fileName: 'file-1.md',
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
    previewText: 'Preview',
    content: 'Content'
  }
}

function createSvgImageItem(): CanvasItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'local-media:///C:/magicpot/icon.svg',
    fileName: 'icon.svg',
    x: 40,
    y: 40,
    width: 220,
    height: 140,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function KeyboardShortcutHarness({ handleUndo }: { handleUndo: ReturnType<typeof vi.fn> }) {
  const canvasActiveRef = useRef(true)
  const [items, setItems] = useState<CanvasItem[]>([createFileItem(40)])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(['file-1']))
  const [tool, setTool] = useState<CanvasTool>('select')
  const [annoTool, setAnnoTool] = useState<AnnotationShape>('rect')
  const [, setSelectionRect] = useState<SelectionRect | null>(null)
  const [, setCroppingImageId] = useState<string | null>(null)
  const [, setExtractingImageId] = useState<string | null>(null)

  useCanvasKeyboardShortcuts({
    canvasActiveRef,
    toolShortcuts: TOOL_SHORTCUTS,
    handleSaveCanvas: vi.fn(),
    handleSaveCanvasAs: vi.fn(),
    handleExportScopeWithFormat: vi.fn(),
    handleUndo,
    handleRedo: vi.fn(),
    items,
    selectedIds,
    setSelectedIds,
    setItemsWithHistory: setItems,
    setTool,
    setAnnoTool,
    setSelectionRect,
    setCroppingImageId,
    setExtractingImageId
  })

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setItems((prev) =>
            prev.map((item) => (item.id === 'file-1' ? { ...item, x: item.x + 100 } : item))
          )
        }}
      >
        move
      </button>
      <span>{`Position file-1: ${items[0]?.x ?? 0},40`}</span>
      <span>{`Tool: ${tool}`}</span>
      <span>{`Anno: ${annoTool}`}</span>
      <span>{`Selected: ${selectedIds.size}`}</span>
    </div>
  )
}

function KeyboardImageShortcutHarness() {
  const canvasActiveRef = useRef(true)
  const [items, setItems] = useState<CanvasItem[]>([createSvgImageItem()])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(['image-1']))
  const [, setTool] = useState<CanvasTool>('select')
  const [, setAnnoTool] = useState<AnnotationShape>('rect')
  const [, setSelectionRect] = useState<SelectionRect | null>(null)
  const [, setCroppingImageId] = useState<string | null>(null)
  const [, setExtractingImageId] = useState<string | null>(null)

  useCanvasKeyboardShortcuts({
    canvasActiveRef,
    toolShortcuts: TOOL_SHORTCUTS,
    handleSaveCanvas: vi.fn(),
    handleSaveCanvasAs: vi.fn(),
    handleExportScopeWithFormat: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    items,
    selectedIds,
    setSelectedIds,
    setItemsWithHistory: setItems,
    setTool,
    setAnnoTool,
    setSelectionRect,
    setCroppingImageId,
    setExtractingImageId
  })

  return <div>canvas</div>
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  readFileFromPathMock.mockReset()
  writeImageToClipboardMock.mockReset()
  writeSvgToClipboardMock.mockReset()

  readFileFromPathMock.mockResolvedValue({
    data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  })
  writeImageToClipboardMock.mockResolvedValue({ success: true })
  writeSvgToClipboardMock.mockResolvedValue({ success: true })

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      svcFs: {
        readFileFromPath: readFileFromPathMock
      },
      svcHyper: {
        writeImageToClipboard: writeImageToClipboardMock,
        writeSvgToClipboard: writeSvgToClipboardMock
      }
    }
  })
})

describe('useCanvasKeyboardShortcuts', () => {
  it('keeps the key listeners mounted when items change after a drag-like update', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')

    render(<KeyboardShortcutHarness handleUndo={vi.fn()} />)

    const initialKeydownAdds = addEventListenerSpy.mock.calls.filter(
      ([eventName]) => eventName === 'keydown'
    ).length
    const initialKeyupAdds = addEventListenerSpy.mock.calls.filter(
      ([eventName]) => eventName === 'keyup'
    ).length

    fireEvent.click(screen.getByRole('button', { name: 'move' }))

    expect(
      addEventListenerSpy.mock.calls.filter(([eventName]) => eventName === 'keydown')
    ).toHaveLength(initialKeydownAdds)
    expect(
      addEventListenerSpy.mock.calls.filter(([eventName]) => eventName === 'keyup')
    ).toHaveLength(initialKeyupAdds)
    expect(
      removeEventListenerSpy.mock.calls.filter(([eventName]) => eventName === 'keydown')
    ).toHaveLength(0)
    expect(
      removeEventListenerSpy.mock.calls.filter(([eventName]) => eventName === 'keyup')
    ).toHaveLength(0)
  })

  it('still handles Ctrl+Z after items change', () => {
    const handleUndo = vi.fn()

    render(<KeyboardShortcutHarness handleUndo={handleUndo} />)

    fireEvent.click(screen.getByRole('button', { name: 'move' }))
    expect(screen.getByText('Position file-1: 140,40')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })

    expect(handleUndo).toHaveBeenCalledTimes(1)
  })

  it('switches to the text annotation tool with the T shortcut', () => {
    render(<KeyboardShortcutHarness handleUndo={vi.fn()} />)

    fireEvent.keyDown(window, { key: 't', code: 'KeyT' })

    expect(screen.getByText('Tool: annotate')).toBeInTheDocument()
    expect(screen.getByText('Anno: text-anno')).toBeInTheDocument()
  })

  it('handles Ctrl+Z by key code when the active layout does not report latin key text', () => {
    const handleUndo = vi.fn()

    render(<KeyboardShortcutHarness handleUndo={handleUndo} />)

    fireEvent.keyDown(window, { key: 'я', code: 'KeyZ', ctrlKey: true })

    expect(handleUndo).toHaveBeenCalledTimes(1)
  })

  it('copies selected svg images through the svg clipboard path', async () => {
    render(<KeyboardImageShortcutHarness />)

    fireEvent.keyDown(window, { key: 'c', code: 'KeyC', ctrlKey: true })

    await waitFor(() => {
      expect(readFileFromPathMock).toHaveBeenCalledWith({
        fullPath: 'C:/magicpot/icon.svg'
      })
    })

    expect(writeSvgToClipboardMock).toHaveBeenCalledTimes(1)
    expect(writeImageToClipboardMock).not.toHaveBeenCalled()
  })

  it('lets native text selections handle Ctrl+C before canvas copy shortcuts', () => {
    render(<KeyboardImageShortcutHarness />)

    const selectedText = document.createElement('p')
    selectedText.textContent = 'selected agent text'
    document.body.appendChild(selectedText)

    const range = document.createRange()
    range.selectNodeContents(selectedText)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)

    const wasNotPrevented = fireEvent.keyDown(window, { key: 'c', code: 'KeyC', ctrlKey: true })

    expect(wasNotPrevented).toBe(true)
    expect(readFileFromPathMock).not.toHaveBeenCalled()
    expect(writeSvgToClipboardMock).not.toHaveBeenCalled()
    expect(writeImageToClipboardMock).not.toHaveBeenCalled()
  })
})
