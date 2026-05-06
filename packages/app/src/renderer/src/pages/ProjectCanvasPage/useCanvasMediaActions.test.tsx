import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodePath from 'path'

import type { CanvasImageItem, CanvasItem, CanvasModel3DItem } from './types'
import { useCanvasMediaActions } from './useCanvasMediaActions'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'chat.image_copied': '图片已复制到剪贴板',
          'chat.image_copy_failed': '复制图片失败'
        }) as Record<string, string>
      )[key] ?? key
  })
}))

const {
  showOpenDialogMock,
  showSaveDialogMock,
  saveImageToPathMock,
  saveImageToDirMock,
  writeImageToClipboardMock,
  getConfigMock,
  saveConfigMock
} = vi.hoisted(() => ({
  showOpenDialogMock: vi.fn(),
  showSaveDialogMock: vi.fn(),
  saveImageToPathMock: vi.fn(),
  saveImageToDirMock: vi.fn(),
  writeImageToClipboardMock: vi.fn(),
  getConfigMock: vi.fn(),
  saveConfigMock: vi.fn()
}))

vi.mock('../../utils/windowUtils', () => ({
  api: () => ({
    svcDialog: {
      showOpenDialog: showOpenDialogMock,
      showSaveDialog: showSaveDialogMock
    },
    svcFs: {
      saveImageToPath: saveImageToPathMock
    },
    svcHyper: {
      saveImageToDir: saveImageToDirMock,
      writeImageToClipboard: writeImageToClipboardMock
    },
    svcState: {
      getConfig: getConfigMock,
      saveConfig: saveConfigMock
    }
  })
}))

function createImageItem(): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'blob:image-1',
    fileName: 'selected-image.png',
    x: 0,
    y: 0,
    width: 320,
    height: 240,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false
  }
}

function createModelItem(overrides: Partial<CanvasModel3DItem> = {}): CanvasModel3DItem {
  return {
    id: 'model-1',
    type: 'model3d',
    src: 'https://example.com/model.fbx',
    fileName: 'model.fbx',
    x: 0,
    y: 0,
    width: 320,
    height: 240,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  }
}

function MediaActionsProbe({
  renderCanvasItemsImageBytes,
  notifySuccess,
  notifyError
}: {
  renderCanvasItemsImageBytes: (
    targetItems: CanvasItem[],
    format: 'png' | 'jpeg' | 'svg',
    includeBackground?: boolean
  ) => Promise<Uint8Array>
  notifySuccess: (message: string) => unknown
  notifyError: (message: string) => unknown
}) {
  const { handleDownloadCanvasItemsAsImage, handleCopyCanvasItemsAsImage } = useCanvasMediaActions({
    notifySuccess,
    notifyError,
    renderCanvasItemsImageBytes
  })

  return (
    <>
      <button
        type="button"
        onClick={() => void handleDownloadCanvasItemsAsImage([createImageItem()], 'selected-image')}
      >
        Download
      </button>
      <button type="button" onClick={() => void handleCopyCanvasItemsAsImage([createImageItem()])}>
        Copy
      </button>
    </>
  )
}

function BlobMediaActionsProbe({
  item,
  notifySuccess,
  notifyError
}: {
  item: CanvasModel3DItem
  notifySuccess: (message: string) => unknown
  notifyError: (message: string) => unknown
}) {
  const { handleDownloadBlobItem } = useCanvasMediaActions({
    notifySuccess,
    notifyError,
    renderCanvasItemsImageBytes: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]))
  })

  return (
    <button type="button" onClick={() => void handleDownloadBlobItem(item)}>
      Download Blob
    </button>
  )
}

describe('useCanvasMediaActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    showOpenDialogMock.mockReset()
    showSaveDialogMock.mockReset()
    saveImageToPathMock.mockReset()
    saveImageToDirMock.mockReset()
    writeImageToClipboardMock.mockReset()
    getConfigMock.mockReset()
    saveConfigMock.mockReset()
    getConfigMock.mockResolvedValue({ config: {} })
    saveConfigMock.mockResolvedValue({})
    localStorage.clear()
    ;(window as unknown as { path?: typeof nodePath.win32 }).path = nodePath.win32

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        blob: vi.fn().mockResolvedValue({
          arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer)
        })
      })
    )
  })

  it('opens a save dialog for every image download and exposes png/jpg/jpeg/svg filters', async () => {
    const notifySuccess = vi.fn()
    const notifyError = vi.fn()
    const renderCanvasItemsImageBytes = vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3, 4]))

    showSaveDialogMock
      .mockResolvedValueOnce({
        canceled: false,
        filePath: 'C:/exports/selected-image.png'
      })
      .mockResolvedValueOnce({
        canceled: false,
        filePath: 'C:/exports/selected-image-2.png'
      })

    render(
      <MediaActionsProbe
        renderCanvasItemsImageBytes={renderCanvasItemsImageBytes}
        notifySuccess={notifySuccess}
        notifyError={notifyError}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })

    await waitFor(() => {
      expect(saveImageToPathMock).toHaveBeenCalledWith({
        image: expect.any(Uint8Array),
        outputPath: 'C:/exports',
        filename: 'selected-image.png'
      })
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })

    await waitFor(() => {
      expect(showSaveDialogMock).toHaveBeenCalledTimes(2)
      expect(saveImageToPathMock).toHaveBeenCalledTimes(2)
    })

    expect(showOpenDialogMock).not.toHaveBeenCalled()
    expect(getConfigMock).not.toHaveBeenCalled()
    expect(saveConfigMock).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
    expect(notifySuccess).toHaveBeenCalledWith('Saved selected-image.png')
    expect(renderCanvasItemsImageBytes).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ id: 'image-1' })],
      'png',
      false
    )
    expect(showSaveDialogMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: 'Save exported image',
        filters: [
          { name: 'PNG Image', extensions: ['png'] },
          { name: 'JPG Image', extensions: ['jpg'] },
          { name: 'JPEG Image', extensions: ['jpeg'] },
          { name: 'SVG Image', extensions: ['svg'] }
        ]
      })
    )
  })

  it('writes an svg wrapper when the user saves as svg', async () => {
    const notifySuccess = vi.fn()
    const notifyError = vi.fn()
    const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const renderCanvasItemsImageBytes = vi.fn().mockResolvedValue(svgBytes)

    showSaveDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:/exports/selected-image.svg'
    })

    render(
      <MediaActionsProbe
        renderCanvasItemsImageBytes={renderCanvasItemsImageBytes}
        notifySuccess={notifySuccess}
        notifyError={notifyError}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })

    await waitFor(() => {
      expect(saveImageToPathMock).toHaveBeenCalledTimes(1)
    })

    const payload = saveImageToPathMock.mock.calls[0]?.[0] as {
      image: Uint8Array
      outputPath: string
      filename: string
    }

    expect(payload.outputPath).toBe('C:/exports')
    expect(payload.filename).toBe('selected-image.svg')
    expect(new TextDecoder().decode(payload.image)).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg"'
    )
    expect(renderCanvasItemsImageBytes).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'image-1' })],
      'svg',
      false
    )
    expect(notifyError).not.toHaveBeenCalled()
    expect(notifySuccess).toHaveBeenCalledWith('Saved selected-image.svg')
  })

  it('uses localized clipboard success copy when copying an image snapshot', async () => {
    const notifySuccess = vi.fn()
    const notifyError = vi.fn()
    const renderCanvasItemsImageBytes = vi.fn().mockResolvedValue(Uint8Array.from([9, 8, 7, 6]))

    writeImageToClipboardMock.mockResolvedValue({ success: true })

    render(
      <MediaActionsProbe
        renderCanvasItemsImageBytes={renderCanvasItemsImageBytes}
        notifySuccess={notifySuccess}
        notifyError={notifyError}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })

    await waitFor(() => {
      expect(writeImageToClipboardMock).toHaveBeenCalledWith({
        data: Uint8Array.from([9, 8, 7, 6])
      })
    })

    expect(notifySuccess).toHaveBeenCalledWith('图片已复制到剪贴板')
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('saves a model package even when one texture can not be read', async () => {
    const notifySuccess = vi.fn()
    const notifyError = vi.fn()
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://example.com/model.fbx' || url === 'blob:albedo') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          blob: vi.fn().mockResolvedValue({
            arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer)
          })
        }
      }

      throw new DOMException(
        'The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.'
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['C:/exports']
    })
    getConfigMock.mockResolvedValue({ config: {} })
    saveImageToDirMock.mockResolvedValue({ savedPath: 'C:/exports/model/model.fbx' })

    render(
      <BlobMediaActionsProbe
        item={createModelItem({
          textures: {
            'textures/albedo.png': 'blob:albedo',
            'textures/normal.png': 'blob:missing'
          }
        })}
        notifySuccess={notifySuccess}
        notifyError={notifyError}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Blob' }))
    })

    await waitFor(() => {
      expect(saveImageToDirMock).toHaveBeenCalledTimes(2)
    })

    expect(saveImageToDirMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fileName: 'model.fbx',
        dir: 'C:\\exports\\model'
      })
    )
    expect(saveImageToDirMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fileName: 'albedo.png',
        dir: 'C:\\exports\\model\\textures'
      })
    )
    expect(fetchMock).toHaveBeenCalledWith('blob:missing')
    expect(notifySuccess).toHaveBeenCalledWith('Saved model package with 1/2 texture files')
    expect(notifyError).not.toHaveBeenCalled()
  })
})
