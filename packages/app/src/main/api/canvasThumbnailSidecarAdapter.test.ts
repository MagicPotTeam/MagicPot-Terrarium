import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CANVAS_THUMBNAIL_SIDECAR_FEATURE_FLAG_ENV,
  CANVAS_THUMBNAIL_SIDECAR_PATH_ENV,
  createCanvasThumbnailSidecarBatchRequest,
  createCanvasThumbnailViaSidecar,
  generateCanvasThumbnailsViaSidecar,
  getCanvasThumbnailSidecarBinaryName,
  getCanvasThumbnailSidecarCandidatePaths,
  isCanvasThumbnailSidecarEnabled,
  normalizeCanvasThumbnailSidecarBinaryPath,
  resolveCanvasThumbnailSidecarBinary,
  runCanvasThumbnailSidecarJson,
  type CanvasThumbnailSidecarChild,
  type CanvasThumbnailSidecarProcess,
  type CanvasThumbnailSidecarSpawnOptions,
  type CanvasThumbnailSidecarWritable
} from './canvasThumbnailSidecarAdapter'

function createProcess(env: NodeJS.ProcessEnv = {}): CanvasThumbnailSidecarProcess {
  return {
    env,
    platform: 'win32',
    arch: 'x64',
    resourcesPath: 'C:/MagicPot/resources',
    execPath: 'C:/MagicPot/MagicPot.exe',
    cwd: () => 'C:/repo/magicpot-open'
  }
}

class FakeStream extends EventEmitter {}

class FakeStdin implements CanvasThumbnailSidecarWritable {
  chunks: string[] = []
  ended = false
  write(chunk: string): void {
    this.chunks.push(chunk)
  }
  end(): void {
    this.ended = true
  }
}

class FakeChild extends EventEmitter implements CanvasThumbnailSidecarChild {
  stdin: FakeStdin | null = new FakeStdin()
  stdout = new FakeStream()
  stderr = new FakeStream()
  killedWith: NodeJS.Signals | string | undefined
  kill(signal?: NodeJS.Signals | string): boolean {
    this.killedWith = signal
    return true
  }
}

type SpawnCall = {
  file: string
  args: string[]
  options: CanvasThumbnailSidecarSpawnOptions
  child: FakeChild
}

function createSpawn(): {
  calls: SpawnCall[]
  spawn: (file: string, args: string[], options: CanvasThumbnailSidecarSpawnOptions) => FakeChild
} {
  const calls: SpawnCall[] = []
  return {
    calls,
    spawn: (file, args, options) => {
      const child = new FakeChild()
      calls.push({ file, args, options, child })
      return child
    }
  }
}

describe('canvasThumbnailSidecarAdapter', () => {
  it('normalizes feature flags, binary names, and quoted paths without shell quoting', () => {
    expect(
      isCanvasThumbnailSidecarEnabled({ [CANVAS_THUMBNAIL_SIDECAR_FEATURE_FLAG_ENV]: 'yes' })
    ).toBe(true)
    expect(
      isCanvasThumbnailSidecarEnabled({ [CANVAS_THUMBNAIL_SIDECAR_FEATURE_FLAG_ENV]: '0' })
    ).toBe(false)
    expect(getCanvasThumbnailSidecarBinaryName('win32')).toBe('magicpot-image-worker.exe')
    expect(getCanvasThumbnailSidecarBinaryName('linux')).toBe('magicpot-image-worker')
    expect(normalizeCanvasThumbnailSidecarBinaryPath(' "C:/Program Files/worker.exe" ')).toBe(
      'C:/Program Files/worker.exe'
    )
  })

  it('builds candidate paths from explicit, env, resources, executable, and development locations', () => {
    const candidates = getCanvasThumbnailSidecarCandidatePaths(
      createProcess({ [CANVAS_THUMBNAIL_SIDECAR_PATH_ENV]: '"D:/workers/env-worker.exe"' }),
      'C:/explicit/worker.exe'
    )

    expect(candidates[0]).toBe('C:/explicit/worker.exe')
    expect(candidates[1]).toBe('D:/workers/env-worker.exe')
    expect(candidates).toContain(
      path.join(
        'C:/MagicPot/resources',
        'bin',
        'image-worker',
        'win32-x64',
        'magicpot-image-worker.exe'
      )
    )
    expect(candidates).toContain(
      path.join(
        'C:/repo/magicpot-open',
        'packages',
        'runtime-assets',
        'resources',
        'bin',
        'image-worker',
        'win32-x64',
        'magicpot-image-worker.exe'
      )
    )
    expect(candidates).toContain(
      path.join(
        'C:/repo/magicpot-open',
        '.cache',
        'cargo-target',
        'canvas-thumbnail-sidecar',
        'release',
        'canvas-thumbnail-sidecar.exe'
      )
    )
    expect(
      candidates.every((candidate) => !candidate.startsWith('"') && !candidate.endsWith('"'))
    ).toBe(true)
  })

  it('resolves the first accessible sidecar binary and reports all candidates on miss', async () => {
    const sidecarProcess = createProcess({
      [CANVAS_THUMBNAIL_SIDECAR_PATH_ENV]: 'C:/env/worker.exe'
    })
    const access = vi.fn(async (candidate: string) => {
      if (candidate !== 'C:/env/worker.exe') {
        throw new Error('missing')
      }
    })

    await expect(
      resolveCanvasThumbnailSidecarBinary({ process: sidecarProcess, access })
    ).resolves.toMatchObject({
      ok: true,
      binaryPath: 'C:/env/worker.exe'
    })
    expect(access).toHaveBeenCalled()

    const miss = await resolveCanvasThumbnailSidecarBinary({
      process: createProcess(),
      access: vi.fn(async () => {
        throw new Error('missing')
      })
    })
    expect(miss.ok).toBe(false)
    expect(miss.candidates.length).toBeGreaterThan(0)
  })

  it('returns an explicit fallback when the feature flag is disabled', async () => {
    const result = await runCanvasThumbnailSidecarJson(
      { hello: 'world' },
      { process: createProcess() }
    )

    expect(result).toMatchObject({
      ok: false,
      fallback: true,
      reason: 'feature-disabled'
    })
  })

  it('spawns with shell disabled, writes JSON over stdin, and parses stdout JSON', async () => {
    const { calls, spawn } = createSpawn()
    const sidecarProcess = createProcess({ [CANVAS_THUMBNAIL_SIDECAR_FEATURE_FLAG_ENV]: '1' })
    const resultPromise = runCanvasThumbnailSidecarJson<{ ok: boolean }>(
      { op: 'probe', path: 'C:/assets/图像.png' },
      {
        process: sidecarProcess,
        access: vi.fn(async () => {}),
        spawn,
        args: ['--stdio'],
        timeoutMs: 500
      }
    )

    await vi.waitUntil(() => calls.length === 1)
    const call = calls[0]
    expect(call.options.shell).toBe(false)
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(call.options.windowsHide).toBe(true)
    expect(call.args).toEqual(['--stdio'])
    expect(call.child.stdin?.chunks.join('')).toContain('"op":"probe"')
    expect(call.child.stdin?.chunks.join('')).toContain('图像.png')
    expect(call.child.stdin?.ended).toBe(true)

    call.child.stdout.emit('data', Buffer.from('{"ok":true}', 'utf8'))
    call.child.emit('close', 0, null)
    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      response: { ok: true },
      args: ['--stdio']
    })
  })

  it('returns safe fallback results for invalid JSON, failed exits, stdout limits, and timeouts', async () => {
    const baseProcess = createProcess({ [CANVAS_THUMBNAIL_SIDECAR_FEATURE_FLAG_ENV]: '1' })

    {
      const { calls, spawn } = createSpawn()
      const promise = runCanvasThumbnailSidecarJson(
        { op: 'bad-json' },
        {
          process: baseProcess,
          access: vi.fn(async () => {}),
          spawn,
          timeoutMs: 500
        }
      )
      await vi.waitUntil(() => calls.length === 1)
      calls[0].child.stdout.emit('data', 'not-json')
      calls[0].child.emit('close', 0, null)
      await expect(promise).resolves.toMatchObject({ ok: false, reason: 'invalid-json' })
    }

    {
      const { calls, spawn } = createSpawn()
      const promise = runCanvasThumbnailSidecarJson(
        { op: 'exit' },
        {
          process: baseProcess,
          access: vi.fn(async () => {}),
          spawn,
          timeoutMs: 500
        }
      )
      await vi.waitUntil(() => calls.length === 1)
      calls[0].child.stderr.emit('data', 'decode failed')
      calls[0].child.emit('close', 7, null)
      await expect(promise).resolves.toMatchObject({
        ok: false,
        reason: 'sidecar-exit-failed',
        exitCode: 7,
        stderr: 'decode failed'
      })
    }

    {
      const { calls, spawn } = createSpawn()
      const promise = runCanvasThumbnailSidecarJson(
        { op: 'too-large' },
        {
          process: baseProcess,
          access: vi.fn(async () => {}),
          spawn,
          maxStdoutBytes: 4,
          timeoutMs: 500
        }
      )
      await vi.waitUntil(() => calls.length === 1)
      calls[0].child.stdout.emit('data', '12345')
      await expect(promise).resolves.toMatchObject({ ok: false, reason: 'stdout-too-large' })
      expect(calls[0].child.killedWith).toBe('SIGKILL')
    }

    {
      const { calls, spawn } = createSpawn()
      const promise = runCanvasThumbnailSidecarJson(
        { op: 'timeout' },
        {
          process: baseProcess,
          access: vi.fn(async () => {}),
          spawn,
          timeoutMs: 1
        }
      )
      await expect(promise).resolves.toMatchObject({ ok: false, reason: 'timeout', timedOut: true })
      expect(calls[0].child.killedWith).toBe('SIGKILL')
    }
  })

  it('creates Rust batch thumbnail requests and preserves optional limits', () => {
    const request = createCanvasThumbnailSidecarBatchRequest({
      cacheRoot: 'C:/cache/../cache/thumbnails',
      items: [{ id: 'asset-1', path: 'C:/assets/../assets/图像.png' }],
      thumbnail: { maxWidth: 512.9, maxHeight: 256.1, format: 'webp' },
      maxConcurrency: 2.9,
      maxDecodedPixels: 1234.8,
      hash: 'sha256'
    })

    expect(request).toMatchObject({
      thumbnail: { maxWidth: 512, maxHeight: 256, format: 'webp' },
      maxConcurrency: 2,
      maxDecodedPixels: 1234,
      hash: 'sha256'
    })
    expect(request.cacheRoot).toContain('thumbnails')
    expect(request.items).toEqual([
      { id: 'asset-1', path: path.resolve('C:/assets/../assets/图像.png') }
    ])
  })

  it('sends Rust batch JSON over stdin and parses batch stdout JSON', async () => {
    const { calls, spawn } = createSpawn()
    const sidecarProcess = createProcess({ [CANVAS_THUMBNAIL_SIDECAR_FEATURE_FLAG_ENV]: '1' })
    const resultPromise = generateCanvasThumbnailsViaSidecar(
      {
        cacheRoot: 'C:/cache/thumbnails',
        items: [{ id: 'asset-1', path: 'C:/assets/图像.png' }],
        thumbnail: { maxWidth: 256, maxHeight: 256, format: 'png' },
        maxConcurrency: 1,
        maxDecodedPixels: 16_777_216,
        hash: 'blake3'
      },
      {
        process: sidecarProcess,
        access: vi.fn(async () => {}),
        spawn,
        timeoutMs: 500
      }
    )

    await vi.waitUntil(() => calls.length === 1)
    expect(calls[0].args).toEqual([])
    const request = JSON.parse(calls[0].child.stdin?.chunks.join('') || '{}')
    expect(request).toMatchObject({
      cacheRoot: path.resolve('C:/cache/thumbnails'),
      thumbnail: { maxWidth: 256, maxHeight: 256, format: 'png' },
      maxConcurrency: 1,
      maxDecodedPixels: 16_777_216,
      hash: 'blake3'
    })
    expect(request.items).toEqual([{ id: 'asset-1', path: path.resolve('C:/assets/图像.png') }])

    calls[0].child.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        cacheRoot: path.resolve('C:/cache/thumbnails'),
        results: [
          {
            id: 'asset-1',
            ok: true,
            manifest: {
              schemaVersion: 1,
              id: 'asset-1',
              source: {
                path: path.resolve('C:/assets/图像.png'),
                byteLength: 10,
                width: 4,
                height: 3,
                colorType: 'Rgba8',
                format: 'png'
              },
              hash: { algorithm: 'blake3', hex: 'abc' },
              thumbnail: {
                path: path.resolve('C:/cache/thumbnails/thumbs/abc.png'),
                width: 4,
                height: 3,
                format: 'png'
              },
              manifestPath: path.resolve('C:/cache/thumbnails/manifests/abc.json')
            }
          }
        ]
      })
    )
    calls[0].child.emit('close', 0, null)
    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      response: {
        ok: true,
        results: [{ id: 'asset-1', ok: true }]
      }
    })
  })

  it('does not send deprecated create-thumbnail fake requests to the Rust sidecar', async () => {
    const { calls, spawn } = createSpawn()
    const result = await createCanvasThumbnailViaSidecar(
      { fullPath: 'C:/assets/image.png', maxSide: 512 },
      {
        process: createProcess({ [CANVAS_THUMBNAIL_SIDECAR_FEATURE_FLAG_ENV]: '1' }),
        access: vi.fn(async () => {}),
        spawn,
        timeoutMs: 500
      }
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'sidecar-exit-failed'
    })
    if (!result.ok) {
      expect(result.message).toContain('Deprecated create-thumbnail')
    }
    expect(calls).toHaveLength(0)
  })
})
