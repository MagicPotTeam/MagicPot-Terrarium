import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FigPluginManifestSchema, canonicalFigPluginJson } from '@shared/figplugin/manifest'
import {
  FIGPLUGIN_MANAGEMENT_ERRORS,
  figPluginManagedListSchema
} from '@shared/figplugin/management'
import {
  FIGPLUGIN_PACKAGE_FORMAT,
  FigPluginPackageSchema,
  canonicalFigPluginPackageIndex,
  getFigPluginPackageSigningPayload
} from '@shared/figplugin/package'
import { verifyFigPluginPackage, type VerifiedFigPluginPackage } from './packageVerifier'
import { FigPluginCenterStore } from './centerStore'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const date = '2026-01-01T00:00:00.000Z'
const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const pluginId = 'demo.figplugin'
const fixture = (
  overrides: Record<string, unknown> = {},
  contents: Array<{ path: string; data: Buffer }> = [
    { path: 'plugin/main.js', data: Buffer.from('throw new Error("never execute");') },
    { path: 'assets/icon.txt', data: Buffer.from('fixture asset') }
  ]
): VerifiedFigPluginPackage => {
  const files = contents.map(({ path, data }) => ({
    path,
    bytes: data.length,
    sha256: sha(data),
    contentBase64: data.toString('base64')
  }))
  const manifest = FigPluginManifestSchema.parse({
    schemaVersion: 1,
    id: pluginId,
    name: 'Demo',
    version: '1.0.0',
    host: 'figma',
    entryPath: files[0].path,
    capabilities: ['dialogue'],
    permissions: { dialogue: 'prompt' },
    limits: { maxConfigBytes: 4096 },
    provenance: {
      publisherId: 'publisher',
      publisherName: 'Publisher',
      source: 'official',
      artifactSha256: 'a'.repeat(64),
      issuedAt: date
    },
    signature: {
      algorithm: 'ed25519',
      keyId: 'fixture-key',
      value: 'b'.repeat(128),
      signedAt: date
    },
    assets: files.map((file, index) => ({
      id: `asset-${index}`,
      path: file.path,
      sizeBytes: file.bytes,
      sha256: file.sha256
    })),
    ...overrides
  })
  const pkg = FigPluginPackageSchema.parse({ format: FIGPLUGIN_PACKAGE_FORMAT, manifest, files })
  pkg.manifest.provenance.artifactSha256 = sha(canonicalFigPluginPackageIndex(pkg))
  pkg.manifest.signature.value = sign(
    null,
    Buffer.from(getFigPluginPackageSigningPayload(pkg)),
    keys.privateKey
  ).toString('hex')
  return verifyFigPluginPackage(pkg, publicKey)
}

let parent: string
let root: string
let store: FigPluginCenterStore
const recordPath = (id = pluginId): string => path.join(root, `${sha(id)}.json`)
const readRecord = async (id = pluginId) => JSON.parse(await fs.readFile(recordPath(id), 'utf8'))
const directory = (verified: VerifiedFigPluginPackage): string =>
  path.join(
    root,
    'packages',
    sha(verified.package.manifest.id),
    sha(canonicalFigPluginJson([verified.package.manifest, verified.artifactSha256]))
  )
const target = (expectedGeneration: number) => ({ pluginId, expectedGeneration })
const remove = (expectedGeneration: number, idempotencyKey = 'remove') => ({
  ...target(expectedGeneration),
  idempotencyKey
})
const legacy = (
  kind: 'install' | 'configure' | 'uninstall',
  manifest = fixture().package.manifest
) => ({
  schemaVersion: 1,
  kind,
  requestId: `${kind}-request`,
  idempotencyKey: `${kind}-old`,
  requestedAt: date,
  ...(kind === 'install' ? { manifest } : { pluginId, host: 'figma' }),
  consent: { granted: true, permissions: [kind], grantedAt: date },
  ...(kind === 'configure' ? { config: {}, configBytes: 2 } : {})
})
const rejection = (code: keyof typeof FIGPLUGIN_MANAGEMENT_ERRORS) => ({
  code,
  message: FIGPLUGIN_MANAGEMENT_ERRORS[code],
  cause: undefined
})
const trackRecordReads = (
  afterRead?: (files: number) => void,
  beforeRead?: (filename: string) => Promise<void>
) => {
  const stats = { files: 0, bytes: 0 }
  const open = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    const filename = args[0].toString()
    if (path.dirname(filename) !== root || !filename.endsWith('.json')) return handle
    stats.files += 1
    const read = handle.read.bind(handle)
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      await beforeRead?.(filename)
      const result = await read(buffer, offset, length, position)
      stats.bytes += result.bytesRead
      afterRead?.(stats.files)
      return result
    }) as typeof handle.read
    return handle
  })
  return stats
}

beforeEach(async () => {
  parent = await fs.mkdtemp(path.join(process.cwd(), '.figplugin-managed-test-'))
  root = path.join(parent, 'center')
  store = new FigPluginCenterStore(() => root)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await fs.rm(parent, { recursive: true, force: true })
})

describe('FIGPLUGIN managed packages in the existing metadata store', () => {
  it('starts empty with generation zero and redacted not-installed failures', async () => {
    expect(await store.listManaged()).toEqual({ items: [], truncated: false, skippedRecords: 0 })
    expect(await store.getManagedGeneration(pluginId)).toBe(0)
    await expect(store.getOwnedEntryPath(target(0))).rejects.toMatchObject(
      rejection('NOT_INSTALLED')
    )
  })

  it('materializes a real Ed25519-verified package without executing and returns only redacted summaries', async () => {
    const verified = fixture()
    expect(await store.installVerifiedPackage(verified, 0, 'install')).toEqual({
      completed: true,
      generation: 1,
      cleanupPending: false
    })
    const entry = await store.getOwnedEntryPath(target(1))
    expect(entry).toBe(path.join(directory(verified), verified.package.manifest.entryPath))
    expect(await fs.readFile(entry)).toEqual(verified.files[0].data)
    const list = await store.listManaged()
    expect(figPluginManagedListSchema.safeParse(list).success).toBe(true)
    expect(list.items[0]).toMatchObject({
      materialization: 'verified-package',
      fileCount: 2,
      generation: 1,
      state: 'disabled',
      ready: false,
      configured: false,
      settings: {}
    })
    for (const secret of [
      root,
      'entryPath',
      'signature',
      'provenance',
      'throw new Error',
      publicKey
    ])
      expect(JSON.stringify(list)).not.toContain(secret)
    expect((await readRecord()).schemaVersion).toBe(2)
    expect((await fs.stat(entry)).nlink).toBe(1)
  })

  it('migrates v1 metadata in-place, leaves old secrets and receipts untouched, and never displays config as settings', async () => {
    const verified = fixture()
    await fs.mkdir(root)
    const old = {
      schemaVersion: 1,
      pluginId,
      manifest: verified.package.manifest,
      config: { analysisProfileId: 'legacy-secret', apiKey: 'private' },
      receipts: []
    }
    await fs.writeFile(recordPath(), JSON.stringify(old))
    expect(await store.getManagedGeneration(pluginId)).toBe(0)
    expect((await store.listManaged()).items[0]).toMatchObject({
      materialization: 'metadata-only',
      configured: true,
      settings: {}
    })
    await expect(store.getOwnedEntryPath(target(0))).rejects.toMatchObject(
      rejection('NOT_INSTALLED')
    )
    await store.installVerifiedPackage(verified, 0, 'upgrade')
    expect((await readRecord()).config).toEqual(old.config)
    expect((await readRecord()).receipts).toEqual([])
    expect((await store.listManaged()).items[0].settings).toEqual({})
  })

  it('stores only allowlisted managed references and snapshots them before waiting', async () => {
    await store.installVerifiedPackage(fixture(), 0, 'install')
    const request = { ...target(1), settings: { analysisProfileId: 'profile-one' } }
    const pending = store.configureManaged(request)
    request.settings.analysisProfileId = 'mutated'
    expect(await pending).toMatchObject({ generation: 2 })
    expect((await store.listManaged()).items[0].settings).toEqual({
      analysisProfileId: 'profile-one'
    })
    expect((await readRecord()).config).toBeNull()
    await expect(
      store.configureManaged({ ...target(2), settings: { apiKey: 'secret' } } as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', cause: undefined })
    expect(await store.getManagedGeneration(pluginId)).toBe(2)
  })

  it('serializes generation CAS across instances and legacy mutations', async () => {
    const verified = fixture()
    const other = new FigPluginCenterStore(root)
    const outcomes = await Promise.allSettled([
      store.installVerifiedPackage(verified, 0, 'one'),
      other.installVerifiedPackage(verified, 0, 'two')
    ])
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((item) => item.status === 'rejected')).toMatchObject({
      reason: rejection('CONFIGURATION_CHANGED')
    })
    await expect(store.configureManaged({ ...target(0), settings: {} })).rejects.toMatchObject(
      rejection('CONFIGURATION_CHANGED')
    )
    await expect(store.getOwnedEntryPath(target(0))).rejects.toMatchObject(
      rejection('CONFIGURATION_CHANGED')
    )
  })

  it('replays install before current CAS, including after uninstall, without reinstalling', async () => {
    const verified = fixture()
    const result = await store.installVerifiedPackage(verified, 0, 'install')
    await store.removeManaged(remove(1))
    store = new FigPluginCenterStore(root)
    expect(await store.installVerifiedPackage(verified, 0, 'install', 0)).toEqual(result)
    expect(await store.listManaged()).toMatchObject({ items: [] })
    expect(await store.getManagedGeneration(pluginId)).toBe(2)
  })

  it('binds replay keys to operation, manifest, signer and expected generation', async () => {
    const verified = fixture()
    await store.installVerifiedPackage(verified, 0, 'key')
    for (const [candidate, generation] of [
      [fixture({ version: '2.0.0' }), 0],
      [{ ...verified, keyFingerprint: 'e'.repeat(64) }, 0],
      [verified, 1]
    ] as const) {
      await expect(
        store.installVerifiedPackage(candidate, generation, 'key')
      ).rejects.toMatchObject(rejection('IDEMPOTENCY_CONFLICT'))
    }
    await expect(store.removeManaged(remove(1, 'key'))).rejects.toMatchObject(
      rejection('IDEMPOTENCY_CONFLICT')
    )
  })

  it('includes the complete manifest in directory identity even when file artifacts are equal', async () => {
    const first = fixture()
    const next = fixture({ version: '2.0.0' })
    expect(first.artifactSha256).toBe(next.artifactSha256)
    await store.installVerifiedPackage(first, 0, 'first')
    const original = await store.getOwnedEntryPath(target(1))
    await store.installVerifiedPackage(next, 1, 'second')
    expect(await store.getOwnedEntryPath(target(2))).not.toBe(original)
    await expect(fs.lstat(directory(first))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['entry', 'asset'])(
    'checks ALL inventory hashes before copy when %s content changes',
    async (which) => {
      const verified = fixture()
      await store.installVerifiedPackage(verified, 0, 'install')
      const file = verified.files[which === 'entry' ? 0 : 1]
      await fs.writeFile(
        path.join(directory(verified), file.path),
        Buffer.alloc(file.data.length, 120)
      )
      await expect(store.getOwnedEntryPath(target(1))).rejects.toMatchObject(
        rejection('INTEGRITY_FAILED')
      )
    }
  )

  it('rejects hard-linked package content without unlinking the external alias', async () => {
    const verified = fixture()
    await store.installVerifiedPackage(verified, 0, 'install')
    const outside = path.join(parent, 'external.js')
    await fs.link(await store.getOwnedEntryPath(target(1)), outside)
    await expect(store.getOwnedEntryPath(target(1))).rejects.toMatchObject(
      rejection('INTEGRITY_FAILED')
    )
    expect(await store.removeManaged(remove(1))).toEqual({
      completed: true,
      generation: 2,
      cleanupPending: true
    })
    expect(await fs.readFile(outside)).toEqual(verified.files[0].data)
    await fs.unlink(outside)
    expect(await store.removeManaged(remove(1))).toEqual({
      completed: true,
      generation: 2,
      cleanupPending: false
    })
  })

  it.each(['root', 'parent', 'packages'])(
    'rejects %s junctions without traversing or modifying the target',
    async (which) => {
      const outside = path.join(parent, 'outside')
      await fs.mkdir(outside)
      let link = root
      if (which === 'parent') {
        link = path.join(parent, 'junction')
        root = path.join(link, 'nested')
      } else if (which === 'packages') {
        await fs.mkdir(root)
        link = path.join(root, 'packages')
      }
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(store.installVerifiedPackage(fixture(), 0, 'install')).rejects.toMatchObject(
        rejection('IO_ERROR')
      )
      expect(await fs.readdir(outside)).toEqual([])
    }
  )

  it('rejects a substituted owned directory junction and never deletes its destination', async () => {
    const verified = fixture()
    await store.installVerifiedPackage(verified, 0, 'install')
    const outside = path.join(parent, 'moved-package')
    await fs.rename(directory(verified), outside)
    await fs.symlink(
      outside,
      directory(verified),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(store.getOwnedEntryPath(target(1))).rejects.toMatchObject(
      rejection('INTEGRITY_FAILED')
    )
    expect(await store.removeManaged(remove(1))).toMatchObject({
      completed: true,
      generation: 2,
      cleanupPending: true
    })
    expect(await fs.readFile(path.join(outside, verified.files[0].path))).toEqual(
      verified.files[0].data
    )
  })

  it('rejects linked records and skips corrupt records without raw contents', async () => {
    await store.installVerifiedPackage(fixture(), 0, 'install')
    const alias = path.join(parent, 'record-alias')
    await fs.link(recordPath(), alias)
    await fs.writeFile(path.join(root, `${'f'.repeat(64)}.json`), 'private-corruption')
    expect(await store.listManaged()).toEqual({ items: [], truncated: false, skippedRecords: 2 })
    await expect(store.removeManaged(remove(1))).rejects.toMatchObject(rejection('IO_ERROR'))
    expect(JSON.parse(await fs.readFile(alias, 'utf8')).generation).toBe(1)
  })

  it('bounds root enumeration to 512 entries using opendir and caps listings at 256', async () => {
    const verified = fixture()
    await fs.mkdir(root)
    const raw = { schemaVersion: 1, config: null, receipts: [] }
    for (let index = 0; index < 257; index += 1) {
      const id = `record-${index}`
      await fs.writeFile(
        recordPath(id),
        JSON.stringify({ ...raw, pluginId: id, manifest: { ...verified.package.manifest, id } })
      )
    }
    vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('unbounded enumeration forbidden'))
    const recordReads = trackRecordReads()
    const first = await store.listManaged()
    expect(first.items).toHaveLength(256)
    expect(first.truncated).toBe(true)
    expect(recordReads.files).toBe(256)
    for (let index = 0; index < 270; index += 1)
      await fs.writeFile(path.join(root, `ignored-${index}`), '')
    const openDir = fs.opendir.bind(fs)
    let reads = 0
    vi.spyOn(fs, 'opendir').mockImplementation(async (...args) => {
      const handle = await openDir(...args)
      const read = handle.read.bind(handle)
      handle.read = (async () => {
        reads += 1
        return read()
      }) as typeof handle.read
      return handle
    })
    expect((await store.listManaged()).truncated).toBe(true)
    expect(reads).toBeLessThanOrEqual(512)
    await expect(
      store.installVerifiedPackage(fixture({ id: 'over-capacity' }), 0, 'install')
    ).rejects.toMatchObject(rejection('BUSY'))
  })

  it.each([
    { kind: 'malformed', sizeMiB: 8 },
    { kind: 'invalid', sizeMiB: 6 },
    { kind: 'valid', sizeMiB: 8 }
  ])('bounds padded $kind record reads to 16MiB, not 512 times 8MiB', async ({ kind, sizeMiB }) => {
    await fs.mkdir(root)
    const verified = fixture()
    for (let index = 0; index < 4; index += 1) {
      const id = `padded-${index}`
      const text =
        kind === 'malformed'
          ? 'private-corruption'
          : kind === 'invalid'
            ? '{"private":"must-not-leak"}'
            : JSON.stringify({
                pluginId: id,
                manifest: { ...verified.package.manifest, id },
                config: null,
                receipts: []
              })
      await fs.writeFile(recordPath(id), text.padEnd(sizeMiB * 1024 * 1024, ' '))
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const reads = trackRecordReads()
    const list = await store.listManaged()
    expect(list.truncated).toBe(true)
    expect(list.skippedRecords).toBe(kind === 'valid' ? 0 : 2)
    expect(list.items).toHaveLength(kind === 'valid' ? 2 : 0)
    expect(reads.files).toBe(2)
    expect(reads.bytes).toBe(2 * sizeMiB * 1024 * 1024)
    expect(reads.bytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(figPluginManagedListSchema.safeParse(list).success).toBe(true)
    for (const secret of [root, 'private-corruption', 'must-not-leak'])
      expect(JSON.stringify(list)).not.toContain(secret)
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('charges actual bytes from a growing record and refuses the next record before opening it', async () => {
    await fs.mkdir(root)
    for (let index = 0; index < 3; index += 1)
      await fs.writeFile(recordPath(`growing-${index}`), '{}'.padEnd(8 * 1024 * 1024, ' '))
    let grew = false
    const reads = trackRecordReads(undefined, async (filename) => {
      if (grew) return
      grew = true
      await fs.appendFile(filename, 'x')
    })
    expect(await store.listManaged()).toEqual({ items: [], truncated: true, skippedRecords: 1 })
    expect(reads.files).toBe(1)
    expect(reads.bytes).toBe(8 * 1024 * 1024 + 1)
  })

  it('returns partial results after ten seconds without loading further padded records or leaking errors', async () => {
    await fs.mkdir(root)
    const verified = fixture()
    for (let index = 0; index < 4; index += 1) {
      const id = `timed-${index}`
      await fs.writeFile(
        recordPath(id),
        JSON.stringify({
          pluginId: id,
          manifest: { ...verified.package.manifest, id },
          config: null,
          receipts: []
        }).padEnd(6 * 1024 * 1024, ' ')
      )
    }
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const reads = trackRecordReads((files) => {
      if (files === 2) now = 10_000
    })
    const list = await store.listManaged()
    expect(list.items).toHaveLength(1)
    expect(list).toMatchObject({ truncated: true, skippedRecords: 0 })
    expect(reads.files).toBe(2)
    expect(reads.bytes).toBeLessThanOrEqual(12 * 1024 * 1024)
    expect(figPluginManagedListSchema.safeParse(list).success).toBe(true)
  })

  it('includes enumeration in the ten-second listing deadline', async () => {
    await fs.mkdir(root)
    for (let index = 0; index < 20; index += 1)
      await fs.writeFile(path.join(root, `ignored-${index}`), '')
    let now = 0
    let reads = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const openDir = fs.opendir.bind(fs)
    vi.spyOn(fs, 'opendir').mockImplementation(async (...args) => {
      const handle = await openDir(...args)
      const read = handle.read.bind(handle)
      handle.read = (async () => {
        reads += 1
        now += 1000
        return read()
      }) as typeof handle.read
      return handle
    })
    expect(await store.listManaged()).toEqual({ items: [], truncated: true, skippedRecords: 0 })
    expect(reads).toBe(10)
  })

  it('expires a queued listing after ten seconds and never scans when its lock is later granted', async () => {
    await store.installVerifiedPackage(fixture(), 0, 'install')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      entered()
      await gate
      return open(...args)
    })
    const scan = vi.spyOn(fs, 'opendir')
    const blocker = store.getManagedGeneration(pluginId)
    await started
    try {
      const listing = new FigPluginCenterStore(root).listManaged()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await listing).toEqual({ items: [], truncated: true, skippedRecords: 0 })
    } finally {
      release()
      await blocker
      vi.useRealTimers()
    }
    expect(await store.getManagedGeneration(pluginId)).toBe(1)
    expect(scan).not.toHaveBeenCalled()
  })

  it.each(['bytes', 'hash', 'artifact', 'manifest', 'duplicate', 'path', 'single-size', 'count'])(
    'rejects changed verifier output at the %s boundary before storage',
    async (kind) => {
      const verified = fixture()
      if (kind === 'bytes') verified.files[0].data[0] ^= 1
      if (kind === 'hash') verified.package.files[0].sha256 = 'f'.repeat(64)
      if (kind === 'artifact') verified.artifactSha256 = 'f'.repeat(64)
      if (kind === 'manifest') verified.package.manifest.assets[0].sha256 = 'f'.repeat(64)
      if (kind === 'duplicate') verified.files[1] = verified.files[0]
      if (kind === 'path') verified.files[0].path = '../escape'
      if (kind === 'single-size') verified.files[0].data = Buffer.alloc(2 * 1024 * 1024 + 1)
      if (kind === 'count') verified.files = Array.from({ length: 65 }, () => verified.files[0])
      await expect(store.installVerifiedPackage(verified, 0, 'install')).rejects.toMatchObject(
        rejection('INVALID_PACKAGE')
      )
      expect(await fs.readdir(parent)).toEqual([])
    }
  )

  it('preserves the old pointer on atomic failure and safely reuses the retained candidate on retry', async () => {
    const first = fixture()
    const next = fixture({ version: '2.0.0' })
    await store.installVerifiedPackage(first, 0, 'first')
    const previous = await fs.readFile(recordPath(), 'utf8')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === recordPath()) throw new Error(`pointer failure ${root}`)
      await rename(from, to)
    })
    await expect(store.installVerifiedPackage(next, 1, 'next')).rejects.toMatchObject(
      rejection('IO_ERROR')
    )
    expect(await fs.readFile(recordPath(), 'utf8')).toBe(previous)
    expect(await fs.readFile(path.join(directory(next), next.files[0].path))).toEqual(
      next.files[0].data
    )
    expect(await store.getOwnedEntryPath(target(1))).toBe(
      path.join(directory(first), first.files[0].path)
    )
    vi.restoreAllMocks()
    expect(await store.installVerifiedPackage(next, 1, 'next')).toMatchObject({
      generation: 2,
      cleanupPending: false
    })
  })

  it('does not delete an orphan from another failed candidate to evade quota', async () => {
    const verified = fixture()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === recordPath()) throw new Error('pointer failure')
      await rename(from, to)
    })
    await expect(store.installVerifiedPackage(verified, 0, 'install')).rejects.toMatchObject(
      rejection('IO_ERROR')
    )
    vi.restoreAllMocks()
    await expect(
      store.installVerifiedPackage(fixture({ version: '3.0.0' }), 0, 'other')
    ).rejects.toMatchObject(rejection('BUSY'))
    expect(await fs.readFile(path.join(directory(verified), verified.files[0].path))).toEqual(
      verified.files[0].data
    )
  })

  it('removal commits tombstone and receipt before deleting only known files, with cleanup retry', async () => {
    const verified = fixture()
    await store.installVerifiedPackage(verified, 0, 'install')
    const unknown = path.join(directory(verified), 'unowned.txt')
    await fs.writeFile(unknown, 'must survive')
    const unlink = fs.unlink.bind(fs)
    vi.spyOn(fs, 'unlink').mockImplementation(async (filename) => {
      if (filename.toString().startsWith(directory(verified)))
        expect(await readRecord()).toMatchObject({
          manifest: null,
          removedManifest: verified.package.manifest,
          generation: 2,
          managedReceipts: expect.arrayContaining([
            expect.objectContaining({
              result: { completed: true, generation: 2, cleanupPending: true }
            })
          ])
        })
      await unlink(filename)
    })
    expect(await store.removeManaged(remove(1))).toEqual({
      completed: true,
      generation: 2,
      cleanupPending: true
    })
    expect(await fs.readFile(unknown, 'utf8')).toBe('must survive')
    expect(await store.getManagedGeneration(pluginId)).toBe(2)
    await fs.unlink(unknown)
    store = new FigPluginCenterStore(root)
    expect(await store.removeManaged(remove(1))).toEqual({
      completed: true,
      generation: 2,
      cleanupPending: false
    })
    expect(await store.removeManaged(remove(1))).toEqual({
      completed: true,
      generation: 2,
      cleanupPending: false
    })
  })

  it('retains a restart-visible cleanup row after the second unlink fails without blocking other IDs', async () => {
    const verified = fixture({ name: 'Retained name', version: '2.3.4' })
    await store.installVerifiedPackage(verified, 0, 'install')
    await store.configureManaged({ ...target(1), settings: { analysisProfileId: 'old-profile' } })
    const unlink = fs.unlink.bind(fs)
    let deletes = 0
    const fault = vi.spyOn(fs, 'unlink').mockImplementation(async (filename) => {
      if (filename.toString().startsWith(directory(verified))) {
        expect(await readRecord()).toMatchObject({
          manifest: null,
          removedManifest: verified.package.manifest
        })
        if (++deletes === 2) throw new Error(`unlink failed: ${root}`)
      }
      await unlink(filename)
    })
    expect(await store.removeManaged(remove(2))).toEqual({
      completed: true,
      generation: 3,
      cleanupPending: true
    })
    expect(deletes).toBe(2)
    fault.mockRestore()
    await expect(
      fs.lstat(path.join(directory(verified), verified.files[0].path))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.rmdir(path.dirname(path.join(directory(verified), verified.files[0].path)))
    store = new FigPluginCenterStore(root)
    const list = await store.listManaged()
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({
      pluginId,
      name: 'Retained name',
      version: '2.3.4',
      generation: 3,
      materialization: 'cleanup-pending',
      state: 'uninstalled',
      ready: false,
      configured: false,
      cleanupPending: true,
      settings: {}
    })
    expect(figPluginManagedListSchema.safeParse(list).success).toBe(true)
    for (const secret of [root, 'entryPath', 'signature', 'old-profile'])
      expect(JSON.stringify(list)).not.toContain(secret)
    await expect(store.getOwnedEntryPath(target(3))).rejects.toMatchObject(
      rejection('NOT_INSTALLED')
    )
    await expect(store.configureManaged({ ...target(3), settings: {} })).rejects.toMatchObject(
      rejection('NOT_INSTALLED')
    )
    expect(
      await store.installVerifiedPackage(fixture({ id: 'unrelated.plugin' }), 0, 'other')
    ).toMatchObject({ completed: true, cleanupPending: false })
    expect(await store.removeManaged(remove(list.items[0].generation, 'retry-current'))).toEqual({
      completed: true,
      generation: 4,
      cleanupPending: false
    })
    expect((await readRecord()).removedManifest).toBeNull()
    expect((await store.listManaged()).items.map((item) => item.pluginId)).toEqual([
      'unrelated.plugin'
    ])
  })

  it('allows partial retired inventories during capacity checks without relaxing active copy checks', async () => {
    const first = fixture()
    const next = fixture({ version: '2.0.0' })
    await store.installVerifiedPackage(first, 0, 'first')
    const unlink = fs.unlink.bind(fs)
    const fault = vi.spyOn(fs, 'unlink').mockImplementation(async (filename) => {
      if (filename === path.join(directory(first), first.files[1].path))
        throw new Error('second unlink')
      await unlink(filename)
    })
    expect(await store.installVerifiedPackage(next, 1, 'next')).toMatchObject({
      generation: 2,
      cleanupPending: true
    })
    fault.mockRestore()
    store = new FigPluginCenterStore(root)
    expect(
      await store.installVerifiedPackage(fixture({ id: 'unrelated.plugin' }), 0, 'other')
    ).toMatchObject({ completed: true })
    expect(await store.getOwnedEntryPath(target(2))).toBe(
      path.join(directory(next), next.files[0].path)
    )
    await fs.unlink(path.join(directory(next), next.files[1].path))
    await expect(store.getOwnedEntryPath(target(2))).rejects.toMatchObject(
      rejection('INTEGRITY_FAILED')
    )
    await expect(
      store.installVerifiedPackage(fixture({ id: 'third.plugin' }), 0, 'third')
    ).rejects.toMatchObject(rejection('IO_ERROR'))
  })

  it.each(['unknown', 'hard-link', 'junction', 'modified'])(
    'still refuses %s leftovers in partially deleted cleanup inventories',
    async (kind) => {
      const verified = fixture()
      await store.installVerifiedPackage(verified, 0, 'install')
      const remaining = path.join(directory(verified), verified.files[1].path)
      const unlink = fs.unlink.bind(fs)
      const fault = vi.spyOn(fs, 'unlink').mockImplementation(async (filename) => {
        if (filename === remaining) throw new Error('second unlink')
        await unlink(filename)
      })
      expect(await store.removeManaged(remove(1))).toMatchObject({ cleanupPending: true })
      fault.mockRestore()
      if (kind === 'unknown')
        await fs.writeFile(path.join(directory(verified), 'unknown'), 'must survive')
      if (kind === 'hard-link') await fs.link(remaining, path.join(parent, 'alias'))
      if (kind === 'modified')
        await fs.writeFile(remaining, Buffer.alloc(verified.files[1].data.length, 120))
      if (kind === 'junction') {
        const outside = path.join(parent, 'outside')
        await fs.rename(path.dirname(remaining), outside)
        await fs.symlink(
          outside,
          path.dirname(remaining),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      }
      store = new FigPluginCenterStore(root)
      await expect(
        store.installVerifiedPackage(fixture({ id: 'unrelated.plugin' }), 0, 'other')
      ).rejects.toMatchObject(rejection('IO_ERROR'))
      expect(await fs.readFile(remaining)).toEqual(
        kind === 'modified'
          ? Buffer.alloc(verified.files[1].data.length, 120)
          : verified.files[1].data
      )
      expect((await store.listManaged()).items[0].cleanupPending).toBe(true)
    }
  )

  it('admits known empty package parents but refuses even an empty unknown parent', async () => {
    await store.installVerifiedPackage(fixture(), 0, 'install')
    await store.removeManaged(remove(1))
    await fs.mkdir(path.join(root, 'packages', sha('unknown.plugin')))
    await expect(
      store.installVerifiedPackage(fixture({ id: 'unrelated.plugin' }), 0, 'other')
    ).rejects.toMatchObject(rejection('BUSY'))
  })

  it.each(['entry', 'asset', 'oversized'])(
    'preserves modified regular %s content and keeps cleanup pending across retries',
    async (kind) => {
      const verified = fixture()
      await store.installVerifiedPackage(verified, 0, 'install')
      const file = verified.files[kind === 'asset' ? 1 : 0]
      const filename = path.join(directory(verified), file.path)
      const changed = Buffer.alloc(
        kind === 'oversized' ? 2 * 1024 * 1024 + 1 : file.data.length,
        120
      )
      await fs.writeFile(filename, changed)
      expect(await store.removeManaged(remove(1))).toEqual({
        completed: true,
        generation: 2,
        cleanupPending: true
      })
      expect((await fs.readFile(filename)).equals(changed)).toBe(true)
      store = new FigPluginCenterStore(root)
      expect(await store.removeManaged(remove(2, 'retry'))).toEqual({
        completed: true,
        generation: 3,
        cleanupPending: true
      })
      expect((await fs.readFile(filename)).equals(changed)).toBe(true)
      expect((await store.listManaged()).items[0]).toMatchObject({
        state: 'uninstalled',
        cleanupPending: true
      })
      await fs.writeFile(filename, file.data)
      expect(await store.removeManaged(remove(3, 'restored'))).toEqual({
        completed: true,
        generation: 4,
        cleanupPending: false
      })
      expect(await store.listManaged()).toEqual({ items: [], truncated: false, skippedRecords: 0 })
      expect((await readRecord()).removedManifest).toBeNull()
    }
  )

  it('reports committed cleanup pending if the final cleanup record rename fails', async () => {
    await store.installVerifiedPackage(fixture(), 0, 'install')
    const rename = fs.rename.bind(fs)
    let pointers = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === recordPath() && ++pointers === 2) throw new Error('cleanup record failure')
      await rename(from, to)
    })
    expect(await store.removeManaged(remove(1))).toEqual({
      completed: true,
      generation: 2,
      cleanupPending: true
    })
    expect(await readRecord()).toMatchObject({
      manifest: null,
      generation: 2,
      packageRecord: { cleanupPending: true }
    })
    vi.restoreAllMocks()
    expect(await store.removeManaged(remove(1))).toMatchObject({
      generation: 2,
      cleanupPending: false
    })
  })

  it('checks staging deadlines and honors actual late pointer rename success', async () => {
    const verified = fixture()
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[1] === 'wx') {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync()
          now = 101
        })
      }
      return handle
    })
    await expect(store.installVerifiedPackage(verified, 0, 'install', 100)).rejects.toMatchObject(
      rejection('TIMEOUT')
    )
    await expect(fs.lstat(recordPath())).rejects.toMatchObject({ code: 'ENOENT' })
    vi.restoreAllMocks()
    now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (to === recordPath()) now = 101
    })
    expect(await store.installVerifiedPackage(verified, 0, 'install', 100)).toEqual({
      completed: true,
      generation: 1,
      cleanupPending: false
    })
  })

  it('reserves the last of 256 managed receipts for removal and never evicts old history', async () => {
    await store.installVerifiedPackage(fixture(), 0, 'install')
    const record = await readRecord()
    record.managedReceipts = Array.from({ length: 255 }, (_, index) => ({
      ...record.managedReceipts[0],
      key: sha(`history-${index}`)
    }))
    await fs.writeFile(recordPath(), JSON.stringify(record))
    await expect(
      store.installVerifiedPackage(fixture({ version: '2.0.0' }), 1, 'next')
    ).rejects.toMatchObject(rejection('BUSY'))
    expect(await store.removeManaged(remove(1))).toMatchObject({ completed: true, generation: 2 })
    expect((await readRecord()).managedReceipts).toHaveLength(256)
    expect(await store.removeManaged(remove(1))).toMatchObject({ generation: 2 })
    await expect(store.removeManaged(remove(2, 'another'))).rejects.toMatchObject(rejection('BUSY'))
  })

  it.each(['installed', 'cleanup-pending'])(
    'enforces the 128MiB aggregate quota from declared %s inventories even when files are absent',
    async (state) => {
      await fs.mkdir(root)
      const data = Array.from({ length: 4 }, (_, index) => ({
        path: `file-${index}.js`,
        data: Buffer.alloc(2 * 1024 * 1024, index)
      }))
      const large = fixture({}, data)
      for (let index = 0; index < 16; index += 1) {
        const id = `large-${index}`
        const manifest = { ...large.package.manifest, id }
        await fs.writeFile(
          recordPath(id),
          JSON.stringify({
            schemaVersion: 2,
            pluginId: id,
            manifest: state === 'installed' ? manifest : null,
            removedManifest: state === 'cleanup-pending' ? manifest : null,
            config: null,
            receipts: [],
            generation: 1,
            packageRecord: {
              artifactSha256: large.artifactSha256,
              keyFingerprint: large.keyFingerprint,
              inventory: large.package.files.map(({ path, bytes, sha256 }) => ({
                path,
                bytes,
                sha256
              })),
              locationId: sha(canonicalFigPluginJson([manifest, large.artifactSha256])),
              cleanupPending: state === 'cleanup-pending'
            }
          })
        )
      }
      await expect(store.installVerifiedPackage(fixture(), 0, 'overflow')).rejects.toMatchObject(
        rejection('BUSY')
      )
      await expect(fs.lstat(recordPath())).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each(['install', 'configure', 'uninstall'] as const)(
    'rejects legacy %s for a managed package without changing records or owned content',
    async (kind) => {
      const verified = fixture()
      await store.installVerifiedPackage(verified, 0, 'install')
      const before = await fs.readFile(recordPath(), 'utf8')
      expect(await store.execute(legacy(kind, verified.package.manifest))).toMatchObject({
        ok: false,
        failure: { reason: 'not-ready', message: 'Verified packages require managed operations.' }
      })
      expect(await fs.readFile(recordPath(), 'utf8')).toBe(before)
      expect(await fs.readFile(await store.getOwnedEntryPath(target(1)))).toEqual(
        verified.files[0].data
      )
    }
  )

  it('keeps metadata-only removal from touching a UI/source path', async () => {
    const verified = fixture()
    await fs.mkdir(root)
    const source = path.join(parent, 'source.js')
    await fs.writeFile(source, 'source survives')
    await fs.writeFile(
      recordPath(),
      JSON.stringify({
        pluginId,
        manifest: verified.package.manifest,
        config: { path: source },
        receipts: []
      })
    )
    expect(await store.removeManaged(remove(0))).toEqual({
      completed: true,
      generation: 1,
      cleanupPending: false
    })
    expect(await fs.readFile(source, 'utf8')).toBe('source survives')
  })

  it('permits other IDs after removal and never lets old removal replay delete a reinstall', async () => {
    const verified = fixture()
    await store.installVerifiedPackage(verified, 0, 'install')
    const removed = await store.removeManaged(remove(1))
    await store.installVerifiedPackage(fixture({ id: 'other.plugin' }), 0, 'other')
    expect(await store.installVerifiedPackage(verified, 2, 'reinstall')).toMatchObject({
      generation: 3
    })
    expect(await store.removeManaged(remove(1))).toEqual(removed)
    expect(await store.getOwnedEntryPath(target(3))).toBe(
      path.join(directory(verified), verified.files[0].path)
    )
    expect((await store.listManaged()).items).toHaveLength(2)
  })

  it('preserves historical opaque config when an upgrade lowers the manifest config limit', async () => {
    const verified = fixture()
    expect(await store.execute(legacy('install', verified.package.manifest))).toMatchObject({
      ok: true
    })
    const record = await readRecord()
    record.config = { secret: 'private'.repeat(30) }
    await fs.writeFile(recordPath(), JSON.stringify(record))
    const receipts = record.receipts
    await store.installVerifiedPackage(
      fixture({ version: '2.0.0', limits: { maxConfigBytes: 128 } }),
      1,
      'upgrade'
    )
    store = new FigPluginCenterStore(root)
    expect(await store.getManagedGeneration(pluginId)).toBe(2)
    expect((await readRecord()).config).toEqual(record.config)
    expect((await readRecord()).receipts).toEqual(receipts)
    expect((await store.listManaged()).items[0].settings).toEqual({})
    await expect(
      store.configureManaged({ ...target(2), settings: { analysisProfileId: 'x'.repeat(128) } })
    ).rejects.toMatchObject(rejection('INVALID_PACKAGE'))
  })

  it('snapshots verified buffers and manifests before asynchronous staging', async () => {
    const verified = fixture()
    const expected = Buffer.from(verified.files[0].data)
    const pending = store.installVerifiedPackage(verified, 0, 'install')
    verified.files[0].data.fill(0)
    verified.package.manifest.version = '99.0.0'
    await pending
    expect(await fs.readFile(await store.getOwnedEntryPath(target(1)))).toEqual(expected)
    expect((await store.listManaged()).items[0].version).toBe('1.0.0')
  })

  it('rejects a removal pointer failure without deleting content and permits identical retry', async () => {
    const verified = fixture()
    await store.installVerifiedPackage(verified, 0, 'install')
    const before = await fs.readFile(recordPath(), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('pointer unavailable'))
    await expect(store.removeManaged(remove(1))).rejects.toMatchObject(rejection('IO_ERROR'))
    expect(await fs.readFile(recordPath(), 'utf8')).toBe(before)
    expect(await fs.readFile(await store.getOwnedEntryPath(target(1)))).toEqual(
      verified.files[0].data
    )
    vi.restoreAllMocks()
    expect(await store.removeManaged(remove(1))).toMatchObject({ completed: true, generation: 2 })
  })
})
