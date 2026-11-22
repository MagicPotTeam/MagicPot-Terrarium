import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Real filesystem: symlinks, owners and modes are what these tests are about.
vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))

import {
  LOCAL_MEDIA_TEMP_ROOT_RECHECK_MS,
  createLocalMediaTempRootVerifier,
  ensurePrivateLocalMediaTempRoot
} from './localMediaTempRoot'
import {
  authorizeLocalMediaImportSourcePathAsync,
  resolveAuthorizedLocalMediaPath
} from './localMediaAccess'

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

  posixOnly('refuses a private (0600) regular file at the expected name', () => {
    const file = path.join(sharedTemp(), 'magicpot-local-media')
    fs.writeFileSync(file, 'not a directory', { mode: 0o600 })
    expect(fs.lstatSync(file).mode & 0o077).toBe(0)
    expect(ensurePrivateLocalMediaTempRoot(file)).toBe(false)
  })

  posixOnly(
    'refuses its own directory when tightening the mode changes nothing (vfat, CIFS)',
    () => {
      const root = path.join(sharedTemp(), 'magicpot-local-media')
      fs.mkdirSync(root)
      fs.chmodSync(root, 0o755)
      const chmodSync = vi.fn()
      expect(ensurePrivateLocalMediaTempRoot(root, { chmodSync })).toBe(false)
      expect(chmodSync).toHaveBeenCalledOnce()
    }
  )

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

describe('the verified temp root, remembered once accepted', () => {
  /** A verifier on the real filesystem whose lstat calls and log lines are counted. */
  const verifier = (overrides: Parameters<typeof createLocalMediaTempRootVerifier>[0] = {}) => {
    const lstatSync = vi.fn((target: string) => (overrides.lstatSync ?? fs.lstatSync)(target))
    const warn = vi.fn()
    return {
      lstatSync,
      warn,
      ...createLocalMediaTempRootVerifier({ ...overrides, lstatSync, warn })
    }
  }

  posixOnly('refuses a planted symlink, logs the reason once and never the path', () => {
    const temp = sharedTemp()
    const victim = path.join(temp, 'victim-home')
    fs.mkdirSync(victim, { mode: 0o700 })
    const root = path.join(temp, 'magicpot-local-media')
    fs.symlinkSync(victim, root)
    const subject = verifier()
    expect(subject.get(root)).toBeNull()
    expect(subject.get(root)).toBeNull()
    expect(subject.warn).toHaveBeenCalledOnce()
    expect(subject.warn.mock.calls[0][0]).toContain('symlink')
    expect(subject.warn.mock.calls[0][0]).not.toContain(temp)
    // A refusal is not remembered: the folder is checked again at the next use.
    expect(subject.lstatSync).toHaveBeenCalledTimes(2)
  })

  posixOnly('refuses a directory another user owns (as the stat reports it)', () => {
    const root = path.join(sharedTemp(), 'magicpot-local-media')
    fs.mkdirSync(root, { mode: 0o700 })
    const chmodSync = vi.fn()
    const subject = verifier({
      lstatSync: (target: string) => {
        const stat = fs.lstatSync(target)
        return {
          isDirectory: () => stat.isDirectory(),
          isSymbolicLink: () => stat.isSymbolicLink(),
          mode: stat.mode,
          uid: process.getuid!() + 1
        }
      },
      chmodSync
    })
    expect(subject.get(root)).toBeNull()
    expect(subject.warn.mock.calls[0][0]).toContain('other-owner')
    expect(chmodSync).not.toHaveBeenCalled()
  })

  posixOnly('tightens a 0777 directory of its own and then uses it', () => {
    const root = path.join(sharedTemp(), 'magicpot-local-media')
    fs.mkdirSync(root)
    fs.chmodSync(root, 0o777)
    const subject = verifier()
    expect(subject.get(root)).toBe(fs.realpathSync(root))
    expect(fs.lstatSync(root).mode & 0o777).toBe(0o700)
    expect(subject.warn).not.toHaveBeenCalled()
  })

  posixOnly('does not stat the folder again once accepted, until a write or a failed use', () => {
    const root = path.join(sharedTemp(), 'magicpot-local-media')
    const subject = verifier()
    const canonical = subject.get(root)
    expect(canonical).toBe(fs.realpathSync(root))
    const statsAfterFirst = subject.lstatSync.mock.calls.length
    for (let request = 0; request < 100; request += 1) expect(subject.get(root)).toBe(canonical)
    expect(subject.lstatSync).toHaveBeenCalledTimes(statsAfterFirst)
    // A write verifies again; so does the next use after a failed one.
    expect(subject.reverify(root)).toBe(canonical)
    expect(subject.lstatSync.mock.calls.length).toBeGreaterThan(statsAfterFirst)
    const statsAfterReverify = subject.lstatSync.mock.calls.length
    subject.forget()
    expect(subject.get(root)).toBe(canonical)
    expect(subject.lstatSync.mock.calls.length).toBeGreaterThan(statsAfterReverify)
  })

  posixOnly('never widens to a symlink put in place of the accepted folder later', async () => {
    const temp = sharedTemp()
    const victim = path.join(temp, 'victim-home')
    fs.mkdirSync(victim, { mode: 0o700 })
    fs.writeFileSync(path.join(victim, 'secret.png'), 'secret')
    const root = path.join(temp, 'magicpot-local-media')
    const subject = verifier()
    const canonical = subject.get(root)!
    expect(canonical).toBeTruthy()
    // The folder disappears (a temp cleaner) and a symlink is planted at its name.
    fs.rmdirSync(root)
    fs.symlinkSync(victim, root)
    const planted = path.join(root, 'secret.png')
    // Re-resolving the root by its name would follow the link: the danger.
    expect(resolveAuthorizedLocalMediaPath(planted, [root])).toBe(path.join(victim, 'secret.png'))
    // The pinned canonical path is never resolved again: nothing under the link is allowed.
    const pinned = [{ pinnedCanonicalPath: subject.get(root)! }]
    expect(resolveAuthorizedLocalMediaPath(planted, pinned)).toBeNull()
    await expect(authorizeLocalMediaImportSourcePathAsync(planted, pinned)).resolves.toBeNull()
    // And verifying again refuses the folder.
    expect(subject.reverify(root)).toBeNull()
  })

  posixOnly(
    'checks once a minute on reads that the folder is still the same one, refusing a changed one',
    () => {
      const temp = sharedTemp()
      const root = path.join(temp, 'magicpot-local-media')
      let clock = 0
      // Reports another inode once the folder counts as recreated (a file system may reuse the
      // freed inode number at once, which a real removal and mkdir here could not show).
      let recreated = false
      const subject = verifier({
        now: () => clock,
        lstatSync: (target: string) => {
          const stat = fs.lstatSync(target)
          return recreated
            ? Object.assign(Object.create(stat) as fs.Stats, { ino: stat.ino + 1 })
            : stat
        }
      })
      const canonical = subject.get(root)!
      expect(canonical).toBe(fs.realpathSync(root))
      const statsAfterAccept = subject.lstatSync.mock.calls.length
      clock = LOCAL_MEDIA_TEMP_ROOT_RECHECK_MS - 1
      expect(subject.get(root)).toBe(canonical)
      expect(subject.lstatSync).toHaveBeenCalledTimes(statsAfterAccept)
      // A minute later: one lstat, still the same folder.
      clock = LOCAL_MEDIA_TEMP_ROOT_RECHECK_MS
      expect(subject.get(root)).toBe(canonical)
      expect(subject.lstatSync).toHaveBeenCalledTimes(statsAfterAccept + 1)
      // Removed by a temp cleaner and created again: another folder at the same name.
      recreated = true
      clock += LOCAL_MEDIA_TEMP_ROOT_RECHECK_MS
      expect(subject.get(root)).toBeNull()
      expect(subject.warn.mock.calls.at(-1)?.[0]).toContain('changed')
      // The next use verifies afresh: main's own private folder is accepted again.
      expect(subject.get(root)).toBe(canonical)
      // Its mode opened by someone: refused at the next check.
      fs.chmodSync(root, 0o777)
      clock += LOCAL_MEDIA_TEMP_ROOT_RECHECK_MS
      expect(subject.get(root)).toBeNull()
      // Replaced by a symlink: refused, and refused again when verified afresh.
      expect(subject.get(root)).toBe(canonical)
      const victim = path.join(temp, 'victim-home')
      fs.mkdirSync(victim, { mode: 0o700 })
      fs.rmSync(root, { recursive: true })
      fs.symlinkSync(victim, root)
      clock += LOCAL_MEDIA_TEMP_ROOT_RECHECK_MS
      expect(subject.get(root)).toBeNull()
      expect(subject.get(root)).toBeNull()
    }
  )

  posixOnly('checks again after a system sleep, when only the wall clock moved', () => {
    const root = path.join(sharedTemp(), 'magicpot-local-media')
    // The monotonic clock stops while the system sleeps; the wall clock does not.
    const mono = 0
    let wall = 1_700_000_000_000
    let otherOwner = false
    const subject = verifier({
      now: () => mono,
      wallNow: () => wall,
      lstatSync: (target: string) => {
        const stat = fs.lstatSync(target)
        return otherOwner
          ? Object.assign(Object.create(stat) as fs.Stats, { uid: process.getuid!() + 1 })
          : stat
      }
    })
    const canonical = subject.get(root)!
    expect(canonical).toBe(fs.realpathSync(root))
    const statsAfterAccept = subject.lstatSync.mock.calls.length
    // Within the minute on both clocks: no check.
    wall += LOCAL_MEDIA_TEMP_ROOT_RECHECK_MS - 1
    expect(subject.get(root)).toBe(canonical)
    expect(subject.lstatSync).toHaveBeenCalledTimes(statsAfterAccept)
    // Eleven days asleep; on resume a temp cleaner removed the folder and another user made
    // one at its name. The first read checks again and refuses it.
    otherOwner = true
    wall += 11 * 24 * 3_600_000
    expect(subject.get(root)).toBeNull()
    expect(subject.warn.mock.calls.at(-1)?.[0]).toContain('changed')
    // A wall clock set back a minute or more counts too.
    otherOwner = false
    expect(subject.get(root)).toBe(canonical)
    const statsBeforeSetBack = subject.lstatSync.mock.calls.length
    wall -= LOCAL_MEDIA_TEMP_ROOT_RECHECK_MS
    expect(subject.get(root)).toBe(canonical)
    expect(subject.lstatSync).toHaveBeenCalledTimes(statsBeforeSetBack + 1)
  })
})
