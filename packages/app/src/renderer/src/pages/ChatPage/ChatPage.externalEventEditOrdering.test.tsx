import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { useEffect, useMemo } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ChatAttachment } from '@shared/llm'
import type { ChatSession } from './chatStorage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import ChatPage from './ChatPage'

const f = vi.hoisted(() => ({ config: null as Config | null, sessions: [] as ChatSession[], materialize: vi.fn(), receiver: vi.fn(), error: vi.fn(), request: vi.fn(), fetch: vi.fn(), forbidden: vi.fn(), dispatch: vi.fn() }))
vi.mock('react-redux', () => ({ useDispatch: () => f.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en', resolvedLanguage: 'en' }, t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: f.config, isReady: true, buildEnv: DEFAULT_BUILD_ENV, configUtils: {}, updateConfig: vi.fn() }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifySuccess: vi.fn(), notifyInfo: vi.fn(), notifyWarning: vi.fn(), notifyError: f.error }) }))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: [{ id: 'fixture', model_name: 'fixture', model_use: 'chat' }], remoteProfiles: [] }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcFs: {}, svcHyper: {}, svcManagedMedia: { importDataUrl: f.forbidden, importFile: f.forbidden }, svcLLMProxy: { chat: f.request, chatStream: f.request, signHy3DModel: f.forbidden } }) }))
vi.mock('@renderer/utils/fileUtils', () => ({ fileToDataUrl: f.forbidden, fileToBlobUrl: f.forbidden, selectFile: f.forbidden, checkFileSize: () => true, isImageFile: () => true }))
vi.mock('@renderer/utils/messageUtils', () => ({ getMessageText: (message: { content?: string }) => message.content || '' }))
vi.mock('@renderer/utils/droppedImageUtils', async original => ({ ...await original<typeof import('@renderer/utils/droppedImageUtils')>(), materializeInternalImageDragAttachment: (attachment: ChatAttachment) => f.materialize(attachment), getDroppedLocalImageFiles: f.forbidden }))
vi.mock('./chatStorage', async original => ({ ...await original<typeof import('./chatStorage')>(), loadAllSessions: async (scope: string) => structuredClone(f.sessions.filter(session => session.storageScope === scope)), saveSessionToDB: async () => {}, debouncedSaveSessions: () => undefined, cancelDebouncedSessionSave: () => undefined, saveChatSessions: () => undefined, loadChatSessionBackups: () => ({}), saveChatSessionBackups: () => undefined, migrateFromLocalStorage: async () => null }))
vi.mock('./chatRequestUtils', async original => ({ ...await original<typeof import('./chatRequestUtils')>(), requestChatCompletion: f.request, requestChatCompletionStream: f.request, supportsStreamingChatCompletion: () => false }))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue, pendingAttachments }: { inputValue: string; pendingAttachments: ChatAttachment[] }) => <div><input data-testid="composer" value={inputValue} readOnly /><pre data-testid="pending">{JSON.stringify(pendingAttachments)}</pre></div> }))
vi.mock('./components/ChatMessageList', () => ({ default: function MessageList({ currentSession, editingMessageIndex, editingContent, onSetEditingIndex, onSetEditingContent, onRegisterEditingAttachmentReceiver }: { currentSession?: ChatSession; editingMessageIndex: number | null; editingContent: string; onSetEditingIndex: (n: number) => void; onSetEditingContent: (s: string) => void; onRegisterEditingAttachmentReceiver: (receiver: ((attachment: ChatAttachment) => void) | null) => void }) {
  const id = currentSession?.id
  const receiver = useMemo(() => (attachment: ChatAttachment) => f.receiver(id, attachment), [id])
  useEffect(() => { onRegisterEditingAttachmentReceiver(editingMessageIndex === null ? null : receiver); return () => onRegisterEditingAttachmentReceiver(null) }, [editingMessageIndex, receiver, onRegisterEditingAttachmentReceiver])
  return <div><span data-testid="session">{id}</span><span data-testid="edit">{editingContent}</span><button onClick={() => { onSetEditingIndex(0); onSetEditingContent('edit baseline') }}>edit</button></div>
} }))
const scopeA = 'isolated-event-a', scopeB = 'isolated-event-b'
const image = (name: string): ChatAttachment => ({ type: 'image', url: `synthetic:${name}`, fileName: `${name}.png` })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const session = (scope: string): ChatSession => ({ id: `session-${scope}`, title: 'fixture', storageScope: scope, profileId: 'fixture', messages: [{ role: 'user', content: 'original' }], draft: { inputValue: `draft-${scope}`, pendingAttachments: [], pendingHiddenContext: '', updatedAt: 1 } })
const dispatch = async (scope: string, detail: object) => { await act(async () => { window.dispatchEvent(new CustomEvent('send-to-agent', { detail: { targetScope: scope, ...detail } })) }) }
const page = (scope: string) => <ThemeProvider theme={createTheme()}><MemoryRouter><ChatPage key={scope} storageScope={scope} /></MemoryRouter></ThemeProvider>
async function enter(scope: string) { await waitFor(() => expect(screen.getByTestId('session')).toHaveTextContent(`session-${scope}`)); await waitFor(() => expect(screen.getByTestId('composer')).toHaveValue(`draft-${scope}`)); fireEvent.click(screen.getByRole('button', { name: 'edit' })); await waitFor(() => expect(screen.getByTestId('edit')).toHaveTextContent('edit baseline')) }
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear()
  f.config = structuredClone(DEFAULT_CONFIG); f.config.use_remote_llm = false
  f.sessions = [session(scopeA), session(scopeB)]
  for (const scope of [scopeA, scopeB]) localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), `session-${scope}`)
  f.materialize.mockImplementation(async (item: ChatAttachment) => item)
  f.fetch.mockImplementation(() => { throw new Error('Unexpected fetch: forbidden') })
  f.forbidden.mockImplementation(() => { throw new Error('Unexpected file or managed media access: forbidden') })
  f.request.mockImplementation(() => { throw new Error('Unexpected request: forbidden') })
  vi.stubGlobal('fetch', f.fetch); vi.stubGlobal('api', { svcLLMProxy: { chat: f.request, chatStream: f.request }, svcManagedMedia: {} })
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterEach(async () => { cleanup(); await act(async () => {}); expect(f.fetch).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); vi.unstubAllGlobals() })
describe('separate external edit events', () => {
  it('retains accepted image when a later hidden-context event is rejected', async () => {
    render(page(scopeA)); await enter(scopeA); const a = image('a')
    await dispatch(scopeA, { attachment: a }); await waitFor(() => expect(f.receiver).toHaveBeenCalledExactlyOnceWith(`session-${scopeA}`, a))
    f.error.mockClear(); f.materialize.mockClear()
    await dispatch(scopeA, { hiddenText: 'synthetic hidden' })
    expect(f.error).toHaveBeenCalledWith('canvas.agent_edit_input_unavailable'); expect(f.materialize).not.toHaveBeenCalled(); expect(f.receiver).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('edit')).toHaveTextContent('edit baseline'); expect(screen.getByTestId('composer')).toHaveValue(`draft-${scopeA}`); expect(screen.getByTestId('pending')).toHaveTextContent('[]')
  })
  it('observes each independent event when B resolves before A', async () => {
    render(page(scopeA)); await enter(scopeA); const a = image('a'), b = image('b'), da = deferred<ChatAttachment>(), db = deferred<ChatAttachment>()
    f.materialize.mockImplementation((item: ChatAttachment) => item.fileName === a.fileName ? da.promise : db.promise)
    try {
      await dispatch(scopeA, { attachment: a }); await dispatch(scopeA, { attachment: b }); await waitFor(() => expect(f.materialize).toHaveBeenCalledTimes(2))
      await act(async () => { db.resolve(b); await db.promise }); await waitFor(() => expect(f.receiver).toHaveBeenCalledExactlyOnceWith(`session-${scopeA}`, b))
      await act(async () => { da.resolve(a); await da.promise }); await waitFor(() => expect(f.receiver).toHaveBeenCalledTimes(2))
      expect(f.receiver.mock.calls).toEqual([[`session-${scopeA}`, b], [`session-${scopeA}`, a]])
    } finally { da.resolve(a); db.resolve(b) }
  })
  it('does not deliver late A into B after scope remount; B has an independent positive control', async () => {
    const view = render(page(scopeA)); await enter(scopeA); const a = image('a'), b = image('b'), da = deferred<ChatAttachment>()
    f.materialize.mockImplementation((item: ChatAttachment) => item.fileName === a.fileName ? da.promise : Promise.resolve(item))
    try {
      await dispatch(scopeA, { attachment: a }); await waitFor(() => expect(f.materialize).toHaveBeenCalledWith(a))
      view.rerender(page(scopeB)); await enter(scopeB); await dispatch(scopeB, { attachment: b }); await waitFor(() => expect(f.receiver).toHaveBeenCalledExactlyOnceWith(`session-${scopeB}`, b))
      await act(async () => { da.resolve(a); await da.promise }); expect(f.receiver).toHaveBeenCalledTimes(1); expect(screen.getByTestId('composer')).toHaveValue(`draft-${scopeB}`); expect(screen.getByTestId('edit')).toHaveTextContent('edit baseline')
    } finally { da.resolve(a) }
  })
})
