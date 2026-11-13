import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import type { ChatAttachment } from '@shared/llm'
import ChatPage from './ChatPage'
import { scopedStorageKey, STORAGE_KEY_CURRENT_SESSION_ID } from './chatPageShared'

const f = vi.hoisted(() => ({ noop: vi.fn(), profiles: [{ id: 'fixture-profile', model_name: 'Fixture', model_use: 'chat' }], remoteProfiles: [], importDataUrl: vi.fn(), blob: vi.fn(), error: vi.fn(), editA: vi.fn(), editB: vi.fn(), read: vi.fn(), config: null as unknown }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en', resolvedLanguage: 'en' }, t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue || key }) }))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config: f.config, isReady: true, buildEnv: DEFAULT_BUILD_ENV, configUtils: {}, updateConfig: vi.fn() }) }))
vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({ useRuntimeMcpStatus: () => ({ runtimeMcpStatus: null }) }))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => ({ notifyError: f.error, notifyWarning: f.noop, notifySuccess: f.noop, notifyInfo: f.noop }) }))
vi.mock('./hooks/useChatProfiles', () => ({ useChatProfiles: () => ({ availableProfiles: f.profiles, remoteProfiles: f.remoteProfiles }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcFs: {}, svcLLMProxy: { signHy3DModel: vi.fn() }, svcManagedMedia: { importDataUrl: f.importDataUrl, importFile: vi.fn() } }) }))
vi.mock('@renderer/utils/fileUtils', async original => ({ ...await original<typeof import('@renderer/utils/fileUtils')>(), fileToBlobUrl: f.blob }))
vi.mock('@renderer/utils/droppedImageUtils', async original => ({ ...await original<typeof import('@renderer/utils/droppedImageUtils')>(), getDroppedLocalImageFiles: f.read }))
vi.mock('./chatStorage', async original => ({ ...await original<typeof import('./chatStorage')>(), loadAllSessions: async () => ['a', 'b'].map(id => ({ id, title: id, profileId: 'fixture-profile', storageScope: 'race', messages: [], draft: { inputValue: id === 'a' ? 'keep' : 'session b', pendingAttachments: [], pendingHiddenContext: '', updatedAt: Date.now() } })), saveSessionToDB: vi.fn(), debouncedSaveSessions: vi.fn(), cancelDebouncedSessionSave: vi.fn(), migrateFromLocalStorage: async () => null }))
vi.mock('./components/SessionSidebar', () => ({ default: ({ onSelectSession }: { onSelectSession: (id: string) => void }) => <button onClick={() => onSelectSession('b')}>switch b</button> }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
vi.mock('./components/ImagePreviewOverlay', () => ({ default: () => null }))
vi.mock('./components/ImageContextMenu', () => ({ default: () => null }))
vi.mock('./components/AgentLocalFilesPanel', () => ({ default: () => null }))
vi.mock('./components/ChatImageGenerationSettings', () => ({ default: () => null }))
vi.mock('./components/ChatMessageList', () => ({ default: ({ onSetEditingIndex, onRegisterEditingAttachmentReceiver }: { onSetEditingIndex: (n: number | null) => void; onRegisterEditingAttachmentReceiver: (receiver: (a: ChatAttachment) => void) => void }) => <><button onClick={() => { onRegisterEditingAttachmentReceiver(f.editA); onSetEditingIndex(0) }}>edit a</button><button onClick={() => { onSetEditingIndex(null) }}>leave edit</button><button onClick={() => { onRegisterEditingAttachmentReceiver(f.editB); onSetEditingIndex(1) }}>edit b</button></> }))
vi.mock('./components/ChatComposer', () => ({ default: ({ inputValue, pendingAttachments }: { inputValue: string; pendingAttachments: ChatAttachment[] }) => <><textarea data-testid="input" value={inputValue} readOnly /><pre data-testid="attachments">{JSON.stringify(pendingAttachments)}</pre></> }))

const transfer = () => {
  const entries = Array.from({ length: 3 }, (_, i) => {
    const file = new File(['x'], `${i}.png`, { type: 'image/png' })
    return { name: file.name, fullPath: `/root/${file.name}`, isFile: true, isDirectory: false, file: (cb: (file: File) => void) => cb(file) }
  })
  const root = { name: 'root', isFile: false, isDirectory: true, createReader: () => { let done = false; return { readEntries: (cb: (entries: unknown[]) => void) => { const batch = done ? [] : entries; done = true; cb(batch) } } } }
  return { files: [], items: [{ kind: 'file', type: '', webkitGetAsEntry: () => root }], types: ['Files', 'text/plain'], getData: (key: string) => key === 'text/plain' ? 'stale text' : '' }
}
const result = (name: string) => ({ localMediaUrl: `local-media://${name}`, reference: { version: 1, kind: 'managed', relativePath: name, status: 'ready' } })
async function setup() {
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'race'), 'a')
  render(<ThemeProvider theme={createTheme()}><MemoryRouter><ChatPage storageScope="race" /></MemoryRouter></ThemeProvider>)
  await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('keep'))
}
beforeEach(() => {
  vi.resetAllMocks(); f.config = structuredClone(DEFAULT_CONFIG); f.blob.mockReturnValue('blob:test')
  f.read.mockResolvedValue({ files: [], failedUrls: [] })
  f.importDataUrl.mockImplementation(async ({ originalFileName }: { originalFileName: string }) => result(originalFileName))
  vi.stubGlobal('Image', class { naturalWidth = 1; naturalHeight = 1; onload: (() => void) | null = null; set src(_: string) { queueMicrotask(() => this.onload?.()) } })
})
afterEach(async () => { cleanup(); await act(async () => {}); vi.unstubAllGlobals(); localStorage.clear() })

describe('synthetic directory drop destination fence', () => {
  it.each(['session', 'editing'] as const)('does not continue after destination changes (%s)', async mode => {
    let release!: (value: ReturnType<typeof result>) => void
    const gate = new Promise<ReturnType<typeof result>>(resolve => { release = resolve })
    f.importDataUrl.mockImplementationOnce(() => gate)
    await setup()
    if (mode === 'editing') fireEvent.click(screen.getByRole('button', { name: 'edit a' }))
    try {
      fireEvent.drop(screen.getByTestId('input'), { dataTransfer: transfer() })
      await waitFor(() => expect(f.importDataUrl).toHaveBeenCalledOnce())
      if (mode === 'session') {
        fireEvent.click(screen.getByRole('button', { name: 'switch b' }))
        await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('session b'))
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'leave edit' }))
        fireEvent.click(screen.getByRole('button', { name: 'edit b' }))
      }
      await act(async () => { release(result('0.png')); await gate; await new Promise(resolve => setTimeout(resolve, 50)) })
      expect(f.importDataUrl).toHaveBeenCalledOnce()
      expect(f.editA).not.toHaveBeenCalled(); expect(f.editB).not.toHaveBeenCalled()
      expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual([])
      expect(screen.getByTestId('input')).toHaveValue(mode === 'session' ? 'session b' : 'keep')
    } finally { release(result('0.png')); await act(async () => { await gate }) }
  })
  it('imports three images in order when destination stays current', async () => {
    await setup(); fireEvent.drop(screen.getByTestId('input'), { dataTransfer: transfer() })
    await waitFor(() => expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toHaveLength(3))
    expect(f.importDataUrl).toHaveBeenCalledTimes(3)
    const attachments = JSON.parse(screen.getByTestId('attachments').textContent || '[]') as ChatAttachment[]
    expect(attachments.map(item => item.fileName)).toEqual(['0.png', '1.png', '2.png'])
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })
})
