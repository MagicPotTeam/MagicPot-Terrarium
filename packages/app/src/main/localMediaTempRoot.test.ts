import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Real filesystem: symlinks, owners and modes are what these tests are about.
vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))

import { ensurePrivateLocalMediaTempRoot } from './localMediaTempRoot'

const cleanupPaths: string[] = []
afterEach(() => {
  cleanupPaths.splice(0).forEach((target) => fs.rmSync(target, { recursive: true, force: true }))
})

/** A stand-in for the shared OS temp directory. */
function sharedTemp(): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-shared-tmp-')))
  cleanupPaths.push(directory)
  fs.chmodSync(directory, 0o1777)
  return directory
}

const posixOnly = it.skipIf(process.platform === 'win32')

describe('the private local-media temp root', () => {
  posixOnly('creates the missing directory as a private directory and trusts it', () => {
    const root = path.join(sharedTemp(), 'magicpot-local-media')
    expect(ensurePrivateLocalMediaTempRoot(root)).toBe(true)
    const stat = fs.lstatSync(root)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
    expect(stat.uid).toBe(process.getuid!())
    // Checked again on every call: still trusted.
    expect(ensurePrivateLocalMediaTempRoot(root)).toBe(true)
  })

  posixOnly('refuses a symlink another user planted at the expected name', () => {
    const temp = sharedTemp()
    const target = path.join(temp, 'chosen-by-someone-else')
    fs.mkdirSync(target, { mode: 0o700 })
    const root = path.join(temp, 'magicpot-local-media')
    fs.symlinkSync(target, root)
    expect(ensurePrivateLocalMediaTempRoot(root)).toBe(false)
    // Nothing is followed, changed or removed.
    expect(fs.lstatSync(root).isSymbolicLink()).toBe(true)
  })

  posixOnly('refuses a symlink planted between the check and the mkdir', () => {
    const temp = sharedTemp()
    const target = path.join(temp, 'chosen-by-someone-else')
    fs.mkdirSync(target)
    const root = path.join(temp, 'magicpot-local-media')
    expect(
      ensurePrivateLocalMediaTempRoot(root, {
        mkdirSync: () => fs.symlinkSync(target, root)
      })
    ).toBe(false)
  })

  posixOnly('refuses a directory owned by another user', () => {
    const root = path.join(sharedTemp(), 'magicpot-local-media')
    fs.mkdirSync(root, { mode: 0o700 })
    const chmodSync = vi.fn()
    expect(
      ensurePrivateLocalMediaTempRoot(root, { getuid: () => process.getuid!() + 1, chmodSync })
    ).toBe(false)
    expect(chmodSync).not.toHaveBeenCalled()
  })

  posixOnly('tightens a looser mode on its own directory', () => {
    const root = path.join(sharedTemp(), 'magicpot-local-media')
    fs.mkdirSync(root)
    fs.chmodSync(root, 0o777)
    expect(ensurePrivateLocalMediaTempRoot(root)).toBe(true)
    expect(fs.lstatSync(root).mode & 0o777).toBe(0o700)
  })

  posixOnly('refuses its own directory when the mode cannot be tightened', () => {
    const root = path.join(sharedTemp(), 'magicpot-local-media')
    fs.mkdirSync(root)
    fs.chmodSync(root, 0o755)
    expect(
      ensurePrivateLocalMediaTempRoot(root, {
        chmodSync: () => {
          throw Object.assign(new Error('denied'), { code: 'EPERM' })
        }
      })
    ).toBe(false)
  })

  it('refuses a file at the expected name and an unreadable location', () => {
    const temp = sharedTemp()
    const file = path.join(temp, 'magicpot-local-media')
    fs.writeFileSync(file, 'not a directory')
    expect(ensurePrivateLocalMediaTempRoot(file)).toBe(false)
    expect(
      ensurePrivateLocalMediaTempRoot(path.join(temp, 'other'), {
        lstatSync: () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' })
        }
      })
    ).toBe(false)
  })

  it('needs no owner or mode where there is no POSIX owner (Windows), but still no link', () => {
    const temp = sharedTemp()
    const root = path.join(temp, 'magicpot-local-media')
    expect(ensurePrivateLocalMediaTempRoot(root, { getuid: null })).toBe(true)
    if (process.platform !== 'win32') {
      const link = path.join(temp, 'linked')
      fs.symlinkSync(root, link)
      expect(ensurePrivateLocalMediaTempRoot(link, { getuid: null })).toBe(false)
    }
  })
})
