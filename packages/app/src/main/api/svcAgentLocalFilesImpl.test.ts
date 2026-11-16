import * as path from 'node:path'
import type { BrowserWindow, OpenDialogReturnValue } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { ServiceValidationError } from '@shared/api/apiUtils/serviceValidation'
import {
  AGENT_LOCAL_FILE_ERRORS,
  AGENT_LOCAL_FILE_LIMITS,
  AgentLocalFileError,
  type AgentLocalFileGrant,
  type AgentLocalFilesSvc,
  type ChooseLocalFileRequest
} from '@shared/api/svcAgentLocalFiles'
import { LocalFileReadGrants } from '../agentLocalFiles/readGrants'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding,
  unregisterMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { AgentLocalFilesSvcImpl } from './svcAgentLocalFilesImpl'

const { showOpenDialog } = vi.hoisted(() => ({ showOpenDialog: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showOpenDialog } }))

const senderId = 42
const baseUrl = 'file:///app/index.html'
const scope = { projectId: 'project-1', paneId: 'pane-1', sessionId: 'session-1' }
const chooseRequest: ChooseLocalFileRequest = { scope, kind: 'file', requestId: 'choose-1' }
const grant: AgentLocalFileGrant = {
  id: 'a'.repeat(32),
  name: 'selected.txt',
  kind: 'file',
  expiresAt: 2_000_000_000_000,
  readOnly: true
}
const readRequest = { scope, grantId: grant.id, requestId: 'read-1', relativePath: 'notes.txt' }
const readResponse = {
  name: 'notes.txt',
  relativePath: 'notes.txt',
  content: 'hello',
  encoding: 'utf-8' as const,
  sizeBytes: 5,
  returnedBytes: 5,
  truncated: false as const
}
const listResponse = { entries: [{ name: 'notes.txt', kind: 'file' as const }], truncated: false }
const localPath = (name: string): string => path.resolve(path.parse(process.cwd()).root, name)
const selectedPath = localPath('selected.txt')
const selection = { canceled: false, filePaths: [selectedPath] }
const requests = {
  setScope: { scope, active: true },
  choose: chooseRequest,
  read: readRequest,
  list: readRequest,
  revoke: { scope },
  cancel: { scope, requestId: 'choose-1' }
}
const methods = Object.keys(requests) as (keyof AgentLocalFilesSvc)[]

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture() {
  const webContents = {
    id: senderId,
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => `${baseUrl}#/canvas?id=${scope.projectId}`)
  }
  const parent = { isDestroyed: vi.fn(() => false), webContents }
  const getMainWindow = vi.fn<() => BrowserWindow | null>(() => parent as unknown as BrowserWindow)
  registerMagicAgentTrustedRouteBinding(senderId, undefined, {
    trustedUrl: baseUrl,
    trustedWebContents: webContents
  })
  const grants = new LocalFileReadGrants()
  const authorize = vi.spyOn(grants, 'authorize').mockResolvedValue(grant)
  const delivery = vi.spyOn(grants, 'assertDeliveryAuthorized').mockImplementation(() => {})
  const read = vi.spyOn(grants, 'read').mockResolvedValue(readResponse)
  const list = vi.spyOn(grants, 'list').mockResolvedValue(listResponse)
  const revoke = vi.spyOn(grants, 'revoke').mockImplementation(() => {})
  const cancel = vi.spyOn(grants, 'cancel').mockImplementation(() => {})
  const service = new AgentLocalFilesSvcImpl(grants, getMainWindow)
  const context = (
    method: keyof AgentLocalFilesSvc,
    overrides: Partial<ServiceInvocationContext> = {}
  ): ServiceInvocationContext => ({
    methodName: `svcAgentLocalFiles.${method}`,
    senderId,
    senderUrl: webContents.getURL(),
    frameUrl: webContents.getURL(),
    isMainFrame: true,
    ...overrides
  })
  const invoke = (method: keyof AgentLocalFilesSvc, invocation?: ServiceInvocationContext) => {
    switch (method) {
      case 'setScope':
        return service.setScope(requests.setScope, invocation)
      case 'choose':
        return service.choose(requests.choose, invocation)
      case 'read':
        return service.read(requests.read, invocation)
      case 'list':
        return service.list(requests.list, invocation)
      case 'revoke':
        return service.revoke(requests.revoke, invocation)
      case 'cancel':
        return service.cancel(requests.cancel, invocation)
    }
  }
  // The real ChatPage announces its active scope before enabling local file access.
  void service.setScope({ scope, active: true }, context('setScope'))
  return {
    service,
    grants,
    authorize,
    read,
    delivery,
    list,
    revoke,
    cancel,
    parent,
    webContents,
    getMainWindow,
    context,
    invoke
  }
}

beforeEach(() => {
  clearMagicAgentTrustedRouteBindingsForTest()
  showOpenDialog.mockReset().mockResolvedValue(selection)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
})

describe('AgentLocalFilesSvcImpl authorization', () => {
  it.each(methods)(
    '%s requires context, exact method and a registered trusted main frame',
    async (method) => {
      const f = fixture()
      await expect(f.invoke(method)).rejects.toMatchObject({ code: 'GRANT_DENIED' })
      for (const override of [
        { methodName: 'svcOther.choose' },
        { methodName: `svcAgentLocalFiles.${method === 'choose' ? 'read' : 'choose'}` },
        { senderId: undefined },
        { senderId: 99 },
        { isMainFrame: false },
        { isMainFrame: undefined },
        { frameUrl: undefined },
        { frameUrl: 'https://untrusted.invalid/#/canvas?id=project-1' },
        { frameUrl: 'file:///other/index.html#/canvas?id=project-1' },
        { senderUrl: 'https://untrusted.invalid/' }
      ]) {
        await expect(f.invoke(method, f.context(method, override))).rejects.toMatchObject({
          code: 'GRANT_DENIED',
          message: AGENT_LOCAL_FILE_ERRORS.GRANT_DENIED,
          cause: undefined
        })
      }
      unregisterMagicAgentTrustedRouteBinding(senderId)
      await expect(f.invoke(method, f.context(method))).rejects.toMatchObject({
        code: 'GRANT_DENIED'
      })
      expect(showOpenDialog).not.toHaveBeenCalled()
      for (const spy of [f.authorize, f.read, f.list, f.revoke, f.cancel]) {
        expect(spy).not.toHaveBeenCalled()
      }
    }
  )

  it.each(methods)('%s rejects a missing, foreign or destroyed main window', async (method) => {
    const f = fixture()
    const context = f.context(method)
    f.getMainWindow.mockReturnValue(null)
    await expect(f.invoke(method, context)).rejects.toMatchObject({ code: 'GRANT_DENIED' })
    f.getMainWindow.mockReturnValue(f.parent as unknown as BrowserWindow)
    f.parent.isDestroyed.mockReturnValue(true)
    await expect(f.invoke(method, context)).rejects.toMatchObject({ code: 'GRANT_DENIED' })
    f.parent.isDestroyed.mockReturnValue(false)
    f.webContents.isDestroyed.mockReturnValue(true)
    await expect(f.invoke(method, context)).rejects.toMatchObject({ code: 'GRANT_DENIED' })
    f.webContents.isDestroyed.mockReturnValue(false)
    f.getMainWindow.mockReturnValue({
      ...f.parent,
      webContents: { ...f.webContents, id: 99 }
    } as unknown as BrowserWindow)
    await expect(f.invoke(method, context)).rejects.toMatchObject({ code: 'GRANT_DENIED' })
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('rejects a pending read after an active session transition and ignores a stale inactive announcement', async () => {
    const f = fixture()
    const delayed = deferred<typeof readResponse>()
    f.read.mockReturnValue(delayed.promise)
    const pending = f.service.read(readRequest, f.context('read'))
    const next = { ...scope, sessionId: 'session-2' }
    await f.service.setScope({ scope: next, active: true }, f.context('setScope'))
    await f.service.setScope({ scope, active: false }, f.context('setScope'))
    delayed.resolve(readResponse)
    await expect(pending).rejects.toMatchObject({ code: 'SCOPE_CHANGED' })
    f.read.mockResolvedValue(readResponse)
    await expect(
      f.service.read({ ...readRequest, scope: next }, f.context('read'))
    ).resolves.toEqual(readResponse)
  })

  it('ignores a stale inactive lifecycle revision after a newer scope activation', async () => {
    const f = fixture()
    const next = { ...scope, sessionId: 'session-2' }
    await f.service.setScope({ scope, active: true, revision: 1 }, f.context('setScope'))
    await f.service.setScope({ scope: next, active: true, revision: 2 }, f.context('setScope'))
    await f.service.setScope({ scope, active: false, revision: 1 }, f.context('setScope'))

    f.read.mockResolvedValue(readResponse)
    await expect(
      f.service.read({ ...readRequest, scope: next }, f.context('read'))
    ).resolves.toEqual(readResponse)
  })
  it('checks a live grant again at completion so a revoked result cannot be delivered', async () => {
    const f = fixture()
    f.delivery.mockImplementation(() => {
      throw new AgentLocalFileError('GRANT_DENIED')
    })
    await expect(f.service.read(readRequest, f.context('read'))).rejects.toMatchObject({
      code: 'GRANT_DENIED'
    })
    expect(f.delivery).toHaveBeenCalledWith(senderId, scope, grant.id)
  })

  it('denies unannounced pane scopes before the chooser and clears authorization when inactive', async () => {
    const f = fixture()
    await expect(
      f.service.choose(
        { ...chooseRequest, scope: { ...scope, paneId: 'other' } },
        f.context('choose')
      )
    ).rejects.toMatchObject({ code: 'SCOPE_CHANGED' })
    expect(showOpenDialog).not.toHaveBeenCalled()
    await f.service.setScope({ scope, active: false }, f.context('setScope'))
    await expect(f.service.read(readRequest, f.context('read'))).rejects.toMatchObject({
      code: 'SCOPE_CHANGED'
    })
  })

  it('fails closed with the default constructor', async () => {
    const f = fixture()
    await expect(
      new AgentLocalFilesSvcImpl().choose(chooseRequest, f.context('choose'))
    ).rejects.toMatchObject({ code: 'GRANT_DENIED' })
  })

  it.each(['choose', 'read', 'list'] as const)(
    '%s uses the actual URL, not the invocation route',
    async (method) => {
      const f = fixture()
      const context = f.context(method)
      for (const url of [
        `${baseUrl}#/canvas?id=other-project`,
        `${baseUrl}#/canvas?projectId=project-1`,
        `${baseUrl}#/canvas?id=project-1&id=other-project`,
        `${baseUrl}#/canvas/child?id=project-1`,
        `${baseUrl}#/workshop?id=project-1`,
        `${baseUrl}?id=project-1#/canvas`,
        `${baseUrl}#/project-webgl?id=other-project`,
        'https://untrusted.invalid/#/canvas?id=project-1'
      ]) {
        f.webContents.getURL.mockReturnValue(url)
        await expect(f.invoke(method, context)).rejects.toMatchObject({ code: 'GRANT_DENIED' })
      }
      expect(showOpenDialog).not.toHaveBeenCalled()
      expect(f.read).not.toHaveBeenCalled()
      expect(f.list).not.toHaveBeenCalled()
    }
  )

  it.each(['/canvas', '/project-webgl'])('accepts the same project on %s', async (route) => {
    const f = fixture()
    f.webContents.getURL.mockReturnValue(`${baseUrl}#${route}?id=project-1&pane=pane-1`)
    await expect(f.service.choose(chooseRequest, f.context('choose'))).resolves.toEqual(grant)
    await expect(f.service.read(readRequest, f.context('read'))).resolves.toEqual(readResponse)
    await expect(f.service.list(readRequest, f.context('list'))).resolves.toEqual(listResponse)
  })

  it('delegates sender and the full scope, but never invocation/request authority fields', async () => {
    const f = fixture()
    await f.service.read(readRequest, f.context('read'))
    await f.service.list(readRequest, f.context('list'))
    const { scope: requestScope, ...params } = readRequest
    expect(f.read).toHaveBeenCalledWith(senderId, requestScope, params)
    expect(f.list).toHaveBeenCalledWith(senderId, requestScope, params)
    for (const invalid of [
      { ...chooseRequest, route: { projectId: 'project-1' } },
      { ...chooseRequest, grantId: grant.id },
      { ...chooseRequest, selectedPath },
      { ...chooseRequest, senderId: 99 }
    ]) {
      await expect(f.service.choose(invalid, f.context('choose'))).rejects.toMatchObject({
        code: 'VALIDATION_ERROR'
      })
    }
    await expect(
      f.service.choose(
        { ...chooseRequest, scope: { ...scope, projectId: 'foreign' } },
        f.context('choose')
      )
    ).rejects.toMatchObject({ code: 'GRANT_DENIED' })
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('leaves arbitrary, foreign-scope and revoked capabilities denied by the grant store', async () => {
    const f = fixture()
    // Exercise the real store's ownership check with a synthetic, memory-only capability.
    f.read.mockRestore()
    f.list.mockRestore()
    f.revoke.mockRestore()
    const stored = {
      public: { ...grant, kind: 'directory', expiresAt: Date.now() + 60_000 },
      senderId,
      scopeKey: JSON.stringify([scope.projectId, scope.paneId, scope.sessionId])
    }
    const internal = f.grants as unknown as { grants: Map<string, unknown> }
    internal.grants.set(grant.id, stored)
    for (const method of ['read', 'list'] as const) {
      for (const foreign of [
        { ...scope, paneId: 'other-pane' },
        { ...scope, sessionId: 'other-session' }
      ]) {
        await expect(
          f.service[method]({ ...readRequest, scope: foreign }, f.context(method))
        ).rejects.toMatchObject({ code: 'SCOPE_CHANGED' })
      }
      await expect(
        f.service[method]({ ...readRequest, grantId: 'b'.repeat(32) }, f.context(method))
      ).rejects.toMatchObject({ code: 'GRANT_DENIED' })
    }
    await expect(
      f.service.revoke(
        { scope: { ...scope, sessionId: 'other' }, grantId: grant.id },
        f.context('revoke')
      )
    ).rejects.toMatchObject({ code: 'GRANT_DENIED' })
    expect(internal.grants.has(grant.id)).toBe(true)
    await f.service.revoke({ scope, grantId: grant.id }, f.context('revoke'))
    expect(internal.grants.size).toBe(0)
    await expect(f.service.read(readRequest, f.context('read'))).rejects.toMatchObject({
      code: 'GRANT_DENIED'
    })
  })
})

describe('AgentLocalFilesSvcImpl native chooser', () => {
  it.each(['file', 'directory'] as const)(
    'chooses only one native %s result with scoped read-only consent',
    async (kind) => {
      const f = fixture()
      f.authorize.mockResolvedValue({ ...grant, kind })
      const suggestedPath = localPath('suggested.txt')
      const native = deferred<OpenDialogReturnValue>()
      showOpenDialog.mockReturnValue(native.promise)
      const pending = f.service.choose(
        { ...chooseRequest, kind, suggestedPath },
        f.context('choose')
      )
      expect(f.authorize).not.toHaveBeenCalled()
      expect(showOpenDialog).toHaveBeenCalledExactlyOnceWith(f.parent, {
        title: `Read-only local ${kind} access — project project-1, pane pane-1, session session-1`,
        properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
        buttonLabel: 'Allow read-only access'
      })
      native.resolve(selection)
      await expect(pending).resolves.toEqual({ ...grant, kind })
      expect(f.authorize).toHaveBeenCalledExactlyOnceWith(senderId, scope, selectedPath, kind)
    }
  )

  it('does not automatically browse mapped drives or local junctions from renderer paths', async () => {
    const f = fixture()
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const suggestedPath =
      process.platform === 'win32' ? 'Z:\\network-junction\\notes.txt' : '/mnt/network/notes.txt'
    expect(
      await f.service.choose({ ...chooseRequest, suggestedPath }, f.context('choose'))
    ).toBeNull()
    expect(showOpenDialog.mock.calls[0][1]).not.toHaveProperty('defaultPath')
    expect(JSON.stringify(showOpenDialog.mock.calls[0][1])).not.toContain(suggestedPath)
    expect(f.authorize).not.toHaveBeenCalled()
  })

  it('omits defaultPath and returns null for native cancellation without granting', async () => {
    const f = fixture()
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [selectedPath] })
    await expect(f.service.choose(chooseRequest, f.context('choose'))).resolves.toBeNull()
    expect(showOpenDialog.mock.calls[0][1]).not.toHaveProperty('defaultPath')
    expect(f.authorize).not.toHaveBeenCalled()
  })

  it.each([
    'relative.txt',
    'C:relative.txt',
    '/root-relative-on-windows.txt',
    '\\root-relative.txt',
    '\\\\server\\share\\file.txt',
    '//server/share/file.txt',
    '\\\\?\\C:\\file.txt',
    '\\\\.\\pipe\\name',
    'file:///C:/file.txt',
    'https://server/file.txt',
    'smb://server/share/file.txt',
    'C:\\NUL',
    'C:\\folder\\file.txt:stream',
    'C:\\fixture-data\u0000file.txt'
  ])('denies unsafe suggested path %j before opening the dialog', async (suggestedPath) => {
    if (process.platform !== 'win32' && suggestedPath === '/root-relative-on-windows.txt') return
    const f = fixture()
    await expect(
      f.service.choose({ ...chooseRequest, suggestedPath }, f.context('choose'))
    ).rejects.toMatchObject({
      code: suggestedPath.includes('\u0000') ? 'VALIDATION_ERROR' : 'PATH_DENIED'
    })
    expect(showOpenDialog).not.toHaveBeenCalled()
    expect(f.authorize).not.toHaveBeenCalled()
  })

  it.each([
    { filePaths: [] },
    { filePaths: [selectedPath, localPath('second.txt')] },
    { filePaths: [''] }
  ])('rejects a missing or ambiguous native selection $filePaths', async ({ filePaths }) => {
    const f = fixture()
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths })
    await expect(f.service.choose(chooseRequest, f.context('choose'))).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
    expect(f.authorize).not.toHaveBeenCalled()
  })

  it('allows only one pending chooser per sender, even across scopes and cancellation', async () => {
    const f = fixture()
    const native = deferred<OpenDialogReturnValue>()
    showOpenDialog.mockReturnValueOnce(native.promise)
    const first = f.service.choose(chooseRequest, f.context('choose'))
    const cancelled = expect(first).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(
      f.service.choose(
        { ...chooseRequest, scope: { ...scope, paneId: 'pane-2' }, requestId: 'choose-2' },
        f.context('choose')
      )
    ).rejects.toMatchObject({ code: 'SCOPE_CHANGED' })
    await f.service.cancel(requests.cancel, f.context('cancel'))
    await expect(f.service.choose(chooseRequest, f.context('choose'))).rejects.toMatchObject({
      code: 'BUSY'
    })
    native.resolve(selection)
    await cancelled
    expect(f.authorize).not.toHaveBeenCalled()
    await expect(f.service.choose(chooseRequest, f.context('choose'))).resolves.toEqual(grant)
  })

  it.each(['cancel', 'revoke'] as const)(
    '%s after route navigation blocks a pending native result',
    async (method) => {
      const f = fixture()
      const native = deferred<OpenDialogReturnValue>()
      showOpenDialog.mockReturnValue(native.promise)
      const pending = f.service.choose(chooseRequest, f.context('choose'))
      const denied = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
      f.webContents.getURL.mockReturnValue(`${baseUrl}#/workshop`)
      await f.invoke(method, f.context(method))
      expect(f[method]).toHaveBeenCalledWith(
        senderId,
        scope,
        method === 'cancel' ? { requestId: 'choose-1' } : {}
      )
      native.resolve(selection)
      await denied
      expect(f.authorize).not.toHaveBeenCalled()
    }
  )

  it('does not cancel another scope or request', async () => {
    const f = fixture()
    const native = deferred<OpenDialogReturnValue>()
    showOpenDialog.mockReturnValue(native.promise)
    const pending = f.service.choose(chooseRequest, f.context('choose'))
    await f.service.cancel({ scope, requestId: 'different' }, f.context('cancel'))
    await f.service.cancel(
      { scope: { ...scope, sessionId: 'other' }, requestId: 'choose-1' },
      f.context('cancel')
    )
    await f.service.revoke({ scope: { ...scope, paneId: 'other' } }, f.context('revoke'))
    native.resolve(selection)
    await expect(pending).resolves.toEqual(grant)
  })

  it.each(['route', 'window', 'contents', 'unregistered'] as const)(
    'rechecks %s after native selection',
    async (change) => {
      const f = fixture()
      const native = deferred<OpenDialogReturnValue>()
      showOpenDialog.mockReturnValue(native.promise)
      const pending = f.service.choose(chooseRequest, f.context('choose'))
      if (change === 'route') f.webContents.getURL.mockReturnValue(`${baseUrl}#/canvas?id=foreign`)
      if (change === 'window') f.parent.isDestroyed.mockReturnValue(true)
      if (change === 'contents') f.webContents.isDestroyed.mockReturnValue(true)
      if (change === 'unregistered') unregisterMagicAgentTrustedRouteBinding(senderId)
      native.resolve(selection)
      await expect(pending).rejects.toMatchObject({ code: 'GRANT_DENIED' })
      expect(f.authorize).not.toHaveBeenCalled()
    }
  )

  it.each(['cancel', 'revoke', 'route', 'unregistered'] as const)(
    'revokes a late grant after %s during authorization',
    async (change) => {
      const f = fixture()
      const late = deferred<AgentLocalFileGrant>()
      const started = deferred<void>()
      f.authorize.mockImplementation(() => {
        started.resolve()
        return late.promise
      })
      const pending = f.service.choose(chooseRequest, f.context('choose'))
      await started.promise
      if (change === 'cancel' || change === 'revoke') await f.invoke(change, f.context(change))
      if (change === 'route') f.webContents.getURL.mockReturnValue(`${baseUrl}#/canvas?id=foreign`)
      if (change === 'unregistered') unregisterMagicAgentTrustedRouteBinding(senderId)
      late.resolve(grant)
      await expect(pending).rejects.toMatchObject({
        code: change === 'cancel' || change === 'revoke' ? 'CANCELLED' : 'GRANT_DENIED'
      })
      expect(f.revoke).toHaveBeenLastCalledWith(senderId, scope, { grantId: grant.id })
    }
  )

  it('expires native ownership at 30 minutes, frees the sender and ignores a late selection', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const native = deferred<OpenDialogReturnValue>()
    showOpenDialog.mockReturnValueOnce(native.promise)
    const pending = f.service.choose(chooseRequest, f.context('choose'))
    const timedOut = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(AGENT_LOCAL_FILE_LIMITS.ttlMs)
    await timedOut
    expect(vi.getTimerCount()).toBe(0)
    await expect(f.service.choose(chooseRequest, f.context('choose'))).resolves.toEqual(grant)
    native.resolve(selection)
    await Promise.resolve()
    expect(f.authorize).toHaveBeenCalledTimes(1)
  })

  it('revokes an authorization that finishes after the 30-minute deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const late = deferred<AgentLocalFileGrant>()
    const started = deferred<void>()
    f.authorize.mockImplementation(() => {
      started.resolve()
      return late.promise
    })
    const pending = f.service.choose(chooseRequest, f.context('choose'))
    const timedOut = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await started.promise
    await vi.advanceTimersByTimeAsync(AGENT_LOCAL_FILE_LIMITS.ttlMs)
    await timedOut
    late.resolve(grant)
    await Promise.resolve()
    expect(f.revoke).toHaveBeenCalledWith(senderId, scope, { grantId: grant.id })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('AgentLocalFilesSvcImpl safe boundaries', () => {
  it.each(['read', 'list'] as const)(
    'withholds %s data if the project changes during I/O',
    async (method) => {
      const f = fixture()
      const started = deferred<void>()
      const done = deferred<void>()
      if (method === 'read') {
        f.read.mockImplementation(async () => {
          started.resolve()
          await done.promise
          return readResponse
        })
      } else {
        f.list.mockImplementation(async () => {
          started.resolve()
          await done.promise
          return listResponse
        })
      }
      const pending = f.invoke(method, f.context(method))
      await started.promise
      f.webContents.getURL.mockReturnValue(`${baseUrl}#/canvas?id=foreign`)
      done.resolve()
      await expect(pending).rejects.toMatchObject({ code: 'GRANT_DENIED' })
    }
  )

  it.each(methods)('%s exposes fixed errors without raw messages or logging', async (method) => {
    const f = fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = new Error('private-path credential-secret')
    if (method === 'choose') showOpenDialog.mockRejectedValue(raw)
    else if (method === 'setScope') {
      vi.spyOn(f.grants, 'revokeSender').mockImplementation(() => {
        throw raw
      })
      await f.service.setScope({ scope, active: false }, f.context('setScope')).catch(() => {})
    } else {
      f[method].mockImplementation(() => {
        throw raw
      })
    }
    const error = await f.invoke(method, f.context(method)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'IO_ERROR',
      message: AGENT_LOCAL_FILE_ERRORS.IO_ERROR,
      cause: undefined,
      payload: undefined
    })
    expect(JSON.stringify(error)).not.toContain('private-path')
    expect(JSON.stringify(error)).not.toContain('credential-secret')
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('scrubs validation details and preserves only fixed public grant error codes', async () => {
    const f = fixture()
    const invalid = { ...chooseRequest, suggestedPath: 'secret\u0000path' }
    const error = await f.service
      .choose(invalid, f.context('choose'))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ServiceValidationError)
    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      cause: undefined,
      issues: [{ message: 'Failed validation', path: [] }]
    })
    expect(JSON.stringify(error)).not.toContain('secret')
    expect(showOpenDialog).not.toHaveBeenCalled()
    const denied = new AgentLocalFileError('PATH_DENIED')
    denied.message = 'private-path credential-secret'
    f.authorize.mockRejectedValue(denied)
    await expect(f.service.choose(chooseRequest, f.context('choose'))).rejects.toMatchObject({
      code: 'PATH_DENIED',
      message: AGENT_LOCAL_FILE_ERRORS.PATH_DENIED,
      cause: undefined
    })
    f.authorize.mockResolvedValue(grant)
    await expect(f.service.choose(chooseRequest, f.context('choose'))).resolves.toEqual(grant)
  })
})
