import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageContextMenu from './ImageContextMenu'

const notifySuccessMock = vi.fn()
const notifyErrorMock = vi.fn()
const saveImageToDirMock = vi.fn()
const readFileFromPathMock = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: notifySuccessMock,
    notifyError: notifyErrorMock
  })
}))

const renderImageContextMenu = (imageUrl = 'blob:chat-image') =>
  render(
    <ThemeProvider theme={createTheme()}>
      <ImageContextMenu
        imageContextMenu={{ mouseX: 10, mouseY: 12, imageUrl }}
        onClose={vi.fn()}
        config={{ download_dir: 'C:/downloads' }}
      />
    </ThemeProvider>
  )

describe('ImageContextMenu', () => {
  beforeEach(() => {
    notifySuccessMock.mockReset()
    notifyErrorMock.mockReset()
    saveImageToDirMock.mockReset()
    saveImageToDirMock.mockResolvedValue({ savedPath: 'C:/downloads/image.png' })
    readFileFromPathMock.mockReset()
    readFileFromPathMock.mockResolvedValue({
      data: new Uint8Array([4, 5, 6]),
      filename: 'render.png'
    })
    localStorage.removeItem('qapp.downloadDir')

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        blob: vi.fn().mockResolvedValue({
          arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
        })
      })
    )

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        svcHyper: {
          saveImageToDir: saveImageToDirMock,
          writeImageToClipboard: vi.fn()
        },
        svcDialog: {
          showOpenDialog: vi.fn()
        },
        svcFs: {
          readFileFromPath: readFileFromPathMock
        },
        svcState: {
          saveConfig: vi.fn()
        },
        svcPhotoshop: {
          sendImageToPhotoshop: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('saves an image without showing a success toast', async () => {
    renderImageContextMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.save_image' }))

    await waitFor(() => {
      expect(saveImageToDirMock).toHaveBeenCalledTimes(1)
    })

    expect(notifySuccessMock).not.toHaveBeenCalled()
    expect(notifyErrorMock).not.toHaveBeenCalled()
  })

  it('reads hosted local-media image URLs through the file system bridge', async () => {
    const fetchMock = vi.mocked(fetch)
    renderImageContextMenu('local-media://server/share/folder/render%201.png')

    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.save_image' }))

    await waitFor(() => {
      expect(readFileFromPathMock).toHaveBeenCalledWith({
        fullPath: '//server/share/folder/render 1.png'
      })
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(saveImageToDirMock).toHaveBeenCalledTimes(1)
  })
})
