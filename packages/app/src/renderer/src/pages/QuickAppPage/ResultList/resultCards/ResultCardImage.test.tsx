/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import ResultCardImage from './ResultCardImage'

const {
  extractWorkflowFromImageMock,
  showItemInFolderMock,
  listQAppCfgsMock,
  getQAppCfgMock,
  saveImageToDirMock,
  writeImageToClipboardMock,
  sendImageToPhotoshopMock,
  showOpenDialogMock,
  saveConfigMock,
  setWorkflowMock,
  setQAppCfgMock,
  setFormStateValueMock,
  resolveImportedWorkflowMock,
  compareWorkflowsMock,
  notifySuccessMock,
  notifyErrorMock
} = vi.hoisted(() => ({
  extractWorkflowFromImageMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  listQAppCfgsMock: vi.fn().mockResolvedValue({ qApps: [] }),
  getQAppCfgMock: vi.fn(),
  saveImageToDirMock: vi.fn().mockResolvedValue({ savedPath: 'C:/downloads/.AutoSave/qapp.png' }),
  writeImageToClipboardMock: vi.fn().mockResolvedValue({ success: true }),
  sendImageToPhotoshopMock: vi.fn().mockResolvedValue({ success: true }),
  showOpenDialogMock: vi.fn(),
  saveConfigMock: vi.fn(),
  setWorkflowMock: vi.fn(),
  setQAppCfgMock: vi.fn(),
  setFormStateValueMock: vi.fn(),
  resolveImportedWorkflowMock: vi.fn(async (workflow: Record<string, unknown>) => ({ workflow })),
  compareWorkflowsMock: vi.fn(() => false),
  notifySuccessMock: vi.fn(),
  notifyErrorMock: vi.fn()
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  downloadFile: vi.fn(),
  extractWorkflowFromImage: extractWorkflowFromImageMock
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcShell: {
      showItemInFolder: showItemInFolderMock
    },
    svcQApp: {
      listQAppCfgs: listQAppCfgsMock,
      getQAppCfg: getQAppCfgMock
    },
    svcHyper: {
      saveImageToDir: saveImageToDirMock,
      writeImageToClipboard: writeImageToClipboardMock
    },
    svcPhotoshop: {
      sendImageToPhotoshop: sendImageToPhotoshopMock
    },
    svcDialog: {
      showOpenDialog: showOpenDialogMock
    },
    svcState: {
      saveConfig: saveConfigMock
    }
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: notifySuccessMock,
    notifyError: notifyErrorMock
  })
}))

vi.mock('../../components/QAppContext', () => ({
  useQAppContext: () => ({
    setWorkflow: setWorkflowMock,
    setQAppCfg: setQAppCfgMock,
    setFormStateValue: setFormStateValueMock,
    qAppCfg: {}
  })
}))

vi.mock('@renderer/utils/qappUtils', () => ({
  compareWorkflows: compareWorkflowsMock
}))

vi.mock('@renderer/utils/resolveImportedWorkflow', () => ({
  resolveImportedWorkflow: resolveImportedWorkflowMock
}))

vi.mock('@shared/config/configUtils', () => ({
  ConfigUtils: class {
    private readonly outputDir = 'C:/output'

    getOutputDir() {
      return this.outputDir
    }
  }
}))

vi.mock('@renderer/components/ModalLayout', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement('div', { 'data-testid': 'modal-layout' }, children) : null
}))

vi.mock('@renderer/components/ImageCanvas/ImageViewer', () => ({
  __esModule: true,
  default: ({ imageUrl }: { imageUrl: string }) =>
    React.createElement('div', { 'data-testid': 'image-viewer' }, imageUrl)
}))

vi.mock('./components/ResultIconButtonBase', () => ({
  __esModule: true,
  default: ({ tooltip, onClick }: { tooltip: string; onClick: () => void }) => (
    <button type="button" data-testid={tooltip} onClick={onClick}>
      {tooltip}
    </button>
  )
}))

describe('ResultCardImage', () => {
  const originalWindowPath = window.path
  const originalFetch = global.fetch

  beforeEach(() => {
    extractWorkflowFromImageMock.mockReset()
    showItemInFolderMock.mockReset()
    listQAppCfgsMock.mockReset()
    listQAppCfgsMock.mockResolvedValue({ qApps: [] })
    getQAppCfgMock.mockReset()
    saveImageToDirMock.mockClear()
    writeImageToClipboardMock.mockClear()
    sendImageToPhotoshopMock.mockClear()
    showOpenDialogMock.mockReset()
    saveConfigMock.mockReset()
    setWorkflowMock.mockClear()
    setQAppCfgMock.mockClear()
    setFormStateValueMock.mockClear()
    resolveImportedWorkflowMock.mockReset()
    resolveImportedWorkflowMock.mockImplementation(async (workflow: Record<string, unknown>) => ({
      workflow
    }))
    compareWorkflowsMock.mockReset()
    compareWorkflowsMock.mockReturnValue(false)
    notifySuccessMock.mockClear()
    notifyErrorMock.mockClear()

    window.path = {
      join: (...parts: string[]) => parts.join('/')
    } as any

    global.fetch = vi.fn(async () => ({
      blob: async () => {
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) as Blob & {
          arrayBuffer?: () => Promise<ArrayBuffer>
        }
        if (typeof blob.arrayBuffer !== 'function') {
          blob.arrayBuffer = async () => new Uint8Array([1, 2, 3]).buffer
        }
        return blob
      }
    })) as any
  })

  afterEach(() => {
    window.path = originalWindowPath
    global.fetch = originalFetch
  })

  it('restores imported quick app cfg when an embedded image workflow has app-mode metadata', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const importedCfg = { icon: 'image', inputs: [{ id: 'api' }], autoInputs: [] }
    const importedWorkflow = { __qAppKey__: 'image-workflow-app', step: 'image-workflow' }

    extractWorkflowFromImageMock.mockResolvedValue({
      workflow: importedWorkflow,
      source: 'history'
    })
    resolveImportedWorkflowMock.mockResolvedValue({
      workflow: importedWorkflow,
      cfg: importedCfg,
      isAppMode: true,
      warnings: []
    } as any)

    render(
      <ResultCardImage
        result={
          {
            type: 'image',
            id: 'image-1',
            promptId: 'prompt-1',
            objectUrl: 'blob:image-result-1',
            fileItem: {
              filename: 'image-1.png',
              subfolder: 'outputs',
              type: 'output'
            }
          } as any
        }
        index={0}
        config={{ download_dir: 'C:/downloads' } as any}
        buildEnv={{} as any}
      />
    )

    fireEvent.contextMenu(screen.getByRole('img'))
    await waitFor(() => {
      expect(screen.getAllByRole('menuitem')).toHaveLength(3)
    })
    fireEvent.click(screen.getAllByRole('menuitem')[2])

    await waitFor(() => {
      expect(extractWorkflowFromImageMock).toHaveBeenCalledWith('blob:image-result-1', 'prompt-1')
      expect(setWorkflowMock).toHaveBeenCalledWith(importedWorkflow)
      expect(setQAppCfgMock).toHaveBeenCalledWith(importedCfg)
      expect(notifySuccessMock).not.toHaveBeenCalled()
    })

    const qappSwitchEvent = dispatchSpy.mock.calls.find(
      ([event]) => event instanceof CustomEvent && event.type === 'qapp:switch'
    )?.[0] as CustomEvent | undefined
    expect(qappSwitchEvent?.detail).toEqual({
      qAppKey: 'image-workflow-app',
      workflow: importedWorkflow
    })
  })

  it('restores imported quick app cfg when an image workflow matches an existing quick app', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const importedCfg = { icon: 'matched', inputs: [{ id: 'api' }], autoInputs: [] }
    const importedWorkflow = { step: 'matched-workflow' }

    extractWorkflowFromImageMock.mockResolvedValue({
      workflow: importedWorkflow,
      source: 'metadata'
    })
    resolveImportedWorkflowMock.mockResolvedValue({
      workflow: importedWorkflow,
      cfg: importedCfg,
      isAppMode: true,
      warnings: []
    } as any)
    listQAppCfgsMock.mockResolvedValue({
      qApps: [{ key: 'matched-qapp', isDirectory: false }]
    })
    getQAppCfgMock.mockResolvedValue({
      workflow: { saved: 'workflow' }
    })
    compareWorkflowsMock.mockReturnValue(true)

    render(
      <ResultCardImage
        result={
          {
            type: 'image',
            id: 'image-2',
            promptId: 'prompt-2',
            objectUrl: 'blob:image-result-2',
            fileItem: {
              filename: 'image-2.png',
              subfolder: 'outputs',
              type: 'output'
            }
          } as any
        }
        index={1}
        config={{ download_dir: 'C:/downloads' } as any}
        buildEnv={{} as any}
      />
    )

    fireEvent.contextMenu(screen.getByRole('img'))
    await waitFor(() => {
      expect(screen.getAllByRole('menuitem')).toHaveLength(3)
    })
    fireEvent.click(screen.getAllByRole('menuitem')[2])

    await waitFor(() => {
      expect(listQAppCfgsMock).toHaveBeenCalled()
      expect(getQAppCfgMock).toHaveBeenCalledWith({ key: 'matched-qapp' })
      expect(setWorkflowMock).toHaveBeenCalledWith(importedWorkflow)
      expect(setQAppCfgMock).toHaveBeenCalledWith(importedCfg)
      expect(notifySuccessMock).not.toHaveBeenCalled()
    })

    const qappSwitchEvent = dispatchSpy.mock.calls.find(
      ([event]) => event instanceof CustomEvent && event.type === 'qapp:switch'
    )?.[0] as CustomEvent | undefined
    expect(qappSwitchEvent?.detail).toEqual({
      qAppKey: 'matched-qapp',
      workflow: importedWorkflow
    })
  })

  it('includes intrinsic image dimensions in the drag payload for canvas drops', async () => {
    const setData = vi.fn()
    const dataTransfer = {
      setData,
      effectAllowed: ''
    } as unknown as DataTransfer

    render(
      <ResultCardImage
        result={
          {
            type: 'image',
            id: 'image-3',
            promptId: 'prompt-3',
            objectUrl: 'blob:image-result-3',
            fileItem: {
              filename: 'image-3.png',
              subfolder: 'outputs',
              type: 'output'
            }
          } as any
        }
        index={2}
        config={{ download_dir: 'C:/downloads' } as any}
        buildEnv={{} as any}
      />
    )

    const image = screen.getByRole('img')
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1536 })
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 864 })

    fireEvent.dragStart(image, { dataTransfer })

    const rawPayload = setData.mock.calls.find(
      ([key]) => key === 'application/x-qapp-image'
    )?.[1] as string | undefined
    expect(rawPayload).toBeTruthy()
    expect(JSON.parse(rawPayload!)).toEqual({
      objectUrl: 'blob:image-result-3',
      promptId: 'prompt-3',
      fileItem: {
        filename: 'image-3.png',
        subfolder: 'outputs',
        type: 'output'
      },
      sourceWidth: 1536,
      sourceHeight: 864
    })
  })
})
