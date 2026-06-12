import React, { useEffect, useRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activateQuickAppImagePasteTarget,
  deactivateQuickAppImagePasteTarget,
  resetQuickAppImagePasteTargetsForTest
} from '@renderer/utils/quickAppPasteTarget'
import { useCanvasFileIntake } from './useCanvasFileIntake'

type TestAddImageToCanvas = Parameters<typeof useCanvasFileIntake>[0]['addImageToCanvas']
type TestAddImagesToCanvas = Parameters<typeof useCanvasFileIntake>[0]['addImagesToCanvas']
type TestAddFileToCanvas = Parameters<typeof useCanvasFileIntake>[0]['addFileToCanvas']
type TestAddTextToCanvas = Parameters<typeof useCanvasFileIntake>[0]['addTextToCanvas']
type TestNotifyWarning = NonNullable<Parameters<typeof useCanvasFileIntake>[0]['notifyWarning']>
type TestImageBatchImportProgress = NonNullable<
  Parameters<typeof useCanvasFileIntake>[0]['onImageBatchImportProgress']
>
import { buildCanvasImageSourceIdentity } from './canvasThumbnailCache'

vi.mock('react-konva', () => ({
  Line: () => null
}))

vi.mock('konva', () => ({
  default: {}
}))

type ClipboardMock = {
  read: ReturnType<typeof vi.fn>
  readText: ReturnType<typeof vi.fn>
}

type NativeClipboardMock = {
  readClipboardImage: ReturnType<typeof vi.fn>
  readClipboardHtml: ReturnType<typeof vi.fn>
  readClipboardText: ReturnType<typeof vi.fn>
}

const originalCreateObjectURL = URL.createObjectURL
const originalCreateImageBitmap = globalThis.createImageBitmap

function buildPngHeader(width: number, height: number, colorType = 6): ArrayBuffer {
  const buffer = new ArrayBuffer(26)
  const header = new Uint8Array(buffer)
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(buffer)
  view.setUint32(8, 13, false)
  header.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width, false)
  view.setUint32(20, height, false)
  header[24] = 8
  header[25] = colorType
  return buffer
}

function buildClipboardPasteEvent({
  text = '',
  html = '',
  includeItems = true,
  files = []
}: {
  text?: string
  html?: string
  includeItems?: boolean
  files?: File[]
}): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  const clipboardItem = {
    type: 'text/plain',
    getAsFile: () => null,
    getAsString: (callback: (value: string) => void) => callback(text)
  }

  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: {
      files,
      items: includeItems ? [clipboardItem] : [],
      getData: (type: string) => {
        if (type === 'text/plain' || type === 'text' || type === 'Text') {
          return text
        }

        if (type === 'text/html') {
          return html
        }

        return ''
      }
    }
  })

  return event
}

function buildFileDragEvent(type: 'dragover' | 'drop', files: File[]): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: {
      files,
      items: [],
      types: ['Files'],
      getData: vi.fn(() => '')
    }
  })
  Object.defineProperty(event, 'clientX', { configurable: true, value: 120 })
  Object.defineProperty(event, 'clientY', { configurable: true, value: 80 })
  return event
}

function buildTypeOnlyFileDragEvent(types: string[]): DragEvent {
  const event = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: {
      files: [],
      items: [],
      types,
      dropEffect: 'none',
      getData: vi.fn(() => '')
    }
  })
  Object.defineProperty(event, 'clientX', { configurable: true, value: 120 })
  Object.defineProperty(event, 'clientY', { configurable: true, value: 80 })
  return event
}

function buildTypelessDragEvent(): DragEvent {
  const event = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: {
      files: [],
      items: [],
      dropEffect: 'none',
      getData: vi.fn(() => '')
    }
  })
  Object.defineProperty(event, 'clientX', { configurable: true, value: 120 })
  Object.defineProperty(event, 'clientY', { configurable: true, value: 80 })
  return event
}

function FileIntakeHarness({
  addTextToCanvas,
  addImageToCanvas = vi.fn<TestAddImageToCanvas>().mockResolvedValue(undefined),
  addImagesToCanvas = vi.fn<TestAddImagesToCanvas>().mockResolvedValue(undefined),
  addFileToCanvas = vi.fn<TestAddFileToCanvas>().mockResolvedValue(undefined),
  notifyWarning = vi.fn<TestNotifyWarning>(),
  onImageBatchImportProgress = vi.fn<TestImageBatchImportProgress>(),
  quickAppTargetActive = false,
  withExternalInput = false,
  initialCanvasActive = true
}: {
  addTextToCanvas: TestAddTextToCanvas
  addImageToCanvas?: TestAddImageToCanvas
  addImagesToCanvas?: TestAddImagesToCanvas
  addFileToCanvas?: TestAddFileToCanvas
  notifyWarning?: TestNotifyWarning
  onImageBatchImportProgress?: TestImageBatchImportProgress
  quickAppTargetActive?: boolean
  withExternalInput?: boolean
  initialCanvasActive?: boolean
}) {
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const canvasActiveRef = useRef(initialCanvasActive)

  const { handleDrop, handleDragOver } = useCanvasFileIntake({
    canvasId: 'canvas-1',
    canvasContainerRef,
    canvasActiveRef,
    notifyWarning,
    addImageToCanvas,
    addImagesToCanvas,
    addModel3DToCanvas: vi.fn().mockResolvedValue(undefined),
    addModel3DUrlToCanvas: vi.fn(),
    addVideoToCanvas: vi.fn().mockResolvedValue(undefined),
    addFileToCanvas,
    addOcrResultToCanvas: vi.fn().mockResolvedValue(undefined),
    addTextToCanvas,
    handleImportCanvasSceneFile: vi.fn().mockResolvedValue(undefined),
    handleImportPsdFile: vi.fn().mockResolvedValue(undefined),
    focusCanvasStage: () => {
      canvasActiveRef.current = true
      canvasContainerRef.current?.focus()
    },
    onImageBatchImportProgress
  })

  useEffect(() => {
    if (!quickAppTargetActive) {
      return
    }

    const token = Symbol('quick-app-target')
    activateQuickAppImagePasteTarget(token)

    return () => {
      deactivateQuickAppImagePasteTarget(token)
    }
  }, [quickAppTargetActive])

  return (
    <>
      {withExternalInput ? <textarea data-testid="external-editor" /> : null}
      <div
        ref={canvasContainerRef}
        data-testid="canvas-paste-surface"
        tabIndex={0}
        onFocus={() => {
          canvasActiveRef.current = true
        }}
        onBlur={() => {
          canvasActiveRef.current = false
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        canvas
      </div>
    </>
  )
}

afterEach(() => {
  cleanup()
  delete window.electronFile
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL
    })
  } else {
    delete (URL as unknown as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL
  }
  if (originalCreateImageBitmap) {
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: originalCreateImageBitmap
    })
  } else {
    Reflect.deleteProperty(globalThis, 'createImageBitmap')
  }
  resetQuickAppImagePasteTargetsForTest()
  vi.restoreAllMocks()
})

beforeEach(() => {
  const clipboardMock: ClipboardMock = {
    read: vi.fn().mockResolvedValue([]),
    readText: vi.fn().mockResolvedValue('')
  }
  const nativeClipboardMock: NativeClipboardMock = {
    readClipboardImage: vi.fn().mockResolvedValue({ success: false }),
    readClipboardHtml: vi.fn().mockResolvedValue({ html: '' }),
    readClipboardText: vi.fn().mockResolvedValue({ text: '' })
  }

  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: clipboardMock
  })

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      svcHyper: nativeClipboardMock
    }
  })
})

describe('useCanvasFileIntake', () => {
  it('handles Ctrl+V by reading plain text directly from the clipboard when the canvas is active', async () => {
    const addTextToCanvas = vi.fn()
    const clipboard = window.navigator.clipboard as unknown as ClipboardMock
    clipboard.readText.mockResolvedValue('Pasted via shortcut')

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} />)

    const canvas = screen.getByTestId('canvas-paste-surface')
    canvas.focus()

    fireEvent.keyDown(window, { key: 'v', code: 'KeyV', ctrlKey: true })

    await waitFor(() => {
      expect(addTextToCanvas).toHaveBeenCalledWith('Pasted via shortcut')
    })
  })

  it('handles Ctrl+V even when the canvas surface is not currently focused', async () => {
    const addTextToCanvas = vi.fn()
    const clipboard = window.navigator.clipboard as unknown as ClipboardMock
    clipboard.readText.mockResolvedValue('Pasted after returning from another app')

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} initialCanvasActive={false} />)

    fireEvent.keyDown(window, { key: 'v', code: 'KeyV', ctrlKey: true })

    await waitFor(() => {
      expect(addTextToCanvas).toHaveBeenCalledWith('Pasted after returning from another app')
    })
  })

  it('does not paste into the canvas while a quick-app image paste target is active', async () => {
    const addTextToCanvas = vi.fn()

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} quickAppTargetActive />)

    const canvas = screen.getByTestId('canvas-paste-surface')
    canvas.focus()

    window.dispatchEvent(buildClipboardPasteEvent({ text: 'Canvas paste payload' }))

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(addTextToCanvas).not.toHaveBeenCalled()
  })

  it('does not route Ctrl+V into the canvas while a quick-app image paste target is active', async () => {
    const addTextToCanvas = vi.fn()
    const clipboard = window.navigator.clipboard as unknown as ClipboardMock
    clipboard.readText.mockResolvedValue('Blocked by quick app target')

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} quickAppTargetActive />)

    const canvas = screen.getByTestId('canvas-paste-surface')
    canvas.focus()

    fireEvent.keyDown(window, { key: 'v', code: 'KeyV', ctrlKey: true })

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(addTextToCanvas).not.toHaveBeenCalled()
  })

  it('does not paste the same clipboard image twice when the browser paste event is slower than the fallback timer', async () => {
    const addTextToCanvas = vi.fn()
    const addImageToCanvas = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => window.setTimeout(resolve, 80)))
    const clipboard = window.navigator.clipboard as unknown as ClipboardMock
    clipboard.read.mockResolvedValue([
      {
        types: ['image/png'],
        getType: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
      }
    ])

    render(
      <FileIntakeHarness addTextToCanvas={addTextToCanvas} addImageToCanvas={addImageToCanvas} />
    )

    const canvas = screen.getByTestId('canvas-paste-surface')
    canvas.focus()

    fireEvent.keyDown(window, { key: 'v', code: 'KeyV', ctrlKey: true })

    const pasteProxy = document.querySelector(
      '[data-canvas-paste-proxy="true"]'
    ) as HTMLTextAreaElement | null
    pasteProxy?.dispatchEvent(
      buildClipboardPasteEvent({
        includeItems: false,
        files: [new File(['png'], 'slow-paste.png', { type: 'image/png' })]
      })
    )

    await new Promise((resolve) => window.setTimeout(resolve, 160))

    expect(addImageToCanvas).toHaveBeenCalledTimes(1)
  })

  it('does not paste into the canvas while an external text editor is focused', async () => {
    const addTextToCanvas = vi.fn()

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} withExternalInput />)

    screen.getByTestId('external-editor').focus()
    window.dispatchEvent(buildClipboardPasteEvent({ text: 'Sidebar prompt' }))

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(addTextToCanvas).not.toHaveBeenCalled()
  })

  it('claims the paste event before document listeners can consume the same clipboard payload', async () => {
    const addTextToCanvas = vi.fn()
    const competingDocumentPasteListener = vi.fn()

    document.addEventListener('paste', competingDocumentPasteListener)

    try {
      render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} />)

      const canvas = screen.getByTestId('canvas-paste-surface')
      canvas.focus()
      canvas.dispatchEvent(
        buildClipboardPasteEvent({
          text: 'Canvas-owned payload'
        })
      )

      await waitFor(() => {
        expect(addTextToCanvas).toHaveBeenCalledWith('Canvas-owned payload')
      })

      expect(competingDocumentPasteListener).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('paste', competingDocumentPasteListener)
    }
  })

  it('handles external paste text exposed only via clipboardData.getData', async () => {
    const addTextToCanvas = vi.fn()
    const clipboard = window.navigator.clipboard as unknown as ClipboardMock
    clipboard.read.mockRejectedValue(new Error('blocked'))
    clipboard.readText.mockRejectedValue(new Error('blocked'))

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} />)

    const canvas = screen.getByTestId('canvas-paste-surface')
    canvas.focus()

    window.dispatchEvent(
      buildClipboardPasteEvent({
        text: 'External clipboard payload',
        includeItems: false
      })
    )

    await waitFor(() => {
      expect(addTextToCanvas).toHaveBeenCalledWith('External clipboard payload')
    })
  })

  it('pastes structured clipboard HTML as canvas text', async () => {
    const addTextToCanvas = vi.fn()
    const clipboard = window.navigator.clipboard as unknown as ClipboardMock
    clipboard.read.mockRejectedValue(new Error('blocked'))
    clipboard.readText.mockRejectedValue(new Error('blocked'))

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} />)

    const canvas = screen.getByTestId('canvas-paste-surface')
    canvas.focus()

    window.dispatchEvent(
      buildClipboardPasteEvent({
        text: 'Name\tScore\nAlice\t95',
        html: '<table><tr><td>Name</td><td>Score</td></tr><tr><td>Alice</td><td>95</td></tr></table>',
        includeItems: false
      })
    )

    await waitFor(() => {
      expect(addTextToCanvas).toHaveBeenCalledWith('Name\tScore\nAlice\t95')
    })
  })

  it('accepts pasted clipboard files for canvas-supported office/text formats', async () => {
    const addTextToCanvas = vi.fn()
    const addFileToCanvas = vi.fn<TestAddFileToCanvas>().mockResolvedValue(undefined)

    render(
      <FileIntakeHarness addTextToCanvas={addTextToCanvas} addFileToCanvas={addFileToCanvas} />
    )

    const canvas = screen.getByTestId('canvas-paste-surface')
    canvas.focus()

    window.dispatchEvent(
      buildClipboardPasteEvent({
        includeItems: false,
        files: [new File(['name,score\nAlice,95'], 'scores.csv', { type: 'text/csv' })]
      })
    )

    await waitFor(() => {
      expect(addFileToCanvas).toHaveBeenCalledTimes(1)
    })

    expect(addFileToCanvas.mock.calls[0]?.[0]).toMatchObject({
      name: 'scores.csv',
      type: 'text/csv'
    })
    expect(addTextToCanvas).not.toHaveBeenCalled()
  })

  it('explicitly rejects unsupported .pur drops', async () => {
    const addTextToCanvas = vi.fn()
    const addImageToCanvas = vi.fn<TestAddImageToCanvas>().mockResolvedValue(undefined)
    const addFileToCanvas = vi.fn<TestAddFileToCanvas>().mockResolvedValue(undefined)
    const notifyWarning = vi.fn<TestNotifyWarning>()
    const purFile = new File(['pur'], '1(1).pur', { type: 'application/octet-stream' })

    render(
      <FileIntakeHarness
        addTextToCanvas={addTextToCanvas}
        addImageToCanvas={addImageToCanvas}
        addFileToCanvas={addFileToCanvas}
        notifyWarning={notifyWarning}
      />
    )

    fireEvent.drop(screen.getByTestId('canvas-paste-surface'), {
      clientX: 320,
      clientY: 240,
      dataTransfer: {
        files: [purFile],
        items: [],
        getData: vi.fn(() => '')
      }
    })

    await waitFor(() => {
      expect(notifyWarning).toHaveBeenCalledWith(
        'PureRef .pur files are not supported by MagicPot Project Canvas.'
      )
    })

    expect(addImageToCanvas).not.toHaveBeenCalled()
    expect(addFileToCanvas).not.toHaveBeenCalled()
    expect(addTextToCanvas).not.toHaveBeenCalled()
  })

  it('releases document-level external drop interception after unmount', async () => {
    const addTextToCanvas = vi.fn()
    const competingDocumentDropListener = vi.fn()
    const imageFile = new File(['png'], 'after-unmount.png', { type: 'image/png' })
    const { unmount } = render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} />)

    unmount()
    document.addEventListener('drop', competingDocumentDropListener)

    try {
      const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
      Object.defineProperty(event, 'dataTransfer', {
        configurable: true,
        value: {
          files: [imageFile],
          items: [],
          types: ['Files'],
          getData: vi.fn(() => '')
        }
      })
      Object.defineProperty(event, 'clientX', { configurable: true, value: 120 })
      Object.defineProperty(event, 'clientY', { configurable: true, value: 80 })

      document.dispatchEvent(event)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(competingDocumentDropListener).toHaveBeenCalledTimes(1)
      expect(event.defaultPrevented).toBe(false)
    } finally {
      document.removeEventListener('drop', competingDocumentDropListener)
    }
  })

  it('claims document-level external file drags even when the browser exposes only URI list types', async () => {
    const addTextToCanvas = vi.fn()

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} />)

    const dragOverEvent = buildTypeOnlyFileDragEvent(['text/uri-list'])
    document.dispatchEvent(dragOverEvent)

    expect(dragOverEvent.defaultPrevented).toBe(true)
    expect(dragOverEvent.dataTransfer?.dropEffect).toBe('copy')
  })

  it('ignores internal drags when DataTransfer exposes no type list', async () => {
    const addTextToCanvas = vi.fn()

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} />)

    const dragOverEvent = buildTypelessDragEvent()
    document.dispatchEvent(dragOverEvent)

    expect(dragOverEvent.defaultPrevented).toBe(false)
    expect(dragOverEvent.dataTransfer?.dropEffect).toBe('none')
  })

  it('does not claim external file drags over the agent workspace', async () => {
    const addTextToCanvas = vi.fn()
    const addImageToCanvas = vi.fn<TestAddImageToCanvas>().mockResolvedValue(undefined)
    const agentDragOverListener = vi.fn()
    const agentDropListener = vi.fn()
    const imageFile = new File(['png'], 'agent-reference.png', { type: 'image/png' })
    const agentRoot = document.createElement('div')
    const agentThread = document.createElement('div')
    agentRoot.dataset.agentWorkspaceRoot = 'canvas-1'
    agentThread.textContent = 'agent thread'
    agentRoot.appendChild(agentThread)
    document.body.appendChild(agentRoot)

    render(
      <FileIntakeHarness addTextToCanvas={addTextToCanvas} addImageToCanvas={addImageToCanvas} />
    )

    agentRoot.addEventListener('dragover', agentDragOverListener)
    agentRoot.addEventListener('drop', agentDropListener)

    try {
      const dragOverEvent = buildFileDragEvent('dragover', [imageFile])
      const dropEvent = buildFileDragEvent('drop', [imageFile])

      agentThread.dispatchEvent(dragOverEvent)
      agentThread.dispatchEvent(dropEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(agentDragOverListener).toHaveBeenCalledTimes(1)
      expect(agentDropListener).toHaveBeenCalledTimes(1)
      expect(dragOverEvent.defaultPrevented).toBe(false)
      expect(dropEvent.defaultPrevented).toBe(false)
      expect(addImageToCanvas).not.toHaveBeenCalled()
    } finally {
      agentRoot.removeEventListener('dragover', agentDragOverListener)
      agentRoot.removeEventListener('drop', agentDropListener)
      agentRoot.remove()
    }
  })

  it('does not claim external file drops when pointer hit-testing is over the agent workspace', async () => {
    const addTextToCanvas = vi.fn()
    const addImageToCanvas = vi.fn<TestAddImageToCanvas>().mockResolvedValue(undefined)
    const imageFile = new File(['png'], 'agent-reference.png', { type: 'image/png' })
    const agentRoot = document.createElement('div')
    const originalElementsFromPoint = document.elementsFromPoint
    agentRoot.dataset.agentWorkspaceRoot = 'canvas-1'
    document.body.appendChild(agentRoot)
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [agentRoot])
    })

    render(
      <FileIntakeHarness addTextToCanvas={addTextToCanvas} addImageToCanvas={addImageToCanvas} />
    )

    try {
      const dropEvent = buildFileDragEvent('drop', [imageFile])

      screen.getByTestId('canvas-paste-surface').dispatchEvent(dropEvent)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(dropEvent.defaultPrevented).toBe(false)
      expect(addImageToCanvas).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: originalElementsFromPoint
      })
      agentRoot.remove()
    }
  })

  it('uses local-media URLs for Electron local image batches instead of reading every file as data URLs', async () => {
    const addTextToCanvas = vi.fn()
    const addImagesToCanvas = vi.fn<TestAddImagesToCanvas>().mockResolvedValue(undefined)
    const firstImage = new File(['png'], 'first.png', { type: 'image/png' })
    const secondImage = new File(['png'], 'second.png', { type: 'image/png' })
    Object.defineProperty(firstImage, 'path', {
      configurable: true,
      value: 'C:\\assets\\first.png'
    })
    Object.defineProperty(secondImage, 'path', {
      configurable: true,
      value: 'C:\\assets\\second.png'
    })

    render(
      <FileIntakeHarness addTextToCanvas={addTextToCanvas} addImagesToCanvas={addImagesToCanvas} />
    )

    fireEvent.drop(screen.getByTestId('canvas-paste-surface'), {
      dataTransfer: {
        files: [firstImage, secondImage],
        items: [],
        getData: vi.fn(() => '')
      }
    })

    await waitFor(() => {
      expect(addImagesToCanvas).toHaveBeenCalledTimes(1)
    })

    expect(addImagesToCanvas.mock.calls[0]?.[0]).toEqual([
      {
        src: 'local-media:///C:/assets/first.png',
        fileName: 'first.png',
        sizeBytes: firstImage.size,
        sourceFile: firstImage
      },
      {
        src: 'local-media:///C:/assets/second.png',
        fileName: 'second.png',
        sizeBytes: secondImage.size,
        sourceFile: secondImage
      }
    ])
  })

  it('reports progress while preparing large local image batches', async () => {
    const addTextToCanvas = vi.fn()
    const addImagesToCanvas = vi.fn<TestAddImagesToCanvas>().mockResolvedValue(undefined)
    const onImageBatchImportProgress = vi.fn<TestImageBatchImportProgress>()
    const imageFiles = Array.from({ length: 50 }, (_, index) => {
      const file = new File(['png'], `batch-${index + 1}.png`, { type: 'image/png' })
      Object.defineProperty(file, 'path', {
        configurable: true,
        value: `C:\\assets\\batch-${index + 1}.png`
      })
      return file
    })

    render(
      <FileIntakeHarness
        addTextToCanvas={addTextToCanvas}
        addImagesToCanvas={addImagesToCanvas}
        onImageBatchImportProgress={onImageBatchImportProgress}
      />
    )

    fireEvent.drop(screen.getByTestId('canvas-paste-surface'), {
      dataTransfer: {
        files: imageFiles,
        items: [],
        getData: vi.fn(() => '')
      }
    })

    await waitFor(() => {
      expect(addImagesToCanvas).toHaveBeenCalledTimes(1)
    })

    expect(onImageBatchImportProgress).toHaveBeenCalledWith({
      phase: 'preparing',
      total: imageFiles.length,
      processed: 0,
      imported: 0,
      failed: 0
    })
    expect(onImageBatchImportProgress).toHaveBeenCalledWith({
      phase: 'preparing',
      total: imageFiles.length,
      processed: 48,
      imported: 0,
      failed: 0
    })
    expect(onImageBatchImportProgress).toHaveBeenCalledWith({
      phase: 'preparing',
      total: imageFiles.length,
      processed: imageFiles.length,
      imported: 0,
      failed: 0
    })
  })

  it('passes PNG header dimensions to the canvas image intake without decoding the file', async () => {
    const addTextToCanvas = vi.fn()
    const addImageToCanvas = vi.fn<TestAddImageToCanvas>().mockResolvedValue(undefined)
    const imageFile = new File([buildPngHeader(19717, 12079, 6)], 'huge.png', {
      type: 'image/png'
    })
    Object.defineProperty(imageFile, 'path', {
      configurable: true,
      value: 'C:\\assets\\huge.png'
    })

    render(
      <FileIntakeHarness addTextToCanvas={addTextToCanvas} addImageToCanvas={addImageToCanvas} />
    )

    fireEvent.drop(screen.getByTestId('canvas-paste-surface'), {
      dataTransfer: {
        files: [imageFile],
        items: [],
        getData: vi.fn(() => '')
      }
    })

    await waitFor(() => {
      expect(addImageToCanvas).toHaveBeenCalledTimes(1)
    })

    expect(addImageToCanvas.mock.calls[0]?.[0]).toBe('local-media:///C:/assets/huge.png')
    expect(addImageToCanvas.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        fileName: 'huge.png',
        sizeBytes: imageFile.size,
        hasAlpha: true,
        sourceWidthHint: 19717,
        sourceHeightHint: 12079,
        sourceFile: imageFile
      })
    )
  })

  it('adds local source identity metadata when the thumbnail service resolves file metadata', async () => {
    const addTextToCanvas = vi.fn()
    const addImageToCanvas = vi.fn<TestAddImageToCanvas>().mockResolvedValue(undefined)
    const imageFile = new File([buildPngHeader(640, 320, 6)], 'identity.png', {
      type: 'image/png'
    })
    Object.defineProperty(imageFile, 'path', {
      configurable: true,
      value: 'C:\\assets\\identity.png'
    })
    const lastModifiedMs = 1712345678000

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        svcHyper: window.api.svcHyper,
        svcCanvasThumbnail: {
          getSourceFileMetadata: vi.fn(async () => ({
            exists: true,
            canonicalPath: 'C:\\assets\\identity.png',
            sizeBytes: imageFile.size,
            lastModifiedMs
          }))
        }
      }
    })

    render(
      <FileIntakeHarness addTextToCanvas={addTextToCanvas} addImageToCanvas={addImageToCanvas} />
    )

    fireEvent.drop(screen.getByTestId('canvas-paste-surface'), {
      dataTransfer: {
        files: [imageFile],
        items: [],
        getData: vi.fn(() => '')
      }
    })

    await waitFor(() => {
      expect(addImageToCanvas).toHaveBeenCalledTimes(1)
    })

    expect(addImageToCanvas.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        sourceIdentity: buildCanvasImageSourceIdentity({
          canonicalPath: 'C:\\assets\\identity.png',
          sizeBytes: imageFile.size,
          lastModifiedMs
        })
      })
    )
  })

  it('passes the original source file for non-PNG image intake', async () => {
    const addTextToCanvas = vi.fn()
    const addImageToCanvas = vi.fn<TestAddImageToCanvas>().mockResolvedValue(undefined)
    const bitmapClose = vi.fn()
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(async () => ({
        width: 3136,
        height: 2624,
        close: bitmapClose
      }))
    })
    const imageFile = new File(['jpeg-bytes'], 'wide.jpg', {
      type: 'image/jpeg'
    })
    Object.defineProperty(imageFile, 'path', {
      configurable: true,
      value: 'C:\\assets\\wide.jpg'
    })

    render(
      <FileIntakeHarness addTextToCanvas={addTextToCanvas} addImageToCanvas={addImageToCanvas} />
    )

    fireEvent.drop(screen.getByTestId('canvas-paste-surface'), {
      dataTransfer: {
        files: [imageFile],
        items: [],
        getData: vi.fn(() => '')
      }
    })

    await waitFor(() => {
      expect(addImageToCanvas).toHaveBeenCalledTimes(1)
    })

    expect(addImageToCanvas.mock.calls[0]?.[0]).toBe('local-media:///C:/assets/wide.jpg')
    expect(addImageToCanvas.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        fileName: 'wide.jpg',
        sizeBytes: imageFile.size,
        sourceWidthHint: 3136,
        sourceHeightHint: 2624,
        sourceFile: imageFile
      })
    )
    expect(globalThis.createImageBitmap).toHaveBeenCalledWith(imageFile)
    expect(bitmapClose).toHaveBeenCalledTimes(1)
  })

  it('uses the Electron file bridge when File.path is unavailable', async () => {
    const addTextToCanvas = vi.fn()
    const addImagesToCanvas = vi.fn<TestAddImagesToCanvas>().mockResolvedValue(undefined)
    const firstImage = new File(['png'], 'first.png', { type: 'image/png' })
    const secondImage = new File(['png'], 'second.png', { type: 'image/png' })
    const getPathForFile = vi.fn((file: File) =>
      file.name === 'first.png' ? 'C:\\bridge\\first.png' : 'C:\\bridge\\second.png'
    )

    Object.defineProperty(window, 'electronFile', {
      configurable: true,
      value: { getPathForFile }
    })

    render(
      <FileIntakeHarness addTextToCanvas={addTextToCanvas} addImagesToCanvas={addImagesToCanvas} />
    )

    fireEvent.drop(screen.getByTestId('canvas-paste-surface'), {
      dataTransfer: {
        files: [firstImage, secondImage],
        items: [],
        getData: vi.fn(() => '')
      }
    })

    await waitFor(() => {
      expect(addImagesToCanvas).toHaveBeenCalledTimes(1)
    })

    expect(getPathForFile).toHaveBeenCalledTimes(2)
    expect(addImagesToCanvas.mock.calls[0]?.[0]).toEqual([
      {
        src: 'local-media:///C:/bridge/first.png',
        fileName: 'first.png',
        sizeBytes: firstImage.size,
        sourceFile: firstImage
      },
      {
        src: 'local-media:///C:/bridge/second.png',
        fileName: 'second.png',
        sizeBytes: secondImage.size,
        sourceFile: secondImage
      }
    ])
  })

  it('falls back to blob URLs for image batches without a local filesystem path', async () => {
    const addTextToCanvas = vi.fn()
    const addImagesToCanvas = vi.fn<TestAddImagesToCanvas>().mockResolvedValue(undefined)
    const firstImage = new File(['png'], 'first.png', { type: 'image/png' })
    const secondImage = new File(['png'], 'second.png', { type: 'image/png' })
    const createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`)
    const readAsDataURL = vi.spyOn(FileReader.prototype, 'readAsDataURL')

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL
    })

    render(
      <FileIntakeHarness addTextToCanvas={addTextToCanvas} addImagesToCanvas={addImagesToCanvas} />
    )

    fireEvent.drop(screen.getByTestId('canvas-paste-surface'), {
      dataTransfer: {
        files: [firstImage, secondImage],
        items: [],
        getData: vi.fn(() => '')
      }
    })

    await waitFor(() => {
      expect(addImagesToCanvas).toHaveBeenCalledTimes(1)
    })

    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(readAsDataURL).not.toHaveBeenCalled()
    expect(addImagesToCanvas.mock.calls[0]?.[0]).toEqual([
      {
        src: 'blob:first.png',
        fileName: 'first.png',
        sizeBytes: firstImage.size,
        sourceFile: firstImage
      },
      {
        src: 'blob:second.png',
        fileName: 'second.png',
        sizeBytes: secondImage.size,
        sourceFile: secondImage
      }
    ])
  })

  it('falls back to navigator clipboard text and keeps tabular data as text', async () => {
    const addTextToCanvas = vi.fn()
    const clipboard = window.navigator.clipboard as unknown as ClipboardMock
    clipboard.read.mockRejectedValue(new Error('blocked'))
    clipboard.readText.mockResolvedValue('Name\tScore\nAlice\t95')

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} />)

    fireEvent.keyDown(window, { key: 'v', code: 'KeyV', ctrlKey: true })

    await waitFor(() => {
      expect(addTextToCanvas).toHaveBeenCalledWith('Name\tScore\nAlice\t95')
    })
  })

  it('falls back to the native clipboard API when web clipboard access is unavailable', async () => {
    const addTextToCanvas = vi.fn()
    const clipboard = window.navigator.clipboard as unknown as ClipboardMock
    const nativeClipboard = window.api.svcHyper as unknown as NativeClipboardMock
    clipboard.read.mockRejectedValue(new Error('blocked'))
    clipboard.readText.mockRejectedValue(new Error('blocked'))
    nativeClipboard.readClipboardText.mockResolvedValue({ text: 'Native clipboard payload' })

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} initialCanvasActive={false} />)

    fireEvent.keyDown(window, { key: 'v', code: 'KeyV', ctrlKey: true })

    await waitFor(() => {
      expect(addTextToCanvas).toHaveBeenCalledWith('Native clipboard payload')
    })
  })

  it('falls back to native clipboard HTML as plain canvas text', async () => {
    const addTextToCanvas = vi.fn()
    const clipboard = window.navigator.clipboard as unknown as ClipboardMock
    const nativeClipboard = window.api.svcHyper as unknown as NativeClipboardMock
    clipboard.read.mockRejectedValue(new Error('blocked'))
    clipboard.readText.mockRejectedValue(new Error('blocked'))
    nativeClipboard.readClipboardHtml.mockResolvedValue({
      html: '<table><tr><td>Name</td><td>Score</td></tr><tr><td>Alice</td><td>95</td></tr></table>'
    })
    nativeClipboard.readClipboardText.mockResolvedValue({ text: '' })

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} initialCanvasActive={false} />)

    fireEvent.keyDown(window, { key: 'v', code: 'KeyV', ctrlKey: true })

    await waitFor(() => {
      expect(addTextToCanvas).toHaveBeenCalledWith('Name\tScore\nAlice\t95')
    })
  })

  it('accepts a native paste event routed through the hidden canvas paste proxy', async () => {
    const addTextToCanvas = vi.fn()

    render(<FileIntakeHarness addTextToCanvas={addTextToCanvas} />)

    const pasteProxy = document.querySelector(
      '[data-canvas-paste-proxy="true"]'
    ) as HTMLTextAreaElement | null

    expect(pasteProxy).toBeTruthy()
    pasteProxy?.focus()
    pasteProxy?.dispatchEvent(
      buildClipboardPasteEvent({
        text: 'Proxy paste payload'
      })
    )

    await waitFor(() => {
      expect(addTextToCanvas).toHaveBeenCalledWith('Proxy paste payload')
    })
  })
})
