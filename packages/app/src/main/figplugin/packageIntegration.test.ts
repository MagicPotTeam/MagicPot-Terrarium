import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FigPluginManifest } from '@shared/figplugin/manifest'
import {
  figPluginManagedListSchema,
  type FigPluginManagedMutation
} from '@shared/figplugin/management'
import { parseFigPluginPackageText } from '@shared/figplugin/package'
import { FigPluginCenterStore } from './centerStore'
import { verifyNativePluginManifest } from './nativeManifest'
import {
  readAndVerifyFigPluginPackageFile,
  verifyFigPluginPackage,
  type VerifiedFigPluginPackage
} from './packageVerifier'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('fs')
vi.unmock('fs/promises')

const hosts = [
  {
    host: 'figma',
    directory: 'figma',
    nativeId: '123456789012345',
    placeholder: '__FIGMA_ASSIGNED_PLUGIN_ID__',
    files: ['code.js', 'ui.html'],
    kind: 'figma-development',
    displayHost: 'Figma'
  },
  {
    host: 'photoshop',
    directory: 'photoshop-uxp',
    nativeId: 'synthetic.magicpot.fixture',
    placeholder: '__PHOTOSHOP_PLUGIN_ID__',
    files: ['main.js', 'index.html'],
    kind: 'photoshop-uxp-development',
    displayHost: 'Adobe Photoshop'
  }
] as const

type Host = (typeof hosts)[number]
type PayloadFile = { path: string; data: Buffer }
type DeveloperManifest = Omit<
  FigPluginManifest,
  'permissions' | 'limits' | 'provenance' | 'signature' | 'assets'
> & {
  permissions: Pick<FigPluginManifest['permissions'], 'assetTransfer' | 'filesystem' | 'network'>
  provenance: Omit<FigPluginManifest['provenance'], 'artifactSha256'>
  signature: Omit<FigPluginManifest['signature'], 'value'>
  assets: Array<Pick<FigPluginManifest['assets'][number], 'id' | 'path'>>
}
type DeveloperFixture = {
  manifest: DeveloperManifest
  files: PayloadFile[]
  sourceDirectory: string
  templateBytes: Buffer
}
type BuiltPackage = { packageText: string; publicKeyPem: string; keyFingerprint: string }
type BuildPackage = (input: {
  manifest: DeveloperManifest
  files: PayloadFile[]
  privateKeyPem: Buffer
}) => BuiltPackage

const issuedAt = '2026-01-01T00:00:00.000Z'
const builderPath = path.join(process.cwd(), 'scripts', 'build-figplugin-package.mjs')
const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
let buildPackage: BuildPackage
let sandbox: string
let root: string
let store: FigPluginCenterStore
let privateKeyPem: Buffer
let publicKeyPem: string
let keyFingerprint: string

beforeAll(async () => {
  // A computed URL exercises the public ESM entry without adding a declaration or TS loader.
  const module: unknown = await import(pathToFileURL(builderPath).href)
  expect(module).toHaveProperty('buildFigPluginPackage', expect.any(Function))
  buildPackage = (module as { buildFigPluginPackage: BuildPackage }).buildFigPluginPackage
})

beforeEach(async () => {
  sandbox = ''
  sandbox = await fs.mkdtemp(path.join(process.cwd(), '.figplugin-integration-'))
  root = path.join(sandbox, 'center')
  store = new FigPluginCenterStore(root)
  const keys = generateKeyPairSync('ed25519')
  privateKeyPem = Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  keyFingerprint = digest(keys.publicKey.export({ type: 'spki', format: 'der' }))
})

afterEach(async () => {
  privateKeyPem?.fill(0)
  vi.unstubAllGlobals()
  // Never clean a shared prefix or host source tree, only this test's mkdtemp directory.
  if (sandbox) await fs.rm(sandbox, { recursive: true, force: true })
})

async function developerFixture(host: Host): Promise<DeveloperFixture> {
  const sourceDirectory = path.join(process.cwd(), 'packages', 'figplugin-hosts', host.directory)
  const templateBytes = await fs.readFile(path.join(sourceDirectory, 'manifest.template.json'))
  const template = JSON.parse(templateBytes.toString('utf8')) as Record<string, unknown>
  expect(template.id).toBe(host.placeholder)
  // These are synthetic development IDs, not assigned publisher identities. Never edit templates.
  const files: PayloadFile[] = [
    {
      path: 'manifest.json',
      data: Buffer.from(JSON.stringify({ ...template, id: host.nativeId }))
    },
    ...(await Promise.all(
      host.files.map(async (filename): Promise<PayloadFile> => ({
        path: filename,
        data: await fs.readFile(path.join(sourceDirectory, filename))
      }))
    ))
  ]
  return {
    sourceDirectory,
    templateBytes,
    files,
    manifest: {
      schemaVersion: 1,
      id: `synthetic.magicpot.${host.host}.fixture`,
      name: 'MagicPot',
      version: '1.0.0',
      host: host.host,
      entryPath: 'manifest.json',
      capabilities: ['asset-transfer'],
      permissions: { assetTransfer: 'read', filesystem: 'none', network: 'none' },
      provenance: {
        publisherId: 'synthetic.fixture.publisher',
        publisherName: 'Synthetic fixture publisher',
        source: 'user-provided',
        issuedAt
      },
      signature: { algorithm: 'ed25519', keyId: 'fixture-key', signedAt: issuedAt },
      assets: files.map((file, index) => ({ id: `fixture-asset-${index}`, path: file.path }))
    }
  }
}

function build(fixture: DeveloperFixture): BuiltPackage {
  return buildPackage({ manifest: fixture.manifest, files: fixture.files, privateKeyPem })
}

function verifyBuilt(built: BuiltPackage): VerifiedFigPluginPackage {
  const verified = verifyFigPluginPackage(
    parseFigPluginPackageText(built.packageText),
    built.publicKeyPem
  )
  expect(built.publicKeyPem).toBe(publicKeyPem)
  expect(built.keyFingerprint).toBe(keyFingerprint)
  expect(verified.keyFingerprint).toBe(built.keyFingerprint)
  expect(verified.artifactSha256).toBe(verified.package.manifest.provenance.artifactSha256)
  // A failed assertion must not print the runtime private key.
  expect(Buffer.from(built.packageText).includes(privateKeyPem)).toBe(false)
  return verified
}

async function importText(built: BuiltPackage): Promise<FigPluginManagedMutation> {
  const verified = verifyFigPluginPackage(
    parseFigPluginPackageText(built.packageText),
    built.publicKeyPem
  )
  // Match the main service boundary: crypto, then native policy, then materialization.
  verifyNativePluginManifest(verified.package)
  return store.installVerifiedPackage(verified, 0, 'install')
}

function expectContained(parent: string, filename: string): void {
  const relative = path.relative(parent, filename)
  expect(relative).not.toBe('')
  expect(path.isAbsolute(relative)).toBe(false)
  expect(relative.split(path.sep)).not.toContain('..')
}

async function expectInstalled(
  fixture: DeveloperFixture,
  host: Host,
  generation: number
): Promise<string> {
  const entry = await store.getOwnedEntryPath({
    pluginId: fixture.manifest.id,
    expectedGeneration: generation
  })
  expectContained(root, entry)
  expect(path.basename(entry)).toBe('manifest.json')
  expect(await fs.realpath(entry)).toBe(entry)
  const descriptor: unknown = JSON.parse(await fs.readFile(entry, 'utf8'))
  expect(descriptor).toMatchObject({ name: 'MagicPot', id: host.nativeId })
  expect(descriptor).toMatchObject(
    host.host === 'figma'
      ? { main: 'code.js', ui: 'ui.html', networkAccess: { allowedDomains: ['none'] } }
      : { main: 'index.html', version: '1.0.0', host: { app: 'PS' } }
  )
  expect((await fs.readdir(path.dirname(entry))).sort()).toEqual(
    fixture.files.map((file) => file.path).sort()
  )
  for (const file of fixture.files) {
    const filename = path.join(path.dirname(entry), file.path)
    expectContained(root, filename)
    expect(await fs.readFile(filename)).toEqual(file.data)
    const stat = await fs.lstat(filename)
    expect(stat.isFile()).toBe(true)
    expect(stat.isSymbolicLink()).toBe(false)
    expect(stat.nlink).toBe(1)
    if (file.path !== 'manifest.json') {
      expect(await fs.readFile(path.join(fixture.sourceDirectory, file.path))).toEqual(file.data)
    }
  }
  expect(await fs.readFile(path.join(fixture.sourceDirectory, 'manifest.template.json'))).toEqual(
    fixture.templateBytes
  )
  return entry
}

async function readRecord(pluginId: string): Promise<unknown> {
  const bytes = await fs.readFile(path.join(root, `${digest(pluginId)}.json`))
  expect(bytes.includes(privateKeyPem)).toBe(false)
  return JSON.parse(bytes.toString('utf8')) as unknown
}

describe('public FIGPLUGIN builder to real main verifier, native policy and filesystem store', () => {
  it.each(hosts)(
    '$host: installs shipped bytes, reads the copy path, configures references and removes',
    async (host) => {
      const fixture = await developerFixture(host)
      const built = build(fixture)
      const verified = verifyBuilt(built)
      expect(verified.files).toEqual(
        [...fixture.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      )
      expect(verified.package.manifest).toMatchObject({
        id: fixture.manifest.id,
        name: 'MagicPot',
        version: '1.0.0',
        host: host.host,
        provenance: { source: 'user-provided', publisherId: 'synthetic.fixture.publisher' }
      })
      expect(verifyNativePluginManifest(verified.package)).toEqual({
        kind: host.kind,
        entryPath: 'manifest.json',
        displayHost: host.displayHost
      })
      expect(await store.installVerifiedPackage(verified, 0, 'install')).toEqual({
        completed: true,
        generation: 1,
        cleanupPending: false
      })
      const entry = await expectInstalled(fixture, host, 1)
      const list = await store.listManaged()
      expect(figPluginManagedListSchema.parse(list)).toEqual(list)
      expect(list).toMatchObject({
        items: [
          {
            pluginId: fixture.manifest.id,
            materialization: 'verified-package',
            signerFingerprint: built.keyFingerprint,
            artifactSha256: verified.artifactSha256,
            fileCount: 3,
            contentBytes: fixture.files.reduce((sum, file) => sum + file.data.length, 0),
            generation: 1,
            state: 'disabled',
            ready: false,
            configured: false,
            cleanupPending: false,
            settings: {}
          }
        ],
        truncated: false,
        skippedRecords: 0
      })
      for (const hidden of [
        root,
        'entryPath',
        'signature',
        'provenance',
        publicKeyPem,
        'contentBase64'
      ]) {
        expect(JSON.stringify(list)).not.toContain(hidden)
      }
      const settings = {
        analysisProfileId: 'fixture-analysis-profile',
        backgroundRemovalProfileId: 'fixture-background-profile'
      }
      expect(
        await store.configureManaged({
          pluginId: fixture.manifest.id,
          expectedGeneration: 1,
          settings
        })
      ).toEqual({ completed: true, generation: 2, cleanupPending: false })
      expect(await readRecord(fixture.manifest.id)).toMatchObject({
        config: null,
        configRefs: settings
      })
      const unrelated = path.join(sandbox, 'keep.txt')
      await fs.writeFile(unrelated, 'not owned by the store', { flag: 'wx' })
      expect(
        await store.removeManaged({
          pluginId: fixture.manifest.id,
          expectedGeneration: 2,
          idempotencyKey: 'remove'
        })
      ).toEqual({ completed: true, generation: 3, cleanupPending: false })
      await expect(fs.lstat(path.dirname(entry))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fs.readFile(unrelated, 'utf8')).toBe('not owned by the store')
      store = new FigPluginCenterStore(root)
      expect(await store.listManaged()).toEqual({ items: [], truncated: false, skippedRecords: 0 })
      expect(await store.getManagedGeneration(fixture.manifest.id)).toBe(3)
      await expect(
        store.getOwnedEntryPath({
          pluginId: fixture.manifest.id,
          expectedGeneration: 3
        })
      ).rejects.toMatchObject({ code: 'NOT_INSTALLED' })
      expect(await readRecord(fixture.manifest.id)).toMatchObject({
        schemaVersion: 2,
        generation: 3,
        manifest: null,
        removedManifest: null,
        packageRecord: null,
        config: null,
        configRefs: null
      })
    }
  )

  it.each(hosts)(
    '$host: reinstall and configuration obey durable CAS and reject secret input',
    async (host) => {
      const fixture = await developerFixture(host)
      const verified = verifyBuilt(build(fixture))
      verifyNativePluginManifest(verified.package)
      const pluginId = fixture.manifest.id
      const first = await store.installVerifiedPackage(verified, 0, 'first')
      expect(await store.installVerifiedPackage(verified, 0, 'first')).toEqual(first)
      const entry = await expectInstalled(fixture, host, 1)
      expect(await store.installVerifiedPackage(verified, 1, 'reinstall')).toEqual({
        completed: true,
        generation: 2,
        cleanupPending: false
      })
      expect(await expectInstalled(fixture, host, 2)).toBe(entry)
      await expect(
        store.configureManaged({
          pluginId,
          expectedGeneration: 1,
          settings: { analysisProfileId: 'stale-profile' }
        })
      ).rejects.toMatchObject({ code: 'CONFIGURATION_CHANGED' })
      await expect(
        store.getOwnedEntryPath({ pluginId, expectedGeneration: 1 })
      ).rejects.toMatchObject({
        code: 'CONFIGURATION_CHANGED'
      })
      const recordPath = path.join(root, `${digest(pluginId)}.json`)
      const before = await fs.readFile(recordPath)
      const settings = {
        analysisProfileId: 'fixture-profile',
        apiKey: 'fixture-never-store-secret'
      }
      await expect(
        store.configureManaged({ pluginId, expectedGeneration: 2, settings })
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        cause: undefined
      })
      expect(await fs.readFile(recordPath)).toEqual(before)
      expect(await store.getManagedGeneration(pluginId)).toBe(2)
      await store.configureManaged({
        pluginId,
        expectedGeneration: 2,
        settings: { analysisProfileId: 'fixture-profile' }
      })
      store = new FigPluginCenterStore(root)
      expect((await store.listManaged()).items[0]).toMatchObject({
        generation: 3,
        configured: true,
        settings: { analysisProfileId: 'fixture-profile' },
        ready: false
      })
      expect(await readRecord(pluginId)).toMatchObject({
        config: null,
        configRefs: { analysisProfileId: 'fixture-profile' }
      })
      expect((await fs.readFile(recordPath, 'utf8')).includes(settings.apiKey)).toBe(false)
      await store.removeManaged({ pluginId, expectedGeneration: 3, idempotencyKey: 'remove' })
      expect(await store.installVerifiedPackage(verified, 0, 'first')).toEqual(first)
      expect((await store.listManaged()).items).toEqual([])
      expect(await store.getManagedGeneration(pluginId)).toBe(4)
      expect(await store.installVerifiedPackage(verified, 4, 'fresh-install')).toEqual({
        completed: true,
        generation: 5,
        cleanupPending: false
      })
      await expectInstalled(fixture, host, 5)
      expect((await store.listManaged()).items[0]).toMatchObject({
        configured: false,
        settings: {}
      })
    }
  )

  it.each(hosts)(
    '$host: the real Node CLI emits the same package accepted by selected-file and native verification',
    async (host) => {
      const fixture = await developerFixture(host)
      const expected = build(fixture)
      const filesRoot = path.join(sandbox, 'input')
      const outputs = path.join(sandbox, 'output')
      await fs.mkdir(filesRoot)
      await fs.mkdir(outputs)
      for (const file of fixture.files) {
        await fs.writeFile(path.join(filesRoot, file.path), file.data, { flag: 'wx' })
      }
      const manifestPath = path.join(sandbox, 'developer-manifest.json')
      const keyPath = path.join(sandbox, 'runtime-private.pem')
      const selectionPath = path.join(outputs, 'fixture.figplugin')
      const publicPath = path.join(outputs, 'fixture-public.pem')
      for (const filename of [manifestPath, keyPath, selectionPath, publicPath]) {
        expectContained(sandbox, filename)
      }
      await fs.writeFile(manifestPath, JSON.stringify(fixture.manifest), { flag: 'wx' })
      try {
        // Only this subprocess fixture needs a private key file; never put it in the asset tree.
        await fs.writeFile(keyPath, privateKeyPem, { flag: 'wx', mode: 0o600 })
        const child = spawnSync(
          process.execPath,
          [
            builderPath,
            '--manifest',
            manifestPath,
            '--files-root',
            filesRoot,
            '--private-key',
            keyPath,
            '--output',
            selectionPath,
            '--public-key-output',
            publicPath
          ],
          {
            cwd: sandbox,
            encoding: 'utf8',
            windowsHide: true,
            timeout: 15_000,
            maxBuffer: 64 * 1024
          }
        )
        expect(child.error).toBeUndefined()
        expect(child.signal).toBeNull()
        expect(child.status).toBe(0)
        expect(child.stdout).toBe('')
        expect(child.stderr).toBe('')
      } finally {
        await fs.rm(keyPath, { force: true })
      }
      await expect(fs.lstat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fs.readFile(selectionPath, 'utf8')).toBe(expected.packageText)
      const selectedPublicKey = await fs.readFile(publicPath, 'utf8')
      expect(selectedPublicKey).toBe(expected.publicKeyPem)
      // selectionPath stands in for the approved native chooser result, not a renderer path.
      const verified = await readAndVerifyFigPluginPackageFile(selectionPath, selectedPublicKey)
      expect(verified.keyFingerprint).toBe(expected.keyFingerprint)
      expect(verified.keyFingerprint).toBe(keyFingerprint)
      expect(verifyNativePluginManifest(verified.package)).toEqual({
        kind: host.kind,
        entryPath: 'manifest.json',
        displayHost: host.displayHost
      })
      await store.installVerifiedPackage(verified, 0, 'cli-install')
      await expectInstalled(fixture, host, 1)
      expect((await fs.readdir(outputs)).sort()).toEqual([
        'fixture-public.pem',
        'fixture.figplugin'
      ])
      expect(
        (
          await store.removeManaged({
            pluginId: fixture.manifest.id,
            expectedGeneration: 1,
            idempotencyKey: 'cli-remove'
          })
        ).cleanupPending
      ).toBe(false)
    },
    30_000
  )

  it.each(hosts)(
    '$host: valid crypto cannot authorize a native permission escalation',
    async (host) => {
      const fixture = await developerFixture(host)
      const descriptor = JSON.parse(fixture.files[0].data.toString('utf8')) as Record<
        string,
        unknown
      >
      fixture.files[0].data = Buffer.from(
        JSON.stringify({
          ...descriptor,
          ...(host.host === 'figma'
            ? { networkAccess: { allowedDomains: ['https://example.invalid'] } }
            : { requiredPermissions: { localFileSystem: 'fullAccess' } })
        })
      )
      const built = build(fixture)
      const verified = verifyBuilt(built)
      expect(() => verifyNativePluginManifest(verified.package)).toThrow(
        expect.objectContaining({ code: 'INVALID_PACKAGE' })
      )
      await expect(importText(built)).rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
      await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fs.readdir(sandbox)).toEqual([])
    }
  )

  it('does not turn the unresolved Figma assigned-ID template into an importable manifest', async () => {
    const fixture = await developerFixture(hosts[0])
    fixture.files[0].data = fixture.templateBytes
    const built = build(fixture)
    verifyBuilt(built)
    await expect(importText(built)).rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(fixture.sourceDirectory, 'manifest.template.json'))).toEqual(
      fixture.templateBytes
    )
  })

  it.each([
    { tamper: 'signed metadata', code: 'INVALID_SIGNATURE' },
    { tamper: 'file bytes', code: 'INTEGRITY_FAILED' }
  ])('rejects changed $tamper before any install output exists', async ({ tamper, code }) => {
    const built = build(await developerFixture(hosts[0]))
    const pkg = parseFigPluginPackageText(built.packageText)
    if (tamper === 'signed metadata') {
      pkg.manifest.provenance.publisherName = 'Altered synthetic publisher'
    } else {
      const file = pkg.files.find((candidate) => candidate.path === 'code.js')!
      const data = Buffer.from(file.contentBase64, 'base64')
      data[0] ^= 1
      file.contentBase64 = data.toString('base64')
    }
    const selectionPath = path.join(sandbox, 'tampered.figplugin')
    await fs.writeFile(selectionPath, JSON.stringify(pkg), { flag: 'wx' })
    const importSelection = async (): Promise<FigPluginManagedMutation> => {
      const verified = await readAndVerifyFigPluginPackageFile(selectionPath, built.publicKeyPem)
      verifyNativePluginManifest(verified.package)
      return store.installVerifiedPackage(verified, 0, 'tampered')
    }
    await expect(importSelection()).rejects.toMatchObject({ code })
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(sandbox)).toEqual(['tampered.figplugin'])
  })

  it.each(hosts)(
    '$host: modified content survives removal with a durable cleanup-pending tombstone',
    async (host) => {
      const fixture = await developerFixture(host)
      const verified = verifyBuilt(build(fixture))
      verifyNativePluginManifest(verified.package)
      await store.installVerifiedPackage(verified, 0, 'install')
      const entry = await expectInstalled(fixture, host, 1)
      const pluginId = fixture.manifest.id
      await store.configureManaged({
        pluginId,
        expectedGeneration: 1,
        settings: { analysisProfileId: 'fixture-profile' }
      })
      // Change the last inventory item so preflight must protect earlier, still-valid files too.
      const changed = verified.files.at(-1)!
      const changedPath = path.join(path.dirname(entry), changed.path)
      const modified = Buffer.from(changed.data)
      modified[0] ^= 1
      await fs.writeFile(changedPath, modified)
      await expect(
        store.getOwnedEntryPath({ pluginId, expectedGeneration: 2 })
      ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
      const removal = { pluginId, expectedGeneration: 2, idempotencyKey: 'remove-modified' }
      expect(await store.removeManaged(removal)).toEqual({
        completed: true,
        generation: 3,
        cleanupPending: true
      })
      store = new FigPluginCenterStore(root)
      const list = await store.listManaged()
      expect(figPluginManagedListSchema.parse(list)).toEqual(list)
      expect(list).toMatchObject({
        items: [
          {
            pluginId,
            generation: 3,
            materialization: 'cleanup-pending',
            state: 'uninstalled',
            cleanupPending: true,
            configured: false,
            ready: false,
            settings: {}
          }
        ],
        truncated: false,
        skippedRecords: 0
      })
      await expect(
        store.getOwnedEntryPath({ pluginId, expectedGeneration: 3 })
      ).rejects.toMatchObject({ code: 'NOT_INSTALLED' })
      expect(await store.removeManaged(removal)).toEqual({
        completed: true,
        generation: 3,
        cleanupPending: true
      })
      for (const file of verified.files) {
        expect(await fs.readFile(path.join(path.dirname(entry), file.path))).toEqual(
          file.path === changed.path ? modified : file.data
        )
      }
      expect(await readRecord(pluginId)).toMatchObject({
        manifest: null,
        config: null,
        configRefs: null,
        generation: 3
      })
      await fs.writeFile(changedPath, changed.data)
      expect(await store.removeManaged(removal)).toEqual({
        completed: true,
        generation: 3,
        cleanupPending: false
      })
      expect((await store.listManaged()).items).toEqual([])
      await expect(fs.lstat(path.dirname(entry))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('treats even a side-effecting JavaScript sentinel as opaque bytes, never desktop code', async () => {
    vi.stubGlobal('__figpluginIntegrationExecuted', false)
    const fixture = await developerFixture(hosts[0])
    const code = fixture.files.find((file) => file.path === 'code.js')!
    code.data = Buffer.concat([
      Buffer.from(
        'globalThis.__figpluginIntegrationExecuted = true; throw new Error("must not execute");\n'
      ),
      code.data
    ])
    const built = build(fixture)
    expect(await importText(built)).toMatchObject({ completed: true, generation: 1 })
    const pluginId = fixture.manifest.id
    const entry = await store.getOwnedEntryPath({ pluginId, expectedGeneration: 1 })
    expect(await fs.readFile(path.join(path.dirname(entry), 'code.js'))).toEqual(code.data)
    await store.configureManaged({ pluginId, expectedGeneration: 1, settings: {} })
    await store.removeManaged({ pluginId, expectedGeneration: 2, idempotencyKey: 'remove' })
    expect(Reflect.get(globalThis, '__figpluginIntegrationExecuted')).toBe(false)
  })
})
