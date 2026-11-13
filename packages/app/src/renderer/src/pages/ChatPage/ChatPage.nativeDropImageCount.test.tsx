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
  importFile: vi.fn(),
  read: vi.fn(),
  config: null as Config | null,
  noop: vi.fn(),
  profiles: [{ id: 'fixture-profile', model_name: 'Fixture', model_use: 'chat' }],
  remoteProfiles: []
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
    svcManagedMedia: { importDataUrl: f.importDataUrl, importFile: f.importFile }
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
      storageScope: 'drop-count',
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
    { id: 'b', title: 'b', profileId: 'fixture-profile', storageScope: 'drop-count', messages: [],
      draft: { inputValue: 'session b', pendingAttachments: [], pendingHiddenContext: '', updatedAt: Date.now() } }
  ],
  saveSessionToDB: vi.fn(),
  debouncedSaveSessions: vi.fn(),
  cancelDebouncedSessionSave: vi.fn(),
  migrateFromLocalStorage: async () => null
}))
vi.mock('./components/SessionSidebar', () => ({ default: ({ onSelectSession }: { onSelectSession: (id: string) => void }) => <button onClick={() => onSelectSession('b')}>switch b</button> }))
vi.mock('./components/SessionHistoryDialog', () => ({ default: () => null }))
vi.mock('./components/ChatPrimarySelection', () => ({ default: () => null }))
vi.mock('./components/ChatSkillPicker', () => ({ default: () => null }))
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
const directoryTransfer = (count: number, trailing = 0, duplicatePath = false, oversizedIndex = -1) => {
  const fileCallback = vi.fn()
  const files = Array.from({ length: count }, (_, i) => {
    const file = new File(['x'], `${i}.png`, { type: i === 0 ? 'text/plain' : 'image/png' })
    if (i === oversizedIndex) Object.defineProperty(file, 'size', { value: Number.MAX_SAFE_INTEGER })
    return {
      name: file.name,
      fullPath: duplicatePath ? '/root/nested/shared.png' : `/root/nested/${file.name}`,
      isFile: true,
      isDirectory: false,
      file: (callback: (file: File) => void) => {
        fileCallback()
        callback(file)
      }
    }
  })
  const text = new File(['x'], 'note.txt', { type: 'text/plain' })
  const txtEntry = {
    name: text.name,
    fullPath: '/root/nested/note.txt',
    isFile: true,
    isDirectory: false,
    file: (callback: (file: File) => void) => {
      fileCallback()
      callback(text)
    }
  }
  const dir = (name: string, entries: unknown[]) => ({
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let offset = 0
      return {
        readEntries: (callback: (entries: unknown[]) => void) => {
          const batch = entries.slice(offset, offset + 20)
          offset += batch.length
          callback(batch)
        }
      }
    }
  })
  const extra = Array.from({ length: trailing }, (_, i) => ({
    name: `late${i}.txt`,
    isFile: true,
    isDirectory: false,
    file: (callback: (file: File) => void) => {
      fileCallback()
      callback(new File(['x'], `late${i}.txt`))
    }
  }))
  const root = dir('root', [dir('nested', files), txtEntry, ...extra])
  return {
    fileCallback,
    dataTransfer: {
      files: [],
      items: [{ kind: 'file', type: '', webkitGetAsEntry: () => root }],
      types: ['Files'],
      getData: () => ''
    }
  }
}
const setup = async () => {
  localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'drop-count'), 'a')
  render(
    <ThemeProvider theme={createTheme()}>
      <MemoryRouter>
        <ChatPage storageScope="drop-count" />
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
    const actual = await vi.importActual<typeof import('@renderer/utils/droppedImageUtils')>('@renderer/utils/droppedImageUtils')
    return actual.materializeInternalImageDragAttachment(attachment)
  })
  f.blob.mockReturnValue('blob:test')
  f.importDataUrl.mockResolvedValue({
    localMediaUrl: 'local-media://imported',
    reference: { version: 1, kind: 'managed', relativePath: 'imported', status: 'ready' }
  })
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
describe('internal drop synthetic rejection and stale session', () => {
  it.each([false, true])('does not fall through to plain text after a thrown materializer edit=%s', async edit => {
    f.materialize.mockRejectedValue(new Error('synthetic failure'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await setup()
    if (edit) fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const before = screen.getByTestId('attachments').textContent
    const payload = JSON.stringify({ attachments: [{ type: 'image', url: 'local-media://first', fileName: 'first.png' }], textContent: 'internal text' })
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: { files: [], items: [], types: ['application/x-qapp-image', 'text/plain'], getData: (key: string) => key === 'application/x-qapp-image' ? payload : key === 'text/plain' ? 'fallback text' : '' } })
    await waitFor(() => expect(f.notify).toHaveBeenCalled())
    expect(f.materialize).toHaveBeenCalledOnce()
    expect(f.editing).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
    expect(f.read).not.toHaveBeenCalled()
  })

  it('ignores a delayed materializer result after switching A to B', async () => {
    let release!: (value: ChatAttachment | null) => void
    f.materialize.mockImplementation(() => new Promise(resolve => { release = resolve }))
    await setup()
    const attachment: ChatAttachment = { type: 'image', url: 'local-media://first', fileName: 'first.png' }
    const payload = JSON.stringify({ attachments: [attachment], textContent: 'stale text' })
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: { files: [], items: [], types: ['application/x-qapp-image'], getData: (key: string) => key === 'application/x-qapp-image' ? payload : '' } })
    await waitFor(() => expect(f.materialize).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'switch b' }))
    await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('session b'))
    await act(async () => { release(null); await Promise.resolve() })
    expect(screen.getByTestId('input')).toHaveValue('session b')
    expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual([])
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.editing).not.toHaveBeenCalled()
  })
})

describe('internal materialization sequential contract', () => {
  const items: ChatAttachment[] = ['one', 'two', 'three'].map(name => ({ type: 'image', url: `local-media://${name}`, fileName: `${name}.png` }))
  const dropItems = () => {
    const payload = JSON.stringify({ attachments: items, textContent: 'sequence text' })
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: { files: [], items: [], types: ['application/x-qapp-image'], getData: (key: string) => key === 'application/x-qapp-image' ? payload : '' } })
  }
  it.each(['null', 'reject'] as const)('stops after second %s and rejects the batch', async failure => {
    let first!: (value: ChatAttachment) => void
    let second!: (value: ChatAttachment | null) => void
    let rejectSecond!: (error: Error) => void
    const firstGate = new Promise<ChatAttachment>(resolve => { first = resolve })
    const secondGate = new Promise<ChatAttachment | null>((resolve, reject) => { second = resolve; rejectSecond = reject })
    f.materialize.mockImplementation((item: ChatAttachment) => item.url === items[0].url ? firstGate : item.url === items[1].url ? secondGate : Promise.resolve(item))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await setup()
    const before = screen.getByTestId('attachments').textContent
    try {
      dropItems()
      await waitFor(() => expect(f.materialize).toHaveBeenCalled())
      expect.soft(f.materialize).toHaveBeenCalledTimes(1)
      await act(async () => { first(items[0]); await Promise.resolve() })
      await waitFor(() => expect(f.materialize.mock.calls.length).toBeGreaterThanOrEqual(2))
      expect.soft(f.materialize).toHaveBeenCalledTimes(2)
      await act(async () => { if (failure === 'null') second(null); else rejectSecond(new Error('synthetic')); await Promise.resolve() })
      await waitFor(() => expect(f.notify).toHaveBeenCalled())
      expect.soft(f.materialize).toHaveBeenCalledTimes(2)
      expect.soft(screen.getByTestId('attachments').textContent).toBe(before)
      expect.soft(screen.getByTestId('input')).toHaveValue('keep')
      expect.soft(f.editing).not.toHaveBeenCalled()
    } finally {
      first(items[0]); second(null)
      await act(async () => { await Promise.allSettled([firstGate, secondGate]) })
    }
  })
  it('delivers all three in order and appends text once', async () => {
    f.materialize.mockImplementation(async (item: ChatAttachment) => item)
    await setup()
    dropItems()
    await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('keep\n\nsequence text'))
    expect(f.materialize.mock.calls.map(([item]) => item.url)).toEqual(items.map(item => item.url))
    const attachments = JSON.parse(screen.getByTestId('attachments').textContent || '[]') as ChatAttachment[]
    expect(attachments.map(item => item.url)).toEqual(['local-media://existing', ...items.map(item => item.url)])
    expect(f.notify).not.toHaveBeenCalled()
  })
  it('does not start later images after switching A to B while the first is pending', async () => {
    let first!: (value: ChatAttachment) => void
    const gate = new Promise<ChatAttachment>(resolve => { first = resolve })
    f.materialize.mockImplementation((item: ChatAttachment) => item.url === items[0].url ? gate : Promise.resolve(item))
    await setup()
    try {
      dropItems()
      await waitFor(() => expect(f.materialize).toHaveBeenCalled())
      expect.soft(f.materialize).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole('button', { name: 'switch b' }))
      await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('session b'))
      await act(async () => { first(items[0]); await gate })
      expect.soft(f.materialize).toHaveBeenCalledTimes(1)
      expect.soft(screen.getByTestId('input')).toHaveValue('session b')
      expect.soft(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toEqual([])
      expect.soft(f.notify).not.toHaveBeenCalled()
    } finally {
      first(items[0])
      await act(async () => { await gate })
    }
  })
})

describe('internal materialization batch atomicity', () => {
  it.each([false, true])('rejects a failed second image without partial delivery edit=%s', async (edit) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    vi.stubGlobal('fetch', fetchMock)
    await setup()
    if (edit) fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const before = screen.getByTestId('attachments').textContent
    const payload = JSON.stringify({ attachments: [
      { type: 'image', url: 'local-media://first', fileName: 'first.png' },
      { type: 'image', url: 'blob:missing', fileName: 'missing.png' }
    ], textContent: 'dropped synthetic text' })
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: {
      files: [], items: [], types: ['application/x-qapp-image'],
      getData: (key: string) => key === 'application/x-qapp-image' ? payload : ''
    } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(f.notify.mock.calls.length > 0 || f.editing.mock.calls.length > 0 || (screen.getByTestId('input') as HTMLTextAreaElement).value !== 'keep' || screen.getByTestId('attachments').textContent !== before).toBe(true))
    expect.soft(f.notify.mock.calls.length).toBeGreaterThan(0)
    expect.soft(f.editing).not.toHaveBeenCalled()
    expect.soft(screen.getByTestId('attachments').textContent).toBe(before)
    expect.soft(screen.getByTestId('input')).toHaveValue('keep')
  })

  it.each([false, true])('delivers two distinct local images in order with text edit=%s', async (edit) => {
    await setup()
    if (edit) fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const payload = JSON.stringify({ attachments: [
      { type: 'image', url: 'local-media://first', fileName: 'first.png' },
      { type: 'image', url: 'local-media://second', fileName: 'second.png' }
    ], textContent: 'dropped synthetic text' })
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: {
      files: [], items: [], types: ['application/x-qapp-image'],
      getData: (key: string) => key === 'application/x-qapp-image' ? payload : ''
    } })
    if (edit) {
      await waitFor(() => expect(f.editing).toHaveBeenCalledTimes(2))
      expect(f.editing.mock.calls.map(([item]) => item.url)).toEqual(['local-media://first', 'local-media://second'])
      expect(screen.getByTestId('input')).toHaveValue('keep')
    } else {
      await waitFor(() => expect(screen.getByTestId('input')).toHaveValue('keep\n\ndropped synthetic text'))
      const attachments = JSON.parse(screen.getByTestId('attachments').textContent || '[]') as ChatAttachment[]
      expect(attachments.map(item => item.url)).toEqual(['local-media://existing', 'local-media://first', 'local-media://second'])
    }
    expect(f.notify).not.toHaveBeenCalled()
  })
})

describe('edit-form native image import preparation', () => {
  it('rejects 51 files before any edit-form decode or managed import', async () => {
    await setup()
    expect(f.editImport).toBeTypeOf('function')
    await expect(f.editImport!(images(51))).rejects.toThrow('本次图片数量超过限制，请分批发送')
    expect(f.blob).not.toHaveBeenCalled()
    expect(f.imageCreated).not.toHaveBeenCalled()
    expect(f.fileReaderCreated).not.toHaveBeenCalled()
    expect(f.importDataUrl).not.toHaveBeenCalled()
    expect(f.importFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachments')).toHaveTextContent('existing.png')
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })

  it('waits for the first image import before decoding or importing the second', async () => {
    await setup()
    let release!: (value: unknown) => void
    f.importDataUrl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    f.importDataUrl.mockResolvedValueOnce({
      localMediaUrl: 'local-media://second',
      reference: { version: 1, kind: 'managed', relativePath: 'second', status: 'ready' }
    })
    const files = images(2)
    const importer = f.editImport!
    expect(importer).toBeTypeOf('function')
    const result = importer(files)
    try {
      await waitFor(() => expect(f.importDataUrl).toHaveBeenCalled())
      expect(f.importDataUrl).toHaveBeenCalledOnce()
      expect(f.imageCreated).toHaveBeenCalledOnce()
    } finally {
      release({
        localMediaUrl: 'local-media://first',
        reference: { version: 1, kind: 'managed', relativePath: 'first', status: 'ready' }
      })
      await result.catch(() => undefined)
    }
    const output = await result
    expect(output.map((attachment) => attachment.fileName)).toEqual(['0.png', '1.png'])
    expect(output.map((attachment) => attachment.url)).toEqual([
      'local-media://first',
      'local-media://second'
    ])
    expect(output.map((attachment) => [attachment.sourceWidth, attachment.sourceHeight])).toEqual([
      [1, 1],
      [1, 1]
    ])
    expect(f.importDataUrl).toHaveBeenCalledTimes(2)
  })

  it('preflights every image size before starting any import', async () => {
    await setup()
    const files = images(2)
    Object.defineProperty(files[1], 'size', { value: Number.MAX_SAFE_INTEGER })
    expect(f.editImport).toBeTypeOf('function')
    const importer = f.editImport!
    const result = importer(files)
    try {
      await expect(result).rejects.toThrow('1.png is too large')
      expect(f.blob).not.toHaveBeenCalled()
      expect(f.imageCreated).not.toHaveBeenCalled()
      expect(f.importDataUrl).not.toHaveBeenCalled()
      expect(f.importFile).not.toHaveBeenCalled()
    } finally {
      // A failing preflight implementation may have already started the first
      // FileReader; drain its import before the next test resets the mocks.
      if (f.blob.mock.calls.length > 0)
        await waitFor(() => expect(f.importDataUrl).toHaveBeenCalled())
    }
  })

  it('preserves order, dimensions, bytes and managed references for eight images', async () => {
    await setup()
    f.importDataUrl.mockImplementation(
      async ({ originalFileName }: { originalFileName: string }) => ({
        localMediaUrl: `local-media://${originalFileName}`,
        reference: { version: 1, kind: 'managed', relativePath: originalFileName, status: 'ready' }
      })
    )
    const files = images(8)
    const output = await f.editImport!(files)
    expect(output.map((attachment) => attachment.fileName)).toEqual(files.map((file) => file.name))
    expect(output.map((attachment) => attachment.url)).toEqual(
      files.map((file) => `local-media://${file.name}`)
    )
    expect(output.map((attachment) => attachment.media?.relativePath)).toEqual(
      files.map((file) => file.name)
    )
    expect(
      output.map((attachment) => [
        attachment.sourceWidth,
        attachment.sourceHeight,
        attachment.sizeBytes
      ])
    ).toEqual(files.map(() => [1, 1, 1]))
    expect(f.importDataUrl.mock.calls.map(([input]) => input.originalFileName)).toEqual(
      files.map((file) => file.name)
    )
    expect(f.importDataUrl.mock.calls.map(([input]) => input.dataUrl)).toEqual(
      files.map(() => 'data:image/png;base64,eA==')
    )
    expect(f.importFile).not.toHaveBeenCalled()
  })

  it('rejects the entire result and does not read the third image when the second import fails', async () => {
    await setup()
    f.importDataUrl.mockResolvedValueOnce({
      localMediaUrl: 'local-media://first',
      reference: { version: 1, kind: 'managed', relativePath: 'first', status: 'ready' }
    })
    f.importDataUrl.mockRejectedValueOnce(new Error('second import failed'))
    await expect(f.editImport!(images(3))).rejects.toThrow('second import failed')
    expect(f.importDataUrl).toHaveBeenCalledTimes(2)
    expect(f.blob).toHaveBeenCalledTimes(2)
    expect(f.imageCreated).toHaveBeenCalledTimes(2)
    expect(f.fileReaderCreated).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('attachments')).toHaveTextContent('existing.png')
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })
})

describe('native drop image count boundary', () => {
  it('preserves distinct image occurrences with identical URLs in one internal drag', async () => {
    await setup()
    const same = { type: 'image', url: 'local-media:///fixture/same.png', fileName: 'same.png' }
    const payload = JSON.stringify({ attachments: [same, same] })
    fireEvent.drop(screen.getByTestId('input'), {
      dataTransfer: {
        files: [], items: [], types: ['application/x-qapp-image'],
        getData: (key: string) => key === 'application/x-qapp-image' ? payload : ''
      }
    })
    await waitFor(() => {
      const attachments = JSON.parse(screen.getByTestId('attachments').textContent || '[]') as ChatAttachment[]
      expect(attachments.filter((attachment) => attachment.url === same.url)).toHaveLength(2)
    })
    expect(f.notify).not.toHaveBeenCalled()
  })

  it('rejects a single internal drag containing 51 repeated image occurrences before materialization', async () => {
    await setup()
    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected fixture read'))
    vi.stubGlobal('fetch', fetchMock)
    const before = screen.getByTestId('attachments').textContent
    const same = { type: 'image', url: 'blob:repeated', fileName: 'repeated.png' }
    const payload = JSON.stringify({ attachments: Array.from({ length: 51 }, () => same), textContent: 'should not append' })
    fireEvent.drop(screen.getByTestId('input'), {
      dataTransfer: {
        files: [], items: [], types: ['application/x-qapp-image'],
        getData: (key: string) => key === 'application/x-qapp-image' ? payload : ''
      }
    })
    await waitFor(() => expect(f.notify).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(f.blob).not.toHaveBeenCalled()
    expect(f.imageCreated).not.toHaveBeenCalled()
    expect(f.importDataUrl).not.toHaveBeenCalled()
    expect(f.importFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })

  it('rejects 51 native image descriptors delivered to the edit receiver before decoding or import', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const before = screen.getByTestId('attachments').textContent
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: transfer(images(51), 'file:///C:/test.png\nextra text') })
    await waitFor(() => expect(f.notify).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送'))
    expect(f.editing).not.toHaveBeenCalled()
    expect(f.blob).not.toHaveBeenCalled()
    expect(f.imageCreated).not.toHaveBeenCalled()
    expect(f.importDataUrl).not.toHaveBeenCalled()
    expect(f.importFile).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })

  it.each([false, true])('rejects ambiguous repeated image paths without partial delivery (edit=%s)', async (edit) => {
    await setup()
    if (edit) fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const before = screen.getByTestId('attachments').textContent
    const drop = directoryTransfer(2, 0, true)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: drop.dataTransfer })
    await waitFor(() => expect(f.notify.mock.calls.length > 0 || (edit ? f.editing.mock.calls.length : f.importDataUrl.mock.calls.length) > 0).toBe(true), { timeout: 5000 })
    expect(f.notify).toHaveBeenCalledWith('Some selected images have conflicting paths. Drag them separately to avoid losing any.')
    expect(f.editing).not.toHaveBeenCalled()
    expect(f.blob).not.toHaveBeenCalled()
    expect(f.imageCreated).not.toHaveBeenCalled()
    expect(f.importDataUrl).not.toHaveBeenCalled()
    expect(f.importFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })

  it.each([false, true])('rejects 51 same-path image occurrences before importing (edit=%s)', async (edit) => {
    await setup()
    if (edit) fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const before = screen.getByTestId('attachments').textContent
    const drop = directoryTransfer(51, 1, true)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: drop.dataTransfer })
    // Both reject and the old first-path-only import provide a completion signal.
    await waitFor(() => expect(f.notify.mock.calls.length > 0 || (edit ? f.editing.mock.calls.length : f.importDataUrl.mock.calls.length) > 0).toBe(true), { timeout: 5000 })
    expect(f.notify).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
    expect(drop.fileCallback).toHaveBeenCalledTimes(51)
    expect(f.editing).not.toHaveBeenCalled()
    expect(f.blob).not.toHaveBeenCalled()
    expect(f.imageCreated).not.toHaveBeenCalled()
    expect(f.fileReaderCreated).not.toHaveBeenCalled()
    expect(f.importDataUrl).not.toHaveBeenCalled()
    expect(f.importFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })

  it('rejects 51 directory image descriptors before materialization and preserves the draft', async () => {
    await setup()
    const before = screen.getByTestId('attachments').textContent
    const drop = directoryTransfer(51, 3)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: drop.dataTransfer })
    await waitFor(() => expect(f.notify).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送'))
    expect(drop.fileCallback).toHaveBeenCalledTimes(51)
    expect(f.blob).not.toHaveBeenCalled()
    expect(f.imageCreated).not.toHaveBeenCalled()
    expect(f.fileReaderCreated).not.toHaveBeenCalled()
    expect(f.importDataUrl).not.toHaveBeenCalled()
    expect(f.importFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })
  it('rejects excessive directory nodes with no partial import', async () => {
    await setup()
    const before = screen.getByTestId('attachments').textContent
    const drop = directoryTransfer(0, 4100)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: drop.dataTransfer })
    await waitFor(() => expect(f.notify).toHaveBeenCalledWith('目录内容过多，请分批拖入'), {
      timeout: 5000
    })
    expect(f.importDataUrl).not.toHaveBeenCalled()
    expect(f.importFile).not.toHaveBeenCalled()
    expect(f.blob).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })
  it('allows 50 directory image descriptors to reach import', async () => {
    await setup()
    const drop = directoryTransfer(50)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: drop.dataTransfer })
    await waitFor(() => expect(f.importDataUrl).toHaveBeenCalled())
    expect(drop.fileCallback).toHaveBeenCalledTimes(51)
    expect(f.notify).not.toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
  })
  it('rejects an oversized directory before decoding or importing into the edit receiver', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const before = screen.getByTestId('attachments').textContent
    const drop = directoryTransfer(51)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: drop.dataTransfer })
    // Drain the old implementation as well, so failed regressions cannot keep
    // importing files into the next test's reset mocks.
    await waitFor(() => expect(f.notify.mock.calls.length > 0 || f.editing.mock.calls.length === 51).toBe(true), { timeout: 10000 })
    expect(f.notify).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
    expect(f.editing).not.toHaveBeenCalled()
    expect(f.blob).not.toHaveBeenCalled()
    expect(f.imageCreated).not.toHaveBeenCalled()
    expect(f.fileReaderCreated).not.toHaveBeenCalled()
    expect(f.importDataUrl).not.toHaveBeenCalled()
    expect(f.importFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })
  it('preserves the edit directory path at exactly 50 images', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const drop = directoryTransfer(50)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: drop.dataTransfer })
    await waitFor(() => expect(f.editing).toHaveBeenCalledTimes(50), { timeout: 5000 })
    expect(f.notify).not.toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
  })
  it('rejects excessive directory nodes while editing with no partial import', async () => {
    await setup()
    fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const drop = directoryTransfer(0, 4100)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: drop.dataTransfer })
    await waitFor(() => expect(f.notify.mock.calls.length > 0 || f.noop.mock.calls.length > 0).toBe(true), { timeout: 10000 })
    expect(f.notify).toHaveBeenCalledWith('目录内容过多，请分批拖入')
    expect(f.editing).not.toHaveBeenCalled()
    expect(f.importDataUrl).not.toHaveBeenCalled()
    expect(f.blob).not.toHaveBeenCalled()
  })
  it('rejects 51 images and a non-image before reading, preserving draft and text even with a file URL', async () => {
    await setup()
    const before = screen.getByTestId('attachments').textContent
    fireEvent.drop(screen.getByTestId('input'), {
      dataTransfer: transfer(
        [...images(51), new File(['x'], 'note.txt', { type: 'text/plain' })],
        'file:///C:/test.png\nextra text'
      )
    })
    expect(f.notify).toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
    expect(f.blob).not.toHaveBeenCalled()
    expect(f.imageCreated).not.toHaveBeenCalled()
    expect(f.fileReaderCreated).not.toHaveBeenCalled()
    expect(f.importDataUrl).not.toHaveBeenCalled()
    expect(f.importFile).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })
  it('lets 50 images plus a non-image enter import', async () => {
    await setup()
    fireEvent.drop(screen.getByTestId('input'), {
      dataTransfer: transfer([...images(50), new File(['x'], 'note.txt', { type: 'text/plain' })])
    })
    await waitFor(() => expect(f.blob).toHaveBeenCalled())
    expect(f.notify).not.toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
  })
  it('does not count a URL-only drop as native files', async () => {
    await setup()
    fireEvent.drop(screen.getByTestId('input'), {
      dataTransfer: transfer([], 'file:///C:/test.png')
    })
    await waitFor(() => expect(f.read).toHaveBeenCalled())
    expect(f.notify).not.toHaveBeenCalledWith('本次图片数量超过限制，请分批发送')
  })

  it.each(['ordinary', 'editing'] as const)('rejects oversized second native image before any reads (%s)', async (mode) => {
    await setup()
    if (mode === 'editing') fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const before = screen.getByTestId('attachments').textContent
    const files = images(3)
    Object.defineProperty(files[1], 'size', { value: Number.MAX_SAFE_INTEGER })
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: transfer(files) })
    // The legacy per-file path also notifies; drain its outstanding imports.
    await waitFor(() => expect(f.notify).toHaveBeenCalled(), { timeout: 5000 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)) })
    expect.soft(f.blob).not.toHaveBeenCalled()
    expect.soft(f.imageCreated).not.toHaveBeenCalled()
    expect.soft(f.fileReaderCreated).not.toHaveBeenCalled()
    expect.soft(f.importDataUrl).not.toHaveBeenCalled()
    expect.soft(f.importFile).not.toHaveBeenCalled()
    expect.soft(f.editing).not.toHaveBeenCalled()
    expect.soft(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })

  it.each(['ordinary', 'editing'] as const)('imports three valid native images in order (%s)', async (mode) => {
    await setup()
    if (mode === 'editing') fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const files = images(3)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: transfer(files) })
    await waitFor(() => {
      if (mode === 'editing') expect(f.editing).toHaveBeenCalledTimes(3)
      else expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toHaveLength(4)
    }, { timeout: 5000 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const actual: ChatAttachment[] = mode === 'editing'
      ? f.editing.mock.calls.map(([attachment]) => attachment as ChatAttachment)
      : JSON.parse(screen.getByTestId('attachments').textContent || '[]').slice(1)
    expect(actual.map((attachment) => attachment.fileName)).toEqual(files.map((file) => file.name))
    expect(f.notify).not.toHaveBeenCalled()
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })

  it.each(['ordinary', 'editing'] as const)('rejects oversized second directory image before reads (%s)', async (mode) => {
    await setup()
    if (mode === 'editing') fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const before = screen.getByTestId('attachments').textContent
    const drop = directoryTransfer(3, 0, false, 1)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: drop.dataTransfer })
    await waitFor(() => expect(f.notify).toHaveBeenCalled(), { timeout: 5000 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)) })
    expect.soft(f.blob).not.toHaveBeenCalled()
    expect.soft(f.imageCreated).not.toHaveBeenCalled()
    expect.soft(f.fileReaderCreated).not.toHaveBeenCalled()
    expect.soft(f.importDataUrl).not.toHaveBeenCalled()
    expect.soft(f.importFile).not.toHaveBeenCalled()
    expect.soft(f.editing).not.toHaveBeenCalled()
    expect.soft(screen.getByTestId('attachments').textContent).toBe(before)
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })

  it.each(['ordinary', 'editing'] as const)('imports three small directory image-like files in order (%s)', async (mode) => {
    await setup()
    if (mode === 'editing') fireEvent.click(screen.getByRole('button', { name: 'edit fixture' }))
    const drop = directoryTransfer(3)
    fireEvent.drop(screen.getByTestId('input'), { dataTransfer: drop.dataTransfer })
    await waitFor(() => {
      if (mode === 'editing') expect(f.editing).toHaveBeenCalledTimes(3)
      else expect(JSON.parse(screen.getByTestId('attachments').textContent || '[]')).toHaveLength(4)
    }, { timeout: 5000 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const actual: ChatAttachment[] = mode === 'editing'
      ? f.editing.mock.calls.map(([attachment]) => attachment as ChatAttachment)
      : JSON.parse(screen.getByTestId('attachments').textContent || '[]').slice(1)
    expect(actual.map((attachment) => attachment.fileName)).toEqual(['0.png', '1.png', '2.png'])
    // 0.png intentionally has text/plain MIME; retain the production classification.
    expect(actual.map((attachment) => attachment.type)).toEqual(['file', 'image', 'image'])
    expect(f.notify).not.toHaveBeenCalled()
    expect(screen.getByTestId('input')).toHaveValue('keep')
  })
})
