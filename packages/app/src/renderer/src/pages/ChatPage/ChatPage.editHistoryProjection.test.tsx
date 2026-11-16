import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { ChatAttachment } from '@shared/llm'
import type { ChatSession } from './chatStorage'
type ChatMessage = ChatSession['messages'][number]
import { buildChatWorkspaceControlsPortalId, scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import ChatPage from './ChatPage'

const f = vi.hoisted(() => ({ config: null as Config | null, sessions: [] as ChatSession[], fetch: vi.fn(), request: vi.fn(), stream: vi.fn(), batch: vi.fn(), supportsStreaming: vi.fn(), read: vi.fn(), write: vi.fn(), save: vi.fn(), materialize: vi.fn(), probe: vi.fn(), video: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en', resolvedLanguage: 'en' }, t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: f.config, isReady: true, buildEnv: DEFAULT_BUILD_ENV, configUtils: {}, updateConfig: vi.fn() }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifySuccess: vi.fn(), notifyInfo: vi.fn(), notifyError: f.error, notifyWarning: f.warning }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcFs: { readTextFile: f.read, writeTextFile: f.write }, svcHyper: { saveImageToDir: f.save }, svcManagedMedia: { materializeForRequest: f.materialize }, svcLLMProxy: { chat: f.request, chatStream: f.stream, remoteFetch: f.probe, signHy3DModel: vi.fn() } }) }))
vi.mock('@renderer/utils/fileUtils', () => ({ fileToDataUrl: vi.fn(async () => 'blob:synthetic'), fileToBlobUrl: vi.fn(() => 'blob:synthetic'), selectFile: vi.fn(), checkFileSize: () => true, isImageFile: () => true }))
vi.mock('@renderer/utils/messageUtils', () => ({ getMessageText: (message: { content?: string }) => message.content || '' }))
vi.mock('./chatStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatStorage')>()
  return { ...actual, loadAllSessions: () => Promise.resolve(f.sessions), saveSessionToDB: async (session: ChatSession) => { const i = f.sessions.findIndex(s => s.id === session.id); if (i >= 0) f.sessions[i] = structuredClone(session); else f.sessions.push(structuredClone(session)) }, debouncedSaveSessions: () => undefined, cancelDebouncedSessionSave: () => undefined, saveChatSessions: (sessions: ChatSession[]) => { f.sessions = structuredClone(sessions) }, loadChatSessionBackups: () => ({}), saveChatSessionBackups: () => undefined }
})
vi.mock('./chatRequestUtils', async (importOriginal) => { const actual = await importOriginal<typeof import('./chatRequestUtils')>(); return { ...actual, resolveAttachmentBatchCapability: f.batch, supportsStreamingChatCompletion: f.supportsStreaming } })
vi.mock('./chatVideoAttachmentUtils', async (importOriginal) => { const actual = await importOriginal<typeof import('./chatVideoAttachmentUtils')>(); return { ...actual, augmentAttachmentsWithVideoBoundaryFrames: (...args: Parameters<typeof actual.augmentAttachmentsWithVideoBoundaryFrames>) => { f.video(); return actual.augmentAttachmentsWithVideoBoundaryFrames(...args) } } })
vi.mock('@renderer/utils/droppedImageUtils', async (importOriginal) => { const actual = await importOriginal<typeof import('@renderer/utils/droppedImageUtils')>(); return { ...actual, materializeInternalImageDragAttachment: async (attachment: ChatAttachment) => { f.materialize(); return attachment } } })
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
// The list renders what the edit form's report preflight would inspect for the whole kept history.
vi.mock('./components/ChatMessageList', () => ({ default: ({ currentSession, projectEditHistory }: { currentSession?: ChatSession; projectEditHistory?: (prefix: ChatMessage[]) => ChatMessage[] }) => <pre data-testid="projected">{JSON.stringify(projectEditHistory ? projectEditHistory(currentSession?.messages ?? []) : 'missing')}</pre> }))
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue, onInputChange, onSend, pendingAttachments }: { inputValue: string; onInputChange: (value: string) => void; onSend: () => void; pendingAttachments: ChatAttachment[] }) => <div><input data-testid="input" value={inputValue} onChange={event => onInputChange(event.target.value)} /><pre data-testid="attachments">{JSON.stringify(pendingAttachments)}</pre><button data-testid="send" onClick={onSend}>Send</button></div> }))
const scope = 'edit-history-projection-fixture'
const report: ChatAttachment = { type: 'file', url: 'local-media:///synthetic/report.md', fileName: 'report.md', reportBundleRole: 'primary-report', reportBundleId: 'synthetic', reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }
const messages: ChatMessage[] = [
  { role: 'user', content: 'old report', attachments: [report] },
  { role: 'assistant', content: 'reply' },
  { role: 'user', content: 'middle' },
  { role: 'assistant', content: 'second reply' },
  { role: 'user', content: 'later' }
]
async function setup(limit: 'all' | 0 | 3 | undefined) {
  vi.stubGlobal('api', { svcManagedMedia: { materializeForRequest: f.materialize }, svcLLMProxy: { chat: f.request, chatStream: f.stream, remoteFetch: f.probe } })
  f.config = structuredClone(DEFAULT_CONFIG)
  f.config!.use_remote_llm = false
  f.config!.llm_config.api_profiles = [{ id: 'fixture-profile', model_name: 'fixture-model', provider: 'openai', api_mode: 'responses' } as LLMAPIProfile]
  if (limit !== undefined) f.config!.llm_config.customSkills = [{ id: 'limit-fixture', category: 'test', skillName: 'Limit fixture', prompt: 'Answer briefly', type: 'normal', execution: { contextMessageLimit: limit } }]
  f.sessions = [{ id: 'fixture-session', title: 'fixture', messages: structuredClone(messages), profileId: 'fixture-profile', ...(limit !== undefined ? { skillId: 'limit-fixture' } : {}), storageScope: scope }]
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'fixture-session')
  render(<ThemeProvider theme={createTheme()}><MemoryRouter><div id={buildChatWorkspaceControlsPortalId(scope)} /><div id="agent-workspace-skill-portal" /><ChatPage storageScope={scope} /></MemoryRouter></ThemeProvider>)
  await waitFor(() => expect(screen.getByTestId('projected').textContent).not.toBe('null'))
  return () => JSON.parse(screen.getByTestId('projected').textContent || 'null') as unknown
}
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear(); f.batch.mockResolvedValue(1); f.fetch.mockRejectedValue(new Error('unexpected fake fetch')); vi.stubGlobal('fetch', f.fetch); Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('ChatPage projects the edit form history like an edited send', () => {
  it('keeps the whole prefix without a skill', async () => {
    const projected = await setup(undefined)
    await waitFor(() => expect(projected()).toEqual(messages))
  })
  it('drops the history for an isolated skill', async () => {
    const projected = await setup(0)
    await waitFor(() => expect(projected()).toEqual([]))
  })
  it('keeps only the last N messages for a limited skill', async () => {
    const projected = await setup(3)
    await waitFor(() => expect(projected()).toEqual(messages.slice(-3)))
  })
  it('keeps the whole prefix for a skill with unlimited context', async () => {
    const projected = await setup('all')
    await waitFor(() => expect(projected()).toEqual(messages))
  })
})
