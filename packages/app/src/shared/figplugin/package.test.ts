import { describe, expect, it, vi } from 'vitest'
import { ServiceValidationError } from '../api/apiUtils/serviceValidation'
import { canonicalFigPluginJson, type FigPluginHost } from './manifest'
import {
  FIGPLUGIN_PACKAGE_FORMAT,
  MAX_CONTENT_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  FigPluginPackageSchema,
  canonicalFigPluginPackageIndex,
  getFigPluginPackageSigningPayload,
  parseFigPluginPackageText,
  type FigPluginPackageFile,
  type FigPluginPackageInput
} from './package'

// Hashes/signatures are shape-only fixtures, never evidence of cryptographic trust.
const file = (path: string, bytes = 1): FigPluginPackageFile => ({
  path,
  bytes,
  sha256: 'a'.repeat(64),
  contentBase64: 'AAAA'.repeat(Math.floor(bytes / 3)) + ['', 'AA==', 'AAA='][bytes % 3]
})

const fixture = (
  host: FigPluginHost = 'figma',
  files = [file('plugin/main.js'), file('assets/data.json', 2)]
): FigPluginPackageInput => ({
  format: FIGPLUGIN_PACKAGE_FORMAT,
  manifest: {
    schemaVersion: 1,
    id: 'demo.figplugin',
    name: '插件 café 🌱',
    version: '1.2.3',
    host,
    entryPath: files[0]?.path,
    capabilities: ['dialogue'],
    permissions: { dialogue: 'prompt' },
    limits: {},
    provenance: {
      publisherId: 'demo.publisher',
      publisherName: '演示 Publisher',
      source: 'user-provided',
      artifactSha256: 'c'.repeat(64),
      issuedAt: '2026-01-01T00:00:00.000Z'
    },
    signature: {
      algorithm: 'ed25519',
      keyId: 'separately-trusted-key',
      value: 'b'.repeat(128),
      signedAt: '2026-01-01T00:00:00.000Z'
    },
    assets: files.map(({ path, bytes, sha256 }, index) => ({
      id: `unrelated-id-${index}`,
      path,
      sizeBytes: bytes,
      sha256
    }))
  },
  files
})

const issues = (value: unknown) => {
  const result = FigPluginPackageSchema.safeParse(value)
  expect(result.success).toBe(false)
  if (result.success) throw new Error('Expected an invalid package fixture')
  return result.error.issues
}

const expectFixedError = (text: string): void => {
  let caught: unknown
  try {
    parseFigPluginPackageText(text)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ServiceValidationError)
  const error = caught as ServiceValidationError
  expect(error.message).toBe('Invalid FIGPLUGIN package')
  expect(error.code).toBe('VALIDATION_ERROR')
  expect(error.issues).toEqual([])
  expect(error.cause).toBeUndefined()
  expect(error.toJSON()).toEqual(
    new ServiceValidationError('FIGPLUGIN package', undefined, []).toJSON()
  )
  expect(JSON.stringify(error)).not.toContain('raw-secret')
}

describe('FIGPLUGIN JSON package contract', () => {
  it('exports the fixed format and resource bounds', () => {
    expect(FIGPLUGIN_PACKAGE_FORMAT).toBe('magicpot.figplugin.package.v1')
    expect(MAX_ENVELOPE_BYTES).toBe(12 * 1024 * 1024)
    expect(MAX_CONTENT_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_FILE_BYTES).toBe(2 * 1024 * 1024)
    expect(MAX_FILES).toBe(64)
  })

  it.each(['figma', 'photoshop'] as const)(
    'accepts a Unicode-named %s package with defaults',
    (host) => {
      const input = fixture(host)
      const pkg = parseFigPluginPackageText(JSON.stringify(input))
      expect(pkg.manifest.host).toBe(host)
      expect(pkg.manifest.name).toBe('插件 café 🌱')
      expect(pkg.manifest.entryPath).toBe('plugin/main.js')
      expect(pkg.files).toEqual(input.files)
      expect(pkg.manifest.permissions).toEqual({
        dialogue: 'prompt',
        backgroundRemoval: 'none',
        assetTransfer: 'none',
        resultTransfer: 'none',
        filesystem: 'none',
        network: 'none'
      })
      expect(pkg.manifest.limits.maxPayloadBytes).toBe(MAX_CONTENT_BYTES)
      expect(pkg.manifest.limits.maxConcurrentCalls).toBe(1)
    }
  )

  it('matches assets by path, bytes and normalized hash, not IDs or array positions', () => {
    const input = fixture()
    input.manifest.provenance.artifactSha256 = 'C'.repeat(64)
    input.manifest.assets!.reverse()
    input.manifest.assets!.forEach((asset, index) => {
      asset.id = `different-id-${index}`
      asset.sha256 = 'A'.repeat(64)
    })
    const pkg = FigPluginPackageSchema.parse(input)
    expect(pkg.manifest.provenance.artifactSha256).toBe('c'.repeat(64))
    expect(pkg.manifest.assets.every((asset) => asset.sha256 === 'a'.repeat(64))).toBe(true)
    expect(input.manifest.assets![0].sha256).toBe('A'.repeat(64))
  })

  it.each(['publicKey', 'config', 'model', 'archive'])(
    'rejects the extra envelope field %s',
    (key) => {
      expect(FigPluginPackageSchema.safeParse({ ...fixture(), [key]: 'raw-secret' }).success).toBe(
        false
      )
    }
  )

  it('rejects unknown nested fields and non-JSON-package formats', () => {
    const input = fixture()
    expect(FigPluginPackageSchema.safeParse({ ...input, format: 'zip' }).success).toBe(false)
    expect(
      FigPluginPackageSchema.safeParse({
        ...input,
        files: [{ ...input.files[0], type: 'symlink' }]
      }).success
    ).toBe(false)
    for (const key of ['publicKey', 'config', 'model']) {
      expect(
        FigPluginPackageSchema.safeParse({ ...input, manifest: { ...input.manifest, [key]: {} } })
          .success
      ).toBe(false)
    }
    expect(
      FigPluginPackageSchema.safeParse({
        ...input,
        manifest: {
          ...input.manifest,
          signature: { ...input.manifest.signature, publicKey: 'raw-secret' }
        }
      }).success
    ).toBe(false)
  })

  it.each([
    '../main.js',
    '/main.js',
    'C:/main.js',
    '\\server\\main.js',
    'plugin\\main.js',
    'plugin//main.js',
    'plugin/./main.js',
    'plugin/../main.js',
    'plugin/main.js.',
    'plugin/main.js ',
    ' plugin/main.js',
    'plugin/main.js\n',
    'plugin/main\u0000.js',
    'plugin/%2e%2e/main.js',
    'plugin/main:stream',
    'plugin/é.js',
    'plugin/文件.js',
    'CON',
    'con.txt',
    'plugin/PRN.json',
    'aux',
    'NuL.js',
    'COM1.txt',
    'lpt9',
    'plugin/COM9/main.js',
    'CONIN$',
    'CONOUT$',
    'COM¹.txt',
    '__proto__/main.js',
    'prototype',
    'Constructor/main.js',
    `${'a'.repeat(129)}.js`,
    `${'a'.repeat(127)}/`.repeat(5) + 'main.js'
  ])('rejects unsafe ASCII/Windows path %j', (path) => {
    expect(FigPluginPackageSchema.safeParse(fixture('figma', [file(path)])).success).toBe(false)
  })

  it.each([
    ['plugin/main.js', 'plugin/main.js'],
    ['plugin/Main.js', 'PLUGIN/main.JS']
  ])('rejects case-folded duplicate files %s and %s', (first, second) => {
    expect(issues(fixture('figma', [file(first), file(second)]))).toContainEqual(
      expect.objectContaining({
        path: ['files', 1, 'path'],
        message: 'duplicate package file path'
      })
    )
  })

  it.each([
    ['plugin', 'plugin/main.js'],
    ['PLUGIN/main.js', 'plugin'],
    ['assets/sub', 'ASSETS/SUB/deeper/file.json']
  ])('rejects ancestor file/directory collisions %s and %s', (first, second) => {
    expect(issues(fixture('figma', [file(first), file(second)]))).toContainEqual(
      expect.objectContaining({ message: 'file path collides with a directory' })
    )
  })

  it('allows shared directories and non-directory string prefixes', () => {
    const input = fixture('figma', [
      file('a'),
      file('a.js'),
      file('ab/main.js'),
      file('ab/data.json')
    ])
    expect(FigPluginPackageSchema.safeParse(input).success).toBe(true)
  })

  it.each([undefined, 'missing.js', 'PLUGIN/main.js'])(
    'requires an exact declared entryPath: %s',
    (entryPath) => {
      const input = fixture()
      input.manifest.entryPath = entryPath
      expect(FigPluginPackageSchema.safeParse(input).success).toBe(false)
    }
  )

  it('requires all files to have exactly one complete manifest asset declaration', () => {
    const mutations: Array<(input: FigPluginPackageInput) => void> = [
      (input) => {
        delete input.manifest.assets
      },
      (input) => {
        input.manifest.assets!.pop()
      },
      (input) => {
        input.manifest.assets!.push({
          id: 'extra',
          path: 'extra.js',
          sizeBytes: 1,
          sha256: 'a'.repeat(64)
        })
      },
      (input) => {
        input.manifest.assets![0].path = 'missing.js'
      },
      (input) => {
        input.manifest.assets![0].path = 'PLUGIN/main.js'
      },
      (input) => {
        delete input.manifest.assets![0].sizeBytes
      },
      (input) => {
        delete input.manifest.assets![0].sha256
      },
      (input) => {
        input.manifest.assets![0].sizeBytes = 2
      },
      (input) => {
        input.manifest.assets![0].sha256 = 'd'.repeat(64)
      },
      (input) => {
        input.manifest.assets![1] = { ...input.manifest.assets![0], id: 'duplicate-path' }
      }
    ]
    for (const mutate of mutations) {
      const input = fixture()
      mutate(input)
      expect(FigPluginPackageSchema.safeParse(input).success).toBe(false)
    }
  })

  it.each(['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(64) + '\n'])(
    'requires lowercase file hashes: %j',
    (sha256) => {
      const input = fixture()
      input.files[0].sha256 = sha256
      expect(FigPluginPackageSchema.safeParse(input).success).toBe(false)
    }
  )

  it.each([
    '',
    'not JSON raw-secret',
    '{"raw-secret":',
    'null',
    '[]',
    '42',
    '{"format":"raw-secret",}',
    '// raw-secret\n{}'
  ])('returns only a fixed validation error for invalid JSON/schema %j', expectFixedError)

  it('redacts unknown keys, content errors and signature errors', () => {
    expectFixedError(JSON.stringify({ ...fixture(), 'raw-secret': true }))
    const input = fixture()
    input.files[0].contentBase64 = 'raw-secret'
    expectFixedError(JSON.stringify(input))
    input.manifest.signature.value = 'raw-secret'
    expectFixedError(JSON.stringify(input))
    expectFixedError(null as unknown as string)
  })
})

describe('FIGPLUGIN base64 and resource budgets', () => {
  it.each([
    [1, 'AA=='],
    [1, 'AQ=='],
    [1, '/w=='],
    [2, 'AAA='],
    [2, '//8='],
    [3, 'AAAA'],
    [3, '////'],
    [4, 'AAAAAA==']
  ])('accepts canonical base64 for %i bytes: %s', (bytes, contentBase64) => {
    const input = fixture('figma', [{ ...file('main.js', bytes), contentBase64 }])
    expect(FigPluginPackageSchema.safeParse(input).success).toBe(true)
  })

  it.each([
    '',
    'A',
    'AA',
    'AAA',
    'AAAA=',
    'AA=',
    'AA===',
    '====',
    'A===',
    'AB==',
    'Af==',
    '/x==',
    'AAB=',
    'AAD=',
    '//9=',
    'AA==AAAA',
    'AA=A',
    'AA-_',
    'AA==\n',
    'AAA\n',
    'AA \n',
    ' AA==',
    'AA== ',
    'AA==\r\n',
    'ＡＡ=='
  ])('rejects noncanonical base64 including nonzero pad bits: %j', (contentBase64) => {
    const input = fixture()
    input.files[0].contentBase64 = contentBase64
    expect(FigPluginPackageSchema.safeParse(input).success).toBe(false)
  })

  it.each([0, -1, 1.5, MAX_FILE_BYTES + 1, NaN, Infinity])(
    'rejects invalid declared bytes: %s',
    (bytes) => {
      const input = fixture()
      input.files[0].bytes = bytes
      expect(FigPluginPackageSchema.safeParse(input).success).toBe(false)
    }
  )

  it('rejects a content length mismatch', () => {
    const input = fixture()
    input.files[0].contentBase64 = 'AAAA'
    expect(issues(input)).toContainEqual(expect.objectContaining({ path: ['files', 0, 'bytes'] }))
  })

  it('accepts 64 files/assets and rejects 65 or empty files', () => {
    const input = fixture(
      'figma',
      Array.from({ length: MAX_FILES }, (_, index) => file(`files/${index}.js`))
    )
    expect(FigPluginPackageSchema.safeParse(input).success).toBe(true)
    const tooMany = fixture('figma', [...input.files, file('extra.js')])
    expect(issues(tooMany)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['files'], code: 'too_big' }),
        expect.objectContaining({ path: ['manifest', 'assets'], code: 'too_big' })
      ])
    )
    expect(FigPluginPackageSchema.safeParse(fixture('figma', [])).success).toBe(false)
  })

  it('accepts exact 2 MiB file/8 MiB content limits and rejects one more byte', () => {
    const input = fixture(
      'figma',
      Array.from({ length: 4 }, (_, index) => file(`files/${index}.js`, MAX_FILE_BYTES))
    )
    expect(parseFigPluginPackageText(JSON.stringify(input)).files).toHaveLength(4)
    expect(issues(fixture('figma', [...input.files, file('extra.js')]))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'declared content exceeds package bound' }),
        expect.objectContaining({ message: 'encoded content exceeds package bound' })
      ])
    )
  })

  it('bounds actual bytes even when excess decoded data has the same padded base64 length', () => {
    const oversized = file('main.js', MAX_FILE_BYTES + 1)
    expect(oversized.contentBase64.length).toBe(
      file('main.js', MAX_FILE_BYTES).contentBase64.length
    )
    oversized.bytes = MAX_FILE_BYTES
    expect(FigPluginPackageSchema.safeParse(fixture('figma', [oversized])).success).toBe(false)
    const muchLarger = file('main.js', MAX_CONTENT_BYTES + 1)
    muchLarger.bytes = 1
    expect(FigPluginPackageSchema.safeParse(fixture('figma', [muchLarger])).success).toBe(false)
  })

  it('independently bounds declared and actual aggregate bytes without decoding', () => {
    const decodedTooLarge = fixture(
      'figma',
      Array.from({ length: 5 }, (_, index) => ({
        ...file(`files/${index}.js`, MAX_FILE_BYTES),
        bytes: 1
      }))
    )
    expect(issues(decodedTooLarge)).toContainEqual(
      expect.objectContaining({ message: 'encoded content exceeds package bound' })
    )
    const declaredTooLarge = fixture(
      'figma',
      Array.from({ length: 5 }, (_, index) => ({
        ...file(`files/${index}.js`),
        bytes: MAX_FILE_BYTES
      }))
    )
    expect(issues(declaredTooLarge)).toContainEqual(
      expect.objectContaining({ message: 'declared content exceeds package bound' })
    )
  })

  it('validates without Node Buffer or a base64 decoder', () => {
    const input = JSON.stringify(fixture())
    let parsed: unknown
    vi.stubGlobal('Buffer', undefined)
    vi.stubGlobal('atob', () => {
      throw new Error('Decoder must not run')
    })
    try {
      parsed = parseFigPluginPackageText(input)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(parsed).toEqual(FigPluginPackageSchema.parse(fixture()))
  })

  it('caps the UTF-8 envelope at exactly 12 MiB before JSON parsing', () => {
    const text = JSON.stringify(fixture())
    const atLimit =
      text + ' '.repeat(MAX_ENVELOPE_BYTES - new TextEncoder().encode(text).byteLength)
    expect(atLimit.length).toBeLessThan(MAX_ENVELOPE_BYTES)
    expect(parseFigPluginPackageText(atLimit).manifest.host).toBe('figma')
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expectFixedError(atLimit + ' ')
      expectFixedError(' '.repeat(MAX_ENVELOPE_BYTES + 1))
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it.each([
    ['é', 2],
    ['汉', 3],
    ['🌱', 4],
    ['\ud800', 3]
  ] as const)('measures UTF-8 %j without allocating decoded content', (character, bytes) => {
    const text = `{"name":"${character.repeat(Math.floor(MAX_ENVELOPE_BYTES / bytes))}"}`
    expect(text.length).toBeLessThan(MAX_ENVELOPE_BYTES)
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expectFixedError(text)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })
})

describe('FIGPLUGIN canonical digest and signing material', () => {
  it('defines the exact index bytes with code-unit path order, not locale order', () => {
    const input = fixture('figma', [file('z.js'), file('a.js'), file('B.js'), file('a-1.js')])
    const pkg = FigPluginPackageSchema.parse(input)
    const sha256 = 'a'.repeat(64)
    const records = ['B.js', 'a-1.js', 'a.js', 'z.js']
      .map((path) => `{"bytes":1,"path":"${path}","sha256":"${sha256}"}`)
      .join(',')
    const expected = `{"files":[${records}],"format":"magicpot.figplugin.package.v1"}`
    const before = JSON.stringify(pkg)
    expect(canonicalFigPluginPackageIndex(pkg)).toBe(expected)
    expect(canonicalFigPluginPackageIndex({ ...pkg, files: [...pkg.files].reverse() })).toBe(
      expected
    )
    expect(JSON.stringify(pkg)).toBe(before)
  })

  it('excludes the manifest and raw content from the index to avoid a self-hash', () => {
    const pkg = FigPluginPackageSchema.parse(fixture())
    const index = canonicalFigPluginPackageIndex(pkg)
    const changed = structuredClone(pkg)
    changed.manifest.name = 'Different plugin'
    changed.manifest.signature.value = 'd'.repeat(128)
    changed.manifest.provenance.artifactSha256 = 'e'.repeat(64)
    changed.files[0].contentBase64 = 'AQ=='
    expect(canonicalFigPluginPackageIndex(changed)).toBe(index)
    for (const field of ['manifest', 'contentBase64', 'signature', 'artifactSha256']) {
      expect(index).not.toContain(field)
    }
    for (const next of [
      file('renamed.js'),
      file('plugin/main.js', 2),
      { ...file('plugin/main.js'), sha256: 'd'.repeat(64) }
    ]) {
      const modified = FigPluginPackageSchema.parse(fixture('figma', [next, pkg.files[1]]))
      expect(canonicalFigPluginPackageIndex(modified)).not.toBe(index)
    }
  })

  it('signs a domain-separated defaulted canonical manifest, omitting only signature.value', () => {
    const input = fixture()
    const pkg = FigPluginPackageSchema.parse(input)
    const before = JSON.stringify(pkg)
    const { algorithm, keyId, signedAt } = pkg.manifest.signature
    const expected = `${FIGPLUGIN_PACKAGE_FORMAT}\n${canonicalFigPluginJson({ ...pkg.manifest, signature: { algorithm, keyId, signedAt } })}`
    expect(getFigPluginPackageSigningPayload(pkg)).toBe(expected)
    expect(getFigPluginPackageSigningPayload(parseFigPluginPackageText(JSON.stringify(pkg)))).toBe(
      expected
    )
    input.manifest.signature.value = 'd'.repeat(128)
    input.manifest.provenance.artifactSha256 = 'C'.repeat(64)
    input.manifest.assets!.forEach((asset) => {
      asset.sha256 = 'A'.repeat(64)
    })
    const reordered = Object.fromEntries(Object.entries(input).reverse())
    expect(getFigPluginPackageSigningPayload(FigPluginPackageSchema.parse(reordered))).toBe(
      expected
    )
    expect(expected).toContain('"artifactSha256":"' + 'c'.repeat(64) + '"')
    expect(expected).toContain('"algorithm":"ed25519"')
    expect(expected).toContain('"signedAt":"2026-01-01T00:00:00.000Z"')
    expect(expected).not.toContain('"value":')
    expect(JSON.stringify(pkg)).toBe(before)
  })

  it('binds permissions, limits, entry, host, provenance and signature metadata', () => {
    const payload = getFigPluginPackageSigningPayload(FigPluginPackageSchema.parse(fixture()))
    const mutations: Array<(input: FigPluginPackageInput) => void> = [
      (input) => {
        input.manifest.capabilities.push('asset-transfer')
        input.manifest.permissions.assetTransfer = 'read'
      },
      (input) => {
        input.manifest.limits.maxConcurrentCalls = 2
      },
      (input) => {
        input.manifest.entryPath = input.files[1].path
      },
      (input) => {
        input.manifest.host = 'photoshop'
      },
      (input) => {
        input.manifest.name = 'Changed name'
      },
      (input) => {
        input.manifest.provenance.artifactSha256 = 'e'.repeat(64)
      },
      (input) => {
        input.manifest.provenance.publisherId = 'another-publisher'
      },
      (input) => {
        input.manifest.signature.keyId = 'another-key'
      },
      (input) => {
        input.manifest.signature.signedAt = '2026-01-02T00:00:00.000Z'
      },
      (input) => {
        input.manifest.assets![0].id = 'changed-business-id'
      }
    ]
    for (const mutate of mutations) {
      const input = fixture()
      mutate(input)
      expect(getFigPluginPackageSigningPayload(FigPluginPackageSchema.parse(input))).not.toBe(
        payload
      )
    }
  })
})
