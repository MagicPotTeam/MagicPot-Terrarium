import nodeFs from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real filesystem; the slow source is a wrapper around it.
vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
)
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
  ipcMain: { handle: vi.fn() }
}))

import {
  DEFAULT_IMPORT_SOURCE_GUARD,
  IMPORT_SOURCE_MAX_CALLS,
  IMPORT_SOURCE_MAX_CALLS_PER_ROOT,
  createImportSourceGate,
  importManagedMediaFile,
  importSourceRootKey,
  runImportSourceOperation,
  type ImportSourceGuard
} from './managedMediaStore'
import {
  authorizeLocalMediaImportSourcePathAsync,
  clearScopedLocalMediaPathsForTest
} from '../localMediaAccess'
import { grantLocalMediaImportPath } from '../localMediaFileIntakeIpc'
import { ManagedMediaSvcImpl } from '../api/svcManagedMediaImpl'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
/** A call that does not return until the test ends (then it fails, freeing its gate slot). */
const stuck: Array<() => void> = []
const never = <T>(): Promise<T> =>
  new Promise<T>((_resolve, reject) => {
    stuck.push(() => reject(new Error('released by the test')))
  })
const guard = (overrides: Partial<ImportSourceGuard> = {}): ImportSourceGuard => ({
  operationTimeoutMs: 80,
  copyBaseTimeoutMs: 5_000,
  copyMinBytesPerSecond: 1024 * 1024,
  ...overrides
})

type Handle = Awaited<ReturnType<typeof fs.open>>

describe('import source deadlines (a stalled or slow source never blocks main)', () => {
  let root: string
  let media: string
  let source: string

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mp-import-guard-')))
    media = path.join(root, 'media')
    source = path.join(root, 'picked.png')
    await fs.mkdir(media, { recursive: true })
    await fs.writeFile(source, PNG)
    clearScopedLocalMediaPathsForTest()
  })

  afterEach(async () => {
    stuck.splice(0).forEach((release) => release())
    await new Promise((resolve) => setImmediate(resolve))
    clearScopedLocalMediaPathsForTest()
    await fs.rm(root, { recursive: true, force: true })
  })

  const stagingIsEmpty = async () =>
    expect(await fs.readdir(path.join(media, '.staging')).catch(() => [])).toEqual([])

  /** fs with the source's calls replaced: everything else is the real filesystem. */
  const slowSource = (
    patch: Partial<{
      lstat: () => Promise<unknown>
      realpath: () => Promise<unknown>
      open: (handle: Handle) => Promise<Handle>
      read: (real: Handle['read'], args: Parameters<Handle['read']>) => Promise<unknown>
      /** Each fstat of the open source: the first (before the copy) is call 0. */
      stat: (real: Handle['stat'], call: number) => Promise<unknown>
      close: (real: Handle['close']) => Promise<void>
    }>
  ) => {
    const closed = vi.fn()
    const wrapped = {
      ...fs,
      lstat: (async (...args: Parameters<typeof fs.lstat>) =>
        String(args[0]) === source && patch.lstat
          ? patch.lstat()
          : fs.lstat(...args)) as typeof fs.lstat,
      realpath: (async (...args: Parameters<typeof fs.realpath>) =>
        String(args[0]) === source && patch.realpath
          ? patch.realpath()
          : fs.realpath(...args)) as typeof fs.realpath,
      open: (async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        if (String(args[0]) !== source) return handle
        let statCalls = 0
        const proxied = new Proxy(handle, {
          get(target, property) {
            if (property === 'read' && patch.read) {
              return (...readArgs: Parameters<Handle['read']>) =>
                patch.read!(target.read.bind(target) as Handle['read'], readArgs)
            }
            if (property === 'stat' && patch.stat) {
              return () => patch.stat!(target.stat.bind(target) as Handle['stat'], statCalls++)
            }
            if (property === 'close') {
              return async () => {
                closed()
                return patch.close
                  ? patch.close(target.close.bind(target) as Handle['close'])
                  : target.close()
              }
            }
            const value = Reflect.get(target, property) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
        return patch.open ? patch.open(proxied) : proxied
      }) as typeof fs.open
    } as typeof fs
    return { fs: wrapped, closed }
  }

  const importWith = (fileSystem: typeof fs, sourceGuard?: ImportSourceGuard) =>
    importManagedMediaFile(
      {
        chatMediaRoot: media,
        sourcePath: source,
        mimeType: 'image/png',
        originalFileName: 'picked.png',
        provenance: { source: 'test' },
        ...(sourceGuard ? { sourceGuard } : {})
      },
      { authorizedRoot: media, fs: fileSystem }
    )

  it('aborts a copy whose read never returns and reports a short error', async () => {
    const { fs: stalled, closed } = slowSource({ read: () => never() })
    const startedAt = Date.now()
    const error = await importWith(stalled, guard()).catch((reason: unknown) => reason)
    expect(error).toMatchObject({
      code: 'MANAGED_MEDIA_IMPORT_TIMEOUT',
      message: 'Managed media source did not respond in time'
    })
    expect(String((error as Error).message)).not.toContain(root)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    // The stalled handle is closed in the background, not awaited.
    expect(closed).toHaveBeenCalled()
    await stagingIsEmpty()
  })

  it('rejects at the deadline even when closing the handle waits for the stalled read', async () => {
    // FileHandle.close() waits for the handle's pending calls: awaiting it would hang.
    let stalledRead: Promise<unknown> | undefined
    const { fs: stalled, closed } = slowSource({
      read: () => (stalledRead = never()),
      close: async (real) => {
        await stalledRead?.catch(() => undefined)
        await real()
      }
    })
    const startedAt = Date.now()
    await expect(importWith(stalled, guard())).rejects.toMatchObject({
      code: 'MANAGED_MEDIA_IMPORT_TIMEOUT'
    })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(closed).toHaveBeenCalled()
    await stagingIsEmpty()
  })

  it.each([
    ['the realpath', { realpath: () => never() }],
    ['the fstat before the copy', { stat: () => never() }],
    [
      'the fstat after the copy',
      { stat: (real: Handle['stat'], call: number) => (call === 0 ? real() : never()) }
    ]
  ] as const)('aborts when %s never returns', async (_name, patch) => {
    const { fs: stalled } = slowSource(patch as Parameters<typeof slowSource>[0])
    const startedAt = Date.now()
    await expect(importWith(stalled, guard())).rejects.toMatchObject({
      code: 'MANAGED_MEDIA_IMPORT_TIMEOUT'
    })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    await stagingIsEmpty()
  })

  it('aborts when the stat before the open never returns', async () => {
    const { fs: stalled } = slowSource({ lstat: () => never() })
    await expect(importWith(stalled, guard())).rejects.toMatchObject({
      code: 'MANAGED_MEDIA_IMPORT_TIMEOUT'
    })
  })

  it('closes a file handle whose open returns only after the deadline', async () => {
    let lateOpen!: () => void
    const { fs: stalled, closed } = slowSource({
      open: (handle) =>
        new Promise<Handle>((resolve) => {
          lateOpen = () => resolve(handle)
        })
    })
    await expect(importWith(stalled, guard())).rejects.toMatchObject({
      code: 'MANAGED_MEDIA_IMPORT_TIMEOUT'
    })
    expect(closed).not.toHaveBeenCalled()
    lateOpen()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
  })

  it('stops a copy that trickles slower than the whole-copy deadline allows', async () => {
    // Each read answers in time, but the whole copy is too slow.
    const big = Buffer.concat([PNG, Buffer.alloc(256 * 1024)])
    await fs.writeFile(source, big)
    const { fs: slow } = slowSource({
      read: async (real, args) => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return real(...args)
      }
    })
    await expect(
      importWith(slow, guard({ copyBaseTimeoutMs: 60, copyMinBytesPerSecond: 1024 * 1024 * 1024 }))
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    await stagingIsEmpty()
  })

  it('imports a slow source that keeps answering within its deadlines', async () => {
    const { fs: slow } = slowSource({
      read: async (real, args) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return real(...args)
      }
    })
    await expect(importWith(slow, guard())).resolves.toMatchObject({
      reference: { kind: 'managed', sizeBytes: PNG.length }
    })
  })

  it('has no deadline for main-owned callers that pass no guard', async () => {
    let finishRead: (() => void) | undefined
    const { fs: slow } = slowSource({
      // The first read waits longer than any guard deadline used here; later reads run.
      read: (real, args) =>
        finishRead
          ? real(...args)
          : new Promise((resolve, reject) => {
              finishRead = () => void real(...args).then(resolve, reject)
            })
    })
    const pending = importWith(slow)
    await new Promise((resolve) => setTimeout(resolve, 150))
    finishRead!()
    await expect(pending).resolves.toMatchObject({ reference: { kind: 'managed' } })
  })

  it('runs two calls per root and three in all, starting a queued call when a slot frees', async () => {
    expect(IMPORT_SOURCE_MAX_CALLS_PER_ROOT).toBe(2)
    expect(IMPORT_SOURCE_MAX_CALLS).toBe(3)
    const gate = createImportSourceGate()
    const later = (ms: number, value: string) => () =>
      new Promise<string>((resolve) => setTimeout(() => resolve(value), ms))
    const third = vi.fn(later(10, 'third'))
    // Two calls of 60 ms hold root /a; the third (10 ms) waits, and its 30 ms deadline starts
    // only when it gets its slot: waiting behind the others is never charged to it.
    const calls = [
      runImportSourceOperation(later(60, 'first'), { key: '/a', timeoutMs: 1_000, gate }),
      runImportSourceOperation(later(60, 'second'), { key: '/a', timeoutMs: 1_000, gate }),
      runImportSourceOperation(third, { key: '/a', timeoutMs: 30, gate })
    ]
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(third).not.toHaveBeenCalled()
    expect(gate.active).toBe(2)
    await expect(Promise.all(calls)).resolves.toEqual(['first', 'second', 'third'])
    expect(gate.active).toBe(0)
    // Three roots run at once; a fourth waits for one of them.
    const fourth = vi.fn(async () => 'fourth')
    const spread = [
      runImportSourceOperation(later(40, 'a'), { key: '/a', timeoutMs: 1_000, gate }),
      runImportSourceOperation(later(40, 'b'), { key: '/b', timeoutMs: 1_000, gate }),
      runImportSourceOperation(later(40, 'c'), { key: '/c', timeoutMs: 1_000, gate }),
      runImportSourceOperation(fourth, { key: '/d', timeoutMs: 1_000, gate })
    ]
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fourth).not.toHaveBeenCalled()
    await expect(Promise.all(spread)).resolves.toEqual(['a', 'b', 'c', 'fourth'])
    expect(gate.active).toBe(0)
  })

  it('refuses at once a call on a root whose calls are past their deadline, and frees the slot only when they return', async () => {
    const gate = createImportSourceGate()
    const releases: Array<() => void> = []
    const hung = () =>
      new Promise<string>((resolve) => {
        releases.push(() => resolve('late'))
      })
    const first = runImportSourceOperation(hung, { key: '/dead', timeoutMs: 30, gate })
    const second = runImportSourceOperation(hung, { key: '/dead', timeoutMs: 30, gate })
    void first.catch(() => undefined)
    void second.catch(() => undefined)
    // Queued behind them on the same root: refused when they pass their deadline, not left waiting.
    const queued = vi.fn(async () => 'ran')
    const waiting = runImportSourceOperation(queued, {
      key: '/dead',
      timeoutMs: 1_000,
      gate
    }).catch((error: unknown) => error)
    await expect(first).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    await expect(second).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    await expect(waiting).resolves.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    expect(queued).not.toHaveBeenCalled()
    expect(gate.active).toBe(2)
    expect(gate.overdue).toBe(2)
    // A new call on that root is refused at once: no third thread on a dead mount.
    const startedAt = performance.now()
    await expect(
      runImportSourceOperation(queued, { key: '/dead', timeoutMs: 1_000, gate })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(queued).not.toHaveBeenCalled()
    // Another root still runs.
    await expect(
      runImportSourceOperation(async () => 'other', { key: '/live', timeoutMs: 1_000, gate })
    ).resolves.toBe('other')
    // The event loop kept running all along; the slots free when the calls really return.
    releases[0]()
    await vi.waitFor(() => expect(gate.active).toBe(1))
    releases[1]()
    await vi.waitFor(() => expect(gate.active).toBe(0))
    expect(gate.overdue).toBe(0)
    await expect(
      runImportSourceOperation(queued, { key: '/dead', timeoutMs: 1_000, gate })
    ).resolves.toBe('ran')
  })

  it('refuses every call, logged once, while all slots are held by calls past their deadline', async () => {
    const onSaturated = vi.fn()
    const gate = createImportSourceGate({ onSaturated })
    const releases: Array<() => void> = []
    const hung = () =>
      new Promise<string>((resolve) => {
        releases.push(() => resolve('late'))
      })
    const stalled = ['/x', '/y', '/z'].map((key) =>
      runImportSourceOperation(hung, { key, timeoutMs: 30, gate }).catch((error: unknown) => error)
    )
    for (const call of stalled)
      await expect(call).resolves.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    expect(onSaturated).toHaveBeenCalledOnce()
    const fresh = vi.fn(async () => 'fresh')
    await expect(
      runImportSourceOperation(fresh, { key: '/fresh', timeoutMs: 1_000, gate })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    await expect(
      runImportSourceOperation(fresh, { key: '/fresh', timeoutMs: 1_000, gate })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    expect(fresh).not.toHaveBeenCalled()
    expect(onSaturated).toHaveBeenCalledOnce()
    releases[0]()
    await vi.waitFor(() => expect(gate.active).toBe(2))
    await expect(
      runImportSourceOperation(fresh, { key: '/fresh', timeoutMs: 1_000, gate })
    ).resolves.toBe('fresh')
    releases.slice(1).forEach((release) => release())
    await vi.waitFor(() => expect(gate.active).toBe(0))
  })

  it('does not start a call once its copy is past its cap', async () => {
    const gate = createImportSourceGate()
    const operation = vi.fn(async () => 'ran')
    await expect(
      runImportSourceOperation(operation, {
        key: '/a',
        timeoutMs: 1_000,
        notAfter: () => performance.now() - 1,
        gate
      })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    expect(operation).not.toHaveBeenCalled()
    expect(gate.active).toBe(0)
  })

  it('does not take a root as dead when a call is cut by its copy cap, not by its own deadline', async () => {
    const gate = createImportSourceGate()
    const releases: Array<(value: string) => void> = []
    const capAt = performance.now() + 30
    await expect(
      runImportSourceOperation(() => new Promise<string>((resolve) => releases.push(resolve)), {
        key: '/a',
        timeoutMs: 1_000,
        notAfter: () => capAt,
        gate
      })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    expect(gate.overdue).toBe(0)
    // The cut call still holds its slot, but its root answers the next call.
    expect(gate.active).toBe(1)
    await expect(
      runImportSourceOperation(async () => 'next', { key: '/a', timeoutMs: 1_000, gate })
    ).resolves.toBe('next')
    releases[0]('late')
    await vi.waitFor(() => expect(gate.active).toBe(0))
  })

  it('keys the gate by drive, share or mount, from the path text alone', () => {
    expect(importSourceRootKey('C:\\Users\\me\\a.png')).toBe('c:')
    expect(importSourceRootKey('d:/photos/a.png')).toBe('d:')
    expect(importSourceRootKey('\\\\Server\\Share\\a.png')).toBe('//server/share')
    expect(importSourceRootKey('/Volumes/NAS/photos/a.png')).toBe('/Volumes/NAS')
    expect(importSourceRootKey('/mnt/nas/a.png')).toBe('/mnt/nas')
    expect(importSourceRootKey('/media/me/USB/a.png')).toBe('/media/me/USB')
    expect(importSourceRootKey('/run/media/me/USB/a.png')).toBe('/run/media/me/USB')
    expect(importSourceRootKey('/run/user/1000/gvfs/smb-share:server=s,share=p/a.png')).toBe(
      '/run/user/1000/gvfs/smb-share:server=s,share=p'
    )
    expect(importSourceRootKey('/home/me/a.png')).toBe('/home')
    expect(importSourceRootKey('/tmp/a.png')).toBe('/tmp')
  })

  it('authorizes with fs.promises.realpath, never a sync realpath on the event loop', async () => {
    const realpathSync = vi.spyOn(nodeFs.realpathSync, 'native')
    const realpath = vi.fn((value: string) => fs.realpath(value))
    await expect(
      authorizeLocalMediaImportSourcePathAsync(source, [root], { realpath })
    ).resolves.toEqual({ canonicalPath: source, viaImportGrant: false })
    expect(realpath).toHaveBeenCalledWith(source)
    expect(realpathSync).not.toHaveBeenCalled()
    realpathSync.mockRestore()
  })

  it('refuses importFile when the authorization realpath stalls, with a short error', async () => {
    const service = new ManagedMediaSvcImpl({
      getMediaDir: () => media,
      authorizeImportSourcePath: (sourcePath) =>
        runImportSourceOperation(
          () =>
            authorizeLocalMediaImportSourcePathAsync(sourcePath, [root], {
              realpath: () => never()
            }),
          { timeoutMs: 50, gate: createImportSourceGate() }
        ),
      importFile: vi.fn(),
      ensureDerivative: vi.fn(async () => {
        throw new Error('not needed')
      })
    })
    const error = (await service
      .importFile({ sourcePath: source, mimeType: 'image/png', originalFileName: 'picked.png' })
      .catch((reason: unknown) => reason)) as { code?: string; message?: string }
    expect(error).toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    expect(String(error.message)).not.toContain(root)
  })

  it('records no import grant when the realpath of the picked file stalls', async () => {
    await expect(
      grantLocalMediaImportPath(source, 'image/png', { realpath: () => never(), timeoutMs: 50 })
    ).resolves.toBe('')
    await expect(authorizeLocalMediaImportSourcePathAsync(source, [])).resolves.toBeNull()
  })
})

/**
 * A slow but working source: virtual files served through one shared, throttled link (a NAS
 * over VPN). Time runs SCALE times faster than in production; the guard is the production
 * guard scaled the same way, so the ratios between sizes, speeds and deadlines are the real ones.
 */
describe('a slow but working source is never cut, a stalled one is', () => {
  const SCALE = 50
  const MiB = 1024 * 1024
  const scaledGuard = (): ImportSourceGuard => ({
    operationTimeoutMs: DEFAULT_IMPORT_SOURCE_GUARD.operationTimeoutMs / SCALE,
    copyBaseTimeoutMs: DEFAULT_IMPORT_SOURCE_GUARD.copyBaseTimeoutMs / SCALE,
    copyMinBytesPerSecond: DEFAULT_IMPORT_SOURCE_GUARD.copyMinBytesPerSecond * SCALE
  })
  let root: string
  let media: string

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mp-import-slow-')))
    media = path.join(root, 'media')
    await fs.mkdir(media, { recursive: true })
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    stuck.splice(0).forEach((release) => release())
    await new Promise((resolve) => setImmediate(resolve))
    clearScopedLocalMediaPathsForTest()
    await fs.rm(root, { recursive: true, force: true })
  })

  const stagingIsEmpty = async () =>
    expect(await fs.readdir(path.join(media, '.staging')).catch(() => [])).toEqual([])

  /** One link shared by every copy: each read waits its turn at bytesPerSecond. */
  const sharedLink = (bytesPerSecond: number) => {
    let freeAt = 0
    return async (bytes: number): Promise<void> => {
      const startAt = Math.max(performance.now(), freeAt)
      freeAt = startAt + (bytes / bytesPerSecond) * 1000
      const wait = freeAt - performance.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }

  /**
   * A valid PNG of `size` bytes that exists only in memory: signature, IHDR, one large private
   * chunk filled with `fill`, IEND. `beforeRead` runs before each read (throttle or stall).
   */
  const virtualPng = (
    name: string,
    size: number,
    fill: number,
    beforeRead: (bytes: number, readIndex: number) => Promise<void>
  ) => {
    const filePath = path.resolve(path.sep, 'mnt', 'nas', name)
    const ihdr = Buffer.alloc(25)
    ihdr.writeUInt32BE(13, 0)
    ihdr.write('IHDR', 4, 'ascii')
    ihdr.writeUInt32BE(1, 8)
    ihdr.writeUInt32BE(1, 12)
    ihdr[16] = 8
    ihdr[17] = 6
    const prefix = Buffer.alloc(8 + 25 + 8)
    PNG.copy(prefix, 0, 0, 8)
    ihdr.copy(prefix, 8)
    prefix.writeUInt32BE(size - prefix.length - 16, 33)
    prefix.write('zzZz', 37, 'ascii')
    const suffix = Buffer.from([
      0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
    ])
    const stats = {
      isFile: () => true,
      isSymbolicLink: () => false,
      isDirectory: () => false,
      size,
      dev: 77,
      ino: fill,
      mtimeMs: 1_000,
      ctimeMs: 1_000
    }
    let reads = 0
    const closed = vi.fn()
    const handle = {
      stat: async () => stats,
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.max(0, Math.min(length, size - position))
        await beforeRead(bytesRead, reads++)
        buffer.fill(fill, offset, offset + bytesRead)
        if (position < prefix.length)
          prefix.copy(buffer, offset, position, Math.min(prefix.length, position + bytesRead))
        const suffixStart = size - suffix.length
        if (position + bytesRead > suffixStart) {
          const from = Math.max(position, suffixStart)
          suffix.copy(
            buffer,
            offset + from - position,
            from - suffixStart,
            position + bytesRead - suffixStart
          )
        }
        return { bytesRead, buffer }
      },
      close: async () => {
        closed()
      }
    }
    return { filePath, stats, handle, closed }
  }

  /** The real filesystem, with the virtual files in place of their paths. */
  const withVirtualFiles = (files: Array<ReturnType<typeof virtualPng>>): typeof fs => {
    const byPath = new Map(files.map((file) => [file.filePath, file]))
    return {
      ...fs,
      lstat: (async (...args: Parameters<typeof fs.lstat>) =>
        byPath.get(String(args[0]))?.stats ?? fs.lstat(...args)) as typeof fs.lstat,
      realpath: (async (...args: Parameters<typeof fs.realpath>) =>
        byPath.has(String(args[0])) ? String(args[0]) : fs.realpath(...args)) as typeof fs.realpath,
      open: (async (...args: Parameters<typeof fs.open>) =>
        byPath.get(String(args[0]))?.handle ?? fs.open(...args)) as unknown as typeof fs.open
    } as typeof fs
  }

  const importVirtual = (
    file: ReturnType<typeof virtualPng>,
    fileSystem: typeof fs,
    sourceGuard: ImportSourceGuard
  ) =>
    importManagedMediaFile(
      {
        chatMediaRoot: media,
        sourcePath: file.filePath,
        mimeType: 'image/png',
        originalFileName: path.basename(file.filePath),
        provenance: { source: 'test' },
        sourceGuard
      },
      { authorizedRoot: media, fs: fileSystem }
    )

  it('imports four 50 MiB files at once from one 1.5 MiB/s link (each needs 133 s)', async () => {
    const link = sharedLink(1.5 * MiB * SCALE)
    const files = [1, 2, 3, 4].map((fill) =>
      virtualPng(`photo-${fill}.png`, 50 * MiB, fill, (bytes) => link(bytes))
    )
    const fileSystem = withVirtualFiles(files)
    const results = await Promise.allSettled(
      files.map((file) => importVirtual(file, fileSystem, scaledGuard()))
    )
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled'
    ])
    for (const result of results)
      expect(result).toMatchObject({ value: { reference: { sizeBytes: 50 * MiB } } })
    files.forEach((file) => expect(file.closed).toHaveBeenCalledOnce())
    await stagingIsEmpty()
  }, 60_000)

  it('imports one 50 MiB file alone from the same link', async () => {
    const link = sharedLink(1.5 * MiB * SCALE)
    const file = virtualPng('alone.png', 50 * MiB, 9, (bytes) => link(bytes))
    await expect(
      importVirtual(file, withVirtualFiles([file]), scaledGuard())
    ).resolves.toMatchObject({ reference: { sizeBytes: 50 * MiB } })
    await stagingIsEmpty()
  }, 60_000)

  it('stops a copy whose source delivers no bytes for 15 s, not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let stalledRead = false
    const file = virtualPng('stalls.png', 4 * MiB, 3, async (_bytes, readIndex) => {
      if (readIndex < 8) return
      stalledRead = true
      await never()
    })
    let outcome: unknown = 'pending'
    void importVirtual(file, withVirtualFiles([file]), DEFAULT_IMPORT_SOURCE_GUARD).then(
      () => (outcome = 'imported'),
      (error: unknown) => (outcome = error)
    )
    for (let turn = 0; turn < 10_000 && !stalledRead; turn += 1)
      await new Promise((resolve) => setImmediate(resolve))
    expect(stalledRead).toBe(true)
    await vi.advanceTimersByTimeAsync(DEFAULT_IMPORT_SOURCE_GUARD.operationTimeoutMs - 1)
    expect(outcome).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    for (let turn = 0; turn < 10_000 && outcome === 'pending'; turn += 1)
      await new Promise((resolve) => setImmediate(resolve))
    expect(outcome).toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    // The stalled handle is closed in the background, and nothing is left staged.
    expect(file.closed).toHaveBeenCalledOnce()
    await stagingIsEmpty()
  })

  it('imports one slow copy that outlasts the old whole-copy limit (20 MiB at 200 KiB/s: 102 s)', async () => {
    const link = sharedLink(200 * 1024 * SCALE)
    const file = virtualPng('slow.png', 20 * MiB, 5, (bytes) => link(bytes))
    await expect(
      importVirtual(file, withVirtualFiles([file]), scaledGuard())
    ).resolves.toMatchObject({ reference: { sizeBytes: 20 * MiB } })
    await stagingIsEmpty()
  }, 30_000)

  it('starts the copy cap at the open: slow calls before it are not charged to the copy', async () => {
    const file = virtualPng('late-open.png', 64 * 1024, 7, async () => undefined)
    const fileSystem = withVirtualFiles([file])
    const realpath = fileSystem.realpath
    // The realpath answers within its own deadline but takes longer than the whole copy cap.
    fileSystem.realpath = (async (...args: Parameters<typeof fs.realpath>) => {
      if (String(args[0]) === file.filePath)
        await new Promise((resolve) => setTimeout(resolve, 900))
      return realpath(...args)
    }) as typeof fs.realpath
    await expect(
      importVirtual(file, fileSystem, {
        operationTimeoutMs: 2_000,
        copyBaseTimeoutMs: 600,
        copyMinBytesPerSecond: 1024 * MiB
      })
    ).resolves.toMatchObject({ reference: { sizeBytes: 64 * 1024 } })
  })

  it('measures the copy on a monotonic clock: a wall-clock jump does not end it', async () => {
    const realNow = Date.now.bind(Date)
    let jumped = false
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (jumped ? 3_600_000 : 0))
    const file = virtualPng('clock.png', 1 * MiB, 6, async (_bytes, readIndex) => {
      if (readIndex === 2) jumped = true
    })
    await expect(
      importVirtual(file, withVirtualFiles([file]), scaledGuard())
    ).resolves.toMatchObject({ reference: { sizeBytes: 1 * MiB } })
    expect(jumped).toBe(true)
  })

  it('lets an import from another root succeed while two calls stall on one dead root', async () => {
    const deadRoot = process.platform === 'win32' ? 'Z:\\nas' : '/mnt/dead-nas'
    const healthy = path.join(root, 'healthy.png')
    await fs.writeFile(healthy, PNG)
    // One pick on the dead mount (its realpath never returns) and one copy from it (its
    // lstat never returns): both calls hold a thread past their deadline.
    const stalledRealpath = vi.fn(() => never<string>())
    const deadFile = virtualPng('dead.png', 1 * MiB, 8, async () => undefined)
    const deadPath = path.resolve(deadRoot, 'dead.png')
    const deadFs = {
      ...fs,
      lstat: (async (...args: Parameters<typeof fs.lstat>) =>
        String(args[0]) === deadPath ? never() : fs.lstat(...args)) as typeof fs.lstat
    } as typeof fs
    await expect(
      grantLocalMediaImportPath(path.join(deadRoot, 'a.png'), 'image/png', {
        realpath: stalledRealpath,
        timeoutMs: 50
      })
    ).resolves.toBe('')
    await expect(
      importVirtual({ ...deadFile, filePath: deadPath }, deadFs, {
        ...scaledGuard(),
        operationTimeoutMs: 50
      })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    // A further pick there is refused at once, without another call on the dead mount.
    await expect(
      grantLocalMediaImportPath(path.join(deadRoot, 'c.png'), 'image/png', {
        realpath: stalledRealpath,
        timeoutMs: 50
      })
    ).resolves.toBe('')
    expect(stalledRealpath).toHaveBeenCalledTimes(1)
    // The local disk keeps working: grant, authorization and copy.
    await expect(
      grantLocalMediaImportPath(healthy, 'image/png', { timeoutMs: 1_000 })
    ).resolves.toBe(healthy)
    await expect(authorizeLocalMediaImportSourcePathAsync(healthy, [])).resolves.toEqual({
      canonicalPath: healthy,
      viaImportGrant: true
    })
    await expect(
      importManagedMediaFile(
        {
          chatMediaRoot: media,
          sourcePath: healthy,
          mimeType: 'image/png',
          originalFileName: 'healthy.png',
          provenance: { source: 'test' },
          sourceGuard: scaledGuard()
        },
        { authorizedRoot: media }
      )
    ).resolves.toMatchObject({ reference: { kind: 'managed' } })
    await stagingIsEmpty()
  })
})
