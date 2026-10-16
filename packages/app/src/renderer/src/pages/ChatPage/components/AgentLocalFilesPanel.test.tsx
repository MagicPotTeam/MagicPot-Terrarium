import React from 'react'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_LOCAL_FILE_ERRORS,
  type AgentLocalFileGrant,
  type AgentLocalFileScope,
  type AgentLocalFilesSvc,
  type ReadLocalFileResponse
} from '@shared/api/svcAgentLocalFiles'
import AgentLocalFilesPanel from './AgentLocalFilesPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options: Record<string, unknown> = {}) =>
      String(options.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(options[name])
      )
  })
}))

const scope: AgentLocalFileScope = {
  projectId: 'project-a',
  paneId: 'pane-a',
  sessionId: 'session-a'
}
const grant: AgentLocalFileGrant = {
  id: 'a'.repeat(32),
  kind: 'file',
  name: 'notes.txt',
  expiresAt: 1900000000000,
  readOnly: true
}
const text: ReadLocalFileResponse = {
  name: 'notes.txt',
  relativePath: '',
  content: 'Untrusted <script>content</script>',
  encoding: 'utf-8',
  sizeBytes: 34,
  returnedBytes: 34,
  truncated: false
}
const directory: AgentLocalFileGrant = { ...grant, kind: 'directory', name: 'documents' }
const attachLabel = 'Use this text in the conversation'
const originalBridge = window.electronFile

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeService() {
  return {
    setScope: vi
      .fn<AgentLocalFilesSvc['setScope']>()
      .mockImplementation(() => undefined as unknown as Promise<void>),
    choose: vi.fn<AgentLocalFilesSvc['choose']>().mockResolvedValue(grant),
    read: vi.fn<AgentLocalFilesSvc['read']>().mockResolvedValue(text),
    list: vi.fn<AgentLocalFilesSvc['list']>().mockResolvedValue({ entries: [], truncated: false }),
    cancel: vi.fn<AgentLocalFilesSvc['cancel']>().mockResolvedValue(undefined),
    revoke: vi.fn<AgentLocalFilesSvc['revoke']>().mockResolvedValue(undefined)
  }
}

function setup(service = makeService(), disabled = false) {
  const onAttach = vi.fn().mockReturnValue(true)
  const result = render(
    <AgentLocalFilesPanel scope={scope} service={service} disabled={disabled} onAttach={onAttach} />
  )
  return { ...result, service, onAttach }
}

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
}

async function selectFile() {
  click('Choose file')
  return screen.findByRole('region', { name: 'Text preview' })
}

function setBridge(value: unknown) {
  Object.defineProperty(window, 'electronFile', { configurable: true, value })
}

beforeEach(() => {
  let id = 0
  // jsdom versions without randomUUID still exercise the production UUID request path.
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`)
  })
  setBridge(undefined)
})

afterEach(() => {
  cleanup()
  setBridge(originalBridge)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AgentLocalFilesPanel', () => {
  it('does not start a chooser before scope activation resolves', async () => {
    const service = makeService()
    const activation = deferred<void>()
    service.setScope.mockReturnValueOnce(activation.promise)
    setup(service)

    const chooseButton = screen.getByRole('button', { name: 'Choose file' })
    expect((chooseButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(chooseButton)
    expect(service.choose).not.toHaveBeenCalled()

    await act(async () => activation.resolve())
    await waitFor(() => expect((chooseButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(chooseButton)
    await waitFor(() => expect(service.choose).toHaveBeenCalledOnce())
  })

  it.each(['resolve', 'reject'])(
    'ignores a stale scope activation %s after switching owners',
    async (outcome) => {
      const service = makeService()
      const oldActivation = deferred<void>()
      const newActivation = deferred<void>()
      const nextScope = { ...scope, sessionId: 'session-b' }
      service.setScope.mockImplementation(({ scope: requestedScope, active }) => {
        if (!active) return Promise.resolve()
        return requestedScope.sessionId === scope.sessionId
          ? oldActivation.promise
          : newActivation.promise
      })
      const { rerender } = setup(service)
      rerender(<AgentLocalFilesPanel scope={nextScope} service={service} onAttach={vi.fn()} />)

      const chooseButton = screen.getByRole('button', { name: 'Choose file' })
      expect(chooseButton).toBeDisabled()
      await act(async () => {
        if (outcome === 'resolve') oldActivation.resolve()
        else oldActivation.reject({ code: 'GRANT_DENIED' })
      })
      expect(chooseButton).toBeDisabled()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(service.choose).not.toHaveBeenCalled()

      await act(async () => newActivation.resolve())
      await waitFor(() => expect(chooseButton).toBeEnabled())
      expect(screen.queryByRole('alert')).toBeNull()
    }
  )

  it('enables the scope synchronously and performs chooser and read operations', async () => {
    const service = makeService()
    service.setScope.mockImplementationOnce(() => undefined as never)
    setup(service)

    const chooseButton = screen.getByRole('button', { name: 'Choose file' })
    await waitFor(() => expect(chooseButton).toBeEnabled())
    fireEvent.click(chooseButton)
    await waitFor(() => expect(service.choose).toHaveBeenCalledOnce())
    await waitFor(() => expect(service.read).toHaveBeenCalledOnce())
    expect(service.choose.mock.calls[0][0]).toMatchObject({ scope, kind: 'file' })
    expect(service.read.mock.calls[0][0]).toMatchObject({
      scope,
      grantId: grant.id,
      relativePath: ''
    })
  })

  it('previews PDF pages and adds original located content only after explicit consent', async () => {
    const file: ReadLocalFileResponse = {
      ...text,
      name: 'unique.pdf',
      content: 'OWNED-PDF-PAGE-ONEOWNED-PDF-PAGE-TWO',
      returnedBytes: 36,
      sizeBytes: 4096,
      document: {
        format: 'pdf',
        sourceSha256: 'c'.repeat(64),
        warnings: ['reading-order-unverified'],
        segments: [
          { text: 'OWNED-PDF-PAGE-ONE', locator: { kind: 'pdf-item', page: 1, item: 0 } },
          { text: 'OWNED-PDF-PAGE-TWO', locator: { kind: 'pdf-item', page: 2, item: 0 } }
        ]
      }
    }
    const service = makeService()
    service.read.mockResolvedValue(file)
    const { onAttach } = setup(service)
    const preview = await selectFile()
    expect(preview.textContent).toBe('[Page 1]\nOWNED-PDF-PAGE-ONE\n[Page 2]\nOWNED-PDF-PAGE-TWO')
    expect(screen.getByText(/Scanned images are not OCR/)).toBeTruthy()
    expect(onAttach).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    click(attachLabel)
    expect(onAttach).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('chooses and reads text without attaching, then requires informed consent and an explicit click', async () => {
    const { service, onAttach } = setup()
    const preview = await selectFile()
    expect(preview.textContent).toBe(text.content)
    expect(preview.querySelector('script')).toBeNull()
    expect(screen.getByText(/UTF-8 text, PDF, DOCX, XLSX and PPTX, up to 64 KiB/)).toBeTruthy()
    expect(screen.getByText(/Document input up to 1 MiB/)).toBeTruthy()
    expect(screen.getByText(/not layout or images/)).toBeTruthy()
    expect(screen.getByText('Read-only access', { exact: false })).toBeTruthy()
    expect(
      screen.getByText(`Expires: ${new Date(grant.expiresAt).toLocaleString()}`, { exact: false })
    ).toBeTruthy()
    expect(screen.getByText('notes.txt · UTF-8 · 34 bytes of 34 bytes')).toBeTruthy()
    expect(service.choose).toHaveBeenCalledWith({
      scope,
      kind: 'file',
      requestId: expect.any(String)
    })
    expect(service.read).toHaveBeenCalledWith({
      scope,
      grantId: grant.id,
      relativePath: '',
      requestId: expect.any(String)
    })
    expect(service.list).not.toHaveBeenCalled()
    expect(service.choose.mock.calls[0][0].requestId).not.toBe(
      service.read.mock.calls[0][0].requestId
    )
    expect(crypto.randomUUID).toHaveBeenCalledTimes(2)
    expect(onAttach).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: attachLabel }) as HTMLButtonElement).disabled).toBe(
      true
    )
    click(attachLabel)
    expect(onAttach).not.toHaveBeenCalled()
    const consent = screen.getByRole('checkbox', {
      name: /draft and chat history.*selected model.*remote and cost tokens.*only when I send.*untrusted data.*Nothing is sent automatically/
    })
    fireEvent.click(consent)
    expect(onAttach).not.toHaveBeenCalled()
    click(attachLabel)
    expect(onAttach).toHaveBeenCalledExactlyOnceWith(text)
    await waitFor(() => expect((consent as HTMLInputElement).checked).toBe(false))
    click(attachLabel)
    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it.each(['false', 'reject', 'throw'])(
    'keeps the preview and consent available when attachment %s fails',
    async (mode) => {
      const { onAttach } = setup()
      await selectFile()
      const consent = screen.getByRole('checkbox', { name: /I understand: this text/ })
      fireEvent.click(consent)
      if (mode === 'false') onAttach.mockReturnValueOnce(false)
      else if (mode === 'reject') onAttach.mockRejectedValueOnce(new Error('private detail'))
      else
        onAttach.mockImplementationOnce(() => {
          throw new Error('private detail')
        })

      click(attachLabel)
      if (mode === 'reject') {
        expect(
          (screen.getByRole('button', { name: attachLabel }) as HTMLButtonElement).disabled
        ).toBe(true)
      }
      expect((await screen.findByRole('alert')).textContent).toBe(
        'Could not add this text to the conversation draft. Review it and try again.'
      )
      expect(screen.getByRole('region', { name: 'Text preview' })).toBeInTheDocument()
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
      expect(screen.getByRole('button', { name: attachLabel })).toBeEnabled()
    }
  )

  it('clears consent and reports success only after an asynchronous attachment succeeds', async () => {
    const { onAttach } = setup()
    const pending = deferred<boolean>()
    onAttach.mockReturnValueOnce(pending.promise)
    await selectFile()
    fireEvent.click(screen.getByRole('checkbox'))
    click(attachLabel)

    expect(screen.getByRole('button', { name: attachLabel })).toBeDisabled()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    await act(async () => pending.resolve(true))
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Added to the conversation draft. Nothing was sent yet.'
    )
    expect(screen.getByRole('region', { name: 'Text preview' })).toBeInTheDocument()
  })

  it('drops a stale attachment result after switching scope', async () => {
    const { onAttach, rerender } = setup()
    const pending = deferred<boolean>()
    onAttach.mockReturnValueOnce(pending.promise)
    await selectFile()
    fireEvent.click(screen.getByRole('checkbox'))
    click(attachLabel)
    rerender(
      <AgentLocalFilesPanel
        scope={{ ...scope, sessionId: 'session-b' }}
        service={makeService()}
        onAttach={onAttach}
      />
    )
    await act(async () => pending.resolve(true))
    expect(screen.queryByText('Added to the conversation draft. Nothing was sent yet.')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Text preview' })).toBeNull()
  })
  it('makes directional and hidden controls visible without modifying the consented attachment', async () => {
    const content =
      'Read this\u202E hidden\u2066text\u2069 \u061C \u200F \u200B \uFEFF <script>data</script>'
    const name = 'notes\u202E.txt'
    const file: ReadLocalFileResponse = {
      ...text,
      name,
      content,
      sizeBytes: new TextEncoder().encode(content).length,
      returnedBytes: new TextEncoder().encode(content).length
    }
    const service = makeService()
    service.choose.mockResolvedValue({ ...grant, name })
    service.read.mockResolvedValue(file)
    const { onAttach } = setup(service)
    const preview = await selectFile()
    expect(preview.textContent).toBe(
      'Read this[U+202E] hidden[U+2066]text[U+2069] [U+061C] [U+200F] [U+200B] [U+FEFF] <script>data</script>'
    )
    expect(preview.querySelector('script')).toBeNull()
    expect(screen.getByText(/Hidden formatting characters are shown as/)).toBeTruthy()
    expect(screen.getAllByText(/notes\[U\+202E\]\.txt/).length).toBeGreaterThan(0)
    expect(onAttach).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    click(attachLabel)
    expect(onAttach).toHaveBeenCalledExactlyOnceWith(file)
    expect(file.content).toBe(content)
    expect(file.name).toBe(name)
  })

  it('bounds the escaped visual preview and announces shortening without rewriting the original file', async () => {
    const content = '\u202E'.repeat(20_000)
    const file: ReadLocalFileResponse = {
      ...text,
      content,
      sizeBytes: 60_000,
      returnedBytes: 60_000
    }
    const service = makeService()
    service.read.mockResolvedValue(file)
    const { onAttach } = setup(service)
    const preview = await selectFile()
    expect(preview.textContent).toBe('[U+202E]'.repeat(8192))
    expect(screen.getByText(/The visual preview is shortened/)).toBeTruthy()
    expect(onAttach).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    click(attachLabel)
    expect(onAttach).toHaveBeenCalledExactlyOnceWith(file)
    expect(file.content).toHaveLength(20_000)
  })

  it('keeps escaped directory labels separate from the unchanged granted relative path', async () => {
    const service = makeService()
    const name = 'entry\u202E.txt'
    service.choose.mockResolvedValue(directory)
    service.list.mockResolvedValue({ entries: [{ name, kind: 'file' }], truncated: false })
    service.read.mockResolvedValue({ ...text, name, relativePath: name })
    setup(service)
    click('Choose directory')
    const entry = await screen.findByRole('button', { name: 'entry[U+202E].txt (file)' })
    fireEvent.click(entry)
    await screen.findByRole('region', { name: 'Text preview' })
    expect(service.read).toHaveBeenCalledExactlyOnceWith({
      scope,
      grantId: directory.id,
      relativePath: name,
      requestId: expect.any(String)
    })
  })

  it('lists only requested directories, browses and goes back using granted relative paths, and resets consent per read', async () => {
    const service = makeService()
    service.choose.mockResolvedValue(directory)
    service.list.mockImplementation(async ({ relativePath }) => ({
      entries: relativePath
        ? [{ name: 'notes.txt', kind: 'file' }]
        : [{ name: 'nested', kind: 'directory' }],
      truncated: !relativePath
    }))
    service.read.mockResolvedValue({ ...text, relativePath: 'nested/notes.txt' })
    const { onAttach } = setup(service)
    click('Choose directory')
    await screen.findByRole('button', { name: 'nested (directory)' })
    expect(service.list).toHaveBeenCalledExactlyOnceWith({
      scope,
      grantId: directory.id,
      relativePath: '',
      requestId: expect.any(String)
    })
    expect(screen.getByText(/This list is not recursive/)).toBeTruthy()
    expect(service.read).not.toHaveBeenCalled()
    click('nested (directory)')
    await screen.findByRole('button', { name: 'notes.txt (file)' })
    expect(service.list).toHaveBeenLastCalledWith({
      scope,
      grantId: directory.id,
      relativePath: 'nested',
      requestId: expect.any(String)
    })
    expect(service.list).toHaveBeenCalledTimes(2)
    click('notes.txt (file)')
    await screen.findByRole('region', { name: 'Text preview' })
    expect(service.read).toHaveBeenLastCalledWith({
      scope,
      grantId: directory.id,
      relativePath: 'nested/notes.txt',
      requestId: expect.any(String)
    })
    fireEvent.click(screen.getByRole('checkbox'))
    click('notes.txt (file)')
    await screen.findByRole('region', { name: 'Text preview' })
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(onAttach).not.toHaveBeenCalled()
    click('Back')
    await screen.findByRole('button', { name: 'nested (directory)' })
    expect(service.list).toHaveBeenLastCalledWith({
      scope,
      grantId: directory.id,
      relativePath: '',
      requestId: expect.any(String)
    })
    expect(screen.queryByRole('region', { name: 'Text preview' })).toBeNull()
  })

  it('revokes and clears a preview even while externally disabled', async () => {
    const { service, onAttach, rerender } = setup()
    await selectFile()
    fireEvent.click(screen.getByRole('checkbox'))
    rerender(<AgentLocalFilesPanel scope={scope} service={service} onAttach={onAttach} disabled />)
    click(attachLabel)
    expect(onAttach).not.toHaveBeenCalled()
    click('Revoke access')
    await waitFor(() => expect(service.revoke).toHaveBeenCalledWith({ scope, grantId: grant.id }))
    expect(screen.queryByRole('region', { name: 'Text preview' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it.each(['Cancel request', 'Revoke access'])(
    'cancels active reads and ignores late content via %s',
    async (action) => {
      const service = makeService()
      const pending = deferred<ReadLocalFileResponse>()
      service.read.mockReturnValue(pending.promise)
      const { onAttach } = setup(service)
      click('Choose file')
      await waitFor(() => expect(service.read).toHaveBeenCalledTimes(1))
      click(action)
      await waitFor(() =>
        expect(service.cancel).toHaveBeenCalledWith({
          scope,
          requestId: service.read.mock.calls[0][0].requestId
        })
      )
      expect(service.revoke).toHaveBeenCalledWith({ scope, grantId: grant.id })
      await act(async () => pending.resolve(text))
      expect(screen.queryByRole('region', { name: 'Text preview' })).toBeNull()
      expect(onAttach).not.toHaveBeenCalled()
    }
  )

  it('cancels a pending chooser and revokes its late grant without reading', async () => {
    const service = makeService()
    const pending = deferred<AgentLocalFileGrant | null>()
    service.choose.mockReturnValue(pending.promise)
    setup(service)
    click('Choose file')
    await waitFor(() => expect(service.choose).toHaveBeenCalledTimes(1))
    click('Cancel request')
    await act(async () => pending.resolve(grant))
    expect(service.cancel).toHaveBeenCalledWith({
      scope,
      requestId: service.choose.mock.calls[0][0].requestId
    })
    expect(service.revoke).toHaveBeenCalledWith({ scope, grantId: grant.id })
    expect(service.read).not.toHaveBeenCalled()
  })

  it('cancels on unmount and revokes grants returned by a late chooser', async () => {
    const service = makeService()
    const pending = deferred<AgentLocalFileGrant | null>()
    service.choose.mockReturnValue(pending.promise)
    const { unmount, onAttach } = setup(service)
    click('Choose file')
    await waitFor(() => expect(service.choose).toHaveBeenCalledTimes(1))
    unmount()
    expect(service.cancel).toHaveBeenCalledWith({
      scope,
      requestId: service.choose.mock.calls[0][0].requestId
    })
    expect(service.revoke).toHaveBeenCalledWith({ scope })
    await act(async () => pending.resolve(grant))
    expect(service.revoke).toHaveBeenLastCalledWith({ scope, grantId: grant.id })
    expect(service.read).not.toHaveBeenCalled()
    expect(onAttach).not.toHaveBeenCalled()
  })

  it('cancels an active directory listing on unmount and ignores its late result', async () => {
    const service = makeService()
    const pending = deferred<Awaited<ReturnType<AgentLocalFilesSvc['list']>>>()
    service.choose.mockResolvedValue(directory)
    service.list.mockReturnValue(pending.promise)
    const { unmount, onAttach } = setup(service)
    click('Choose directory')
    await waitFor(() => expect(service.list).toHaveBeenCalledTimes(1))
    unmount()
    expect(service.cancel).toHaveBeenCalledWith({
      scope,
      requestId: service.list.mock.calls[0][0].requestId
    })
    expect(service.revoke).toHaveBeenCalledWith({ scope })
    await act(async () =>
      pending.resolve({ entries: [{ name: 'late.txt', kind: 'file' }], truncated: false })
    )
    expect(screen.queryByText('late.txt (file)')).toBeNull()
    expect(onAttach).not.toHaveBeenCalled()
  })

  it('clears preview, suggested path, and consent across scopes even without a remount', async () => {
    const { service, rerender, onAttach } = setup()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'C:\\suggested\\notes.txt' } })
    await selectFile()
    fireEvent.click(screen.getByRole('checkbox'))
    const nextScope = { ...scope, sessionId: 'session-b' }
    rerender(<AgentLocalFilesPanel scope={nextScope} service={service} onAttach={onAttach} />)
    expect(service.revoke).toHaveBeenCalledWith({ scope })
    expect(screen.queryByRole('region', { name: 'Text preview' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
    await selectFile()
    expect(service.read.mock.lastCall?.[0].scope).toEqual(nextScope)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(onAttach).not.toHaveBeenCalled()
  })

  it('does not replace a new scope preview with a late read from the old scope', async () => {
    const service = makeService()
    const pending = deferred<ReadLocalFileResponse>()
    service.read
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ...text, content: 'New scope text' })
    const { rerender, onAttach } = setup(service)
    click('Choose file')
    await waitFor(() => expect(service.read).toHaveBeenCalledTimes(1))
    rerender(
      <AgentLocalFilesPanel
        scope={{ ...scope, paneId: 'pane-b' }}
        service={service}
        onAttach={onAttach}
      />
    )
    expect(service.cancel).toHaveBeenCalledWith({
      scope,
      requestId: service.read.mock.calls[0][0].requestId
    })
    await selectFile()
    await act(async () => pending.resolve(text))
    expect(screen.getByRole('region', { name: 'Text preview' }).textContent).toBe('New scope text')
    expect(onAttach).not.toHaveBeenCalled()
  })

  it('revokes a late chooser in its original scope after scope changes', async () => {
    const service = makeService()
    const pending = deferred<AgentLocalFileGrant | null>()
    service.choose.mockReturnValue(pending.promise)
    const { rerender, onAttach } = setup(service)
    click('Choose file')
    await waitFor(() => expect(service.choose).toHaveBeenCalledTimes(1))
    rerender(
      <AgentLocalFilesPanel
        scope={{ ...scope, projectId: 'project-b' }}
        service={service}
        onAttach={onAttach}
      />
    )
    await act(async () => pending.resolve(grant))
    expect(service.revoke).toHaveBeenCalledWith({ scope, grantId: grant.id })
    expect(service.read).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Text preview' })).toBeNull()
  })

  it('passes a typed path only to the native chooser, never as a read grant', async () => {
    const service = makeService()
    const pending = deferred<AgentLocalFileGrant | null>()
    service.choose.mockReturnValue(pending.promise)
    const { onAttach } = setup(service)
    const suggestedPath = 'C:\\suggested\\notes.txt'
    fireEvent.change(screen.getByRole('textbox'), { target: { value: suggestedPath } })
    expect(service.choose).not.toHaveBeenCalled()
    expect(service.read).not.toHaveBeenCalled()
    click('Choose file')
    await waitFor(() => expect(service.choose).toHaveBeenCalledTimes(1))
    expect(service.choose).toHaveBeenCalledExactlyOnceWith({
      scope,
      kind: 'file',
      suggestedPath,
      requestId: expect.any(String)
    })
    expect(service.read).not.toHaveBeenCalled()
    await act(async () => pending.resolve(grant))
    expect(service.read).toHaveBeenCalledExactlyOnceWith({
      scope,
      grantId: grant.id,
      relativePath: '',
      requestId: expect.any(String)
    })
    expect(onAttach).not.toHaveBeenCalled()
  })

  it.each(['available', 'missing', 'throws'])(
    'intercepts drop and uses native confirmation with a %s bridge',
    async (bridge) => {
      const service = makeService()
      const pending = deferred<AgentLocalFileGrant | null>()
      service.choose.mockReturnValue(pending.promise)
      const getPathForFile = vi.fn(() => {
        if (bridge === 'throws') throw new Error('private bridge detail')
        return 'C:\\suggested\\drop.txt'
      })
      const authorizeLocalMediaFile = vi.fn()
      setBridge(bridge === 'missing' ? undefined : { getPathForFile, authorizeLocalMediaFile })
      const legacyDrop = vi.fn()
      const legacyDrag = vi.fn()
      const onAttach = vi.fn()
      render(
        <div onDrop={legacyDrop} onDragOver={legacyDrag}>
          <AgentLocalFilesPanel scope={scope} service={service} onAttach={onAttach} />
        </div>
      )
      const file = new File(['never read in renderer'], 'drop.txt', { type: 'text/plain' })
      const rawText = vi.fn()
      Object.defineProperty(file, 'text', { value: rawText })
      Object.defineProperty(file, 'path', { value: 'C:\\untrusted\\raw-path.txt' })
      const target = screen.getByRole('textbox')
      const drag = createEvent.dragOver(target, { dataTransfer: { files: [file] } })
      const drop = createEvent.drop(target, { dataTransfer: { files: [file] } })
      fireEvent(target, drag)
      fireEvent(target, drop)
      await waitFor(() => expect(service.choose).toHaveBeenCalledTimes(1))
      expect(drag.defaultPrevented).toBe(true)
      expect(drop.defaultPrevented).toBe(true)
      expect(legacyDrag).not.toHaveBeenCalled()
      expect(legacyDrop).not.toHaveBeenCalled()
      expect(service.choose).toHaveBeenCalledExactlyOnceWith({
        scope,
        kind: 'file',
        requestId: expect.any(String),
        ...(bridge === 'available' ? { suggestedPath: 'C:\\suggested\\drop.txt' } : {})
      })
      if (bridge !== 'missing') expect(getPathForFile).toHaveBeenCalledWith(file)
      expect(authorizeLocalMediaFile).not.toHaveBeenCalled()
      expect(rawText).not.toHaveBeenCalled()
      expect(service.read).not.toHaveBeenCalled()
      await act(async () => pending.resolve(null))
      expect(service.read).not.toHaveBeenCalled()
      expect(onAttach).not.toHaveBeenCalled()
    }
  )

  it('blocks click and drop while disabled but still swallows the legacy drop', () => {
    const service = makeService()
    const legacyDrop = vi.fn()
    const onAttach = vi.fn()
    render(
      <div onDrop={legacyDrop}>
        <AgentLocalFilesPanel scope={scope} service={service} onAttach={onAttach} disabled />
      </div>
    )
    click('Choose file')
    click('Choose directory')
    const target = screen.getByRole('region', { name: 'Local files' })
    const drop = createEvent.drop(target, {
      dataTransfer: { files: [new File(['test'], 'test.txt')] }
    })
    fireEvent(target, drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(legacyDrop).not.toHaveBeenCalled()
    expect(service.choose).not.toHaveBeenCalled()
    expect(service.read).not.toHaveBeenCalled()
    expect(onAttach).not.toHaveBeenCalled()
  })

  it.each(Object.entries(AGENT_LOCAL_FILE_ERRORS))(
    'displays only the fixed public message for %s',
    async (code, message) => {
      const service = makeService()
      service.read.mockRejectedValue({ code, message: 'C:\\fixture-data\\secret.txt: raw failure' })
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { onAttach } = setup(service)
      click('Choose file')
      expect((await screen.findByRole('alert')).textContent).toBe(message)
      expect(screen.queryByRole('region', { name: 'Text preview' })).toBeNull()
      expect(document.body.textContent).not.toContain('secret.txt')
      expect(errorLog).not.toHaveBeenCalled()
      expect(warnLog).not.toHaveBeenCalled()
      expect(onAttach).not.toHaveBeenCalled()
    }
  )

  it.each([
    'AgentLocalFileError: ',
    "Error invoking remote method 'svcAgentLocalFiles.read': AgentLocalFileError: "
  ])(
    'recognizes the Electron serialized error prefix %s without displaying raw messages',
    async (prefix) => {
      const service = makeService()
      service.read.mockRejectedValue(new Error(prefix + AGENT_LOCAL_FILE_ERRORS.TEXT_TOO_LARGE))
      setup(service)
      click('Choose file')
      expect((await screen.findByRole('alert')).textContent).toBe(
        AGENT_LOCAL_FILE_ERRORS.TEXT_TOO_LARGE
      )
      expect(screen.queryByRole('region', { name: 'Text preview' })).toBeNull()
    }
  )

  it('does not display an Electron-prefixed message containing raw path suffixes', async () => {
    const service = makeService()
    service.read.mockRejectedValue(
      new Error('AgentLocalFileError: ' + AGENT_LOCAL_FILE_ERRORS.NOT_FOUND + ' C:/secret.txt')
    )
    setup(service)
    click('Choose file')
    expect((await screen.findByRole('alert')).textContent).toBe(AGENT_LOCAL_FILE_ERRORS.IO_ERROR)
    expect(document.body.textContent).not.toContain('secret.txt')
  })

  it('waits for scope activation before opening the native chooser', async () => {
    const service = makeService()
    const activation = deferred<void>()
    service.setScope.mockReturnValueOnce(activation.promise)
    setup(service)

    click('Choose file')
    await act(async () => {})
    expect(service.choose).not.toHaveBeenCalled()

    await act(async () => activation.resolve())
    const chooseButton = screen.getByRole('button', { name: 'Choose file' })
    await waitFor(() => expect(chooseButton).toBeEnabled())
    fireEvent.click(chooseButton)
    await waitFor(() => expect(service.choose).toHaveBeenCalledTimes(1))
    expect(service.read).toHaveBeenCalledTimes(1)
  })

  it('surfaces activation failures and blocks chooser/read actions until the active scope is authorized', async () => {
    const service = makeService()
    service.setScope.mockRejectedValueOnce({ code: 'GRANT_DENIED', message: 'raw private detail' })
    setup(service)

    expect((await screen.findByRole('alert')).textContent).toBe(
      AGENT_LOCAL_FILE_ERRORS.GRANT_DENIED
    )
    click('Choose file')
    expect(service.choose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Choose file' })).toBeDisabled()
    expect(document.body.textContent).not.toContain('private detail')
  })

  it('uses a fixed fallback for unknown chooser errors and supports a dismissed chooser', async () => {
    const service = makeService()
    service.choose.mockRejectedValueOnce(new Error('raw secret')).mockResolvedValueOnce(null)
    setup(service)
    click('Choose file')
    expect((await screen.findByRole('alert')).textContent).toBe(AGENT_LOCAL_FILE_ERRORS.IO_ERROR)
    click('Choose file')
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Choose file' }) as HTMLButtonElement).disabled
      ).toBe(false)
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(service.read).not.toHaveBeenCalled()
    expect(service.list).not.toHaveBeenCalled()
  })

  it('clears content and reports only public errors when revocation fails', async () => {
    const { service } = setup()
    await selectFile()
    service.revoke.mockRejectedValue({ code: 'PATH_DENIED', message: 'raw secret' })
    click('Revoke access')
    expect((await screen.findByRole('alert')).textContent).toBe(AGENT_LOCAL_FILE_ERRORS.PATH_DENIED)
    expect(screen.queryByRole('region', { name: 'Text preview' })).toBeNull()
  })

  it('handles listing failures without reading or attaching', async () => {
    const service = makeService()
    service.choose.mockResolvedValue(directory)
    service.list.mockRejectedValue({ code: 'NOT_FOUND', message: 'raw secret' })
    const { onAttach } = setup(service)
    click('Choose directory')
    expect((await screen.findByRole('alert')).textContent).toBe(AGENT_LOCAL_FILE_ERRORS.NOT_FOUND)
    expect(service.read).not.toHaveBeenCalled()
    expect(onAttach).not.toHaveBeenCalled()
  })
})
