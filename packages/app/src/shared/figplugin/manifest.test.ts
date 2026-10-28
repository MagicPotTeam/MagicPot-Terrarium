import { describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_BRIDGE_MANIFEST_VERSION,
  FIGPLUGIN_MAX_CONFIG_BYTES,
  FIGPLUGIN_MAX_CONCURRENT_CALLS,
  FIGPLUGIN_MAX_PAYLOAD_BYTES,
  FIGPLUGIN_MAX_TIMEOUT_MS,
  FIGPLUGIN_SCHEMA_VERSION,
  canonicalizeFigPluginPath,
  canonicalFigPluginJson,
  canonicalFigPluginRequest,
  FigPluginDesktopBridgeOriginSchema,
  FigPluginManifestSchema,
  FigPluginSignatureValueSchema,
  FigPluginVersionSchema,
  measureFigPluginConfigBytes,
  validateFigPluginManifest,
  type FigPluginManifestInput
} from './manifest'
import {
  FIGPLUGIN_PACKAGE_FORMAT,
  FigPluginPackageSchema,
  getFigPluginPackageSigningPayload
} from './package'

const validManifest = (overrides: Record<string, unknown> = {}): FigPluginManifestInput => ({
  schemaVersion: 1,
  id: 'demo.figplugin',
  name: 'Demo FIGPLUGIN',
  version: '1.2.3',
  host: 'figma',
  entryPath: 'plugin/main.js',
  capabilities: ['dialogue', 'asset-transfer', 'result-transfer'],
  permissions: {
    dialogue: 'prompt',
    backgroundRemoval: 'none',
    assetTransfer: 'read',
    resultTransfer: 'write',
    filesystem: 'none',
    network: 'none'
  },
  limits: {
    maxPayloadBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES,
    maxResultBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES,
    maxConfigBytes: 16 * 1024,
    maxCallTimeoutMs: 60_000,
    maxConcurrentCalls: 1
  },
  provenance: {
    publisherId: 'magicpot',
    publisherName: 'MagicPot',
    source: 'official',
    artifactSha256: 'a'.repeat(64),
    sourceUrl: 'https://example.com/plugins/demo',
    issuedAt: '2026-01-01T00:00:00.000Z'
  },
  signature: {
    algorithm: 'ed25519',
    keyId: 'magicpot-release',
    value: 'b'.repeat(128),
    signedAt: '2026-01-01T00:00:00.000Z'
  },
  assets: [
    {
      id: 'input-image',
      path: 'assets/input.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      sha256: 'c'.repeat(64)
    }
  ],
  ...overrides
})

const bridgeManifest = (overrides: Record<string, unknown> = {}): FigPluginManifestInput =>
  validManifest({
    schemaVersion: FIGPLUGIN_BRIDGE_MANIFEST_VERSION,
    entryPath: 'plugin/manifest.json',
    capabilities: ['dialogue', 'asset-transfer'],
    permissions: {
      dialogue: 'prompt',
      assetTransfer: 'read',
      network: 'desktop-bridge'
    },
    bridge: { protocol: 1, origin: 'http://127.0.0.1:43123' },
    ...overrides
  })

// Shape-only package fixture; signature trust is tested by the main-process verifier.
const packageFixture = (manifest: FigPluginManifestInput) =>
  FigPluginPackageSchema.parse({
    format: FIGPLUGIN_PACKAGE_FORMAT,
    manifest: {
      ...manifest,
      assets: [{ id: 'entry', path: manifest.entryPath, sizeBytes: 1, sha256: 'c'.repeat(64) }]
    },
    files: [
      {
        path: manifest.entryPath,
        bytes: 1,
        sha256: 'c'.repeat(64),
        contentBase64: 'AA=='
      }
    ]
  })

describe('FIGPLUGIN manifest contract', () => {
  it.each(['1.2.3-0', '1.2.3-00alpha', '1.2.3-alpha-beta.1+build.01', '0.0.0-0.--.---'])(
    'accepts unambiguous semantic version %s',
    (version) => {
      expect(FigPluginVersionSchema.parse(version)).toBe(version)
    }
  )
  it.each(['1.2.3-01', '1.2.3-alpha..1', `0.0.0-0.${'--.'.repeat(30)}!`])(
    'rejects malformed semantic version %s without ambiguous backtracking',
    (version) => {
      expect(FigPluginVersionSchema.safeParse(version).success).toBe(false)
    }
  )

  it('rejects long untrusted versions before running the semantic-version regular expression', () => {
    const original = RegExp.prototype.test
    const tested: number[] = []
    const spy = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (
      this: RegExp,
      text: string
    ) {
      // Zod 4 counts Unicode code points with a bounded linear surrogate check.
      // Only the semantic-version matcher is prohibited before the size gate.
      if (this.source.startsWith('^(0|[1-9]')) tested.push(text.length)
      return original.call(this, text)
    })
    try {
      const result = FigPluginVersionSchema.safeParse(`1.0.0-${'a'.repeat(64 * 1024)}!`)
      expect(result.success).toBe(false)
      expect(tested.some((length) => length > 128)).toBe(false)
    } finally {
      spy.mockRestore()
    }
    expect(FigPluginVersionSchema.parse(' 1.2.3-beta.1+fixture ')).toBe('1.2.3-beta.1+fixture')
    expect(FigPluginVersionSchema.safeParse(`1.0.0-${'😀'.repeat(128)}`).success).toBe(false)
  })

  it('accepts a valid versioned manifest and normalizes bounded metadata', () => {
    const result = validateFigPluginManifest(validManifest())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.version).toBe('1.2.3')
      expect(result.value.provenance.artifactSha256).toBe('a'.repeat(64))
      expect(result.value.assets[0].sha256).toBe('c'.repeat(64))
    }
  })

  it('preserves v1 parsed JSON, defaults and canonical signing/request material', () => {
    expect(FIGPLUGIN_SCHEMA_VERSION).toBe(1)
    expect(FIGPLUGIN_BRIDGE_MANIFEST_VERSION).toBe(2)
    const explicit = validManifest()
    const defaulted = validManifest({
      capabilities: ['dialogue'],
      permissions: { dialogue: 'prompt' },
      limits: {}
    })
    delete defaulted.assets
    const expectedDefaulted = validManifest({
      capabilities: ['dialogue'],
      permissions: {
        dialogue: 'prompt',
        backgroundRemoval: 'none',
        assetTransfer: 'none',
        resultTransfer: 'none',
        filesystem: 'none',
        network: 'none'
      },
      assets: []
    })

    for (const [input, expected] of [
      [explicit, explicit],
      [defaulted, expectedDefaulted]
    ]) {
      const parsed = FigPluginManifestSchema.parse(input)
      expect(parsed).toStrictEqual(expected)
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(expected))
      expect(Object.hasOwn(parsed, 'bridge')).toBe(false)
      expect(canonicalFigPluginJson(parsed)).toBe(canonicalFigPluginJson(expected))
      expect(canonicalFigPluginRequest({ manifest: parsed })).toBe(
        canonicalFigPluginRequest({ manifest: expected })
      )
      const pkg = packageFixture(input)
      expect(getFigPluginPackageSigningPayload(pkg)).toBe(
        `${FIGPLUGIN_PACKAGE_FORMAT}\n${canonicalFigPluginJson({
          ...expected,
          assets: pkg.manifest.assets,
          signature: {
            algorithm: 'ed25519',
            keyId: 'magicpot-release',
            signedAt: '2026-01-01T00:00:00.000Z'
          }
        })}`
      )
    }
    const withoutEntry = validManifest()
    delete withoutEntry.entryPath
    expect(FigPluginManifestSchema.parse(withoutEntry)).toStrictEqual(withoutEntry)
  })

  it.each(['figma', 'photoshop'] as const)(
    'accepts an explicit signed v2 desktop bridge declaration for %s',
    (host) => {
      const input = bridgeManifest({ host, limits: {} })
      const parsed = FigPluginManifestSchema.parse(input)
      expect(parsed).toStrictEqual({
        ...input,
        permissions: {
          dialogue: 'prompt',
          backgroundRemoval: 'none',
          assetTransfer: 'read',
          resultTransfer: 'none',
          filesystem: 'none',
          network: 'desktop-bridge'
        },
        limits: validManifest().limits
      })
      expect(parsed.bridge).toEqual({ protocol: 1, origin: 'http://127.0.0.1:43123' })
    }
  )

  it('allows additional signed capabilities only with matching permissions, not runtime activation', () => {
    expect(
      validateFigPluginManifest(
        bridgeManifest({
          capabilities: ['dialogue', 'asset-transfer', 'background-removal', 'result-transfer'],
          permissions: {
            dialogue: 'prompt',
            assetTransfer: 'read',
            backgroundRemoval: 'prompt',
            resultTransfer: 'write',
            network: 'desktop-bridge'
          }
        })
      ).ok
    ).toBe(true)
  })

  it('never upgrades a v1 network denial through a bridge declaration or permission', () => {
    const legacy = validManifest()
    for (const override of [
      { bridge: bridgeManifest().bridge },
      { permissions: { ...legacy.permissions, network: 'desktop-bridge' } },
      {
        bridge: bridgeManifest().bridge,
        permissions: { ...legacy.permissions, network: 'desktop-bridge' }
      }
    ]) {
      expect(validateFigPluginManifest({ ...legacy, ...override }).ok).toBe(false)
    }
  })

  it.each([
    ['missing bridge', { bridge: undefined }],
    ['null bridge', { bridge: null }],
    ['network none', { permissions: { ...bridgeManifest().permissions, network: 'none' } }],
    ['implicit network denial', { permissions: { dialogue: 'prompt', assetTransfer: 'read' } }],
    ['filesystem access', { permissions: { ...bridgeManifest().permissions, filesystem: 'read' } }],
    ['missing entryPath', { entryPath: undefined }],
    ['unsupported schema version', { schemaVersion: 3 }],
    [
      'missing dialogue',
      {
        capabilities: ['asset-transfer'],
        permissions: { assetTransfer: 'read', network: 'desktop-bridge' }
      }
    ],
    [
      'missing asset-transfer',
      { capabilities: ['dialogue'], permissions: { dialogue: 'prompt', network: 'desktop-bridge' } }
    ],
    ['dialogue denial', { permissions: { ...bridgeManifest().permissions, dialogue: 'none' } }],
    [
      'asset-transfer denial',
      { permissions: { ...bridgeManifest().permissions, assetTransfer: 'none' } }
    ],
    [
      'undeclared result transfer',
      { permissions: { ...bridgeManifest().permissions, resultTransfer: 'write' } }
    ],
    [
      'undeclared background removal',
      { permissions: { ...bridgeManifest().permissions, backgroundRemoval: 'prompt' } }
    ],
    ['missing protocol', { bridge: { origin: 'http://127.0.0.1:43123' } }],
    ['missing origin', { bridge: { protocol: 1 } }],
    ['unsupported protocol', { bridge: { protocol: 2, origin: 'http://127.0.0.1:43123' } }],
    ['coerced protocol', { bridge: { protocol: '1', origin: 'http://127.0.0.1:43123' } }]
  ])('rejects a v2 declaration with %s', (_label, override) => {
    expect(validateFigPluginManifest(bridgeManifest(override)).ok).toBe(false)
  })

  it.each([1024, 43123, 65535])('accepts the exact loopback origin on port %i', (port) => {
    const origin = `http://127.0.0.1:${port}`
    expect(FigPluginDesktopBridgeOriginSchema.parse(origin)).toBe(origin)
    expect(validateFigPluginManifest(bridgeManifest({ bridge: { protocol: 1, origin } })).ok).toBe(
      true
    )
  })

  it.each([
    'http://example.com:43123',
    'https://example.com:43123',
    'http://192.168.1.1:43123',
    'http://0.0.0.0:43123',
    'http://127.0.0.2:43123',
    'http://localhost.invalid:43123',
    'http://[::1]:43123',
    'http://127.1:43123',
    'http://2130706433:43123',
    'http://0177.0.0.1:43123',
    'http://127.0.0.1.:43123',
    'http://%31%32%37.0.0.1:43123',
    'http://127%2e0%2e0%2e1:43123',
    'http://*:43123',
    'http://127.0.0.1:*',
    'https://127.0.0.1:43123',
    'HTTP://127.0.0.1:43123',
    'http://user:pass@127.0.0.1:43123',
    'http://127.0.0.1:43123@evil.test',
    'http://127.0.0.1:43123/',
    'http://127.0.0.1:43123/path',
    'http://127.0.0.1:43123?query',
    'http://127.0.0.1:43123#hash',
    'http://127.0.0.1:43123\\',
    'http://127.0.0.1:43123%2f',
    'http://127.0.0.1:043123',
    'http://127.0.0.1:01024',
    'http://127.0.0.1:+1024',
    'http://127.0.0.1:1e4',
    'http://127.0.0.1:1024.0',
    'http://127.0.0.1:1023',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:99999',
    'http://127.0.0.1',
    ' http://127.0.0.1:43123',
    'http://127.0.0.1:43123 ',
    'http://127.0.0.1:43123\n',
    'http://127.0.0.1:43123\r\n',
    'http://127.0.0.1:43123\u0000'
  ])('rejects noncanonical bridge origin %j without URL normalization', (origin) => {
    expect(FigPluginDesktopBridgeOriginSchema.safeParse(origin).success).toBe(false)
    expect(validateFigPluginManifest(bridgeManifest({ bridge: { protocol: 1, origin } })).ok).toBe(
      false
    )
  })

  it('keeps every signed v2 nested declaration strict', () => {
    const input = bridgeManifest()
    for (const key of ['permissions', 'limits', 'provenance', 'signature', 'bridge'] as const) {
      expect(
        validateFigPluginManifest({ ...input, [key]: { ...input[key], unknown: true } }).ok
      ).toBe(false)
    }
    expect(validateFigPluginManifest({ ...input, unknown: true }).ok).toBe(false)
    expect(
      validateFigPluginManifest({ ...input, assets: [{ ...input.assets![0], unknown: true }] }).ok
    ).toBe(false)
  })

  it('binds bridge origin tampering to canonical signing and request material', () => {
    const pkg = packageFixture(bridgeManifest())
    const changed = FigPluginPackageSchema.parse({
      ...pkg,
      manifest: { ...pkg.manifest, bridge: { protocol: 1, origin: 'http://127.0.0.1:43124' } }
    })
    expect(getFigPluginPackageSigningPayload(pkg)).toContain(
      '"bridge":{"origin":"http://127.0.0.1:43123","protocol":1}'
    )
    expect(getFigPluginPackageSigningPayload(changed)).not.toBe(
      getFigPluginPackageSigningPayload(pkg)
    )
    expect(canonicalFigPluginRequest({ manifest: changed.manifest })).not.toBe(
      canonicalFigPluginRequest({ manifest: pkg.manifest })
    )
  })

  it.each([validManifest, bridgeManifest])(
    'retains identifier normalization and resource bounds',
    (fixture) => {
      expect(FigPluginManifestSchema.parse(fixture({ id: ` ${'a'.repeat(128)} ` })).id).toBe(
        'a'.repeat(128)
      )
      for (const id of ['', ' ', 'a'.repeat(129), 'unsafe id']) {
        expect(validateFigPluginManifest(fixture({ id })).ok).toBe(false)
      }
      for (const limits of [
        { maxPayloadBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES + 1 },
        { maxResultBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES + 1 },
        { maxConfigBytes: FIGPLUGIN_MAX_CONFIG_BYTES + 1 },
        { maxCallTimeoutMs: FIGPLUGIN_MAX_TIMEOUT_MS + 1 },
        { maxConcurrentCalls: FIGPLUGIN_MAX_CONCURRENT_CALLS + 1 },
        { maxPayloadBytes: 1024, maxResultBytes: 1025 },
        { maxPayloadBytes: 0 },
        { maxConcurrentCalls: 1.5 }
      ]) {
        expect(validateFigPluginManifest(fixture({ limits })).ok).toBe(false)
      }
      expect(
        validateFigPluginManifest(
          fixture({
            assets: [
              { id: 'same', path: 'assets/a.png' },
              { id: ' same ', path: 'assets/b.png' }
            ]
          })
        ).ok
      ).toBe(false)
    }
  )

  it.each([
    ['host', { host: 'illustrator' }],
    ['capability', { capabilities: ['shell'] }],
    ['path', { entryPath: '../main.js' }],
    ['absolute path', { entryPath: '/tmp/main.js' }],
    ['permissions', { permissions: { dialogue: 'full' } }],
    ['version', { version: 'v1' }],
    ['schema version without bridge', { schemaVersion: 2 }],
    [
      'signature',
      {
        signature: {
          algorithm: 'ed25519',
          keyId: 'key',
          value: 'bad',
          signedAt: '2026-01-01T00:00:00.000Z'
        }
      }
    ]
  ])('rejects invalid %s', (_label, override) => {
    expect(validateFigPluginManifest(validManifest(override)).ok).toBe(false)
  })

  it('rejects unknown fields, duplicate identifiers, and over-privileged declarations', () => {
    expect(validateFigPluginManifest(validManifest({ unknown: true })).ok).toBe(false)
    expect(
      validateFigPluginManifest(
        validManifest({
          capabilities: ['dialogue', 'dialogue'],
          permissions: {
            dialogue: 'prompt',
            backgroundRemoval: 'prompt',
            assetTransfer: 'read',
            resultTransfer: 'write',
            filesystem: 'none',
            network: 'none'
          },
          assets: [
            { id: 'same', path: 'assets/a.png', sizeBytes: 1 },
            { id: 'same', path: 'assets/b.png', sizeBytes: 1 }
          ]
        })
      ).ok
    ).toBe(false)
  })

  it('measures canonical JSON UTF-8 config bytes and rejects oversized config', () => {
    expect(measureFigPluginConfigBytes({ b: 'é', a: 1 })).toBe(
      new TextEncoder().encode('{"a":1,"b":"é"}').byteLength
    )
    expect(() =>
      measureFigPluginConfigBytes({ value: 'x'.repeat(FIGPLUGIN_MAX_CONFIG_BYTES) })
    ).toThrow('configuration exceeds the FIGPLUGIN bound')
  })

  it('accepts only canonical base64url pad bits without claiming signature trust', () => {
    for (const last of ['A', 'Q', 'g', 'w']) {
      const value = 'A'.repeat(85) + last
      expect(FigPluginSignatureValueSchema.safeParse(value).success).toBe(true)
      expect(FigPluginSignatureValueSchema.safeParse(value + '==').success).toBe(true)
    }
    for (const value of ['A'.repeat(85) + 'B', 'A'.repeat(85) + '_', 'A'.repeat(86) + '=']) {
      expect(FigPluginSignatureValueSchema.safeParse(value).success).toBe(false)
    }
  })

  it('omits only envelope retry metadata and retains nested business and signed fields', () => {
    const first = {
      requestId: 'one',
      requestedAt: '2026-01-01T00:00:00.000Z',
      consent: { grantedAt: '2026-01-01T00:00:00.000Z', granted: true },
      config: { nested: { requestedAt: 'one', requestId: 'business-id' } },
      manifest: { signature: { signedAt: '2026-01-01T00:00:00.000Z' } }
    }
    const key = canonicalFigPluginRequest(first)
    expect(
      canonicalFigPluginRequest({
        ...first,
        requestId: 'two',
        requestedAt: '2026-01-02T00:00:00.000Z',
        consent: { ...first.consent, grantedAt: '2026-01-02T00:00:00.000Z' }
      })
    ).toBe(key)
    expect(
      canonicalFigPluginRequest({
        ...first,
        config: { nested: { requestedAt: 'two', requestId: 'business-id' } }
      })
    ).not.toBe(key)
    expect(
      canonicalFigPluginRequest({
        ...first,
        manifest: { signature: { signedAt: '2026-01-02T00:00:00.000Z' } }
      })
    ).not.toBe(key)
    expect(first.requestId).toBe('one')
    const getter = vi.fn(() => 'must-not-run')
    const accessor = Object.defineProperty({}, 'config', { enumerable: true, get: getter })
    expect(() => canonicalFigPluginRequest(accessor)).toThrow('accessor')
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects Windows device names and canonical duplicate asset paths', () => {
    expect(canonicalizeFigPluginPath('Assets/Image.PNG')).toBe('assets/image.png')
    expect(canonicalizeFigPluginPath('assets/image.png.')).toBeUndefined()
    for (const name of ['CON', 'com1.txt', 'Lpt9', 'aux.']) {
      expect(canonicalizeFigPluginPath(`assets/${name}`)).toBeUndefined()
    }
    expect(
      validateFigPluginManifest(
        validManifest({
          assets: [
            { id: 'one', path: 'assets/Image.PNG', sizeBytes: 1 },
            { id: 'two', path: 'ASSETS/image.png', sizeBytes: 1 }
          ]
        })
      ).ok
    ).toBe(false)
  })

  it('rejects payload and manifest size limits above the contract bound', () => {
    expect(
      validateFigPluginManifest(
        validManifest({
          limits: {
            maxPayloadBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES + 1,
            maxResultBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES,
            maxConfigBytes: 16 * 1024,
            maxCallTimeoutMs: 60_000,
            maxConcurrentCalls: 1
          },
          assets: [
            { id: 'large', path: 'assets/a.bin', sizeBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES + 1 }
          ]
        })
      ).ok
    ).toBe(false)
  })
})
