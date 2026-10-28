import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { performance as nodePerformance } from 'node:perf_hooks'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeBackgroundRemovalRgbaPng } from './pngRgbaDecoder'
import type { TrustedImageDecoder } from './imageValidation'
import { createSelectedSourceReader } from './selectedSource'
import {
  BACKGROUND_REMOVAL_REVIEW_DOMAIN,
  MAX_BACKGROUND_REMOVAL_LIFETIME_MS,
  createBackgroundRemovalRunner,
  type BackgroundRemovalReview,
  type BackgroundRemovalScope,
  type ResolvedBackgroundRemovalBackend,
  type RunBackgroundRemovalResult,
  type TrustedBackgroundRemovalDeadline,
  type TrustedBackgroundRemovalOptions
} from './runner'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('fs')
vi.unmock('fs/promises')

// Tiny encoded fixtures, not a remover or evidence of semantic matting quality.
function chunk(kind: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length)
  result.write(kind, 4, 4, 'ascii')
  result.set(data, 8)
  let crc = 0xffffffff
  for (const byte of result.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}
function fixture(alpha = [0, 255], compressed?: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(alpha.length)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk(
      'IDAT',
      compressed ?? deflateSync(Buffer.from([0, ...alpha.flatMap((a) => [1, 2, 3, a])]))
    ),
    chunk('IEND')
  ])
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const scope: BackgroundRemovalScope = {
  senderId: 7,
  documentEpoch: 3,
  projectId: 'project-1',
  operationId: 'operation-1',
  sourceId: 'source-1'
}
const profile = 'background-profile-2'
const fail = (error: string) => ({ status: 'error', error })
function setup(overrides: TrustedBackgroundRemovalOptions = {}) {
  const backend = vi.fn<ResolvedBackgroundRemovalBackend['run']>(async () => fixture())
  const configuration: ResolvedBackgroundRemovalBackend = {
    backgroundRemovalProfileId: profile,
    authorityEpoch: 1,
    descriptor: {
      id: 'fixture-backend',
      configurationRevision: 'revision-1',
      destination: 'synthetic-memory',
      kind: 'synthetic'
    },
    run: backend
  }
  const resolve = vi.fn(async () => configuration)
  const isCurrent = vi.fn<NonNullable<TrustedBackgroundRemovalOptions['isCurrent']>>((binding) => {
    return (
      binding.backgroundRemovalProfileId === configuration.backgroundRemovalProfileId &&
      binding.authorityEpoch === configuration.authorityEpoch &&
      binding.backend.id === configuration.descriptor.id &&
      binding.backend.configurationRevision === configuration.descriptor.configurationRevision &&
      binding.backend.destination === configuration.descriptor.destination &&
      binding.backend.kind === configuration.descriptor.kind
    )
  })
  const approveNative = vi.fn<NonNullable<TrustedBackgroundRemovalOptions['approveNative']>>(
    async () => true
  )
  const runner = createBackgroundRemovalRunner({
    decoder: decodeBackgroundRemovalRgbaPng,
    resolve,
    isCurrent,
    approveNative,
    ...overrides
  })
  return { runner, backend, configuration, resolve, isCurrent, approveNative }
}
async function prepare(runner: ReturnType<typeof createBackgroundRemovalRunner>) {
  const result = await runner.prepare(fixture(), scope, profile)
  expect(result.status).toBe('review')
  if (result.status !== 'review') throw new Error('expected review')
  return result.review
}
function run(
  runner: ReturnType<typeof createBackgroundRemovalRunner>,
  review: BackgroundRemovalReview
) {
  return runner.run(review.receiptId, review.reviewHash, scope)
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('main-only explicit background removal review contract', () => {
  it('has no default decoder, resolver, capability fallback or approval', async () => {
    expect(await createBackgroundRemovalRunner().prepare(fixture(), scope, profile)).toEqual(
      fail('UNAVAILABLE')
    )
    const missingDecoder = setup({ decoder: undefined })
    expect(await missingDecoder.runner.prepare(fixture(), scope, profile)).toEqual(
      fail('DECODER_UNAVAILABLE')
    )
    expect(missingDecoder.resolve).not.toHaveBeenCalled()
    for (const options of [{ resolve: undefined }, { isCurrent: undefined }]) {
      const env = setup(options)
      expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('UNAVAILABLE'))
      expect(env.backend).not.toHaveBeenCalled()
    }
    const env = setup({ approveNative: undefined })
    const review = await prepare(env.runner)
    expect(await run(env.runner, review)).toEqual(fail('APPROVAL_UNAVAILABLE'))
    expect(env.backend).not.toHaveBeenCalled()
  })

  it('prepares without invoking approval/backend and resolves only the exact saved reference', async () => {
    const env = setup()
    const review = await prepare(env.runner)
    expect(env.resolve).toHaveBeenCalledExactlyOnceWith(profile, expect.any(AbortSignal))
    expect(env.approveNative).not.toHaveBeenCalled()
    expect(env.backend).not.toHaveBeenCalled()
    expect(review.binding.backgroundRemovalProfileId).toBe(profile)
    expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('BUSY'))
    expect(env.runner.discard(review.receiptId, review.reviewHash, scope)).toEqual({
      status: 'discarded'
    })
  })

  it.each(['', 'regular-image-profile'])(
    'does not fall back from unavailable ref %j',
    async (ref) => {
      const resolve = vi.fn(async () => undefined)
      const env = setup({ resolve })
      expect(await env.runner.prepare(fixture(), scope, ref)).toEqual(
        fail(ref ? 'UNAVAILABLE' : 'INVALID_REQUEST')
      )
      if (ref) expect(resolve).toHaveBeenCalledExactlyOnceWith(ref, expect.any(AbortSignal))
      else expect(resolve).not.toHaveBeenCalled()
      expect(env.backend).not.toHaveBeenCalled()
    }
  )

  it.each([
    { ...scope, senderId: -1 },
    { ...scope, documentEpoch: NaN },
    { ...scope, documentEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...scope, projectId: '' },
    { ...scope, operationId: 'x'.repeat(129) },
    { ...scope, sourceId: 'D:/fixture-data/source.png' }
  ])('rejects invalid public scope before decoding: %j', async (inputScope) => {
    const decoder = vi.fn(decodeBackgroundRemovalRgbaPng)
    const env = setup({ decoder })
    expect(await env.runner.prepare(fixture(), inputScope, profile)).toEqual(
      fail('INVALID_REQUEST')
    )
    expect(decoder).not.toHaveBeenCalled()
    expect(env.resolve).not.toHaveBeenCalled()
  })

  it('makes an opaque receipt and domain-separated hash of the complete frozen exact binding', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    const env = setup()
    const start = Date.now()
    const review = await prepare(env.runner)
    expect(review.receiptId).toMatch(/^[a-f0-9]{32,}$/)
    expect(review.reviewHash).toBe(
      createHash('sha256')
        .update(BACKGROUND_REMOVAL_REVIEW_DOMAIN)
        .update(JSON.stringify({ receiptId: review.receiptId, binding: review.binding }))
        .digest('hex')
    )
    expect(review.binding.source).toEqual({
      sha256: createHash('sha256').update(fixture()).digest('hex'),
      format: 'png',
      width: 2,
      height: 1
    })
    expect(review.binding.scope).toEqual(scope)
    expect(review.binding.expiresAt).toBe(start + 120_000)
    for (const object of [
      review,
      review.binding,
      review.binding.source,
      review.binding.scope,
      review.binding.backend
    ]) {
      expect(Object.isFrozen(object)).toBe(true)
    }
    expect(() => Object.assign(review.binding.backend, { destination: 'other' })).toThrow()
    expect(Object.keys(review)).toEqual(['receiptId', 'reviewHash', 'binding'])
    expect(Object.keys(review.binding)).toEqual([
      'scope',
      'source',
      'backgroundRemovalProfileId',
      'authorityEpoch',
      'backend',
      'expiresAt'
    ])
    env.runner.cancel()
    const next = await prepare(env.runner)
    expect(next.receiptId).not.toBe(review.receiptId)
    expect(next.reviewHash).not.toBe(review.reviewHash)
    env.runner.cancel()
  })

  it('snapshots only public descriptor fields and checks the exact frozen binding', async () => {
    const env = setup()
    Object.assign(env.configuration, { secret: 'credential', path: 'D:/fixture-data/source.png' })
    Object.assign(env.configuration.descriptor, {
      credentials: 'never-review',
      endpoint: 'https://secret'
    })
    const review = await prepare(env.runner)
    expect(JSON.stringify(review)).not.toMatch(/credential|private|endpoint|https:/)
    expect(Object.keys(review.binding.backend)).toEqual([
      'id',
      'configurationRevision',
      'destination',
      'kind'
    ])
    expect(env.isCurrent.mock.calls.every(([binding]) => binding === review.binding)).toBe(true)
    env.runner.cancel()
  })

  it('returns detached validated PNG bytes only to trusted main, preserving the original', async () => {
    const env = setup()
    const source = fixture([255, 255])
    const original = Buffer.from(source)
    const result = await env.runner.prepare(source, scope, profile)
    if (result.status !== 'review') throw new Error('expected review')
    const output = fixture()
    env.backend.mockResolvedValue(output)
    const completed = await run(env.runner, result.review)
    expect(completed).toEqual({
      status: 'result',
      bytes: fixture(),
      metadata: { format: 'png', width: 2, height: 1 }
    })
    expect(env.approveNative).toHaveBeenCalledExactlyOnceWith(
      result.review,
      expect.any(AbortSignal)
    )
    expect(env.backend).toHaveBeenCalledExactlyOnceWith(
      original,
      { format: 'png', width: 2, height: 1 },
      expect.any(AbortSignal)
    )
    expect(source).toEqual(original)
    if (completed.status !== 'result') throw new Error('expected result')
    expect(completed.bytes.buffer).not.toBe(output.buffer)
    expect(env.backend.mock.calls[0][0].buffer).not.toBe(source.buffer)
    output.fill(0)
    expect(completed.bytes).toEqual(fixture())
    completed.bytes.fill(0)
    expect(source).toEqual(original)
    expect(await run(env.runner, result.review)).toEqual(fail('INVALID_RECEIPT'))
    await prepare(env.runner)
    env.runner.cancel()
  })

  it('snapshots source and ordinary scope before decoder or resolver can reenter', async () => {
    const source = fixture()
    const mutableScope = { ...scope }
    const gate = deferred<void>()
    const decoder: TrustedImageDecoder = async (bytes, metadata, signal) => {
      await gate.promise
      return decodeBackgroundRemovalRgbaPng(bytes, metadata, signal)
    }
    const env = setup({ decoder })
    const pending = env.runner.prepare(source, mutableScope, profile)
    source.fill(0)
    mutableScope.operationId = 'changed'
    gate.resolve()
    const prepared = await pending
    if (prepared.status !== 'review') throw new Error('expected review')
    expect(prepared.review.binding.scope).toEqual(scope)
    expect(await run(env.runner, prepared.review)).toMatchObject({ status: 'result' })
    expect(env.backend.mock.calls[0][0]).toEqual(fixture())
  })

  it('does not let backend mutation alter the retained source or output validation snapshot', async () => {
    let output: Buffer = Buffer.alloc(0)
    let decodes = 0
    const decoder: TrustedImageDecoder = async (bytes, metadata, signal) => {
      if (++decodes === 2) output.fill(0)
      return decodeBackgroundRemovalRgbaPng(bytes, metadata, signal)
    }
    const env = setup({ decoder })
    const source = fixture()
    const prepared = await env.runner.prepare(source, scope, profile)
    if (prepared.status !== 'review') throw new Error('expected review')
    env.backend.mockImplementation(async (bytes, metadata) => {
      expect(Object.isFrozen(metadata)).toBe(true)
      bytes.fill(0)
      output = fixture()
      return output
    })
    expect(await run(env.runner, prepared.review)).toMatchObject({
      status: 'result',
      bytes: fixture()
    })
    expect(source).toEqual(fixture())
  })

  it.each(['senderId', 'documentEpoch', 'projectId', 'operationId', 'sourceId'] as const)(
    'rejects a changed %s without consuming the valid receipt',
    async (key) => {
      const env = setup()
      const review = await prepare(env.runner)
      const changed = { ...scope, [key]: typeof scope[key] === 'number' ? 99 : 'other' }
      expect(await env.runner.run(review.receiptId, review.reviewHash, changed)).toEqual(
        fail('INVALID_RECEIPT')
      )
      expect(env.runner.discard(review.receiptId, review.reviewHash, changed)).toEqual(
        fail('INVALID_RECEIPT')
      )
      expect(env.approveNative).not.toHaveBeenCalled()
      expect(await run(env.runner, review)).toMatchObject({ status: 'result' })
    }
  )

  it.each(['id', 'hash'])('rejects a wrong receipt %s without native approval', async (field) => {
    const env = setup()
    const review = await prepare(env.runner)
    expect(
      await env.runner.run(
        field === 'id' ? '0'.repeat(32) : review.receiptId,
        field === 'hash' ? '0'.repeat(64) : review.reviewHash,
        scope
      )
    ).toEqual(fail('INVALID_RECEIPT'))
    expect(env.approveNative).not.toHaveBeenCalled()
    env.runner.cancel()
  })

  it.each([false, 1, 'true', { approved: true }])(
    'only literal native approval true grants execution: %j',
    async (approval) => {
      const env = setup({ approveNative: async () => approval as boolean })
      const review = await prepare(env.runner)
      expect(await run(env.runner, review)).toEqual(fail('APPROVAL_DENIED'))
      expect(await run(env.runner, review)).toEqual(fail('INVALID_RECEIPT'))
      expect(env.backend).not.toHaveBeenCalled()
    }
  )

  it.each(['profile', 'kind', 'destination', 'revision', 'id', 'epoch'])(
    'rejects invalid resolver binding: %s',
    async (field) => {
      const env = setup()
      if (field === 'profile') env.configuration.backgroundRemovalProfileId = 'other'
      if (field === 'kind') Object.assign(env.configuration.descriptor, { kind: 'remote' })
      if (field === 'destination')
        env.configuration.descriptor.destination = 'https://secret:token@example.test/path'
      if (field === 'revision') env.configuration.descriptor.configurationRevision = ''
      if (field === 'id') env.configuration.descriptor.id = 'D:/fixture-data/image.png'
      if (field === 'epoch') env.configuration.authorityEpoch = -1
      expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('UNAVAILABLE'))
      expect(env.backend).not.toHaveBeenCalled()
    }
  )

  it.each([
    'authorityEpoch',
    'id',
    'configurationRevision',
    'destination',
    'kind',
    'backgroundRemovalProfileId'
  ])('blocks changed current configuration %s', async (field) => {
    const env = setup()
    const review = await prepare(env.runner)
    if (field === 'authorityEpoch') env.configuration.authorityEpoch++
    else if (field === 'backgroundRemovalProfileId')
      env.configuration.backgroundRemovalProfileId = 'changed'
    else Object.assign(env.configuration.descriptor, { [field]: 'changed' })
    expect(await run(env.runner, review)).toEqual(fail('REVOKED'))
    expect(env.approveNative).not.toHaveBeenCalled()
    expect(env.backend).not.toHaveBeenCalled()
  })

  it('epoch revocation during approval blocks an otherwise unchanged descriptor', async () => {
    const env = setup()
    const review = await prepare(env.runner)
    const gate = deferred<boolean>()
    env.approveNative.mockReturnValue(gate.promise)
    const pending = run(env.runner, review)
    env.configuration.authorityEpoch++
    expect(review.binding.authorityEpoch).toBe(1)
    gate.resolve(true)
    expect(await pending).toEqual(fail('REVOKED'))
    expect(env.backend).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'isCurrent', 'approveNative', 'backend', 'decoder'])(
    'redacts thrown %s errors',
    async (stage) => {
      const secret = () => {
        throw new Error('SECRET D:/fixture-data/source.png https://user:password@host')
      }
      const env = setup({
        ...(stage === 'resolve' ? { resolve: secret } : {}),
        ...(stage === 'isCurrent' ? { isCurrent: secret } : {}),
        ...(stage === 'approveNative' ? { approveNative: secret } : {}),
        ...(stage === 'decoder' ? { decoder: secret } : {})
      })
      if (stage === 'backend') env.backend.mockImplementation(secret)
      const prepared = await env.runner.prepare(fixture(), scope, profile)
      const result =
        prepared.status === 'review' ? await run(env.runner, prepared.review) : prepared
      expect(result).toEqual(
        fail(
          {
            resolve: 'UNAVAILABLE',
            isCurrent: 'REVOKED',
            approveNative: 'APPROVAL_DENIED',
            backend: 'BACKEND_FAILED',
            decoder: 'INVALID_INPUT'
          }[stage]!
        )
      )
      expect(JSON.stringify(result)).not.toContain('SECRET')
    }
  )
})

describe('single-slot deadlines, cancellation and synchronous reentrancy', () => {
  it('reserves before input decode and readiness callbacks reenter prepare', async () => {
    const attempts: Promise<unknown>[] = []
    const env: ReturnType<typeof setup> = setup({
      decoder: (bytes, metadata, signal) => {
        attempts.push(env.runner.prepare(fixture(), scope, profile))
        return decodeBackgroundRemovalRgbaPng(bytes, metadata, signal)
      },
      resolve: async () => {
        attempts.push(env.runner.prepare(fixture(), scope, profile))
        return env.configuration
      }
    })
    await prepare(env.runner)
    expect(await Promise.all(attempts)).toEqual([fail('BUSY'), fail('BUSY')])
    env.runner.cancel()
  })

  it('publishes one in-flight Promise before isCurrent, approval and backend reentry', async () => {
    const env = setup()
    const review = await prepare(env.runner)
    const repeats: Promise<RunBackgroundRemovalResult>[] = []
    const oldCurrent = env.isCurrent.getMockImplementation()!
    env.isCurrent.mockImplementation((binding) => {
      repeats.push(run(env.runner, review))
      return oldCurrent(binding)
    })
    env.approveNative.mockImplementation(async () => {
      repeats.push(run(env.runner, review))
      return true
    })
    env.backend.mockImplementation(async () => {
      repeats.push(run(env.runner, review))
      return fixture()
    })
    const first = run(env.runner, review)
    expect(run(env.runner, review)).toBe(first)
    expect(await first).toMatchObject({ status: 'result' })
    expect(repeats.length).toBeGreaterThan(2)
    for (const repeat of repeats) expect(repeat).toBe(first)
    expect(env.backend).toHaveBeenCalledOnce()
    expect(env.approveNative).toHaveBeenCalledOnce()
  })

  it('rejects wrong scope/hash while the matching run is already in flight', async () => {
    const env = setup()
    const review = await prepare(env.runner)
    const gate = deferred<boolean>()
    env.approveNative.mockReturnValue(gate.promise)
    const pending = run(env.runner, review)
    expect(
      await env.runner.run(review.receiptId, review.reviewHash, { ...scope, senderId: 9 })
    ).toEqual(fail('INVALID_RECEIPT'))
    expect(await env.runner.run(review.receiptId, '0'.repeat(64), scope)).toEqual(
      fail('INVALID_RECEIPT')
    )
    expect(run(env.runner, review)).toBe(pending)
    gate.resolve(true)
    expect(await pending).toMatchObject({ status: 'result' })
    expect(env.approveNative).toHaveBeenCalledOnce()
  })

  it.each(['isCurrent', 'approval', 'backend'])(
    'synchronous invalidate in %s prevents late success',
    async (stage) => {
      const env = setup()
      const review = await prepare(env.runner)
      if (stage === 'isCurrent')
        env.isCurrent.mockImplementation(() => {
          env.runner.invalidate()
          return true
        })
      if (stage === 'approval')
        env.approveNative.mockImplementation(async () => {
          env.runner.invalidate()
          return true
        })
      if (stage === 'backend')
        env.backend.mockImplementation(async () => {
          env.runner.invalidate()
          return fixture()
        })
      expect(await run(env.runner, review)).toEqual(fail('REVOKED'))
      if (stage !== 'backend') expect(env.backend).not.toHaveBeenCalled()
    }
  )

  it.each(
    ['decode', 'readiness', 'approval', 'backend', 'output'].flatMap((stage) =>
      [false, true].map((reject) => [stage, reject] as const)
    )
  )('cancel retains capacity until ignoring %s work settles (reject=%s)', async (stage, reject) => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    let decodes = 0
    let blocked = false
    let seenSignal: AbortSignal | undefined
    const block = async (signal?: AbortSignal) => {
      // Only the first operation stalls; the capacity probe must not reuse a rejected gate.
      if (blocked) return
      blocked = true
      seenSignal = signal
      entered.resolve()
      await gate.promise
    }
    const env: ReturnType<typeof setup> = setup({
      decoder: async (bytes, metadata, signal) => {
        decodes++
        if ((stage === 'decode' && decodes === 1) || (stage === 'output' && decodes === 2))
          await block(signal)
        return decodeBackgroundRemovalRgbaPng(bytes, metadata)
      },
      resolve: async (_profile, signal) => {
        if (stage === 'readiness') await block(signal)
        return env.configuration
      },
      approveNative: async (_review, signal) => {
        if (stage === 'approval') await block(signal)
        return true
      }
    })
    env.backend.mockImplementation(async (_bytes, _metadata, signal) => {
      if (stage === 'backend') await block(signal)
      return fixture()
    })
    const pending =
      stage === 'decode' || stage === 'readiness'
        ? env.runner.prepare(fixture(), scope, profile)
        : run(env.runner, await prepare(env.runner))
    await entered.promise
    let settled = false
    void pending.then(() => {
      settled = true
    })
    env.runner.cancel()
    expect(seenSignal?.aborted).toBe(true)
    expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('BUSY'))
    expect(settled).toBe(false)
    if (reject) gate.reject(new Error('late SECRET path'))
    else gate.resolve()
    expect(await pending).toEqual(fail('CANCELLED'))
    await prepare(env.runner)
    env.runner.cancel()
  })

  it('retains capacity even when a callback synchronously cancels then returns pending work', async () => {
    const gate = deferred<boolean>()
    const env = setup()
    const review = await prepare(env.runner)
    const attempts: Promise<unknown>[] = []
    env.approveNative.mockImplementation((_review, signal) => {
      signal.addEventListener(
        'abort',
        () => {
          attempts.push(env.runner.prepare(fixture(), scope, profile))
        },
        { once: true }
      )
      env.runner.cancel()
      return gate.promise
    })
    const pending = run(env.runner, review)
    expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('BUSY'))
    expect(await Promise.all(attempts)).toEqual([fail('BUSY')])
    expect(run(env.runner, review)).toBe(pending)
    gate.resolve(true)
    expect(await pending).toEqual(fail('CANCELLED'))
    expect(env.backend).not.toHaveBeenCalled()
  })

  it('guards outer result settlement and retains capacity across its final microtask', async () => {
    let decodes = 0
    let outputDecoded = false
    let checksAfterDecode = 0
    let attempt: Promise<unknown> | undefined
    const env = setup({
      decoder: async (bytes, metadata, signal) => {
        const decoded = await decodeBackgroundRemovalRgbaPng(bytes, metadata, signal)
        if (++decodes === 2) outputDecoded = true
        return decoded
      }
    })
    const review = await prepare(env.runner)
    env.isCurrent.mockImplementation(() => {
      // Decoder, validation-call and executeRun each check after their await. Invalidate
      // after executeRun's final check, but BEFORE the outer run Promise delivers bytes.
      if (outputDecoded && ++checksAfterDecode === 3)
        queueMicrotask(() => {
          env.runner.invalidate()
          attempt = env.runner.prepare(fixture(), scope, profile)
        })
      return true
    })
    expect(await run(env.runner, review)).toEqual(fail('REVOKED'))
    expect(attempt).toBeDefined()
    expect(await attempt).toEqual(fail('BUSY'))
  })

  it.each(['decode', 'readiness', 'review', 'approval', 'backend', 'output'])(
    'absolute expiry covers %s without freeing outstanding capacity',
    async (stage) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
      const gate = deferred<void>()
      const entered = deferred<void>()
      let decodes = 0
      const block = async () => {
        entered.resolve()
        await gate.promise
      }
      const env: ReturnType<typeof setup> = setup({
        decoder: async (bytes, metadata) => {
          decodes++
          if ((stage === 'decode' && decodes === 1) || (stage === 'output' && decodes === 2))
            await block()
          return decodeBackgroundRemovalRgbaPng(bytes, metadata)
        },
        resolve: async () => {
          if (stage === 'readiness') await block()
          return env.configuration
        },
        approveNative: async () => {
          if (stage === 'approval') await block()
          return true
        }
      })
      env.backend.mockImplementation(async () => {
        if (stage === 'backend') await block()
        return fixture()
      })
      if (stage === 'review') {
        const review = await prepare(env.runner)
        await vi.advanceTimersByTimeAsync(120_000)
        expect(await run(env.runner, review)).toEqual(fail('INVALID_RECEIPT'))
      } else {
        const pending =
          stage === 'decode' || stage === 'readiness'
            ? env.runner.prepare(fixture(), scope, profile)
            : run(env.runner, await prepare(env.runner))
        await entered.promise
        let settled = false
        void pending.then(() => {
          settled = true
        })
        await vi.advanceTimersByTimeAsync(120_000)
        expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('BUSY'))
        expect(settled).toBe(false)
        gate.resolve()
        expect(await pending).toEqual(fail('EXPIRED'))
      }
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('uses one unref timer and clears it on discard', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const env = setup()
    const review = await prepare(env.runner)
    expect(timer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 120_000)
    const handle = timer.mock.results[0].value as ReturnType<typeof setTimeout>
    expect(handle.hasRef()).toBe(false)
    env.runner.discard(review.receiptId, review.reviewHash, scope)
    expect(clear).toHaveBeenCalledWith(handle)
  })

  it('includes time spent decoding and resolving readiness in the review deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const start = Date.now()
    const env: ReturnType<typeof setup> = setup({
      decoder: async (bytes, metadata, signal) => {
        vi.setSystemTime(Date.now() + 20_000)
        return decodeBackgroundRemovalRgbaPng(bytes, metadata, signal)
      },
      resolve: async () => {
        vi.setSystemTime(Date.now() + 30_000)
        return env.configuration
      }
    })
    const review = await prepare(env.runner)
    expect(review.binding.expiresAt).toBe(start + 120_000)
    expect(review.binding.expiresAt - Date.now()).toBe(70_000)
    env.runner.cancel()
  })

  it('does not reset the 120s deadline at Run or native approval', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    const env = setup()
    const review = await prepare(env.runner)
    await vi.advanceTimersByTimeAsync(119_999)
    const gate = deferred<boolean>()
    env.approveNative.mockReturnValue(gate.promise)
    const pending = run(env.runner, review)
    await vi.advanceTimersByTimeAsync(1)
    gate.resolve(true)
    expect(await pending).toEqual(fail('EXPIRED'))
    expect(env.backend).not.toHaveBeenCalled()
    expect(MAX_BACKGROUND_REMOVAL_LIFETIME_MS).toBe(120_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['before', 'during'])(
    'checks deadline %s isCurrent even if timers have not fired',
    async (when) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const env = setup()
      const review = await prepare(env.runner)
      if (when === 'before') vi.setSystemTime(review.binding.expiresAt)
      else
        env.isCurrent.mockImplementation(() => {
          vi.setSystemTime(review.binding.expiresAt)
          return true
        })
      expect(await run(env.runner, review)).toEqual(fail('EXPIRED'))
      expect(env.approveNative).not.toHaveBeenCalled()
    }
  )

  it('does not extend lifetime when the wall clock moves backwards', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    const env = setup()
    const review = await prepare(env.runner)
    vi.setSystemTime(Date.now() - 1_000_000)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await run(env.runner, review)).toEqual(fail('INVALID_RECEIPT'))
    expect(env.backend).not.toHaveBeenCalled()
  })

  it('rechecks full configuration after backend/output decode and discards late data', async () => {
    for (const stage of ['backend', 'output']) {
      let decodes = 0
      const env: ReturnType<typeof setup> = setup({
        decoder: async (bytes, metadata, signal) => {
          const decoded = await decodeBackgroundRemovalRgbaPng(bytes, metadata, signal)
          if (++decodes === 2 && stage === 'output') env.configuration.authorityEpoch++
          return decoded
        }
      })
      const review = await prepare(env.runner)
      env.backend.mockImplementation(async () => {
        if (stage === 'backend') env.configuration.descriptor.destination = 'changed'
        return fixture()
      })
      expect(await run(env.runner, review)).toEqual(fail('REVOKED'))
    }
  })

  it('discards a review synchronously and discards a running operation cooperatively', async () => {
    const env = setup()
    const first = await prepare(env.runner)
    expect(env.runner.discard(first.receiptId, first.reviewHash, scope)).toEqual({
      status: 'discarded'
    })
    expect(await run(env.runner, first)).toEqual(fail('INVALID_RECEIPT'))
    const second = await prepare(env.runner)
    const gate = deferred<boolean>()
    env.approveNative.mockReturnValue(gate.promise)
    const pending = run(env.runner, second)
    expect(env.runner.discard(second.receiptId, second.reviewHash, scope)).toEqual({
      status: 'discarded'
    })
    expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('BUSY'))
    gate.resolve(true)
    expect(await pending).toEqual(fail('CANCELLED'))
  })
})

describe('real decoder validation at runner boundaries', () => {
  it.each([
    ['malformed', Buffer.from('not PNG')],
    ['truncated', fixture().subarray(0, -1)],
    [
      'truncated deflate with valid PNG CRC',
      fixture([0, 255], deflateSync(Buffer.from([0, 1, 2, 3, 0, 1, 2, 3, 255])).subarray(0, -1))
    ],
    ['wrong size', fixture([0])],
    ['opaque', fixture([255, 255])],
    ['transparent', fixture([0, 0])]
  ])('rejects %s output', async (_label, bytes) => {
    const env = setup()
    const review = await prepare(env.runner)
    env.backend.mockResolvedValue(bytes)
    expect(await run(env.runner, review)).toEqual(fail('INVALID_OUTPUT'))
  })

  it.each(['proxy', 'shared', 'detached', 'malformed'])(
    'rejects %s source before resolver/approval',
    async (kind) => {
      const trap = vi.fn(() => {
        throw new Error('must not access proxy')
      })
      const source =
        kind === 'proxy'
          ? new Proxy(fixture(), { get: trap })
          : kind === 'shared'
            ? Buffer.from(new SharedArrayBuffer(100))
            : kind === 'malformed'
              ? Buffer.from('bad image')
              : Buffer.alloc(100)
      if (kind === 'detached') structuredClone(source.buffer, { transfer: [source.buffer] })
      const env = setup()
      expect(await env.runner.prepare(source, scope, profile)).toEqual(fail('INVALID_INPUT'))
      expect(env.resolve).not.toHaveBeenCalled()
      expect(env.approveNative).not.toHaveBeenCalled()
      expect(trap).not.toHaveBeenCalled()
    }
  )
})

// Keep node:perf_hooks (reader) and the global performance (runner) on the same clock.
// Fake Date/timers alone do not replace the reader's imported monotonic clock.
function sharedClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  let monotonic = 10_000
  vi.spyOn(globalThis.performance, 'now').mockImplementation(() => monotonic)
  if (!Object.is(nodePerformance, globalThis.performance))
    vi.spyOn(nodePerformance, 'now').mockImplementation(() => monotonic)
  return {
    advance(ms: number) {
      monotonic += ms
      vi.advanceTimersByTime(ms)
    },
    jump(wallMs: number, monoMs: number) {
      vi.setSystemTime(Date.now() + wallMs)
      monotonic += monoMs
    }
  }
}
function sharedDeadline(ms = 120_000, signal?: AbortSignal) {
  return { expiresAt: Date.now() + ms, monotonicDeadline: performance.now() + ms, signal }
}
async function prepareShared(
  runner: ReturnType<typeof createBackgroundRemovalRunner>,
  deadline: TrustedBackgroundRemovalDeadline
) {
  const result = await runner.prepare(fixture(), scope, profile, deadline)
  expect(result.status).toBe('review')
  if (result.status !== 'review') throw new Error('expected shared-deadline review')
  return result.review
}

describe('optional trusted-main shared deadline envelope', () => {
  it('snapshots both deadlines and signal before decode without widening the review binding', async () => {
    const clock = sharedClock()
    const controller = new AbortController()
    const replacement = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const deadline = sharedDeadline(1_000, controller.signal)
    const expiresAt = deadline.expiresAt
    const gate = deferred<void>()
    const env = setup({
      decoder: async (bytes, metadata, signal) => {
        await gate.promise
        return decodeBackgroundRemovalRgbaPng(bytes, metadata, signal)
      }
    })
    const pending = env.runner.prepare(fixture(), scope, profile, deadline)
    deadline.expiresAt += 119_000
    deadline.monotonicDeadline += 119_000
    deadline.signal = replacement.signal
    gate.resolve()
    const prepared = await pending
    expect(prepared.status).toBe('review')
    if (prepared.status !== 'review') throw new Error('expected review')
    expect(prepared.review.binding.expiresAt).toBe(expiresAt)
    expect(Object.keys(prepared.review.binding)).toEqual([
      'scope',
      'source',
      'backgroundRemovalProfileId',
      'authorityEpoch',
      'backend',
      'expiresAt'
    ])
    expect(JSON.stringify(prepared.review)).not.toMatch(/monotonicDeadline|signal/)
    expect(prepared.review.reviewHash).toBe(
      createHash('sha256')
        .update(BACKGROUND_REMOVAL_REVIEW_DOMAIN)
        .update(
          JSON.stringify({ receiptId: prepared.review.receiptId, binding: prepared.review.binding })
        )
        .digest('hex')
    )
    replacement.abort()
    expect(vi.getTimerCount()).toBe(1)
    clock.advance(1_000)
    expect(await run(env.runner, prepared.review)).toEqual(fail('INVALID_RECEIPT'))
    expect(remove).toHaveBeenCalledOnce()
    expect(env.approveNative).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects malformed, nonfinite, over-120s and non-AbortSignal envelopes without callbacks', async () => {
    sharedClock()
    const valid = sharedDeadline(30_000)
    const invalid = [
      null,
      {},
      ...['expiresAt', 'monotonicDeadline'].flatMap((key) =>
        [undefined, NaN, Infinity, -Infinity, '120000'].map((value) => ({ ...valid, [key]: value }))
      ),
      { ...valid, expiresAt: Date.now() + 120_001 },
      { ...valid, monotonicDeadline: performance.now() + 120_001 },
      { ...valid, expiresAt: Date.now() - 1, monotonicDeadline: performance.now() + 120_001 },
      { ...valid, signal: null },
      { ...valid, signal: { aborted: false, addEventListener: vi.fn() } }
    ]
    for (const deadline of invalid) {
      const decoder = vi.fn(decodeBackgroundRemovalRgbaPng)
      const env = setup({ decoder })
      expect(
        await env.runner.prepare(
          fixture(),
          scope,
          profile,
          deadline as TrustedBackgroundRemovalDeadline
        )
      ).toEqual(fail('INVALID_REQUEST'))
      expect(decoder).not.toHaveBeenCalled()
      expect(env.resolve).not.toHaveBeenCalled()
      expect(env.isCurrent).not.toHaveBeenCalled()
      expect(env.approveNative).not.toHaveBeenCalled()
      expect(env.backend).not.toHaveBeenCalled()
      env.runner.cancel()
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('rejects finite past or exactly elapsed absolute deadlines before any callback', async () => {
    sharedClock()
    for (const key of ['expiresAt', 'monotonicDeadline'] as const) {
      for (const elapsed of [0, 1, 1_000_000_000_000_000]) {
        const deadline = sharedDeadline(30_000)
        deadline[key] = (key === 'expiresAt' ? Date.now() : performance.now()) - elapsed
        const decoder = vi.fn(decodeBackgroundRemovalRgbaPng)
        const env = setup({ decoder })
        expect(await env.runner.prepare(fixture(), scope, profile, deadline)).toEqual(
          fail('EXPIRED')
        )
        expect(decoder).not.toHaveBeenCalled()
        expect(env.resolve).not.toHaveBeenCalled()
        expect(env.isCurrent).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      }
    }
  })

  it('pre-abort returns CANCELLED before decode/readiness/current/approval callbacks', async () => {
    sharedClock()
    const controller = new AbortController()
    controller.abort()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const decoder = vi.fn(decodeBackgroundRemovalRgbaPng)
    const env = setup({ decoder })
    expect(
      await env.runner.prepare(fixture(), scope, profile, sharedDeadline(30_000, controller.signal))
    ).toEqual(fail('CANCELLED'))
    expect(decoder).not.toHaveBeenCalled()
    expect(env.resolve).not.toHaveBeenCalled()
    expect(env.isCurrent).not.toHaveBeenCalled()
    expect(env.approveNative).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await prepare(env.runner)
    env.runner.cancel()
  })

  it.each(['wall', 'monotonic'])(
    'uses the earlier %s remaining duration for one unref timer',
    async (earlier) => {
      const clock = sharedClock()
      const timer = vi.spyOn(globalThis, 'setTimeout')
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const deadline = sharedDeadline(1_000, controller.signal)
      if (earlier === 'wall') deadline.expiresAt = Date.now() + 100
      else deadline.monotonicDeadline = performance.now() + 100
      const env = setup()
      const review = await prepareShared(env.runner, deadline)
      expect(timer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 100)
      expect((timer.mock.results[0].value as ReturnType<typeof setTimeout>).hasRef()).toBe(false)
      clock.advance(99)
      expect(remove).not.toHaveBeenCalled()
      clock.advance(1)
      expect(await run(env.runner, review)).toEqual(fail('INVALID_RECEIPT'))
      expect(remove).toHaveBeenCalledOnce()
      expect(env.approveNative).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['wall', 'monotonic'])(
    'checks the shared %s deadline before and after current even without timers',
    async (elapsed) => {
      const clock = sharedClock()
      for (const when of ['before', 'during']) {
        const env = setup()
        const review = await prepareShared(env.runner, sharedDeadline(30_000))
        const jump = () =>
          clock.jump(elapsed === 'wall' ? 30_000 : -30_000, elapsed === 'monotonic' ? 30_000 : 0)
        if (when === 'before') jump()
        else
          env.isCurrent.mockImplementation(() => {
            jump()
            return true
          })
        expect(await run(env.runner, review)).toEqual(fail('EXPIRED'))
        expect(env.approveNative).not.toHaveBeenCalled()
        expect(env.backend).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      }
    }
  )

  it('detaches its only external listener on all review/run terminal paths, never per Run', async () => {
    const clock = sharedClock()
    for (const terminal of [
      'expiry',
      'discard',
      'cancel',
      'invalidate',
      'external abort',
      'approval denied',
      'approval unavailable',
      'approval throws',
      'backend fails',
      'output invalid',
      'success'
    ]) {
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, 'addEventListener')
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const env = setup(terminal === 'approval unavailable' ? { approveNative: undefined } : {})
      const review = await prepareShared(env.runner, sharedDeadline(1_000, controller.signal))
      expect(add).toHaveBeenCalledExactlyOnceWith(
        'abort',
        expect.any(Function),
        expect.objectContaining({ once: true })
      )
      const listener = add.mock.calls[0][1]
      expect(getEventListeners(controller.signal, 'abort')).toEqual([listener])
      expect(remove).not.toHaveBeenCalled()
      if (terminal === 'expiry') clock.advance(1_000)
      else if (terminal === 'discard')
        env.runner.discard(review.receiptId, review.reviewHash, scope)
      else if (terminal === 'cancel') env.runner.cancel()
      else if (terminal === 'invalidate') env.runner.invalidate()
      else if (terminal === 'external abort') controller.abort()
      else {
        if (terminal === 'approval denied') env.approveNative.mockResolvedValue(false)
        if (terminal === 'approval throws')
          env.approveNative.mockRejectedValue(new Error('synthetic failure'))
        if (terminal === 'backend fails')
          env.backend.mockRejectedValue(new Error('synthetic failure'))
        if (terminal === 'output invalid') env.backend.mockResolvedValue(Buffer.from('bad PNG'))
        const pending = run(env.runner, review)
        expect(run(env.runner, review)).toBe(pending)
        const result = await pending
        expect(result).toMatchObject(
          terminal === 'success' ? { status: 'result' } : { status: 'error' }
        )
      }
      expect(add).toHaveBeenCalledOnce()
      expect(remove).toHaveBeenCalledExactlyOnceWith('abort', listener)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(await run(env.runner, review)).toEqual(fail('INVALID_RECEIPT'))
      await prepare(env.runner)
      controller.abort()
      expect(vi.getTimerCount()).toBe(1)
      env.runner.cancel()
    }
  })

  it('detaches on prepare failures as well as successful review/run lifetimes', async () => {
    sharedClock()
    for (const terminal of [
      'scope',
      'input',
      'decoder missing',
      'decoder throws',
      'resolve missing',
      'resolve throws',
      'current denied'
    ]) {
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, 'addEventListener')
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const throws = async () => {
        throw new Error('synthetic failure')
      }
      const env = setup({
        ...(terminal === 'decoder missing' ? { decoder: undefined } : {}),
        ...(terminal === 'decoder throws' ? { decoder: throws } : {}),
        ...(terminal === 'resolve missing' ? { resolve: undefined } : {}),
        ...(terminal === 'resolve throws' ? { resolve: throws } : {}),
        ...(terminal === 'current denied' ? { isCurrent: () => false } : {})
      })
      const result = await env.runner.prepare(
        terminal === 'input' ? Buffer.from('bad PNG') : fixture(),
        terminal === 'scope' ? { ...scope, sourceId: '' } : scope,
        profile,
        sharedDeadline(30_000, controller.signal)
      )
      expect(result.status).toBe('error')
      expect(add).toHaveBeenCalledOnce()
      expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0][1])
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it.each(['decode', 'readiness', 'approval', 'backend', 'output'])(
    'synchronous external abort in %s aborts immediately but drains work and preserves reentrant capacity',
    async (stage) => {
      sharedClock()
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, 'addEventListener')
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const gate = deferred<void>()
      const entered = deferred<void>()
      const attempts: Promise<unknown>[] = []
      let seenSignal: AbortSignal | undefined
      let decodes = 0
      const block = async (signal?: AbortSignal) => {
        seenSignal = signal
        signal?.addEventListener(
          'abort',
          () => {
            attempts.push(env.runner.prepare(fixture(), scope, profile))
          },
          { once: true }
        )
        controller.abort()
        entered.resolve()
        await gate.promise
      }
      const env: ReturnType<typeof setup> = setup({
        decoder: async (bytes, metadata, signal) => {
          decodes++
          if ((stage === 'decode' && decodes === 1) || (stage === 'output' && decodes === 2))
            await block(signal)
          return decodeBackgroundRemovalRgbaPng(bytes, metadata)
        },
        resolve: async (_profile, signal) => {
          if (stage === 'readiness') await block(signal)
          return env.configuration
        },
        approveNative: async (_review, signal) => {
          if (stage === 'approval') await block(signal)
          return true
        }
      })
      env.backend.mockImplementation(async (_bytes, _metadata, signal) => {
        if (stage === 'backend') await block(signal)
        return fixture()
      })
      const deadline = sharedDeadline(30_000, controller.signal)
      const review =
        stage === 'decode' || stage === 'readiness'
          ? undefined
          : await prepareShared(env.runner, deadline)
      const pending = review
        ? run(env.runner, review)
        : env.runner.prepare(fixture(), scope, profile, deadline)
      await entered.promise
      let settled = false
      void pending.then(() => {
        settled = true
      })
      try {
        expect(seenSignal).not.toBe(controller.signal)
        expect(seenSignal?.aborted).toBe(true)
        expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('BUSY'))
        expect(await Promise.all(attempts)).toEqual([fail('BUSY')])
        expect(settled).toBe(false)
        if (review) expect(run(env.runner, review)).toBe(pending)
        expect(add).toHaveBeenCalledOnce()
        expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0][1])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        gate.resolve()
      }
      expect(await pending).toEqual(fail('CANCELLED'))
      expect(remove).toHaveBeenCalledOnce()
      env.runner.cancel()
    }
  )

  it('keeps the external abort listener until the guarded outer result settlement', async () => {
    sharedClock()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let decodes = 0
    let outputDecoded = false
    let checksAfterDecode = 0
    let attempt: Promise<unknown> | undefined
    const env = setup({
      decoder: async (bytes, metadata, signal) => {
        const decoded = await decodeBackgroundRemovalRgbaPng(bytes, metadata, signal)
        if (++decodes === 2) outputDecoded = true
        return decoded
      }
    })
    const review = await prepareShared(env.runner, sharedDeadline(30_000, controller.signal))
    env.isCurrent.mockImplementation(() => {
      if (outputDecoded && ++checksAfterDecode === 3)
        queueMicrotask(() => {
          controller.abort()
          attempt = env.runner.prepare(fixture(), scope, profile)
        })
      return true
    })
    expect(await run(env.runner, review)).toEqual(fail('CANCELLED'))
    expect(await attempt).toEqual(fail('BUSY'))
    expect(remove).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('test-only actual selected-source reader to runner deadline sharing', () => {
  let root: string
  let selected: string
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'd04-shared-deadline-worker-')))
    selected = path.join(root, 'synthetic.png')
    await fs.writeFile(selected, fixture())
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  async function readSource(
    clock: ReturnType<typeof sharedClock>,
    deadline: TrustedBackgroundRemovalDeadline,
    chooserMs = 40_000
  ) {
    const reader = createSelectedSourceReader({
      chooseNative: async () => {
        clock.advance(chooserMs)
        return selected
      },
      isCurrent: () => true
    })
    const source = await reader.readSelected(scope, deadline)
    expect(source.status).toBe('source')
    if (source.status !== 'source') throw new Error('expected synthetic selected source')
    expect(source.bytes).toEqual(fixture())
    expect(vi.getTimerCount()).toBe(0)
    return source
  }

  it('retains pre-chooser expiresAt and only the remaining timer through real read, prepare and review', async () => {
    const clock = sharedClock()
    const controller = new AbortController()
    const deadline = sharedDeadline(120_000, controller.signal)
    const source = await readSource(clock, deadline)
    expect(source.expiresAt).toBe(deadline.expiresAt)
    expect(source.expiresAt - Date.now()).toBe(80_000)
    expect(deadline.monotonicDeadline - nodePerformance.now()).toBe(80_000)
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const env = setup()
    const prepared = await env.runner.prepare(source.bytes, source.scope, profile, deadline)
    expect(prepared.status).toBe('review')
    if (prepared.status !== 'review') throw new Error('expected review')
    expect(prepared.review.binding.expiresAt).toBe(source.expiresAt)
    expect(prepared.review.binding.source.sha256).toBe(source.sha256)
    expect(timer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 80_000)
    clock.advance(80_000)
    expect(await run(env.runner, prepared.review)).toEqual(fail('INVALID_RECEIPT'))
    expect(env.approveNative).not.toHaveBeenCalled()
    expect(env.backend).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['wall', 'monotonic'])(
    'rejects %s expiry between read delivery and prepare without decoding',
    async (elapsed) => {
      const clock = sharedClock()
      const deadline = sharedDeadline()
      const source = await readSource(clock, deadline)
      clock.jump(elapsed === 'wall' ? 80_000 : 0, elapsed === 'monotonic' ? 80_000 : 0)
      const decoder = vi.fn(decodeBackgroundRemovalRgbaPng)
      const env = setup({ decoder })
      expect(await env.runner.prepare(source.bytes, source.scope, profile, deadline)).toEqual(
        fail('EXPIRED')
      )
      expect(decoder).not.toHaveBeenCalled()
      expect(env.resolve).not.toHaveBeenCalled()
      expect(env.isCurrent).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('rejects an owner abort in the listener-free source-to-prepare interval without decoding', async () => {
    const clock = sharedClock()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const deadline = sharedDeadline(120_000, controller.signal)
    const source = await readSource(clock, deadline)
    expect(add).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0][1])
    controller.abort()
    const decoder = vi.fn(decodeBackgroundRemovalRgbaPng)
    const env = setup({ decoder })
    expect(await env.runner.prepare(source.bytes, source.scope, profile, deadline)).toEqual(
      fail('CANCELLED')
    )
    expect(decoder).not.toHaveBeenCalled()
    expect(env.resolve).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['approval', 'backend'])(
    'counts chooser, review and %s time against the original deadline while draining pending work',
    async (stage) => {
      const clock = sharedClock()
      const controller = new AbortController()
      const deadline = sharedDeadline(120_000, controller.signal)
      const source = await readSource(clock, deadline, 100_000)
      const gate = deferred<void>()
      const entered = deferred<void>()
      let seenSignal: AbortSignal | undefined
      const env = setup()
      const prepared = await env.runner.prepare(source.bytes, source.scope, profile, deadline)
      if (prepared.status !== 'review') throw new Error('expected review')
      clock.advance(10_000)
      env.approveNative.mockImplementation(async (_review, signal) => {
        if (stage === 'approval') {
          seenSignal = signal
          entered.resolve()
          await gate.promise
        } else clock.advance(5_000)
        return true
      })
      env.backend.mockImplementation(async (_bytes, _metadata, signal) => {
        seenSignal = signal
        entered.resolve()
        await gate.promise
        return fixture()
      })
      const pending = run(env.runner, prepared.review)
      await entered.promise
      try {
        clock.advance(stage === 'approval' ? 10_000 : 5_000)
        expect(seenSignal?.aborted).toBe(true)
        expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('BUSY'))
        expect(run(env.runner, prepared.review)).toBe(pending)
      } finally {
        gate.resolve()
      }
      expect(await pending).toEqual(fail('EXPIRED'))
      if (stage === 'approval') expect(env.backend).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})

describe('unsuppressible external abort', () => {
  it.each(['decode', 'readiness', 'approval', 'backend', 'output'] as const)(
    'ignores earlier stopImmediatePropagation during %s, aborts immediately and drains late success',
    async (stage) => {
      sharedClock()
      const controller = new AbortController()
      const suppress = vi.fn((event: Event) => event.stopImmediatePropagation())
      controller.signal.addEventListener('abort', suppress, { once: true })
      const entered = deferred<void>()
      const gate = deferred<void>()
      let internal: AbortSignal | undefined
      let decodes = 0
      const attempts: Promise<unknown>[] = []
      const block = async (signal?: AbortSignal) => {
        internal = signal
        signal?.addEventListener(
          'abort',
          () => attempts.push(env.runner.prepare(fixture(), scope, profile)),
          { once: true }
        )
        entered.resolve()
        await gate.promise
      }
      const env: ReturnType<typeof setup> = setup({
        decoder: async (bytes, metadata, signal) => {
          if (++decodes === (stage === 'decode' ? 1 : stage === 'output' ? 2 : 0))
            await block(signal)
          // Deliberately ignore abort: cancellation must reject even a valid late decode.
          return decodeBackgroundRemovalRgbaPng(bytes, metadata)
        },
        resolve: async (_profile, signal) => {
          if (stage === 'readiness') await block(signal)
          return env.configuration
        },
        approveNative: async (_review, signal) => {
          if (stage === 'approval') await block(signal)
          return true
        }
      })
      env.backend.mockImplementation(async (_bytes, _metadata, signal) => {
        if (stage === 'backend') await block(signal)
        return fixture()
      })
      const limits = sharedDeadline(30_000, controller.signal)
      const review =
        stage === 'decode' || stage === 'readiness'
          ? undefined
          : await prepareShared(env.runner, limits)
      const pending = review
        ? run(env.runner, review)
        : env.runner.prepare(fixture(), scope, profile, limits)
      let settled = false
      void pending.then(() => {
        settled = true
      })
      await entered.promise
      try {
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(2)
        controller.abort(new Error('private abort reason'))
        expect(suppress).toHaveBeenCalledOnce()
        expect(internal).not.toBe(controller.signal)
        expect.soft(internal?.aborted).toBe(true)
        expect.soft(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('BUSY'))
        expect.soft(await Promise.all(attempts)).toEqual([fail('BUSY')])
        expect(settled).toBe(false)
        if (review) expect(run(env.runner, review)).toBe(pending)
      } finally {
        gate.resolve()
      }
      expect.soft(await pending).toEqual(fail('CANCELLED'))
      env.runner.cancel()
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      await prepare(env.runner)
      env.runner.cancel()
    }
  )

  it('cancels an idle review despite an earlier suppressing listener', async () => {
    sharedClock()
    const controller = new AbortController()
    controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation(), {
      once: true
    })
    const env = setup()
    const review = await prepareShared(env.runner, sharedDeadline(30_000, controller.signal))
    controller.abort()
    expect.soft(await run(env.runner, review)).toEqual(fail('INVALID_RECEIPT'))
    expect.soft(env.approveNative).not.toHaveBeenCalled()
    expect.soft(env.backend).not.toHaveBeenCalled()
    env.runner.cancel()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases the reserved slot and timer when listener installation throws', async () => {
    sharedClock()
    const controller = new AbortController()
    const decoder = vi.fn(decodeBackgroundRemovalRgbaPng)
    const env = setup({ decoder })
    let attempt: Promise<unknown> | undefined
    vi.spyOn(controller.signal, 'addEventListener').mockImplementationOnce(() => {
      attempt = env.runner.prepare(fixture(), scope, profile)
      throw new Error('synthetic listener installation failure')
    })
    expect(
      await env.runner.prepare(fixture(), scope, profile, sharedDeadline(30_000, controller.signal))
    ).toEqual(fail('UNAVAILABLE'))
    expect(await attempt).toEqual(fail('BUSY'))
    expect(decoder).not.toHaveBeenCalled()
    expect(env.resolve).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    await prepareShared(env.runner, sharedDeadline(30_000, controller.signal))
    env.runner.cancel()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('external subscription lifecycle during pending work', () => {
  it.each(['cancel', 'invalidate', 'discard', 'expiry'] as const)(
    'detaches exactly once on %s without releasing an uncooperative backend',
    async (terminal) => {
      const clock = sharedClock()
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, 'addEventListener')
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const entered = deferred<void>()
      const gate = deferred<void>()
      const env = setup()
      env.backend.mockImplementationOnce(async () => {
        entered.resolve()
        await gate.promise
        return fixture()
      })
      const review = await prepareShared(env.runner, sharedDeadline(1_000, controller.signal))
      const pending = run(env.runner, review)
      await entered.promise
      try {
        expect(getEventListeners(controller.signal, 'abort')).toEqual([add.mock.calls[0][1]])
        if (terminal === 'expiry') clock.advance(1_000)
        else if (terminal === 'discard')
          expect(env.runner.discard(review.receiptId, review.reviewHash, scope)).toEqual({
            status: 'discarded'
          })
        else env.runner[terminal]()
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        expect(await env.runner.prepare(fixture(), scope, profile)).toEqual(fail('BUSY'))
        expect(run(env.runner, review)).toBe(pending)
      } finally {
        gate.resolve()
      }
      expect(await pending).toEqual(
        fail(
          terminal === 'expiry' ? 'EXPIRED' : terminal === 'invalidate' ? 'REVOKED' : 'CANCELLED'
        )
      )
      expect(add).toHaveBeenCalledOnce()
      expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0][1])
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
