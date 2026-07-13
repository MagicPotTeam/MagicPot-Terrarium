import fs from 'node:fs/promises'
import path from 'node:path'
import { vol } from 'memfs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { writeJsonFileAtomic } from './jsonPersistence'

const ROOT = '/json-persistence'
const FILE_PATH = path.join(ROOT, 'state.json')
const permissionIt = process.platform === 'win32' ? it.skip : it

describe('writeJsonFileAtomic', () => {
  beforeEach(() => {
    vol.reset()
  })

  permissionIt('preserves an existing destination file mode when rewriting it', async () => {
    await fs.mkdir(ROOT, { recursive: true })
    await fs.writeFile(FILE_PATH, '{"old":true}\n', { mode: 0o640 })
    await fs.chmod(FILE_PATH, 0o640)

    await writeJsonFileAtomic(FILE_PATH, { updated: true })

    expect((await fs.stat(FILE_PATH)).mode & 0o777).toBe(0o640)
    expect(JSON.parse(await fs.readFile(FILE_PATH, 'utf8'))).toEqual({ updated: true })
  })

  permissionIt('uses a restrictive mode for a new destination file', async () => {
    await writeJsonFileAtomic(FILE_PATH, { created: true })

    expect((await fs.stat(FILE_PATH)).mode & 0o777).toBe(0o600)
  })

  it('removes a new temp file when the atomic rename fails', async () => {
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'))

    await expect(writeJsonFileAtomic(FILE_PATH, { uncommitted: true })).rejects.toThrow(
      'rename failed'
    )

    await expect(fs.stat(FILE_PATH)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(ROOT)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    renameSpy.mockRestore()
  })
})
