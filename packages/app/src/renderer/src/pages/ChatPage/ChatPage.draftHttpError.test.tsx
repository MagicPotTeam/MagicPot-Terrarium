import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import type { ChatSession } from './chatStorage'
import ChatPage from './ChatPage'

const h = vi.hoisted(() => ({ sessions: [] as ChatSession[], save: vi.fn(), warning: vi.fn(), error: vi.fn(), fileToDataUrl: vi.fn(async () => 'data:image/png;base64,QQ=='), realBackup: false }))
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || key, i18n: { language: 'en', resolvedLanguage: 'en' } }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: { ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [], customSkills: [], customSkillCategories: [] } } as Config, isReady: true, buildEnv: { ...DEFAULT_BUILD_ENV }, configUtils: {}, updateConfig: vi.fn() }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifyError: h.error, notifyWarning: h.warning, notifySuccess: vi.fn(), notifyInfo: vi.fn() }) }))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: [{ id: 'base-model', model_name: 'Base', model_use: 'chat' }], remoteProfiles: [] }) }))
vi.mock('./chatStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatStorage')>()
  return { ...actual, loadAllSessions: async () => clone(h.sessions), saveSessionToDB: (...args: unknown[]) => h.save(...args), saveAllSessions: vi.fn(), compareAndUpdateSessionInDB: vi.fn(), deleteSessionFromDB: vi.fn(), cancelDebouncedSessionSave: vi.fn(), deleteSessionDraftBackup: vi.fn(), migrateFromLocalStorage: vi.fn(async () => null), readSessionDraftBackup: vi.fn(), hasSessionDeleteTombstone: vi.fn(() => false), readSessionDeleteTombstones: vi.fn(() => []), debouncedSaveSessions: vi.fn(), setSessionDeleteTombstone: vi.fn(), writeSessionDraftBackup: (...args: Parameters<typeof actual.writeSessionDraftBackup>) => { if (h.realBackup) actual.writeSessionDraftBackup(...args) } }
})
vi.mock('./components/SessionSidebar', () => ({ default: () => <div /> }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('@renderer/utils/fileUtils', () => ({ selectFile: vi.fn(), fileToBlobUrl: vi.fn(() => 'blob:test'), fileToDataUrl: h.fileToDataUrl, checkFileSize: vi.fn(() => true), formatFileSize: vi.fn(() => '1 B') }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcAgentLocalFiles: {}, svcFs: {}, svcLLMProxy: { signHy3DModel: vi.fn() }, svcHyper: { saveImageToDir: vi.fn(async () => ({ savedPath: null })) }, svcManagedMedia: {} }) }))
vi.mock('./components/ChatComposer', () => ({ default: (props: { inputValue: string, onInputChange: (v: string) => void, pendingAttachments?: unknown[] }) => <div><input data-testid="input" value={props.inputValue} onChange={e => props.onInputChange(e.target.value)} /><output data-testid="attachments">{JSON.stringify(props.pendingAttachments ?? [])}</output></div> }))
vi.mock('./components/ChatMessageList', () => ({ default: () => <div /> }))

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); h.sessions = []; h.realBackup = false; h.save.mockReset(); h.save.mockImplementation(async (s: ChatSession) => { h.sessions = [clone(s)] }); h.warning.mockReset(); h.error.mockReset(); h.fileToDataUrl.mockClear() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ChatPage draft blob HTTP status', () => {
  it.each(['one-bad', 'two-one-bad', 'ok'] as const)('%s', async scenario => {
    const attachments = scenario === 'two-one-bad' ? [{ type: 'image' as const, url: 'blob:good', fileName: 'good.png' }, { type: 'image' as const, url: 'blob:bad', fileName: 'bad.png' }] : [{ type: 'image' as const, url: scenario === 'ok' ? 'blob:good' : 'blob:bad', fileName: scenario === 'ok' ? 'good.png' : 'bad.png' }]
    const oldDraft = { inputValue: 'old', pendingAttachments: attachments, pendingHiddenContext: '', updatedAt: 1 }
    h.sessions = [{ id: 'http-draft', title: 'fixture', messages: [], draft: oldDraft }]
    const goodBlob = vi.fn(async () => new Blob(['a'], { type: 'image/png' }))
    const badBlob = vi.fn(async () => new Blob(['bad'], { type: 'text/plain' }))
    const fetch = vi.fn(async (url: string) => { if (url === 'blob:good') return { ok: true, status: 200, blob: goodBlob } as unknown as Response; if (url === 'blob:bad') return { ok: false, status: 404, blob: badBlob } as unknown as Response; throw Error('unexpected network') })
    vi.stubGlobal('fetch', fetch)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const view = render(<MemoryRouter><ThemeProvider theme={createTheme()}><ChatPage compact storageScope="draft-http" active /></ThemeProvider></MemoryRouter>)
    try {
      await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('old'))
      await waitFor(() => expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual(attachments))
      const storage = await vi.importActual<typeof import('./chatStorage')>('./chatStorage')
      const previous = { ...oldDraft, inputValue: 'recoverable', pendingAttachments: attachments.map(a => ({ ...a, url: 'data:image/png;base64,Qg==' })) }
      storage.writeSessionDraftBackup('http-draft', 1, previous, 'draft-http')
      const backup = storage.readSessionDraftBackup('http-draft', 'draft-http')
      h.realBackup = true
      fireEvent.change(screen.getByTestId('input'), { target: { value: 'current edit' } })
      fireEvent(window, new Event('blur'))
      if (scenario === 'ok') {
        await waitFor(() => expect(h.sessions[0]?.draft?.inputValue).toBe('current edit'))
        expect(goodBlob).toHaveBeenCalled(); expect(h.fileToDataUrl).toHaveBeenCalled()
        expect(h.sessions[0].draft?.pendingAttachments[0].url).toBe('data:image/png;base64,QQ==')
      } else {
        await waitFor(() => expect(fetch).toHaveBeenCalledWith('blob:bad'))
        await waitFor(() => expect(warn).toHaveBeenCalledWith('[ChatPage] Failed to serialize draft attachment:', expect.any(Error)))
        expect(badBlob).not.toHaveBeenCalled()
        expect(storage.readSessionDraftBackup('http-draft', 'draft-http')).toEqual(backup)
        expect(h.sessions[0].draft).toEqual(oldDraft)
        await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('current edit'))
        expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual(attachments)
      }
    } finally { h.realBackup = false; view.unmount() }
  })
})
