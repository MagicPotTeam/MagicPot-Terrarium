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
  createImportSourceGate,
  importManagedMediaFile,
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
      open: (handle: Handle) => Promise<Handle>
      read: (real: Handle['read'], args: Parameters<Handle['read']>) => Promise<unknown>
    }>
  ) => {
    const closed = vi.fn()
    const wrapped = {
      ...fs,
      lstat: (async (...args: Parameters<typeof fs.lstat>) =>
        String(args[0]) === source && patch.lstat
          ? patch.lstat()
          : fs.lstat(...args)) as typeof fs.lstat,
      open: (async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        if (String(args[0]) !== source) return handle
        const proxied = new Proxy(handle, {
          get(target, property) {
            if (property === 'read' && patch.read) {
              return (...readArgs: Parameters<Handle['read']>) =>
                patch.read!(target.read.bind(target) as Handle['read'], readArgs)
            }
            if (property === 'close') {
              return async () => {
                closed()
                return target.close()
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

  it('runs at most two source calls at once and frees a slot only when its call returns', async () => {
    const gate = createImportSourceGate(2)
    const releases: Array<() => void> = []
    const hung = () =>
      new Promise<string>((resolve) => {
        releases.push(() => resolve('late'))
      })
    const first = runImportSourceOperation(hung, { timeoutMs: 30, gate })
    const second = runImportSourceOperation(hung, { timeoutMs: 30, gate })
    await expect(first).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    await expect(second).rejects.toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    // Both calls are still stuck: the third waits for a slot and gets the short error.
    const third = vi.fn(async () => 'ran')
    await expect(runImportSourceOperation(third, { timeoutMs: 30, gate })).rejects.toMatchObject({
      code: 'MANAGED_MEDIA_IMPORT_TIMEOUT'
    })
    expect(third).not.toHaveBeenCalled()
    expect(gate.active).toBe(2)
    // The event loop kept running all along.
    await new Promise((resolve) => setImmediate(resolve))
    releases[0]()
    await vi.waitFor(() => expect(gate.active).toBe(1))
    await expect(runImportSourceOperation(third, { timeoutMs: 30, gate })).resolves.toBe('ran')
    releases[1]()
    await vi.waitFor(() => expect(gate.active).toBe(0))
  })

  it('authorizes with fs.promises.realpath, never a sync realpath on the event loop', async () => {
    const realpathSync = vi.spyOn(nodeFs.realpathSync, 'native')
    const realpath = vi.fn((value: string) => fs.realpath(value))
    await expect(
      authorizeLocalMediaImportSourcePathAsync(source, [root], { realpath })
    ).resolves.toBe(source)
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
          { timeoutMs: 50, gate: createImportSourceGate(2) }
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
