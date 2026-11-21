import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real filesystem: the read-granted file is a real file standing in for a mapped share.
vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
)

const roots = vi.hoisted(() => ({ base: '' }))
vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => `${roots.base}/electron-${name}`)
  },
  ipcMain: { handle: vi.fn() },
  nativeImage: {}
}))
vi.mock('../config/userDataDirectory', () => ({
  getCurrentUserDataDirectoryState: () => ({
    autoSaveRoot: `${roots.base}/AutoSave`,
    projectRoot: `${roots.base}/Projects`
  })
}))

import { MANAGED_MEDIA_IMPORT_TIMEOUT_MESSAGE } from '@shared/api/svcManagedMedia'
import { FsSvcImpl } from './svcFsImpl'
import {
  clearScopedLocalMediaPathsForTest,
  countLocalMediaImportGrantsForTest,
  recordLocalMediaImportGrant
} from '../localMediaAccess'
import { grantLocalMediaImportFile } from '../localMediaFileIntakeIpc'
import { createImportSourceGate, type ImportSourceGuard } from '../llmProxy/managedMediaStore'
import { forgetLocalMediaTempRootVerification } from '../localMediaTempRoot'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const IMAGE_LIMIT = 5 * 1024 * 1024
type Handle = Awaited<ReturnType<typeof fsPromises.open>>

/** A call that does not return until the test ends. */
const stuck: Array<() => void> = []
const never = <T>(): Promise<T> =>
  new Promise<T>((_resolve, reject) => {
    stuck.push(() => reject(new Error('released by the test')))
  })
/** The outcome of a promise within `ms`: 'resolved', the rejection code, or 'pending'. */
const within = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => 'resolved',
      (error: unknown) => String((error as { code?: string })?.code ?? error)
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms))
  ])
const guard: ImportSourceGuard = {
  operationTimeoutMs: 50,
  copyBaseTimeoutMs: 5_000,
  copyMinBytesPerSecond: 1024 * 1024
}

/**
 * readImageFromPath for a file the user dropped from a mapped network drive (Z:\pics\a.png,
 * whose canonical form is \\server\share\pics\a.png): the share may stop answering at any time.
 */
describe('readImageFromPath of a read-granted file (a mapped network drive)', () => {
  let canonical: string
  let dropped: string

  beforeEach(() => {
    roots.base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-read-grant-')))
    // The share's file, outside every application root...
    canonical = path.join(roots.base, 'share', 'pics', 'a.png')
    fs.mkdirSync(path.dirname(canonical), { recursive: true })
    fs.writeFileSync(canonical, PNG)
    // ...and the path the user dropped, which only the share's canonical form resolves.
    dropped = path.join(roots.base, 'Z-drive', 'pics', 'a.png')
    forgetLocalMediaTempRootVerification()
    clearScopedLocalMediaPathsForTest()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    stuck.splice(0).forEach((release) => release())
    await new Promise((resolve) => setImmediate(resolve))
    forgetLocalMediaTempRootVerification()
    clearScopedLocalMediaPathsForTest()
    fs.rmSync(roots.base, { recursive: true, force: true })
  })

  it('finds the grant by the dropped path and reads it with no synchronous filesystem call', async () => {
    // Granted as main grants a mapped drive: its realpath gives a network (UNC-like) form.
    await expect(
      grantLocalMediaImportFile(dropped, 'image/png', {
        realpath: async () => `/${canonical}`,
        stat: (value) => fsPromises.stat(value)
      })
    ).resolves.toEqual({ refused: 'network', sizeBytes: PNG.length })
    const syncCalls = [
      vi.spyOn(fs.realpathSync, 'native'),
      vi.spyOn(fs, 'realpathSync'),
      vi.spyOn(fs, 'statSync'),
      vi.spyOn(fs, 'lstatSync'),
      vi.spyOn(fs, 'existsSync'),
      vi.spyOn(fs, 'accessSync'),
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'readFileSync')
    ]
    await expect(
      new FsSvcImpl().readImageFromPath({ fullPath: dropped, maxBytes: IMAGE_LIMIT })
    ).resolves.toEqual({ image: new Uint8Array(PNG), filename: 'a.png' })
    // Nothing on main's event loop waits for the share.
    for (const spy of syncCalls) expect(spy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    // Spent once.
    await expect(
      new FsSvcImpl().readImageFromPath({ fullPath: dropped, maxBytes: IMAGE_LIMIT })
    ).rejects.toThrow('not authorized')
  })

  it('cuts a read that stalls at its deadline, counted by the import-source gate', async () => {
    const gate = createImportSourceGate({ onSaturated: () => undefined })
    const closed = vi.fn()
    const opened = vi.fn()
    // The share answers the open, then never answers the read.
    const stalledFs = {
      ...fsPromises,
      open: (async (...args: Parameters<typeof fsPromises.open>) => {
        opened()
        const handle = await fsPromises.open(...args)
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'read') return () => never()
            if (property === 'close')
              return async () => {
                closed()
                return target.close()
              }
            const value = Reflect.get(target, property) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }) as typeof fsPromises.open
    } as typeof fsPromises
    const service = new FsSvcImpl({
      importSourceGuard: guard,
      importSourceGate: gate,
      importSourceFs: stalledFs
    })
    recordLocalMediaImportGrant(canonical, undefined, 'read', { requestedPath: dropped })
    const read = service.readImageFromPath({ fullPath: dropped, maxBytes: IMAGE_LIMIT })
    const error = await read.catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'MANAGED_MEDIA_IMPORT_TIMEOUT' })
    // The composer's timeout notice, never a path.
    expect((error as Error).message).toBe(MANAGED_MEDIA_IMPORT_TIMEOUT_MESSAGE)
    expect((error as Error).message).not.toContain(roots.base)
    // The stalled read holds its gate slot, seen as past its deadline.
    expect(gate.active).toBe(1)
    expect(gate.overdue).toBe(1)
    // Dropped again while that read hangs: refused at once, no second thread on it.
    recordLocalMediaImportGrant(canonical, undefined, 'read', { requestedPath: dropped })
    expect(
      await within(service.readImageFromPath({ fullPath: dropped, maxBytes: IMAGE_LIMIT }), 500)
    ).toBe('MANAGED_MEDIA_IMPORT_TIMEOUT')
    expect(opened).toHaveBeenCalledOnce()
    // The read returns at last: its slot frees and its handle is closed.
    stuck.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(gate.active).toBe(0))
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
  })

  it('reads no more than the image limit, even when the page names no limit', async () => {
    fs.writeFileSync(canonical, Buffer.alloc(IMAGE_LIMIT + 1, 0x41))
    recordLocalMediaImportGrant(canonical, undefined, 'read', { requestedPath: dropped })
    await expect(new FsSvcImpl().readImageFromPath({ fullPath: dropped })).rejects.toMatchObject({
      code: 'MANAGED_MEDIA_TOO_LARGE'
    })
    // At the limit it is read.
    fs.writeFileSync(canonical, Buffer.alloc(IMAGE_LIMIT, 0x41))
    recordLocalMediaImportGrant(canonical, undefined, 'read', { requestedPath: dropped })
    const response = await new FsSvcImpl().readImageFromPath({ fullPath: dropped })
    expect(response.image.byteLength).toBe(IMAGE_LIMIT)
  })

  it('reads no more than the size main measured when it granted the read', async () => {
    await expect(
      grantLocalMediaImportFile(dropped, 'image/png', {
        realpath: async () => `/${canonical}`,
        stat: (value) => fsPromises.stat(value)
      })
    ).resolves.toEqual({ refused: 'network', sizeBytes: PNG.length })
    // The file at that path grows after the grant (still well below the image limit).
    fs.writeFileSync(canonical, Buffer.concat([PNG, Buffer.alloc(1_000, 0x41)]))
    await expect(
      new FsSvcImpl().readImageFromPath({ fullPath: dropped, maxBytes: IMAGE_LIMIT })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_TOO_LARGE' })
    // A page limit below the size is kept too.
    recordLocalMediaImportGrant(canonical, undefined, 'read', {
      requestedPath: dropped,
      sizeBytes: PNG.length + 1_000
    })
    await expect(
      new FsSvcImpl().readImageFromPath({ fullPath: dropped, maxBytes: PNG.length })
    ).rejects.toMatchObject({ code: 'MANAGED_MEDIA_TOO_LARGE' })
  })

  it('closes a handle whose open answers only after the deadline', async () => {
    const gate = createImportSourceGate({ onSaturated: () => undefined })
    let answerOpen!: () => void
    const lateHandle = { close: vi.fn(async () => undefined) } as unknown as Handle
    const stalledFs = {
      ...fsPromises,
      open: (() =>
        new Promise<Handle>(
          (resolve) => (answerOpen = () => resolve(lateHandle))
        )) as unknown as typeof fsPromises.open
    } as typeof fsPromises
    recordLocalMediaImportGrant(canonical, undefined, 'read', { requestedPath: dropped })
    expect(
      await within(
        new FsSvcImpl({
          importSourceGuard: guard,
          importSourceGate: gate,
          importSourceFs: stalledFs
        }).readImageFromPath({ fullPath: dropped, maxBytes: IMAGE_LIMIT }),
        1_000
      )
    ).toBe('MANAGED_MEDIA_IMPORT_TIMEOUT')
    expect(gate.overdue).toBe(1)
    answerOpen()
    await vi.waitFor(() => expect(lateHandle.close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(gate.active).toBe(0))
    expect(countLocalMediaImportGrantsForTest()).toBe(0)
  })
})
