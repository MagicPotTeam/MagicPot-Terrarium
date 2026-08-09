import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { channelManifestSigningPayload, parseChannelManifestV1 } from './channelManifestProtocol'
import {
  ChannelManifestClient,
  type ChannelManifestClock,
  type ChannelManifestFileSystem
} from './channelManifestClient'

const CACHE_PATH = path.resolve('channel-cache', 'nightly.json')
const HIGH_WATER_PATH = `${CACHE_PATH}.high-water`
const URL = 'https://updates.example.test/nightly.json'
const SHA = 'c9a892c000000000000000000000000000000000'
const ROOT = 'https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')

function signedManifest(generatedAt = '2026-07-17T05:40:00Z') {
  const value = {
    schema: 1,
    channel: 'nightly',
    generatedAt,
    releases: [
      {
        version: '1.0.113-nightly.20260717.053138',
        buildId: '20260717-053138-c9a892c',
        commitSha: SHA,
        publishedAt: '2026-07-17T05:40:00Z',
        releaseNotesUrl: `${ROOT}/tag/nightly-20260717`,
        minimumLauncherVersion: '1.0.0',
        artifacts: {
          app: {
            kind: 'app',
            version: '1.0.113-nightly.20260717.053138',
            buildId: '20260717-053138-c9a892c',
            commitSha: SHA,
            runtimeId: 'comfy-win-x64-20260701-a1b2c3d',
            platform: 'win32',
            arch: 'x64',
            url: `${ROOT}/download/nightly-20260717/magicpot-app.zip`,
            sha256: 'a'.repeat(64),
            size: 123,
            unpackedSize: 456,
            entrypoint: 'app/MagicPot.exe',
            createdAt: '2026-07-17T05:40:00Z'
          },
          runtime: {
            kind: 'runtime',
            runtimeId: 'comfy-win-x64-20260701-a1b2c3d',
            platform: 'win32',
            arch: 'x64',
            url: `${ROOT}/download/runtime-20260701/magicpot-runtime.7z`,
            sha256: 'b'.repeat(64),
            size: 789,
            unpackedSize: 999,
            entrypoint: 'python_embeded/python.exe',
            createdAt: '2026-07-01T03:00:00Z'
          }
        }
      }
    ],
    signature: {
      algorithm: 'ed25519',
      keyId: 'release-key-1',
      value: Buffer.alloc(64).toString('base64')
    }
  }
  const parsed = parseChannelManifestV1(value, { expectedChannel: 'nightly' })
  value.signature.value = sign(null, channelManifestSigningPayload(parsed), privateKey).toString(
    'base64'
  )
  return JSON.stringify(value)
}

class MemoryFileSystem implements ChannelManifestFileSystem {
  readonly files = new Map<string, string>()
  failRename = false
  failRenameTarget: string | undefined
  async mkdir(): Promise<void> {
    await Promise.resolve()
  }
  async readFile(target: string): Promise<string> {
    const value = this.files.get(target)
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return value
  }
  async writeFile(target: string, data: string): Promise<void> {
    this.files.set(target, data)
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    if (this.failRename || newPath === this.failRenameTarget) throw new Error('rename failed')
    const value = await this.readFile(oldPath)
    this.files.set(newPath, value)
    this.files.delete(oldPath)
  }
  async unlink(target: string): Promise<void> {
    if (!this.files.delete(target)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }
}

function cache(
  rawManifest: string,
  etag = '"old"',
  lastModified = 'Wed, 15 Jul 2026 10:00:00 GMT'
) {
  return JSON.stringify({
    schema: 1,
    rawManifest,
    etag,
    lastModified,
    verifiedAt: '2026-07-16T00:00:00.000Z'
  })
}

function highWater(rawManifest: string) {
  const manifest = JSON.parse(rawManifest) as {
    generatedAt: string
    releases: Array<{ version: string; buildId: string }>
  }
  return JSON.stringify({
    schema: 1,
    generatedAt: manifest.generatedAt,
    digest: createHash('sha256').update(rawManifest, 'utf8').digest('hex'),
    releaseIdentity:
      manifest.releases.map(({ version, buildId }) => `${version}:${buildId}`).join(',') || 'empty'
  })
}

function createClient(fileSystem: MemoryFileSystem, fetch: typeof globalThis.fetch, extra = {}) {
  return new ChannelManifestClient({
    url: URL,
    channel: 'nightly',
    cachePath: CACHE_PATH,
    publicKeys: { 'release-key-1': publicKey },
    fileSystem,
    fetch,
    uniqueId: () => 'test',
    ...extra
  })
}

describe('ChannelManifestClient', () => {
  let fileSystem: MemoryFileSystem
  let rawManifest: string
  beforeEach(() => {
    fileSystem = new MemoryFileSystem()
    rawManifest = signedManifest()
  })

  it('accepts verified 200 and atomically stores manifest and validators', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(rawManifest, {
          status: 200,
          headers: { ETag: '"new"', 'Last-Modified': 'Fri, 17 Jul 2026 05:40:00 GMT' }
        })
    )
    const result = await createClient(fileSystem, fetch).fetchManifest()
    expect(result.source).toBe('network')
    expect(result.etag).toBe('"new"')
    expect(JSON.parse(fileSystem.files.get(CACHE_PATH)!).rawManifest).toBe(rawManifest)
  })

  it('sends ETag and Last-Modified and uses verified cache on 304', async () => {
    fileSystem.files.set(CACHE_PATH, cache(rawManifest))
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('If-None-Match')).toBe('"old"')
      expect(headers.get('If-Modified-Since')).toBe('Wed, 15 Jul 2026 10:00:00 GMT')
      return new Response(null, { status: 304 })
    }) as typeof globalThis.fetch
    expect((await createClient(fileSystem, fetch).fetchManifest()).source).toBe('revalidated-cache')
  })

  it('rejects 304 without cache', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 304 }))
    await expect(createClient(fileSystem, fetch).fetchManifest()).rejects.toThrow(/without.*cache/)
  })

  it('aborts a timed-out fetch', async () => {
    const clock: ChannelManifestClock = {
      now: () => new Date('2026-07-17T00:00:00Z'),
      setTimeout: (callback) => {
        queueMicrotask(callback)
        return 1
      },
      clearTimeout: () => undefined
    }
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        )
    ) as typeof globalThis.fetch
    await expect(
      createClient(fileSystem, fetch, { clock, timeoutMs: 1 }).fetchManifest()
    ).rejects.toThrow(/Failed to fetch/)
  })

  it('rejects declared and streamed oversized responses', async () => {
    const declared = vi.fn(
      async () => new Response('x', { status: 200, headers: { 'Content-Length': '100' } })
    )
    await expect(
      createClient(fileSystem, declared, { maxResponseBytes: 10 }).fetchManifest()
    ).rejects.toThrow(/size limit/)
    const streamed = vi.fn(async () => new Response('x'.repeat(11), { status: 200 }))
    await expect(
      createClient(fileSystem, streamed, { maxResponseBytes: 10 }).fetchManifest()
    ).rejects.toThrow(/size limit/)
  })

  it('falls back on network error only after re-parsing and re-verifying cache', async () => {
    fileSystem.files.set(CACHE_PATH, cache(rawManifest))
    const fetch = vi.fn(async () => {
      throw new TypeError('offline')
    })
    expect((await createClient(fileSystem, fetch).fetchManifest()).source).toBe(
      'network-error-cache'
    )
    const damaged = JSON.parse(rawManifest)
    damaged.releases[0].artifacts.app.size += 1
    fileSystem.files.set(CACHE_PATH, cache(JSON.stringify(damaged)))
    await expect(createClient(fileSystem, fetch).fetchManifest()).rejects.toThrow(
      /signature verification/
    )
  })

  it('rejects a signed manifest older than the accepted cache high-water mark', async () => {
    const newer = signedManifest('2026-07-18T05:40:00Z')
    fileSystem.files.set(CACHE_PATH, cache(newer))
    const fetch = vi.fn(
      async () => new Response(signedManifest('2026-07-17T05:40:00Z'), { status: 200 })
    )

    await expect(createClient(fileSystem, fetch).fetchManifest()).rejects.toThrow(
      /rollback rejected/
    )
    expect(JSON.parse(fileSystem.files.get(CACHE_PATH)!).rawManifest).toBe(newer)
  })

  it('recovers online when the high-water mark is ahead of an old cache', async () => {
    const oldManifest = signedManifest('2026-07-17T05:40:00Z')
    const currentManifest = signedManifest('2026-07-18T05:40:00Z')
    fileSystem.files.set(CACHE_PATH, cache(oldManifest))
    fileSystem.files.set(HIGH_WATER_PATH, highWater(currentManifest))
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('If-None-Match')).toBe(false)
      return new Response(currentManifest, { status: 200, headers: { ETag: '"current"' } })
    }) as typeof globalThis.fetch

    await expect(createClient(fileSystem, fetch).fetchManifest()).resolves.toMatchObject({
      source: 'network',
      etag: '"current"'
    })
    expect(JSON.parse(fileSystem.files.get(CACHE_PATH)!).rawManifest).toBe(currentManifest)
  })

  it('fails closed offline when the high-water mark is ahead of the cache', async () => {
    const oldManifest = signedManifest('2026-07-17T05:40:00Z')
    const currentManifest = signedManifest('2026-07-18T05:40:00Z')
    fileSystem.files.set(CACHE_PATH, cache(oldManifest))
    fileSystem.files.set(HIGH_WATER_PATH, highWater(currentManifest))
    const fetch = vi.fn(async () => {
      throw new TypeError('offline')
    })

    await expect(createClient(fileSystem, fetch).fetchManifest()).rejects.toThrow(/Failed to fetch/)
  })

  it('rejects a network manifest at the high-water time with a different digest', async () => {
    const accepted = signedManifest('2026-07-18T05:40:00Z')
    const equivocationValue = JSON.parse(accepted)
    equivocationValue.releases[0].version = '1.0.114-nightly.20260718.053138'
    equivocationValue.releases[0].artifacts.app.version = equivocationValue.releases[0].version
    const parsed = parseChannelManifestV1(equivocationValue, { expectedChannel: 'nightly' })
    equivocationValue.signature.value = sign(
      null,
      channelManifestSigningPayload(parsed),
      privateKey
    ).toString('base64')
    const equivocation = JSON.stringify(equivocationValue)
    fileSystem.files.set(CACHE_PATH, cache(signedManifest('2026-07-17T05:40:00Z')))
    fileSystem.files.set(HIGH_WATER_PATH, highWater(accepted))

    await expect(
      createClient(
        fileSystem,
        async () => new Response(equivocation, { status: 200 })
      ).fetchManifest()
    ).rejects.toThrow(/equivocation rejected/)
  })

  it('recovers on the next run after a cache write fails behind a saved high-water mark', async () => {
    const previous = signedManifest('2026-07-17T05:40:00Z')
    const current = signedManifest('2026-07-18T05:40:00Z')
    fileSystem.files.set(CACHE_PATH, cache(previous))
    fileSystem.failRenameTarget = CACHE_PATH

    await expect(
      createClient(fileSystem, async () => new Response(current, { status: 200 })).fetchManifest()
    ).rejects.toThrow(/rename failed/)
    expect(fileSystem.files.get(HIGH_WATER_PATH)).toBe(highWater(current))
    expect(JSON.parse(fileSystem.files.get(CACHE_PATH)!).rawManifest).toBe(previous)

    fileSystem.failRenameTarget = undefined
    await expect(
      createClient(fileSystem, async () => new Response(current, { status: 200 })).fetchManifest()
    ).resolves.toMatchObject({ source: 'network' })
    expect(JSON.parse(fileSystem.files.get(CACHE_PATH)!).rawManifest).toBe(current)
  })

  it('does not hide malicious 200 signature failure behind valid cache', async () => {
    fileSystem.files.set(CACHE_PATH, cache(rawManifest))
    const attacked = JSON.parse(rawManifest)
    attacked.releases[0].artifacts.app.size += 1
    const fetch = vi.fn(async () => new Response(JSON.stringify(attacked), { status: 200 }))
    await expect(createClient(fileSystem, fetch).fetchManifest()).rejects.toThrow(
      /signature verification/
    )
    expect(JSON.parse(fileSystem.files.get(CACHE_PATH)!).rawManifest).toBe(rawManifest)
  })

  it('rejects corrupt cache before request or fallback', async () => {
    fileSystem.files.set(CACHE_PATH, '{broken')
    const fetch = vi.fn(async () => {
      throw new TypeError('offline')
    })
    await expect(createClient(fileSystem, fetch).fetchManifest()).rejects.toThrow(
      /cache is not valid JSON/
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps previous cache when atomic rename fails', async () => {
    const previous = cache(rawManifest)
    fileSystem.files.set(CACHE_PATH, previous)
    fileSystem.failRename = true
    const fetch = vi.fn(
      async () => new Response(rawManifest, { status: 200, headers: { ETag: '"new"' } })
    )
    await expect(createClient(fileSystem, fetch).fetchManifest()).rejects.toThrow(/rename failed/)
    expect(fileSystem.files.get(CACHE_PATH)).toBe(previous)
    expect(fileSystem.files.has(`${CACHE_PATH}.test.tmp`)).toBe(false)
  })
})
