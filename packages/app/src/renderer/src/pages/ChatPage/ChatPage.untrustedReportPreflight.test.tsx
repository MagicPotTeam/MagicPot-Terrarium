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
import { createReportBundleRegistryFixture } from './__fixtures__/reportBundleFixtures'
import { UNVERIFIED_REPORT_BUNDLE_MESSAGE } from '@shared/llm/unverifiedReport'

const f = vi.hoisted(() => ({ config: null as Config | null, sessions: [] as ChatSession[], fetch: vi.fn(), request: vi.fn(), stream: vi.fn(), batch: vi.fn(), supportsStreaming: vi.fn(), read: vi.fn(), write: vi.fn(), save: vi.fn(), materialize: vi.fn(), probe: vi.fn(), video: vi.fn(), error: vi.fn(), warning: vi.fn(), verify: vi.fn(), listProps: null as null | Record<string, unknown> }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en', resolvedLanguage: 'en' }, t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: f.config, isReady: true, buildEnv: DEFAULT_BUILD_ENV, configUtils: {}, updateConfig: vi.fn() }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifySuccess: vi.fn(), notifyInfo: vi.fn(), notifyError: f.error, notifyWarning: f.warning }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcFs: { readTextFile: f.read, writeTextFile: f.write }, svcHyper: { saveImageToDir: f.save }, svcManagedMedia: { materializeForRequest: f.materialize }, svcLLMProxy: { chat: f.request, chatStream: f.stream, remoteFetch: f.probe, signHy3DModel: vi.fn() }, svcReportBundles: { verify: (...args: unknown[]) => f.verify(...args) } }) }))
vi.mock('@renderer/utils/fileUtils', () => ({ fileToDataUrl: vi.fn(async () => 'blob:synthetic'), fileToBlobUrl: vi.fn(() => 'blob:synthetic'), selectFile: vi.fn(), checkFileSize: () => true, isImageFile: () => true }))
vi.mock('@renderer/utils/messageUtils', () => ({ getMessageText: (message: { content?: string }) => message.content || '' }))
vi.mock('./chatStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatStorage')>()
  return { ...actual, loadAllSessions: () => Promise.resolve(f.sessions), saveSessionToDB: async (session: ChatSession) => { const i = f.sessions.findIndex(s => s.id === session.id); if (i >= 0) f.sessions[i] = structuredClone(session); else f.sessions.push(structuredClone(session)) }, debouncedSaveSessions: () => undefined, cancelDebouncedSessionSave: () => undefined, saveChatSessions: (sessions: ChatSession[]) => { f.sessions = structuredClone(sessions) }, loadChatSessionBackups: () => ({}), saveChatSessionBackups: () => undefined }
})
vi.mock('./chatRequestUtils', async (importOriginal) => { const actual = await importOriginal<typeof import('./chatRequestUtils')>(); return { ...actual, REPORT_PREFLIGHT_TIMEOUT_MS: 200, resolveAttachmentBatchCapability: f.batch, supportsStreamingChatCompletion: f.supportsStreaming } })
vi.mock('./chatVideoAttachmentUtils', async (importOriginal) => { const actual = await importOriginal<typeof import('./chatVideoAttachmentUtils')>(); return { ...actual, augmentAttachmentsWithVideoBoundaryFrames: (...args: Parameters<typeof actual.augmentAttachmentsWithVideoBoundaryFrames>) => { f.video(); return actual.augmentAttachmentsWithVideoBoundaryFrames(...args) } } })
vi.mock('@renderer/utils/droppedImageUtils', async (importOriginal) => { const actual = await importOriginal<typeof import('@renderer/utils/droppedImageUtils')>(); return { ...actual, materializeInternalImageDragAttachment: async (attachment: ChatAttachment) => { f.materialize(); return attachment } } })
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatMessageList', () => ({ default: (props: { currentSession?: ChatSession }) => { f.listProps = props; return <pre data-testid="session">{JSON.stringify(props.currentSession ?? null)}</pre> } }))
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue, onInputChange, onSend, pendingAttachments }: { inputValue: string; onInputChange: (value: string) => void; onSend: () => void; pendingAttachments: ChatAttachment[] }) => <div><input data-testid="input" value={inputValue} onChange={event => onInputChange(event.target.value)} /><pre data-testid="attachments">{JSON.stringify(pendingAttachments)}</pre><button data-testid="send" onClick={onSend}>Send</button></div> }))
const scope = 'report-preflight-fixture'
const report = (extra: Partial<ChatAttachment> = {}): ChatAttachment => ({ type: 'file', url: 'local-media:///synthetic/report.md', fileName: 'report.md', reportBundleRole: 'primary-report', ...extra })
const image: ChatAttachment = { type: 'image', url: 'blob:synthetic-image', fileName: 'image.png', mimeType: 'image/png' }
async function setup(attachments: ChatAttachment[], streaming = false, messages: ChatSession['messages'] = [], isolated = false, profileExtra: Partial<LLMAPIProfile> = {}) {
  vi.stubGlobal('api', { svcManagedMedia: { materializeForRequest: f.materialize }, svcLLMProxy: { chat: f.request, chatStream: f.stream, remoteFetch: f.probe } })
  f.request.mockResolvedValue({ content: 'synthetic response' })
  f.stream.mockResolvedValue(undefined)
  f.config = structuredClone(DEFAULT_CONFIG)
  f.config!.use_remote_llm = false
  f.config!.llm_config.api_profiles = [{ id: 'fixture-profile', model_name: 'fixture-model', provider: 'openai', api_mode: 'responses', ...profileExtra } as LLMAPIProfile]
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

describe('registered report bundles in ChatPage (MAIN verify before the draft is given up)', () => {
  const mainManifestUrl = 'local-media:///main-snapshot/manifest.json'
  const descriptorManifestUrl = 'local-media:///synthetic/descriptor.manifest.json'
  const reportHeading = '# Synthetic report heading'
  const boundReport = (registry: ReturnType<typeof createReportBundleRegistryFixture>, conversationId = 'fixture-session') =>
    registry.register(report({ reportBundleId: 'bundle-1', reportBundleManifestUrl: descriptorManifestUrl }), conversationId, { manifestUrl: mainManifestUrl, imageCount: 0 })
  const serveBundle = () => f.fetch.mockImplementation(async (url: string) => {
    if (String(url) === mainManifestUrl) return { ok: true, text: async () => JSON.stringify({ version: 1, bundleId: 'bundle-1', title: 'Synthetic', entries: [{ role: 'primary-report', fileName: 'report.md', relativePath: 'report.md' }] }) }
    if (String(url) === 'local-media:///synthetic/report.md') return { ok: true, text: async () => `${reportHeading}\nBody.`, blob: async () => new Blob([`${reportHeading}\nBody.`], { type: 'text/markdown' }) }
    throw new Error(`unexpected fake fetch: ${String(url)}`)
  })
  const fetchedUrls = () => f.fetch.mock.calls.map(([url]) => String(url))
  const expectedConversation = { conversationId: 'fixture-session', storageScope: scope }
  const dataUrlProfile: Partial<LLMAPIProfile> = { attachment_transports: ['request-data-url'] }

  it.each([false, true])('sends a bound report that MAIN verifies and reads its manifest once per stage (stream=%s)', async streaming => {
    const registry = createReportBundleRegistryFixture()
    f.verify.mockImplementation(registry.verify)
    const bound = boundReport(registry)
    await setup([bound], streaming, [], false, dataUrlProfile)
    serveBundle()
    fireEvent.click(screen.getByTestId('send'))
    const dispatch = streaming ? f.stream : f.request
    const sentReport = () => dispatch.mock.calls.flatMap(([request]) => (request as { conversationId?: string; messages: ChatSession['messages'] }).conversationId === 'fixture-session' ? (request as { messages: ChatSession['messages'] }).messages : [])
      .flatMap(message => message.attachments ?? []).find(attachment => attachment.reportBundleRole === 'primary-report')
    await waitFor(() => expect(sentReport()).toBeDefined())
    // The verified report goes out to the MAIN boundary with its binding and its own bytes.
    expect(sentReport()?.reportBundleBinding).toBe(bound.reportBundleBinding)
    expect(atob(sentReport()!.url.split(',')[1] ?? '')).toContain(reportHeading)
    expect(f.error).not.toHaveBeenCalledWith(UNVERIFIED_REPORT_BUNDLE_MESSAGE)
    // Page preflight (before blob persistence) and request path each ask MAIN once.
    expect(registry.verify).toHaveBeenCalledTimes(2)
    for (const [request] of registry.verify.mock.calls) expect(request).toEqual({ conversation: expectedConversation, items: [{ binding: bound.reportBundleBinding, primaryUrl: bound.url }] })
    // MAIN's snapshot manifest is read twice per successful send: once by the page preflight,
    // once by the request path. The descriptor's own manifest URL is never read.
    expect(fetchedUrls().filter(url => url === mainManifestUrl)).toHaveLength(2)
    expect(fetchedUrls()).not.toContain(descriptorManifestUrl)
    expect(screen.getByTestId('input')).toHaveValue('')
  })

  it.each([false, true])('refuses a bound report MAIN does not verify before any read or dispatch and keeps the draft (stream=%s)', async streaming => {
    const registry = createReportBundleRegistryFixture()
    f.verify.mockImplementation(registry.verify)
    // Registered for another conversation: MAIN refuses it here.
    const attachments = [boundReport(registry, 'another-session'), image]
    await setup(attachments, streaming, [], false, dataUrlProfile)
    serveBundle()
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(f.error).toHaveBeenCalledWith(UNVERIFIED_REPORT_BUNDLE_MESSAGE))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(registry.verify).toHaveBeenCalledOnce()
    expect(registry.verify).toHaveBeenCalledWith({ conversation: expectedConversation, items: [{ binding: attachments[0].reportBundleBinding, primaryUrl: attachments[0].url }] })
    expect(screen.getByTestId('input')).toHaveValue('Draft text')
    expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual(attachments)
    for (const fn of [f.fetch, f.request, f.stream, f.materialize, f.probe, f.read, f.save]) expect(fn).not.toHaveBeenCalled()
    expect(JSON.parse(screen.getByTestId('session').textContent || 'null')?.messages).toEqual([])
  })

  it('lets a plain follow-up through when the history holds an assistant-role bound report', async () => {
    const registry = createReportBundleRegistryFixture()
    f.verify.mockImplementation(registry.verify)
    const bound = boundReport(registry)
    await setup([], false, [{ role: 'assistant', content: 'canvas report', attachments: [bound] }], false, dataUrlProfile)
    serveBundle()
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(f.request.mock.calls.some(call => JSON.stringify(call).includes('Draft text'))).toBe(true))
    expect(f.error).not.toHaveBeenCalled()
    expect(registry.verify).toHaveBeenCalledTimes(2)
    // Assistant-role reports are summarized, not expanded: no manifest is read.
    expect(fetchedUrls()).not.toContain(mainManifestUrl)
  })

  it('pauses a queued item that MAIN refuses and keeps its text', async () => {
    const registry = createReportBundleRegistryFixture()
    f.verify.mockImplementation(registry.verify)
    const bound = boundReport(registry)
    await setup([], false, [{ role: 'assistant', content: 'canvas report', attachments: [bound] }], false, dataUrlProfile)
    serveBundle()
    let finishFirst: (value: { content: string }) => void = () => undefined
    f.request.mockImplementation((request: unknown) => JSON.stringify(request).includes('Draft text')
      ? new Promise(resolve => { finishFirst = resolve })
      : Promise.resolve({ content: 'probe reply' }))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(f.request.mock.calls.some(call => JSON.stringify(call).includes('Draft text'))).toBe(true))
    fireEvent.change(screen.getByTestId('input'), { target: { value: 'Queued follow-up' } })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('Queued follow-up'))
    // A bundle file changed while the first turn ran: MAIN now refuses the binding.
    f.verify.mockImplementation(async (request: { items: Array<{ binding: string }> }) => ({ results: request.items.map(item => ({ binding: item.binding, status: 'refused' })) }))
    await act(async () => { finishFirst({ content: 'first reply' }) })
    await waitFor(() => expect(f.error).toHaveBeenCalledWith(UNVERIFIED_REPORT_BUNDLE_MESSAGE))
    await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('未发送 · 已暂停'))
    expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('Queued follow-up')
    expect(f.request.mock.calls.some(call => JSON.stringify(call).includes('Queued follow-up'))).toBe(false)
    const stored = JSON.parse(screen.getByTestId('session').textContent || 'null')
    expect(stored.messages.some((message: { content?: string }) => message.content === 'Queued follow-up')).toBe(false)
  })
})

describe('no hang and no lost text around MAIN report verify', () => {
  const timeoutMessage = 'Checking the report took too long. Your message was kept; try again.'
  const bound = (registry: ReturnType<typeof createReportBundleRegistryFixture>, conversationId = 'fixture-session') =>
    registry.register(report({ reportBundleId: 'bundle-1' }), conversationId, { manifestUrl: null, imageCount: 0 })

  it('refuses a send whose MAIN verify does not answer in time, keeps the draft and frees the conversation', async () => {
    const registry = createReportBundleRegistryFixture()
    f.verify.mockImplementation(() => new Promise(() => undefined))
    const attachments = [bound(registry)]
    await setup(attachments, false)
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(f.error).toHaveBeenCalledWith(timeoutMessage), { timeout: 3000 })
    expect(screen.getByTestId('input')).toHaveValue('Draft text')
    expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual(attachments)
    for (const fn of [f.request, f.stream, f.materialize]) expect(fn).not.toHaveBeenCalled()
    // The send lock was released: the next send asks MAIN again and goes out.
    f.verify.mockImplementation(registry.verify)
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(f.request).toHaveBeenCalled())
    expect(f.verify).toHaveBeenCalledTimes(3)
  })

  it.each(['image count', 'MAIN refusal'] as const)('reopens the edit form with the edited text when the send refuses the edit (%s)', async (cause) => {
    const registry = createReportBundleRegistryFixture()
    f.verify.mockImplementation(registry.verify)
    const history: ChatSession['messages'] = [{ role: 'user', content: 'original question' }, { role: 'assistant', content: 'synthetic answer' }]
    await setup([], false, history, false, { max_input_images: 1 })
    const props = () => f.listProps as { editingMessageIndex: number | null; editingContent: string; onSendEditedMessage: (content: string, attachments: ChatAttachment[] | undefined, hidden: string | undefined, base: ChatSession['messages']) => void }
    expect(props().editingMessageIndex).toBeNull()
    const attachments = cause === 'image count' ? [image, { ...image, url: 'blob:synthetic-second' }] : [bound(registry, 'another-session')]
    await act(async () => { props().onSendEditedMessage('edited question', attachments, undefined, []) })
    await waitFor(() => expect(props().editingMessageIndex).toBe(0))
    expect(props().editingContent).toBe('edited question')
    expect(f.error).toHaveBeenCalledWith(cause === 'image count' ? 'Too many images; the limit is 1.' : UNVERIFIED_REPORT_BUNDLE_MESSAGE)
    for (const fn of [f.request, f.stream]) expect(fn).not.toHaveBeenCalled()
    expect(JSON.parse(screen.getByTestId('session').textContent || 'null')?.messages).toEqual(history)
  })
})

describe('where a report binding may come from', () => {
  const binding = `rb1.${'F'.repeat(43)}`
  const boundPrimary = report({ reportBundleId: 'bundle-1', reportBundleManifestUrl: 'local-media:///synthetic/manifest.json', reportBundleBinding: binding })
  const storedMessages = () => JSON.parse(screen.getByTestId('session').textContent || 'null')?.messages as ChatSession['messages']

  it('stores a model reply attachment without the binding it carried', async () => {
    await setup([])
    f.request.mockResolvedValue({ content: 'model reply', attachments: [boundPrimary] })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(storedMessages().some(message => message.role === 'assistant' && message.content.includes('model reply'))).toBe(true))
    const reply = storedMessages().findLast(message => message.role === 'assistant')
    expect(reply?.attachments?.some(attachment => attachment.reportBundleRole === 'primary-report')).toBe(true)
    expect(JSON.stringify(storedMessages())).not.toContain(binding)
  })

  it('stores a streamed model attachment without its binding when the reply is cancelled after it', async () => {
    await setup([], true)
    let attachmentDelivered = false
    f.stream.mockImplementation(async (_request: unknown, response: { onData: (chunk: unknown) => void; abortReceiver?: { onAbort: (handler: () => void) => void } }) => {
      response.onData({ type: 'text-delta', delta: 'partial', done: false })
      response.onData({ type: 'attachment', delta: '', done: false, attachment: boundPrimary })
      attachmentDelivered = true
      await new Promise<void>((_resolve, reject) => { response.abortReceiver?.onAbort(() => reject(new Error('aborted'))) })
    })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(attachmentDelivered).toBe(true))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { window.dispatchEvent(new CustomEvent('chat:terminate-session', { detail: { scope, sessionId: 'fixture-session' } })) })
    await waitFor(() => expect(storedMessages().some(message => message.role === 'assistant' && message.content.includes('partial'))).toBe(true))
    const reply = storedMessages().findLast(message => message.role === 'assistant')
    expect(reply?.attachments?.some(attachment => attachment.reportBundleRole === 'primary-report')).toBe(true)
    expect(JSON.stringify(storedMessages())).not.toContain(binding)
    expect(JSON.stringify(f.sessions)).not.toContain(binding)
  })

  it('keeps the binding on the canvas producer message appended to this conversation', async () => {
    await setup([])
    act(() => { window.dispatchEvent(new CustomEvent('chat:append-message', { detail: { scope, sessionId: 'fixture-session', role: 'assistant', content: 'canvas report', attachments: [boundPrimary] } })) })
    await waitFor(() => expect(storedMessages()).toHaveLength(1))
    expect(storedMessages()[0].attachments).toEqual([boundPrimary])
  })
})
