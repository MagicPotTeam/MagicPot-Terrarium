import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { buildFigPluginPackage } from './build-figplugin-package.mjs'

const script = fileURLToPath(new URL('./build-figplugin-package.mjs', import.meta.url))
const FORMAT = 'magicpot.figplugin.package.v1'
const MiB = 1024 * 1024
const CLI_ERROR =
  'FIGPLUGIN package build failed. Existing files were not overwritten; newly created outputs may remain.\n'
// Ephemeral fixture keys only. No checked-in key, real credential path or external filesystem fixture.
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function input() {
  return {
    privateKeyPem,
    manifest: {
      schemaVersion: 1,
      id: 'fixture.plugin',
      name: 'Fixture plugin',
      version: '1.2.3-rc.1+fixture',
      host: 'figma',
      entryPath: 'main.js',
      capabilities: ['dialogue'],
      permissions: { dialogue: 'prompt' },
      provenance: {
        publisherId: 'fixture.publisher',
        publisherName: 'Fixture publisher',
        sourceUrl: 'https://example.invalid/source',
        issuedAt: '2025-01-02T03:04:05Z'
      },
      signature: { keyId: 'fixture.key', signedAt: '2025-01-03T03:04:05.123Z' },
      assets: [
        { id: 'main', path: 'main.js', mimeType: ' Text/Javascript ' },
        { id: 'asset', path: 'assets/data.bin' }
      ]
    },
    files: [
      { path: 'main.js', data: Buffer.from('throw new Error("plugin must never execute")') },
      { path: 'assets/data.bin', data: Buffer.from([0, 1, 2, 127, 128, 255]) }
    ]
  }
}

function signatureValid(manifest, signature = manifest.signature.value, domain = FORMAT) {
  const unsigned = structuredClone(manifest)
  delete unsigned.signature.value
  return verify(
    null,
    Buffer.from(`${domain}\n${canonical(unsigned)}`),
    publicKeyPem,
    Buffer.from(signature, 'hex')
  )
}

function rejects(value) {
  assert.throws(
    () => buildFigPluginPackage(value),
    (error) => {
      assert.equal(error.message, 'Invalid FIGPLUGIN package input')
      assert.equal(error.cause, undefined)
      assert.deepEqual(Object.keys(error), [])
      return true
    }
  )
}

function setFiles(value, files) {
  value.files = files
  value.manifest.entryPath = files[0]?.path ?? 'main.js'
  value.manifest.assets = files.map(({ path }, index) => ({ id: `asset-${index}`, path }))
}

test('canonical envelope, full inventory, SPKI fingerprint and domain-separated Ed25519 signature', () => {
  const value = input()
  const before = canonical(value.manifest)
  const result = buildFigPluginPackage(value)
  const pkg = JSON.parse(result.packageText)
  assert.deepEqual(Object.keys(result).sort(), ['keyFingerprint', 'packageText', 'publicKeyPem'])
  assert.equal(result.packageText, canonical(pkg))
  assert.equal(result.publicKeyPem, publicKeyPem)
  assert.equal(
    result.keyFingerprint,
    sha(createPublicKey(result.publicKeyPem).export({ format: 'der', type: 'spki' }))
  )
  assert.equal(pkg.format, FORMAT)
  assert.equal(canonical(value.manifest), before)
  assert.deepEqual(
    pkg.files.map(({ path }) => path),
    ['assets/data.bin', 'main.js']
  )
  for (const file of pkg.files) {
    const original = value.files.find(({ path }) => path === file.path).data
    assert.deepEqual(Buffer.from(file.contentBase64, 'base64'), original)
    assert.equal(file.contentBase64, original.toString('base64'))
    assert.equal(file.bytes, original.length)
    assert.equal(file.sha256, sha(original))
    const asset = pkg.manifest.assets.find(({ path }) => path === file.path)
    assert.equal(asset.sizeBytes, file.bytes)
    assert.equal(asset.sha256, file.sha256)
  }
  assert.equal(
    pkg.manifest.provenance.artifactSha256,
    sha(
      canonical({
        format: FORMAT,
        files: pkg.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
      })
    )
  )
  assert.deepEqual(pkg.manifest.permissions, {
    dialogue: 'prompt',
    backgroundRemoval: 'none',
    assetTransfer: 'none',
    resultTransfer: 'none',
    filesystem: 'none',
    network: 'none'
  })
  assert.deepEqual(pkg.manifest.limits, {
    maxPayloadBytes: 8 * MiB,
    maxResultBytes: 8 * MiB,
    maxConfigBytes: 16 * 1024,
    maxCallTimeoutMs: 60_000,
    maxConcurrentCalls: 1
  })
  assert.equal(pkg.manifest.assets[0].mimeType, 'text/javascript')
  assert.equal(pkg.manifest.provenance.source, 'user-provided')
  assert.equal(pkg.manifest.signature.algorithm, 'ed25519')
  assert.equal(pkg.manifest.provenance.issuedAt, value.manifest.provenance.issuedAt)
  assert.equal(pkg.manifest.signature.signedAt, value.manifest.signature.signedAt)
  assert.equal(signatureValid(pkg.manifest), true)
  assert.equal(signatureValid(pkg.manifest, pkg.manifest.signature.value, 'another.format'), false)
  assert.equal(result.packageText.includes(privateKeyPem), false)
  assert.equal(result.packageText.includes('PRIVATE KEY'), false)
})

test('deterministic without clock/key generation; file order and object key order do not matter', () => {
  const value = input()
  const first = buildFigPluginPackage(value)
  value.files.reverse()
  value.manifest = JSON.parse(canonical(value.manifest))
  assert.deepEqual(buildFigPluginPackage(value), first)
  const pkg = JSON.parse(first.packageText)
  assert.deepEqual(buildFigPluginPackage({ ...value, manifest: pkg.manifest }), first)
})

test('every manifest field, including permission/provenance/timestamps/entry path, is signed', () => {
  const { manifest } = JSON.parse(buildFigPluginPackage(input()).packageText)
  const changes = [
    (m) => {
      m.schemaVersion = 2
    },
    (m) => {
      m.id = 'changed'
    },
    (m) => {
      m.name = 'Changed'
    },
    (m) => {
      m.version = '2.0.0'
    },
    (m) => {
      m.host = 'photoshop'
    },
    (m) => {
      m.entryPath = 'assets/data.bin'
    },
    (m) => {
      m.capabilities.push('asset-transfer')
    },
    (m) => {
      m.permissions.dialogue = 'none'
    },
    (m) => {
      m.permissions.network = 'prompt'
    },
    (m) => {
      m.limits.maxCallTimeoutMs = 100
    },
    (m) => {
      m.provenance.publisherId = 'other'
    },
    (m) => {
      m.provenance.publisherName = 'Other'
    },
    (m) => {
      m.provenance.source = 'official'
    },
    (m) => {
      m.provenance.sourceUrl += '/changed'
    },
    (m) => {
      m.provenance.artifactSha256 = '0'.repeat(64)
    },
    (m) => {
      m.provenance.issuedAt = '2025-01-02T03:04:06Z'
    },
    (m) => {
      m.signature.signedAt = '2025-01-03T03:04:05.124Z'
    },
    (m) => {
      m.signature.keyId = 'other'
    },
    (m) => {
      m.signature.algorithm = 'other'
    },
    (m) => {
      m.assets[0].id = 'other'
    },
    (m) => {
      m.assets[0].path = 'other.js'
    },
    (m) => {
      m.assets[0].sha256 = '0'.repeat(64)
    },
    (m) => {
      m.assets[0].sizeBytes++
    },
    (m) => {
      m.assets[0].mimeType = 'application/json'
    }
  ]
  for (const change of changes) {
    const modified = structuredClone(manifest)
    change(modified)
    assert.equal(signatureValid(modified), false)
  }
})

test('normalizes shared-schema fields but preserves caller privileges, source and explicit limits', () => {
  const value = input()
  value.manifest.id = ' fixture.plugin '
  value.manifest.name = ' Fixture plugin '
  value.manifest.version = ' 1.2.3 '
  value.manifest.provenance.publisherId = ' fixture.publisher '
  value.manifest.provenance.source = 'official'
  value.manifest.signature.keyId = ' fixture.key '
  value.manifest.capabilities = [
    'dialogue',
    'background-removal',
    'asset-transfer',
    'result-transfer'
  ]
  value.manifest.permissions = {
    dialogue: 'prompt',
    backgroundRemoval: 'prompt',
    assetTransfer: 'read',
    resultTransfer: 'write'
  }
  value.manifest.limits = {
    maxPayloadBytes: 2000,
    maxResultBytes: 1000,
    maxConfigBytes: 500,
    maxCallTimeoutMs: 100,
    maxConcurrentCalls: 8
  }
  const { manifest } = JSON.parse(buildFigPluginPackage(value).packageText)
  assert.equal(manifest.id, 'fixture.plugin')
  assert.equal(manifest.version, '1.2.3')
  assert.equal(manifest.provenance.source, 'official')
  assert.deepEqual(manifest.limits, value.manifest.limits)
  assert.equal(manifest.permissions.assetTransfer, 'read')
  assert.equal(signatureValid(manifest), true)
})

test('strict manifests reject unknown fields, invalid defaults, duplicates, versions and timestamps', () => {
  const mutations = [
    (m) => {
      m.extra = {}
    },
    (m) => {
      m.kind = 'figplugin'
    },
    (m) => {
      m.schemaVersion = 2
    },
    (m) => {
      delete m.id
    },
    (m) => {
      m.id = '../bad'
    },
    (m) => {
      m.name = ''
    },
    (m) => {
      m.version = '01.2.3'
    },
    (m) => {
      m.version = '1.0.0-01'
    },
    (m) => {
      m.version = 'v1.0.0'
    },
    (m) => {
      m.version = '1.2.3/'
    },
    (m) => {
      m.version = '1'.repeat(129)
    },
    (m) => {
      m.host = 'browser'
    },
    (m) => {
      delete m.entryPath
    },
    (m) => {
      m.entryPath = 'MAIN.js'
    },
    (m) => {
      m.capabilities = []
    },
    (m) => {
      m.capabilities.push('dialogue')
    },
    (m) => {
      m.capabilities = ['shell']
    },
    (m) => {
      m.permissions = {}
    },
    (m) => {
      m.permissions.dialogue = 'none'
    },
    (m) => {
      m.permissions.assetTransfer = 'read'
    },
    (m) => {
      m.permissions.network = 'prompt'
    },
    (m) => {
      m.permissions.filesystem = 'read'
    },
    (m) => {
      m.permissions.extra = 'none'
    },
    (m) => {
      m.permissions = null
    },
    (m) => {
      m.limits = null
    },
    (m) => {
      m.limits = { maxPayloadBytes: 1 }
    },
    (m) => {
      m.limits = { maxConfigBytes: 65537 }
    },
    (m) => {
      m.limits = { maxCallTimeoutMs: 99 }
    },
    (m) => {
      m.limits = { maxConcurrentCalls: 1.5 }
    },
    (m) => {
      m.limits = { extra: 1 }
    },
    (m) => {
      m.provenance.extra = 'opaque'
    },
    (m) => {
      m.provenance.source = 'trusted'
    },
    (m) => {
      m.provenance.sourceUrl = 'http://example.invalid'
    },
    (m) => {
      m.provenance.issuedAt = '2025-02-30T00:00:00Z'
    },
    (m) => {
      m.signature.signedAt = '2025-01-03T03:04:05+00:00'
    },
    (m) => {
      m.signature.algorithm = 'rsa'
    },
    (m) => {
      m.signature.extra = 'opaque'
    },
    (m) => {
      delete m.signature.keyId
    },
    (m) => {
      m.signature.value = 'invalid'
    },
    (m) => {
      m.assets[1].id = 'main'
    },
    (m) => {
      m.assets[1].path = 'main.js'
    },
    (m) => {
      m.assets[0].extra = {}
    },
    (m) => {
      m.assets[0].mimeType = 'text'
    },
    (m) => {
      m.assets[0].sizeBytes = -1
    },
    (m) => {
      m.assets[0].sha256 = 'invalid'
    },
    (m) => {
      m.assets = []
    },
    (m) => {
      delete m.assets
    },
    (m) => {
      m.provenance.artifactSha256 = 'wrong'
    }
  ]
  mutations.forEach((mutate) => {
    const value = input()
    mutate(value.manifest)
    rejects(value)
  })
})

test('safe ASCII paths, Windows devices, case-fold collisions and file/directory prefixes', () => {
  for (const unsafe of [
    '../main.js',
    '/main.js',
    'C:/main.js',
    'a\\main.js',
    'a//b',
    './a',
    'a/..',
    'a.',
    'a ',
    'a\n',
    'a\u0000',
    'é.js',
    'a%20b',
    'a:b',
    '__proto__/a',
    'a/Constructor',
    'CON.js',
    'aux',
    'COM1.txt',
    'lpt9',
    'NUL',
    'conin$',
    'x'.repeat(129),
    'a/'.repeat(256) + 'x'
  ]) {
    const value = input()
    setFiles(value, [{ path: unsafe, data: Buffer.from('fixture') }])
    rejects(value)
  }
  for (const paths of [
    ['a', 'a'],
    ['a', 'A'],
    ['a', 'A/b'],
    ['A/b', 'a']
  ]) {
    const value = input()
    setFiles(
      value,
      paths.map((path) => ({ path, data: Buffer.from('fixture') }))
    )
    rejects(value)
  }
  const value = input()
  value.files[1].path = 'MAIN.js'
  rejects(value)
})

test('full inventory and actual Buffer/count/byte limits, including exact 64 files and 8 MiB', () => {
  const value = input()
  setFiles(
    value,
    Array.from({ length: 64 }, (_, i) => ({ path: `${i}.bin`, data: Buffer.from([i]) }))
  )
  assert.equal(JSON.parse(buildFigPluginPackage(value).packageText).files.length, 64)
  value.files.push({ path: '65.bin', data: Buffer.from('x') })
  rejects(value)
  setFiles(
    value,
    Array.from({ length: 4 }, (_, i) => ({ path: `${i}.bin`, data: Buffer.alloc(2 * MiB, i) }))
  )
  const { packageText } = buildFigPluginPackage(value)
  assert.ok(Buffer.byteLength(packageText) <= 12 * MiB)
  assert.equal(
    JSON.parse(packageText).files.reduce((sum, file) => sum + file.bytes, 0),
    8 * MiB
  )
  setFiles(value, [...value.files, { path: 'overflow.bin', data: Buffer.from('x') }])
  rejects(value)
  for (const data of [Buffer.alloc(0), Buffer.alloc(2 * MiB + 1), new Uint8Array([1]), 'text']) {
    const modified = input()
    modified.files[0].data = data
    rejects(modified)
  }
  const missing = input()
  missing.files.pop()
  rejects(missing)
  const extra = input()
  extra.files.push({ path: 'extra.bin', data: Buffer.from('not declared') })
  rejects(extra)
  const unlistedEntry = input()
  unlistedEntry.manifest.assets.pop()
  rejects(unlistedEntry)
})

test('bounded plain JSON, no getters/toJSON hooks, opaque data, sparse arrays or cycles', () => {
  const value = input()
  let called = false
  Object.defineProperty(value.manifest, 'opaque', {
    enumerable: true,
    get() {
      called = true
      return 'secret'
    }
  })
  rejects(value)
  assert.equal(called, false)
  const custom = input()
  custom.manifest.toJSON = () => {
    called = true
    return {}
  }
  rejects(custom)
  assert.equal(called, false)
  const cyclic = input()
  cyclic.manifest.opaque = cyclic.manifest
  rejects(cyclic)
  const deep = input()
  deep.manifest.opaque = Array.from({ length: 20 }).reduce((inner) => ({ inner }), {})
  rejects(deep)
  const huge = input()
  huge.manifest.name = 's'.repeat(64 * 1024)
  rejects(huge)
  const sparse = input()
  delete sparse.files[0]
  rejects(sparse)
  const extra = input()
  extra.files[0].sha256 = '0'.repeat(64)
  rejects(extra)
  for (const manifest of [null, [], new Date(), { value: NaN }]) rejects({ ...input(), manifest })
})

test('PKCS8 Ed25519 only; no key generation, malformed/oversized keys or key-bearing assets', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  const keys = [
    undefined,
    publicKeyPem,
    'secret fixture',
    's'.repeat(4097),
    privateKey,
    privateKeyPem + privateKeyPem,
    rsa.export({ type: 'pkcs8', format: 'pem' }),
    rsa.export({ type: 'pkcs1', format: 'pem' }),
    ec.export({ type: 'pkcs8', format: 'pem' }),
    privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'fixture-only'
    })
  ]
  for (const key of keys) rejects({ ...input(), privateKeyPem: key })
  assert.equal(
    buildFigPluginPackage({ ...input(), privateKeyPem: Buffer.from(privateKeyPem) }).publicKeyPem,
    publicKeyPem
  )
  const keyAsset = input()
  keyAsset.files[0].data = Buffer.from(privateKeyPem)
  rejects(keyAsset)
  const keyMetadata = input()
  keyMetadata.manifest.name = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  rejects(keyMetadata)
})

function fixture(t) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(path.dirname(script), '.figplugin-test-'))
  )
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const value = input()
  const filesRoot = path.join(root, 'files')
  fs.mkdirSync(path.join(filesRoot, 'assets'), { recursive: true })
  for (const file of value.files) fs.writeFileSync(path.join(filesRoot, file.path), file.data)
  const manifestPath = path.join(root, 'manifest.json')
  const keyPath = path.join(root, 'fixture-secret-private.pem')
  const output = path.join(root, 'plugin.figplugin')
  const publicOutput = path.join(root, 'public.pem')
  fs.writeFileSync(manifestPath, JSON.stringify(value.manifest))
  fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 })
  return { root, value, filesRoot, manifestPath, keyPath, output, publicOutput }
}

function argsFor(f, override = {}) {
  const names = {
    '--manifest': f.manifestPath,
    '--files-root': f.filesRoot,
    '--private-key': f.keyPath,
    '--output': f.output,
    '--public-key-output': f.publicOutput,
    ...override
  }
  return Object.entries(names).flat()
}

function cli(f, args = argsFor(f)) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true
  })
}

function failsCleanly(f, result = cli(f)) {
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, CLI_ERROR)
  for (const secret of [f.keyPath, f.root, privateKeyPem, 'fixture-secret'])
    assert.equal(result.stderr.includes(secret), false)
}

function noOutputs(f) {
  assert.equal(fs.existsSync(f.output), false)
  assert.equal(fs.existsSync(f.publicOutput), false)
}

test('CLI is offline, reads only declared assets and emits only the two specified new files', (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.filesRoot, 'unlisted-private.txt'), 'must not be bundled')
  fs.mkdirSync(path.join(f.filesRoot, 'unlisted-directory'))
  const result = cli(f)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  const built = buildFigPluginPackage(f.value)
  assert.equal(fs.readFileSync(f.output, 'utf8'), built.packageText)
  assert.equal(fs.readFileSync(f.publicOutput, 'utf8'), built.publicKeyPem)
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), privateKeyPem)
  assert.deepEqual(fs.readdirSync(f.root).sort(), [
    'files',
    'fixture-secret-private.pem',
    'manifest.json',
    'plugin.figplugin',
    'public.pem'
  ])
})

test('both output names refuse existing files/directories; no deletion, replacement or private key output', (t) => {
  const f = fixture(t)
  for (const output of [f.output, f.publicOutput]) {
    fs.writeFileSync(output, 'user-owned sentinel')
    failsCleanly(f)
    assert.equal(fs.readFileSync(output, 'utf8'), 'user-owned sentinel')
    assert.equal(fs.existsSync(output === f.output ? f.publicOutput : f.output), false)
    fs.unlinkSync(output)
    fs.mkdirSync(output)
    failsCleanly(f)
    assert.ok(fs.statSync(output).isDirectory())
    fs.rmdirSync(output)
  }
  failsCleanly(f, cli(f, argsFor(f, { '--output': f.keyPath })))
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), privateKeyPem)
  failsCleanly(f, cli(f, argsFor(f, { '--public-key-output': f.output })))
  failsCleanly(
    f,
    cli(f, argsFor(f, { '--public-key-output': path.join(f.root, 'missing', 'key.pem') }))
  )
  noOutputs(f)
})

test('CLI flags are required, unique and closed; malformed/large/deep/duplicate JSON has no outputs', (t) => {
  const f = fixture(t)
  for (const args of [
    [],
    argsFor(f).slice(2),
    [...argsFor(f), '--extra', 'secret'],
    [...argsFor(f).slice(0, -2), '--manifest', f.manifestPath]
  ])
    failsCleanly(f, cli(f, args))
  const valid = JSON.stringify(f.value.manifest)
  const invalid = [
    '{',
    valid + '\nsecret',
    ' '.repeat(64 * 1024 + 1),
    '['.repeat(32) + '0' + ']'.repeat(32),
    valid.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    valid.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
    valid.replace('"dialogue":"prompt"', '"dialogue":"prompt","dialogue":"prompt"'),
    valid.replace('"keyId":"fixture.key"', '"keyId":"fixture.key","opaque":{"secret":true}'),
    Buffer.from([0xff, 0xfe, 0x7b, 0x7d])
  ]
  for (const content of invalid) {
    fs.writeFileSync(f.manifestPath, content)
    failsCleanly(f)
    noOutputs(f)
  }
})

test('CLI file/key bounds and native failures have fixed redacted errors and no outputs', (t) => {
  const f = fixture(t)
  for (const key of ['fixture-secret-key-data', 'x'.repeat(4097), '']) {
    fs.writeFileSync(f.keyPath, key)
    failsCleanly(f)
    noOutputs(f)
  }
  fs.writeFileSync(f.keyPath, privateKeyPem)
  for (const data of [Buffer.alloc(0), Buffer.alloc(2 * MiB + 1)]) {
    fs.writeFileSync(path.join(f.filesRoot, 'main.js'), data)
    failsCleanly(f)
    noOutputs(f)
  }
  fs.unlinkSync(path.join(f.filesRoot, 'main.js'))
  failsCleanly(f)
  noOutputs(f)
})

test('CLI rejects hardlinked key, manifest and assets (nlink must be one)', (t) => {
  const f = fixture(t)
  const alias = path.join(f.root, 'hardlink')
  for (const name of [f.keyPath, f.manifestPath, path.join(f.filesRoot, 'main.js')]) {
    fs.linkSync(name, alias)
    failsCleanly(f)
    noOutputs(f)
    fs.unlinkSync(alias)
  }
})

test('CLI rejects linked ancestors, including root, key parent, asset parent and output parent', (t) => {
  const f = fixture(t)
  const linked = path.join(f.root, 'linked')
  fs.symlinkSync(f.filesRoot, linked, process.platform === 'win32' ? 'junction' : 'dir')
  failsCleanly(f, cli(f, argsFor(f, { '--files-root': linked })))
  const linkedRoot = path.join(f.root, 'linked-root')
  fs.symlinkSync(f.root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
  for (const override of [
    { '--private-key': path.join(linkedRoot, path.basename(f.keyPath)) },
    { '--manifest': path.join(linkedRoot, 'manifest.json') },
    { '--output': path.join(linkedRoot, 'other.figplugin') },
    { '--public-key-output': path.join(linkedRoot, 'other.pem') }
  ])
    failsCleanly(f, cli(f, argsFor(f, override)))
  fs.renameSync(path.join(f.filesRoot, 'assets'), path.join(f.root, 'asset-directory'))
  fs.symlinkSync(
    path.join(f.root, 'asset-directory'),
    path.join(f.filesRoot, 'assets'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  failsCleanly(f)
  noOutputs(f)
})

test('CLI rejects file symlinks, including dangling existing outputs', (t) => {
  const f = fixture(t)
  const linked = path.join(f.root, 'key-symlink')
  try {
    fs.symlinkSync(f.keyPath, linked, 'file')
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('file symlink creation is unavailable; hardlink and junction tests still run')
      return
    }
    throw error
  }
  failsCleanly(f, cli(f, argsFor(f, { '--private-key': linked })))
  fs.symlinkSync(path.join(f.root, 'absent'), f.publicOutput, 'file')
  failsCleanly(f)
  assert.ok(fs.lstatSync(f.publicOutput).isSymbolicLink())
  assert.equal(fs.existsSync(f.output), false)
})

test('CLI rejects unsafe declarations, collisions and accidentally declared signing keys before outputs', (t) => {
  const f = fixture(t)
  for (const unsafe of ['../fixture-secret-private.pem', 'CON.js', 'a\n', 'MAIN.js', 'a/b']) {
    const manifest = structuredClone(f.value.manifest)
    manifest.assets[1].path = unsafe
    fs.writeFileSync(f.manifestPath, JSON.stringify(manifest))
    failsCleanly(f)
    noOutputs(f)
  }
  const manifest = structuredClone(f.value.manifest)
  manifest.entryPath = path.basename(f.keyPath)
  manifest.assets = [{ id: 'main', path: manifest.entryPath }]
  fs.writeFileSync(f.manifestPath, JSON.stringify(manifest))
  failsCleanly(f, cli(f, argsFor(f, { '--files-root': f.root })))
  noOutputs(f)
})

function bridgeInput(origin = 'http://127.0.0.1:24816') {
  const value = input()
  Object.assign(value.manifest, {
    schemaVersion: 2,
    capabilities: ['dialogue', 'asset-transfer'],
    permissions: { dialogue: 'prompt', assetTransfer: 'read', network: 'desktop-bridge' },
    bridge: { protocol: 1, origin }
  })
  return value
}

test('v2 preserves exact origins and normalizes shared fields/defaults before deterministic signing', (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('building must remain offline'))
  for (const host of ['figma', 'photoshop']) {
    for (const port of [1024, 24816, 65535]) {
      const origin = `http://127.0.0.1:${port}`
      const value = bridgeInput(origin)
      value.manifest.host = host
      value.manifest.id = ' fixture.plugin '
      value.manifest.name = ' Fixture plugin '
      value.manifest.version = ' 1.2.3 '
      value.manifest.entryPath = ' main.js '
      value.manifest.assets[0].id = ' main '
      value.manifest.assets[0].path = ' main.js '
      value.manifest.assets[0].sha256 = ' A'.trim().repeat(64)
      value.manifest.provenance.publisherId = ' fixture.publisher '
      value.manifest.provenance.publisherName = ' Fixture publisher '
      value.manifest.provenance.sourceUrl = ' https://example.invalid/source '
      value.manifest.provenance.issuedAt = ' 2025-01-02T03:04:05Z '
      value.manifest.signature.keyId = ' fixture.key '
      value.manifest.signature.signedAt = ' 2025-01-03T03:04:05.123Z '
      const before = canonical(value.manifest)
      const result = buildFigPluginPackage(value)
      const { manifest, format, files } = JSON.parse(result.packageText)
      assert.equal(format, FORMAT)
      assert.equal(manifest.schemaVersion, 2)
      assert.equal(manifest.id, 'fixture.plugin')
      assert.equal(manifest.name, 'Fixture plugin')
      assert.equal(manifest.version, '1.2.3')
      assert.equal(manifest.entryPath, 'main.js')
      assert.equal(manifest.assets[0].id, 'main')
      assert.equal(manifest.assets[0].path, 'main.js')
      assert.equal(manifest.assets[0].mimeType, 'text/javascript')
      assert.equal(manifest.assets[0].sha256, sha(value.files[0].data))
      assert.equal(manifest.provenance.publisherId, 'fixture.publisher')
      assert.equal(manifest.provenance.publisherName, 'Fixture publisher')
      assert.equal(manifest.provenance.sourceUrl, 'https://example.invalid/source')
      assert.equal(manifest.provenance.issuedAt, '2025-01-02T03:04:05Z')
      assert.equal(manifest.signature.signedAt, '2025-01-03T03:04:05.123Z')
      assert.equal(manifest.signature.keyId, 'fixture.key')
      assert.deepEqual(manifest.bridge, { protocol: 1, origin })
      assert.deepEqual(manifest.permissions, {
        dialogue: 'prompt',
        backgroundRemoval: 'none',
        assetTransfer: 'read',
        resultTransfer: 'none',
        filesystem: 'none',
        network: 'desktop-bridge'
      })
      assert.deepEqual(
        manifest.limits,
        JSON.parse(buildFigPluginPackage(input()).packageText).manifest.limits
      )
      assert.equal(files.length, 2)
      assert.equal(signatureValid(manifest), true)
      assert.equal(canonical(value.manifest), before)
      assert.deepEqual(buildFigPluginPackage({ ...value, manifest }), result)
      assert.equal(result.packageText, canonical(JSON.parse(result.packageText)))
    }
  }
})

test('v2 origin is not URL-normalized: aliases, credentials, wildcards, paths and noncanonical ports fail', () => {
  for (const origin of [
    undefined,
    null,
    24816,
    {},
    [],
    '',
    ' ',
    '*',
    'http://localhost.invalid:24816',
    'http://127.1:24816',
    'http://2130706433:24816',
    'http://0x7f000001:24816',
    'http://0177.0.0.1:24816',
    'http://127.000.000.001:24816',
    'http://[::1]:24816',
    'http://[::ffff:127.0.0.1]:24816',
    'http://0.0.0.0:24816',
    'http://127.0.0.2:24816',
    'http://127.0.0.1.example.invalid:24816',
    'http://127.0.0.1.:24816',
    'https://127.0.0.1:24816',
    'HTTP://127.0.0.1:24816',
    'ws://127.0.0.1:24816',
    'http://user@127.0.0.1:24816',
    'http://127.0.0.1:24816@evil.invalid',
    'http://127%2e0.0.1:24816',
    'http://127.0.0.1',
    'http://127.0.0.1:*',
    'http://127.0.0.1:0',
    'http://127.0.0.1:80',
    'http://127.0.0.1:1023',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:99999',
    'http://127.0.0.1:100000',
    'http://127.0.0.1:024816',
    'http://127.0.0.1:+24816',
    'http://127.0.0.1:24816.0',
    'http://127.0.0.1:24816/',
    'http://127.0.0.1:24816/path',
    'http://127.0.0.1:24816?',
    'http://127.0.0.1:24816#',
    ' http://127.0.0.1:24816',
    'http://127.0.0.1:24816 ',
    'http://127.0.0.1:1024\n',
    'http://127.0.0.1:1024\r\n',
    'http://127.0.0.1:1024\t',
    'http://127.0.0.1:1024\u0000'
  ]) {
    const value = bridgeInput()
    value.manifest.bridge.origin = origin
    rejects(value)
  }
})

test('v2 bridge and permission declarations are strict and never silently upgrade v1', () => {
  const mutations = [
    (m) => {
      m.schemaVersion = 0
    },
    (m) => {
      m.schemaVersion = 3
    },
    (m) => {
      m.schemaVersion = '2'
    },
    (m) => {
      delete m.schemaVersion
    },
    (m) => {
      delete m.bridge
    },
    (m) => {
      m.bridge = null
    },
    (m) => {
      m.bridge = []
    },
    (m) => {
      m.bridge.extra = 'secret'
    },
    (m) => {
      m.bridge.protocol = 2
    },
    (m) => {
      m.bridge.protocol = '1'
    },
    (m) => {
      delete m.bridge.protocol
    },
    (m) => {
      delete m.bridge.origin
    },
    (m) => {
      m.bridge.origin = { origin: 'http://127.0.0.1:24816' }
    },
    (m) => {
      delete m.entryPath
    },
    (m) => {
      delete m.permissions
    },
    (m) => {
      delete m.permissions.network
    },
    (m) => {
      m.permissions.network = 'none'
    },
    (m) => {
      m.permissions.network = '*'
    },
    (m) => {
      m.permissions.network = 'prompt'
    },
    (m) => {
      m.permissions.filesystem = 'read'
    },
    (m) => {
      delete m.permissions.dialogue
    },
    (m) => {
      m.permissions.dialogue = 'none'
    },
    (m) => {
      delete m.permissions.assetTransfer
    },
    (m) => {
      m.permissions.assetTransfer = 'none'
    },
    (m) => {
      m.capabilities = ['asset-transfer']
      m.permissions.dialogue = 'none'
    },
    (m) => {
      m.capabilities = ['dialogue']
      m.permissions.assetTransfer = 'none'
    },
    (m) => {
      m.permissions.backgroundRemoval = 'prompt'
    },
    (m) => {
      m.permissions.resultTransfer = 'write'
    },
    (m) => {
      m.capabilities.push('background-removal')
    },
    (m) => {
      m.capabilities.push('result-transfer')
    },
    (m) => {
      m.capabilities.push('dialogue')
    },
    (m) => {
      m.assets[1].path = ' MAIN.js '
    },
    (m) => {
      m.limits = { maxPayloadBytes: 32768, maxResultBytes: 65536 }
    }
  ]
  for (const mutate of mutations) {
    const value = bridgeInput()
    mutate(value.manifest)
    rejects(value)
  }
  for (const change of [
    { bridge: { protocol: 1, origin: 'http://127.0.0.1:24816' } },
    { permissions: { dialogue: 'prompt', network: 'desktop-bridge' } },
    { schemaVersion: 1 }
  ]) {
    const value = Object.hasOwn(change, 'schemaVersion') ? bridgeInput() : input()
    Object.assign(value.manifest, change)
    rejects(value)
  }
  const getter = bridgeInput()
  let reads = 0
  Object.defineProperty(getter.manifest.bridge, 'origin', {
    enumerable: true,
    get() {
      reads++
      throw new Error('SYNTHETIC_SECRET')
    }
  })
  rejects(getter)
  assert.equal(reads, 0)
  const all = bridgeInput()
  all.manifest.capabilities.push('background-removal', 'result-transfer')
  Object.assign(all.manifest.permissions, { backgroundRemoval: 'prompt', resultTransfer: 'write' })
  assert.equal(signatureValid(JSON.parse(buildFigPluginPackage(all).packageText).manifest), true)
})

test('v2 signing covers the whole bridge, schema and network permission; changed origins change signatures', () => {
  const value = bridgeInput()
  const { manifest } = JSON.parse(buildFigPluginPackage(value).packageText)
  assert.equal(signatureValid(manifest), true)
  for (const change of [
    (m) => {
      m.schemaVersion = 1
    },
    (m) => {
      m.bridge.protocol = 2
    },
    (m) => {
      m.bridge.origin = 'http://127.0.0.1:24817'
    },
    (m) => {
      m.bridge.extra = true
    },
    (m) => {
      delete m.bridge
    },
    (m) => {
      m.permissions.network = 'none'
    },
    (m) => {
      m.permissions.dialogue = 'none'
    },
    (m) => {
      m.permissions.assetTransfer = 'none'
    }
  ]) {
    const tampered = structuredClone(manifest)
    change(tampered)
    assert.equal(signatureValid(tampered), false)
  }
  value.manifest.bridge.origin = 'http://127.0.0.1:24817'
  const changed = JSON.parse(buildFigPluginPackage(value).packageText).manifest
  assert.equal(signatureValid(changed), true)
  assert.notEqual(changed.signature.value, manifest.signature.value)
  assert.equal(changed.provenance.artifactSha256, manifest.provenance.artifactSha256)
  assert.equal(signatureValid(changed, manifest.signature.value), false)
})

test('v2 CLI rejects duplicate bridge keys and invalid origins, then emits the same signed bytes as the API', (t) => {
  const f = fixture(t)
  const value = bridgeInput()
  const valid = JSON.stringify(value.manifest)
  for (const invalid of [
    valid.replace('"protocol":1', '"protocol":1,"protocol":1'),
    valid.replace('"origin":', '"origin":"http://127.0.0.1:24817","ori\\u0067in":'),
    valid.replace(
      '"bridge":',
      '"bridge":{"protocol":1,"origin":"http://127.0.0.1:24816"},"bridge":'
    ),
    valid.replace('http://127.0.0.1:24816', 'http://localhost.invalid:24816'),
    valid.replace('"desktop-bridge"', '"*"'),
    valid.replace('"schemaVersion":2', '"schemaVersion":1')
  ]) {
    fs.writeFileSync(f.manifestPath, invalid)
    failsCleanly(f)
    noOutputs(f)
  }
  fs.writeFileSync(f.manifestPath, valid)
  const result = cli(f)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal(fs.readFileSync(f.output, 'utf8'), buildFigPluginPackage(value).packageText)
  assert.equal(fs.readFileSync(f.publicOutput, 'utf8'), publicKeyPem)
  assert.equal(fs.readFileSync(f.keyPath, 'utf8'), privateKeyPem)
})

test('strict semantic versions retain alphanumeric identifiers without ambiguous backtracking', () => {
  for (const version of [
    '1.2.3-0',
    '1.2.3-00alpha',
    '1.2.3-alpha-beta.1+build.01',
    '0.0.0-0.--.---'
  ]) {
    const fixture = input()
    fixture.manifest.version = version
    assert.equal(JSON.parse(buildFigPluginPackage(fixture).packageText).manifest.version, version)
  }
  for (const version of ['1.2.3-01', '1.2.3-alpha..1', `0.0.0-0.${'--.'.repeat(30)}!`]) {
    const fixture = input()
    fixture.manifest.version = version
    assert.throws(() => buildFigPluginPackage(fixture))
  }
})
