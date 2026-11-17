// The composer's per-message image budget (32 MiB, MAIN's preparation batch of the built-in
// OpenAI Responses route) applies at attach only where the send would take that route.
// The refusals on that route are in ChatPage.nativeDropImageCount.test.tsx.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import type { ChatAttachment } from '@shared/llm'
import ChatPage from './ChatPage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'

const f = vi.hoisted(() => ({
  materialize: vi.fn(),
  editing: vi.fn(),
  editImport: null as ((files: File[]) => Promise<ChatAttachment[]>) | null,
  notify: vi.fn(),
  blob: vi.fn(),
  imageCreated: vi.fn(),
  fileReaderCreated: vi.fn(),
  importDataUrl: vi.fn(),
  importBytes: vi.fn(),
  importFile: vi.fn(),
  read: vi.fn(),
  config: null as Config | null,
  noop: vi.fn(),
  profiles: [{ id: 'fixture-profile', model_name: 'Fixture', model_use: 'chat' }],
  remoteProfiles: [],
  sessionBInput: 'session b'
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue || key
  })
}))
vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: f.config,
    isReady: true,
    buildEnv: DEFAULT_BUILD_ENV,
    configUtils: {},
    updateConfig: vi.fn()
  })
}))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({
  useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null })
}))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: f.notify,
    notifyWarning: f.noop,
    notifySuccess: f.noop,
    notifyInfo: f.noop
  })
}))
vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({ availableProfiles: f.profiles, remoteProfiles: f.remoteProfiles })
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcFs: {},
    svcLLMProxy: { signHy3DModel: vi.fn() },
    svcManagedMedia: {
      importDataUrl: f.importDataUrl,
      importBytes: f.importBytes,
      importFile: f.importFile
    }
  })
}))
vi.mock('@renderer/utils/fileUtils', async (original) => ({
  ...(await original<typeof import('@renderer/utils/fileUtils')>()),
  fileToBlobUrl: f.blob
}))
vi.mock('@renderer/utils/droppedImageUtils', async (original) => ({
  ...(await original<typeof import('@renderer/utils/droppedImageUtils')>()),
  getDroppedLocalImageFiles: f.read,
  materializeInternalImageDragAttachment: (...args: unknown[]) => f.materialize(...args)
}))
vi.mock('./chatStorage', async (original) => ({
  ...(await original<typeof import('./chatStorage')>()),
  loadAllSessions: async () => [
    {
      id: 'a',
      title: 'a',
      profileId: 'fixture-profile',
      storageScope: 'composer-budget',
      messages: [],
      draft: {
        inputValue: 'keep',
        pendingAttachments: [
          { type: 'image', url: 'local-media://existing', fileName: 'existing.png' }
        ],
        pendingHiddenContext: '',
        updatedAt: Date.now()
      }
    },
    {
      id: 'b',
      title: 'b',
      profileId: 'fixture-profile',
      storageScope: 'composer-budget',
      messages: [],
      draft: {
        inputValue: f.sessionBInput,
        pendingAttachments: [],
        pendingHiddenContext: '',
        updatedAt: Date.now()
      }
    }
  ],
  saveSessionToDB: vi.fn(),
  debouncedSaveSessions: vi.fn(),
  cancelDebouncedSessionSave: vi.fn(),
  migrateFromLocalStorage: async () => null
}))
vi.mock('./components/SessionSidebar', () => ({
  default: ({ onSelectSession }: { onSelectSession: (id: string) => void }) => (
    <button onClick={() => onSelectSession('b')}>switch b</button>
  )
}))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('./components/ChatMessageList', () => ({
  default: ({
    onSetEditingIndex,
    onRegisterEditingAttachmentReceiver,
    onDropImageAttachments
  }: {
    onSetEditingIndex: (index: number) => void
    onRegisterEditingAttachmentReceiver: (receiver: (attachment: ChatAttachment) => void) => void
    onDropImageAttachments: (files: File[]) => Promise<ChatAttachment[]>
  }) => {
    f.editImport = onDropImageAttachments
    return (
      <button
        onClick={() => {
          onRegisterEditingAttachmentReceiver(f.editing)
          onSetEditingIndex(0)
        }}
      >
        edit fixture
      </button>
    )
  }
}))
vi.mock('./components/ChatComposer', () => ({
  default: ({
    inputValue,
    pendingAttachments
  }: {
    inputValue: string
    pendingAttachments: ChatAttachment[]
  }) => (
    <>
      <textarea data-testid="input" value={inputValue} readOnly />
      <pre data-testid="attachments">{JSON.stringify(pendingAttachments)}</pre>
    </>
  )
}))

const images = (count: number) =>
  Array.from({ length: count }, (_, i) => new File(['x'], `${i}.png`, { type: 'image/png' }))
const transfer = (files: File[], text = '') => ({
  files,
  items: files.map((file) => ({ kind: 'file', type: file.type, webkitGetAsEntry: () => null })),
  types: ['Files', 'text/plain'],
  getData: (key: string) => (key === 'text/plain' ? text : '')
})
const setup = async () => {
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'composer-budget'), 'a')
  render(
    <ThemeProvider theme={createTheme()}>
      <MemoryRouter>
        <ChatPage storageScope="composer-budget" />
      </MemoryRouter>
    </ThemeProvider>
  )
  await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('keep'))
}
beforeEach(() => {
  vi.resetAllMocks()
  f.config = structuredClone(DEFAULT_CONFIG)
  f.editImport = null
  f.materialize.mockImplementation(async (attachment: ChatAttachment) => {
    const actual = await vi.importActual<typeof import('@renderer/utils/droppedImageUtils')>(
      '@renderer/utils/droppedImageUtils'
    )
    return actual.materializeInternalImageDragAttachment(attachment)
  })
  f.blob.mockReturnValue('blob:test')
  const imported = {
    localMediaUrl: 'local-media://imported',
    reference: { version: 1, kind: 'managed', relativePath: 'imported', status: 'ready' }
  }
  f.importDataUrl.mockResolvedValue(imported)
  // A File without a path (jsdom has none) is imported as bytes.
  f.importBytes.mockResolvedValue(imported)
  f.read.mockResolvedValue({ files: [], failedUrls: [] })
  vi.stubGlobal(
    'Image',
    class {
      constructor() {
        f.imageCreated()
      }
      naturalWidth = 1
      naturalHeight = 1
      onload: (() => void) | null = null
      set src(_: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
  )
  const OriginalFileReader = FileReader
  vi.stubGlobal(
    'FileReader',
    class extends OriginalFileReader {
      constructor() {
        super()
        f.fileReaderCreated()
      }
    }
  )
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  vi.unstubAllGlobals()
  localStorage.clear()
})
describe('per-message image budget on routes MAIN does not limit this way', () => {
  const MiB = 1024 * 1024
  const size49 = Math.round(4.9 * MiB)
  // 4.9 MiB each, under the 5 MB per-image limit; 8 of them exceed the 32 MiB batch.
  const largeImages = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => new File([new Uint8Array(size49)], `${i}.png`, { type: 'image/png' })
    )
  const attachmentCount = () =>
    (JSON.parse(screen.getByTestId('attachments').textContent || '[]') as ChatAttachment[]).length
  const useProfile = (overrides: Record<string, unknown>) => {
    f.config!.llm_config.api_profiles = [
      {
        id: 'fixture-profile',
        provider: 'openai',
        deployment: 'cloud',
        model_use: 'chat',
        model_name: 'fixture',
        base_url: 'https://provider.invalid/v1',
        api_key: 'fixture',
        api_mode: 'responses',
        call_type: 'api',
        attachment_transports: ['request-data-url'],
        ...overrides
      } as Config['llm_config']['api_profiles'][number]
    ]
  }
  // Session b's draft is empty or holds f.sessionBInput.
  const setupSessionB = async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'switch b' }))
    await waitFor(() => expect(screen.getByTestId('input')).toHaveValue(f.sessionBInput))
  }
  afterEach(() => {
    f.sessionBInput = 'session b'
  })

  it('attaches eight 4.9 MB images when the draft asks for an image, which MAIN then generates without the preparation limit', async () => {
    useProfile({})
    f.sessionBInput = '帮我生成一张图片，参考这些设计图'
    await setupSessionB()
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: transfer(largeImages(8)) })
    await waitFor(() => expect(attachmentCount()).toBe(8))
    expect(f.notify).not.toHaveBeenCalledWith('chat.image_batch_too_large')
  })
  it('attaches eight 4.9 MB images on the chat-completions route', async () => {
    useProfile({ api_mode: 'chat-completions' })
    await setupSessionB()
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: transfer(largeImages(8)) })
    await waitFor(() => expect(attachmentCount()).toBe(8))
    expect(f.notify).not.toHaveBeenCalledWith('chat.image_batch_too_large')
  })
})
