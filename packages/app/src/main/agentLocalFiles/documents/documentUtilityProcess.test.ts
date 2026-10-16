import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDocumentUtilityExtractor,
  documentUtilityEnvironment
} from './documentUtilityProcess'
import { DOCUMENT_PROCESS_DEADLINE_MS } from './documentProcessSupervisor'
import { DOCUMENT_TEXT_PROTOCOL } from './documentSchema'
import { parseDocumentTextRequestFrame, serializeDocumentTextResult } from './documentWorkerWire'
import { pdfFixtures } from './__fixtures__/pdfFixtures'

vi.mock('electron', () => ({ app: {}, utilityProcess: {} }))
const request = () => ({
  protocol: DOCUMENT_TEXT_PROTOCOL,
  jobId: '12345678123456781234567812345678',
  format: 'pdf' as const,
  bytes: pdfFixtures().multiPage
})
function fixture() {
  const child = new EventEmitter() as EventEmitter & {
    postMessage: ReturnType<typeof vi.fn<(frame: string) => void>>
    kill: ReturnType<typeof vi.fn<() => boolean>>
  }
  child.postMessage = vi.fn()
  child.kill = vi.fn(() => false)
  const fork = vi.fn(() => child)
  const verifyAssets = vi.fn(() => 'owned-fixed-worker')
  const extractor = createDocumentUtilityExtractor({
    isReady: () => true,
    appRoot: () => 'owned-app-root',
    fork,
    verifyAssets
  })
  return { child, fork, verifyAssets, extractor }
}
afterEach(() => vi.useRealTimers())

describe('document utility adapter exit ownership', () => {
  it('uses only nonempty fixed environment, ignoring code injection, provider and path secrets', () => {
    expect(
      documentUtilityEnvironment({
        SystemRoot: 'synthetic-system',
        WINDIR: 'synthetic-win',
        NODE_OPTIONS: '--require injected',
        NODE_PATH: 'injected',
        OPENAI_API_KEY: 'synthetic-secret',
        PATH: 'injected'
      })
    ).toEqual({ LANG: 'C', SystemRoot: 'synthetic-system', WINDIR: 'synthetic-win' })
    expect(documentUtilityEnvironment({})).toEqual({ LANG: 'C' })
  })
  it('sends one canonical byte request at spawn, ACKs result, settles only native exit and frees slot', async () => {
    const f = fixture()
    const pending = f.extractor.extract(request(), new AbortController().signal)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    expect(f.fork).toHaveBeenCalledWith(
      'owned-fixed-worker',
      [],
      expect.objectContaining({
        execArgv: ['--max-old-space-size=256'],
        stdio: 'ignore',
        allowLoadingUnsignedLibraries: false
      })
    )
    expect(f.child.postMessage).not.toHaveBeenCalled()
    f.child.emit('spawn')
    const parsed = parseDocumentTextRequestFrame(f.child.postMessage.mock.calls[0][0])
    expect(parsed.ok).toBe(true)
    f.child.emit(
      'message',
      serializeDocumentTextResult(
        {
          protocol: DOCUMENT_TEXT_PROTOCOL,
          jobId: request().jobId,
          format: 'pdf',
          ok: true,
          segments: [{ text: 'OWNED', locator: { kind: 'pdf-item', page: 2, item: 0 } }],
          truncated: false,
          warnings: ['reading-order-unverified']
        },
        request().jobId,
        'pdf'
      )
    )
    expect(f.child.postMessage.mock.calls[1][0]).toBe('ACK')
    await Promise.resolve()
    expect(settled).toBe(false)
    f.child.emit('exit', 0)
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(f.child.eventNames()).toEqual([])
    f.extractor.dispose()
  })
  it.each(['cancel', 'timeout', 'dispose', 'malformed', 'error'] as const)(
    'quarantines outer promise and slot through %s kill failure until the native exit',
    async (reason) => {
      vi.useFakeTimers()
      const f = fixture(),
        controller = new AbortController()
      const pending = f.extractor.extract(request(), controller.signal)
      let settled = false
      void pending.then(() => {
        settled = true
      })
      f.child.emit('spawn')
      if (reason === 'cancel') controller.abort()
      if (reason === 'dispose') f.extractor.dispose()
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(DOCUMENT_PROCESS_DEADLINE_MS)
      if (reason === 'malformed') f.child.emit('message', '{"token":"synthetic"}')
      if (reason === 'error') f.child.emit('error', new Error('synthetic-path-private'))
      await Promise.resolve()
      expect(f.child.kill).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)
      await expect(
        f.extractor.extract(request(), new AbortController().signal)
      ).resolves.toMatchObject({
        ok: false,
        code: reason === 'dispose' ? 'EXECUTION_FAILED' : 'LIMIT'
      })
      f.child.emit('exit', 1)
      await expect(pending).resolves.toMatchObject({
        ok: false,
        code:
          reason === 'cancel' ? 'CANCELLED' : reason === 'timeout' ? 'TIMEOUT' : 'EXECUTION_FAILED'
      })
      expect(f.child.eventNames()).toEqual([])
      f.extractor.dispose()
    }
  )
  it('retries a failed pre-spawn kill when native spawn occurs without sending request bytes', async () => {
    const f = fixture(),
      controller = new AbortController()
    const pending = f.extractor.extract(request(), controller.signal)
    controller.abort()
    expect(f.child.kill).toHaveBeenCalledTimes(1)
    f.child.emit('spawn')
    expect(f.child.kill).toHaveBeenCalledTimes(2)
    expect(f.child.postMessage).not.toHaveBeenCalled()
    f.child.emit('exit', 1)
    await expect(pending).resolves.toMatchObject({ code: 'CANCELLED' })
    f.extractor.dispose()
  })
  it('fails closed before Electron readiness without checking assets or forking', async () => {
    const fork = vi.fn(),
      verifyAssets = vi.fn()
    const extractor = createDocumentUtilityExtractor({ isReady: () => false, fork, verifyAssets })
    await expect(extractor.extract(request(), new AbortController().signal)).resolves.toMatchObject(
      { code: 'EXECUTION_FAILED' }
    )
    expect(fork).not.toHaveBeenCalled()
    expect(verifyAssets).not.toHaveBeenCalled()
    extractor.dispose()
  })
  it('fails closed at corruption/invalid request before any child is created', async () => {
    const f = fixture()
    f.verifyAssets.mockImplementation(() => {
      throw new Error('synthetic-path-detail')
    })
    await expect(
      f.extractor.extract(request(), new AbortController().signal)
    ).resolves.toMatchObject({ code: 'EXECUTION_FAILED' })
    expect(f.fork).not.toHaveBeenCalled()
    await expect(
      f.extractor.extract({ ...request(), bytes: new Uint8Array() }, new AbortController().signal)
    ).resolves.toMatchObject({ code: 'INVALID' })
    const before = new AbortController()
    before.abort()
    await expect(f.extractor.extract(request(), before.signal)).resolves.toMatchObject({
      code: 'CANCELLED'
    })
    f.extractor.dispose()
  })
})
