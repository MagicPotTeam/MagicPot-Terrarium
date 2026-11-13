import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { ChatAttachment } from '@shared/llm'
import type { ChatSession } from './chatStorage'
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
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatMessageList', () => ({ default: ({ currentSession }: { currentSession?: ChatSession }) => <pre data-testid="session">{JSON.stringify(currentSession ?? null)}</pre> }))
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue, onInputChange, onSend, pendingAttachments }: { inputValue: string; onInputChange: (value: string) => void; onSend: () => void; pendingAttachments: ChatAttachment[] }) => <div><input data-testid="input" value={inputValue} onChange={event => onInputChange(event.target.value)} /><pre data-testid="attachments">{JSON.stringify(pendingAttachments)}</pre><button data-testid="send" onClick={onSend}>Send</button></div> }))
const scope = 'report-preflight-fixture'
const report = (extra: Partial<ChatAttachment> = {}): ChatAttachment => ({ type: 'file', url: 'local-media:///synthetic/report.md', fileName: 'report.md', reportBundleRole: 'primary-report', ...extra })
const image: ChatAttachment = { type: 'image', url: 'blob:synthetic-image', fileName: 'image.png', mimeType: 'image/png' }
async function setup(attachments: ChatAttachment[], streaming = false, messages: ChatSession['messages'] = [], isolated = false) {
  vi.stubGlobal('api', { svcManagedMedia: { materializeForRequest: f.materialize }, svcLLMProxy: { chat: f.request, chatStream: f.stream, remoteFetch: f.probe } })
  f.request.mockResolvedValue({ content: 'synthetic response' })
  f.stream.mockResolvedValue(undefined)
  f.config = structuredClone(DEFAULT_CONFIG)
  f.config!.use_remote_llm = false
  f.config!.llm_config.api_profiles = [{ id: 'fixture-profile', model_name: 'fixture-model', provider: 'openai', api_mode: 'responses' } as LLMAPIProfile]
  if (isolated) f.config!.llm_config.customSkills = [{ id: 'isolated-fixture', category: 'test', skillName: 'Isolated fixture', prompt: 'Answer briefly', type: 'normal', execution: { contextMessageLimit: 0 } }]
  f.supportsStreaming.mockReturnValue(streaming)
  f.sessions = [{ id: 'fixture-session', title: 'fixture', messages, profileId: 'fixture-profile', ...(isolated ? { skillId: 'isolated-fixture' } : {}), storageScope: scope, draft: { inputValue: 'Draft text', pendingAttachments: attachments, pendingHiddenContext: '', updatedAt: 1 } }]
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'fixture-session')
  render(<ThemeProvider theme={createTheme()}><MemoryRouter><div id={buildChatWorkspaceControlsPortalId(scope)} /><div id="agent-workspace-skill-portal" /><ChatPage storageScope={scope} /></MemoryRouter></ThemeProvider>)
  await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('Draft text'))
  await waitFor(() => expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual(attachments))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)) })
  for (const fn of [f.fetch, f.request, f.stream, f.batch, f.read, f.write, f.save, f.materialize, f.probe, f.video, f.error, f.warning]) fn.mockClear()
}
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear(); f.batch.mockResolvedValue(1); f.fetch.mockRejectedValue(new Error('unexpected fake fetch')); vi.stubGlobal('fetch', f.fetch); Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }) })
afterEach(async () => { cleanup(); await act(async () => {}); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('untrusted primary report preflight in ChatPage', () => {
  it.each(['user', 'assistant'] as const)('rejects retained %s history report before IO, unary/stream', async role => {
    for (const streaming of [false, true]) {
      const messages: ChatSession['messages'] = [{ role, content: 'old report', attachments: [report({reportBundleId: 'synthetic', reportBundleManifestUrl: 'local-media:///synthetic/manifest.json'})] }]
      await setup([image], streaming, messages)
      fireEvent.click(screen.getByTestId('send'))
      await waitFor(() => expect(f.error).toHaveBeenCalled())
      expect(screen.getByTestId('input')).toHaveValue('Draft text')
      expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual([image])
      for (const fn of [f.fetch, f.request, f.stream, f.materialize, f.probe, f.video, f.read, f.save]) expect(fn).not.toHaveBeenCalled()
      cleanup(); localStorage.clear(); vi.clearAllMocks()
    }
  })
  it.each(['none', 'file', 'report'] as const)('isolated skill excludes old %s history without false rejection', async kind => {
    const ordinary: ChatAttachment = {type:'file', url:'data:text/plain;base64,SGVsbG8=', fileName:'ordinary.txt', mimeType:'text/plain'}
    const attachments = kind === 'none' ? undefined : [kind === 'file' ? ordinary : report()]
    const messages: ChatSession['messages'] = [{role:'user', content:'PRIVATE OLD HISTORY', ...(attachments ? {attachments} : {})}]
    await setup([], false, messages, true)
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(f.request).toHaveBeenCalled())
    expect(f.error).not.toHaveBeenCalled()
    expect(JSON.stringify(f.request.mock.calls[0])).not.toContain('PRIVATE OLD HISTORY')
  })
  it('permits an ordinary text attachment without report metadata', async () => {
    const ordinary: ChatAttachment = { type: 'file', url: 'data:text/plain;base64,SGVsbG8=', fileName: 'ordinary.txt', mimeType: 'text/plain' }
    await setup([ordinary])
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(f.request).toHaveBeenCalled())
  })
  it.each([false, true])('rejects unverified primary report before side effects and preserves draft (stream=%s)', async streaming => {
    const attachments = [report({ reportBundleId: 'self-claimed', reportBundleImageCount: 1, reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }), image]
    await setup(attachments, streaming)
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(f.error).toHaveBeenCalled())
    expect(screen.getByTestId('input')).toHaveValue('Draft text')
    expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual(attachments)
    for (const fn of [f.fetch, f.request, f.stream, f.materialize, f.probe, f.video, f.read, f.save]) expect(fn).not.toHaveBeenCalled()
  })
  it('rejects primary report without manifest even without images', async () => {
    const attachments = [report()]
    await setup(attachments)
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(f.error).toHaveBeenCalled())
    expect(screen.getByTestId('input')).toHaveValue('Draft text')
    expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual(attachments)
    for (const fn of [f.fetch, f.request, f.stream, f.materialize, f.probe, f.video, f.read, f.save]) expect(fn).not.toHaveBeenCalled()
  })
})
