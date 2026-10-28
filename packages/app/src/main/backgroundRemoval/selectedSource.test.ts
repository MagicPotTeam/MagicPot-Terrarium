import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_IMAGE_BYTES } from './imageValidation'
import { MAX_BACKGROUND_REMOVAL_LIFETIME_MS, type BackgroundRemovalScope } from './runner'
import {
  createSelectedSourceReader,
  type SelectedSourceIO,
  type SelectedSourceResult,
  type TrustedSelectedSourceOptions
} from './selectedSource'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('fs')
vi.unmock('fs/promises')

const scope: BackgroundRemovalScope = {
  senderId: 7,
  documentEpoch: 3,
  projectId: 'project-1',
  operationId: 'operation-1',
  sourceId: 'source-1'
}
const fail = (error: string) => ({ status: 'error', error })
const deadline = (ms = 30_000) => ({
  expiresAt: Date.now() + ms,
  monotonicDeadline: performance.now() + ms
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
// Real filesystem adapter: only individual tests replace methods with labelled synthetic faults.
const realIO: SelectedSourceIO = {
  lstat: (value) => fs.lstat(value, { bigint: true }),
  realpath: (value) => fs.realpath(value),
  statfs: (value) => fs.statfs(value, { bigint: true }),
  open: async (value, flags) => {
    const handle = await fs.open(value, flags)
    return {
      stat: () => handle.stat({ bigint: true }),
      read: async (buffer, offset, length, position) =>
        (await handle.read(buffer, offset, length, position)).bytesRead,
      close: () => handle.close()
    }
  }
}
let root: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'd04-selected-source-worker-')))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await fs.rm(root, { recursive: true, force: true })
})
async function fixture(name = 'raw.png', bytes = Buffer.from([0, 255, 1, 2])) {
  const selected = path.join(root, name)
  await fs.mkdir(path.dirname(selected), { recursive: true })
  await fs.writeFile(selected, bytes)
  return selected
}
function reader(selected: string | null, options: TrustedSelectedSourceOptions = {}) {
  return createSelectedSourceReader({
    chooseNative: async () => selected,
    isCurrent: () => true,
    ...options
  })
}

describe('main-only source contract, not decode or processing consent', () => {
  it('defaults unavailable without touching filesystem or chooser', async () => {
    const lstat = vi.spyOn(fs, 'lstat')
    const chooseNative = vi.fn(async () => path.join(root, 'unread.png'))
    expect(await createSelectedSourceReader().readSelected(scope, deadline())).toEqual(
      fail('UNAVAILABLE')
    )
    expect(
      await createSelectedSourceReader({ isCurrent: () => true }).readSelected(scope, deadline())
    ).toEqual(fail('UNAVAILABLE'))
    expect(
      await createSelectedSourceReader({ chooseNative }).readSelected(scope, deadline())
    ).toEqual(fail('UNAVAILABLE'))
    expect(chooseNative).not.toHaveBeenCalled()
    expect(lstat).not.toHaveBeenCalled()
  })

  it.each([0, 4, MAX_IMAGE_BYTES])(
    'reads %i arbitrary raw bytes, without claiming a decoded image',
    async (size) => {
      const input = Buffer.alloc(size, 0xfe)
      const selected = await fixture('safe 空 格 café.png', input)
      const readFile = vi.spyOn(fs, 'readFile')
      const limits = deadline()
      const submitted = { ...scope, ignoredPath: selected }
      const chooseNative = vi.fn(
        async (context: Readonly<BackgroundRemovalScope>, signal: AbortSignal) => {
          expect(context).toEqual(scope)
          expect(Object.isFrozen(context)).toBe(true)
          expect(signal.aborted).toBe(false)
          submitted.sourceId = 'mutated-original'
          return selected
        }
      )
      const result = await reader(selected, { chooseNative }).readSelected(submitted, limits)
      expect(result.status).toBe('source')
      if (result.status !== 'source') throw new Error('expected source')
      expect(Object.keys(result).sort()).toEqual([
        'bytes',
        'expiresAt',
        'scope',
        'sha256',
        'status'
      ])
      expect(result.bytes.equals(input)).toBe(true)
      expect(result.bytes.buffer.byteLength).toBe(size)
      expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'))
      expect(result.scope).toEqual(scope)
      expect(result.scope).not.toBe(submitted)
      expect(Object.isFrozen(result.scope)).toBe(true)
      expect(result.expiresAt).toBe(limits.expiresAt)
      expect(readFile).not.toHaveBeenCalled()
    }
  )

  it('rejects one byte above the bound before opening', async () => {
    const selected = await fixture('large.png', Buffer.alloc(MAX_IMAGE_BYTES + 1))
    const open = vi.spyOn(fs, 'open')
    expect(await reader(selected).readSelected(scope, deadline())).toEqual(fail('TOO_LARGE'))
    expect(open).not.toHaveBeenCalled()
  })

  it('detaches returned bytes from the sentinel buffer and uses one read-only bounded handle', async () => {
    const selected = await fixture()
    const scratch: Buffer[] = []
    const lengths: number[] = []
    const open = vi.fn<SelectedSourceIO['open']>(async (value, flags) => {
      expect(flags).toBe(
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
      )
      const handle = await realIO.open(value, flags)
      return {
        ...handle,
        read: async (buffer, offset, length, position) => {
          scratch.push(buffer)
          lengths.push(length)
          return handle.read(buffer, offset, length, position)
        }
      }
    })
    const result = await reader(selected, { io: { ...realIO, open } }).readSelected(
      scope,
      deadline()
    )
    expect(result.status).toBe('source')
    if (result.status !== 'source') throw new Error('expected source')
    expect(open).toHaveBeenCalledTimes(1)
    expect(scratch[0].length).toBe(result.bytes.length + 1)
    expect(lengths.every((length) => length <= 16 * 1024)).toBe(true)
    expect(scratch[0].every((byte) => byte === 0)).toBe(true)
    scratch[0].fill(9)
    expect(result.bytes).toEqual(Buffer.from([0, 255, 1, 2]))
  })

  it.each(['', '../path', 'https://host/image', 'x'.repeat(129)])(
    'rejects nonopaque scope %j',
    async (sourceId) => {
      const chooseNative = vi.fn(async () => null)
      expect(
        await reader(null, { chooseNative }).readSelected({ ...scope, sourceId }, deadline())
      ).toEqual(fail('INVALID_REQUEST'))
      expect(chooseNative).not.toHaveBeenCalled()
    }
  )

  it('chooser cancel and pre-abort never access the filesystem', async () => {
    const lstat = vi.spyOn(fs, 'lstat')
    expect(await reader(null).readSelected(scope, deadline())).toEqual(fail('CANCELLED'))
    const controller = new AbortController()
    controller.abort(new Error('secret reason'))
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const isCurrent = vi.fn(() => true)
    const chooseNative = vi.fn(async () => path.join(root, 'unread.png'))
    expect(
      await reader(null, { chooseNative, isCurrent }).readSelected(scope, {
        ...deadline(),
        signal: controller.signal
      })
    ).toEqual(fail('CANCELLED'))
    expect(add).not.toHaveBeenCalled()
    expect(isCurrent).not.toHaveBeenCalled()
    expect(chooseNative).not.toHaveBeenCalled()
    expect(lstat).not.toHaveBeenCalled()
  })
})

describe('scope, deadlines and retained capacity', () => {
  it.each(['senderId', 'documentEpoch', 'projectId', 'operationId', 'sourceId'] as const)(
    'checks the captured entire scope on %s change',
    async (field) => {
      const selected = await fixture()
      let current = { ...scope }
      const gate = deferred<string | null>()
      const source = reader(selected, {
        chooseNative: () => gate.promise,
        isCurrent: (captured) =>
          Object.keys(scope).every(
            (key) => Reflect.get(captured, key) === Reflect.get(current, key)
          )
      })
      const pending = source.readSelected(scope, deadline())
      current = { ...scope, [field]: typeof scope[field] === 'number' ? 99 : 'other' }
      gate.resolve(selected)
      expect(await pending).toEqual(fail('REVOKED'))
    }
  )

  it.each(['cancel', 'invalidate', 'abort'] as const)(
    'synchronous %s retains an uncooperative chooser slot',
    async (action) => {
      const gate = deferred<string | null>()
      const controller = new AbortController()
      let chooserSignal: AbortSignal | undefined
      const source = reader(null, {
        chooseNative: (_scope, signal) => {
          chooserSignal = signal
          return gate.promise
        }
      })
      let settled = false
      const pending = source
        .readSelected(scope, { ...deadline(), signal: controller.signal })
        .then((result) => {
          settled = true
          return result
        })
      if (action === 'abort') controller.abort()
      else source[action]()
      expect(chooserSignal?.aborted).toBe(true)
      expect(await source.readSelected(scope, deadline())).toEqual(fail('BUSY'))
      expect(settled).toBe(false)
      gate.resolve(null)
      expect(await pending).toEqual(fail(action === 'invalidate' ? 'REVOKED' : 'CANCELLED'))
      expect(await source.readSelected(scope, deadline())).toEqual(fail('CANCELLED'))
    }
  )

  it('reserves before reentrant current and chooser callbacks, including synchronous cancellation', async () => {
    const reentered: Promise<SelectedSourceResult>[] = []
    const gate = deferred<string | null>()
    const source = reader(null, {
      isCurrent: () => {
        reentered.push(source.readSelected(scope, deadline()))
        return true
      },
      chooseNative: () => {
        reentered.push(source.readSelected(scope, deadline()))
        source.cancel()
        return gate.promise
      }
    })
    const pending = source.readSelected(scope, deadline())
    expect(await Promise.all(reentered)).toEqual(reentered.map(() => fail('BUSY')))
    expect(await source.readSelected(scope, deadline())).toEqual(fail('BUSY'))
    gate.resolve(null)
    expect(await pending).toEqual(fail('CANCELLED'))
  })

  it.each(['open', 'read', 'close'] as const)(
    'retains cancellation capacity through deferred real %s and close',
    async (stage) => {
      const selected = await fixture()
      const gate = deferred<void>()
      const entered = deferred<void>()
      let scratch: Buffer | undefined
      let closes = 0
      const pause = async () => {
        entered.resolve()
        await gate.promise
      }
      const io: SelectedSourceIO = {
        ...realIO,
        open: async (value, flags) => {
          const handle = await realIO.open(value, flags)
          if (stage === 'open') await pause()
          return {
            ...handle,
            read: async (buffer, offset, length, position) => {
              scratch = buffer
              if (stage === 'read') await pause()
              return handle.read(buffer, offset, length, position)
            },
            close: async () => {
              closes++
              if (stage === 'close') await pause()
              await handle.close()
            }
          }
        }
      }
      const source = reader(selected, { io })
      let settled = false
      const pending = source.readSelected(scope, deadline()).then((result) => {
        settled = true
        return result
      })
      await entered.promise
      source.cancel()
      expect(await source.readSelected(scope, deadline())).toEqual(fail('BUSY'))
      expect(settled).toBe(false)
      gate.resolve()
      expect(await pending).toEqual(fail('CANCELLED'))
      expect(closes).toBe(1)
      expect(scratch?.every((byte) => byte === 0) ?? true).toBe(true)
    }
  )

  it.each([false, true])(
    'quarantines on synthetic close failure, cancellation=%s; never returns success',
    async (cancel) => {
      const selected = await fixture()
      const gate = deferred<void>()
      const entered = deferred<void>()
      const io: SelectedSourceIO = {
        ...realIO,
        open: async (value, flags) => {
          const handle = await realIO.open(value, flags)
          return {
            ...handle,
            close: async () => {
              entered.resolve()
              await gate.promise
              await handle.close() // Test cleanup is real; the reported failure is synthetic.
              throw new Error(`${selected} secret close failure`)
            }
          }
        }
      }
      const source = reader(selected, { io })
      const pending = source.readSelected(scope, deadline())
      await entered.promise
      if (cancel) source.cancel()
      expect(await source.readSelected(scope, deadline())).toEqual(fail('BUSY'))
      gate.resolve()
      expect(await pending).toEqual(fail('IO_ERROR'))
      source.invalidate()
      source.cancel()
      expect(await source.readSelected(scope, deadline())).toEqual(fail('UNAVAILABLE'))
    }
  )

  it.each(['wall', 'monotonic', 'cap-wall', 'cap-monotonic', 'nan'] as const)(
    'rejects preexpired or invalid %s deadline before chooser',
    async (kind) => {
      const limits = deadline()
      if (kind === 'wall') limits.expiresAt = Date.now() - 1
      if (kind === 'monotonic') limits.monotonicDeadline = performance.now() - 1
      if (kind === 'cap-wall') limits.expiresAt += MAX_BACKGROUND_REMOVAL_LIFETIME_MS
      if (kind === 'cap-monotonic') limits.monotonicDeadline += MAX_BACKGROUND_REMOVAL_LIFETIME_MS
      if (kind === 'nan') limits.monotonicDeadline = NaN
      const chooseNative = vi.fn(async () => null)
      const source = reader(null, { chooseNative })
      expect(await source.readSelected(scope, limits)).toEqual(
        fail(kind === 'wall' || kind === 'monotonic' ? 'EXPIRED' : 'INVALID_REQUEST')
      )
      expect(chooseNative).not.toHaveBeenCalled()
    }
  )

  it('requires both existing deadlines rather than allocating a default lifetime', async () => {
    const source = reader(null)
    // @ts-expect-error Deliberately verify the runtime boundary as well as the required type.
    expect(await source.readSelected(scope)).toEqual(fail('INVALID_REQUEST'))
    // @ts-expect-error A remaining relative duration is not an absolute monotonic deadline.
    expect(await source.readSelected(scope, { expiresAt: Date.now() + 1000 })).toEqual(
      fail('INVALID_REQUEST')
    )
  })

  it('uses the already remaining timer, unrefs it, and does not free an expired chooser', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const gate = deferred<string | null>()
    const source = reader(null, { chooseNative: () => gate.promise })
    const limits = deadline(80)
    const pending = source.readSelected(scope, limits)
    expect(timer).toHaveBeenCalledTimes(1)
    expect(timer.mock.calls[0][1]).toBeLessThanOrEqual(80)
    expect(timer.mock.results[0].value.hasRef()).toBe(false)
    await vi.advanceTimersByTimeAsync(80)
    expect(await source.readSelected(scope, deadline())).toEqual(fail('BUSY'))
    gate.resolve(null)
    expect(await pending).toEqual(fail('EXPIRED'))
  })

  it.each(['wall', 'monotonic'] as const)(
    'late %s clock checks cover chooser time without resetting the deadline',
    async (clock) => {
      const limits = deadline()
      const original = { ...limits }
      const lstat = vi.spyOn(fs, 'lstat')
      const source = reader(null, {
        chooseNative: async () => {
          limits.expiresAt += MAX_BACKGROUND_REMOVAL_LIFETIME_MS
          limits.monotonicDeadline += MAX_BACKGROUND_REMOVAL_LIFETIME_MS
          if (clock === 'wall') vi.spyOn(Date, 'now').mockReturnValue(original.expiresAt)
          else vi.spyOn(performance, 'now').mockReturnValue(original.monotonicDeadline)
          return path.join(root, 'unread.png')
        }
      })
      expect(await source.readSelected(scope, limits)).toEqual(fail('EXPIRED'))
      expect(lstat).not.toHaveBeenCalled()
    }
  )

  it.each(['throw', 'cancel', 'expire'] as const)(
    'rechecks synchronous isCurrent %s before chooser',
    async (action) => {
      const limits = deadline()
      const chooseNative = vi.fn(async () => null)
      const source = reader(null, {
        chooseNative,
        isCurrent: () => {
          if (action === 'throw') throw new Error(`${root} secret`)
          if (action === 'cancel') source.cancel()
          if (action === 'expire') vi.spyOn(Date, 'now').mockReturnValue(limits.expiresAt)
          return true
        }
      })
      expect(await source.readSelected(scope, limits)).toEqual(
        fail(action === 'throw' ? 'REVOKED' : action === 'cancel' ? 'CANCELLED' : 'EXPIRED')
      )
      expect(chooseNative).not.toHaveBeenCalled()
    }
  )

  it('rechecks current after close and immediately before outer delivery', async () => {
    const selected = await fixture()
    let afterCloseChecks = 0
    let closed = false
    const io: SelectedSourceIO = {
      ...realIO,
      open: async (value, flags) => {
        const handle = await realIO.open(value, flags)
        return {
          ...handle,
          close: async () => {
            await handle.close()
            closed = true
          }
        }
      }
    }
    const source = reader(selected, { io, isCurrent: () => !(closed && ++afterCloseChecks === 2) })
    expect(await source.readSelected(scope, deadline())).toEqual(fail('REVOKED'))
    expect(afterCloseChecks).toBe(2)
  })

  it.each(['lstat', 'realpath', 'statfs', 'open', 'stat', 'read', 'close'] as const)(
    'rechecks authority after %s settlement and closes acquired handles',
    async (stage) => {
      const selected = await fixture()
      let current = true
      let opened = false
      let closed = false
      const io: SelectedSourceIO = {
        lstat: async (value) => {
          const result = await realIO.lstat(value)
          if (stage === 'lstat') current = false
          return result
        },
        realpath: async (value) => {
          const result = await realIO.realpath(value)
          if (stage === 'realpath') current = false
          return result
        },
        statfs: async (value) => {
          const result = await realIO.statfs(value)
          if (stage === 'statfs') current = false
          return result
        },
        open: async (value, flags) => {
          const handle = await realIO.open(value, flags)
          opened = true
          if (stage === 'open') current = false
          return {
            stat: async () => {
              const result = await handle.stat()
              if (stage === 'stat') current = false
              return result
            },
            read: async (...args) => {
              const result = await handle.read(...args)
              if (stage === 'read') current = false
              return result
            },
            close: async () => {
              await handle.close()
              closed = true
              if (stage === 'close') current = false
            }
          }
        }
      }
      expect(
        await reader(selected, { io, isCurrent: () => current }).readSelected(scope, deadline())
      ).toEqual(fail('REVOKED'))
      expect(closed).toBe(opened)
    }
  )

  it('expiry during close drops bytes without resetting the original deadline', async () => {
    const selected = await fixture()
    const limits = deadline()
    const io: SelectedSourceIO = {
      ...realIO,
      open: async (value, flags) => {
        const handle = await realIO.open(value, flags)
        return {
          ...handle,
          close: async () => {
            await handle.close()
            vi.spyOn(Date, 'now').mockReturnValue(limits.expiresAt)
          }
        }
      }
    }
    expect(await reader(selected, { io }).readSelected(scope, limits)).toEqual(fail('EXPIRED'))
  })
})

describe('conservative local path and pinned file integrity', () => {
  it.each([
    '.env',
    '.env.local',
    '.envrc',
    '.ssh/id_rsa',
    '.git/config',
    '.aws/config',
    '.azure/token',
    '.gnupg/key',
    '.kube/config',
    '.npmrc',
    '.netrc',
    '.pypirc',
    '.dockercfg',
    'auth.json',
    'Cookies',
    'cookies.sqlite',
    'credentials.json',
    'secrets.txt',
    'private.pem',
    'private.key',
    'store.p12',
    'vault.kdbx',
    '.kohakuterrarium/session',
    'fixture.kohakutr',
    'fixture.kohakutr-wal',
    'fixture.kohakutr.backup',
    'fixture.kt',
    'fixture.drives',
    'fixture.lock',
    'fixture.db-wal',
    'CON',
    'LPT1.png',
    'COM¹.png',
    'CONIN$',
    'raw.png:stream',
    'raw.png.',
    'raw.png ',
    `nested${path.sep}..${path.sep}raw.png`,
    `.${path.sep}raw.png`,
    `nested${path.sep}${path.sep}raw.png`,
    'control\u0001.png'
  ])(
    'rejects synthetic sensitive/alias component %j without filesystem access',
    async (relative) => {
      const lstat = vi.spyOn(fs, 'lstat')
      expect(await reader(`${root}${path.sep}${relative}`).readSelected(scope, deadline())).toEqual(
        fail('PATH_DENIED')
      )
      expect(lstat).not.toHaveBeenCalled()
    }
  )

  it.each([
    'relative.png',
    'C:relative.png',
    '\\\\server\\share\\raw.png',
    '//server/share/raw.png',
    '\\\\?\\C:\\raw.png',
    '\\\\.\\CON',
    'https://host/raw.png',
    'file:///raw.png'
  ])('rejects nonlocal selection %j', async (selected) => {
    const lstat = vi.spyOn(fs, 'lstat')
    expect(await reader(selected).readSelected(scope, deadline())).toEqual(fail('PATH_DENIED'))
    expect(lstat).not.toHaveBeenCalled()
  })

  it('rejects directory, missing file, synthetic remote filesystem and canonical redirect', async () => {
    expect(await reader(root).readSelected(scope, deadline())).toEqual(fail('PATH_DENIED'))
    expect(await reader(path.join(root, 'missing.png')).readSelected(scope, deadline())).toEqual(
      fail('NOT_FOUND')
    )
    const selected = await fixture()
    expect(
      await reader(selected, {
        io: { ...realIO, statfs: async () => ({ type: 0x6969n }) }
      }).readSelected(scope, deadline())
    ).toEqual(fail('PATH_DENIED'))
    expect(
      await reader(selected, {
        io: { ...realIO, realpath: async () => path.join(root, 'other.png') }
      }).readSelected(scope, deadline())
    ).toEqual(fail('PATH_DENIED'))
  })

  it.each(['replace', 'modify', 'truncate', 'grow'] as const)(
    'detects actual %s after the first checked stat',
    async (action) => {
      const selected = await fixture()
      const open: SelectedSourceIO['open'] = async (value, flags) => {
        if (action === 'replace') {
          await fs.rename(selected, path.join(root, 'old.png'))
          await fs.writeFile(selected, Buffer.from([0, 255, 1, 2]))
        } else {
          if (action === 'modify') await fs.writeFile(selected, Buffer.from([2, 1, 255, 0]))
          if (action === 'truncate') await fs.truncate(selected, 1)
          if (action === 'grow') await fs.appendFile(selected, Buffer.from([3]))
          await fs.utimes(selected, 1, 1)
        }
        return realIO.open(value, flags)
      }
      expect(
        await reader(selected, { io: { ...realIO, open } }).readSelected(scope, deadline())
      ).toEqual(fail('FILE_CHANGED'))
    }
  )

  it.each(['modify', 'truncate', 'grow', 'hardlink'] as const)(
    'detects actual %s during bounded read and closes',
    async (action) => {
      const selected = await fixture()
      let mutated = false
      let closed = false
      const io: SelectedSourceIO = {
        ...realIO,
        open: async (value, flags) => {
          const handle = await realIO.open(value, flags)
          return {
            ...handle,
            read: async (buffer, offset, length, position) => {
              if (!mutated) {
                mutated = true
                if (action === 'modify') {
                  await fs.writeFile(selected, Buffer.from([3, 2, 1, 0]))
                  await fs.utimes(selected, 1, 1)
                }
                if (action === 'truncate') await fs.truncate(selected, 1)
                if (action === 'grow') await fs.appendFile(selected, Buffer.from([3]))
                if (action === 'hardlink') await fs.link(selected, path.join(root, 'alias.png'))
              }
              return handle.read(buffer, offset, length, position)
            },
            close: async () => {
              await handle.close()
              closed = true
            }
          }
        }
      }
      expect(await reader(selected, { io }).readSelected(scope, deadline())).toEqual(
        fail('FILE_CHANGED')
      )
      expect(closed).toBe(true)
    }
  )

  it('rejects actual hardlinks before open', async () => {
    const selected = await fixture()
    await fs.link(selected, path.join(root, 'alias.png'))
    const open = vi.spyOn(fs, 'open')
    expect(await reader(selected).readSelected(scope, deadline())).toEqual(fail('PATH_DENIED'))
    expect(open).not.toHaveBeenCalled()
  })

  it.for(['directory', 'file'] as const)(
    'rejects actual %s symlink/junction if OS permits creation',
    async (kind, context) => {
      const selected = await fixture('actual/raw.png')
      const alias = path.join(root, kind === 'directory' ? 'alias' : 'alias.png')
      try {
        await fs.symlink(
          kind === 'directory' ? path.dirname(selected) : selected,
          alias,
          kind === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir'
        )
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          (error.code === 'EPERM' || error.code === 'ENOTSUP')
        ) {
          context.skip()
          return
        }
        throw error
      }
      expect(
        await reader(kind === 'directory' ? path.join(alias, 'raw.png') : alias).readSelected(
          scope,
          deadline()
        )
      ).toEqual(fail('PATH_DENIED'))
    }
  )

  it.each(['before', 'after'] as const)(
    'rechecks the full path chain %s read (synthetic directory identity change)',
    async (stage) => {
      const selected = await fixture('actual/raw.png')
      let changed = false
      let reads = 0
      let closed = false
      // Windows denies renaming a directory with an open child. Inject only its identity change.
      const io: SelectedSourceIO = {
        ...realIO,
        lstat: async (value) => {
          const stat = await realIO.lstat(value)
          return changed && value === path.dirname(selected)
            ? Object.assign(stat, { ino: stat.ino + 1n })
            : stat
        },
        open: async (value, flags) => {
          const handle = await realIO.open(value, flags)
          if (stage === 'before') changed = true
          return {
            ...handle,
            read: async (...args) => {
              reads++
              changed = true
              return handle.read(...args)
            },
            close: async () => {
              await handle.close()
              closed = true
            }
          }
        }
      }
      expect(await reader(selected, { io }).readSelected(scope, deadline())).toEqual(
        fail('FILE_CHANGED')
      )
      expect(reads === 0).toBe(stage === 'before')
      expect(closed).toBe(true)
    }
  )

  it.each([0, 4])(
    'size+1 sentinel detects growth despite synthetic unchanged stats (initial size %i)',
    async (size) => {
      const selected = await fixture('raw.png', Buffer.alloc(size))
      const original = await realIO.lstat(selected)
      let added = false
      let bytesRead = 0
      const io: SelectedSourceIO = {
        ...realIO,
        lstat: async (value) => (value === selected ? original : realIO.lstat(value)),
        open: async (value, flags) => {
          const handle = await realIO.open(value, flags)
          return {
            ...handle,
            stat: async () => original,
            read: async (...args) => {
              if (!added) {
                added = true
                await fs.appendFile(selected, Buffer.from([1]))
              }
              const read = await handle.read(...args)
              bytesRead += read
              return read
            }
          }
        }
      }
      expect(await reader(selected, { io }).readSelected(scope, deadline())).toEqual(
        fail('FILE_CHANGED')
      )
      expect(bytesRead).toBe(size + 1)
    }
  )

  it('rechecks canonical path after read (synthetic redirect, not an OS race proof)', async () => {
    const selected = await fixture()
    let calls = 0
    const io: SelectedSourceIO = {
      ...realIO,
      realpath: async (value) =>
        ++calls === 3 ? path.join(root, 'other.png') : realIO.realpath(value)
    }
    expect(await reader(selected, { io }).readSelected(scope, deadline())).toEqual(
      fail('PATH_DENIED')
    )
    expect(calls).toBe(3)
  })

  it.each(['chooser', 'lstat', 'open', 'stat', 'read'] as const)(
    'redacts raw %s errors and closes acquired handles',
    async (stage) => {
      const selected = await fixture()
      const error = Object.assign(new Error(`${selected} secret-token`), { code: 'EIO' })
      let closed = false
      const io: SelectedSourceIO = {
        ...realIO,
        lstat: async (value) => {
          if (stage === 'lstat') throw error
          return realIO.lstat(value)
        },
        open: async (value, flags) => {
          if (stage === 'open') throw error
          const handle = await realIO.open(value, flags)
          return {
            ...handle,
            stat: async () => {
              if (stage === 'stat') throw error
              return handle.stat()
            },
            read: async (...args) => {
              if (stage === 'read') throw error
              return handle.read(...args)
            },
            close: async () => {
              await handle.close()
              closed = true
            }
          }
        }
      }
      const source = reader(selected, {
        io,
        chooseNative: async () => {
          if (stage === 'chooser') throw error
          return selected
        }
      })
      expect(await source.readSelected(scope, deadline())).toEqual(fail('IO_ERROR'))
      expect(closed).toBe(stage === 'read' || stage === 'stat')
    }
  )
})

describe('unsuppressible external abort', () => {
  it.each(['chooser', 'open', 'read', 'close'] as const)(
    'ignores earlier stopImmediatePropagation during %s, aborts immediately and drains late success',
    async (stage) => {
      const selected = await fixture()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const controller = new AbortController()
      const suppress = vi.fn((event: Event) => event.stopImmediatePropagation())
      controller.signal.addEventListener('abort', suppress, { once: true })
      const gate = deferred<void>()
      const entered = deferred<void>()
      const pause = async () => {
        entered.resolve()
        await gate.promise
      }
      let internal: AbortSignal | undefined
      let scratch: Buffer | undefined
      let closes = 0
      const attempts: Promise<SelectedSourceResult>[] = []
      const source = reader(selected, {
        chooseNative: async (_scope, signal) => {
          internal = signal
          signal.addEventListener(
            'abort',
            () => attempts.push(source.readSelected(scope, deadline())),
            { once: true }
          )
          if (stage === 'chooser') await pause()
          return selected
        },
        io: {
          ...realIO,
          open: async (value, flags) => {
            const handle = await realIO.open(value, flags)
            if (stage === 'open') await pause()
            return {
              ...handle,
              read: async (buffer, offset, length, position) => {
                scratch = buffer
                if (stage === 'read') await pause()
                return handle.read(buffer, offset, length, position)
              },
              close: async () => {
                closes++
                if (stage === 'close') await pause()
                await handle.close()
              }
            }
          }
        }
      })
      const replacement = new AbortController()
      const limits = { ...deadline(), signal: controller.signal }
      let settled = false
      const pending = source.readSelected(scope, limits).then((result) => {
        settled = true
        return result
      })
      limits.signal = replacement.signal
      await entered.promise
      try {
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(2)
        controller.abort(new Error('private abort reason'))
        expect(suppress).toHaveBeenCalledOnce()
        expect(internal).not.toBe(controller.signal)
        expect.soft(internal?.aborted).toBe(true)
        expect.soft(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        expect(await source.readSelected(scope, deadline())).toEqual(fail('BUSY'))
        expect.soft(await Promise.all(attempts)).toEqual([fail('BUSY')])
        expect(settled).toBe(false)
      } finally {
        gate.resolve()
      }
      expect.soft(await pending).toEqual(fail('CANCELLED'))
      expect.soft(closes).toBe(stage === 'chooser' ? 0 : 1)
      expect(scratch?.every((byte) => byte === 0) ?? true).toBe(true)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(getEventListeners(replacement.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(await source.readSelected(scope, deadline())).toMatchObject({ status: 'source' })
    }
  )

  it('releases the reserved slot and timer when listener installation throws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const chooseNative = vi.fn(async () => null)
    const source = reader(null, { chooseNative })
    let attempt: Promise<SelectedSourceResult> | undefined
    vi.spyOn(controller.signal, 'addEventListener').mockImplementationOnce(() => {
      attempt = source.readSelected(scope, deadline())
      throw new Error('synthetic listener installation failure')
    })
    // Convert an unexpected rejection to data so RED also records any capacity/timer leak.
    const result = await source
      .readSelected(scope, { ...deadline(), signal: controller.signal })
      .catch(() => ({ status: 'unexpected rejection' }))
    expect.soft(result).toEqual(fail('IO_ERROR'))
    expect(await attempt).toEqual(fail('BUSY'))
    expect(chooseNative).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect.soft(vi.getTimerCount()).toBe(0)
    expect
      .soft(await source.readSelected(scope, { ...deadline(), signal: controller.signal }))
      .toEqual(fail('CANCELLED'))
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect.soft(vi.getTimerCount()).toBe(0)
  })
})

describe('external subscription lifecycle', () => {
  it.each([
    'success',
    'chooser cancel',
    'chooser error',
    'path denied',
    'read error',
    'close error',
    'cancel',
    'invalidate',
    'external abort',
    'expiry'
  ])('detaches exactly once after %s, including mandatory close', async (terminal) => {
    const selected = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const replacement = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let closes = 0
    let reads = 0
    const subscriptions: unknown[][] = []
    const attempts: SelectedSourceResult[] = []
    const limits = { ...deadline(1_000), signal: controller.signal }
    const source = reader(selected, {
      chooseNative: async () => {
        limits.signal = replacement.signal
        subscriptions.push(getEventListeners(controller.signal, 'abort'))
        if (terminal === 'chooser error') throw new Error('synthetic chooser failure')
        if (terminal === 'chooser cancel') return null
        return terminal === 'path denied' ? 'https://invalid.example/not-local' : selected
      },
      io: {
        ...realIO,
        open: async (value, flags) => {
          const handle = await realIO.open(value, flags)
          return {
            ...handle,
            read: async (...args) => {
              reads++
              if (terminal === 'read error') throw new Error('synthetic read failure')
              return handle.read(...args)
            },
            close: async () => {
              closes++
              subscriptions.push(getEventListeners(controller.signal, 'abort'))
              if (terminal === 'cancel') source.cancel()
              if (terminal === 'invalidate') source.invalidate()
              if (terminal === 'external abort') controller.abort()
              if (terminal === 'expiry') vi.advanceTimersByTime(1_000)
              attempts.push(await source.readSelected(scope, deadline()))
              await handle.close()
              if (terminal === 'close error') throw new Error('synthetic close failure')
            }
          }
        }
      }
    })
    const result = await source.readSelected(scope, limits)
    const expected =
      terminal === 'success'
        ? { status: 'source' }
        : fail(
            terminal.endsWith('error')
              ? 'IO_ERROR'
              : terminal === 'path denied'
                ? 'PATH_DENIED'
                : terminal === 'invalidate'
                  ? 'REVOKED'
                  : terminal === 'expiry'
                    ? 'EXPIRED'
                    : 'CANCELLED'
          )
    expect(result).toMatchObject(expected)
    expect(closes).toBe(reads ? 1 : 0)
    expect(subscriptions).toHaveLength(1 + closes)
    for (const listeners of subscriptions) expect(listeners).toEqual([add.mock.calls[0][1]])
    expect(attempts).toEqual(closes ? [fail('BUSY')] : [])
    expect(add).toHaveBeenCalledExactlyOnceWith(
      'abort',
      expect.any(Function),
      expect.objectContaining({ once: true })
    )
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0][1])
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(replacement.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    controller.abort()
    source.cancel()
    source.invalidate()
    expect(remove).toHaveBeenCalledOnce()
    if (terminal === 'close error')
      expect(await source.readSelected(scope, deadline())).toEqual(fail('UNAVAILABLE'))
  })
})
