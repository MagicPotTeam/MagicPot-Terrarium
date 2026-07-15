import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { shellOpenExternalMock, netFetchMock } = vi.hoisted(() => ({
  shellOpenExternalMock: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: {
    fetch: netFetchMock
  },
  shell: {
    openExternal: shellOpenExternalMock
  }
}))

import { DownloadFileProgressEvent } from '@shared/api/svcShell'
import { createDownloadByteLimitTransform, MAX_DOWNLOAD_BYTES, ShellSvcImpl } from './svcShellImpl'

function mockDownloadResponse(
  statusCode: number,
  headers: Record<string, string>,
  chunks: Buffer[] = []
): void {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    }
  })
  netFetchMock.mockResolvedValueOnce(
    new Response(body, {
      status: statusCode,
      statusText: statusCode === 200 ? 'OK' : 'Found',
      headers
    })
  )
}

function makeStats({
  size = 1,
  blocks = 1
}: {
  size?: number
  blocks?: number
} = {}): fs.Stats {
  return {
    size,
    blocks
  } as unknown as fs.Stats
}

describe('ShellSvcImpl', () => {
  beforeEach(() => {
    shellOpenExternalMock.mockResolvedValue(undefined)
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    shellOpenExternalMock.mockReset()
  })

  it('treats regular files as available', async () => {
    vi.spyOn(fs, 'statSync').mockReturnValue(makeStats({ size: 1024, blocks: 8 }))

    const svc = new ShellSvcImpl()

    await expect(svc.fileExists('C:/models/ok.safetensors')).resolves.toBe(true)
  })

  it('treats cloud placeholder files as available when the path exists', async () => {
    vi.spyOn(fs, 'statSync').mockReturnValue(makeStats({ size: 16_479_334_424, blocks: 0 }))

    const svc = new ShellSvcImpl()

    await expect(svc.fileExists('C:/models/offline.safetensors')).resolves.toBe(true)
  })

  it('keeps zero-byte files available', async () => {
    vi.spyOn(fs, 'statSync').mockReturnValue(makeStats({ size: 0, blocks: 0 }))

    const svc = new ShellSvcImpl()

    await expect(svc.fileExists('C:/empty.txt')).resolves.toBe(true)
  })

  it('returns false when stat fails', async () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const svc = new ShellSvcImpl()

    await expect(svc.fileExistsBatch(['C:/missing-a', 'C:/missing-b'])).resolves.toEqual([
      false,
      false
    ])
  })

  it('returns the current user home directory', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue('C:/Users/demo')

    const svc = new ShellSvcImpl()

    await expect(svc.getHomeDir()).resolves.toBe('C:/Users/demo')
  })

  it('normalizes safe external URLs before handing them to Electron shell', async () => {
    const svc = new ShellSvcImpl()

    await expect(svc.openExternal(' https://example.com/path ')).resolves.toBeUndefined()

    expect(shellOpenExternalMock).toHaveBeenCalledWith('https://example.com/path')
  })

  it('rejects unsafe external URL protocols before calling Electron shell', async () => {
    const svc = new ShellSvcImpl()

    await expect(svc.openExternal('javascript:alert(1)')).rejects.toThrow(
      /Unsupported external URL protocol/
    )

    expect(shellOpenExternalMock).not.toHaveBeenCalled()
  })

  const makeTempDir = async (name: string) => {
    const root = path.join('/tmp', name)
    await fs.promises.mkdir(root, { recursive: true })
    return fs.promises.mkdtemp(path.join(root, 'case-'))
  }

  it('creates directories before opening or downloading dependency assets', async () => {
    const tempDir = await makeTempDir('magicpot-shell-dir')
    const targetDir = path.join(tempDir, 'models', 'controlnet')

    const svc = new ShellSvcImpl()

    await expect(svc.ensureDirectory({ path: targetDir })).resolves.toEqual({
      path: path.resolve(targetDir)
    })
    expect(fs.existsSync(targetDir)).toBe(true)

    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })

  it('rejects non-HTTPS and private download targets before connecting', async () => {
    const svc = new ShellSvcImpl()
    const request = { outputDir: '/tmp', filename: 'model.bin' }

    await expect(
      svc.downloadFile({ ...request, url: 'http://example.com/model.bin' })
    ).rejects.toThrow('must use https')
    await expect(
      svc.downloadFile({ ...request, url: 'https://127.0.0.1/model.bin' })
    ).rejects.toThrow('public host')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('uses Electron networking and validates every redirect target', async () => {
    const tempDir = await makeTempDir('magicpot-shell-redirect')
    mockDownloadResponse(302, { location: 'https://127.0.0.1/secret' })
    const svc = new ShellSvcImpl()

    await expect(
      svc.downloadFile({
        url: 'https://public.example/model.bin',
        outputDir: tempDir,
        filename: 'model.bin'
      })
    ).rejects.toThrow('public host')
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://public.example/model.bin',
      expect.objectContaining({ method: 'GET', redirect: 'manual' })
    )
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })

  it('enforces the actual streamed byte limit without buffering', async () => {
    const transform = createDownloadByteLimitTransform(MAX_DOWNLOAD_BYTES, vi.fn())
    const errors: Error[] = []
    transform.on('error', (error) => errors.push(error))

    transform.write(Buffer.alloc(1))
    transform.write(Buffer.alloc(1), () => undefined)
    transform.destroy()

    const tinyLimitTransform = createDownloadByteLimitTransform(1, vi.fn())
    const error = new Promise<Error>((resolve) => tinyLimitTransform.once('error', resolve))
    tinyLimitTransform.write(Buffer.alloc(2))
    await expect(error).resolves.toMatchObject({
      message: expect.stringContaining('response is too large')
    })
    expect(errors).toEqual([])
  })

  it('rejects oversized Content-Length and removes partial temp files', async () => {
    const tempDir = await makeTempDir('magicpot-shell-oversize')
    mockDownloadResponse(200, { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) })
    const svc = new ShellSvcImpl()

    await expect(
      svc.downloadFile({
        url: 'https://public.example/model.bin',
        outputDir: tempDir,
        filename: 'model.bin'
      })
    ).rejects.toThrow('response is too large')
    expect(await fs.promises.readdir(tempDir)).toEqual([])
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })

  it('routes downloads through Electron net.fetch with an abort signal', async () => {
    const tempDir = await makeTempDir('magicpot-shell-timeout')
    mockDownloadResponse(200, {}, [Buffer.from('ok')])
    const svc = new ShellSvcImpl()
    await svc.downloadFile({
      url: 'https://public.example/model.bin',
      outputDir: tempDir,
      filename: 'model.bin'
    })

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://public.example/model.bin',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })

  it('streams downloads to the requested filename', async () => {
    const tempDir = await makeTempDir('magicpot-shell-download')
    const bytes = new Uint8Array([1, 2, 3, 4])
    mockDownloadResponse(200, {}, [Buffer.from(bytes)])

    const svc = new ShellSvcImpl()
    const result = await svc.downloadFile({
      url: 'https://example.com/model.bin',
      outputDir: tempDir,
      filename: 'model.bin'
    })

    expect(result.alreadyExists).toBe(false)
    expect(fs.readFileSync(result.fullPath)).toEqual(Buffer.from(bytes))

    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })

  it('emits download progress while streaming files', async () => {
    const tempDir = await makeTempDir('magicpot-shell-download-progress')
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    mockDownloadResponse(200, { 'content-length': String(bytes.byteLength) }, [Buffer.from(bytes)])

    const events: DownloadFileProgressEvent[] = []
    const svc = new ShellSvcImpl()
    await svc.downloadFileWithProgress(
      {
        url: 'https://example.com/model.bin',
        outputDir: tempDir,
        filename: 'model.bin'
      },
      { onData: (event) => events.push(event) }
    )

    const progressEvents = events.filter((event) => event.type === 'progress')
    const completeEvent = events.find((event) => event.type === 'complete')

    expect(progressEvents.length).toBeGreaterThan(0)
    expect(progressEvents.at(-1)).toMatchObject({
      downloadedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
      percent: 100
    })
    expect(progressEvents.at(-1)?.bytesPerSecond).toBeGreaterThan(0)
    expect(completeEvent).toMatchObject({
      type: 'complete',
      result: {
        alreadyExists: false
      }
    })

    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })

  it('continues downloading when the progress listener disconnects', async () => {
    const tempDir = await makeTempDir('magicpot-shell-download-progress-disconnect')
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])
    mockDownloadResponse(200, { 'content-length': String(bytes.byteLength) }, [Buffer.from(bytes)])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const events: DownloadFileProgressEvent[] = []
    const svc = new ShellSvcImpl()
    await svc.downloadFileWithProgress(
      {
        url: 'https://example.com/model.bin',
        outputDir: tempDir,
        filename: 'model.bin'
      },
      {
        onData: (event) => {
          if (event.type === 'progress') {
            throw new Error('port closed')
          }
          events.push(event)
        }
      }
    )

    const completeEvent = events.find((event) => event.type === 'complete')
    expect(completeEvent).toMatchObject({
      type: 'complete',
      result: {
        alreadyExists: false
      }
    })
    expect(fs.readFileSync(path.join(tempDir, 'model.bin'))).toEqual(Buffer.from(bytes))

    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })

  it('does not clone custom nodes over an existing non-empty directory', async () => {
    const tempDir = await makeTempDir('magicpot-shell-git')
    const targetDir = path.join(tempDir, 'ComfyUI-Test-Node')
    await fs.promises.mkdir(targetDir)
    await fs.promises.writeFile(path.join(targetDir, 'README.md'), 'installed')

    const svc = new ShellSvcImpl()
    const result = await svc.installGitRepository({
      url: 'https://github.com/example/ComfyUI-Test-Node.git',
      outputDir: tempDir,
      directoryName: 'ComfyUI-Test-Node'
    })

    expect(result).toEqual({
      targetDir: path.resolve(targetDir),
      alreadyExists: true
    })

    await fs.promises.rm(tempDir, { recursive: true, force: true })
  })
})
