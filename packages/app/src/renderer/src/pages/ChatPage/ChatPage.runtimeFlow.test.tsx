import React from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type SkillReferenceAttachment } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import type { ChatSession, ChatSessionDraft } from './chatStorage'
import ChatPage from './ChatPage'
import {
  BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
  BUILT_IN_PROMPT_TRANSLATION_SKILL_ID
} from './builtInSkills'
import {
  scopedStorageKey,
  STORAGE_KEY_CURRENT_SESSION_ID,
  STORAGE_KEY_LOADING_IDS,
  STORAGE_KEY_SELECTED_PROFILE
} from './chatPageShared'

const hoisted = vi.hoisted(() => ({
  currentConfig: { value: null as Config | null },
  runtimeMcpStatus: { value: null as Record<string, unknown> | null },
  availableProfiles: {
    value: [
      { id: 'base-model', model_name: 'GPT-4o', model_use: 'chat' as const },
      {
        id: 'vision-model',
        model_name: 'Vision Model',
        model_use: 'vision' as const,
        is_vision_model: true
      },
      { id: 'translation-model', model_name: 'Translation Model', model_use: 'chat' as const }
    ] as Array<{
      id: string
      model_name: string
      model_use?: 'chat' | 'vision' | 'ocr'
      is_vision_model?: boolean
      is_ocr_model?: boolean
      auth_mode?: string
      provider?: string
      deployment?: string
    }>
  },
  storedSessions: { value: [] as ChatSession[] },
  draftBackups: {
    value: {} as Record<string, { updatedAt: number; draft?: ChatSessionDraft }>
  },
  saveSessionToDBGate: { value: null as Promise<void> | null },
  debouncedSaveAllSessionsGate: { value: null as Promise<void> | null },
  loadAllSessionsMock: vi.fn(),
  saveAllSessionsMock: vi.fn(),
  requestChatCompletionMock: vi.fn(),
  requestChatCompletionStreamMock: vi.fn(),
  resolveAttachmentBatchCapabilityMock: vi.fn(),
  supportsStreamingChatCompletionMock: vi.fn(),
  selectFileMock: vi.fn(),
  fileToBlobUrlMock: vi.fn(() => 'blob:chat-draft'),
  fileToDataUrlMock: vi.fn(async () => 'data:application/octet-stream;base64,QUJD'),
  readTextFileMock: vi.fn(),
  chatMessageListMock: vi.fn(),
  notifySuccessMock: vi.fn(),
  notifyErrorMock: vi.fn(),
  notifyWarningMock: vi.fn()
}))

const cloneValue = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [],
    customSkills: [],
    customSkillCategories: [],
    useImageInterrogation: true,
    imageInterrogationProfileId: 'vision-model',
    usePromptTranslation: true,
    promptTranslationProfileId: 'translation-model'
  },
  plugin_config: {
    ...DEFAULT_CONFIG.plugin_config!,
    api_profiles: [],
    light_adjustment_prompt: DEFAULT_CONFIG.plugin_config?.light_adjustment_prompt || '',
    useImageInterrogation: true,
    imageInterrogationSystemPrompt: 'qapp vision system',
    imageInterrogationUserPrompt: 'qapp vision user',
    imageInterrogationProfileId: 'vision-model',
    usePromptTranslation: true,
    promptTranslationSystemPrompt: 'qapp translate system',
    promptTranslationUserPrompt: 'qapp translate user',
    promptTranslationProfileId: 'translation-model'
  },
  local_llm_server_config: {
    ...DEFAULT_CONFIG.local_llm_server_config
  },
  remote_llm_server_config: {
    ...DEFAULT_CONFIG.remote_llm_server_config
  },
  mcp_config: {
    ...DEFAULT_CONFIG.mcp_config,
    client: {
      ...DEFAULT_CONFIG.mcp_config?.client,
      servers: []
    }
  },
  aigc3d_config: {
    ...DEFAULT_CONFIG.aigc3d_config!
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options?: { defaultValue?: string; error?: string }) =>
      options?.defaultValue || options?.error || key
  })
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: hoisted.currentConfig.value,
    isReady: true,
    buildEnv: cloneValue(DEFAULT_BUILD_ENV),
    configUtils: {},
    updateConfig: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({
  useRuntimeMcpStatus: () => ({
    runtimeMcpStatus: hoisted.runtimeMcpStatus.value
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: hoisted.notifySuccessMock,
    notifyError: hoisted.notifyErrorMock,
    notifyWarning: hoisted.notifyWarningMock
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcFs: {
      readTextFile: hoisted.readTextFileMock
    },
    svcLLMProxy: {
      signHy3DModel: vi.fn()
    }
  })
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  selectFile: (_extensions?: string[]) => hoisted.selectFileMock(),
  fileToBlobUrl: (_file: File) => hoisted.fileToBlobUrlMock(),
  fileToDataUrl: (_file: File) => hoisted.fileToDataUrlMock(),
  checkFileSize: () => true,
  formatFileSize: (bytes: number) => `${bytes} B`
}))

vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({
    availableProfiles: hoisted.availableProfiles.value,
    remoteProfiles: []
  })
}))

vi.mock('./hooks/useImagePreview', () => ({
  useImagePreview: () => ({
    previewImage: null,
    imageScale: 1,
    imagePosition: { x: 0, y: 0 },
    isPreviewDragging: false,
    currentImageIndex: 0,
    setPreviewImage: vi.fn(),
    closePreview: vi.fn(),
    handlePreviewClick: vi.fn(),
    handlePreviewWheel: vi.fn(),
    handlePreviewMouseMove: vi.fn(),
    handlePreviewMouseUp: vi.fn(),
    handlePreviewMouseDown: vi.fn()
  })
}))

vi.mock('./hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    isListening: false,
    isSupported: false,
    startListening: vi.fn(),
    stopListening: vi.fn()
  })
}))

vi.mock('./chatStorage', () => ({
  loadAllSessions: (...args: unknown[]) => hoisted.loadAllSessionsMock(...args),
  saveAllSessions: (...args: unknown[]) => hoisted.saveAllSessionsMock(...args),
  saveSessionToDB: vi.fn(async (session: ChatSession) => {
    if (hoisted.saveSessionToDBGate.value) {
      await hoisted.saveSessionToDBGate.value
    }
    const nextSessions = cloneValue(hoisted.storedSessions.value)
    const existingIndex = nextSessions.findIndex((item) => item.id === session.id)
    if (existingIndex >= 0) {
      nextSessions[existingIndex] = cloneValue(session)
    } else {
      nextSessions.unshift(cloneValue(session))
    }
    hoisted.storedSessions.value = nextSessions
  }),
  deleteSessionFromDB: vi.fn(async (sessionId: string) => {
    hoisted.storedSessions.value = hoisted.storedSessions.value.filter(
      (session) => session.id !== sessionId
    )
  }),
  readSessionDraftBackup: vi.fn((sessionId: string, scope = 'default') => {
    const record = hoisted.draftBackups.value[`${scope}:${sessionId}`]
    return record ? cloneValue(record) : undefined
  }),
  writeSessionDraftBackup: vi.fn(
    (
      sessionId: string,
      updatedAt: number,
      draft: ChatSessionDraft | undefined,
      scope = 'default'
    ) => {
      const key = `${scope}:${sessionId}`
      const existingRecord = hoisted.draftBackups.value[key]
      if (existingRecord && existingRecord.updatedAt > updatedAt) {
        return
      }

      hoisted.draftBackups.value = {
        ...hoisted.draftBackups.value,
        [key]: draft ? { updatedAt, draft: cloneValue(draft) } : { updatedAt }
      }
    }
  ),
  deleteSessionDraftBackup: vi.fn((sessionId: string, scope = 'default') => {
    const key = `${scope}:${sessionId}`
    const nextBackups = { ...hoisted.draftBackups.value }
    delete nextBackups[key]
    hoisted.draftBackups.value = nextBackups
  }),
  migrateFromLocalStorage: vi.fn(async () => null),
  debouncedSaveAllSessions: vi.fn((sessions: ChatSession[]) => {
    const nextSessions = cloneValue(sessions)
    if (hoisted.debouncedSaveAllSessionsGate.value) {
      void hoisted.debouncedSaveAllSessionsGate.value.then(() => {
        hoisted.storedSessions.value = nextSessions
      })
      return
    }
    hoisted.storedSessions.value = nextSessions
  })
}))

vi.mock('./chatRequestUtils', () => ({
  requestChatCompletion: hoisted.requestChatCompletionMock,
  requestChatCompletionStream: hoisted.requestChatCompletionStreamMock,
  resolveAttachmentBatchCapability: hoisted.resolveAttachmentBatchCapabilityMock,
  supportsStreamingChatCompletion: hoisted.supportsStreamingChatCompletionMock
}))

vi.mock('./components/SessionSidebar', () => ({
  default: ({
    visibleSessions,
    currentSessionId,
    onCreateSession,
    onSelectSession
  }: {
    visibleSessions: ChatSession[]
    currentSessionId: string | null
    onCreateSession: () => void
    onSelectSession: (sessionId: string) => void
  }) => (
    <div data-testid="session-sidebar-mock">
      <button type="button" data-testid="session-create-mock" onClick={onCreateSession}>
        create-session
      </button>
      <div data-testid="session-current-id">{currentSessionId || 'none'}</div>
      {visibleSessions.map((session) => (
        <button
          key={session.id}
          type="button"
          data-testid={`session-select-${session.id}`}
          onClick={() => onSelectSession(session.id)}
        >
          {session.title}
        </button>
      ))}
    </div>
  )
}))

vi.mock('./components/SessionHistoryDialog', () => ({
  default: () => <div data-testid="session-history-dialog-mock" />
}))

vi.mock('./components/ChatPrimarySelection', () => ({
  default: ({
    selectedProfileId,
    selectedReasoningEffort,
    onSelectProfile,
    onSelectReasoningEffort
  }: {
    selectedProfileId?: string | null
    selectedReasoningEffort?: string | null
    onSelectProfile: (profileId: string | null) => void
    onSelectReasoningEffort?: (effort: 'medium' | 'high' | 'xhigh') => void
  }) => (
    <div data-testid="chat-primary-selection-mock">
      <button
        type="button"
        data-testid="select-base-model"
        onClick={() => onSelectProfile('base-model')}
      >
        select-base-model
      </button>
      <button
        type="button"
        data-testid="select-vision-model"
        onClick={() => onSelectProfile('vision-model')}
      >
        select-vision-model
      </button>
      <span data-testid="chat-primary-selection-value">{selectedProfileId || 'none'}</span>
      <button
        type="button"
        data-testid="select-reasoning-medium"
        onClick={() => onSelectReasoningEffort?.('medium')}
      >
        select-reasoning-medium
      </button>
      <button
        type="button"
        data-testid="select-reasoning-high"
        onClick={() => onSelectReasoningEffort?.('high')}
      >
        select-reasoning-high
      </button>
      <button
        type="button"
        data-testid="select-reasoning-xhigh"
        onClick={() => onSelectReasoningEffort?.('xhigh')}
      >
        select-reasoning-xhigh
      </button>
      <span data-testid="chat-reasoning-value">{selectedReasoningEffort || 'none'}</span>
    </div>
  )
}))

vi.mock('./components/ChatSkillPicker', () => ({
  default: () => <div data-testid="chat-skill-picker-mock" />
}))

vi.mock('./components/ImagePreviewOverlay', () => ({
  default: () => null
}))

vi.mock('./components/ImageContextMenu', () => ({
  default: () => null
}))

vi.mock('./components/ChatComposer', () => ({
  default: ({
    inputValue,
    onInputChange,
    onUploadFile,
    pendingAttachments,
    selectedSkillName,
    modelSelectorSlot
  }: {
    inputValue: string
    onInputChange: (value: string) => void
    onUploadFile: () => void
    pendingAttachments: ChatAttachment[]
    selectedSkillName?: string
    modelSelectorSlot?: React.ReactNode
  }) => (
    <div data-testid="chat-composer-mock">
      <div>{selectedSkillName || 'no-skill'}</div>
      <input
        data-testid="chat-composer-input-mock"
        value={inputValue}
        onChange={(event) => onInputChange(event.target.value)}
      />
      <button type="button" data-testid="chat-composer-upload-mock" onClick={onUploadFile}>
        upload
      </button>
      <div data-testid="chat-composer-attachment-count">{pendingAttachments.length}</div>
      <div data-testid="chat-composer-attachment-names">
        {pendingAttachments.map((attachment) => attachment.fileName || attachment.url).join('|')}
      </div>
      {modelSelectorSlot}
    </div>
  )
}))

vi.mock('./components/ChatMessageList', () => ({
  default: (props: {
    currentSession?: ChatSession
    isLoading?: boolean
    pendingConfirmation?: {
      requestId: string
      prompt: string
      confirmLabel: string
      cancelLabel: string
    } | null
    onResolvePendingConfirmation?: (requestId: string, confirmed: boolean) => void
  }) => {
    hoisted.chatMessageListMock(props)
    return (
      <>
        <pre data-testid="chat-session-state">
          {JSON.stringify(props.currentSession ?? null, null, 2)}
        </pre>
        {props.pendingConfirmation ? (
          <div data-testid="chat-pending-confirmation-mock">
            <span>{props.pendingConfirmation.prompt}</span>
            <button
              type="button"
              data-testid="chat-pending-confirm"
              onClick={() =>
                props.onResolvePendingConfirmation?.(props.pendingConfirmation!.requestId, true)
              }
            >
              {props.pendingConfirmation.confirmLabel}
            </button>
            <button
              type="button"
              data-testid="chat-pending-cancel"
              onClick={() =>
                props.onResolvePendingConfirmation?.(props.pendingConfirmation!.requestId, false)
              }
            >
              {props.pendingConfirmation.cancelLabel}
            </button>
          </div>
        ) : null}
      </>
    )
  }
}))

const theme = createTheme()

const createImageAttachment = (fileName: string): ChatAttachment => ({
  type: 'image',
  url: `file:///C:/magicpot/${fileName}`,
  fileName,
  mimeType: 'image/png',
  sizeBytes: 1024
})

const createFileAttachment = (fileName: string, mimeType = 'application/pdf'): ChatAttachment => ({
  type: 'file',
  url: `file:///C:/magicpot/${fileName}`,
  fileName,
  mimeType,
  sizeBytes: 2048
})

const createSkillReferenceImageAttachment = (fileName: string): SkillReferenceAttachment => ({
  type: 'image',
  url: `file:///C:/magicpot/${fileName}`,
  fileName,
  mimeType: 'image/png',
  sizeBytes: 1024
})

const createSkillReferenceFileAttachment = (
  fileName: string,
  mimeType = 'application/pdf'
): SkillReferenceAttachment => ({
  type: 'file',
  url: `file:///C:/magicpot/${fileName}`,
  fileName,
  mimeType,
  sizeBytes: 2048
})

const renderChatPage = (
  storageScopeOrProps: string | { acceptExternalInput?: boolean; active?: boolean } = 'runtime-flow'
) => {
  const storageScope =
    typeof storageScopeOrProps === 'string' ? storageScopeOrProps : 'runtime-flow'
  const acceptExternalInput =
    typeof storageScopeOrProps === 'string' ? undefined : storageScopeOrProps.acceptExternalInput
  const active = typeof storageScopeOrProps === 'string' ? undefined : storageScopeOrProps.active

  return render(
    <ThemeProvider theme={theme}>
      <ChatPage
        compact
        storageScope={storageScope}
        acceptExternalInput={acceptExternalInput}
        active={active}
      />
    </ThemeProvider>
  )
}

const dispatchNewSession = async (
  detail: {
    skillId?: string
    profileId?: string
    initialMessage?: string
    initialAttachments?: ChatAttachment[]
  },
  scope = 'runtime-flow'
) => {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('chat:newSession', {
        detail: {
          scope,
          ...detail
        }
      })
    )
  })
}

const dispatchSwitchSession = async (sessionId: string, scope = 'runtime-flow') => {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('chat:switchSession', {
        detail: {
          scope,
          sessionId
        }
      })
    )
  })
}

const createLocalFile = (name: string, type: string, path: string): File => {
  const file = new File(['mock-file'], name, { type })
  Object.defineProperty(file, 'path', {
    configurable: true,
    value: path
  })
  return file
}

const readCurrentSessionState = (): ChatSession | null => {
  const serialized = screen.getByTestId('chat-session-state').textContent || 'null'
  return JSON.parse(serialized) as ChatSession | null
}

const readCurrentSessionStateWithin = (container: HTMLElement): ChatSession | null => {
  const serialized = within(container).getByTestId('chat-session-state').textContent || 'null'
  return JSON.parse(serialized) as ChatSession | null
}

describe('ChatPage runtime workflow integration', () => {
  beforeEach(() => {
    hoisted.currentConfig.value = createConfig()
    hoisted.runtimeMcpStatus.value = null
    hoisted.availableProfiles.value = [
      { id: 'base-model', model_name: 'GPT-4o', model_use: 'chat' as const },
      {
        id: 'vision-model',
        model_name: 'Vision Model',
        model_use: 'vision' as const,
        is_vision_model: true
      },
      { id: 'translation-model', model_name: 'Translation Model', model_use: 'chat' as const }
    ]
    hoisted.storedSessions.value = []
    hoisted.draftBackups.value = {}
    hoisted.saveSessionToDBGate.value = null
    hoisted.debouncedSaveAllSessionsGate.value = null
    hoisted.loadAllSessionsMock.mockReset()
    hoisted.loadAllSessionsMock.mockImplementation(async () =>
      cloneValue(hoisted.storedSessions.value)
    )
    hoisted.saveAllSessionsMock.mockReset()
    hoisted.saveAllSessionsMock.mockImplementation(async (sessions: ChatSession[]) => {
      hoisted.storedSessions.value = cloneValue(sessions)
    })
    hoisted.readTextFileMock.mockReset()
    hoisted.chatMessageListMock.mockClear()
    hoisted.notifySuccessMock.mockReset()
    hoisted.notifyErrorMock.mockReset()
    hoisted.notifyWarningMock.mockReset()
    hoisted.resolveAttachmentBatchCapabilityMock.mockReset()
    hoisted.resolveAttachmentBatchCapabilityMock.mockResolvedValue(1)
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionStreamMock.mockReset()
    hoisted.supportsStreamingChatCompletionMock.mockReset()
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(false)
    hoisted.selectFileMock.mockReset()
    hoisted.selectFileMock.mockResolvedValue(null)
    hoisted.fileToBlobUrlMock.mockClear()
    hoisted.fileToDataUrlMock.mockClear()
    hoisted.requestChatCompletionMock.mockImplementation(
      async ({
        skillRuntime,
        messages
      }: {
        skillRuntime?: { skillId?: string }
        messages: Array<{ attachments?: ChatAttachment[] }>
      }) => {
        const lastMessage = messages[messages.length - 1]
        const firstAttachment = lastMessage?.attachments?.[0]
        const attachmentBaseName = firstAttachment?.fileName?.replace(/\.[^.]+$/, '') || 'asset'

        switch (skillRuntime?.skillId) {
          case BUILT_IN_IMAGE_INTERROGATION_SKILL_ID:
            return {
              content: `visual analysis for ${attachmentBaseName}`
            }
          case BUILT_IN_PROMPT_TRANSLATION_SKILL_ID:
            return {
              content: 'translated prompt output'
            }
          default:
            return {
              content: 'default reply'
            }
        }
      }
    )

    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = '<div id="agent-workspace-skill-portal"></div>'

    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
  })

  it('restores the last selected model when bootstrapping the initial session', async () => {
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'),
      'vision-model'
    )

    renderChatPage()

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.profileId).toBe('vision-model')
    })
  })

  it('clears stale persisted loading placeholders after restart', async () => {
    const staleSession: ChatSession = {
      id: 'stale-loading-session',
      title: 'Restarted request',
      messages: [
        {
          role: 'user',
          content: 'This was interrupted by restart.'
        },
        {
          role: 'assistant',
          content: ''
        }
      ]
    }
    hoisted.storedSessions.value = [staleSession]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      staleSession.id
    )
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_LOADING_IDS, 'runtime-flow'),
      JSON.stringify([staleSession.id])
    )

    renderChatPage()

    await waitFor(() => {
      const calls = hoisted.chatMessageListMock.mock.calls
      const latestProps = calls[calls.length - 1]?.[0] as
        | { currentSession?: ChatSession; isLoading?: boolean }
        | undefined
      expect(latestProps?.currentSession?.id).toBe(staleSession.id)
      expect(latestProps?.isLoading).toBe(false)
    })
    expect(localStorage.getItem(scopedStorageKey(STORAGE_KEY_LOADING_IDS, 'runtime-flow'))).toBe(
      '[]'
    )
  })

  it('keeps the current model selection when creating a new session in the same scope', async () => {
    const user = userEvent.setup()

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await user.click(screen.getByTestId('select-vision-model'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-primary-selection-value').textContent).toBe('vision-model')
      const currentSession = readCurrentSessionState()
      expect(currentSession?.profileId).toBe('vision-model')
    })

    await dispatchNewSession({})

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.profileId).toBe('vision-model')
    })
  })

  it('applies external send-to-agent input only to the matching targetScope', async () => {
    render(
      <ThemeProvider theme={theme}>
        <div data-testid="agent-a">
          <ChatPage compact storageScope="runtime-flow-a" />
        </div>
        <div data-testid="agent-b">
          <ChatPage compact storageScope="runtime-flow-b" />
        </div>
      </ThemeProvider>
    )

    const agentA = screen.getByTestId('agent-a')
    const agentB = screen.getByTestId('agent-b')

    await waitFor(() =>
      expect(within(agentA).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(within(agentB).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )

    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            text: 'inspect just this selection',
            hiddenText: 'selection-only hidden context',
            attachment: createImageAttachment('scope-only.png'),
            targetScope: 'runtime-flow-b'
          }
        })
      )
    })

    await waitFor(() => {
      expect(within(agentA).getByTestId('chat-composer-input-mock')).toHaveValue('')
      expect(within(agentA).getByTestId('chat-composer-attachment-count').textContent).toBe('0')
      expect(within(agentB).getByTestId('chat-composer-input-mock')).toHaveValue(
        'inspect just this selection'
      )
      expect(within(agentB).getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(within(agentB).getByTestId('chat-composer-attachment-names').textContent).toContain(
        'scope-only.png'
      )
    })
  })

  it('routes unscoped send-to-agent input only into the active mounted ChatPage', async () => {
    render(
      <ThemeProvider theme={theme}>
        <div data-testid="agent-a">
          <ChatPage compact storageScope="runtime-flow-a" active={false} />
        </div>
        <div data-testid="agent-b">
          <ChatPage compact storageScope="runtime-flow-b" active />
        </div>
      </ThemeProvider>
    )

    const agentA = screen.getByTestId('agent-a')
    const agentB = screen.getByTestId('agent-b')

    await waitFor(() =>
      expect(within(agentA).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(within(agentB).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            text: 'active agent only',
            attachment: createImageAttachment('active-only.png')
          }
        })
      )
    })

    await waitFor(() => {
      expect(within(agentA).getByTestId('chat-composer-input-mock')).toHaveValue('')
      expect(within(agentA).getByTestId('chat-composer-attachment-count').textContent).toBe('0')
      expect(within(agentB).getByTestId('chat-composer-input-mock')).toHaveValue(
        'active agent only'
      )
      expect(within(agentB).getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(within(agentB).getByTestId('chat-composer-attachment-names').textContent).toContain(
        'active-only.png'
      )
    })
  })

  it('allows scoped send-to-agent input to mutate an explicit inactive target scope', async () => {
    render(
      <ThemeProvider theme={theme}>
        <div data-testid="agent-a">
          <ChatPage compact storageScope="runtime-flow-a" active />
        </div>
        <div data-testid="agent-b">
          <ChatPage compact storageScope="runtime-flow-b" active={false} />
        </div>
      </ThemeProvider>
    )

    const agentA = screen.getByTestId('agent-a')
    const agentB = screen.getByTestId('agent-b')

    await waitFor(() =>
      expect(within(agentA).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(within(agentB).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            text: 'explicit inactive target',
            targetScope: 'runtime-flow-b'
          }
        })
      )
    })

    await waitFor(() => {
      expect(within(agentA).getByTestId('chat-composer-input-mock')).toHaveValue('')
      expect(within(agentB).getByTestId('chat-composer-input-mock')).toHaveValue(
        'explicit inactive target'
      )
    })
  })

  it('handles unscoped compact chat events only in the active mounted ChatPage', async () => {
    render(
      <ThemeProvider theme={theme}>
        <div data-testid="agent-a">
          <ChatPage compact storageScope="runtime-flow-a" active={false} />
        </div>
        <div data-testid="agent-b">
          <ChatPage compact storageScope="runtime-flow-b" active />
        </div>
      </ThemeProvider>
    )

    const agentA = screen.getByTestId('agent-a')
    const agentB = screen.getByTestId('agent-b')

    await waitFor(() =>
      expect(within(agentA).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(within(agentB).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )

    await waitFor(() => {
      expect(readCurrentSessionStateWithin(agentA)?.id).toBeTruthy()
      expect(readCurrentSessionStateWithin(agentB)?.id).toBeTruthy()
    })

    const initialAgentASessionId = readCurrentSessionStateWithin(agentA)?.id

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:newSession', {
          detail: {
            title: 'active-only session'
          }
        })
      )
    })

    await waitFor(() => {
      expect(readCurrentSessionStateWithin(agentA)?.id).toBe(initialAgentASessionId)
      expect(readCurrentSessionStateWithin(agentB)?.title).toBe('active-only session')
    })
  })

  it('surfaces external confirmations inside the Agent conversation and emits the choice', async () => {
    const user = userEvent.setup()
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    const sessionId = readCurrentSessionState()?.id as string
    const responsePromise = new Promise<{
      scope?: string
      sessionId?: string
      requestId?: string
      confirmed?: boolean
    }>((resolve) => {
      const handleResponse = (event: Event) => {
        window.removeEventListener('chat:confirmation-response', handleResponse)
        resolve(
          (
            event as CustomEvent<{
              scope?: string
              sessionId?: string
              requestId?: string
              confirmed?: boolean
            }>
          ).detail
        )
      }
      window.addEventListener('chat:confirmation-response', handleResponse)
    })

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:request-confirmation', {
          detail: {
            scope: 'runtime-flow',
            sessionId,
            requestId: 'target-confirm-1',
            prompt: '请确认目标执行方案',
            confirmLabel: '确认执行',
            cancelLabel: '取消',
            confirmedUserContent: '确认执行该目标方案。',
            cancelledUserContent: '取消执行该目标方案。'
          }
        })
      )
    })

    await waitFor(() =>
      expect(screen.getByTestId('chat-pending-confirmation-mock')).toHaveTextContent(
        '请确认目标执行方案'
      )
    )

    await user.click(screen.getByTestId('chat-pending-confirm'))

    await expect(responsePromise).resolves.toEqual({
      scope: 'runtime-flow',
      sessionId,
      requestId: 'target-confirm-1',
      confirmed: true
    })
    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages.at(-1)).toEqual({
        role: 'user',
        content: '确认执行该目标方案。'
      })
    })
  })

  it('cancels pending external confirmations when the session is terminated', async () => {
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    const sessionId = readCurrentSessionState()?.id as string
    const responsePromise = new Promise<{
      scope?: string
      sessionId?: string
      requestId?: string
      confirmed?: boolean
    }>((resolve) => {
      const handleResponse = (event: Event) => {
        window.removeEventListener('chat:confirmation-response', handleResponse)
        resolve(
          (
            event as CustomEvent<{
              scope?: string
              sessionId?: string
              requestId?: string
              confirmed?: boolean
            }>
          ).detail
        )
      }
      window.addEventListener('chat:confirmation-response', handleResponse)
    })

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:request-confirmation', {
          detail: {
            scope: 'runtime-flow',
            sessionId,
            requestId: 'target-confirm-cancel',
            prompt: 'Review target plan',
            confirmLabel: 'Confirm',
            cancelLabel: 'Cancel',
            confirmedUserContent: 'Confirm target plan.',
            cancelledUserContent: 'Cancel target plan.'
          }
        })
      )
    })

    await waitFor(() =>
      expect(screen.getByTestId('chat-pending-confirmation-mock')).toHaveTextContent(
        'Review target plan'
      )
    )

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:terminate-session', {
          detail: {
            scope: 'runtime-flow',
            sessionId
          }
        })
      )
    })

    await expect(responsePromise).resolves.toEqual({
      scope: 'runtime-flow',
      sessionId,
      requestId: 'target-confirm-cancel',
      confirmed: false
    })
    await waitFor(() =>
      expect(screen.queryByTestId('chat-pending-confirmation-mock')).not.toBeInTheDocument()
    )
  })

  it('routes document paste attachments only into the active mounted ChatPage', async () => {
    const OriginalImage = globalThis.Image
    class MockImage {
      naturalWidth = 64
      naturalHeight = 32
      width = 64
      height = 32
      onload: (() => void) | null = null
      onerror: (() => void) | null = null

      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)
    hoisted.fileToBlobUrlMock.mockReturnValue('data:image/png;base64,iVBORw0KGgo=')

    render(
      <ThemeProvider theme={theme}>
        <div data-testid="agent-a">
          <ChatPage compact storageScope="runtime-flow-a" active={false} />
        </div>
        <div data-testid="agent-b">
          <ChatPage compact storageScope="runtime-flow-b" active />
        </div>
      </ThemeProvider>
    )

    const agentA = screen.getByTestId('agent-a')
    const agentB = screen.getByTestId('agent-b')

    await waitFor(() =>
      expect(within(agentA).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(within(agentB).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )

    await act(async () => {
      await Promise.resolve()
    })

    try {
      await act(async () => {
        const pasteEvent = new Event('paste', {
          bubbles: true,
          cancelable: true
        }) as ClipboardEvent
        Object.defineProperty(pasteEvent, 'clipboardData', {
          value: {
            items: [
              {
                type: 'image/png',
                getAsFile: () => new File(['pasted-image'], 'clipboard.png', { type: 'image/png' })
              }
            ]
          }
        })
        document.dispatchEvent(pasteEvent)
      })

      await waitFor(() => {
        expect(within(agentA).getByTestId('chat-composer-attachment-count').textContent).toBe('0')
        expect(within(agentB).getByTestId('chat-composer-attachment-count').textContent).toBe('1')
        expect(within(agentB).getByTestId('chat-composer-attachment-names').textContent).toContain(
          'pasted-image.png'
        )
      })
    } finally {
      vi.stubGlobal('Image', OriginalImage)
      hoisted.fileToBlobUrlMock.mockImplementation(() => 'blob:chat-draft')
    }
  })

  it('restores per-session drafts after switching away and remounting the same scope', async () => {
    const user = userEvent.setup()
    const firstRender = renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    let firstSessionId: string | undefined
    await waitFor(() => {
      firstSessionId = readCurrentSessionState()?.id
      expect(firstSessionId).toBeTruthy()
    })

    await user.type(screen.getByTestId('chat-composer-input-mock'), 'draft prompt for mesh')

    hoisted.selectFileMock.mockResolvedValueOnce(
      createLocalFile('mesh.glb', 'model/gltf-binary', 'C:\\magicpot\\mesh.glb')
    )
    await user.click(screen.getByTestId('chat-composer-upload-mock'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('draft prompt for mesh')
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain('mesh.glb')
    })

    await dispatchNewSession({})

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.id).toBeTruthy()
      expect(currentSession?.id).not.toBe(firstSessionId)
    })

    expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
    expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('0')

    await dispatchSwitchSession(firstSessionId as string)

    await waitFor(() => {
      expect(readCurrentSessionState()?.id).toBe(firstSessionId)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('draft prompt for mesh')
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain('mesh.glb')
    })

    firstRender.unmount()
    renderChatPage()

    await waitFor(() => {
      expect(
        localStorage.getItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'))
      ).toBe(firstSessionId)
      expect(readCurrentSessionState()?.id).toBe(firstSessionId)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('draft prompt for mesh')
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain('mesh.glb')
    })
  })

  it('restores the latest draft backup after an immediate remount before session persistence finishes', async () => {
    const user = userEvent.setup()
    const firstRender = renderChatPage('runtime-flow-race')

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    let firstSessionId: string | undefined
    await waitFor(() => {
      firstSessionId = readCurrentSessionState()?.id
      expect(firstSessionId).toBeTruthy()
    })

    await user.type(screen.getByTestId('chat-composer-input-mock'), 'draft survives remount race')

    hoisted.selectFileMock.mockResolvedValueOnce(
      createLocalFile('draft.glb', 'model/gltf-binary', 'C:\\magicpot\\draft.glb')
    )
    await user.click(screen.getByTestId('chat-composer-upload-mock'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(
        'draft survives remount race'
      )
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain(
        'draft.glb'
      )
    })

    let releaseSaveSessionToDB: (() => void) | null = null
    hoisted.saveSessionToDBGate.value = new Promise<void>((resolve) => {
      releaseSaveSessionToDB = resolve
    })

    firstRender.unmount()
    renderChatPage('runtime-flow-race')

    await waitFor(() => {
      expect(readCurrentSessionState()?.id).toBe(firstSessionId)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(
        'draft survives remount race'
      )
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain(
        'draft.glb'
      )
    })

    await act(async () => {
      releaseSaveSessionToDB?.()
      hoisted.saveSessionToDBGate.value = null
    })
  })

  it('does not let an older async draft persistence restore over newer composer input', async () => {
    const user = userEvent.setup()
    const originalFetch = globalThis.fetch
    let releaseFetch: (() => void) | null = null
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseFetch = () =>
            resolve(new Response(new Blob(['old'], { type: 'model/gltf-binary' })))
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    try {
      renderChatPage('runtime-flow-stale-draft')

      await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

      await user.type(screen.getByTestId('chat-composer-input-mock'), 'stale draft')

      hoisted.selectFileMock.mockResolvedValueOnce(
        new File(['stale'], 'stale.glb', { type: 'model/gltf-binary' })
      )
      await user.click(screen.getByTestId('chat-composer-upload-mock'))

      await waitFor(() => expect(fetchMock).toHaveBeenCalled())

      await user.type(screen.getByTestId('chat-composer-input-mock'), ' plus fresh edit')

      await act(async () => {
        releaseFetch?.()
        await Promise.resolve()
      })

      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(
        'stale draft plus fresh edit'
      )

      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 250))
      })
      if (fetchMock.mock.calls.length > 1) {
        await act(async () => {
          releaseFetch?.()
          await Promise.resolve()
        })
      }
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  it('does not keep another session draft when returning to a session with an empty draft', async () => {
    const user = userEvent.setup()
    renderChatPage('runtime-flow-empty-draft')

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    let firstSessionId: string | undefined
    await waitFor(() => {
      firstSessionId = readCurrentSessionState()?.id
      expect(firstSessionId).toBeTruthy()
    })

    const input = screen.getByTestId('chat-composer-input-mock')
    await user.type(input, 'temporary draft')
    await user.clear(input)

    await dispatchNewSession({}, 'runtime-flow-empty-draft')
    await waitFor(() => {
      expect(readCurrentSessionState()?.id).not.toBe(firstSessionId)
    })

    await user.type(screen.getByTestId('chat-composer-input-mock'), 'second session draft')

    await dispatchSwitchSession(firstSessionId as string, 'runtime-flow-empty-draft')

    await waitFor(() => {
      expect(readCurrentSessionState()?.id).toBe(firstSessionId)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
    })
  })

  it('reuses the remembered session id when the initial session has not finished debounced persistence', async () => {
    const user = userEvent.setup()
    let releaseDebouncedSave: (() => void) | null = null
    hoisted.debouncedSaveAllSessionsGate.value = new Promise<void>((resolve) => {
      releaseDebouncedSave = resolve
    })

    const firstRender = renderChatPage('runtime-flow-initial-race')

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    let firstSessionId: string | undefined
    await waitFor(() => {
      firstSessionId = readCurrentSessionState()?.id
      expect(firstSessionId).toBeTruthy()
    })

    await user.type(screen.getByTestId('chat-composer-input-mock'), 'draft on unsaved session')

    hoisted.selectFileMock.mockResolvedValueOnce(
      Object.assign(new File(['glb'], 'unsaved.glb', { type: 'model/gltf-binary' }), {
        path: 'C:\\magicpot\\unsaved.glb'
      })
    )

    await user.click(screen.getByTestId('chat-composer-upload-mock'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(hoisted.storedSessions.value).toEqual([])
    })

    firstRender.unmount()

    renderChatPage('runtime-flow-initial-race')

    await waitFor(() => {
      expect(readCurrentSessionState()?.id).toBe(firstSessionId)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('draft on unsaved session')
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain(
        'unsaved.glb'
      )
    })

    await act(async () => {
      releaseDebouncedSave?.()
      hoisted.debouncedSaveAllSessionsGate.value = null
    })
  })

  it('reuses the last selected model when a new scope has no scoped profile record yet', async () => {
    const user = userEvent.setup()
    const firstRender = renderChatPage('runtime-flow-a')

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await user.click(screen.getByTestId('select-vision-model'))

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY_SELECTED_PROFILE)).toBe('vision-model')
    })

    firstRender.unmount()

    renderChatPage('runtime-flow-b')

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.profileId).toBe('vision-model')
    })
  })

  it('runs image interrogation on the same runtime foundation with qapp image settings', async () => {
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
      initialMessage: 'Inspect this image',
      initialAttachments: [createImageAttachment('hero.png')]
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    expect(firstCall.profileId).toBe('vision-model')
    expect(firstCall.systemPrompt).toBe('qapp vision system')
    expect(firstCall.skillRuntime).toEqual(
      expect.objectContaining({
        skillId: BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
        execution: expect.objectContaining({
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'chat',
          fallbackStrategy: 'default',
          persistSessionUrl: false
        }),
        bindings: [
          expect.objectContaining({
            appId: 'qapp.image-interrogation',
            resourceUris: [
              'qapp.imageInterrogation.systemPrompt',
              'qapp.imageInterrogation.userPrompt'
            ]
          })
        ]
      })
    )
    expect(firstCall.messages[0].hiddenContext).toContain('qapp vision user')

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.skillId).toBe(BUILT_IN_IMAGE_INTERROGATION_SKILL_ID)
      expect(currentSession?.messages).toHaveLength(2)
    })
  })

  it('runs prompt translation on the same runtime foundation with explicit translation defaults', async () => {
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
      initialMessage: 'Translate this prompt into English'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    expect(firstCall.profileId).toBe('translation-model')
    expect(firstCall.systemPrompt).toBe('qapp translate system')
    expect(firstCall.skillRuntime).toEqual(
      expect.objectContaining({
        skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
        execution: expect.objectContaining({
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'chat',
          fallbackStrategy: 'default',
          persistSessionUrl: false
        }),
        bindings: [
          expect.objectContaining({
            appId: 'qapp.prompt-translation',
            resourceUris: [
              'qapp.promptTranslation.systemPrompt',
              'qapp.promptTranslation.userPrompt'
            ]
          })
        ]
      })
    )
    expect(firstCall.messages[0].hiddenContext).toContain('qapp translate user')

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.skillId).toBe(BUILT_IN_PROMPT_TRANSLATION_SKILL_ID)
      expect(currentSession?.messages).toHaveLength(2)
    })
  })

  it('forwards bound MCP tool capabilities in compact ChatPage sessions', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {
      ...config,
      llm_config: {
        ...config.llm_config,
        customSkills: [
          {
            id: 'github-mcp-skill',
            category: 'agent',
            skillName: 'GitHub MCP Skill',
            prompt: 'Use GitHub MCP when needed.',
            type: 'normal',
            bindings: [
              {
                appId: 'mcp.github',
                toolNames: ['mcp.github.issues.list']
              }
            ]
          }
        ]
      },
      mcp_config: {
        ...config.mcp_config,
        client: {
          ...config.mcp_config.client,
          servers: [
            {
              id: 'github',
              enabled: true,
              transport: 'stdio',
              command: 'github-mcp'
            }
          ]
        }
      }
    }

    hoisted.runtimeMcpStatus.value = {
      client: {
        connections: [
          {
            id: 'github',
            aliasPrefix: 'mcp.github',
            status: 'connected',
            toolCount: 1,
            toolAliases: ['mcp.github.issues.list'],
            transport: 'stdio'
          }
        ],
        discoveredToolCount: 1
      },
      server: {
        enabled: true,
        path: '/api/mcp',
        exposeResources: true,
        authRequired: false
      }
    }

    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({
      content: 'Fetched GitHub issue summary.'
    })

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: 'github-mcp-skill',
      initialMessage: 'Show open GitHub issues for this repo.'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    expect(firstCall.skillRuntime).toEqual(
      expect.objectContaining({
        skillId: 'github-mcp-skill',
        bindings: [
          expect.objectContaining({
            appId: 'mcp.github',
            toolNames: ['mcp.github.issues.list'],
            transport: 'mcp',
            source: 'mcp-client'
          })
        ]
      })
    )
  })

  it('accepts attachment-only assistant results without treating them as empty responses', async () => {
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({
      content: '',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/generated-armor.png',
          mimeType: 'image/png'
        }
      ]
    })

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
      initialMessage: '直接出图，不要出文字'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages).toHaveLength(2)
      expect(currentSession?.messages[1]).toEqual(
        expect.objectContaining({
          role: 'assistant',
          content: '',
          attachments: [
            expect.objectContaining({
              type: 'image',
              url: 'https://example.com/generated-armor.png',
              mimeType: 'image/png'
            })
          ]
        })
      )
    })
  })

  it('keeps multiple image references together for image generation requests', async () => {
    localStorage.setItem(
      scopedStorageKey('chat.imageGenerationOptions', 'runtime-flow'),
      JSON.stringify({
        enabled: true,
        action: 'edit',
        outputFormat: 'png',
        quality: 'high',
        background: 'auto',
        size: 'auto'
      })
    )
    hoisted.resolveAttachmentBatchCapabilityMock.mockClear()
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({
      content: 'generated from both references'
    })

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      profileId: 'vision-model',
      initialMessage: 'Use both references together.',
      initialAttachments: [createImageAttachment('role.png'), createImageAttachment('ghost.png')]
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(hoisted.resolveAttachmentBatchCapabilityMock).not.toHaveBeenCalled()

    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    const lastRequestMessage = firstCall.messages[firstCall.messages.length - 1]
    expect(lastRequestMessage.attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        fileName: 'role.png'
      }),
      expect.objectContaining({
        type: 'image',
        fileName: 'ghost.png'
      })
    ])
  })

  it('warns and blocks skill execution when the selected model supports neither images nor documents', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {
      ...config,
      llm_config: {
        ...config.llm_config,
        customSkills: [
          {
            id: 'asset-review',
            category: 'Design',
            skillName: 'Asset Review',
            prompt: 'Review the uploaded references.',
            type: 'normal'
          }
        ]
      }
    }

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: 'asset-review',
      initialMessage: 'Check these references',
      initialAttachments: [createImageAttachment('hero.png'), createFileAttachment('brief.pdf')]
    })

    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledTimes(1))

    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(String(hoisted.notifyWarningMock.mock.calls[0]?.[0] || '')).toContain(
      '不支持图片和文档输入，仅支持文本输入'
    )

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages).toHaveLength(0)
    })
  })

  it('warns about document input when the selected model supports images only', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {
      ...config,
      llm_config: {
        ...config.llm_config,
        customSkills: [
          {
            id: 'asset-review',
            category: 'Design',
            skillName: 'Asset Review',
            prompt: 'Review the uploaded references.',
            type: 'normal'
          }
        ]
      }
    }

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: 'asset-review',
      profileId: 'vision-model',
      initialMessage: 'Check these references',
      initialAttachments: [createImageAttachment('hero.png'), createFileAttachment('brief.pdf')]
    })

    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledTimes(1))

    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(String(hoisted.notifyWarningMock.mock.calls[0]?.[0] || '')).toContain(
      '仅支持图片输入，不支持文档输入'
    )
  })

  it('injects locked skill reference attachments into the outgoing user message', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {
      ...config,
      llm_config: {
        ...config.llm_config,
        customSkills: [
          {
            id: 'asset-review',
            category: 'Design',
            skillName: 'Asset Review',
            prompt: 'Review the locked references first.',
            type: 'normal',
            referenceAttachments: [createSkillReferenceImageAttachment('locked-reference.png')]
          }
        ]
      }
    }

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: 'asset-review',
      profileId: 'vision-model',
      initialMessage: 'Please review'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    const lastRequestMessage = firstCall.messages[firstCall.messages.length - 1]
    expect(lastRequestMessage.attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        fileName: 'locked-reference.png',
        hiddenFromChatView: true
      })
    ])

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages[0]?.attachments).toEqual([
        expect.objectContaining({
          type: 'image',
          fileName: 'locked-reference.png',
          hiddenFromChatView: true
        })
      ])
    })
  })

  it('warns and blocks skill execution when locked references require unsupported image and document input', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {
      ...config,
      llm_config: {
        ...config.llm_config,
        customSkills: [
          {
            id: 'asset-review',
            category: 'Design',
            skillName: 'Asset Review',
            prompt: 'Review the locked references.',
            type: 'normal',
            referenceAttachments: [
              createSkillReferenceImageAttachment('hero.png'),
              createSkillReferenceFileAttachment('brief.pdf')
            ]
          }
        ]
      }
    }

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: 'asset-review',
      initialMessage: 'Check these locked references'
    })

    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledTimes(1))

    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(String(hoisted.notifyWarningMock.mock.calls[0]?.[0] || '')).toContain(
      '不支持图片和文档输入，仅支持文本输入'
    )

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages).toHaveLength(0)
    })
  })

  it('treats scope termination as a real cancellation for an in-flight request', async () => {
    let observedSignal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal
          const abortWithError = () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }

          if (!signal) {
            reject(new Error('Expected abort signal'))
            return
          }

          if (signal.aborted) {
            abortWithError()
            return
          }

          signal.addEventListener('abort', abortWithError, { once: true })
        })
    )

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
      initialMessage: 'Cancel me'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:terminate-scope', {
          detail: {
            scope: 'runtime-flow'
          }
        })
      )
    })

    await waitFor(() => expect(observedSignal?.aborted).toBe(true))
    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages).toHaveLength(1)
      expect(currentSession?.messages[0]).toEqual(
        expect.objectContaining({ role: 'user', content: 'Cancel me' })
      )
    })
  })

  it('treats session deletion as a real cancellation for an in-flight request', async () => {
    let observedSignal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal
          const abortWithError = () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }

          if (!signal) {
            reject(new Error('Expected abort signal'))
            return
          }

          if (signal.aborted) {
            abortWithError()
            return
          }

          signal.addEventListener('abort', abortWithError, { once: true })
        })
    )

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
      initialMessage: 'Cancel on delete'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const sessionBeforeDelete = readCurrentSessionState()
    expect(sessionBeforeDelete?.id).toBeTruthy()

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:deleteSession', {
          detail: {
            scope: 'runtime-flow',
            sessionId: sessionBeforeDelete?.id
          }
        })
      )
    })

    await waitFor(() => expect(observedSignal?.aborted).toBe(true))
    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.id).not.toBe(sessionBeforeDelete?.id)
    })
  })
})
