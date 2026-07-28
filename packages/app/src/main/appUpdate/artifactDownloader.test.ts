import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadArtifact } from './artifactDownloader'

const roots: string[] = []
const bytes = new TextEncoder().encode('streamed launcher artifact')
const sha256 = createHash('sha256').update(bytes).digest('hex')

async function destination(): Promise<string> {
  const tempRoot = os.tmpdir()
  await fs.mkdir(tempRoot, { recursive: true })
  const root = await fs.mkdtemp(path.join(tempRoot, 'artifact-downloader-'))
  roots.push(root)
  return path.join(root, 'cache', 'launcher.zip')
}

function options(destinationPath: string, overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://updates.example/launcher.zip',
    destinationPath,
    expected: { size: bytes.byteLength, sha256 },
    maxBytes: 1024,
    timeoutMs: 1_000,
    ...overrides
  }
}

function response(body: Uint8Array = bytes, init: ResponseInit = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const split = Math.max(1, Math.floor(body.byteLength / 2))
        controller.enqueue(body.slice(0, split))
        if (split < body.byteLength) controller.enqueue(body.slice(split))
        controller.close()
      }
    }),
    init
  )
}

async function directoryEntries(destinationPath: string): Promise<string[]> {
  return fs.readdir(path.dirname(destinationPath)).catch(() => [])
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  vi.useRealTimers()
})

describe('downloadArtifact', () => {
  it('streams, verifies, and publishes a successful download', async () => {
    const target = await destination()
    const fetchImpl = vi.fn(async () =>
      response(bytes, { headers: { 'content-length': String(bytes.byteLength) } })
    )

    await expect(downloadArtifact(options(target), { fetch: fetchImpl })).resolves.toEqual({
      path: target,
      size: bytes.byteLength,
      sha256
    })
    expect(await fs.readFile(target)).toEqual(Buffer.from(bytes))
    expect(await directoryEntries(target)).toEqual(['launcher.zip'])
  })

  it('rejects a hash mismatch and cleans the temporary file', async () => {
    const target = await destination()
    await expect(
      downloadArtifact(
        options(target, { expected: { size: bytes.byteLength, sha256: '0'.repeat(64) } }),
        {
          fetch: async () => response()
        }
      )
    ).rejects.toThrow('SHA-256 mismatch')
    expect(await directoryEntries(target)).toEqual([])
  })

  it('rejects Content-Length and final streamed size mismatches', async () => {
    const headerTarget = await destination()
    await expect(
      downloadArtifact(options(headerTarget), {
        fetch: async () => response(bytes, { headers: { 'content-length': '1' } })
      })
    ).rejects.toThrow('Content-Length mismatch')
    expect(await directoryEntries(headerTarget)).toEqual([])

    const bodyTarget = await destination()
    await expect(
      downloadArtifact(options(bodyTarget), { fetch: async () => response(bytes.slice(0, -1)) })
    ).rejects.toThrow('size mismatch')
    expect(await directoryEntries(bodyTarget)).toEqual([])
  })

  it('rejects downloads exceeding the configured maximum and cleans up', async () => {
    const target = await destination()
    await expect(
      downloadArtifact(
        options(target, {
          expected: { size: 10, sha256: '0'.repeat(64) },
          maxBytes: 10
        }),
        { fetch: async () => response(new Uint8Array(11)) }
      )
    ).rejects.toThrow('maximum')
    expect(await directoryEntries(target)).toEqual([])
  })

  it('aborts on timeout and cleans up', async () => {
    vi.useFakeTimers()
    try {
      const target = await destination()
      await fs.mkdir(path.dirname(target), { recursive: true })
      let fetchStarted!: () => void
      const started = new Promise<void>((resolve) => {
        fetchStarted = resolve
      })
      const assertion = expect(
        downloadArtifact(options(target, { timeoutMs: 50 }), {
          fetch: (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              fetchStarted()
              if (init?.signal?.aborted) reject(init.signal.reason)
              else
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                  once: true
                })
            })
        })
      ).rejects.toThrow('aborted or timed out')
      await started
      await vi.advanceTimersByTimeAsync(50)
      await assertion
      expect(await directoryEntries(target)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors caller aborts and rejects HTTP errors', async () => {
    const abortTarget = await destination()
    const controller = new AbortController()
    controller.abort()
    await expect(
      downloadArtifact(options(abortTarget, { signal: controller.signal }), {
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) reject(init.signal.reason)
            else
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                once: true
              })
          })
      })
    ).rejects.toThrow('aborted or timed out')
    expect(await directoryEntries(abortTarget)).toEqual([])

    const httpTarget = await destination()
    await expect(
      downloadArtifact(options(httpTarget), {
        fetch: async () => new Response(null, { status: 503 })
      })
    ).rejects.toThrow('HTTP 503')
    expect(await directoryEntries(httpTarget)).toEqual([])
  })

  it('returns an already verified artifact without fetching', async () => {
    const target = await destination()
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, bytes)
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(downloadArtifact(options(target), { fetch: fetchImpl })).resolves.toMatchObject({
      path: target,
      size: bytes.byteLength,
      sha256
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('quarantines an existing conflicting artifact and downloads a replacement', async () => {
    const target = await destination()
    const original = Buffer.from('do not overwrite')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, original)
    const fetchImpl = vi.fn(async () => response(bytes))

    await expect(downloadArtifact(options(target), { fetch: fetchImpl })).resolves.toMatchObject({
      path: target,
      sha256
    })
    expect(await fs.readFile(target)).toEqual(Buffer.from(bytes))
    const entries = await fs.readdir(path.dirname(target))
    const quarantine = entries.find((entry) => entry.endsWith('.quarantine'))
    expect(quarantine).toBeDefined()
    expect(await fs.readFile(path.join(path.dirname(target), quarantine!))).toEqual(original)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('only accepts HTTPS URLs', async () => {
    const target = await destination()
    await expect(
      downloadArtifact(options(target, { url: 'http://updates.example/launcher.zip' }))
    ).rejects.toThrow('HTTPS')
  })
})
