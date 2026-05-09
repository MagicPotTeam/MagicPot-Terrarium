import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi, afterEach } from 'vitest'

import { ShellSvcImpl } from './svcShellImpl'

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
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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

  it('streams downloads to the requested filename', async () => {
    const tempDir = await makeTempDir('magicpot-shell-download')
    const bytes = new Uint8Array([1, 2, 3, 4])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes, { status: 200, statusText: 'OK' }))
    )

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
