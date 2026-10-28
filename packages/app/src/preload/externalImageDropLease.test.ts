import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  createExternalImageDropAuthorization,
  EXTERNAL_IMAGE_DROP_LEASE_MS
} from './externalImageDropLease'

const prefix =
  process.platform === 'win32' ? 'file:///C:/Synthetic%20Lark/' : 'file:///tmp/Synthetic%20Lark/'
const first = `${prefix}first.png`
const second = `${prefix}second.jpg`

function harness(
  authorizePath = vi.fn<(filePath: string) => Promise<boolean>>().mockResolvedValue(true)
) {
  const listeners = new Map<string, EventListener>()
  const addEventListener = vi.fn((name: string, listener: EventListener, _capture: boolean) =>
    listeners.set(name, listener)
  )
  const removeEventListener = vi.fn((name: string, listener: EventListener, _capture: boolean) => {
    if (listeners.get(name) === listener) listeners.delete(name)
  })
  let time = 10_000
  const authorization = createExternalImageDropAuthorization({
    target: { addEventListener, removeEventListener } as unknown as Window,
    authorizePath,
    now: () => time
  })
  const emit = (name: string, event: unknown = {}) => listeners.get(name)?.(event as Event)
  const drop = (data: Record<string, string>, isTrusted = true) =>
    emit('drop', {
      isTrusted,
      dataTransfer: { getData: (name: string) => data[name] || '' }
    })
  return {
    ...authorization,
    authorizePath,
    addEventListener,
    removeEventListener,
    emit,
    drop,
    advance: (milliseconds: number) => {
      time += milliseconds
    }
  }
}

const deferred = () => {
  let resolve!: (value: boolean) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('private trusted external-image drop leases', () => {
  it('registers a capture listener but never reads or grants a path just from capture', () => {
    const subject = harness()
    expect(subject.addEventListener).toHaveBeenCalledWith('drop', expect.any(Function), true)
    subject.drop({ 'text/plain': first })
    expect(subject.authorizePath).not.toHaveBeenCalled()
    expect(Object.keys(subject).filter((name) => name.includes('trust'))).toEqual([])
  })

  it('cannot create a grant from arbitrary renderer strings, objects, or event-like flags', async () => {
    const subject = harness()
    for (const input of [
      first,
      fileURLToPath(first),
      undefined,
      null,
      { url: first, isTrusted: true }
    ]) {
      await expect(subject.authorizeDroppedLocalImage(input)).resolves.toBe('')
    }
    subject.drop({ 'text/plain': first }, false)
    await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe('')
    expect(subject.authorizePath).not.toHaveBeenCalled()
  })

  it('only grants canonical URLs in the current trusted drop', async () => {
    const subject = harness()
    subject.drop({ 'text/plain': first.replace('%20', ' ') })
    await expect(subject.authorizeDroppedLocalImage(first.replace('%20', ' '))).resolves.toBe('')
    await expect(subject.authorizeDroppedLocalImage(second)).resolves.toBe('')
    await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe(fileURLToPath(first))
    expect(subject.authorizePath).toHaveBeenCalledExactlyOnceWith(fileURLToPath(first))
  })

  it.each(['text/plain', 'text', 'Text', 'text/uri-list', 'text/html'])(
    'captures the %s flavor before the renderer handles the drop',
    async (type) => {
      const subject = harness()
      subject.drop({ [type]: type === 'text/html' ? `<img src="${first}">` : first })
      await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe(fileURLToPath(first))
    }
  )

  it('shares concurrent authorization but consumes the lease once', async () => {
    const grant = deferred()
    const subject = harness(vi.fn().mockReturnValue(grant.promise))
    subject.drop({ 'text/plain': first })
    const initial = subject.authorizeDroppedLocalImage(first)
    const concurrent = subject.authorizeDroppedLocalImage(first)
    expect(concurrent).toBe(initial)
    await Promise.resolve()
    expect(subject.authorizePath).toHaveBeenCalledTimes(1)
    grant.resolve(true)
    await expect(initial).resolves.toBe(fileURLToPath(first))
    await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe('')
    expect(subject.authorizePath).toHaveBeenCalledTimes(1)
  })

  it.each(['denied', 'rejected'])(
    'also consumes failed %s authorization without leaking an exception',
    async (failure) => {
      const subject = harness(
        failure === 'denied'
          ? vi.fn().mockResolvedValue(false)
          : vi.fn().mockRejectedValue(new Error('not found'))
      )
      subject.drop({ 'text/plain': first })
      await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe('')
      await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe('')
      expect(subject.authorizePath).toHaveBeenCalledTimes(1)
    }
  )

  it('rejects an expired lease before any authorization starts', async () => {
    const subject = harness()
    subject.drop({ 'text/plain': first })
    subject.advance(EXTERNAL_IMAGE_DROP_LEASE_MS)
    await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe('')
    expect(subject.authorizePath).not.toHaveBeenCalled()
  })

  it('does not publish a late authorization after its lease expires', async () => {
    const grant = deferred()
    const subject = harness(vi.fn().mockReturnValue(grant.promise))
    subject.drop({ 'text/plain': first })
    const pending = subject.authorizeDroppedLocalImage(first)
    await Promise.resolve()
    subject.advance(EXTERNAL_IMAGE_DROP_LEASE_MS)
    grant.resolve(true)
    await expect(pending).resolves.toBe('')
  })

  it('does not start a queued authorization after a newer trusted drop', async () => {
    const subject = harness()
    subject.drop({ 'text/plain': first })
    const pending = subject.authorizeDroppedLocalImage(first)
    subject.drop({ 'text/plain': second })
    await expect(pending).resolves.toBe('')
    expect(subject.authorizePath).not.toHaveBeenCalled()
    await expect(subject.authorizeDroppedLocalImage(second)).resolves.toBe(fileURLToPath(second))
  })

  it('keeps a newer same-URL drop independent from an older pending authorization', async () => {
    const oldGrant = deferred()
    const newGrant = deferred()
    const subject = harness(
      vi.fn().mockReturnValueOnce(oldGrant.promise).mockReturnValueOnce(newGrant.promise)
    )
    subject.drop({ 'text/plain': first })
    const older = subject.authorizeDroppedLocalImage(first)
    await Promise.resolve()
    subject.drop({ 'text/plain': first })
    const newer = subject.authorizeDroppedLocalImage(first)
    await Promise.resolve()
    expect(newer).not.toBe(older)
    oldGrant.resolve(true)
    await expect(older).resolves.toBe('')
    expect(subject.authorizeDroppedLocalImage(first)).toBe(newer)
    newGrant.resolve(true)
    await expect(newer).resolves.toBe(fileURLToPath(first))
    expect(subject.authorizePath).toHaveBeenCalledTimes(2)
  })

  it.each(['beforeunload', 'pagehide', 'hashchange', 'popstate'])(
    'invalidates captured and pending leases on %s',
    async (event) => {
      const grant = deferred()
      const subject = harness(vi.fn().mockReturnValue(grant.promise))
      subject.drop({ 'text/plain': first })
      const pending = subject.authorizeDroppedLocalImage(first)
      await Promise.resolve()
      subject.emit(event)
      grant.resolve(true)
      await expect(pending).resolves.toBe('')
      await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe('')
    }
  )

  it('invalidates old leases even when the newer trusted drop is empty or unreadable', async () => {
    const subject = harness()
    subject.drop({ 'text/plain': first })
    subject.emit('drop', { isTrusted: true, dataTransfer: null })
    await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe('')
    subject.drop({ 'text/plain': first })
    subject.emit('drop', {
      isTrusted: true,
      dataTransfer: {
        getData: () => {
          throw new Error('closed')
        }
      }
    })
    await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe('')
    expect(subject.authorizePath).not.toHaveBeenCalled()
  })

  it('does not let synthetic drops replace a genuine current lease', async () => {
    const subject = harness()
    subject.drop({ 'text/plain': first })
    subject.drop({ 'text/plain': second }, false)
    await expect(subject.authorizeDroppedLocalImage(second)).resolves.toBe('')
    await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe(fileURLToPath(first))
  })

  it('bounds the lease to eight distinct local raster references', async () => {
    const subject = harness()
    const urls = Array.from({ length: 9 }, (_, index) => `${prefix}${index}.png`)
    subject.drop({ 'text/uri-list': urls.join('\n') })
    await expect(subject.authorizeDroppedLocalImage(urls[0])).resolves.toBe('')
    subject.drop({ 'text/uri-list': [...urls.slice(0, 8), urls[0]].join('\n') })
    await expect(Promise.all(urls.map(subject.authorizeDroppedLocalImage))).resolves.toEqual([
      ...urls.slice(0, 8).map((url) => fileURLToPath(url)),
      ''
    ])
    expect(subject.authorizePath).toHaveBeenCalledTimes(8)
  })

  it('retains literal percent escapes in the authorized native filename', async () => {
    const subject = harness()
    const url = `${prefix}%E5%8E%9F%E5%9B%BE%2520%25.png`
    subject.drop({ 'text/plain': url })
    await expect(subject.authorizeDroppedLocalImage(url)).resolves.toBe(fileURLToPath(url))
    expect(subject.authorizePath.mock.calls[0][0]).toContain('\u539f\u56fe%20%.png')
  })

  it('disposes listeners idempotently and rejects pending results after disposal', async () => {
    const grant = deferred()
    const subject = harness(vi.fn().mockReturnValue(grant.promise))
    subject.drop({ 'text/plain': first })
    const pending = subject.authorizeDroppedLocalImage(first)
    await Promise.resolve()
    subject.dispose()
    subject.dispose()
    grant.resolve(true)
    await expect(pending).resolves.toBe('')
    subject.drop({ 'text/plain': first })
    await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe('')
    expect(subject.removeEventListener).toHaveBeenCalledTimes(5)
    for (const [name, listener, capture] of subject.addEventListener.mock.calls) {
      expect(subject.removeEventListener).toHaveBeenCalledWith(name, listener, capture)
    }
  })

  it('is safe when no DOM is available', async () => {
    const authorizePath = vi.fn().mockResolvedValue(true)
    const subject = createExternalImageDropAuthorization({ authorizePath })
    await expect(subject.authorizeDroppedLocalImage(first)).resolves.toBe('')
    subject.dispose()
    expect(authorizePath).not.toHaveBeenCalled()
  })
})
