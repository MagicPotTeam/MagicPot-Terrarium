import fs from 'fs'
import os from 'os'
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
})
