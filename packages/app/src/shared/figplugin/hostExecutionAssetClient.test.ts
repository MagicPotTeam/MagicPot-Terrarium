import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { readExecutionAsset, validateExecutionAsset } from './hostExecutionAssetClient'
import { figPluginExecutionAssetSchema } from './hostExecutionAssets'

const now = 1_800_000_000_000
const identity = {
  sessionId: '1'.repeat(32),
  pluginId: 'test-plugin',
  projectId: 'project',
  host: 'figma' as const
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const intent = {
  callId: '4'.repeat(32),
  executionId: '5'.repeat(32),
  actionId: '6'.repeat(32),
  planSha256: '7'.repeat(64),
  expiresAt: now + 110000
}
const fixture = (size = 24577) => {
  const bytes = new Uint8Array(size).map((_, index) => index % 251)
  const asset = figPluginExecutionAssetSchema.parse({
    version: 1,
    kind: 'execution-image-asset',
    purpose: 'host-plan-execution',
    ...identity,
    assetId: '2'.repeat(32),
    mimeType: 'image/png',
    sha256: hash(bytes),
    sizeBytes: bytes.length,
    width: 40,
    height: 30,
    chunkSize: 24576,
    chunkCount: Math.ceil(bytes.length / 24576),
    createdAt: now,
    expiresAt: now + 120000
  })
  const frames = Array.from({ length: asset.chunkCount }, (_, index) => ({
    protocol: 1,
    purpose: 'host-plan-execution',
    sessionId: identity.sessionId,
    assetId: asset.assetId,
    callId: intent.callId,
    executionId: intent.executionId,
    actionId: intent.actionId,
    planSha256: intent.planSha256,
    chunk: {
      version: 1,
      kind: 'content-addressed-binary-chunk',
      sha256: asset.sha256,
      index,
      chunkCount: asset.chunkCount,
      bytesBase64: Buffer.from(bytes.subarray(index * 24576, (index + 1) * 24576)).toString(
        'base64'
      )
    }
  }))
  return { asset, bytes, frames }
}

describe('claim-bound portable execution asset reader', () => {
  it('reads exact raw bytes using execution-only action-bound requests without browser globals', async () => {
    const { asset, bytes, frames } = fixture()
    const readChunk = vi.fn(({ index }) => frames[index])
    vi.stubGlobal('atob', undefined)
    vi.stubGlobal('btoa', undefined)
    vi.stubGlobal('crypto', undefined)
    try {
      expect(
        await readExecutionAsset(asset, {
          identity,
          intent,
          now: () => now,
          readChunk,
          sha256: hash
        })
      ).toEqual(bytes)
      expect(readChunk.mock.calls.map(([request]) => request)).toEqual(
        [0, 1].map((index) => ({
          protocol: 1,
          purpose: 'host-plan-execution',
          callId: intent.callId,
          executionId: intent.executionId,
          actionId: intent.actionId,
          planSha256: intent.planSha256,
          assetId: asset.assetId,
          sha256: asset.sha256,
          index
        }))
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reads the existing maximum raw image budget without enlarging frames', async () => {
    const { asset, bytes, frames } = fixture(8 * 1024 * 1024)
    const result = await readExecutionAsset(asset, {
      identity,
      intent,
      now: () => now,
      readChunk: ({ index }) => frames[index],
      sha256: hash
    })
    expect(hash(result)).toBe(hash(bytes))
    expect(frames).toHaveLength(342)
  })

  it.each([
    { sessionId: 'a'.repeat(32) },
    { pluginId: 'other-plugin' },
    { projectId: 'other' },
    { host: 'photoshop' },
    { purpose: 'local-preview' },
    { kind: 'session-image-asset' },
    { expiresAt: now },
    { createdAt: now + 1 },
    { url: 'https://example.test/image' }
  ])('rejects stale or unbound execution identity %j', (change) => {
    expect(() => validateExecutionAsset({ ...fixture().asset, ...change }, identity, now)).toThrow()
  })

  it.each([
    'callId',
    'executionId',
    'actionId',
    'planSha256',
    'assetId',
    'sessionId',
    'purpose',
    'extra',
    'sha256',
    'index',
    'count',
    'short',
    'tampered',
    'noncanonical',
    'whitespace'
  ])('rejects %s frame substitution before publishing', async (fault) => {
    const { asset, frames } = fixture()
    const changed = structuredClone(frames)
    if (['callId', 'executionId', 'actionId', 'assetId', 'sessionId'].includes(fault))
      Object.assign(changed[0], { [fault]: 'a'.repeat(32) })
    if (fault === 'planSha256') changed[0].planSha256 = 'a'.repeat(64)
    if (fault === 'purpose') changed[0].purpose = 'local-preview'
    if (fault === 'extra') Object.assign(changed[0], { requestId: 'forbidden' })
    if (fault === 'sha256') changed[0].chunk.sha256 = 'a'.repeat(64)
    if (fault === 'index') changed[1].chunk.index = 0
    if (fault === 'count') changed[0].chunk.chunkCount = 3
    if (fault === 'short') changed[0].chunk.bytesBase64 = 'AA=='
    if (fault === 'tampered') changed[1].chunk.bytesBase64 = 'AQ=='
    if (fault === 'noncanonical') changed[1].chunk.bytesBase64 = 'AB=='
    if (fault === 'whitespace') changed[1].chunk.bytesBase64 += '\n'
    await expect(
      readExecutionAsset(asset, {
        identity,
        intent,
        now: () => now,
        sha256: hash,
        readChunk: ({ index }) => changed[index]
      })
    ).rejects.toThrow()
  })

  it('rejects expired, malformed or asset-outliving intents before sending a request', async () => {
    const { asset } = fixture()
    const readChunk = vi.fn()
    for (const change of [
      { expiresAt: now },
      { expiresAt: asset.expiresAt + 1 },
      { expiresAt: NaN },
      { actionId: '' },
      { planSha256: 'a'.repeat(32) }
    ])
      await expect(
        readExecutionAsset(asset, {
          identity,
          intent: { ...intent, ...change },
          now: () => now,
          readChunk,
          sha256: hash
        })
      ).rejects.toThrow()
    expect(readChunk).not.toHaveBeenCalled()
  })

  it('cancels an unresponsive fetch and ignores its late result without hashing', async () => {
    const { asset, frames } = fixture()
    const controller = new AbortController()
    const sha256 = vi.fn(hash)
    let release!: (value: unknown) => void
    const read = readExecutionAsset(asset, {
      identity,
      intent,
      now: () => now,
      sha256,
      signal: controller.signal,
      readChunk: () =>
        new Promise((resolve) => {
          release = resolve
        })
    })
    await Promise.resolve()
    controller.abort()
    await expect(read).rejects.toThrow('CANCELLED')
    release(frames[0])
    await Promise.resolve()
    expect(sha256).not.toHaveBeenCalled()
  })

  it('zeroes the assembled buffer on a failed or cancelled hash and ignores late hashes', async () => {
    const { asset, frames } = fixture()
    for (const cancel of [false, true]) {
      const controller = new AbortController()
      let captured!: Uint8Array
      let late!: (hash: string) => void
      const read = readExecutionAsset(asset, {
        identity,
        intent,
        now: () => now,
        signal: controller.signal,
        readChunk: ({ index }) => frames[index],
        sha256(bytes) {
          captured = bytes
          if (!cancel) return '0'.repeat(64)
          controller.abort()
          return new Promise<string>((resolve) => {
            late = resolve
          })
        }
      })
      await expect(read).rejects.toThrow()
      expect(captured.every((byte) => byte === 0)).toBe(true)
      if (cancel) {
        late(asset.sha256)
        await Promise.resolve()
        expect(captured.every((byte) => byte === 0)).toBe(true)
      }
    }
  })

  it.each(['intent-expired', 'epoch', 'clock-invalid'])(
    'stops on %s after an asynchronous read',
    async (fault) => {
      const { asset, frames } = fixture()
      let time = now
      let current = true
      await expect(
        readExecutionAsset(asset, {
          identity,
          intent,
          now: () => time,
          isCurrent: () => current,
          sha256: hash,
          readChunk: ({ index }) => {
            if (fault === 'intent-expired') time = intent.expiresAt
            if (fault === 'epoch') current = false
            if (fault === 'clock-invalid') time = NaN
            return frames[index]
          }
        })
      ).rejects.toThrow()
    }
  )

  it('deadlines an unresponsive transport and refuses an already cancelled signal', async () => {
    vi.useFakeTimers()
    try {
      const { asset } = fixture()
      const read = readExecutionAsset(asset, {
        identity,
        intent,
        now: () => now,
        deadline: now + 10,
        readChunk: () => new Promise(() => {}),
        sha256: hash
      })
      const checked = expect(read).rejects.toThrow('EXPIRED')
      await vi.advanceTimersByTimeAsync(10)
      await checked
      const controller = new AbortController()
      controller.abort()
      const readChunk = vi.fn()
      await expect(
        readExecutionAsset(asset, {
          identity,
          intent,
          now: () => now,
          signal: controller.signal,
          readChunk,
          sha256: hash
        })
      ).rejects.toThrow('CANCELLED')
      expect(readChunk).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects non-finite or fractional explicit deadlines without reading', async () => {
    const { asset } = fixture()
    const readChunk = vi.fn()
    for (const deadline of [Infinity, NaN, now + 0.5])
      await expect(
        readExecutionAsset(asset, {
          identity,
          intent,
          now: () => now,
          deadline,
          readChunk,
          sha256: hash
        })
      ).rejects.toThrow('DEADLINE')
    expect(readChunk).not.toHaveBeenCalled()
  })
})
