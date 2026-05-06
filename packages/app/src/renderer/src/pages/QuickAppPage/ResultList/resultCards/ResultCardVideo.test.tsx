/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import ResultCardVideo from './ResultCardVideo'
import { INTERNAL_IMAGE_DRAG_PREFIX, QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'

const {
  downloadFileMock,
  extractWorkflowFromImageMock,
  showItemInFolderMock,
  listQAppCfgsMock,
  getQAppCfgMock,
  setWorkflowMock,
  setQAppCfgMock,
  resolveImportedWorkflowMock,
  notifySuccessMock,
  notifyErrorMock
} = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
  extractWorkflowFromImageMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  listQAppCfgsMock: vi.fn().mockResolvedValue({ qApps: [] }),
  getQAppCfgMock: vi.fn(),
  setWorkflowMock: vi.fn(),
  setQAppCfgMock: vi.fn(),
  resolveImportedWorkflowMock: vi.fn(async (workflow: Record<string, unknown>) => ({ workflow })),
  notifySuccessMock: vi.fn(),
  notifyErrorMock: vi.fn()
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  downloadFile: downloadFileMock,
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
    setQAppCfg: setQAppCfgMock
  })
}))

vi.mock('@renderer/utils/qappUtils', () => ({
  compareWorkflows: vi.fn(() => false)
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

vi.mock('./components/ResultIconButtonBase', () => ({
  __esModule: true,
  default: ({ tooltip, onClick }: { tooltip: string; onClick: () => void }) => (
    <button type="button" data-testid={tooltip} onClick={onClick}>
      {tooltip}
    </button>
  )
}))

describe('ResultCardVideo', () => {
  const originalWindowPath = window.path

  beforeEach(() => {
    downloadFileMock.mockReset()
    extractWorkflowFromImageMock.mockReset()
    showItemInFolderMock.mockReset()
    listQAppCfgsMock.mockClear()
    getQAppCfgMock.mockClear()
    setWorkflowMock.mockClear()
    setQAppCfgMock.mockClear()
    resolveImportedWorkflowMock.mockReset()
    notifySuccessMock.mockClear()
    notifyErrorMock.mockClear()
    window.path = {
      join: (...parts: string[]) => parts.join('/')
    } as any
  })

  it('supports preview, download, and open-folder actions for a video result', () => {
    render(
      <ResultCardVideo
        result={
          {
            type: 'video',
            id: 'video-1',
            promptId: 'prompt-1',
            objectUrl: 'blob:video-result',
            fileItem: {
              filename: 'clip.mp4',
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

    const buttons = screen.getAllByRole('button')
    const video = document.querySelector('video')
    expect(video).toHaveAttribute('src', 'blob:video-result')

    fireEvent.click(buttons[1])
    expect(screen.getByTestId('modal-layout')).toBeInTheDocument()

    fireEvent.click(buttons[0])
    expect(downloadFileMock).toHaveBeenCalledWith('blob:video-result', 'clip.mp4')

    fireEvent.click(buttons[2])
    expect(showItemInFolderMock).toHaveBeenCalledWith('C:/output/outputs/clip.mp4')
  })

  it('falls back to a generated name when the file item is missing a filename', () => {
    render(
      <ResultCardVideo
        result={
          {
            type: 'video',
            id: 'video-2',
            promptId: 'prompt-2',
            objectUrl: 'blob:video-result-2',
            fileItem: {
              filename: '',
              subfolder: '',
              type: 'output'
            }
          } as any
        }
        index={1}
        config={{ download_dir: 'C:/downloads' } as any}
        buildEnv={{} as any}
      />
    )

    fireEvent.click(screen.getAllByRole('button')[0])
    expect(downloadFileMock).toHaveBeenCalledWith('blob:video-result-2', 'qapp_video_2.mp4')
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('writes quick-app drag payloads for workflow re-import', () => {
    render(
      <ResultCardVideo
        result={
          {
            type: 'video',
            id: 'video-3',
            promptId: 'prompt-3',
            objectUrl: 'blob:video-result-3',
            fileItem: {
              filename: 'clip-3.mp4',
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

    const setData = vi.fn()
    const video = document.querySelector('video') as HTMLVideoElement

    fireEvent.dragStart(video, {
      dataTransfer: {
        setData,
        effectAllowed: 'uninitialized'
      }
    })

    const mimePayload = setData.mock.calls.find(([key]) => key === QAPP_IMAGE_DRAG_MIME)?.[1]
    expect(mimePayload).toBeTruthy()
    expect(JSON.parse(mimePayload)).toMatchObject({
      objectUrl: 'blob:video-result-3',
      promptId: 'prompt-3',
      fileItem: {
        filename: 'clip-3.mp4',
        subfolder: 'outputs',
        type: 'output'
      },
      itemTypes: ['video']
    })
    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      `${INTERNAL_IMAGE_DRAG_PREFIX}${mimePayload}`
    )
  })

  it('disables dragging when the video result url is not ready yet', () => {
    render(
      <ResultCardVideo
        result={
          {
            type: 'video',
            id: 'video-3b',
            promptId: 'prompt-3b',
            objectUrl: ' ',
            fileItem: {
              filename: 'clip-3b.mp4',
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

    const setData = vi.fn()
    const video = document.querySelector('video') as HTMLVideoElement

    expect(video).not.toHaveAttribute('draggable', 'true')

    fireEvent.dragStart(video, {
      dataTransfer: {
        setData,
        effectAllowed: 'uninitialized'
      }
    })

    expect(setData).not.toHaveBeenCalled()
  })

  it('loads an embedded quick app from the video workflow payload', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    extractWorkflowFromImageMock.mockResolvedValue({
      workflow: { __qAppKey__: 'video-workflow-app' },
      source: 'history'
    })

    render(
      <ResultCardVideo
        result={
          {
            type: 'video',
            id: 'video-4',
            promptId: 'prompt-4',
            objectUrl: 'blob:video-result-4',
            fileItem: {
              filename: 'clip-4.mp4',
              subfolder: 'outputs',
              type: 'output'
            }
          } as any
        }
        index={3}
        config={{ download_dir: 'C:/downloads' } as any}
        buildEnv={{} as any}
      />
    )

    fireEvent.click(screen.getByTestId('加载快应用'))

    await waitFor(() => {
      expect(extractWorkflowFromImageMock).toHaveBeenCalledWith('blob:video-result-4', 'prompt-4')
      expect(setWorkflowMock).toHaveBeenCalledWith({ __qAppKey__: 'video-workflow-app' })
      expect(notifySuccessMock).not.toHaveBeenCalled()
    })

    const qappSwitchEvent = dispatchSpy.mock.calls.find(
      ([event]) => event instanceof CustomEvent && event.type === 'qapp:switch'
    )?.[0] as CustomEvent | undefined
    expect(qappSwitchEvent?.detail).toEqual({
      qAppKey: 'video-workflow-app',
      workflow: { __qAppKey__: 'video-workflow-app' }
    })
  })

  it('restores imported quick app cfg when a video workflow has app-mode metadata', async () => {
    extractWorkflowFromImageMock.mockResolvedValue({
      workflow: { step: 'video-workflow' },
      source: 'history'
    })
    const importedCfg = { icon: 'video', inputs: [{ id: 'api' }], autoInputs: [] }
    resolveImportedWorkflowMock.mockResolvedValue({
      workflow: { step: 'video-workflow' },
      cfg: importedCfg,
      isAppMode: true,
      warnings: []
    } as any)

    render(
      <ResultCardVideo
        result={
          {
            type: 'video',
            id: 'video-5',
            promptId: 'prompt-5',
            objectUrl: 'blob:video-result-5',
            fileItem: {
              filename: 'clip-5.mp4',
              subfolder: 'outputs',
              type: 'output'
            }
          } as any
        }
        index={4}
        config={{ download_dir: 'C:/downloads' } as any}
        buildEnv={{} as any}
      />
    )

    fireEvent.click(screen.getByTestId('加载快应用'))

    await waitFor(() => {
      expect(setQAppCfgMock).toHaveBeenCalledWith(importedCfg)
      expect(setWorkflowMock).toHaveBeenCalledWith({ step: 'video-workflow' })
    })
  })

  afterEach(() => {
    window.path = originalWindowPath
  })
})
