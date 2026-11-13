import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ChatAttachment } from '@shared/llm'
import type { ChatSession } from './chatStorage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import ChatPage from './ChatPage'

const f = vi.hoisted(() => ({
  config: null as Config | null,
  sessions: [] as ChatSession[],
  materialize: vi.fn(), fetch: vi.fn(), request: vi.fn(), stream: vi.fn(),
  error: vi.fn(), noop: vi.fn(),
  profiles: [{ id: 'fixture-profile', model_name: 'Fixture', model_use: 'chat' }],
  remoteProfiles: []
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  i18n: { language: 'en', resolvedLanguage: 'en' },
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key
}) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: f.config, isReady: true, buildEnv: DEFAULT_BUILD_ENV, configUtils: {}, updateConfig: f.noop }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifyError: f.error, notifyWarning: f.noop, notifySuccess: f.noop, notifyInfo: f.noop }) }))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: f.profiles, remoteProfiles: f.remoteProfiles }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcFs: {}, svcLLMProxy: {}, svcManagedMedia: {} }) }))
vi.mock('@renderer/utils/droppedImageUtils', async original => ({
  ...await original<typeof import('@renderer/utils/droppedImageUtils')>(),
  materializeInternalImageDragAttachment: (attachment: ChatAttachment) => f.materialize(attachment)
}))
vi.mock('./chatStorage', async original => ({
  ...await original<typeof import('./chatStorage')>(),
  loadAllSessions: async () => structuredClone(f.sessions),
  saveSessionToDB: async (session: ChatSession) => {
    const index = f.sessions.findIndex(item => item.id === session.id)
    if (index < 0) f.sessions.push(structuredClone(session)); else f.sessions[index] = structuredClone(session)
  },
  debouncedSaveSessions: () => undefined,
  cancelDebouncedSessionSave: () => undefined,
  migrateFromLocalStorage: async () => null
}))
vi.mock('./chatRequestUtils', async original => ({
  ...await original<typeof import('./chatRequestUtils')>(),
  requestChatCompletion: f.request,
  requestChatCompletionStream: f.stream
}))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue }: { inputValue: string }) => <input data-testid="composer" value={inputValue} readOnly /> }))

const scope = 'edit-occurrence-integration'
const same: ChatAttachment = { type: 'image', url: 'local-media:///synthetic/same.png', fileName: 'same.png' }
const image = (name: string): ChatAttachment => ({ type: 'image', url: `local-media:///synthetic/${name}.png`, fileName: `${name}.png` })
const theme = createTheme()

beforeEach(() => {
  vi.resetAllMocks()
  f.config = structuredClone(DEFAULT_CONFIG)
  f.config.use_remote_llm = false
  f.sessions = [{ id: 'fixture', title: 'fixture', profileId: 'fixture-profile', storageScope: scope,
    messages: [{ role: 'user', content: 'original fixture message' }],
    draft: { inputValue: 'keep composer draft', pendingAttachments: [], pendingHiddenContext: '', updatedAt: 1 } }]
  f.materialize.mockImplementation(async (attachment: ChatAttachment) => attachment)
  f.fetch.mockRejectedValue(new Error('Unexpected fetch in edit occurrence test'))
  vi.stubGlobal('fetch', f.fetch)
  // No real Electron IPC is available to this fixture.
  vi.stubGlobal('api', { svcLLMProxy: {}, svcManagedMedia: {}, svcFs: {} })
  localStorage.clear(); sessionStorage.clear()
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'fixture')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  vi.unstubAllGlobals()
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.request).not.toHaveBeenCalled()
  expect(f.stream).not.toHaveBeenCalled()
})
async function openEditingForm() {
  render(<ThemeProvider theme={theme}><MemoryRouter><ChatPage storageScope={scope} /></MemoryRouter></ThemeProvider>)
  expect(await screen.findByText('original fixture message')).toBeVisible()
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveValue('keep composer draft'))
  fireEvent.click(within(screen.getByTestId('user-message-actions')).getByRole('button', { name: 'chat.edit_message' }))
  await screen.findByTestId('edit-message-composer')
}
async function sendExternal(attachment: ChatAttachment) {
  await act(async () => { window.dispatchEvent(new CustomEvent('send-to-agent', { detail: { targetScope: scope, attachment } })) })
}

describe('ChatPage to real edit form occurrence seam', () => {
  it('retains separate same-source non-auto events while keeping the composer untouched', async () => {
    await openEditingForm()
    await sendExternal(same)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove same.png' })).toHaveLength(1))
    await sendExternal({ ...same, sourceWidth: 42 })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove same.png' })).toHaveLength(2))
    expect(f.materialize.mock.calls.map(([attachment]) => attachment)).toEqual([same, { ...same, sourceWidth: 42 }])
    expect(screen.getByTestId('composer')).toHaveValue('keep composer draft')
    expect(screen.getByTestId('edit-message-composer').querySelector('textarea')).toHaveValue('original fixture message')
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove same.png' })[0])
    expect(screen.getAllByRole('button', { name: 'Remove same.png' })).toHaveLength(1)
    expect(f.error).not.toHaveBeenCalled()
  })

  it('delivers each occurrence in an internal multi-image drop to the real edit form', async () => {
    await openEditingForm()
    const attachments = [image('one'), image('two'), image('three')]
    const payload = JSON.stringify({ attachments })
    fireEvent.drop(screen.getByTestId('edit-message-composer'), { dataTransfer: {
      files: [], items: [], types: ['application/x-qapp-image'],
      getData: (key: string) => key === 'application/x-qapp-image' ? payload : ''
    } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove three.png' })).toBeVisible())
    for (const attachment of attachments) expect(screen.getByRole('button', { name: `Remove ${attachment.fileName}` })).toBeVisible()
    expect(f.materialize.mock.calls.map(([attachment]) => attachment)).toEqual(attachments)
    expect(screen.getByTestId('composer')).toHaveValue('keep composer draft')
    expect(screen.getByTestId('edit-message-composer').querySelector('textarea')).toHaveValue('original fixture message')
    expect(f.error).not.toHaveBeenCalled()
  })
})
