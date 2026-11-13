import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config, type LLMAPIProfile } from '@shared/config/config'
import type { ChatAttachment } from '@shared/llm'
import type { CanvasImageItem } from '../ProjectCanvasPage/types'
import type { ChatSession } from './chatStorage'
import { buildChatWorkspaceControlsPortalId, scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'
import ChatPage from './ChatPage'
import { useCanvasBridgeActions } from '../ProjectCanvasPage/useCanvasBridgeActions'

const f = vi.hoisted(() => ({ config: null as Config | null, sessions: [] as ChatSession[], profiles: [{ id: 'fixture', model_name: 'fixture', model_use: 'chat' }], remote: [], materialize: vi.fn(), request: vi.fn(), stream: vi.fn(), error: vi.fn(), noop: vi.fn(), dispatch: vi.fn() }))
vi.mock('react-redux', () => ({ useDispatch: () => f.dispatch }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en', resolvedLanguage: 'en' }, t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: f.config, isReady: true, buildEnv: DEFAULT_BUILD_ENV, configUtils: {}, updateConfig: f.noop }) }))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: f.profiles, remoteProfiles: f.remote }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifySuccess: f.noop, notifyInfo: f.noop, notifyError: f.error, notifyWarning: f.noop }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcFs: {}, svcHyper: {}, svcManagedMedia: {}, svcLLMProxy: { chat: f.request, chatStream: f.stream, signHy3DModel: f.noop } }) }))
vi.mock('@renderer/utils/fileUtils', () => ({ fileToDataUrl: vi.fn(), fileToBlobUrl: vi.fn(), selectFile: vi.fn(), checkFileSize: () => true, isImageFile: () => true }))
vi.mock('@renderer/utils/messageUtils', () => ({ getMessageText: (message: { content?: string }) => message.content || '' }))
vi.mock('./chatStorage', async original => ({ ...await original<typeof import('./chatStorage')>(), loadAllSessions: async () => f.sessions, saveSessionToDB: async () => {}, debouncedSaveSessions: () => undefined, cancelDebouncedSessionSave: () => undefined, saveChatSessions: () => undefined, loadChatSessionBackups: () => ({}), saveChatSessionBackups: () => undefined }))
vi.mock('./chatRequestUtils', async original => ({ ...await original<typeof import('./chatRequestUtils')>(), requestChatCompletion: f.request, requestChatCompletionStream: f.stream, supportsStreamingChatCompletion: () => false, resolveAttachmentBatchCapability: async () => 1 }))
vi.mock('@renderer/utils/droppedImageUtils', async original => ({ ...await original<typeof import('@renderer/utils/droppedImageUtils')>(), materializeInternalImageDragAttachment: (attachment: ChatAttachment) => f.materialize(attachment) }))
vi.mock('./components/SessionSidebar', () => ({ default: () => null }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatMessageList', () => ({ default: () => null }))
// Lightweight composer displays actual props and invokes the genuine ChatPage callback.
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue, pendingAttachments, onSend }: { inputValue: string; pendingAttachments: ChatAttachment[]; onSend: () => void }) => <div><input data-testid="input" value={inputValue} readOnly /><pre data-testid="attachments">{JSON.stringify(pendingAttachments)}</pre><button onClick={() => onSend()}>send fixture</button></div> }))
const scope = 'canvas-occurrence-fixture'
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear(); f.config = structuredClone(DEFAULT_CONFIG); f.config.use_remote_llm = false; f.config.llm_config.api_profiles = [{ id: 'fixture', model_name: 'fixture', provider: 'openai', api_mode: 'responses' } as LLMAPIProfile]; f.sessions = [{ id: 'fixture-session', title: 'fixture', messages: [], profileId: 'fixture', storageScope: scope, draft: { inputValue: '', pendingAttachments: [], pendingHiddenContext: '', updatedAt: 1 } }]; f.materialize.mockImplementation(async (item: ChatAttachment) => item); f.request.mockResolvedValue({ content: 'ok' }); vi.stubGlobal('api', { svcLLMProxy: { chat: f.request, chatStream: f.stream }, svcManagedMedia: {} }); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network forbidden'))); Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }) })
afterEach(async () => { cleanup(); await act(async () => {}); vi.unstubAllGlobals() })

describe('canvas to ChatPage occurrence seam', () => {
  it.each([true, false])('sends eight images same source=%s', async same => {
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'fixture-session')
    render(<ThemeProvider theme={createTheme()}><MemoryRouter><div id={buildChatWorkspaceControlsPortalId(scope)} /><ChatPage storageScope={scope} /></MemoryRouter></ThemeProvider>)
    await waitFor(() => expect(screen.getByTestId('input')).toHaveValue(''))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)) })
    const images: CanvasImageItem[] = Array.from({ length: 8 }, (_, i) => ({ id: `image-${i}`, type: 'image', src: `data:image/png;base64,${same ? 'QQ==' : btoa(String(i))}`, fileName: `${i}.png`, x: i * 100, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: i, locked: false }))
    const events = vi.spyOn(window, 'dispatchEvent')
    const hook = renderHook(() => useCanvasBridgeActions({ canvasId: 'fixture', projectName: 'Fixture', items: images, groups: [], notifyError: f.error, notifySuccess: f.noop, extractPromptTextFromCanvasItems: () => 'synthetic prompt', renderCanvasItemsImageDataUrl: vi.fn(async () => ''), renderCanvasItemsSvgMarkup: vi.fn(async () => '') }))
    await act(async () => { await hook.result.current.handleSendCanvasItemsToAgent(images, { targetScope: scope }); await new Promise(resolve => setTimeout(resolve, 260)) })
    const sent = events.mock.calls.map(([event]) => event as CustomEvent<{ attachment?: ChatAttachment }>).filter(event => event.type === 'send-to-agent' && event.detail.attachment)
    expect(sent.map(event => event.detail.attachment?.fileName)).toEqual(images.map(item => item.fileName))
    await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('synthetic prompt'))
    const pending = JSON.parse(screen.getByTestId('attachments').textContent || '[]') as ChatAttachment[]
    expect(pending.map(item => item.fileName)).toEqual(images.map(item => item.fileName))
    fireEvent.click(screen.getByRole('button', { name: 'send fixture' }))
    await waitFor(() => expect(f.request).toHaveBeenCalledOnce())
    const message = f.request.mock.calls[0][0].messages.at(-1)
    expect(message.attachments.map((item: ChatAttachment) => item.fileName)).toEqual(images.map(item => item.fileName))
    expect(message.content).toContain('synthetic prompt')
    hook.unmount(); events.mockRestore()
  })

  it('rejects a same-source batch without changing an existing composer draft', async () => {
    const original: ChatAttachment = { type: 'image', url: 'data:image/png;base64,Qg==', fileName: 'existing.png' }
    f.sessions[0].draft = { inputValue: 'existing draft', pendingAttachments: [original], pendingHiddenContext: '', updatedAt: 1 }
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), 'fixture-session')
    render(<ThemeProvider theme={createTheme()}><MemoryRouter><div id={buildChatWorkspaceControlsPortalId(scope)} /><ChatPage storageScope={scope} /></MemoryRouter></ThemeProvider>)
    await waitFor(() => {
      expect(screen.getByTestId('input')).toHaveValue('existing draft')
      expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual([original])
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)) })
    const before = screen.getByTestId('attachments').textContent
    const images: CanvasImageItem[] = Array.from({ length: 8 }, (_, i) => ({ id: `image-${i}`, type: 'image', src: 'data:image/png;base64,QQ==', fileName: `${i}.png`, x: i * 100, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: i, locked: false }))
    const events = vi.spyOn(window, 'dispatchEvent')
    const hook = renderHook(() => useCanvasBridgeActions({ canvasId: 'fixture', projectName: 'Fixture', items: images, groups: [], notifyError: f.error, notifySuccess: f.noop, extractPromptTextFromCanvasItems: () => 'synthetic prompt', renderCanvasItemsImageDataUrl: vi.fn(async () => ''), renderCanvasItemsSvgMarkup: vi.fn(async () => '') }))
    let accepted: boolean | undefined
    await act(async () => { accepted = await hook.result.current.handleSendCanvasItemsToAgent(images, { targetScope: scope }); await new Promise(resolve => setTimeout(resolve, 260)) })
    expect.soft(accepted).toBe(false)
    expect.soft(f.error).toHaveBeenCalledWith('canvas.agent_send_duplicate_selection')
    expect.soft(events.mock.calls.map(([event]) => event.type).filter(type => type === 'send-to-agent' || type === 'chat:focus-composer')).toEqual([])
    expect.soft(screen.getByTestId('input')).toHaveValue('existing draft')
    expect.soft(screen.getByTestId('attachments').textContent).toBe(before)
    expect(f.request).not.toHaveBeenCalled()
    hook.unmount(); events.mockRestore()
  })
})
