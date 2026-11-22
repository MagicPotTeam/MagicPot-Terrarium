import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Real filesystem: modes and a planted entry are what these tests are about.
vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))

import {
  CANVAS_DRAG_TEMP_ROOT_REFUSED,
  sanitizeDragFileName,
  writeCanvasSystemDragFiles
} from './canvasSystemDragFiles'

const cleanup: string[] = []
afterEach(() =>
  cleanup.splice(0).forEach((target) => fs.rmSync(target, { recursive: true, force: true }))
)
const tempDirectory = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-drag-out-')))
  cleanup.push(directory)
  return directory
}
const posixOnly = it.skipIf(process.platform === 'win32')
const files = [{ fileName: 'a:b?.png', data: new Uint8Array([1, 2, 3]) }]

describe('canvas drag-out files', () => {
  it('writes nothing when the private temp folder is not verified', () => {
    const mkdirSync = vi.fn()
    const writeFileSync = vi.fn()
    expect(() =>
      writeCanvasSystemDragFiles(files, null, { fileSystem: { mkdirSync, writeFileSync } })
    ).toThrow(CANVAS_DRAG_TEMP_ROOT_REFUSED)
    expect(mkdirSync).not.toHaveBeenCalled()
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  posixOnly('creates a private folder and private files', () => {
    const drag = path.join(tempDirectory(), 'verified', 'drag')
    const [written] = writeCanvasSystemDragFiles(files, drag, { uniquePrefix: () => 'p' })
    expect(written).toBe(path.join(drag, `p-${sanitizeDragFileName('a:b?.png')}`))
    expect(fs.readFileSync(written)).toEqual(Buffer.from([1, 2, 3]))
    expect(fs.statSync(written).mode & 0o777).toBe(0o600)
    expect(fs.statSync(drag).mode & 0o777).toBe(0o700)
  })

  posixOnly('never follows or overwrites an entry that already has the name', () => {
    const base = tempDirectory()
    const drag = path.join(base, 'drag')
    fs.mkdirSync(drag, { mode: 0o700 })
    const victim = path.join(base, 'victim.txt')
    fs.writeFileSync(victim, 'keep')
    fs.symlinkSync(victim, path.join(drag, `p-${sanitizeDragFileName('a:b?.png')}`))
    expect(() => writeCanvasSystemDragFiles(files, drag, { uniquePrefix: () => 'p' })).toThrow(
      expect.objectContaining({ code: 'EEXIST' })
    )
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep')
  })
})
