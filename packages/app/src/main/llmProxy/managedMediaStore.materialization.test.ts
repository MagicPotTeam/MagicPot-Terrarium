import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import { readManagedMediaBytes } from './managedMediaStore'

describe('readManagedMediaBytes (real filesystem)', () => {
  let root: string
  let target: string
  const bytes = Buffer.alloc(128 * 1024 + 3, 42)
  const selected = {
    relativePath: 'originals/test.png',
    mimeType: 'image/png' as const,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-read-')))
    target = path.join(root, selected.relativePath)
    await fs.mkdir(path.dirname(target))
    await fs.writeFile(target, bytes)
  })
  afterEach(async () => fs.rm(root, { recursive: true, force: true }))

  function read(fileSystem = fs, value = selected) {
    return readManagedMediaBytes(root, value, {
      authorizedRoot: root,
      fs: fileSystem
    })
  }

  it('reads short chunks from one nofollow handle and closes it', async () => {
    const close = vi.fn()
    const open = vi.fn<typeof fs.open>(async (file, flags) => {
      expect(flags).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const handle = await fs.open(file, flags)
      const realRead = handle.read.bind(handle)
      const realClose = handle.close.bind(handle)
      handle.read = vi.fn(async (buffer, offset, length, position) => {
        expect(length).toBeLessThanOrEqual(64 * 1024)
        return realRead(buffer, offset, Math.min(length, 4096), position)
      }) as unknown as typeof handle.read
      handle.close = async () => {
        close()
        await realClose()
      }
      return handle
    })
    await expect(read({ ...fs, open })).resolves.toEqual(bytes)
    expect(open).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it.each(['identity', 'mtimeMs', 'ctimeMs', 'mode', 'size', 'read error', 'truncation'])(
    'rejects %s changes on the open handle and closes on failure',
    async (mutation) => {
      const close = vi.fn()
      const open: typeof fs.open = async (file, flags) => {
        if (mutation === 'identity') {
          await fs.rename(target, `${target}.old`)
          await fs.writeFile(target, bytes)
        }
        const handle = await fs.open(file, flags)
        const realStat = handle.stat.bind(handle)
        const realRead = handle.read.bind(handle)
        const realClose = handle.close.bind(handle)
        let didRead = false
        handle.stat = (async () => {
          const stat = await realStat()
          if (didRead && ['mtimeMs', 'ctimeMs', 'mode', 'size'].includes(mutation)) {
            const key = mutation as 'mtimeMs' | 'ctimeMs' | 'mode' | 'size'
            stat[key] += 1
          }
          return stat
        }) as typeof handle.stat
        handle.read = vi.fn(async (buffer, offset, length, position) => {
          didRead = true
          if (mutation === 'read error') throw new Error('private path read failure')
          if (mutation === 'truncation') return { bytesRead: 0, buffer }
          return realRead(buffer, offset, length, position)
        }) as unknown as typeof handle.read
        handle.close = async () => {
          close()
          await realClose()
        }
        return handle
      }
      await expect(read({ ...fs, open })).rejects.toMatchObject({ code: 'MANAGED_MEDIA_CORRUPT' })
      expect(close).toHaveBeenCalledTimes(1)
    }
  )

  it('hashes the returned bytes even when all observed file metadata is unchanged', async () => {
    const open: typeof fs.open = async (file, flags) => {
      const handle = await fs.open(file, flags)
      const realRead = handle.read.bind(handle)
      handle.read = vi.fn(async (buffer, offset, length, position) => {
        const result = await realRead(buffer, offset, length, position)
        buffer[offset] ^= 1
        return result
      }) as unknown as typeof handle.read
      return handle
    }
    await expect(read({ ...fs, open })).rejects.toMatchObject({ code: 'MANAGED_MEDIA_CORRUPT' })
  })

  it.each([
    { sizeBytes: 1.5 },
    { sizeBytes: 0 },
    { sizeBytes: Number.NaN },
    { sha256: 'bad' },
    { relativePath: '../outside.png' },
    { relativePath: 'originals/test.jpg' }
  ])('rejects invalid selected metadata before opening %#', async (invalid) => {
    const open = vi.fn<typeof fs.open>()
    await expect(read({ ...fs, open }, { ...selected, ...invalid })).rejects.toMatchObject({
      code: 'MANAGED_MEDIA_CORRUPT'
    })
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects on-disk growth before opening or allocating the file size', async () => {
    await fs.appendFile(target, Buffer.from('unexpected'))
    const open = vi.fn<typeof fs.open>()
    await expect(read({ ...fs, open })).rejects.toMatchObject({ code: 'MANAGED_MEDIA_CORRUPT' })
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects a real timestamp change during the handle read', async () => {
    const open: typeof fs.open = async (file, flags) => {
      const handle = await fs.open(file, flags)
      const originalStat = await handle.stat()
      const realRead = handle.read.bind(handle)
      let touched = false
      handle.read = vi.fn(async (buffer, offset, length, position) => {
        const result = await realRead(buffer, offset, length, position)
        if (!touched) {
          touched = true
          await fs.utimes(target, originalStat.atime, new Date(originalStat.mtimeMs + 10_000))
        }
        return result
      }) as unknown as typeof handle.read
      return handle
    }
    await expect(read({ ...fs, open })).rejects.toMatchObject({ code: 'MANAGED_MEDIA_CORRUPT' })
  })

  it('does not swallow a handle close failure', async () => {
    const open: typeof fs.open = async (file, flags) => {
      const handle = await fs.open(file, flags)
      const realClose = handle.close.bind(handle)
      handle.close = async () => {
        await realClose()
        throw new Error('fixture close failure')
      }
      return handle
    }
    await expect(read({ ...fs, open })).rejects.toMatchObject({ code: 'MANAGED_MEDIA_CORRUPT' })
  })

  it('preserves missing-file errors', async () => {
    await fs.unlink(target)
    await expect(read()).rejects.toMatchObject({ code: 'MANAGED_MEDIA_MISSING' })
  })
})
