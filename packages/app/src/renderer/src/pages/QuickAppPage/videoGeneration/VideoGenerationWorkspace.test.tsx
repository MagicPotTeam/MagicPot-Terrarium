import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import { theme } from '@renderer/theme'
import VideoGenerationWorkspace from './VideoGenerationWorkspace'

const mocks = vi.hoisted(() => ({
  currentConfig: { value: undefined as unknown as Config },
  chatMock: vi.fn(),
  appendResultsMock: vi.fn(),
  notifyErrorMock: vi.fn(),
  notifySuccessMock: vi.fn(),
  selectFileMock: vi.fn(),
  fileToDataUrlMock: vi.fn(),
  downloadFileMock: vi.fn()
}))

type TranslationOptions = Record<string, unknown> & { defaultValue?: string }

const interpolateTranslation = (template: string, options?: TranslationOptions): string =>
  template.replace(/{{\s*(\w+)\s*}}/g, (_match, key: string) => {
    const value = options?.[key]
    return value === undefined || value === null ? '' : String(value)
  })

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: TranslationOptions) =>
      interpolateTranslation(options?.defaultValue ?? _key, options)
  })
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: mocks.currentConfig.value
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: mocks.notifyErrorMock,
    notifySuccess: mocks.notifySuccessMock
  })
}))

vi.mock('@renderer/store/hooks/comfyStatus', () => ({
  useComfyStatus: () => ({
    appendResults: mocks.appendResultsMock
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcLLMProxy: {
      chat: mocks.chatMock
    }
  })
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  downloadFile: mocks.downloadFileMock,
  selectFile: mocks.selectFileMock,
  fileToDataUrl: mocks.fileToDataUrlMock
}))

const buildConfig = ({
  agentProfiles = [],
  qappProfiles = []
}: {
  agentProfiles?: LLMAPIProfile[]
  qappProfiles?: LLMAPIProfile[]
}): Config => ({
  ...DEFAULT_CONFIG,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: agentProfiles
  },
  plugin_config: {
    ...DEFAULT_CONFIG.plugin_config!,
    api_profiles: qappProfiles
  }
})

const buildKlingProfile = (id: string, modelName = 'kling-v1-6'): LLMAPIProfile => ({
  id,
  model_name: modelName,
  base_url: 'https://api-beijing.klingai.com',
  api_key: `${id}-access-key`,
  api_secret: `${id}-secret-key`,
  provider: 'kling',
  model_use: 'video'
})

const buildSeedanceProfile = (id: string): LLMAPIProfile => ({
  id,
  model_name: 'doubao-seedance-1-0-pro-250528',
  base_url: 'https://ark.cn-beijing.volces.com/api/v3',
  api_key: `${id}-api-key`,
  provider: 'volcengine',
  model_use: 'video'
})

const renderWorkspace = (props?: React.ComponentProps<typeof VideoGenerationWorkspace>) =>
  render(
    <ThemeProvider theme={theme}>
      <VideoGenerationWorkspace {...props} />
    </ThemeProvider>
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.currentConfig.value = buildConfig({})
  mocks.selectFileMock.mockResolvedValue(null)
  mocks.fileToDataUrlMock.mockResolvedValue('data:image/png;base64,AAAA')
  mocks.chatMock.mockResolvedValue({
    content: '',
    attachments: [
      {
        type: 'video',
        url: 'https://cdn.example/generated.mp4',
        fileName: 'generated.mp4',
        mimeType: 'video/mp4'
      }
    ]
  })

  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: vi.fn(() => 'result-id')
  })
})

describe('VideoGenerationWorkspace', () => {
  it('uses the selected Quick App API video profile through the main-process proxy', async () => {
    mocks.currentConfig.value = buildConfig({
      agentProfiles: [buildSeedanceProfile('agent-video')],
      qappProfiles: [buildKlingProfile('qapp-video')]
    })

    renderWorkspace()

    expect((await screen.findByRole('combobox', { name: /Video model/ })).textContent).toContain(
      'qapp-video'
    )
    expect(screen.getByText('Basic')).toBeTruthy()
    expect(screen.getByText('Assets')).toBeTruthy()
    expect(screen.getByText('Kling parameters')).toBeTruthy()
    expect(screen.getByText('Advanced')).toBeTruthy()
    expect(screen.getByText('Request JSON preview')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Video prompt'), {
      target: { value: 'cinematic red panda walking through bamboo' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

    await waitFor(() => {
      expect(mocks.chatMock).toHaveBeenCalledTimes(1)
    })
    expect(mocks.chatMock).toHaveBeenCalledWith({
      profileId: 'qapp-video',
      profileScope: 'qapp',
      videoGenerationOptions: {
        aspectRatio: '16:9',
        duration: 5,
        watermark: false,
        mode: 'std',
        sound: 'off',
        cameraPreset: 'none'
      },
      messages: [
        {
          role: 'user',
          content: 'cinematic red panda walking through bamboo'
        }
      ]
    })
    expect(mocks.appendResultsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'result-id',
        promptId: 'builtin-video-generation',
        type: 'video',
        objectUrl: 'https://cdn.example/generated.mp4',
        fileItem: expect.objectContaining({ filename: 'generated.mp4', format: 'video/mp4' })
      })
    ])
    expect(mocks.notifySuccessMock).toHaveBeenCalledWith('Video generation completed.')
    expect(await screen.findByText('Latest result')).toBeTruthy()
  })

  it('can use Agent Thread video profiles directly from the Quick App page', async () => {
    mocks.currentConfig.value = buildConfig({
      agentProfiles: [buildSeedanceProfile('agent-video')]
    })

    renderWorkspace()

    expect((await screen.findByRole('combobox', { name: /Video model/ })).textContent).toContain(
      'agent-video'
    )
    fireEvent.change(screen.getByLabelText('Video prompt'), {
      target: { value: 'wide shot of a robot painter' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

    await waitFor(() => {
      expect(mocks.chatMock).toHaveBeenCalledTimes(1)
    })
    expect(mocks.chatMock.mock.calls[0][0]).toMatchObject({
      profileId: 'agent-video',
      profileScope: 'agent'
    })
  })

  it('sends Kling first frame and last frame assets as image and image_tail attachments', async () => {
    mocks.currentConfig.value = buildConfig({
      qappProfiles: [buildKlingProfile('qapp-video')]
    })
    const firstFrame = new File(['first'], 'first.png', { type: 'image/png' })
    const lastFrame = new File(['last'], 'last.jpg', { type: 'image/jpeg' })
    mocks.selectFileMock.mockResolvedValueOnce(firstFrame).mockResolvedValueOnce(lastFrame)
    mocks.fileToDataUrlMock
      .mockResolvedValueOnce('data:image/png;base64,FIRST')
      .mockResolvedValueOnce('data:image/jpeg;base64,LAST')

    renderWorkspace()

    await screen.findByRole('combobox', { name: /Video model/ })
    fireEvent.click(screen.getByRole('button', { name: 'Choose First frame' }))
    expect(await screen.findByText('first.png')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Choose Last frame' }))
    expect(await screen.findByText('last.jpg')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

    await waitFor(() => {
      expect(mocks.chatMock).toHaveBeenCalledTimes(1)
    })
    expect(mocks.chatMock.mock.calls[0][0].messages[0]).toEqual({
      role: 'user',
      content: '',
      attachments: [
        expect.objectContaining({
          type: 'image',
          url: 'data:image/png;base64,FIRST',
          mimeType: 'image/png',
          fileName: 'first.png',
          metadata: expect.objectContaining({ videoGenerationAssetSlot: 'firstFrame' })
        }),
        expect.objectContaining({
          type: 'image',
          url: 'data:image/jpeg;base64,LAST',
          mimeType: 'image/jpeg',
          fileName: 'last.jpg',
          metadata: expect.objectContaining({ videoGenerationAssetSlot: 'lastFrame' })
        })
      ]
    })
    expect(screen.getByTestId('video-generation-request-preview').textContent).toContain(
      'image_tail'
    )
  })

  it('sends a selected reference image as an image attachment', async () => {
    mocks.currentConfig.value = buildConfig({
      qappProfiles: [buildKlingProfile('qapp-video')]
    })
    const imageFile = new File(['mock'], 'reference.png', { type: 'image/png' })
    mocks.selectFileMock.mockResolvedValue(imageFile)
    mocks.fileToDataUrlMock.mockResolvedValue('data:image/png;base64,AAAA')

    renderWorkspace()

    await screen.findByRole('combobox', { name: /Video model/ })
    fireEvent.click(screen.getByRole('button', { name: 'Choose Reference image' }))
    expect(await screen.findByText('reference.png')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

    await waitFor(() => {
      expect(mocks.chatMock).toHaveBeenCalledTimes(1)
    })
    expect(mocks.chatMock.mock.calls[0][0].messages[0]).toEqual({
      role: 'user',
      content: '',
      attachments: [
        expect.objectContaining({
          type: 'image',
          url: 'data:image/png;base64,AAAA',
          mimeType: 'image/png',
          fileName: 'reference.png',
          metadata: expect.objectContaining({ videoGenerationAssetSlot: 'referenceImage' })
        })
      ]
    })
  })

  it(
    'passes Seedance adaptive duration, valid frames, callback URL, and duration mode options',
    async () => {
      mocks.currentConfig.value = buildConfig({
        qappProfiles: [buildSeedanceProfile('seedance-video')]
      })

      renderWorkspace()

      await screen.findByRole('combobox', { name: /Video model/ })
      fireEvent.change(screen.getByLabelText('Video prompt'), {
        target: { value: 'wide tracking shot of waves' }
      })
      fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Duration' }))
      fireEvent.click(await screen.findByRole('option', { name: 'Adaptive' }))
      fireEvent.change(screen.getByLabelText('Frames'), { target: { value: '97' } })
      fireEvent.change(screen.getByLabelText('Callback URL'), {
        target: { value: 'https://example.com/callback' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

      await waitFor(() => {
        expect(mocks.chatMock).toHaveBeenCalledTimes(1)
      })
      expect(mocks.chatMock.mock.calls[0][0].videoGenerationOptions).toMatchObject({
        aspectRatio: '16:9',
        duration: -1,
        watermark: false,
        resolution: '720p',
        generateAudio: false,
        returnLastFrame: false,
        frames: 97,
        durationMode: 'adaptive',
        callbackUrl: 'https://example.com/callback'
      })
      expect(screen.getByTestId('video-generation-request-preview').textContent).toContain(
        'callback_url'
      )
    },
    15000
  )

  it('uses the selected Seedance image slot role for a single last-frame asset', async () => {
    mocks.currentConfig.value = buildConfig({
      qappProfiles: [buildSeedanceProfile('seedance-video')]
    })
    const lastFrame = new File(['last'], 'last.png', { type: 'image/png' })
    mocks.selectFileMock.mockResolvedValue(lastFrame)
    mocks.fileToDataUrlMock.mockResolvedValue('data:image/png;base64,LAST')

    renderWorkspace()

    await screen.findByRole('combobox', { name: /Video model/ })
    fireEvent.click(screen.getByRole('button', { name: 'Choose Last frame' }))
    expect(await screen.findByText('last.png')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

    await waitFor(() => {
      expect(mocks.chatMock).toHaveBeenCalledTimes(1)
    })
    expect(mocks.chatMock.mock.calls[0][0].videoGenerationOptions).toMatchObject({
      referenceRole: 'last_frame'
    })
    expect(mocks.chatMock.mock.calls[0][0].messages[0].attachments[0]).toMatchObject({
      type: 'image',
      url: 'data:image/png;base64,LAST',
      metadata: expect.objectContaining({ videoGenerationRole: 'last_frame' })
    })
  })

  it('validates and sends Seedance reference video/audio URL assets', async () => {
    mocks.currentConfig.value = buildConfig({
      qappProfiles: [buildSeedanceProfile('seedance-video')]
    })
    const videoFile = new File(['local-video'], 'local.mp4', { type: 'video/mp4' })
    mocks.selectFileMock.mockResolvedValue(videoFile)
    mocks.fileToDataUrlMock.mockResolvedValue('data:video/mp4;base64,LOCAL')

    renderWorkspace()

    await screen.findByRole('combobox', { name: /Video model/ })
    fireEvent.click(screen.getByRole('button', { name: 'Choose Reference video' }))
    expect(await screen.findByText('local.mp4')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

    await waitFor(() => {
      expect(mocks.notifyErrorMock).toHaveBeenCalledWith(
        expect.stringContaining('Reference video must use a public http(s) URL')
      )
    })
    expect(mocks.chatMock).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Reference video URL'), {
      target: { value: 'https://cdn.example/reference.mp4' }
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Use URL' })[3])
    fireEvent.change(screen.getByLabelText('Reference audio URL'), {
      target: { value: 'asset://audio/reference' }
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Use URL' })[4])
    fireEvent.change(screen.getByLabelText('Video prompt'), {
      target: { value: 'Blend media references' }
    })
    mocks.notifyErrorMock.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

    await waitFor(() => {
      expect(mocks.chatMock).toHaveBeenCalledTimes(1)
    })
    expect(mocks.chatMock.mock.calls[0][0].messages[0]).toEqual({
      role: 'user',
      content: 'Blend media references',
      attachments: [
        expect.objectContaining({
          type: 'video',
          url: 'https://cdn.example/reference.mp4',
          mimeType: 'video/mp4',
          metadata: expect.objectContaining({ videoGenerationRole: 'reference_video' })
        }),
        expect.objectContaining({
          type: 'file',
          url: 'asset://audio/reference',
          mimeType: 'audio/mpeg',
          metadata: expect.objectContaining({ videoGenerationRole: 'reference_audio' })
        })
      ]
    })
    const previewText = screen.getByTestId('video-generation-request-preview').textContent || ''
    expect(previewText).toContain('"video_url"')
    expect(previewText).toContain('"audio_url"')
    expect(previewText).not.toContain('unsupportedByCurrentClient')
  }, 15000)

  it('shows inline mode with compact controls', async () => {
    mocks.currentConfig.value = buildConfig({
      qappProfiles: [buildKlingProfile('qapp-video')]
    })

    renderWorkspace({ inline: true })

    expect((await screen.findByRole('combobox', { name: /Video model/ })).textContent).toContain(
      'qapp-video'
    )
    expect(screen.getByRole('button', { name: 'Generate video' })).toBeTruthy()
    expect(screen.queryByText(/Submit Kling or Volcengine/)).toBeNull()
  })

  it('dispatches generated inline video results to canvas and warns that provider URLs may expire', async () => {
    mocks.currentConfig.value = buildConfig({
      qappProfiles: [buildKlingProfile('qapp-video')]
    })
    const canvasEvents: CustomEvent[] = []
    const handleCanvasVideo = (event: Event) => {
      canvasEvents.push(event as CustomEvent)
    }
    window.addEventListener('canvas:add-video', handleCanvasVideo)

    try {
      renderWorkspace({ inline: true, projectId: 'project-video' })

      await screen.findByRole('combobox', { name: /Video model/ })
      fireEvent.change(screen.getByLabelText('Video prompt'), {
        target: { value: 'a neon city fly-through' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

      await screen.findByText('Latest result')
      expect(
        screen.getByText(/Provider-hosted video URLs can be temporary signed URLs and may expire/)
      ).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Download video' }))
      expect(mocks.downloadFileMock).toHaveBeenCalledWith(
        'https://cdn.example/generated.mp4',
        'generated.mp4'
      )

      await waitFor(() => {
        expect(canvasEvents).toHaveLength(1)
      })
      expect(canvasEvents[0].detail).toMatchObject({
        src: 'https://cdn.example/generated.mp4',
        fileName: 'generated.mp4',
        projectId: 'project-video',
        promptId: 'builtin-video-generation',
        select: false,
        fileItem: expect.objectContaining({ filename: 'generated.mp4', format: 'video/mp4' })
      })
    } finally {
      window.removeEventListener('canvas:add-video', handleCanvasVideo)
    }
  })

  it('prevents invalid Kling requests and reports inline validation errors', async () => {
    mocks.currentConfig.value = buildConfig({
      qappProfiles: [buildKlingProfile('qapp-video')]
    })

    renderWorkspace()

    await screen.findByRole('combobox', { name: /Video model/ })
    fireEvent.change(screen.getByLabelText('Video prompt'), {
      target: { value: 'a minimal prompt' }
    })
    fireEvent.change(screen.getByLabelText('CFG scale'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

    expect(
      (await screen.findAllByText('Kling CFG scale must be a number from 0 to 1.')).length
    ).toBeGreaterThan(0)
    expect(mocks.notifyErrorMock).toHaveBeenCalledWith(
      'Kling CFG scale must be a number from 0 to 1.'
    )
    expect(mocks.chatMock).not.toHaveBeenCalled()
  })

  it('reports provider responses that do not include a video attachment', async () => {
    mocks.currentConfig.value = buildConfig({
      qappProfiles: [buildKlingProfile('qapp-video')]
    })
    mocks.chatMock.mockResolvedValue({ content: 'no video returned' })

    renderWorkspace()

    await screen.findByRole('combobox', { name: /Video model/ })
    fireEvent.change(screen.getByLabelText('Video prompt'), {
      target: { value: 'a minimal prompt' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate video' }))

    await waitFor(() => {
      expect(mocks.notifyErrorMock).toHaveBeenCalledWith('Generation failed: no video returned')
    })
    expect(mocks.appendResultsMock).not.toHaveBeenCalled()
  })
})
