import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, DEFAULT_CONFIG } from '@shared/config/config'
import SidePanel from './SidePanel'
import { formatQueueTimestamp } from './sidePanelQueueUtils'

const { requestChatCompletionMock } = vi.hoisted(() => ({
  requestChatCompletionMock: vi.fn()
}))

const resetHy3dDraftMediaStateForTests = () =>
  (
    SidePanel as typeof SidePanel & { __resetHy3dDraftMediaStateForTests: () => void }
  ).__resetHy3dDraftMediaStateForTests()

const navigateMock = vi.fn()
const dispatchMock = vi.fn()
const closeMessageMock = vi.fn()
const notifyErrorMock = vi.fn()
const notifyInfoMock = vi.fn(() => 'hy3d-progress')
const notifySuccessMock = vi.fn()
const notifyWarningMock = vi.fn()
const getObjectInfoMock = vi.fn(async () => ({}))
const watchQueueMock = vi.fn(async () => undefined)
const getQAppCfgMock = vi.fn(async () => ({ cfg: {}, workflow: {} }))
let comfyEventCallback: ((event: { type: string; data: Record<string, unknown> }) => void) | null =
  null
const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  aigc3d_config: {
    ...DEFAULT_CONFIG.aigc3d_config!
  },
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: []
  },
  plugin_config: DEFAULT_CONFIG.plugin_config
    ? {
        ...DEFAULT_CONFIG.plugin_config,
        api_profiles: []
      }
    : undefined
})
let currentConfig: Config = createConfig()

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: notifySuccessMock,
    notifyError: notifyErrorMock,
    notifyInfo: notifyInfoMock,
    notifyWarning: notifyWarningMock,
    closeMessage: closeMessageMock
  })
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: currentConfig,
    buildEnv: {},
    isReady: true,
    configUtils: {},
    updateConfig: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useComfyEvent', () => ({
  useComfyEventCallback: (
    callback: (event: { type: string; data: Record<string, unknown> }) => void
  ) => {
    comfyEventCallback = callback
  }
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: currentConfig,
    buildEnv: {},
    isReady: true,
    configUtils: {},
    updateConfig: vi.fn()
  })
}))

vi.mock('@renderer/store/hooks/comfyStatus', () => ({
  useComfyStatus: () => ({
    state: { isConnected: true, isRunning: false },
    setIsConnected: vi.fn(),
    setObjectInfos: vi.fn()
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getObjectInfo: getObjectInfoMock,
      watchQueue: watchQueueMock,
      cancelQueueItem: vi.fn()
    },
    svcState: {
      saveConfig: vi.fn()
    },
    svcQApp: {
      getQAppCfg: getQAppCfgMock
    }
  })
}))

vi.mock('../store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      layout: {
        activeSidePanel: 'quickapp',
        openTabs: [{ id: 'tab-settings' }]
      }
    })
}))

vi.mock('../store/slices/layoutSlice', () => ({
  closeSidePanel: () => ({ type: 'closeSidePanel' }),
  openTab: (value: unknown) => ({ type: 'openTab', payload: value }),
  setActiveTab: (value: unknown) => ({ type: 'setActiveTab', payload: value })
}))

vi.mock('../pages/QuickAppPage/components/QAppContext', () => ({
  QAppContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useQAppContext: () => ({
    validate: vi.fn(),
    buildWorkflow: vi.fn(),
    qAppCfg: null,
    currentQAppKey: '~builtin/hunyuan3d'
  })
}))

vi.mock('../pages/QuickAppPage/ResultList/resultTransformers', () => ({
  transformResults: vi.fn()
}))

vi.mock('../pages/QuickAppPage/utils/qAppCanvasDispatch', () => ({
  dispatchQAppResultsToCanvas: vi.fn(() => ({ totalCount: 0 }))
}))

vi.mock('../pages/QuickAppPage/utils/qAppErrorMessage', () => ({
  normalizeQAppErrorMessage: (value: string) => value
}))

vi.mock('../pages/ChatPage/chatRequestUtils', () => ({
  requestChatCompletion: requestChatCompletionMock
}))

vi.mock('../pages/QuickAppPage/components/QAppMenu', () => ({
  default: ({
    currentQAppKey,
    activeCategory,
    setCurrentQAppKey,
    renderExpandedContent
  }: {
    currentQAppKey: string
    activeCategory: string
    setCurrentQAppKey: (key: string) => void
    renderExpandedContent: (key: string) => React.ReactNode
  }) => (
    <div>
      <div>{`Active Category: ${activeCategory}`}</div>
      {activeCategory === 'video' ? (
        <button type="button" onClick={() => setCurrentQAppKey('~builtin/video-generation')}>
          AI Video Generation
        </button>
      ) : null}
      {currentQAppKey.startsWith('~builtin/hunyuan3d/') ||
      currentQAppKey === '~builtin/video-generation'
        ? renderExpandedContent(currentQAppKey)
        : null}
    </div>
  )
}))

vi.mock('../pages/QuickAppPage/QAppExecutePanel/QAppInputPanel', () => ({
  default: () => <div>Quick App Panel</div>
}))

vi.mock('../pages/FileBrowserPage/ModelPage', () => ({
  default: () => <div>Explorer</div>
}))

vi.mock('../pages/QuickAppPage/videoGeneration/VideoGenerationWorkspace', () => ({
  default: ({
    projectId,
    inline,
    resultPromptId
  }: {
    projectId?: string
    inline?: boolean
    resultPromptId?: string
  }) => (
    <div>
      <div>Video Generation Workspace</div>
      <div>{`Video Project: ${projectId || '(empty)'}`}</div>
      <div>{`Video Inline: ${inline ? 'yes' : 'no'}`}</div>
      <div>{`Video Result Prompt: ${resultPromptId || '(empty)'}`}</div>
    </div>
  )
}))

vi.mock('../pages/ChatPage/Hunyuan3DPanel', () => ({
  default: ({
    params,
    onParamsChange,
    onGenerate,
    onMediaStateChange
  }: {
    params: { modelUrl: string; apiAction?: string; mode?: string }
    onParamsChange: (params: unknown) => void
    onGenerate?: () => void
    onMediaStateChange: (state: unknown) => void
  }) => (
    <div>
      <div>Hunyuan3D Panel</div>
      <div>{`Model URL: ${params.modelUrl || '(empty)'}`}</div>
      <div>{`API Action: ${params.apiAction || '(empty)'}`}</div>
      <div>{`Mode: ${params.mode || '(empty)'}`}</div>
      <button onClick={() => onParamsChange({ apiAction: 'SubmitHunyuanTo3DRapidJob' })}>
        Switch To Rapid
      </button>
      <button onClick={() => onParamsChange({ mode: 'img2_3d' })}>Switch To Image Mode</button>
      <button onClick={() => onParamsChange({ mode: 'text2_3d' })}>Switch To Text Mode</button>
      <button
        onClick={() =>
          onMediaStateChange({
            conceptImages: [
              {
                type: 'image',
                url: 'https://example.com/concept-front.png',
                fileName: 'concept-front.png',
                slot: 'single'
              },
              {
                type: 'image',
                url: 'https://example.com/concept-back.png',
                fileName: 'concept-back.png',
                slot: 'back'
              }
            ],
            textureRefImages: [
              {
                type: 'image',
                url: 'https://example.com/texture.png',
                fileName: 'texture.png',
                slot: 'single'
              }
            ],
            profileRefImage: {
              type: 'image',
              url: 'https://example.com/profile.png',
              fileName: 'profile.png'
            }
          })
        }
      >
        Seed Mixed Media
      </button>
      <button onClick={() => onGenerate?.()}>Trigger Generate</button>
    </div>
  )
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string) => key
  })
}))

describe('SidePanel', () => {
  beforeEach(() => {
    resetHy3dDraftMediaStateForTests()
    navigateMock.mockClear()
    dispatchMock.mockClear()
    closeMessageMock.mockClear()
    notifyErrorMock.mockClear()
    notifyInfoMock.mockClear()
    notifySuccessMock.mockClear()
    notifyWarningMock.mockClear()
    requestChatCompletionMock.mockReset()
    getObjectInfoMock.mockClear()
    watchQueueMock.mockClear()
    getQAppCfgMock.mockClear()
    comfyEventCallback = null
    currentConfig = createConfig()
    requestChatCompletionMock.mockResolvedValue({
      content: '[Generated 3D Model](https://example.com/generated-model.glb)'
    })

    localStorage.clear()
    sessionStorage.clear()
    localStorage.setItem('qapp.currentQAppKey', '~builtin/hunyuan3d/concept')
  })

  it('renders the Hunyuan3D quick app hint when Hunyuan is not configured', async () => {
    render(<SidePanel />)

    expect(await screen.findByRole('button', { name: '3D' })).toBeTruthy()
    expect(await screen.findByText('Active Category: model3d')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '3D' }))

    expect(await screen.findByText('Hunyuan3D Panel')).toBeTruthy()
    expect(await screen.findByRole('button', { name: /API/ })).toBeTruthy()
  })

  it('renders the built-in video app directly in inline mode when selected from the SidePanel', async () => {
    render(<SidePanel projectId="tab-project-video" />)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('qapp:switch', {
          detail: { qAppKey: '~builtin/video-generation' }
        })
      )
    })

    expect(await screen.findByText('Active Category: video')).toBeTruthy()
    expect(await screen.findByText('Video Generation Workspace')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'AI Video Generation' })).toBeTruthy()
    expect(screen.getByText('Video Project: tab-project-video')).toBeTruthy()
    expect(screen.getByText('Video Inline: yes')).toBeTruthy()
    expect(screen.getByText('Video Result Prompt: builtin-video-generation-inline')).toBeTruthy()
    expect(screen.queryByText('Quick App Panel')).toBeNull()
    expect(getQAppCfgMock).not.toHaveBeenCalled()
  })

  it('moves overflow quick app categories into a more menu when the side panel is narrow', async () => {
    render(<SidePanel width={360} />)

    expect(await screen.findByRole('button', { name: '图像' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '3D' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '检查' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '更多分类' }))

    fireEvent.click(await screen.findByRole('menuitem', { name: '检查' }))

    expect(await screen.findByText('Active Category: inspection')).toBeTruthy()
  })

  it('hides the Hunyuan3D quick app hint after Hunyuan is configured', async () => {
    currentConfig = {
      ...createConfig(),
      aigc3d_config: {
        ...DEFAULT_CONFIG.aigc3d_config!,
        tencent_secret_id: 'secret-id',
        tencent_secret_key: 'secret-key',
        cos_bucket: 'bucket',
        cos_region: 'ap-guangzhou'
      }
    }

    render(<SidePanel />)

    expect(await screen.findByText('Hunyuan3D Panel')).toBeTruthy()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /API/ })).toBeNull()
    })
  })

  it('allows concept generation to stay on the rapid engine when switched locally', async () => {
    render(<SidePanel />)

    expect(await screen.findByText('Hunyuan3D Panel')).toBeTruthy()
    expect(screen.getByText('API Action: SubmitHunyuanTo3DProJob')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Switch To Rapid' }))

    await waitFor(() => {
      expect(screen.getByText('API Action: SubmitHunyuanTo3DRapidJob')).toBeTruthy()
    })
  })

  it('restores concept generation when the selected Hunyuan step is concept but stored params are split', async () => {
    localStorage.setItem(
      'hy3d.params',
      JSON.stringify({
        apiAction: 'SubmitHunyuan3DPartJob',
        modelUrl: 'https://example.com/source-model.fbx',
        modelSourceFileName: 'source-model.fbx'
      })
    )

    const modelEvents: Array<
      CustomEvent<{
        hy3dQuickAppKey?: string
        hy3dParams?: { apiAction?: string; mode?: string }
      }>
    > = []
    const handleGenerate = (event: Event) => {
      modelEvents.push(
        event as CustomEvent<{
          hy3dQuickAppKey?: string
          hy3dParams?: { apiAction?: string; mode?: string }
        }>
      )
    }

    window.addEventListener('canvas:add-model3d', handleGenerate)

    try {
      render(<SidePanel projectId="tab-project-demo" />)

      expect(await screen.findByText('Hunyuan3D Panel')).toBeTruthy()
      await waitFor(() => {
        expect(screen.getByText('API Action: SubmitHunyuanTo3DProJob')).toBeTruthy()
      })

      fireEvent.click(screen.getByRole('button', { name: 'Seed Mixed Media' }))
      fireEvent.click(screen.getByRole('button', { name: 'Switch To Image Mode' }))
      fireEvent.click(screen.getByRole('button', { name: 'Trigger Generate' }))

      await waitFor(() => {
        expect(requestChatCompletionMock).toHaveBeenCalledTimes(1)
        expect(modelEvents).toHaveLength(1)
      })
      expect(modelEvents[0].detail).toMatchObject({
        hy3dQuickAppKey: '~builtin/hunyuan3d/concept',
        hy3dParams: {
          apiAction: 'SubmitHunyuanTo3DProJob',
          mode: 'img2_3d'
        }
      })
    } finally {
      window.removeEventListener('canvas:add-model3d', handleGenerate)
    }
  })

  it('restores the last concept engine after switching away from concept and back', async () => {
    render(<SidePanel />)

    expect(await screen.findByText('Hunyuan3D Panel')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Switch To Rapid' }))

    await waitFor(() => {
      expect(screen.getByText('API Action: SubmitHunyuanTo3DRapidJob')).toBeTruthy()
    })

    act(() => {
      window.dispatchEvent(
        new CustomEvent('qapp:switch', {
          detail: { qAppKey: '~builtin/hunyuan3d/split' }
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('API Action: SubmitHunyuan3DPartJob')).toBeTruthy()
    })

    act(() => {
      window.dispatchEvent(
        new CustomEvent('qapp:switch', {
          detail: { qAppKey: '~builtin/hunyuan3d/concept' }
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('API Action: SubmitHunyuanTo3DRapidJob')).toBeTruthy()
    })
  })

  it('keeps Hunyuan draft media across side panel remounts in the current renderer session', async () => {
    const firstRender = render(<SidePanel />)
    await screen.findByText('Hunyuan3D Panel')

    fireEvent.click(screen.getByRole('button', { name: 'Seed Mixed Media' }))
    firstRender.unmount()

    render(<SidePanel />)
    await screen.findByText('Hunyuan3D Panel')

    fireEvent.click(screen.getByRole('button', { name: 'Switch To Image Mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trigger Generate' }))

    await waitFor(() => {
      expect(requestChatCompletionMock).toHaveBeenCalledTimes(1)
    })
    expect(requestChatCompletionMock.mock.calls[0][0].messages[0].attachments).toEqual([
      expect.objectContaining({
        url: 'https://example.com/concept-front.png'
      }),
      expect.objectContaining({
        url: 'https://example.com/concept-back.png'
      })
    ])
    expect(notifyInfoMock).toHaveBeenCalledTimes(1)
    expect(closeMessageMock).toHaveBeenCalledWith('hy3d-progress')
  })

  it('restores Hunyuan draft media from session storage after the in-memory cache is dropped', async () => {
    const firstRender = render(<SidePanel />)
    await screen.findByText('Hunyuan3D Panel')

    fireEvent.click(screen.getByRole('button', { name: 'Seed Mixed Media' }))
    firstRender.unmount()

    resetHy3dDraftMediaStateForTests()

    render(<SidePanel />)
    await screen.findByText('Hunyuan3D Panel')

    fireEvent.click(screen.getByRole('button', { name: 'Switch To Image Mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trigger Generate' }))

    await waitFor(() => {
      expect(requestChatCompletionMock).toHaveBeenCalledTimes(1)
    })
    expect(requestChatCompletionMock.mock.calls[0][0].messages[0].attachments).toEqual([
      expect.objectContaining({
        url: 'https://example.com/concept-front.png'
      }),
      expect.objectContaining({
        url: 'https://example.com/concept-back.png'
      })
    ])
  })

  it('ignores hidden text prompts for image-to-3d concept requests', async () => {
    localStorage.setItem(
      'hy3d.params',
      JSON.stringify({
        apiAction: 'SubmitHunyuanTo3DProJob',
        prompt: 'concept prompt'
      })
    )

    const modelEvents: Array<
      CustomEvent<{
        src?: string
        projectId?: string
        fileName?: string
        hy3dQuickAppKey?: string
        hy3dParams?: { apiAction?: string; mode?: string; prompt?: string }
        hy3dMediaState?: { conceptImages?: Array<{ url?: string }> }
      }>
    > = []
    const handleGenerate = (event: Event) => {
      modelEvents.push(
        event as CustomEvent<{
          src?: string
          projectId?: string
          fileName?: string
          hy3dQuickAppKey?: string
          hy3dParams?: { apiAction?: string; mode?: string; prompt?: string }
          hy3dMediaState?: { conceptImages?: Array<{ url?: string }> }
        }>
      )
    }

    window.addEventListener('canvas:add-model3d', handleGenerate)

    try {
      render(<SidePanel />)
      await screen.findByText('Hunyuan3D Panel')

      fireEvent.click(screen.getByRole('button', { name: 'Seed Mixed Media' }))
      fireEvent.click(screen.getByRole('button', { name: 'Switch To Image Mode' }))
      fireEvent.click(screen.getByRole('button', { name: 'Trigger Generate' }))

      await waitFor(() => {
        expect(requestChatCompletionMock).toHaveBeenCalledTimes(1)
        expect(modelEvents).toHaveLength(1)
      })
      expect(requestChatCompletionMock.mock.calls[0][0].messages[0].attachments).toEqual([
        expect.objectContaining({
          url: 'https://example.com/concept-front.png'
        }),
        expect.objectContaining({
          url: 'https://example.com/concept-back.png'
        })
      ])
      expect(requestChatCompletionMock.mock.calls[0][0].messages[0].content).toBe('')
      expect(modelEvents[0].detail).toMatchObject({
        src: 'https://example.com/generated-model.glb',
        fileName: 'generated-model.glb',
        projectId: undefined,
        select: true,
        hy3dQuickAppKey: '~builtin/hunyuan3d/concept',
        hy3dParams: {
          apiAction: 'SubmitHunyuanTo3DProJob',
          mode: 'img2_3d'
        }
      })
      expect(modelEvents[0].detail.hy3dMediaState?.conceptImages?.[1]?.url).toBe(
        'https://example.com/concept-back.png'
      )
      expect(notifySuccessMock).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('canvas:add-model3d', handleGenerate)
    }
  })

  it('adds generated Hunyuan models to the current canvas without opening the agent workspace', async () => {
    const modelEvents: Array<
      CustomEvent<{
        src?: string
        projectId?: string
        fileName?: string
        hy3dQuickAppKey?: string
        hy3dParams?: { apiAction?: string; mode?: string }
        hy3dMediaState?: { conceptImages?: Array<{ url?: string }> }
      }>
    > = []
    const handleGenerate = (event: Event) => {
      modelEvents.push(
        event as CustomEvent<{
          src?: string
          projectId?: string
          fileName?: string
          hy3dQuickAppKey?: string
          hy3dParams?: { apiAction?: string; mode?: string }
          hy3dMediaState?: { conceptImages?: Array<{ url?: string }> }
        }>
      )
    }

    window.addEventListener('canvas:add-model3d', handleGenerate)

    try {
      render(<SidePanel projectId="tab-project-demo" />)
      await screen.findByText('Hunyuan3D Panel')

      fireEvent.click(screen.getByRole('button', { name: 'Seed Mixed Media' }))
      fireEvent.click(screen.getByRole('button', { name: 'Switch To Image Mode' }))
      fireEvent.click(screen.getByRole('button', { name: 'Trigger Generate' }))

      await waitFor(() => {
        expect(modelEvents).toHaveLength(1)
      })
      expect(modelEvents[0].detail).toMatchObject({
        src: 'https://example.com/generated-model.glb',
        fileName: 'generated-model.glb',
        projectId: 'tab-project-demo',
        select: true,
        hy3dQuickAppKey: '~builtin/hunyuan3d/concept',
        hy3dParams: {
          apiAction: 'SubmitHunyuanTo3DProJob',
          mode: 'img2_3d'
        }
      })
      expect(modelEvents[0].detail.hy3dMediaState?.conceptImages?.[0]?.url).toBe(
        'https://example.com/concept-front.png'
      )
      expect(dispatchMock).not.toHaveBeenCalledWith({ type: 'openRightPanel' })
      expect(notifySuccessMock).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('canvas:add-model3d', handleGenerate)
    }
  })

  it('prefers the generated GLB when Hunyuan returns preview images together with OBJ and GLB outputs', async () => {
    requestChatCompletionMock.mockResolvedValueOnce({
      content: [
        '![Generated PNG](https://example.com/generated-preview.png)',
        '[Generated 3D Model](https://example.com/generated-model.obj)',
        '[Generated 3D Model](https://example.com/generated-model.glb)'
      ].join('\n')
    })

    const modelEvents: Array<
      CustomEvent<{
        src?: string
        projectId?: string
        fileName?: string
        hy3dQuickAppKey?: string
        hy3dParams?: { apiAction?: string; mode?: string }
      }>
    > = []
    const handleGenerate = (event: Event) => {
      modelEvents.push(
        event as CustomEvent<{
          src?: string
          projectId?: string
          fileName?: string
          hy3dQuickAppKey?: string
          hy3dParams?: { apiAction?: string; mode?: string }
        }>
      )
    }

    window.addEventListener('canvas:add-model3d', handleGenerate)

    try {
      render(<SidePanel projectId="tab-project-demo" />)
      await screen.findByText('Hunyuan3D Panel')

      fireEvent.click(screen.getByRole('button', { name: 'Seed Mixed Media' }))
      fireEvent.click(screen.getByRole('button', { name: 'Switch To Image Mode' }))
      fireEvent.click(screen.getByRole('button', { name: 'Trigger Generate' }))

      await waitFor(() => {
        expect(modelEvents).toHaveLength(1)
      })
      expect(modelEvents[0].detail).toMatchObject({
        src: 'https://example.com/generated-model.glb',
        fileName: 'generated-model.glb',
        projectId: 'tab-project-demo',
        select: true,
        hy3dQuickAppKey: '~builtin/hunyuan3d/concept',
        hy3dParams: {
          apiAction: 'SubmitHunyuanTo3DProJob',
          mode: 'img2_3d'
        }
      })
    } finally {
      window.removeEventListener('canvas:add-model3d', handleGenerate)
    }
  })

  it('keeps the FBX source input and dispatches every split result model to the canvas', async () => {
    localStorage.setItem('qapp.currentQAppKey', '~builtin/hunyuan3d/split')
    localStorage.setItem(
      'hy3d.params',
      JSON.stringify({
        apiAction: 'SubmitHunyuan3DPartJob',
        modelUrl: 'https://example.com/source-model.fbx',
        modelSourceFileName: 'source-model.fbx'
      })
    )
    requestChatCompletionMock.mockResolvedValueOnce({
      content: [
        '[Generated 3D Model](https://example.com/parts/part-a.glb)',
        '[Generated 3D Model](https://example.com/parts/part-b.glb)',
        '[Generated 3D Model](https://example.com/parts/part-c.glb)'
      ].join('\n')
    })

    const modelEvents: Array<
      CustomEvent<{
        src?: string
        projectId?: string
        fileName?: string
        offsetX?: number
        offsetY?: number
        width?: number
        height?: number
        select?: boolean
        hy3dQuickAppKey?: string
        hy3dParams?: { apiAction?: string }
      }>
    > = []
    const handleGenerate = (event: Event) => {
      modelEvents.push(
        event as CustomEvent<{
          src?: string
          projectId?: string
          fileName?: string
          offsetX?: number
          offsetY?: number
          width?: number
          height?: number
          select?: boolean
          hy3dQuickAppKey?: string
          hy3dParams?: { apiAction?: string }
        }>
      )
    }

    window.addEventListener('canvas:add-model3d', handleGenerate)

    try {
      render(<SidePanel projectId="tab-project-demo" />)
      await screen.findByText('Hunyuan3D Panel')
      expect(screen.getByText('API Action: SubmitHunyuan3DPartJob')).toBeTruthy()
      expect(screen.getByText('Model URL: https://example.com/source-model.fbx')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Trigger Generate' }))

      await waitFor(() => {
        expect(modelEvents).toHaveLength(3)
      })
      expect(modelEvents.map((event) => event.detail.src)).toEqual([
        'https://example.com/parts/part-a.glb',
        'https://example.com/parts/part-b.glb',
        'https://example.com/parts/part-c.glb'
      ])
      expect(modelEvents.map((event) => event.detail.fileName)).toEqual([
        'part-a.glb',
        'part-b.glb',
        'part-c.glb'
      ])
      expect(modelEvents.map((event) => event.detail.projectId)).toEqual([
        'tab-project-demo',
        'tab-project-demo',
        'tab-project-demo'
      ])
      expect(modelEvents.map((event) => event.detail.hy3dQuickAppKey)).toEqual([
        '~builtin/hunyuan3d/split',
        '~builtin/hunyuan3d/split',
        '~builtin/hunyuan3d/split'
      ])
      expect(modelEvents.map((event) => event.detail.hy3dParams?.apiAction)).toEqual([
        'SubmitHunyuan3DPartJob',
        'SubmitHunyuan3DPartJob',
        'SubmitHunyuan3DPartJob'
      ])
      expect(modelEvents.map((event) => event.detail.width)).toEqual([240, 240, 240])
      expect(modelEvents.map((event) => event.detail.height)).toEqual([240, 240, 240])
      expect(modelEvents.map((event) => event.detail.select)).toEqual([false, false, true])
      expect(
        new Set(
          modelEvents.map(
            (event) => `${event.detail.offsetX ?? 'x'},${event.detail.offsetY ?? 'y'}`
          )
        ).size
      ).toBe(3)
      expect(screen.getByText('Model URL: https://example.com/source-model.fbx')).toBeTruthy()
    } finally {
      window.removeEventListener('canvas:add-model3d', handleGenerate)
    }
  })

  it('syncs refreshed signed urls back into the mounted Hunyuan3D side panel', async () => {
    localStorage.setItem(
      'hy3d.params',
      JSON.stringify({
        apiAction: 'SubmitTextureTo3DJob',
        modelUrl: 'https://example.com/model-old.glb',
        modelSignedUrlExpiresAt: '2026-04-04T00:00:00.000Z'
      })
    )

    render(<SidePanel />)

    expect(await screen.findByText('Model URL: https://example.com/model-old.glb')).toBeTruthy()

    act(() => {
      window.dispatchEvent(
        new CustomEvent('hy3d:params-updated', {
          detail: {
            params: {
              apiAction: 'SubmitTextureTo3DJob',
              modelUrl: 'https://example.com/model-new.glb',
              modelSignedUrlExpiresAt: '2026-04-05T00:00:00.000Z'
            }
          }
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Model URL: https://example.com/model-new.glb')).toBeTruthy()
    })
  })

  it('formats queue timestamps as local datetime strings with second precision', () => {
    const createdAt = new Date(2026, 3, 2, 22, 48, 29).getTime()

    expect(formatQueueTimestamp(createdAt)).toBe('2026-04-02 22:48:29')
  })
})
