import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readInstalledCatalogSnapshot, type InstalledCatalogReadOptions } from './installedCatalogReader'

vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const filename = 'magicpot-installed-package.json'
let fixtureRoot: string, userData: string, installed: string, controller: AbortController, live: boolean
const metadata = (id = 'demo.package') => ({ id, name: 'Demo Package', version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z', sourcePath: 'C:\\old\\source', packagePath: 'D:\\old\\package', manifest: { manifestVersion: 1, id, name: 'Demo Package', version: '1.0.0' } })
const options = (override: Partial<InstalledCatalogReadOptions> = {}): InstalledCatalogReadOptions => ({ userData, lease: { signal: controller.signal, isCurrent: () => live && !controller.signal.aborted, close: vi.fn() }, ...override })
const expected = (id = 'demo.package') => ({ id, name: 'Demo Package', version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' })
const install = (id = 'demo.package', value: unknown = metadata(id)) => {
  const child = path.join(installed, id); fs.mkdirSync(child, { recursive: true }); fs.writeFileSync(path.join(child, filename), JSON.stringify(value)); return child
}
const unavailable = (reason: string) => ({ status: 'unavailable', reason })
beforeEach(() => {
  const storage = process.env.MAGICPOT_STORAGE_ROOT
  if (!storage || !path.isAbsolute(storage) || !storage.includes('studio-catalog-storage')) throw new Error('catalog fixtures require explicit confined scratch storage')
  fs.mkdirSync(storage, { recursive: true }); fixtureRoot = fs.mkdtempSync(path.join(storage, 'reader-fixture-'))
  userData = fs.realpathSync.native(fixtureRoot); installed = path.join(userData, 'magic-agent-packages', 'installed')
  controller = new AbortController(); live = true
})
afterEach(() => { controller.abort(); vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(fixtureRoot, { recursive: true, force: true }) })

describe('bounded readonly installed-metadata snapshot; app-managed stable ancestors, not an OS sandbox', () => {
  it('reads only final metadata, projects four fields, sorts exact IDs and never probes source/package paths', async () => {
    const second = install('zeta'), first = install('alpha')
    fs.mkdirSync(path.join(first, 'package')); fs.writeFileSync(path.join(first, 'package', 'DO_NOT_READ'), 'PRIVATE_PACKAGE_CONTENT')
    fs.mkdirSync(path.join(second, 'package'))
    const open = vi.spyOn(fsp, 'open'), readFile = vi.spyOn(fsp, 'readFile'), readdir = vi.spyOn(fsp, 'readdir')
    const write = vi.spyOn(fsp, 'writeFile'), mkdir = vi.spyOn(fsp, 'mkdir'), rm = vi.spyOn(fsp, 'rm'), rename = vi.spyOn(fsp, 'rename')
    const result = await readInstalledCatalogSnapshot(options())
    expect(result).toEqual({ status: 'available', entries: [expected('alpha'), expected('zeta')] })
    expect(Object.isFrozen(result)).toBe(true); if (result.status === 'available') expect(Object.isFrozen(result.entries)).toBe(true)
    expect(open.mock.calls.map(args => String(args[0])).sort()).toEqual([path.join(first, filename), path.join(second, filename)].sort())
    expect(readFile).not.toHaveBeenCalled(); expect(readdir).not.toHaveBeenCalled()
    for (const spy of [write, mkdir, rm, rename]) expect(spy).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|sourcePath|packagePath|manifest|[CD]:/)
  })

  it('reports stable present empty root as success without initialization', async () => {
    fs.mkdirSync(installed, { recursive: true })
    expect(await readInstalledCatalogSnapshot(options())).toEqual({ status: 'available', entries: [] })
    expect(fs.readdirSync(installed)).toEqual([])
  })
  it('missing root is explicit unavailable, not successful empty and never created', async () => {
    expect(await readInstalledCatalogSnapshot(options())).toEqual(unavailable('missing-root'))
    expect(fs.existsSync(path.join(userData, 'magic-agent-packages'))).toBe(false)
  })
  it.each(['', '.', 'relative/path'])('invalid MAIN path %s has no filesystem access or CWD fallback', async value => {
    const stat = vi.spyOn(fsp, 'lstat'), open = vi.spyOn(fsp, 'open'), directory = vi.spyOn(fsp, 'opendir')
    expect(await readInstalledCatalogSnapshot(options({ userData: value }))).toEqual(unavailable('unsafe-path'))
    for (const spy of [stat, open, directory]) expect(spy).not.toHaveBeenCalled()
  })
  it.each(['aborted', 'stale', 'throws'] as const)('invalid initial lease %s prevents all filesystem IO', async kind => {
    if (kind === 'aborted') controller.abort()
    if (kind === 'stale') live = false
    const input = options(); if (kind === 'throws') input.lease = { ...input.lease, isCurrent: () => { throw new Error('PRIVATE') } }
    const stat = vi.spyOn(fsp, 'lstat'), open = vi.spyOn(fsp, 'open')
    expect(await readInstalledCatalogSnapshot(input)).toEqual(unavailable('revoked'))
    expect(stat).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
  })
  it.each(['.install-demo-1', '.backup-demo-1', '.store-lock', 'Demo', 'unknown@entry', 'demo.'])('rejects artifact/unsupported root entry %s instead of skipping or recovering', async name => {
    install(); fs.mkdirSync(path.join(installed, name))
    expect(await readInstalledCatalogSnapshot(options())).toEqual(unavailable('unsafe-path'))
    expect(fs.existsSync(path.join(installed, name))).toBe(true)
  })
  it('a plain root file is not a final package directory', async () => {
    install(); fs.writeFileSync(path.join(installed, 'plain'), '{}')
    expect(await readInstalledCatalogSnapshot(options())).toEqual(unavailable('unsafe-path'))
  })
  it.each(['malformed', 'utf8', 'missing', 'directory', 'oversized', 'hardlink'] as const)('discards the entire catalog for one %s metadata among good packages', async kind => {
    install('alpha'); const child = install('zeta'), target = path.join(child, filename)
    if (kind === 'malformed') fs.writeFileSync(target, '{')
    if (kind === 'utf8') fs.writeFileSync(target, Buffer.from([0xff]))
    if (kind === 'missing') fs.unlinkSync(target)
    if (kind === 'directory') { fs.unlinkSync(target); fs.mkdirSync(target) }
    if (kind === 'oversized') fs.writeFileSync(target, Buffer.alloc(65537, 0x20))
    if (kind === 'hardlink') fs.linkSync(target, path.join(fixtureRoot, 'alias'))
    const result = await readInstalledCatalogSnapshot(options())
    expect(result.status).toBe('unavailable'); expect(result).not.toHaveProperty('entries')
    expect(JSON.stringify(result)).not.toMatch(/alpha|zeta|[CD]:|PRIVATE/)
  })
  it('rejects an observed installed-root junction rather than traversing it', async () => {
    const outside = path.join(fixtureRoot, 'outside'); fs.mkdirSync(outside); fs.mkdirSync(path.dirname(installed), { recursive: true })
    fs.symlinkSync(outside, installed, 'junction')
    expect(await readInstalledCatalogSnapshot(options())).toEqual(unavailable('unsafe-path'))
  })
  it('rejects an observed child junction rather than reading its metadata', async () => {
    const outside = path.join(fixtureRoot, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, filename), JSON.stringify(metadata()))
    fs.mkdirSync(installed, { recursive: true }); fs.symlinkSync(outside, path.join(installed, 'demo.package'), 'junction')
    const open = vi.spyOn(fsp, 'open')
    expect(await readInstalledCatalogSnapshot(options())).toEqual(unavailable('unsafe-path')); expect(open).not.toHaveBeenCalled()
  })
  it('caps final package count at 64 instead of truncating', async () => {
    for (let index = 0; index < 65; index++) install('pkg-' + index)
    expect(await readInstalledCatalogSnapshot(options())).toEqual(unavailable('limit-exceeded'))
  })
  it('caps total root entries at 128 before any metadata bytes are opened', async () => {
    fs.mkdirSync(installed, { recursive: true }); for (let index = 0; index < 129; index++) fs.mkdirSync(path.join(installed, 'entry-' + index))
    const open = vi.spyOn(fsp, 'open')
    expect(await readInstalledCatalogSnapshot(options())).toEqual(unavailable('limit-exceeded')); expect(open).not.toHaveBeenCalled()
  })
  it('caps aggregate metadata bytes at 2MiB without partial success', async () => {
    for (let index = 0; index < 33; index++) { const child = install('pkg-' + index), target = path.join(child, filename), raw = fs.readFileSync(target); fs.writeFileSync(target, Buffer.concat([raw, Buffer.alloc(65536 - raw.length, 0x20)])) }
    expect(await readInstalledCatalogSnapshot(options())).toEqual(unavailable('limit-exceeded'))
  })
  it('rejects lease invalidated after an awaited filesystem operation even if live is later restored', async () => {
    install(); const original = fsp.lstat.bind(fsp)
    vi.spyOn(fsp, 'lstat').mockImplementationOnce(async (...args) => { const result = await original(...args); live = false; return result })
    const pending = readInstalledCatalogSnapshot(options()), result = await pending; live = true
    expect(result).toEqual(unavailable('revoked'))
  })
  it('detects canonical-root disappearance during final re-enumeration, not partial publication', async () => {
    install(); const original = fsp.opendir.bind(fsp); let count = 0
    vi.spyOn(fsp, 'opendir').mockImplementation(async (...args) => { if (++count === 2) fs.renameSync(installed, installed + '-moved'); return original(...args) })
    const result = await readInstalledCatalogSnapshot(options())
    expect(result.status).toBe('unavailable'); expect(result).not.toHaveProperty('entries')
  })
  it('detects a root entry appearing during the read rather than publishing a stale subset', async () => {
    install(); const original = fsp.open.bind(fsp)
    vi.spyOn(fsp, 'open').mockImplementationOnce(async (...args) => { const handle = await original(...args); install('late'); return handle })
    const result = await readInstalledCatalogSnapshot(options())
    expect(result.status).toBe('unavailable'); expect(result).not.toHaveProperty('entries')
  })
  it('deadline returns before an unresolved open; late handle is closed and never read', async () => {
    install(); vi.useFakeTimers()
    let resolveOpen!: (value: Awaited<ReturnType<typeof fsp.open>>) => void, started!: () => void
    const opened = new Promise<void>(resolve => { started = resolve }), close = vi.fn(async () => {}), read = vi.fn()
    vi.spyOn(fsp, 'open').mockImplementationOnce(() => { started(); return new Promise(resolve => { resolveOpen = resolve }) })
    const pending = readInstalledCatalogSnapshot(options()); expect(await Promise.race([opened.then(() => 'opened'), pending.then(() => 'settled-before-open')])).toBe('opened')
    await vi.advanceTimersByTimeAsync(2001)
    expect(await pending).toEqual(unavailable('deadline'))
    resolveOpen({ close, read } as unknown as Awaited<ReturnType<typeof fsp.open>>)
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce()); expect(read).not.toHaveBeenCalled()
  })
  it('abort returns before unresolved opendir; eventual directory handle is closed without reading', async () => {
    install(); let resolveDirectory!: (value: Awaited<ReturnType<typeof fsp.opendir>>) => void, started!: () => void
    const opened = new Promise<void>(resolve => { started = resolve }), close = vi.fn(async () => {}), read = vi.fn()
    vi.spyOn(fsp, 'opendir').mockImplementationOnce(() => { started(); return new Promise(resolve => { resolveDirectory = resolve }) })
    const pending = readInstalledCatalogSnapshot(options()); expect(await Promise.race([opened.then(() => 'opened'), pending.then(() => 'settled-before-opendir')])).toBe('opened'); controller.abort()
    expect(await pending).toEqual(unavailable('revoked'))
    resolveDirectory({ close, read } as unknown as Awaited<ReturnType<typeof fsp.opendir>>)
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce()); expect(read).not.toHaveBeenCalled()
  })
  it('bounds outstanding workers to one without queuing successors while late cleanup remains pending', async () => {
    install(); let resolveOpen!: (value: Awaited<ReturnType<typeof fsp.open>>) => void, started!: () => void, finishClose!: () => void
    const opened = new Promise<void>(resolve => { started = resolve }), read = vi.fn(), close = vi.fn(() => new Promise<void>(resolve => { finishClose = resolve }))
    const open = vi.spyOn(fsp, 'open').mockImplementationOnce(() => { started(); return new Promise(resolve => { resolveOpen = resolve }) })
    const pending = readInstalledCatalogSnapshot(options()); expect(await Promise.race([opened.then(() => 'opened'), pending.then(() => 'settled')])).toBe('opened')
    controller.abort(); expect(await pending).toEqual(unavailable('revoked')); controller = new AbortController()
    const stat = vi.spyOn(fsp, 'lstat')
    for (let index = 0; index < 10; index++) expect(await readInstalledCatalogSnapshot(options())).toEqual(unavailable('unavailable'))
    expect(stat).not.toHaveBeenCalled(); expect(open).toHaveBeenCalledOnce()
    resolveOpen({ close, read } as unknown as Awaited<ReturnType<typeof fsp.open>>)
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(await readInstalledCatalogSnapshot(options())).toEqual(unavailable('unavailable')); expect(read).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled()
    finishClose(); await vi.waitFor(async () => expect(await readInstalledCatalogSnapshot(options())).toEqual({ status: 'available', entries: [expected()] }))
    expect(close).toHaveBeenCalledOnce()
  })
  it('accepts a directory ID ending in .txt when its final metadata is valid; no suffix-based false rejection', async () => {
    install('demo.txt')
    expect(await readInstalledCatalogSnapshot(options())).toEqual({ status: 'available', entries: [expected('demo.txt')] })
  })
  it.each(['revoked', 'stale', 'deadline'] as const)('rechecks %s between completed worker and outer publication continuation', async kind => {
    fs.mkdirSync(installed, { recursive: true })
    let enumerations = 0, finalRootPaths = 0, lastPinRead = false, guardsAfterLastPin = 0, clock = 1000, boundaryReached = false
    const directory = fsp.opendir.bind(fsp), realpath = fsp.realpath.bind(fsp)
    vi.spyOn(fsp, 'opendir').mockImplementation(async (...args) => { enumerations++; return directory(...args) })
    vi.spyOn(fsp, 'realpath').mockImplementation(async (...args) => {
      const result = await realpath(...args)
      if (String(args[0]) === installed && enumerations === 2 && ++finalRootPaths === 2) lastPinRead = true
      return result
    })
    const now = () => {
      if (lastPinRead && ++guardsAfterLastPin === 2) {
        boundaryReached = true
        queueMicrotask(() => { if (kind === 'revoked') controller.abort(); else if (kind === 'stale') live = false; else clock += 2001 })
      }
      return clock
    }
    const result = await readInstalledCatalogSnapshot(options({ now }))
    expect(boundaryReached).toBe(true)
    expect(result).toEqual(unavailable(kind === 'deadline' ? 'deadline' : 'revoked'))
  })
  it('rechecks abort fired by listener detachment after worker completion, before returning its already available result', async () => {
    fs.mkdirSync(installed, { recursive: true })
    const signal = controller.signal, remove = signal.removeEventListener.bind(signal); let boundaryReached = false
    vi.spyOn(signal, 'removeEventListener').mockImplementation((...args) => { remove(...args); if (args[0] === 'abort') { boundaryReached = true; controller.abort() } })
    const result = await readInstalledCatalogSnapshot(options())
    expect(boundaryReached).toBe(true); expect(result).toEqual(unavailable('revoked'))
  })
  it('clock failure prevents publication without leaking internal error detail', async () => {
    install(); expect(await readInstalledCatalogSnapshot(options({ now: () => { throw new Error('PRIVATE_CLOCK_PATH') } }))).toEqual(unavailable('deadline'))
  })
})
