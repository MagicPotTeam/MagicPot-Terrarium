import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FigPluginManifestSchema,
  canonicalFigPluginJson,
  measureFigPluginConfigBytes
} from '@shared/figplugin/manifest'
import { FIGPLUGIN_MANAGEMENT_ERRORS } from '@shared/figplugin/management'
import {
  FIGPLUGIN_PACKAGE_FORMAT,
  FigPluginPackageSchema,
  canonicalFigPluginPackageIndex,
  getFigPluginPackageSigningPayload
} from '@shared/figplugin/package'
import { verifyFigPluginPackage, type VerifiedFigPluginPackage } from './packageVerifier'
import { FigPluginCenterStore, type FigPluginRuntimeDescriptor } from './centerStore'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const date = '2026-01-01T00:00:00.000Z'
const pluginId = 'runtime.figplugin'
const bridgeOrigin = 'http://127.0.0.1:43127'
const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const fixture = (schemaVersion = 2, version = '1.0.0'): VerifiedFigPluginPackage => {
  const contents = [
    {
      path: 'plugin/manifest.json',
      data: Buffer.from(
        JSON.stringify({
          name: 'Runtime fixture',
          id: '123456789',
          api: '1.0.0',
          editorType: ['figma'],
          main: 'main.js',
          documentAccess: 'dynamic-page',
          networkAccess: {
            allowedDomains: ['none'],
            ...(schemaVersion === 2 ? { devAllowedDomains: [bridgeOrigin] } : {})
          }
        })
      )
    },
    {
      path: 'plugin/main.js',
      data: Buffer.from('globalThis.__figpluginRuntimeFixtureExecuted = true;')
    },
    { path: 'assets/fixture.txt', data: Buffer.from('opaque fixture asset') }
  ]
  const files = contents.map(({ path, data }) => ({
    path,
    bytes: data.length,
    sha256: sha(data),
    contentBase64: data.toString('base64')
  }))
  const manifest = FigPluginManifestSchema.parse({
    schemaVersion,
    id: pluginId,
    name: ' Runtime fixture ',
    version,
    host: 'figma',
    entryPath: files[0].path,
    capabilities: ['dialogue', 'asset-transfer'],
    permissions: {
      dialogue: 'prompt',
      assetTransfer: 'read',
      network: schemaVersion === 2 ? 'desktop-bridge' : 'none'
    },
    ...(schemaVersion === 2 ? { bridge: { protocol: 1, origin: bridgeOrigin } } : {}),
    limits: { maxConfigBytes: 4096 },
    provenance: {
      publisherId: 'fixture-publisher',
      publisherName: 'Fixture Publisher',
      source: 'user-provided',
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
    }))
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
let subscriptions: Array<() => void>
const target = (expectedGeneration: number) => ({ pluginId, expectedGeneration })
const recordPath = (): string => path.join(root, `${sha(pluginId)}.json`)
const readRecord = async () => JSON.parse(await fs.readFile(recordPath(), 'utf8'))
const directory = (verified: VerifiedFigPluginPackage): string =>
  path.join(
    root,
    'packages',
    sha(pluginId),
    sha(canonicalFigPluginJson([verified.package.manifest, verified.artifactSha256]))
  )
const rejection = (code: keyof typeof FIGPLUGIN_MANAGEMENT_ERRORS) => ({
  code,
  message: FIGPLUGIN_MANAGEMENT_ERRORS[code],
  cause: undefined
})
const subscribe = (listener: (id: string) => void, source = store): (() => void) => {
  const unsubscribe = source.onRuntimeInvalidated(listener)
  subscriptions.push(unsubscribe)
  return unsubscribe
}
const installConfigured = async (verified = fixture()): Promise<VerifiedFigPluginPackage> => {
  await store.installVerifiedPackage(verified, 0, 'install')
  await store.configureManaged({
    ...target(1),
    settings: { analysisProfileId: 'analysis-profile', backgroundRemovalProfileId: 'other-profile' }
  })
  return verified
}
const seedMetadata = async (
  verified: VerifiedFigPluginPackage,
  config: Record<string, unknown> | null = null,
  configRefs: Record<string, unknown> | null = null
): Promise<void> => {
  await fs.mkdir(root)
  await fs.writeFile(
    recordPath(),
    JSON.stringify({
      schemaVersion: 1,
      pluginId,
      manifest: verified.package.manifest,
      config,
      configRefs,
      receipts: []
    })
  )
}
const legacy = (
  kind: 'install' | 'configure' | 'uninstall',
  manifest = fixture(1).package.manifest,
  config: Record<string, unknown> = {}
) => ({
  schemaVersion: 1,
  kind,
  requestId: `${kind}-request`,
  idempotencyKey: `${kind}-legacy`,
  requestedAt: date,
  ...(kind === 'install' ? { manifest } : { pluginId, host: 'figma' }),
  consent: { granted: true, permissions: [kind], grantedAt: date },
  ...(kind === 'configure' ? { config, configBytes: measureFigPluginConfigBytes(config) } : {})
})
const statusRequest = () => ({
  schemaVersion: 1,
  kind: 'status',
  requestId: 'status-request',
  idempotencyKey: 'status-read',
  requestedAt: date,
  pluginId,
  host: 'figma'
})
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(async () => {
  parent = await fs.mkdtemp(path.join(process.cwd(), '.figplugin-runtime-binding-test-'))
  root = path.join(parent, 'center')
  store = new FigPluginCenterStore(() => root)
  subscriptions = []
})
afterEach(async () => {
  for (const unsubscribe of subscriptions) unsubscribe()
  vi.restoreAllMocks()
  await fs.rm(parent, { recursive: true, force: true })
})

describe('main-only FIGPLUGIN runtime descriptors', () => {
  it('returns only the normalized verified identity, references and limits without writing or executing', async () => {
    const verified = fixture()
    await seedMetadata(verified, {
      apiKey: 'legacy-api-secret',
      analysisProfileId: 'legacy-profile'
    })
    await installConfigured(verified)
    const before = await fs.readFile(recordPath(), 'utf8')
    const listener = vi.fn()
    subscribe(listener)
    const descriptor: FigPluginRuntimeDescriptor = await store.getRuntimeDescriptor(target(2))
    expect(descriptor).toEqual({
      pluginId,
      host: 'figma',
      generation: 2,
      artifactSha256: verified.artifactSha256,
      signerFingerprint: sha(keys.publicKey.export({ type: 'spki', format: 'der' })),
      manifestSha256: sha(canonicalFigPluginJson(verified.package.manifest)),
      bridgeOrigin,
      profileId: 'analysis-profile',
      limits: verified.package.manifest.limits
    })
    const list = await store.listManaged()
    expect(list.items[0]).toMatchObject({
      bridgeOrigin,
      ready: false,
      state: 'disabled',
      generation: 2
    })
    for (const secret of [
      root,
      'entryPath',
      'contentBase64',
      'signature',
      'provenance',
      'config',
      'other-profile',
      'legacy-profile',
      'legacy-api-secret',
      publicKey,
      keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      verified.package.manifest.signature.value,
      'opaque fixture asset'
    ])
      expect(JSON.stringify(descriptor)).not.toContain(secret)
    expect(JSON.stringify(list)).not.toContain('legacy-api-secret')
    expect(globalThis).not.toHaveProperty('__figpluginRuntimeFixtureExecuted')
    descriptor.limits.maxConcurrentCalls = 8
    expect((await store.getRuntimeDescriptor(target(2))).limits).toEqual(
      verified.package.manifest.limits
    )
    expect(await fs.readFile(recordPath(), 'utf8')).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects a missing installation with a redacted management error', async () => {
    await expect(store.getRuntimeDescriptor(target(0))).rejects.toMatchObject(
      rejection('NOT_INSTALLED')
    )
  })

  it('never grants runtime authority or advertises an origin for metadata-only v2 records', async () => {
    await seedMetadata(fixture(), null, { analysisProfileId: 'analysis-profile' })
    await expect(store.getRuntimeDescriptor(target(0))).rejects.toMatchObject(
      rejection('NOT_INSTALLED')
    )
    expect((await store.listManaged()).items[0]).not.toHaveProperty('bridgeOrigin')
  })

  it('rejects an actual installed v1 package even with managed analysis references', async () => {
    await installConfigured(fixture(1))
    await expect(store.getRuntimeDescriptor(target(2))).rejects.toMatchObject(
      rejection('CONFIGURATION_CHANGED')
    )
    expect((await store.listManaged()).items[0]).not.toHaveProperty('bridgeOrigin')
  })

  it.each([undefined, {}, { backgroundRemovalProfileId: 'background-only' }])(
    'requires an explicit managed analysis profile, not %j',
    async (settings) => {
      await store.installVerifiedPackage(fixture(), 0, 'install')
      if (settings) await store.configureManaged({ ...target(1), settings })
      await expect(store.getRuntimeDescriptor(target(settings ? 2 : 1))).rejects.toMatchObject(
        rejection('CONFIGURATION_CHANGED')
      )
    }
  )

  it('never upgrades an opaque legacy analysisProfileId into a managed runtime reference', async () => {
    const verified = fixture()
    await seedMetadata(verified, { analysisProfileId: 'legacy-secret', apiKey: 'private' })
    await store.installVerifiedPackage(verified, 0, 'install')
    await expect(store.getRuntimeDescriptor(target(1))).rejects.toMatchObject(
      rejection('CONFIGURATION_CHANGED')
    )
    expect((await store.listManaged()).items[0].settings).toEqual({})
  })

  it('rejects empty profile references and malformed targets at the shared boundary', async () => {
    await installConfigured()
    const listener = vi.fn()
    subscribe(listener)
    await expect(
      store.configureManaged({
        ...target(2),
        settings: { analysisProfileId: '   ' }
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', cause: undefined })
    await expect(
      store.getRuntimeDescriptor({ ...target(2), profileId: 'injected' } as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', cause: undefined })
    expect(listener).not.toHaveBeenCalled()
  })

  it.each(['plugin/manifest.json', 'plugin/main.js', 'assets/fixture.txt'])(
    'rechecks installed bytes including %s on every descriptor read',
    async (relative) => {
      const verified = await installConfigured()
      await store.getRuntimeDescriptor(target(2))
      const original = verified.files.find((file) => file.path === relative)!
      await fs.writeFile(
        path.join(directory(verified), relative),
        Buffer.alloc(original.data.length, 120)
      )
      await expect(store.getRuntimeDescriptor(target(2))).rejects.toMatchObject(
        rejection('INTEGRITY_FAILED')
      )
    }
  )

  it.each(['missing', 'unexpected', 'hardlink'])(
    'rejects %s installed files rather than returning a cached descriptor',
    async (change) => {
      const verified = await installConfigured()
      const entry = path.join(directory(verified), 'plugin/main.js')
      if (change === 'missing') await fs.unlink(entry)
      else if (change === 'unexpected')
        await fs.writeFile(path.join(directory(verified), 'unknown.txt'), 'unknown')
      else await fs.link(entry, path.join(parent, 'external-link.js'))
      await expect(store.getRuntimeDescriptor(target(2))).rejects.toMatchObject(
        rejection('INTEGRITY_FAILED')
      )
    }
  )

  it('rejects a stored manifest that no longer matches the installed inventory identity', async () => {
    await installConfigured()
    const record = await readRecord()
    record.manifest.bridge.origin = 'http://127.0.0.1:43128'
    await fs.writeFile(recordPath(), JSON.stringify(record))
    await expect(store.getRuntimeDescriptor(target(2))).rejects.toMatchObject(rejection('IO_ERROR'))
  })

  it('serializes descriptors with cross-instance mutations and snapshots the CAS request', async () => {
    await installConfigured()
    const other = new FigPluginCenterStore(root)
    const request = target(3)
    const mutation = other.configureManaged({
      ...target(2),
      settings: { analysisProfileId: 'next-profile' }
    })
    const descriptor = store.getRuntimeDescriptor(request)
    request.expectedGeneration = 0
    expect(await mutation).toMatchObject({ generation: 3 })
    expect(await descriptor).toMatchObject({ generation: 3, profileId: 'next-profile' })
    await expect(other.getRuntimeDescriptor(target(2))).rejects.toMatchObject(
      rejection('CONFIGURATION_CHANGED')
    )
    await other.removeManaged({ ...target(3), idempotencyKey: 'remove' })
    await expect(store.getRuntimeDescriptor(target(4))).rejects.toMatchObject(
      rejection('NOT_INSTALLED')
    )
  })

  it.each([0, NaN, Infinity])(
    'rejects an expired or invalid deadline %s before touching storage',
    async (deadline) => {
      await expect(store.getRuntimeDescriptor(target(0), deadline)).rejects.toMatchObject(
        rejection('TIMEOUT')
      )
      await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('counts root-lock queue time against the default ten-second descriptor deadline', async () => {
    await installConfigured()
    const entered = gate()
    const release = gate()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (args[1].toString() === recordPath()) {
        entered.resolve()
        await release.promise
      }
      return rename(...args)
    })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const mutation = store.configureManaged({
      ...target(2),
      settings: { analysisProfileId: 'next' }
    })
    try {
      await entered.promise
      const descriptor = new FigPluginCenterStore(root).getRuntimeDescriptor(target(3))
      const rejected = expect(descriptor).rejects.toMatchObject(rejection('TIMEOUT'))
      clock.mockReturnValue(now + 10_001)
      release.resolve()
      await mutation
      await rejected
    } finally {
      release.resolve()
      await mutation
    }
  })
})

describe('root-scoped pre-commit runtime invalidation', () => {
  it('emits once per new generation, before commit/deletion, but not for cleanup writes', async () => {
    const verified = fixture()
    const listener = vi.fn()
    const postCommitReads: Array<Promise<number>> = []
    subscribe((id) => {
      listener(id)
      postCommitReads.push(new FigPluginCenterStore(root).getManagedGeneration(id))
    })
    const commits: Array<{ invalidations: number; previousGeneration: number }> = []
    const deletions: number[] = []
    const rename = fs.rename.bind(fs)
    const unlink = fs.unlink.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (args[1].toString() === recordPath()) {
        let previousGeneration = 0
        try {
          previousGeneration = (await readRecord()).generation
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        commits.push({ invalidations: listener.mock.calls.length, previousGeneration })
      }
      return rename(...args)
    })
    vi.spyOn(fs, 'unlink').mockImplementation(async (...args) => {
      if (args[0].toString().startsWith(path.join(root, 'packages') + path.sep))
        deletions.push(listener.mock.calls.length)
      return unlink(...args)
    })
    await store.installVerifiedPackage(verified, 0, 'install')
    await store.configureManaged({ ...target(1), settings: { analysisProfileId: 'profile' } })
    await store.installVerifiedPackage(fixture(2, '2.0.0'), 2, 'upgrade')
    await store.removeManaged({ ...target(3), idempotencyKey: 'remove' })
    expect(listener.mock.calls).toEqual([[pluginId], [pluginId], [pluginId], [pluginId]])
    expect(commits).toEqual([
      { invalidations: 1, previousGeneration: 0 },
      { invalidations: 2, previousGeneration: 1 },
      { invalidations: 3, previousGeneration: 2 },
      { invalidations: 3, previousGeneration: 3 },
      { invalidations: 4, previousGeneration: 3 },
      { invalidations: 4, previousGeneration: 4 }
    ])
    expect(deletions).toEqual([3, 3, 3, 4, 4, 4])
    expect(await Promise.all(postCommitReads)).toEqual([1, 2, 3, 4])
  })

  it('shares a normalized root bus and lock across instances while isolating other roots', async () => {
    await store.installVerifiedPackage(fixture(), 0, 'install')
    const other = new FigPluginCenterStore(
      process.platform === 'win32' ? root.toUpperCase() : path.join(root, '.')
    )
    const local = vi.fn()
    const remote = vi.fn()
    const unrelated = vi.fn()
    subscribe(local)
    subscribe(remote, other)
    subscribe(unrelated, new FigPluginCenterStore(path.join(parent, 'other')))
    const outcomes = await Promise.allSettled([
      store.configureManaged({ ...target(1), settings: { analysisProfileId: 'one' } }),
      other.configureManaged({ ...target(1), settings: { analysisProfileId: 'two' } })
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: rejection('CONFIGURATION_CHANGED')
    })
    expect(local.mock.calls).toEqual([[pluginId]])
    expect(remote.mock.calls).toEqual([[pluginId]])
    expect(unrelated).not.toHaveBeenCalled()
    expect((await other.getRuntimeDescriptor(target(2))).profileId).toBe('one')
  })

  it('resolves a lazy root only on registration and supports independent, idempotent disposal', async () => {
    let ready = false
    const getRoot = vi.fn(() => {
      if (!ready) throw new Error('app not ready')
      return root
    })
    const observer = new FigPluginCenterStore(getRoot)
    expect(getRoot).not.toHaveBeenCalled()
    ready = true
    const listener = vi.fn()
    const first = subscribe(listener, observer)
    const second = subscribe(listener, observer)
    first()
    await store.installVerifiedPackage(fixture(), 0, 'install')
    expect(listener).toHaveBeenCalledTimes(1)
    second()
    const replacement = subscribe(listener, observer)
    second()
    await store.configureManaged({ ...target(1), settings: {} })
    expect(listener).toHaveBeenCalledTimes(2)
    replacement()
    first()
    await store.configureManaged({ ...target(2), settings: {} })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getRoot).toHaveBeenCalledTimes(3)
  })

  it('isolates a throwing subscriber without losing other revocations or the commit', async () => {
    subscribe(() => {
      throw new Error('consumer failed')
    })
    const listener = vi.fn()
    subscribe(listener, new FigPluginCenterStore(root))
    expect(await store.installVerifiedPackage(fixture(), 0, 'install')).toMatchObject({
      generation: 1
    })
    expect(await store.getManagedGeneration(pluginId)).toBe(1)
    expect(listener.mock.calls).toEqual([[pluginId]])
  })

  it('does not revoke a newer runtime on historical managed replays or read operations', async () => {
    const verified = await installConfigured()
    const remove = { ...target(2), idempotencyKey: 'remove' }
    await store.removeManaged(remove)
    await store.installVerifiedPackage(verified, 3, 'reinstall')
    await store.configureManaged({ ...target(4), settings: { analysisProfileId: 'current' } })
    const listener = vi.fn()
    subscribe(listener)
    expect(await store.installVerifiedPackage(verified, 0, 'install', 0)).toMatchObject({
      generation: 1
    })
    expect(await store.removeManaged(remove, 0)).toMatchObject({ generation: 3 })
    await store.listManaged()
    await store.getOwnedEntryPath(target(5))
    expect(await store.execute(statusRequest())).toMatchObject({
      ok: true,
      status: { ready: false }
    })
    expect(await store.getRuntimeDescriptor(target(5))).toMatchObject({
      generation: 5,
      profileId: 'current'
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('omits tombstoned origins and does not emit again when a removal replay finishes cleanup', async () => {
    const verified = await installConfigured()
    const unknown = path.join(directory(verified), 'unknown.txt')
    await fs.writeFile(unknown, 'user file')
    const listener = vi.fn()
    subscribe(listener)
    const remove = { ...target(2), idempotencyKey: 'remove' }
    expect(await store.removeManaged(remove)).toMatchObject({ generation: 3, cleanupPending: true })
    const item = (await store.listManaged()).items[0]
    expect(item).toMatchObject({ state: 'uninstalled', materialization: 'cleanup-pending' })
    expect(item).not.toHaveProperty('bridgeOrigin')
    await expect(store.getRuntimeDescriptor(target(3))).rejects.toMatchObject(
      rejection('NOT_INSTALLED')
    )
    await fs.unlink(unknown)
    expect(await store.removeManaged(remove)).toMatchObject({
      generation: 3,
      cleanupPending: false
    })
    expect(listener.mock.calls).toEqual([[pluginId]])
  })

  it('revokes before a failed pointer commit without faking a new authoritative generation', async () => {
    await installConfigured()
    const before = await fs.readFile(recordPath(), 'utf8')
    const listener = vi.fn()
    subscribe(listener)
    const rename = fs.rename.bind(fs)
    const signalsAtFailure: number[] = []
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (args[1].toString() === recordPath()) {
        signalsAtFailure.push(listener.mock.calls.length)
        throw new Error('simulated pointer failure with private path')
      }
      return rename(...args)
    })
    await expect(
      store.configureManaged({ ...target(2), settings: { analysisProfileId: 'new' } })
    ).rejects.toMatchObject(rejection('IO_ERROR'))
    expect(signalsAtFailure).toEqual([1])
    expect(await fs.readFile(recordPath(), 'utf8')).toBe(before)
    expect(await store.getRuntimeDescriptor(target(2))).toMatchObject({
      generation: 2,
      profileId: 'analysis-profile'
    })
  })

  it('invalidates legacy install/configure/uninstall generations, never status or old replay', async () => {
    const listener = vi.fn()
    subscribe(listener, new FigPluginCenterStore(root))
    const manifest = fixture(1).package.manifest
    const operations = [
      legacy('install', manifest),
      legacy('configure', manifest),
      legacy('uninstall', manifest)
    ]
    for (const operation of operations) {
      expect(await store.execute(operation)).toMatchObject({ ok: true })
      expect(await store.execute(statusRequest())).toMatchObject({ ok: true })
    }
    expect(listener.mock.calls).toEqual([[pluginId], [pluginId], [pluginId]])
    for (const operation of operations)
      expect(await store.execute({ ...operation, requestId: 'replay-request' })).toMatchObject({
        ok: true
      })
    expect(listener).toHaveBeenCalledTimes(3)
    expect(await store.getManagedGeneration(pluginId)).toBe(3)
  })
})
