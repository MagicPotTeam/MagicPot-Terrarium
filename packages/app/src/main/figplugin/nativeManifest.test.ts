import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FigPluginManagementError } from '@shared/figplugin/management'
import {
  FIGPLUGIN_PACKAGE_FORMAT,
  FigPluginPackageSchema,
  canonicalFigPluginPackageIndex,
  getFigPluginPackageSigningPayload,
  type FigPluginPackage
} from '@shared/figplugin/package'
import { verifyFigPluginPackage } from './packageVerifier'
import { verifyNativePluginManifest } from './nativeManifest'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const name = 'Private development fixture'
const bridgeOrigin = 'http://127.0.0.1:43127'
const bridgeReasoning = 'Connect only to the locally paired MagicPot desktop bridge.'
type Host = FigPluginPackage['manifest']['host']

function figma() {
  return {
    name,
    // Synthetic test ID only, not an official or host-registered plugin identity.
    id: '1234567890123456789',
    api: '1.0.0',
    editorType: ['figma'],
    main: 'code.js',
    ui: 'ui.html',
    documentAccess: 'dynamic-page',
    networkAccess: { allowedDomains: ['none'] }
  }
}

function photoshop() {
  return {
    manifestVersion: 5,
    id: 'private.publisher.panel',
    name,
    version: '1.2.3',
    main: 'ui.html',
    host: { app: 'PS', minVersion: '23.3.0' },
    entrypoints: [{ type: 'panel', id: 'panel', label: { default: 'Private panel' } }]
  }
}

function bridgeFigma(origin = bridgeOrigin) {
  return {
    ...figma(),
    networkAccess: { allowedDomains: [origin], reasoning: bridgeReasoning }
  }
}

function bridgePhotoshop(origin = bridgeOrigin) {
  return { ...photoshop(), requiredPermissions: { network: { domains: [origin] } } }
}

function bridgeNative(host: Host, origin = bridgeOrigin) {
  return host === 'figma' ? bridgeFigma(origin) : bridgePhotoshop(origin)
}

// All fixtures are private, signed in memory and never materialized or launched in a host.
function fixture(
  host: Host = 'figma',
  native: unknown = host === 'figma' ? figma() : photoshop(),
  options: {
    entryPath?: string
    version?: string
    extraFiles?: Array<[string, string]>
    schemaVersion?: 1 | 2
    bridgeOrigin?: string
  } = {}
): FigPluginPackage {
  const entryPath = options.entryPath ?? 'native/manifest.json'
  const isBridge = options.schemaVersion === 2
  const data = Buffer.isBuffer(native)
    ? native
    : Buffer.from(typeof native === 'string' ? native : JSON.stringify(native))
  const sources: Array<[string, Buffer | string]> = [
    [entryPath, data],
    [
      'native/code.js',
      host === 'figma'
        ? 'figma.showUI(__html__);'
        : 'require("uxp").entrypoints.setup({ panels: { panel: { show() {} } } });'
    ],
    ['native/ui.html', '<!doctype html><html><body><script src="code.js"></script></body></html>'],
    ...(options.extraFiles ?? [])
  ]
  const files = sources.map(([path, source]) => {
    const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source)
    return {
      path,
      bytes: bytes.length,
      sha256: hash(bytes),
      contentBase64: bytes.toString('base64')
    }
  })
  const pkg = FigPluginPackageSchema.parse({
    format: FIGPLUGIN_PACKAGE_FORMAT,
    manifest: {
      schemaVersion: options.schemaVersion ?? 1,
      id: 'private.native-fixture',
      name,
      version: options.version ?? '1.2.3',
      host,
      entryPath,
      capabilities: isBridge ? ['dialogue', 'asset-transfer'] : ['dialogue'],
      permissions: {
        dialogue: 'prompt',
        network: isBridge ? 'desktop-bridge' : 'none',
        filesystem: 'none',
        ...(isBridge ? { assetTransfer: 'read' } : {})
      },
      ...(isBridge
        ? { bridge: { protocol: 1, origin: options.bridgeOrigin ?? bridgeOrigin } }
        : {}),
      limits: {},
      provenance: {
        publisherId: 'private-publisher',
        publisherName: 'Private Publisher',
        source: 'user-provided',
        artifactSha256: '0'.repeat(64),
        issuedAt: '2026-01-01T00:00:00.000Z'
      },
      signature: {
        algorithm: 'ed25519',
        keyId: 'private-key',
        value: '0'.repeat(128),
        signedAt: '2026-01-01T00:00:00.000Z'
      },
      assets: files.map((file, index) => ({
        id: `asset-${index}`,
        path: file.path,
        sizeBytes: file.bytes,
        sha256: file.sha256
      }))
    },
    files
  })
  pkg.manifest.provenance.artifactSha256 = hash(canonicalFigPluginPackageIndex(pkg))
  pkg.manifest.signature.value = sign(
    null,
    Buffer.from(getFigPluginPackageSigningPayload(pkg)),
    privateKey
  ).toString('base64url')
  return verifyFigPluginPackage(pkg, publicKeyPem).package
}

function rejects(pkg: FigPluginPackage): void {
  let caught: unknown
  try {
    verifyNativePluginManifest(pkg)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(FigPluginManagementError)
  const error = caught as FigPluginManagementError
  expect(error.toJSON()).toEqual({
    code: 'INVALID_PACKAGE',
    message: 'The plugin package is invalid.'
  })
  expect(error.cause).toBeUndefined()
  expect(error.payload).toBeUndefined()
  expect(JSON.stringify(error)).not.toMatch(/native\/|private|123456789|issues|secret|https:/)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('verifyNativePluginManifest', () => {
  it.each([
    ['figma', 'figma-development', 'Figma'],
    ['photoshop', 'photoshop-uxp-development', 'Adobe Photoshop']
  ] as const)(
    'maps a verified private %s bundle to its native manifest, without mutating it',
    (host, kind, displayHost) => {
      const pkg = fixture(host)
      const before = structuredClone(pkg)
      expect(verifyNativePluginManifest(pkg)).toEqual({
        kind,
        entryPath: 'native/manifest.json',
        displayHost
      })
      expect(pkg).toEqual(before)
    }
  )

  it('supports a manifest at the package root with safe nested references', () => {
    const pkg = fixture(
      'figma',
      { ...figma(), main: 'native/code.js', ui: 'native/ui.html' },
      { entryPath: 'manifest.json' }
    )
    expect(verifyNativePluginManifest(pkg).entryPath).toBe('manifest.json')
  })

  it.each(['figma', 'photoshop'] as const)('rejects a native/declared %s host mismatch', (host) => {
    rejects(fixture(host, host === 'figma' ? photoshop() : figma()))
  })

  it.each(['native/entry.js', 'native/Manifest.json', 'native/descriptor.json'])(
    'requires an actual manifest.json entry, not %s',
    (entryPath) => {
      rejects(fixture('figma', figma(), { entryPath }))
    }
  )

  it.each(['missing', 'different-case', 'absent-entry', 'unsupported-host'])(
    'fails closed for %s package metadata',
    (kind) => {
      const pkg = fixture()
      if (kind === 'missing') pkg.files.shift()
      if (kind === 'different-case') pkg.manifest.entryPath = 'native/Manifest.json'
      if (kind === 'absent-entry') Reflect.deleteProperty(pkg.manifest, 'entryPath')
      if (kind === 'unsupported-host') Reflect.set(pkg.manifest, 'host', 'illustrator')
      rejects(pkg)
    }
  )

  it.each(['figma', 'photoshop'] as const)('requires coherent %s display metadata', (host) => {
    rejects(
      fixture(host, { ...(host === 'figma' ? figma() : photoshop()), name: 'Misleading name' })
    )
  })

  it.each(['network', 'filesystem'])('rejects an envelope claiming %s access', (permission) => {
    const pkg = fixture()
    Reflect.set(pkg.manifest.permissions, permission, 'prompt')
    rejects(pkg)
  })

  it('accepts exactly 64 KiB of native manifest bytes', () => {
    const text = JSON.stringify(figma())
    const pkg = fixture('figma', text.padEnd(64 * 1024, ' '))
    expect(verifyNativePluginManifest(pkg).kind).toBe('figma-development')
  })

  it('rejects more than 64 KiB before UTF-8 decoding', () => {
    const pkg = fixture('figma', JSON.stringify(figma()).padEnd(64 * 1024 + 1, ' '))
    rejects(pkg)
  })

  it.each([
    Buffer.from([0xff]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xe2, 0x82]),
    Buffer.from([0xed, 0xa0, 0x80])
  ])('rejects invalid UTF-8 %j without replacement characters', (invalid) => {
    const text = JSON.stringify(figma())
    rejects(
      fixture(
        'figma',
        Buffer.concat([Buffer.from(text.slice(0, -1) + ',"secret":"'), invalid, Buffer.from('"}')])
      )
    )
  })

  it.each([
    'null',
    '[]',
    '42',
    '"secret"',
    '{',
    `/* secret */${JSON.stringify(figma())}`,
    JSON.stringify(figma()).slice(0, -1) + ',}',
    '\ufeff' + JSON.stringify(figma()),
    JSON.stringify(figma()) + '\0',
    JSON.stringify(figma()) + '{}'
  ])('rejects non-strict JSON input %s', (text) => {
    rejects(fixture('figma', text))
  })

  it.each([
    '{"api":"secret",' + JSON.stringify(figma()).slice(1),
    '{"\\u0061pi":"secret",' + JSON.stringify(figma()).slice(1),
    JSON.stringify(figma()).replace(
      '"allowedDomains":["none"]',
      '"allowedDomains":["*"],"allowedDomains":["none"]'
    ),
    JSON.stringify(figma()).slice(0, -1) + ',"__proto__":{"secret":true}}'
  ])('rejects duplicate, escaped-duplicate or prototype keys', (text) => {
    rejects(fixture('figma', text))
  })

  it.each(['main', 'ui'] as const)(
    'requires the referenced Figma %s file with exact case',
    (field) => {
      for (const value of [
        field === 'main' ? 'missing.js' : 'missing.html',
        field === 'main' ? 'Code.js' : 'UI.html'
      ]) {
        rejects(fixture('figma', { ...figma(), [field]: value }))
      }
    }
  )

  it.each([
    '../code.js',
    './code.js',
    'nested/../code.js',
    '/native/code.js',
    'C:/code.js',
    'native\\code.js',
    '//host/code.js',
    'https://secret.invalid/code.js',
    'file:///secret/code.js',
    '%2e%2e/code.js',
    'code.js?secret',
    'code.js#secret',
    'code.js\0',
    'code.js\n',
    ' code.js',
    'sub//code.js',
    'con/code.js',
    'sub./code.js',
    '__proto__/code.js',
    'code.ts',
    'ui.html'
  ])('rejects unsafe or non-JS Figma main %j', (main) => {
    rejects(fixture('figma', { ...figma(), main }))
  })

  it('does not resolve relative files from the package root or search sibling directories', () => {
    rejects(
      fixture(
        'figma',
        { ...figma(), main: 'elsewhere.js' },
        { extraFiles: [['elsewhere.js', 'void 0;']] }
      )
    )
  })

  it('never evaluates code or fetches a resource and does not claim to audit scripts', () => {
    const pkg = fixture('photoshop')
    const fetch = vi.fn(() => {
      throw new Error('must not fetch')
    })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('nativeManifestExecuted', false)
    // HTML remains opaque: descriptor permissions, not a pretend JS/HTML security scan.
    const html =
      '<script src="https://secret.invalid/code.js"></script><script>globalThis.nativeManifestExecuted = true</script>'
    const opaque = fixture(
      'photoshop',
      { ...photoshop(), main: 'opaque.html' },
      { extraFiles: [['native/opaque.html', html]] }
    )
    expect(verifyNativePluginManifest(pkg).kind).toBe('photoshop-uxp-development')
    expect(verifyNativePluginManifest(opaque).kind).toBe('photoshop-uxp-development')
    expect(fetch).not.toHaveBeenCalled()
    expect(Reflect.get(globalThis, 'nativeManifestExecuted')).toBe(false)
  })
})

describe('Figma strict no-network development subset', () => {
  it('accepts optional UI omission and an explicitly empty development allowlist', () => {
    const native = figma()
    Reflect.deleteProperty(native, 'ui')
    expect(
      verifyNativePluginManifest(
        fixture('figma', {
          ...native,
          networkAccess: { allowedDomains: ['none'], devAllowedDomains: [] }
        })
      ).kind
    ).toBe('figma-development')
  })

  it.each(['name', 'id', 'api', 'editorType', 'main', 'documentAccess', 'networkAccess'])(
    'requires %s',
    (field) => {
      const native = figma()
      Reflect.deleteProperty(native, field)
      rejects(fixture('figma', native))
    }
  )

  it.each([
    'build',
    'enableProposedApi',
    'enablePrivatePluginApi',
    'permissions',
    'relaunchButtons',
    'menu',
    'unknown',
    'version'
  ])('rejects forbidden/unsupported top-level %s', (field) => {
    rejects(
      fixture('figma', {
        ...figma(),
        [field]: field === 'build' ? 'cmd /c secret' : ['currentuser', 'payments']
      })
    )
  })

  it.each(['', '1234', '1'.repeat(33), 'official-plugin', '12345\n', '１２３４５', 12345])(
    'rejects a non-assigned-ID shape %j',
    (id) => {
      rejects(fixture('figma', { ...figma(), id }))
    }
  )

  it.each(['12345', '1'.repeat(32)])(
    'accepts the ID shape boundary %s without claiming registration',
    (id) => {
      expect(verifyNativePluginManifest(fixture('figma', { ...figma(), id })).kind).toBe(
        'figma-development'
      )
    }
  )

  it.each([
    { api: '1.1.0' },
    { api: 1 },
    { editorType: ['figjam'] },
    { editorType: ['figma', 'figjam'] },
    { editorType: [] },
    { documentAccess: 'current-page' },
    { ui: 'code.js' },
    { ui: { default: 'ui.html' } },
    { networkAccess: {} },
    { networkAccess: { allowedDomains: [] } },
    { networkAccess: { allowedDomains: ['*'] } },
    { networkAccess: { allowedDomains: ['none', 'https://secret.invalid'] } },
    { networkAccess: { allowedDomains: ['none'], devAllowedDomains: ['http://localhost:1234'] } },
    { networkAccess: { allowedDomains: ['none'], devAllowedDomains: ['none'] } },
    { networkAccess: { allowedDomains: ['none'], unknown: true } }
  ])('rejects unsupported fields or domain grants %j', (fields) => {
    rejects(fixture('figma', { ...figma(), ...fields }))
  })
})

describe('Photoshop UXP v5 sandbox-only panel subset', () => {
  it.each([undefined, {}, { localFileSystem: 'plugin' }])(
    'accepts permissions %j and width/height minimum panel size',
    (requiredPermissions) => {
      const native = {
        ...photoshop(),
        requiredPermissions,
        entrypoints: [{ ...photoshop().entrypoints[0], minimumSize: { width: 240, height: 180 } }]
      }
      expect(verifyNativePluginManifest(fixture('photoshop', native)).kind).toBe(
        'photoshop-uxp-development'
      )
    }
  )

  it.each(['23.3.0', '23.3.1', '23.10.0', '24.0.0'])('supports host minimum %s', (minVersion) => {
    expect(
      verifyNativePluginManifest(
        fixture('photoshop', { ...photoshop(), host: { app: 'PS', minVersion } })
      ).kind
    ).toBe('photoshop-uxp-development')
  })

  it.each([
    '23.2.99',
    '22.99.99',
    '0.0.0',
    '23.3',
    '023.3.0',
    '23.3.0-beta',
    '23.3.0+build',
    '23.3.0\n',
    '9007199254740992.3.0',
    '23.9007199254740992.0',
    '23.3.9007199254740992',
    '9'.repeat(1000) + '.0.0'
  ])('rejects unsupported or overflowing host minimum %j', (minVersion) => {
    rejects(fixture('photoshop', { ...photoshop(), host: { app: 'PS', minVersion } }))
  })

  it.each(['1.2.4', '1.2', '01.2.3', '1.2.3\n', '9007199254740992.0.0'])(
    'requires a coherent bounded x.y.z package version, not %j',
    (version) => {
      rejects(fixture('photoshop', { ...photoshop(), version }))
    }
  )

  it.each(['1.2.3-beta', '1.2.3+build', '9007199254740992.0.0'])(
    'rejects %s even when the envelope version matches',
    (version) => {
      rejects(fixture('photoshop', { ...photoshop(), version }, { version }))
    }
  )

  it.each([
    '',
    ' ',
    'a'.repeat(129),
    'publisher/secret',
    'publisher:secret',
    '非ASCII',
    'publisher\n',
    123
  ])('rejects invalid publisher ID %j', (id) => {
    rejects(fixture('photoshop', { ...photoshop(), id }))
  })

  it.each(['manifestVersion', 'id', 'name', 'version', 'main', 'host', 'entrypoints'])(
    'requires %s',
    (field) => {
      const native = photoshop()
      Reflect.deleteProperty(native, field)
      rejects(fixture('photoshop', native))
    }
  )

  it.each([
    { manifestVersion: 4 },
    { manifestVersion: 6 },
    { manifestVersion: '5' },
    { main: 'code.js' },
    { main: 'UI.html' },
    { main: '../ui.html' },
    { main: 'missing.html' },
    { host: { app: 'XD', minVersion: '23.3.0' } },
    { host: [{ app: 'PS', minVersion: '23.3.0' }] },
    { host: { app: 'PS', minVersion: '23.3.0', maxVersion: '30.0.0' } },
    { entrypoints: [] },
    { entrypoints: [...photoshop().entrypoints, ...photoshop().entrypoints] },
    { entrypoints: [{ ...photoshop().entrypoints[0], type: 'command' }] },
    { entrypoints: [{ ...photoshop().entrypoints[0], id: '../secret' }] },
    { entrypoints: [{ ...photoshop().entrypoints[0], label: 'Private panel' }] },
    { entrypoints: [{ ...photoshop().entrypoints[0], label: { default: '' } }] },
    {
      entrypoints: [
        { ...photoshop().entrypoints[0], label: { default: 'Panel', secret: 'secret' } }
      ]
    },
    { entrypoints: [{ ...photoshop().entrypoints[0], unknown: true }] },
    { entrypoints: [{ ...photoshop().entrypoints[0], minimumSize: { x: 240, y: 180 } }] },
    { entrypoints: [{ ...photoshop().entrypoints[0], minimumSize: { width: 0, height: 180 } }] },
    { entrypoints: [{ ...photoshop().entrypoints[0], minimumSize: { width: 1.5, height: 180 } }] },
    {
      entrypoints: [
        { ...photoshop().entrypoints[0], minimumSize: { width: 240, height: 9007199254740992 } }
      ]
    },
    {
      entrypoints: [
        { ...photoshop().entrypoints[0], minimumSize: { width: 240, height: 180, unknown: 1 } }
      ]
    },
    { unknown: true },
    { build: 'cmd /c secret' }
  ])('rejects unsupported or unknown descriptor fields %j', (fields) => {
    rejects(fixture('photoshop', { ...photoshop(), ...fields }))
  })

  it.each([
    { localFileSystem: 'fullAccess' },
    { localFileSystem: 'request' },
    { localFileSystem: 'none' },
    { network: { domains: ['*'] } },
    { network: { domains: [] } },
    { clipboard: 'readAndWrite' },
    { ipc: { enablePluginCommunication: true } },
    { webview: { allow: 'yes', domains: ['*'] } },
    { launchProcess: { schemes: ['https'], extensions: ['.exe'] } },
    { unknown: true }
  ])('rejects permission escalation %j', (requiredPermissions) => {
    rejects(fixture('photoshop', { ...photoshop(), requiredPermissions }))
  })

  it('rejects numeric overflow from strict JSON without leaking parser details', () => {
    const native = photoshop()
    const text = JSON.stringify({
      ...native,
      entrypoints: [{ ...native.entrypoints[0], minimumSize: { width: 240, height: 'overflow' } }]
    }).replace('"overflow"', '1e309')
    rejects(fixture('photoshop', text))
  })
})

describe.each(['figma', 'photoshop'] as const)('explicit v2 %s desktop bridge subset', (host) => {
  const expected = {
    kind: host === 'figma' ? 'figma-development' : 'photoshop-uxp-development',
    entryPath: 'native/manifest.json',
    displayHost: host === 'figma' ? 'Figma' : 'Adobe Photoshop'
  }

  it.each(['http://127.0.0.1:1024', bridgeOrigin, 'http://127.0.0.1:65535'])(
    'accepts only the signed origin %s without requiring a config filename or mutating the package',
    (origin) => {
      const pkg = fixture(host, bridgeNative(host, origin), {
        schemaVersion: 2,
        bridgeOrigin: origin
      })
      const before = structuredClone(pkg)
      expect(verifyNativePluginManifest(pkg)).toEqual(expected)
      expect(pkg).toEqual(before)
    }
  )

  it('does not implicitly upgrade v1 based on the native descriptor', () => {
    rejects(fixture(host, bridgeNative(host)))
  })

  it('requires native bridge permissions rather than an offline v1 descriptor', () => {
    rejects(fixture(host, host === 'figma' ? figma() : photoshop(), { schemaVersion: 2 }))
  })

  it('rejects an implicit schema upgrade with v1 permissions and no bridge', () => {
    const pkg = fixture(host)
    pkg.manifest.schemaVersion = 2
    rejects(pkg)
  })

  it.each([
    'missing-version',
    'unknown-version',
    'v1-version',
    'v1-offline-with-bridge',
    'v1-offline-without-bridge',
    'offline',
    'missing-network',
    'missing-bridge',
    'missing-origin',
    'altered-origin',
    'invalid-origin',
    'wrong-protocol',
    'filesystem'
  ])('fails closed for %s envelope metadata', (kind) => {
    const pkg = fixture(host, bridgeNative(host), { schemaVersion: 2 })
    // Deliberately violate the verified-envelope contract to check the native policy gate too.
    if (kind === 'missing-version') Reflect.deleteProperty(pkg.manifest, 'schemaVersion')
    if (kind === 'unknown-version') Reflect.set(pkg.manifest, 'schemaVersion', 3)
    if (kind.startsWith('v1-')) pkg.manifest.schemaVersion = 1
    if (kind.startsWith('v1-offline') || kind === 'offline') {
      pkg.manifest.permissions.network = 'none'
    }
    if (kind === 'missing-network') Reflect.deleteProperty(pkg.manifest.permissions, 'network')
    if (kind === 'missing-bridge' || kind === 'v1-offline-without-bridge') {
      Reflect.deleteProperty(pkg.manifest, 'bridge')
    }
    if (kind === 'missing-origin') Reflect.deleteProperty(pkg.manifest.bridge!, 'origin')
    if (kind === 'altered-origin') pkg.manifest.bridge!.origin = 'http://127.0.0.1:43128'
    if (kind === 'invalid-origin') pkg.manifest.bridge!.origin = 'http://localhost:43127'
    if (kind === 'wrong-protocol') Reflect.set(pkg.manifest.bridge!, 'protocol', 2)
    if (kind === 'filesystem') Reflect.set(pkg.manifest.permissions, 'filesystem', 'prompt')
    rejects(pkg)
  })

  it.each(
    [
      undefined,
      null,
      bridgeOrigin,
      [],
      [42],
      ['none'],
      ['*'],
      [bridgeOrigin, bridgeOrigin],
      [bridgeOrigin, 'https://secret.invalid'],
      ['http://127.0.0.1:43128'],
      ['http://localhost:43127'],
      ['http://127.1:43127'],
      ['http://127.0.0.2:43127'],
      ['http://[::1]:43127'],
      ['https://127.0.0.1:43127'],
      ['HTTP://127.0.0.1:43127'],
      ['http://secret@127.0.0.1:43127'],
      ['http://127.0.0.1:43127@secret.invalid'],
      ['http://127.0.0.1.secret.invalid:43127'],
      ['http://127.0.0.1:043127'],
      ['http://127.0.0.1:1023'],
      ['http://127.0.0.1:65536'],
      ['http://127.0.0.1'],
      [`${bridgeOrigin}/`],
      [`${bridgeOrigin}/api`],
      [`${bridgeOrigin}?secret`],
      [`${bridgeOrigin}#secret`],
      [`${bridgeOrigin}\n`],
      [`${bridgeOrigin}\0`],
      [` ${bridgeOrigin}`]
    ].map((domains) => ({ domains }))
  )('rejects missing, extra or non-exact native domains $domains', ({ domains }) => {
    const native =
      host === 'figma'
        ? {
            ...bridgeFigma(),
            networkAccess: { ...bridgeFigma().networkAccess, allowedDomains: domains }
          }
        : { ...bridgePhotoshop(), requiredPermissions: { network: { domains } } }
    rejects(fixture(host, native, { schemaVersion: 2 }))
  })

  it.each(['build', 'permissions', 'fullScriptingAccess', 'bridge', 'token', 'pairingCode'])(
    'rejects unsupported native field %s even in v2',
    (field) => {
      rejects(fixture(host, { ...bridgeNative(host), [field]: 'secret' }, { schemaVersion: 2 }))
    }
  )

  it('still requires existing, safe main and HTML references', () => {
    const native = bridgeNative(host)
    for (const main of ['../outside.js', 'missing.js', 'missing.html', 'Code.js', 'UI.html']) {
      rejects(fixture(host, { ...native, main }, { schemaVersion: 2 }))
    }
    if (host === 'figma') {
      rejects(fixture(host, { ...native, ui: 'missing.html' }, { schemaVersion: 2 }))
    }
  })

  it('keeps the native manifest byte limit for v2', () => {
    const text = JSON.stringify(bridgeNative(host))
    expect(
      verifyNativePluginManifest(fixture(host, text.padEnd(64 * 1024, ' '), { schemaVersion: 2 }))
    ).toEqual(expected)
    rejects(fixture(host, text.padEnd(64 * 1024 + 1, ' '), { schemaVersion: 2 }))
  })

  it('rejects duplicate permission keys even when the last value matches the signed origin', () => {
    const key = host === 'figma' ? 'allowedDomains' : 'domains'
    const text = JSON.stringify(bridgeNative(host)).replace(
      `"${key}":["${bridgeOrigin}"]`,
      `"${key}":["*"],"${key}":["${bridgeOrigin}"]`
    )
    rejects(fixture(host, text, { schemaVersion: 2 }))
  })

  it('leaves signed scripts, HTML and configuration opaque and never fetches or executes them', () => {
    const fetch = vi.fn(() => {
      throw new Error('must not fetch')
    })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('nativeManifestExecuted', false)
    const pkg = fixture(
      host,
      {
        ...bridgeNative(host),
        main: host === 'figma' ? 'bridge-main.js' : 'bridge-ui.html',
        ...(host === 'figma' ? { ui: 'bridge-ui.html' } : {})
      },
      {
        schemaVersion: 2,
        extraFiles: [
          ['native/bridge-main.js', 'globalThis.nativeManifestExecuted = true;'],
          ['native/bridge-ui.html', '<script src="runtime-config.js"></script>'],
          ['native/runtime-config.js', `globalThis.bridgeOrigin = ${JSON.stringify(bridgeOrigin)};`]
        ]
      }
    )
    expect(verifyNativePluginManifest(pkg)).toEqual(expected)
    expect(fetch).not.toHaveBeenCalled()
    expect(Reflect.get(globalThis, 'nativeManifestExecuted')).toBe(false)
  })

  it.each(['origin', 'native/manifest.json', 'native/code.js', 'native/runtime-config.js'])(
    'verifies the v2 signature over %s before native policy checks',
    (target) => {
      const pkg = fixture(host, bridgeNative(host), {
        schemaVersion: 2,
        extraFiles: [['native/runtime-config.js', 'void 0;']]
      })
      expect(verifyNativePluginManifest(pkg)).toEqual(expected)
      if (target === 'origin') {
        pkg.manifest.bridge!.origin = 'http://127.0.0.1:43128'
      } else {
        const file = pkg.files.find((file) => file.path === target)!
        const bytes = Buffer.from(Buffer.from(file.contentBase64, 'base64').toString() + ' ')
        file.bytes = bytes.length
        file.sha256 = hash(bytes)
        file.contentBase64 = bytes.toString('base64')
        const asset = pkg.manifest.assets.find((asset) => asset.path === target)!
        asset.sizeBytes = file.bytes
        asset.sha256 = file.sha256
        pkg.manifest.provenance.artifactSha256 = hash(canonicalFigPluginPackageIndex(pkg))
      }
      expect(() => verifyFigPluginPackage(pkg, publicKeyPem)).toThrow(
        'FIGPLUGIN package signature is invalid.'
      )
    }
  )
})

describe('Figma v2 bridge-specific permissions', () => {
  it('accepts an absent UI and explicitly empty development allowlist', () => {
    const native = bridgeFigma()
    Reflect.deleteProperty(native, 'ui')
    expect(
      verifyNativePluginManifest(
        fixture(
          'figma',
          { ...native, networkAccess: { ...native.networkAccess, devAllowedDomains: [] } },
          { schemaVersion: 2 }
        )
      ).kind
    ).toBe('figma-development')
  })

  it.each([
    { reasoning: undefined },
    { reasoning: '' },
    { reasoning: ' ' },
    { reasoning: 'x'.repeat(257) },
    { reasoning: 'Connect to arbitrary websites.' },
    { reasoning: 1 },
    { devAllowedDomains: [bridgeOrigin] },
    { devAllowedDomains: ['none'] },
    { devAllowedDomains: ['*'] },
    { devAllowedDomains: null },
    { unknown: true },
    { token: 'secret' }
  ])('rejects broadened or misleading networkAccess %j', (fields) => {
    rejects(
      fixture(
        'figma',
        { ...bridgeFigma(), networkAccess: { ...bridgeFigma().networkAccess, ...fields } },
        { schemaVersion: 2 }
      )
    )
  })

  it.each(['enableProposedApi', 'enablePrivatePluginApi'])('still rejects %s', (field) => {
    rejects(fixture('figma', { ...bridgeFigma(), [field]: true }, { schemaVersion: 2 }))
  })

  it('requires networkAccess in v2', () => {
    const native = bridgeFigma()
    Reflect.deleteProperty(native, 'networkAccess')
    rejects(fixture('figma', native, { schemaVersion: 2 }))
  })
})

describe('Photoshop v2 bridge-specific permissions', () => {
  it('accepts only optional plugin-local filesystem access alongside the bridge grant', () => {
    expect(
      verifyNativePluginManifest(
        fixture(
          'photoshop',
          {
            ...bridgePhotoshop(),
            requiredPermissions: {
              ...bridgePhotoshop().requiredPermissions,
              localFileSystem: 'plugin'
            }
          },
          { schemaVersion: 2 }
        )
      ).kind
    ).toBe('photoshop-uxp-development')
  })

  it.each([
    { network: undefined },
    { network: {} },
    { network: { domains: [bridgeOrigin], unknown: true } },
    { localFileSystem: 'fullAccess' },
    { localFileSystem: 'request' },
    { localFileSystem: 'none' },
    { shell: true },
    { fullScriptingAccess: true },
    { allowCodeGenerationFromStrings: true },
    { clipboard: 'readAndWrite' },
    { ipc: { enablePluginCommunication: true } },
    { webview: { allow: 'yes', domains: [bridgeOrigin] } },
    { launchProcess: { schemes: ['https'], extensions: ['.exe'] } },
    { unknown: true },
    { token: 'secret' }
  ])('rejects missing or escalated requiredPermissions %j', (permissions) => {
    rejects(
      fixture(
        'photoshop',
        {
          ...bridgePhotoshop(),
          requiredPermissions: { ...bridgePhotoshop().requiredPermissions, ...permissions }
        },
        { schemaVersion: 2 }
      )
    )
  })

  it('requires requiredPermissions in v2', () => {
    const native = bridgePhotoshop()
    Reflect.deleteProperty(native, 'requiredPermissions')
    rejects(fixture('photoshop', native, { schemaVersion: 2 }))
  })
})
