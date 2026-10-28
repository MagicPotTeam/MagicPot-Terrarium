import { createHash, generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  BrowserWindow,
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue
} from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import {
  FIGPLUGIN_MANAGEMENT_ERRORS,
  FigPluginManagementError,
  type FigPluginManagedConfigureRequest,
  type FigPluginManagedList,
  type FigPluginManagedMutation,
  type FigPluginManagedRemoveRequest,
  type FigPluginManagedTarget,
  type FigPluginManagementErrorCode,
  type FigPluginPackagePreview
} from '@shared/figplugin/management'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import {
  canonicalFigPluginPackageIndex,
  FIGPLUGIN_PACKAGE_FORMAT,
  FigPluginPackageSchema
} from '@shared/figplugin/package'
import type { VerifiedFigPluginPackage } from '../figplugin/packageVerifier'
import {
  authorizeMagicAgentApprovalRenderer,
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding,
  unregisterMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { FigPluginCenterSvcImpl } from './svcFigPluginCenterImpl'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('fs/promises')
vi.unmock('node:fs/promises')

const native = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>(),
  showOpenDialog:
    vi.fn<(parent: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>>(),
  showMessageBox:
    vi.fn<(parent: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>(),
  writeText: vi.fn<(text: string) => void>(),
  showItemInFolder: vi.fn<(filename: string) => void>(),
  openPath: vi.fn(),
  openExternal: vi.fn(),
  verify: vi.fn<(filename: string, publicKey: string) => Promise<VerifiedFigPluginPackage>>()
}))
vi.mock('electron', () => ({
  app: { getPath: native.getPath },
  dialog: { showOpenDialog: native.showOpenDialog, showMessageBox: native.showMessageBox },
  clipboard: { writeText: native.writeText },
  shell: {
    showItemInFolder: native.showItemInFolder,
    openPath: native.openPath,
    openExternal: native.openExternal
  }
}))
vi.mock('../figplugin/packageVerifier', () => ({
  readAndVerifyFigPluginPackageFile: native.verify
}))

const TRUSTED_URL = 'file:///app/index.html#/workshop/plugins'
const TTL_MS = 5 * 60_000
const GENERATION = 3
const RAW_CONTENT = 'globalThis.figPluginPackageServiceTestExecuted = true; // synthetic-package'
const NATIVE_DESCRIPTOR = JSON.stringify({
  name: 'Synthetic FIGPLUGIN',
  id: '123456789012345',
  api: '1.0.0',
  editorType: ['figma'],
  documentAccess: 'dynamic-page',
  main: 'entry.js',
  networkAccess: { allowedDomains: ['none'] }
})
const TOTAL_CONTENT_BYTES = Buffer.byteLength(RAW_CONTENT) + Buffer.byteLength(NATIVE_DESCRIPTOR)
const RECEIPT = 'a'.repeat(48)
const target: FigPluginManagedTarget = {
  pluginId: 'synthetic.figplugin',
  expectedGeneration: GENERATION
}
const configuration: FigPluginManagedConfigureRequest = {
  ...target,
  settings: { analysisProfileId: 'synthetic-analysis', backgroundRemovalProfileId: 'synthetic-bg' }
}
const removal: FigPluginManagedRemoveRequest = { ...target, idempotencyKey: 'remove-synthetic-1' }
const mutation: FigPluginManagedMutation = {
  completed: true,
  generation: GENERATION + 1,
  cleanupPending: false
}
type ManagementMethod = Exclude<keyof FigPluginCenterSvcImpl, 'execute'>

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function freezeMetadata(value: unknown): void {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return
  for (const child of Object.values(value)) freezeMetadata(child)
  Object.freeze(value)
}

function packageFixture(): { verified: VerifiedFigPluginPackage; publicKeyPem: string } {
  const publicKey = generateKeyPairSync('ed25519').publicKey
  const entryPath = 'plugin/manifest.json'
  const contents = [
    { path: entryPath, data: Buffer.from(NATIVE_DESCRIPTOR) },
    { path: 'plugin/entry.js', data: Buffer.from(RAW_CONTENT) }
  ]
  const files = contents.map(({ path, data }) => ({
    path,
    bytes: data.length,
    sha256: digest(data),
    contentBase64: data.toString('base64')
  }))
  // The verifier is mocked at its boundary; this is schema-valid metadata, not a trusted signature.
  const pkg = FigPluginPackageSchema.parse({
    format: FIGPLUGIN_PACKAGE_FORMAT,
    manifest: {
      schemaVersion: 1,
      id: target.pluginId,
      name: 'Synthetic FIGPLUGIN',
      version: '1.2.3',
      host: 'figma',
      entryPath,
      capabilities: ['dialogue'],
      permissions: { dialogue: 'prompt' },
      limits: {},
      provenance: {
        publisherId: 'synthetic-publisher',
        publisherName: 'Synthetic Publisher',
        source: 'user-provided',
        sourceUrl: 'https://figplugin.invalid/never-fetch',
        artifactSha256: '0'.repeat(64),
        issuedAt: '2026-01-01T00:00:00.000Z'
      },
      signature: {
        algorithm: 'ed25519',
        keyId: 'synthetic-key',
        value: '0'.repeat(128),
        signedAt: '2026-01-01T00:00:00.000Z'
      },
      assets: files.map((file, index) => ({
        id: `entry-${index}`,
        path: file.path,
        sizeBytes: file.bytes,
        sha256: file.sha256
      }))
    },
    files
  })
  pkg.manifest.provenance.artifactSha256 = digest(canonicalFigPluginPackageIndex(pkg))
  const verified: VerifiedFigPluginPackage = {
    package: pkg,
    keyFingerprint: digest(publicKey.export({ format: 'der', type: 'spki' })),
    artifactSha256: pkg.manifest.provenance.artifactSha256,
    files: contents.map(({ path, data }) => ({
      path,
      get data() {
        return Buffer.from(data)
      }
    }))
  }
  freezeMetadata(verified)
  return { verified, publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString() }
}

function managedList(verified: VerifiedFigPluginPackage): FigPluginManagedList {
  const manifest = verified.package.manifest
  return {
    items: [
      {
        pluginId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        host: manifest.host,
        generation: GENERATION,
        capabilities: [...manifest.capabilities],
        manifestSha256: digest(canonicalFigPluginJson(manifest)),
        materialization: 'verified-package',
        signerFingerprint: verified.keyFingerprint,
        artifactSha256: verified.artifactSha256,
        fileCount: 2,
        contentBytes: TOTAL_CONTENT_BYTES,
        configured: true,
        ready: false,
        state: 'disabled',
        cleanupPending: false,
        settings: { ...configuration.settings }
      }
    ],
    truncated: false,
    skippedRecords: 0
  }
}

function makeStore() {
  return {
    listManaged: vi.fn<() => Promise<FigPluginManagedList>>(),
    getManagedGeneration: vi.fn<(pluginId: string) => Promise<number>>(),
    installVerifiedPackage:
      vi.fn<
        (
          verified: VerifiedFigPluginPackage,
          generation: number,
          idempotencyKey: string
        ) => Promise<FigPluginManagedMutation>
      >(),
    configureManaged:
      vi.fn<(request: FigPluginManagedConfigureRequest) => Promise<FigPluginManagedMutation>>(),
    removeManaged:
      vi.fn<(request: FigPluginManagedRemoveRequest) => Promise<FigPluginManagedMutation>>(),
    getOwnedEntryPath: vi.fn<(request: FigPluginManagedTarget) => Promise<string>>()
  }
}

function makeWindow(id = 42) {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: Object.assign(new EventEmitter(), {
      id,
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => TRUSTED_URL)
    })
  }
}

function registerWindow(window: ReturnType<typeof makeWindow>): void {
  registerMagicAgentTrustedRouteBinding(window.webContents.id, undefined, {
    trustedUrl: TRUSTED_URL,
    trustedWebContents: window.webContents
  })
}

function invocation(
  method: ManagementMethod,
  overrides: Partial<ServiceInvocationContext> = {}
): ServiceInvocationContext {
  return {
    methodName: `svcFigPluginCenter.${method}`,
    senderId: 42,
    senderUrl: TRUSTED_URL,
    frameUrl: TRUSTED_URL,
    isMainFrame: true,
    ...overrides
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Promise not initialized')
  }
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const cancelledPicker: OpenDialogReturnValue = { canceled: true, filePaths: [] }
const approved: MessageBoxReturnValue = { response: 0, checkboxChecked: true }
const network = vi.fn(() => {
  throw new Error('Unexpected network request')
})
const ownedRoots = new Set<string>()
let root: string
let packagePath: string
let keyPath: string
let ownedEntryPath: string
let fixture: ReturnType<typeof packageFixture>
let store: ReturnType<typeof makeStore>
let window: ReturnType<typeof makeWindow>
let mainWindow: ReturnType<typeof makeWindow> | null
let service: FigPluginCenterSvcImpl

function selectPackageAndKey(): void {
  native.showOpenDialog
    .mockResolvedValueOnce({ canceled: false, filePaths: [packagePath] })
    .mockResolvedValueOnce({ canceled: false, filePaths: [keyPath] })
}

async function choosePreview(): Promise<FigPluginPackagePreview> {
  selectPackageAndKey()
  const result = await service.choosePackage({}, invocation('choosePackage'))
  expect(result).not.toBeNull()
  if (!result) throw new Error('Expected a verified preview')
  return result
}

function installation(preview: Pick<FigPluginPackagePreview, 'receiptId' | 'expectedGeneration'>) {
  return {
    receiptId: preview.receiptId,
    expectedGeneration: preview.expectedGeneration,
    idempotencyKey: 'install-synthetic-1'
  }
}

function expectStoreUntouched(): void {
  for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled()
}

function expectNoWrites(): void {
  expect(store.installVerifiedPackage).not.toHaveBeenCalled()
  expect(store.configureManaged).not.toHaveBeenCalled()
  expect(store.removeManaged).not.toHaveBeenCalled()
  expect(native.writeText).not.toHaveBeenCalled()
  expect(native.showItemInFolder).not.toHaveBeenCalled()
}

async function rejectsSafely(
  work: Promise<unknown>,
  code: FigPluginManagementErrorCode
): Promise<void> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(FigPluginManagementError)
  if (!(error instanceof ServiceError)) throw new Error('Expected a sanitized service error')
  expect(error.code).toBe(code)
  expect(error.message).toBe(FIGPLUGIN_MANAGEMENT_ERRORS[code])
  expect(error.cause).toBeUndefined()
  expect(error.payload).toBeUndefined()
  expect(JSON.parse(JSON.stringify(error))).toEqual({
    code,
    message: FIGPLUGIN_MANAGEMENT_ERRORS[code]
  })
  for (const secret of [
    root,
    packagePath,
    keyPath,
    fixture.publicKeyPem,
    RAW_CONTENT,
    'synthetic-secret'
  ]) {
    expect(String(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  }
}

beforeEach(async () => {
  vi.resetAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
  root = await fs.mkdtemp(path.join(process.cwd(), '.figplugin-packages-service-test-'))
  ownedRoots.add(root)
  fixture = packageFixture()
  packagePath = path.join(root, 'selected.figplugin')
  keyPath = path.join(root, 'pub.pem')
  ownedEntryPath = path.join(root, 'managed', 'objects', 'entry.js')
  await fs.writeFile(packagePath, JSON.stringify(fixture.verified.package))
  await fs.writeFile(keyPath, fixture.publicKeyPem)
  native.getPath.mockImplementation(() => {
    throw new Error('Injected store must not access app data')
  })
  native.showOpenDialog.mockResolvedValue(cancelledPicker)
  native.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
  native.verify.mockResolvedValue(fixture.verified)
  store = makeStore()
  store.listManaged.mockResolvedValue(managedList(fixture.verified))
  store.getManagedGeneration.mockResolvedValue(GENERATION)
  store.installVerifiedPackage.mockResolvedValue(mutation)
  store.configureManaged.mockResolvedValue(mutation)
  store.removeManaged.mockResolvedValue(mutation)
  store.getOwnedEntryPath.mockResolvedValue(ownedEntryPath)
  window = makeWindow()
  mainWindow = window
  registerWindow(window)
  service = new FigPluginCenterSvcImpl(
    store as unknown as ConstructorParameters<typeof FigPluginCenterSvcImpl>[0],
    () => mainWindow as unknown as BrowserWindow | null
  )
  network.mockImplementation(() => {
    throw new Error('Unexpected network request')
  })
  vi.stubGlobal('fetch', network)
  vi.stubGlobal('figPluginPackageServiceTestExecuted', false)
})

afterEach(async () => {
  try {
    expect(native.getPath).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(native.openPath).not.toHaveBeenCalled()
    expect(native.openExternal).not.toHaveBeenCalled()
    expect(Reflect.get(globalThis, 'figPluginPackageServiceTestExecuted')).toBe(false)
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    clearMagicAgentTrustedRouteBindingsForTest()
    for (const directory of ownedRoots) {
      await fs.rm(directory, { recursive: true, force: true })
      ownedRoots.delete(directory)
    }
  }
})

describe('FigPluginCenterSvcImpl native package management', () => {
  const methods: Array<{
    name: ManagementMethod
    invoke: (context?: ServiceInvocationContext) => Promise<unknown>
  }> = [
    { name: 'listPackages', invoke: (context) => service.listPackages({}, context) },
    { name: 'choosePackage', invoke: (context) => service.choosePackage({}, context) },
    {
      name: 'installPackage',
      invoke: (context) =>
        service.installPackage(
          installation({ receiptId: RECEIPT, expectedGeneration: GENERATION }),
          context
        )
    },
    {
      name: 'configurePackage',
      invoke: (context) => service.configurePackage(configuration, context)
    },
    { name: 'removePackage', invoke: (context) => service.removePackage(removal, context) },
    { name: 'copyPackagePath', invoke: (context) => service.copyPackagePath(target, context) },
    { name: 'revealPackage', invoke: (context) => service.revealPackage(target, context) },
    {
      name: 'discardPreview',
      invoke: (context) => service.discardPreview({ receiptId: RECEIPT }, context)
    }
  ]

  it.each(methods)(
    '$name denies missing, untrusted, wrong-method and subframe contexts before effects',
    async ({ name, invoke }) => {
      expect(() => authorizeMagicAgentApprovalRenderer(invocation(name))).not.toThrow()
      await rejectsSafely(invoke(), 'PERMISSION_DENIED')
      for (const override of [
        { senderId: 99 },
        { senderId: undefined },
        { methodName: 'svcOther.execute' },
        { isMainFrame: false },
        { isMainFrame: undefined },
        { frameUrl: 'https://untrusted.invalid/#/workshop/plugins' },
        { frameUrl: 'file:///other/index.html#/workshop/plugins' },
        { senderUrl: 'https://untrusted.invalid/' }
      ]) {
        await rejectsSafely(invoke(invocation(name, override)), 'PERMISSION_DENIED')
      }
      window.webContents.getURL.mockReturnValue('file:///app/index.html#/settings')
      await rejectsSafely(invoke(invocation(name)), 'PERMISSION_DENIED')
      window.webContents.getURL.mockReturnValue(TRUSTED_URL)
      window.isDestroyed.mockReturnValue(true)
      await rejectsSafely(invoke(invocation(name)), 'PERMISSION_DENIED')
      window.isDestroyed.mockReturnValue(false)
      window.webContents.isDestroyed.mockReturnValue(true)
      await rejectsSafely(invoke(invocation(name)), 'PERMISSION_DENIED')
      window.webContents.isDestroyed.mockReturnValue(false)
      mainWindow = null
      await rejectsSafely(invoke(invocation(name)), 'PERMISSION_DENIED')
      mainWindow = window
      unregisterMagicAgentTrustedRouteBinding(42)
      await rejectsSafely(invoke(invocation(name)), 'PERMISSION_DENIED')
      expect(native.showOpenDialog).not.toHaveBeenCalled()
      expect(native.showMessageBox).not.toHaveBeenCalled()
      expect(native.verify).not.toHaveBeenCalled()
      expectStoreUntouched()
      expectNoWrites()
    }
  )

  it.each(['listPackages', 'choosePackage'] as const)(
    '%s rejects renderer paths in the empty request before chooser/store access',
    async (method) => {
      for (const payload of [
        { path: packagePath },
        { publicKeyPath: keyPath },
        { defaultPath: root }
      ]) {
        await expect(
          service[method](payload as unknown as Record<string, never>, invocation(method))
        ).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
          cause: undefined
        })
      }
      expect(native.showOpenDialog).not.toHaveBeenCalled()
      expect(native.verify).not.toHaveBeenCalled()
      expectStoreUntouched()
    }
  )

  it.each(['package', 'key'] as const)(
    'cancelling the native %s picker produces no receipt or reads',
    async (stage) => {
      const open = vi.spyOn(fs, 'open')
      if (stage === 'key')
        native.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [packagePath] })
      expect(await service.choosePackage({}, invocation('choosePackage'))).toBeNull()
      expect(native.showOpenDialog).toHaveBeenCalledTimes(stage === 'key' ? 2 : 1)
      expect(open).not.toHaveBeenCalled()
      expect(native.verify).not.toHaveBeenCalled()
      expect(native.showMessageBox).not.toHaveBeenCalled()
      expectStoreUntouched()
    }
  )

  it('uses two parented native selections without defaultPath and returns only plain preview metadata', async () => {
    const open = vi.spyOn(fs, 'open')
    const before = Date.now()
    const preview = await choosePreview()
    expect(native.showOpenDialog).toHaveBeenCalledTimes(2)
    for (const [parent, options] of native.showOpenDialog.mock.calls) {
      expect(parent).toBe(window)
      expect(options.properties).toEqual(['openFile'])
      expect(options).not.toHaveProperty('defaultPath')
    }
    expect(native.showOpenDialog.mock.calls[0][1].filters).toEqual([
      { name: 'FIGPLUGIN package', extensions: ['figplugin', 'json'] }
    ])
    expect(native.showOpenDialog.mock.calls[1][1].filters).toEqual([
      { name: 'Public key', extensions: ['pem', 'pub'] }
    ])
    expect(open).toHaveBeenCalledExactlyOnceWith(keyPath, expect.any(Number))
    expect(native.verify).toHaveBeenCalledExactlyOnceWith(packagePath, fixture.publicKeyPem)
    expect(store.getManagedGeneration).toHaveBeenCalledExactlyOnceWith(target.pluginId)
    expect(store.getManagedGeneration.mock.invocationCallOrder[0]).toBeGreaterThan(
      native.verify.mock.invocationCallOrder[0]
    )
    expect(preview).toEqual({
      receiptId: expect.stringMatching(/^[a-f0-9]{48}$/),
      expiresAt: expect.any(Number),
      pluginId: target.pluginId,
      name: 'Synthetic FIGPLUGIN',
      version: '1.2.3',
      host: 'figma',
      expectedGeneration: GENERATION,
      capabilities: ['dialogue'],
      signerFingerprint: fixture.verified.keyFingerprint,
      artifactSha256: fixture.verified.artifactSha256,
      fileCount: 2,
      contentBytes: TOTAL_CONTENT_BYTES,
      signatureVerified: true,
      publisherTrusted: false,
      executesInDesktop: false
    })
    expect(preview.expiresAt).toBeGreaterThanOrEqual(before + TTL_MS)
    expect(preview.expiresAt).toBeLessThanOrEqual(Date.now() + TTL_MS)
    expect(Object.getPrototypeOf(preview)).toBe(Object.prototype)
    const serialized = JSON.stringify(preview)
    expect(JSON.parse(serialized)).toEqual(preview)
    for (const privateValue of [
      root,
      packagePath,
      keyPath,
      fixture.publicKeyPem,
      RAW_CONTENT,
      Buffer.from(RAW_CONTENT).toString('base64')
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it.each([
    { stage: 'package', count: 0, code: 'INVALID_PACKAGE' },
    { stage: 'package', count: 2, code: 'INVALID_PACKAGE' },
    { stage: 'key', count: 0, code: 'INVALID_SIGNER' },
    { stage: 'key', count: 2, code: 'INVALID_SIGNER' }
  ] as const)(
    'rejects $count native $stage selections rather than guessing a path',
    async ({ stage, count, code }) => {
      if (stage === 'key')
        native.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [packagePath] })
      native.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: Array.from({ length: count }, () => (stage === 'key' ? keyPath : packagePath))
      })
      await rejectsSafely(service.choosePackage({}, invocation('choosePackage')), code)
      expect(native.verify).not.toHaveBeenCalled()
      expectStoreUntouched()
    }
  )

  it.each([
    { label: 'malformed package', key: undefined, code: 'INVALID_PACKAGE' },
    { label: 'malformed public key', key: 'synthetic-secret-not-a-key', code: 'INVALID_SIGNER' },
    {
      label: 'private key',
      key: '-----BEGIN PRIVATE KEY-----\nsynthetic-secret\n-----END PRIVATE KEY-----\n',
      code: 'INVALID_SIGNER'
    }
  ] as const)(
    'sanitizes verifier failures for a $label without exposing selected files or content',
    async ({ key, code }) => {
      const selectedKey = key ?? fixture.publicKeyPem
      await fs.writeFile(keyPath, selectedKey)
      const failure = Object.assign(
        new ServiceError(`${packagePath} ${selectedKey} ${RAW_CONTENT}`, { code }),
        {
          cause: new Error(`synthetic-secret ${root}`),
          payload: { raw: RAW_CONTENT }
        }
      )
      native.verify.mockRejectedValueOnce(failure)
      selectPackageAndKey()
      await rejectsSafely(service.choosePackage({}, invocation('choosePackage')), code)
      expect(native.verify).toHaveBeenCalledExactlyOnceWith(packagePath, selectedKey)
      expectStoreUntouched()
      expectNoWrites()
    }
  )

  it.each([0, 4097])(
    'rejects a %i-byte selected key before opening it or invoking the verifier',
    async (size) => {
      await fs.writeFile(keyPath, Buffer.alloc(size, 65))
      const open = vi.spyOn(fs, 'open')
      selectPackageAndKey()
      await rejectsSafely(service.choosePackage({}, invocation('choosePackage')), 'INVALID_SIGNER')
      expect(open).not.toHaveBeenCalled()
      expect(native.verify).not.toHaveBeenCalled()
      expectStoreUntouched()
    }
  )

  it('sanitizes unexpected native errors and releases the chooser lock', async () => {
    native.showOpenDialog.mockRejectedValueOnce(new Error(`synthetic-secret ${packagePath}`))
    await rejectsSafely(service.choosePackage({}, invocation('choosePackage')), 'IO_ERROR')
    expect(await service.choosePackage({}, invocation('choosePackage'))).toBeNull()
    expect(native.verify).not.toHaveBeenCalled()
    expectStoreUntouched()
  })

  it('rejects a cryptographically verified package without an accepted native host descriptor before preview', async () => {
    const invalid = structuredClone(fixture.verified.package)
    invalid.manifest.entryPath = 'plugin/entry.js'
    native.verify.mockResolvedValueOnce({ ...fixture.verified, package: invalid })
    native.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [packagePath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [keyPath] })
    await rejectsSafely(service.choosePackage({}, invocation('choosePackage')), 'INVALID_PACKAGE')
    expect(store.getManagedGeneration).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('requires a main-verified receipt before showing any install confirmation', async () => {
    await rejectsSafely(
      service.installPackage(
        installation({ receiptId: RECEIPT, expectedGeneration: GENERATION }),
        invocation('installPackage')
      ),
      'STALE_PREVIEW'
    )
    const rendererPackage = {
      ...installation({ receiptId: RECEIPT, expectedGeneration: GENERATION }),
      package: fixture.verified.package,
      path: packagePath
    }
    await expect(
      service.installPackage(rendererPackage, invocation('installPackage'))
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', cause: undefined })
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expect(native.verify).not.toHaveBeenCalled()
    expectStoreUntouched()
  })

  it.each([
    { response: 0, checkboxChecked: false },
    { response: 1, checkboxChecked: true },
    { response: 1, checkboxChecked: false }
  ])(
    'does not install for native response $response / checkbox $checkboxChecked',
    async (answer) => {
      const preview = await choosePreview()
      native.showMessageBox.mockResolvedValueOnce(answer)
      expect(
        await service.installPackage(installation(preview), invocation('installPackage'))
      ).toEqual({
        completed: false,
        generation: GENERATION,
        cleanupPending: false
      })
      expect(native.showMessageBox).toHaveBeenCalledWith(
        window,
        expect.objectContaining({
          type: 'warning',
          defaultId: 1,
          cancelId: 1,
          checkboxChecked: false,
          checkboxLabel: 'I have verified the signer fingerprint and approve this exact package'
        })
      )
      expectNoWrites()
    }
  )

  it('confirms the exact main-owned snapshot and forwards the same idempotency key on retries', async () => {
    const preview = await choosePreview()
    expectNoWrites()
    const request = installation(preview)
    preview.name = 'renderer replacement'
    preview.capabilities.length = 0
    await fs.writeFile(packagePath, 'different bytes after preview')
    native.showMessageBox.mockResolvedValue(approved)
    expect(await service.installPackage(request, invocation('installPackage'))).toEqual(mutation)
    expect(await service.installPackage(request, invocation('installPackage'))).toEqual(mutation)
    expect(native.showMessageBox).toHaveBeenCalledTimes(2)
    const [parent, warning] = native.showMessageBox.mock.calls[0]
    expect(parent).toBe(window)
    expect(warning).toMatchObject({
      type: 'warning',
      message: 'Synthetic FIGPLUGIN 1.2.3 (figma)',
      buttons: ['Install this exact package', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      checkboxChecked: false,
      checkboxLabel: 'I have verified the signer fingerprint and approve this exact package'
    })
    expect(warning.detail).toContain(fixture.verified.keyFingerprint)
    expect(warning.detail).toContain(fixture.verified.artifactSha256)
    expect(warning.detail).toContain('Capabilities: dialogue')
    expect(warning.detail).toContain(
      'A valid signature does not prove the publisher is official or the code is safe'
    )
    expect(warning.detail).toContain('nothing runs in MagicPot')
    expect(warning.detail).toContain('Importing it into a host may execute code there')
    expect(store.installVerifiedPackage).toHaveBeenCalledTimes(2)
    for (const args of store.installVerifiedPackage.mock.calls) {
      expect(args).toEqual([fixture.verified, GENERATION, request.idempotencyKey])
      expect(args[0]).toBe(fixture.verified)
    }
    expect(native.verify).toHaveBeenCalledTimes(1)
  })

  it('rejects a preview generation mismatch before native consent', async () => {
    const preview = await choosePreview()
    await rejectsSafely(
      service.installPackage(
        { ...installation(preview), expectedGeneration: GENERATION + 1 },
        invocation('installPackage')
      ),
      'CONFIGURATION_CHANGED'
    )
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('does not transfer a receipt to another independently trusted window', async () => {
    const preview = await choosePreview()
    mainWindow = makeWindow(43)
    registerWindow(mainWindow)
    const other = invocation('installPackage', { senderId: 43 })
    expect(() => authorizeMagicAgentApprovalRenderer(other)).not.toThrow()
    await rejectsSafely(service.installPackage(installation(preview), other), 'STALE_PREVIEW')
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('expires receipts at the five-minute boundary before asking for confirmation', async () => {
    const preview = await choosePreview()
    vi.useFakeTimers()
    vi.setSystemTime(preview.expiresAt)
    await rejectsSafely(
      service.installPackage(installation(preview), invocation('installPackage')),
      'STALE_PREVIEW'
    )
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it.each(['changed URL', 'same-URL reload'] as const)(
    'invalidates a receipt after a %s',
    async (navigation) => {
      const preview = await choosePreview()
      const reloaded = navigation === 'changed URL' ? `${TRUSTED_URL}?reload=1` : TRUSTED_URL
      window.webContents.getURL.mockReturnValue(reloaded)
      if (navigation === 'same-URL reload')
        window.webContents.emit('did-start-navigation', {}, TRUSTED_URL, false, true)
      await rejectsSafely(
        service.installPackage(
          installation(preview),
          invocation('installPackage', { senderUrl: reloaded, frameUrl: reloaded })
        ),
        'STALE_PREVIEW'
      )
      expect(native.showMessageBox).not.toHaveBeenCalled()
      expectNoWrites()
    }
  )

  it.each([
    { url: 'file:///app/index.html#/settings', code: 'PERMISSION_DENIED' },
    { url: `${TRUSTED_URL}?reload=2`, code: 'STALE_PREVIEW' }
  ] as const)(
    'rechecks the live document after install confirmation: $code',
    async ({ url, code }) => {
      const preview = await choosePreview()
      const shown = deferred<void>()
      const answer = deferred<MessageBoxReturnValue>()
      native.showMessageBox.mockImplementationOnce(() => {
        shown.resolve(undefined)
        return answer.promise
      })
      const pending = service.installPackage(installation(preview), invocation('installPackage'))
      await Promise.race([shown.promise, pending])
      window.webContents.getURL.mockReturnValue(url)
      answer.resolve(approved)
      await rejectsSafely(pending, code)
      expectNoWrites()
    }
  )

  it('rejects double choose and installation while a chooser is pending, then releases BUSY', async () => {
    const answer = deferred<OpenDialogReturnValue>()
    native.showOpenDialog.mockReturnValueOnce(answer.promise)
    const pending = service.choosePackage({}, invocation('choosePackage'))
    const outcome = pending.catch((error: unknown) => error)
    await rejectsSafely(service.choosePackage({}, invocation('choosePackage')), 'BUSY')
    await rejectsSafely(
      service.installPackage(
        installation({ receiptId: RECEIPT, expectedGeneration: GENERATION }),
        invocation('installPackage')
      ),
      'BUSY'
    )
    expect(native.showOpenDialog).toHaveBeenCalledTimes(1)
    expectStoreUntouched()
    answer.resolve(cancelledPicker)
    expect(await outcome).toBeNull()
    expect(await service.choosePackage({}, invocation('choosePackage'))).toBeNull()
  })

  it('keeps BUSY until the pending install store operation completes', async () => {
    const preview = await choosePreview()
    const entered = deferred<void>()
    const commit = deferred<FigPluginManagedMutation>()
    native.showMessageBox.mockResolvedValueOnce(approved)
    store.installVerifiedPackage.mockImplementationOnce(() => {
      entered.resolve(undefined)
      return commit.promise
    })
    const request = installation(preview)
    const pending = service.installPackage(request, invocation('installPackage'))
    await Promise.race([entered.promise, pending])
    await rejectsSafely(service.choosePackage({}, invocation('choosePackage')), 'BUSY')
    await rejectsSafely(service.installPackage(request, invocation('installPackage')), 'BUSY')
    await rejectsSafely(
      service.configurePackage(configuration, invocation('configurePackage')),
      'BUSY'
    )
    expect(native.showOpenDialog).toHaveBeenCalledTimes(2)
    expect(native.showMessageBox).toHaveBeenCalledTimes(1)
    expect(store.installVerifiedPackage).toHaveBeenCalledTimes(1)
    expect(store.configureManaged).not.toHaveBeenCalled()
    commit.resolve(mutation)
    expect(await pending).toEqual(mutation)
    expect(await service.choosePackage({}, invocation('choosePackage'))).toBeNull()
  })

  it('lists store-owned summaries and configures only profile references with generation CAS', async () => {
    const listing = managedList(fixture.verified)
    store.listManaged.mockResolvedValueOnce(listing)
    expect(await service.listPackages({}, invocation('listPackages'))).toBe(listing)
    expect(store.listManaged).toHaveBeenCalledExactlyOnceWith()
    expect(listing.items[0].settings).toEqual(configuration.settings)
    expect(listing.items[0]).toMatchObject({
      ready: false,
      state: 'disabled',
      generation: GENERATION
    })
    const serialized = JSON.stringify(listing)
    for (const privateValue of [root, RAW_CONTENT, fixture.publicKeyPem])
      expect(serialized).not.toContain(privateValue)
    expect(await service.configurePackage(configuration, invocation('configurePackage'))).toEqual(
      mutation
    )
    expect(store.configureManaged).toHaveBeenCalledExactlyOnceWith(configuration)
    expect(native.showOpenDialog).not.toHaveBeenCalled()
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expect(native.verify).not.toHaveBeenCalled()
  })

  it('rejects raw configuration secrets instead of forwarding them to the store', async () => {
    const request = {
      ...configuration,
      settings: { ...configuration.settings, apiKey: 'synthetic-secret' }
    }
    const error = await service
      .configurePackage(request, invocation('configurePackage'))
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', cause: undefined })
    expect(JSON.stringify(error)).not.toContain('synthetic-secret')
    expectStoreUntouched()
  })

  it('propagates a sanitized configuration generation conflict without retrying the write', async () => {
    store.configureManaged.mockRejectedValueOnce(
      new ServiceError(`synthetic-secret ${root}`, { code: 'CONFIGURATION_CHANGED' })
    )
    await rejectsSafely(
      service.configurePackage(configuration, invocation('configurePackage')),
      'CONFIGURATION_CHANGED'
    )
    expect(store.configureManaged).toHaveBeenCalledExactlyOnceWith(configuration)
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expect(await service.configurePackage(configuration, invocation('configurePackage'))).toEqual(
      mutation
    )
  })

  it.each(['copyPackagePath', 'revealPackage'] as const)(
    '%s uses only the actual store-owned entry and returns no path',
    async (method) => {
      const result = await service[method](target, invocation(method))
      expect(result).toEqual({ completed: true })
      expect(JSON.stringify(result)).not.toContain(ownedEntryPath)
      expect(store.getOwnedEntryPath).toHaveBeenCalledExactlyOnceWith(target)
      if (method === 'copyPackagePath') {
        expect(native.writeText).toHaveBeenCalledExactlyOnceWith(ownedEntryPath)
        expect(native.showItemInFolder).not.toHaveBeenCalled()
      } else {
        expect(native.showItemInFolder).toHaveBeenCalledExactlyOnceWith(ownedEntryPath)
        expect(native.writeText).not.toHaveBeenCalled()
      }
      expect(native.showOpenDialog).not.toHaveBeenCalled()
      expect(native.showMessageBox).not.toHaveBeenCalled()
      expect(native.verify).not.toHaveBeenCalled()
      expect(store.installVerifiedPackage).not.toHaveBeenCalled()
    }
  )

  it.each(['copyPackagePath', 'revealPackage'] as const)(
    '%s rejects renderer paths and stale generations without native effects',
    async (method) => {
      const forged = { ...target, path: packagePath }
      await expect(service[method](forged, invocation(method))).rejects.toMatchObject({
        code: 'VALIDATION_ERROR'
      })
      expectStoreUntouched()
      store.getOwnedEntryPath.mockRejectedValueOnce(
        new FigPluginManagementError('CONFIGURATION_CHANGED')
      )
      await rejectsSafely(service[method](target, invocation(method)), 'CONFIGURATION_CHANGED')
      expect(store.getOwnedEntryPath).toHaveBeenCalledExactlyOnceWith(target)
      expectNoWrites()
    }
  )

  it.each(['copyPackagePath', 'revealPackage'] as const)(
    '%s reauthorizes after awaiting the owned entry',
    async (method) => {
      const entry = deferred<string>()
      store.getOwnedEntryPath.mockReturnValueOnce(entry.promise)
      const pending = service[method](target, invocation(method))
      expect(store.getOwnedEntryPath).toHaveBeenCalledExactlyOnceWith(target)
      window.webContents.getURL.mockReturnValue('file:///app/index.html#/settings')
      entry.resolve(ownedEntryPath)
      await rejectsSafely(pending, 'PERMISSION_DENIED')
      expectNoWrites()
    }
  )

  it('leaves managed files untouched when native removal is cancelled', async () => {
    expect(await service.removePackage(removal, invocation('removePackage'))).toEqual({
      completed: false,
      generation: GENERATION,
      cleanupPending: false
    })
    expect(store.listManaged).toHaveBeenCalledExactlyOnceWith()
    expect(native.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        type: 'warning',
        defaultId: 1,
        cancelId: 1,
        buttons: ['Remove managed copy', 'Cancel']
      })
    )
    expect(native.showMessageBox.mock.calls[0][1].detail).toContain(
      'Existing projects and model configuration are not removed'
    )
    expectNoWrites()
  })

  it('refuses removal with a listing generation mismatch before native confirmation', async () => {
    const listing = managedList(fixture.verified)
    listing.items[0].generation++
    store.listManaged.mockResolvedValueOnce(listing)
    await rejectsSafely(
      service.removePackage(removal, invocation('removePackage')),
      'CONFIGURATION_CHANGED'
    )
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('rejects an old removal whose window reloads while the authoritative listing is pending', async () => {
    const answer = deferred<FigPluginManagedList>()
    store.listManaged.mockReturnValueOnce(answer.promise)
    const pending = service.removePackage(removal, invocation('removePackage'))
    const rejected = rejectsSafely(pending, 'PERMISSION_DENIED')
    window.webContents.emit('did-start-navigation', {}, TRUSTED_URL, false, true)
    answer.resolve(managedList(fixture.verified))
    await rejected
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('passes removal generation and idempotency through CAS even after native confirmation', async () => {
    native.showMessageBox.mockResolvedValue(approved)
    store.removeManaged.mockRejectedValueOnce(new FigPluginManagementError('CONFIGURATION_CHANGED'))
    await rejectsSafely(
      service.removePackage(removal, invocation('removePackage')),
      'CONFIGURATION_CHANGED'
    )
    expect(store.removeManaged).toHaveBeenCalledExactlyOnceWith(removal)
    store.removeManaged.mockResolvedValueOnce({ ...mutation, cleanupPending: true })
    expect(await service.removePackage(removal, invocation('removePackage'))).toEqual({
      ...mutation,
      cleanupPending: true
    })
    expect(store.removeManaged).toHaveBeenLastCalledWith(removal)
  })

  it('refuses removal after a native confirmation if the parent navigated', async () => {
    const shown = deferred<void>()
    const answer = deferred<MessageBoxReturnValue>()
    native.showMessageBox.mockImplementationOnce(() => {
      shown.resolve(undefined)
      return answer.promise
    })
    const pending = service.removePackage(removal, invocation('removePackage'))
    await Promise.race([shown.promise, pending])
    window.webContents.getURL.mockReturnValue(`${TRUSTED_URL}?reload=3`)
    answer.resolve(approved)
    await rejectsSafely(pending, 'PERMISSION_DENIED')
    expectNoWrites()
  })

  it.each(['package', 'key'] as const)(
    'times out the %s chooser at five minutes and ignores its late selection without reading',
    async (stage) => {
      vi.useFakeTimers()
      const answer = deferred<OpenDialogReturnValue>()
      const open = vi.spyOn(fs, 'open')
      if (stage === 'key')
        native.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [packagePath] })
      native.showOpenDialog.mockReturnValueOnce(answer.promise)
      const pending = service.choosePackage({}, invocation('choosePackage'))
      const outcome = pending.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(TTL_MS - 1)
      expect(native.showOpenDialog).toHaveBeenCalledTimes(stage === 'key' ? 2 : 1)
      await rejectsSafely(service.choosePackage({}, invocation('choosePackage')), 'BUSY')
      await vi.advanceTimersByTimeAsync(1)
      await rejectsSafely(
        outcome.then((error) => {
          throw error
        }),
        'TIMEOUT'
      )
      answer.resolve({ canceled: false, filePaths: [stage === 'key' ? keyPath : packagePath] })
      await vi.advanceTimersByTimeAsync(0)
      expect(native.showOpenDialog).toHaveBeenCalledTimes(stage === 'key' ? 2 : 1)
      expect(open).not.toHaveBeenCalled()
      expect(native.verify).not.toHaveBeenCalled()
      expectStoreUntouched()
      expectNoWrites()
      expect(await service.choosePackage({}, invocation('choosePackage'))).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('discards a preview idempotently and rejects its now-stale receipt without confirmation', async () => {
    const preview = await choosePreview()
    expect(
      await service.discardPreview({ receiptId: preview.receiptId }, invocation('discardPreview'))
    ).toBeUndefined()
    expect(
      await service.discardPreview({ receiptId: preview.receiptId }, invocation('discardPreview'))
    ).toBeUndefined()
    await rejectsSafely(
      service.installPackage(installation(preview), invocation('installPackage')),
      'STALE_PREVIEW'
    )
    expect(native.showMessageBox).not.toHaveBeenCalled()
    expectNoWrites()
  })
})
