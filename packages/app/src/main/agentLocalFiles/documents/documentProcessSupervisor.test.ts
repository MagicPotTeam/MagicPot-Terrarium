import { fork, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DOCUMENT_PROCESS_RECEIPT_ACK,
  createDocumentProcessSupervisor,
  type DocumentProcessChild,
  type DocumentProcessStart,
  type DocumentProcessTransport,
  type DocumentProcessTransportEvents
} from './documentProcessSupervisor'
import {
  checkDocumentTextResult,
  DOCUMENT_TEXT_PROTOCOL,
  type DocumentTextFormat,
  type DocumentTextResult
} from './documentSchema'
import { parseDocumentTextResultFrame, serializeDocumentTextRequest } from './documentWorkerWire'

const JOB_ID = '0123456789abcdef0123456789abcdef'
const OTHER_JOB_ID = 'fedcba9876543210fedcba9876543210'
const fixturePath = path.resolve(
  process.cwd(),
  'packages/app/src/main/agentLocalFiles/documents/__fixtures__/documentProcessFixture.cjs'
)
const activeChildren = new Set<ChildProcess>()

function request(format: DocumentTextFormat = 'pdf') {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
  return { protocol: DOCUMENT_TEXT_PROTOCOL, jobId: JOB_ID, format, bytes }
}

function success(
  overrides: Partial<Extract<DocumentTextResult, { ok: true }>> = {}
): Extract<DocumentTextResult, { ok: true }> {
  return {
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId: JOB_ID,
    ok: true,
    format: 'pdf',
    segments: [{ text: 'known fixture text', locator: { kind: 'pdf-item', page: 1, item: 0 } }],
    truncated: false,
    warnings: [],
    ...overrides
  }
}

function failure(
  code: Extract<DocumentTextResult, { ok: false }>['code'] = 'NO_TEXT'
): Extract<DocumentTextResult, { ok: false }> {
  return { protocol: DOCUMENT_TEXT_PROTOCOL, jobId: JOB_ID, format: 'pdf', ok: false, code }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

class FakeTransport {
  readonly child: DocumentProcessChild = { kill: vi.fn(() => true) }
  readonly sent: string[] = []
  handlers: DocumentProcessTransportEvents | undefined
  sendImpl: (frame: string) => void | Promise<void> = (frame) => {
    this.sent.push(frame)
  }
  readonly transport: DocumentProcessTransport = {
    subscribe: (events) => {
      this.handlers = events
      return () => {
        if (this.handlers === events) this.handlers = undefined
      }
    },
    send: (frame) => this.sendImpl(frame)
  }

  spawn(child = this.child): void {
    this.handlers?.spawn(child)
  }

  data(frame: unknown, child = this.child): void {
    this.handlers?.data(child, frame)
  }

  exit(code: number | null = 0, signal: string | null = null, child = this.child): void {
    this.handlers?.exit(child, code, signal)
  }

  error(error: unknown, child = this.child): void {
    this.handlers?.error(child, error)
  }

  untaggedData(frame: unknown): void {
    ;(this.handlers?.data as unknown as (frame: unknown) => void)?.(frame)
  }
}

function fakeSetup(
  options: {
    decode?: (frame: unknown) => unknown | Promise<unknown>
    start?: DocumentProcessStart
    transport?: FakeTransport
  } = {}
) {
  const transport = options.transport ?? new FakeTransport()
  const codec = {
    serialize: vi.fn(() => 'request-frame'),
    decode: vi.fn(options.decode ?? (() => success()))
  }
  const start =
    options.start ??
    (() => {
      transport.spawn()
    })
  const supervisor = createDocumentProcessSupervisor({
    transport: transport.transport,
    codec,
    start
  })
  return { supervisor, transport, codec }
}

afterEach(() => {
  vi.useRealTimers()
  for (const child of activeChildren) {
    if (!child.killed) child.kill()
    child.disconnect?.()
  }
  activeChildren.clear()
})

describe('document process supervisor lifecycle', () => {
  it('fails closed without trusted transport, codec or start and releases the slot', async () => {
    const supervisor = createDocumentProcessSupervisor()
    await expect(supervisor.run(request())).resolves.toEqual({
      protocol: DOCUMENT_TEXT_PROTOCOL,
      jobId: JOB_ID,
      format: 'pdf',
      ok: false,
      code: 'EXECUTION_FAILED'
    })
    expect(supervisor.state).toBe('idle')
    expect(supervisor.isBusy()).toBe(false)
  })

  it('rejects invalid bytes before starting anything and keeps request data out of errors', async () => {
    const start = vi.fn()
    const supervisor = createDocumentProcessSupervisor({ start })
    const invalid = { ...request(), bytes: new Uint8Array([1, 2, 3]) }
    await expect(supervisor.run(invalid)).resolves.toEqual({ ok: false, code: 'INVALID' })
    expect(start).not.toHaveBeenCalled()
    expect(supervisor.state).toBe('idle')
  })

  it('returns LIMIT for oversized input and never starts a child', async () => {
    const start = vi.fn()
    const supervisor = createDocumentProcessSupervisor({ start })
    const oversized = { ...request(), bytes: new Uint8Array(1024 * 1024 + 1) }
    oversized.bytes[0] = 0x25
    oversized.bytes[1] = 0x50
    oversized.bytes[2] = 0x44
    oversized.bytes[3] = 0x46
    oversized.bytes[4] = 0x2d
    await expect(supervisor.run(oversized)).resolves.toEqual({ ok: false, code: 'LIMIT' })
    expect(start).not.toHaveBeenCalled()
  })

  it('cancels before spawn without invoking the injected start', async () => {
    const controller = new AbortController()
    controller.abort()
    const start = vi.fn()
    const supervisor = createDocumentProcessSupervisor({ start })
    await expect(supervisor.run(request(), controller.signal)).resolves.toMatchObject({
      ok: false,
      code: 'CANCELLED',
      jobId: JOB_ID,
      format: 'pdf'
    })
    expect(start).not.toHaveBeenCalled()
  })

  it('reserves the slot before synchronous codec re-entry', async () => {
    let nested: Promise<unknown> | undefined
    const transport = new FakeTransport()
    const codec = {
      serialize: vi.fn(() => {
        nested = supervisor.run(request())
        return 'request-frame'
      }),
      decode: vi.fn(() => success())
    }
    const supervisor = createDocumentProcessSupervisor({
      transport: transport.transport,
      codec,
      start: () => transport.spawn()
    })
    const primary = supervisor.run(request())
    await expect(nested).resolves.toEqual({ ok: false, code: 'LIMIT' })
    transport.data('result-frame')
    await flush()
    transport.exit()
    await expect(primary).resolves.toMatchObject({ ok: true, jobId: JOB_ID })
  })

  it('keeps an unresolved start quarantined after the fixed deadline and kills a late child', async () => {
    vi.useFakeTimers()
    let resolveStart!: (child: DocumentProcessChild) => void
    const start = vi.fn(
      () =>
        new Promise<DocumentProcessChild>((resolve) => {
          resolveStart = resolve
        })
    )
    const { supervisor, transport } = fakeSetup({ start })
    const pending = supervisor.run(request())
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(5001)
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'TIMEOUT' })
    expect(supervisor.state).toBe('quarantined')
    resolveStart(transport.child)
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.child.kill).toHaveBeenCalledOnce()
    expect(supervisor.isBusy()).toBe(true)
  })

  it('commits a valid result only after matching exit zero', async () => {
    const { supervisor, transport } = fakeSetup()
    const pending = supervisor.run(request())
    transport.data('result-frame')
    await flush()
    expect(transport.sent).toEqual(['request-frame', DOCUMENT_PROCESS_RECEIPT_ACK])
    expect(supervisor.isBusy()).toBe(true)
    transport.exit(0)
    await expect(pending).resolves.toMatchObject({ ok: true, jobId: JOB_ID })
    expect(supervisor.state).toBe('idle')
  })

  it.each(['NO_TEXT', 'LIMIT', 'UNSUPPORTED'] as const)(
    'keeps a valid %s failure pending until ACK and normal exit',
    async (code) => {
      const { supervisor, transport } = fakeSetup({ decode: () => failure(code) })
      const pending = supervisor.run(request())
      transport.data('failure-frame')
      await flush()
      expect(supervisor.isBusy()).toBe(true)
      const observed = await Promise.race([
        pending.then(() => 'settled'),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
      ])
      expect(observed).toBe('pending')
      transport.exit(0)
      await expect(pending).resolves.toMatchObject({ ok: false, code })
      expect(supervisor.state).toBe('idle')
    }
  )

  it('lets cancellation win over a result that arrived before exit', async () => {
    const { supervisor, transport } = fakeSetup()
    const pending = supervisor.run(request())
    transport.data('result-frame')
    await flush()
    expect(supervisor.cancel()).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(transport.child.kill).toHaveBeenCalledOnce()
    transport.exit(0)
    expect(supervisor.state).toBe('idle')
  })

  it.each([
    [
      'malformed result',
      () => {
        throw new Error('malformed')
      }
    ],
    ['wrong correlation', () => ({ ...success(), jobId: OTHER_JOB_ID })],
    ['wrong format', () => ({ ...success(), format: 'docx' })]
  ])('%s fails closed and waits for exit confirmation', async (_name, decode) => {
    const { supervisor, transport } = fakeSetup({ decode })
    const pending = supervisor.run(request())
    transport.data('bad-frame')
    await flush()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'EXECUTION_FAILED' })
    expect(supervisor.isBusy()).toBe(true)
    transport.exit(0)
    expect(supervisor.state).toBe('idle')
  })

  it('ignores stale or untagged transport events rather than crossing the slot boundary', async () => {
    const first = fakeSetup()
    const firstPending = first.supervisor.run(request())
    const staleChild: DocumentProcessChild = { kill: vi.fn(() => true) }
    first.transport.exit(0, null, staleChild)
    first.transport.data('stale-frame', staleChild)
    first.transport.untaggedData('untagged-frame')
    expect(first.supervisor.isBusy()).toBe(true)
    first.transport.data('result-frame')
    await flush()
    first.transport.exit(0)
    await expect(firstPending).resolves.toMatchObject({ ok: true, jobId: JOB_ID })
  })

  it('rejects duplicate data and never promotes the first result', async () => {
    const { supervisor, transport } = fakeSetup()
    const pending = supervisor.run(request())
    transport.data('first')
    await flush()
    transport.data('duplicate')
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'EXECUTION_FAILED' })
    transport.exit(0)
    expect(supervisor.state).toBe('idle')
  })

  it.each([
    ['no result', () => undefined, 0, null],
    ['nonzero exit', () => success(), 1, null],
    ['null signal exit', () => success(), 0, 'SIGTERM']
  ] as const)('%s resolves only as execution failure', async (_name, decode, exitCode, signal) => {
    const { supervisor, transport } = fakeSetup({ decode })
    const pending = supervisor.run(request())
    if (exitCode === 0 && decode() !== undefined) {
      transport.data('result')
      await flush()
    }
    transport.exit(exitCode, signal)
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'EXECUTION_FAILED' })
    expect(supervisor.state).toBe('idle')
  })

  it('quarantines a child after transport error or a successful kill without exit', async () => {
    const first = fakeSetup()
    const firstPending = first.supervisor.run(request())
    first.transport.error(new Error('transport'))
    await expect(firstPending).resolves.toMatchObject({ ok: false, code: 'EXECUTION_FAILED' })
    expect(first.supervisor.state).toBe('quarantined')
    expect(first.supervisor.cancel()).toBe(false)

    const second = fakeSetup()
    const secondPending = second.supervisor.run(request())
    expect(second.supervisor.cancel()).toBe(true)
    await expect(secondPending).resolves.toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(second.supervisor.state).toBe('quarantined')
  })

  it('does not release after a deadline failure until child exit', async () => {
    vi.useFakeTimers()
    const { supervisor, transport } = fakeSetup()
    const pending = supervisor.run(request())
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(5001)
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'TIMEOUT' })
    expect(supervisor.isBusy()).toBe(true)
    await expect(supervisor.run(request())).resolves.toEqual({ ok: false, code: 'LIMIT' })
    transport.exit(0)
    expect(supervisor.state).toBe('idle')
  })

  it('drops a late decoded result after cancellation and cleans the listener at confirmed exit', async () => {
    let resolveDecode!: (value: unknown) => void
    const transport = new FakeTransport()
    const { supervisor } = fakeSetup({
      transport,
      decode: () =>
        new Promise((resolve) => {
          resolveDecode = resolve
        })
    })
    const pending = supervisor.run(request())
    transport.data('slow-result')
    await flush()
    expect(supervisor.cancel()).toBe(true)
    resolveDecode(success())
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'CANCELLED' })
    expect(transport.sent).toEqual(['request-frame'])
    transport.exit(0)
    expect(supervisor.state).toBe('idle')
    expect(transport.handlers).toBeUndefined()
  })

  it('rejects a decoder that resolves after child exit and keeps the failure until closeout', async () => {
    let resolveDecode!: (value: unknown) => void
    const transport = new FakeTransport()
    const { supervisor } = fakeSetup({
      transport,
      decode: () =>
        new Promise((resolve) => {
          resolveDecode = resolve
        })
    })
    const pending = supervisor.run(request())
    transport.data('slow-result')
    await flush()
    transport.exit(0)
    resolveDecode(success())
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'EXECUTION_FAILED' })
    expect(supervisor.state).toBe('idle')
  })

  it('holds the slot while asynchronous ACK is pending even when exit is known', async () => {
    let resolveAck!: () => void
    const transport = new FakeTransport()
    transport.sendImpl = (frame) => {
      transport.sent.push(frame)
      if (frame === DOCUMENT_PROCESS_RECEIPT_ACK)
        return new Promise<void>((resolve) => (resolveAck = resolve))
      return undefined
    }
    const { supervisor } = fakeSetup({ transport })
    const pending = supervisor.run(request())
    transport.data('result-frame')
    await flush()
    transport.exit(0)
    await expect(
      Promise.race([pending.then(() => 'settled'), Promise.resolve('pending')])
    ).resolves.toBe('pending')
    expect(supervisor.isBusy()).toBe(true)
    resolveAck()
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(supervisor.state).toBe('idle')
  })

  it('rejects a failed ACK and releases only after known child exit', async () => {
    const transport = new FakeTransport()
    transport.sendImpl = (frame) => {
      transport.sent.push(frame)
      if (frame === DOCUMENT_PROCESS_RECEIPT_ACK) return Promise.reject(new Error('send failed'))
      return undefined
    }
    const { supervisor } = fakeSetup({ transport })
    const pending = supervisor.run(request())
    transport.data('result-frame')
    await flush()
    transport.exit(0)
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'EXECUTION_FAILED' })
    expect(supervisor.state).toBe('idle')
  })

  it('disposes as a terminal failure without pretending an unresolved child exited', async () => {
    const { supervisor, transport } = fakeSetup()
    const pending = supervisor.run(request())
    supervisor.dispose()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'EXECUTION_FAILED' })
    expect(transport.child.kill).toHaveBeenCalledOnce()
    expect(supervisor.state).toBe('disposed')
    transport.exit(0)
    expect(supervisor.state).toBe('disposed')
    await expect(supervisor.run(request())).resolves.toEqual({
      ok: false,
      code: 'EXECUTION_FAILED'
    })
  })

  it('runs the fixed Node22 fixture through injected transport and waits for ACK then exit', async () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(22)
    const transport: DocumentProcessTransport & {
      child?: ChildProcess
      handlers?: DocumentProcessTransportEvents
    } = {
      subscribe: (events) => {
        transport.handlers = events
        return () => {
          if (transport.handlers === events) transport.handlers = undefined
        }
      },
      send: (frame) => {
        transport.child?.send(frame)
      }
    }
    const supervisor = createDocumentProcessSupervisor({
      transport,
      codec: {
        serialize: (value) => serializeDocumentTextRequest(value),
        decode: (frame, jobId, format) => {
          const parsed = parseDocumentTextResultFrame(frame, jobId, format)
          if (!parsed.ok) throw new Error('invalid fixture frame')
          return parsed.result
        }
      },
      start: () => {
        const child = fork(fixturePath, ['NORMAL'], {
          cwd: path.dirname(fixturePath),
          env: {
            SystemRoot: process.env.SystemRoot ?? '',
            PATH: process.env.PATH ?? '',
            MAGICPOT_DOCUMENT_FIXTURE: '1'
          },
          execArgv: ['--max-old-space-size=256'],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc']
        })
        activeChildren.add(child)
        transport.child = child
        child.on('message', (frame) => transport.handlers?.data(child, frame))
        child.on('error', (error) => transport.handlers?.error(child, error))
        child.on('exit', (code, signal) => {
          activeChildren.delete(child)
          transport.handlers?.exit(child, code, signal)
        })
        return child
      }
    })
    const result = await supervisor.run(request())
    expect(result).toMatchObject({ ok: true, jobId: JOB_ID, format: 'pdf' })
    expect((result as Extract<DocumentTextResult, { ok: true }>).segments[0].text).toBe(
      'fixture-known-result'
    )
    expect(supervisor.state).toBe('idle')
  })

  it('rechecks the schema after trusted decode and never accepts a raw failure object', () => {
    const malformed = { ...success(), segments: [] }
    expect(checkDocumentTextResult(malformed, JOB_ID, 'pdf')).toEqual({
      ok: false,
      code: 'INVALID'
    })
  })
})
