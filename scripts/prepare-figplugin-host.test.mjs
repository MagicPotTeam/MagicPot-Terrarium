import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { prepareFigPluginHost } from './prepare-figplugin-host.mjs'
import { buildFigPluginPackage } from './build-figplugin-package.mjs'

const SCRIPT = fileURLToPath(new URL('./prepare-figplugin-host.mjs', import.meta.url))
const SOURCES = fileURLToPath(new URL('../packages/figplugin-hosts/', import.meta.url))
const MAX_FILE = 2 * 1024 * 1024
const INVALID = 'Invalid FIGPLUGIN host preparation input'
const CLI_ERROR =
  'FIGPLUGIN host preparation failed. Existing files were not overwritten; newly created outputs may remain.\n'
const ISSUED_AT = '2026-03-14T12:34:56.789Z'
const ORIGIN = 'http://127.0.0.1:24816'
// Opaque connected fixture: preparation must not evaluate even this benign helper script.
const SYNTHETIC_HELPER = Buffer.from(
  'Object.defineProperty(globalThis, "MagicPotSelectionSnapshotV1", { value: Object.freeze({}) });\n' +
    'throw new Error("HELPER_MUST_NOT_RUN");\n// no trailing newline'
)
const HELPER_SEPARATOR = Buffer.from('\n;\n')
// These plausible-format IDs are synthetic fixtures, not claims of registry ownership.
const HOSTS = {
  figma: {
    pluginId: '987654321012345678',
    directory: 'figma',
    code: 'code.js',
    ui: 'ui.html'
  },
  photoshop: {
    pluginId: 'com.magicpot.synthetic.dev-2026',
    directory: 'photoshop-uxp',
    code: 'main.js',
    ui: 'index.html'
  }
}
const FLAGS = [
  ['--host', 'host'],
  ['--plugin-id', 'pluginId'],
  ['--publisher-id', 'publisherId'],
  ['--key-id', 'keyId'],
  ['--issued-at', 'issuedAt'],
  ['--output', 'outputDir']
]
const hash = (data) => createHash('sha256').update(data).digest('hex')
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function snapshot(name) {
  const stat = fs.lstatSync(name, { bigint: true })
  const metadata = Object.fromEntries(
    ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [key, stat[key]])
  )
  assert.equal(stat.isSymbolicLink(), false)
  return {
    ...metadata,
    contents: stat.isDirectory()
      ? Object.fromEntries(
          fs
            .readdirSync(name)
            .sort()
            .map((child) => [child, snapshot(path.join(name, child))])
        )
      : fs.readFileSync(name)
  }
}

// Snapshot only the v1 inputs, not unrelated files or concurrently developed bridge sources.
function templateSnapshots() {
  return Object.values(HOSTS).flatMap((spec) =>
    ['manifest.template.json', spec.code, spec.ui].map((name) =>
      snapshot(path.join(SOURCES, spec.directory, name))
    )
  )
}
const originalSources = templateSnapshots()
after(() =>
  assert.deepEqual(templateSnapshots(), originalSources, 'repository templates stay unchanged')
)

function temporary(t) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(process.cwd()), '.prepare-figplugin-test-')
  )
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function options(root, host = 'figma', overrides = {}) {
  return {
    host,
    pluginId: HOSTS[host].pluginId,
    publisherId: 'synthetic.publisher',
    keyId: 'synthetic.key-1',
    issuedAt: ISSUED_AT,
    outputDir: path.join(root, 'output'),
    ...overrides
  }
}

function rejected(input, prepare = prepareFigPluginHost) {
  assert.throws(
    () => prepare(input),
    (error) => {
      assert.equal(error.constructor, Error)
      assert.equal(error.message, INVALID)
      assert.equal(error.cause, undefined)
      assert.deepEqual(Object.keys(error), [])
      return true
    }
  )
}

function cli(args, cwd, script = SCRIPT) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  return result
}

function cliArgs(input) {
  const args = FLAGS.flatMap(([flag, key]) => [flag, input[key]])
  if (Object.hasOwn(input, 'bridgeOrigin')) args.push('--bridge-origin', input.bridgeOrigin)
  return args
}

function cliRejected(args, cwd) {
  const result = cli(args, cwd)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, CLI_ERROR)
}

async function isolated(t, host = 'figma', connected = false) {
  const root = temporary(t)
  const spec = HOSTS[host]
  const script = path.join(root, 'scripts', 'prepare-figplugin-host.mjs')
  const sourceDir = path.join(root, 'packages', 'figplugin-hosts', spec.directory)
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.copyFileSync(SCRIPT, script)
  for (const name of ['manifest.template.json', spec.code, spec.ui]) {
    fs.copyFileSync(path.join(SOURCES, spec.directory, name), path.join(sourceDir, name))
  }
  if (connected) {
    const helper = path.join(path.dirname(sourceDir), 'shared', 'selection-snapshot.js')
    fs.mkdirSync(path.dirname(helper))
    fs.writeFileSync(helper, SYNTHETIC_HELPER)
    fs.writeFileSync(
      path.join(path.dirname(helper), 'plan-preview.js'),
      '/* opaque planning validator fixture */\n'
    )
    const bridgeDir = path.join(sourceDir, 'bridge')
    fs.mkdirSync(bridgeDir)
    // Opaque bytes, including placeholder-looking JS, must be copied without evaluation/substitution.
    fs.writeFileSync(
      path.join(bridgeDir, spec.code),
      'throw new Error("BRIDGE_CODE_MUST_NOT_RUN");\n// __FIGMA_ASSIGNED_PLUGIN_ID__ __PHOTOSHOP_PLUGIN_ID__ __html__\n'
    )
    fs.writeFileSync(
      path.join(bridgeDir, spec.ui),
      `<html><body>synthetic bridge UI<script src="${spec.code}"></script></body></html>\n`
    )
    fs.writeFileSync(path.join(bridgeDir, 'manifest.template.json'), 'must not be read')
  }
  const { prepareFigPluginHost: prepare } = await import(pathToFileURL(script).href)
  return {
    root,
    sourceDir,
    script,
    prepare,
    input: options(root, host, connected ? { bridgeOrigin: ORIGIN } : {})
  }
}

for (const [host, spec] of Object.entries(HOSTS)) {
  test(`${host}: copies exactly four files, substitutes only the synthetic ID, and stays unsigned`, (t) => {
    const root = temporary(t)
    const input = options(root, host)
    assert.deepEqual(prepareFigPluginHost(input), { host, fileCount: 4 })
    const names = ['manifest.json', spec.code, spec.ui, 'package.template.json'].sort()
    assert.deepEqual(fs.readdirSync(input.outputDir).sort(), names)
    for (const name of names) {
      const stat = fs.lstatSync(path.join(input.outputDir, name))
      assert.equal(stat.isFile(), true)
      assert.equal(stat.isSymbolicLink(), false)
      assert.equal(stat.nlink, 1)
      assert.ok(stat.size > 0 && stat.size <= MAX_FILE)
      if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600)
    }
    const sourceDir = path.join(SOURCES, spec.directory)
    const expected = JSON.parse(
      fs.readFileSync(path.join(sourceDir, 'manifest.template.json'), 'utf8')
    )
    const native = JSON.parse(fs.readFileSync(path.join(input.outputDir, 'manifest.json'), 'utf8'))
    assert.deepEqual(native, { ...expected, id: spec.pluginId })
    if (host === 'figma') assert.deepEqual(native.networkAccess.allowedDomains, ['none'])
    else assert.deepEqual(native.requiredPermissions, { localFileSystem: 'plugin' })
    for (const name of [spec.code, spec.ui]) {
      assert.deepEqual(
        fs.readFileSync(path.join(input.outputDir, name)),
        fs.readFileSync(path.join(sourceDir, name))
      )
    }
    const template = JSON.parse(
      fs.readFileSync(path.join(input.outputDir, 'package.template.json'), 'utf8')
    )
    assert.equal(template.schemaVersion, 1)
    assert.equal(Object.hasOwn(template, 'bridge'), false)
    assert.deepEqual(template.limits, {})
    assert.equal(template.host, host)
    assert.equal(template.entryPath, 'manifest.json')
    assert.deepEqual(template.capabilities, ['asset-transfer'])
    assert.deepEqual(template.permissions, {
      dialogue: 'none',
      backgroundRemoval: 'none',
      assetTransfer: 'read',
      resultTransfer: 'none',
      filesystem: 'none',
      network: 'none'
    })
    assert.deepEqual(template.provenance, {
      publisherId: input.publisherId,
      publisherName: 'User-provided development publisher',
      source: 'user-provided',
      issuedAt: ISSUED_AT
    })
    assert.deepEqual(template.signature, {
      algorithm: 'ed25519',
      keyId: input.keyId,
      signedAt: ISSUED_AT
    })
    assert.deepEqual(
      template.assets.map(({ path }) => path).sort(),
      ['manifest.json', spec.code, spec.ui].sort()
    )
    assert.equal(JSON.stringify(template).includes(root), false)
    assert.deepEqual(templateSnapshots(), originalSources)
  })

  test(`${host}: the offline builder signs the generated template with an in-memory test key`, (t) => {
    const root = temporary(t)
    const input = options(root, host)
    prepareFigPluginHost(input)
    const before = snapshot(input.outputDir)
    const manifest = JSON.parse(
      fs.readFileSync(path.join(input.outputDir, 'package.template.json'), 'utf8')
    )
    const files = manifest.assets.map(({ path: name }) => ({
      path: name,
      data: fs.readFileSync(path.join(input.outputDir, name))
    }))
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const result = buildFigPluginPackage({ manifest, files, privateKeyPem })
    const wire = JSON.parse(result.packageText)
    assert.equal(wire.format, 'magicpot.figplugin.package.v1')
    assert.equal(wire.manifest.provenance.source, 'user-provided')
    const signature = Buffer.from(wire.manifest.signature.value, 'hex')
    delete wire.manifest.signature.value
    assert.equal(
      verify(
        null,
        Buffer.from(`${wire.format}\n${canonical(wire.manifest)}`),
        publicKey,
        signature
      ),
      true
    )
    for (const file of wire.files) {
      const expected = files.find(({ path }) => path === file.path).data
      assert.deepEqual(Buffer.from(file.contentBase64, 'base64'), expected)
      assert.equal(file.bytes, expected.length)
      assert.equal(file.sha256, hash(expected))
    }
    assert.equal(
      wire.manifest.provenance.artifactSha256,
      hash(
        canonical({
          format: wire.format,
          files: wire.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
        })
      )
    )
    assert.equal(result.publicKeyPem, publicKey.export({ type: 'spki', format: 'pem' }))
    assert.equal(result.packageText.includes(privateKeyPem), false)
    assert.deepEqual(snapshot(input.outputDir), before)
    assert.equal(Object.hasOwn(manifest.signature, 'value'), false)
  })

  test(`${host}: CLI output is deterministic for the caller's date and disclaims pairing/trust`, (t) => {
    const root = temporary(t)
    for (const name of ['first', 'second']) {
      const input = options(root, host, {
        outputDir: path.join(root, name),
        issuedAt: '2024-02-29T00:00:00Z'
      })
      const result = cli(cliArgs(input), root)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, '')
      assert.match(result.stdout, /4 files/)
      assert.match(result.stdout, /No host code executed; desktop not paired/)
      assert.match(result.stdout, /unsigned and does not establish publisher trust/)
      assert.equal(result.stdout.includes(root), false)
    }
    for (const name of fs.readdirSync(path.join(root, 'first'))) {
      assert.deepEqual(
        fs.readFileSync(path.join(root, 'first', name)),
        fs.readFileSync(path.join(root, 'second', name))
      )
    }
    const template = JSON.parse(
      fs.readFileSync(path.join(root, 'first', 'package.template.json'), 'utf8')
    )
    assert.equal(template.provenance.issuedAt, '2024-02-29T00:00:00Z')
    assert.equal(template.signature.signedAt, '2024-02-29T00:00:00Z')
    assert.deepEqual(fs.readdirSync(root).sort(), ['first', 'second'])
  })
}

test('all six CLI flags are mandatory, singular and known; help creates nothing', (t) => {
  const root = temporary(t)
  const args = cliArgs(options(root))
  const before = snapshot(root)
  for (let index = 0; index < FLAGS.length; index++) {
    cliRejected(
      args.filter((_, position) => Math.floor(position / 2) !== index),
      root
    )
    const duplicate = [...args]
    duplicate[index * 2] = FLAGS[(index + 1) % FLAGS.length][0]
    cliRejected(duplicate, root)
  }
  cliRejected([], root)
  cliRejected([...args, '--unknown', 'synthetic'], root)
  cliRejected(['--unknown', ...args.slice(1)], root)
  cliRejected([...args.slice(0, -1)], root)
  cliRejected(['--help', ...args], root)
  cliRejected([...args, '--private-key', 'synthetic-not-a-file'], root)
  const help = cli(['--help'], root)
  assert.equal(help.status, 0)
  assert.equal(help.stderr, '')
  for (const [flag] of FLAGS) assert.ok(help.stdout.includes(flag))
  assert.match(help.stdout, /All six flags are required/)
  assert.match(help.stdout, /Optional --bridge-origin/)
  assert.match(help.stdout, /No keys are read or created/)
  assert.equal(help.stdout.includes(root), false)
  assert.deepEqual(snapshot(root), before)
})

test('API options require six own enumerable data properties without invoking getters', (t) => {
  const root = temporary(t)
  const input = options(root)
  for (const [, key] of FLAGS) {
    const missing = { ...input }
    delete missing[key]
    rejected(missing)
    let reads = 0
    const getter = { ...input }
    Object.defineProperty(getter, key, {
      enumerable: true,
      get() {
        reads++
        throw new Error('SYNTHETIC_SECRET')
      }
    })
    rejected(getter)
    assert.equal(reads, 0)
    rejected(Object.defineProperty({ ...input }, key, { enumerable: false }))
  }
  for (const invalid of [
    null,
    [],
    new Date(),
    Object.create(input),
    { ...input, extra: 'no' },
    { ...input, [Symbol('extra')]: 'no' }
  ])
    rejected(invalid)
  assert.deepEqual(fs.readdirSync(root), [])
  assert.deepEqual(prepareFigPluginHost(Object.assign(Object.create(null), input)), {
    host: 'figma',
    fileCount: 4
  })
})

test('unsafe IDs, unknown hosts, placeholders, and noncanonical dates fail without output', (t) => {
  const root = temporary(t)
  const cases = [
    { host: 'illustrator' },
    ...['1234', '1'.repeat(33), 'abc12345', '__FIGMA_ASSIGNED_PLUGIN_ID__', '12345\n'].map(
      (pluginId) => ({ pluginId })
    ),
    ...[
      'id with spaces',
      'com:plugin',
      'com/plugin',
      'com\\plugin',
      '.plugin',
      '-plugin',
      '_plugin',
      'a'.repeat(129),
      'p\u00e9',
      '__PHOTOSHOP_PLUGIN_ID__',
      'placeholder',
      'your-plugin-id'
    ].map((pluginId) => ({ host: 'photoshop', pluginId })),
    ...[
      '',
      'not-a-date',
      '2026-02-30T00:00:00Z',
      '2025-02-29T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T00:00:00',
      '2026-01-01T00:00:00+00:00',
      '2026-01-01T00:00:00.0000Z'
    ].map((issuedAt) => ({ issuedAt })),
    { publisherId: 'your-publisher-id' },
    { publisherId: '../publisher' },
    { keyId: '__KEY_ID__' },
    { keyId: 'key with spaces' },
    { keyId: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NOT_A_KEY\n-----END PRIVATE KEY-----' }
  ]
  for (const change of cases) rejected(options(root, 'figma', change))
  assert.deepEqual(fs.readdirSync(root), [])
})

test('Photoshop ID boundary policy accepts one character, 128 characters, and trailing punctuation', (t) => {
  const root = temporary(t)
  for (const [index, pluginId] of ['A', 'a'.repeat(128), 'com.synthetic_Dev-1.'].entries()) {
    const input = options(root, 'photoshop', {
      pluginId,
      outputDir: path.join(root, String(index))
    })
    prepareFigPluginHost(input)
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(input.outputDir, 'manifest.json'), 'utf8')).id,
      pluginId
    )
  }
})

test('relative, traversal, device, ADS, network, and malformed output paths are refused', (t) => {
  const root = temporary(t)
  for (const outputDir of [
    'relative-output',
    '.',
    '',
    path.parse(root).root,
    `${root}${path.sep}..${path.sep}escape`,
    `${root}${path.sep}.${path.sep}output`,
    path.join(root, 'NUL'),
    path.join(root, 'COM1.txt'),
    path.join(root, 'trailing.'),
    path.join(root, 'trailing '),
    path.join(root, 'file:stream'),
    path.join(root, 'bad\nname'),
    path.join(root, 'bad?name'),
    '//synthetic.invalid/share/output',
    '\\\\synthetic.invalid\\share\\output'
  ])
    rejected(options(root, 'figma', { outputDir }))
  rejected(options(root, 'figma', { outputDir: path.join(root, 'absent-parent', 'output') }))
  assert.deepEqual(fs.readdirSync(root), [])
})

test('preexisting empty directory, file, populated directory, and target directory remain untouched', (t) => {
  const root = temporary(t)
  for (const kind of ['empty', 'file', 'populated', 'target']) {
    const outputDir = path.join(root, kind)
    if (kind === 'file') fs.writeFileSync(outputDir, 'synthetic user file', { flag: 'wx' })
    else {
      fs.mkdirSync(outputDir)
      if (kind !== 'empty')
        fs.writeFileSync(path.join(outputDir, 'manifest.json'), 'synthetic user manifest', {
          flag: 'wx'
        })
    }
    const before = snapshot(outputDir)
    for (const extra of [{}, { bridgeOrigin: ORIGIN }]) {
      rejected(options(root, 'figma', { outputDir, ...extra }))
      cliRejected(cliArgs(options(root, 'figma', { outputDir, ...extra })), root)
      assert.deepEqual(snapshot(outputDir), before)
    }
  }
})

test('parent junctions and output links are refused without touching their synthetic target', (t) => {
  const root = temporary(t)
  const target = path.join(root, 'target')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'manifest.json'), 'synthetic user content', { flag: 'wx' })
  const before = snapshot(target)
  const link = path.join(root, 'linked')
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  for (const outputDir of [link, path.join(link, 'output')]) {
    rejected(options(root, 'figma', { outputDir }))
    cliRejected(cliArgs(options(root, 'figma', { outputDir })), root)
  }
  assert.deepEqual(snapshot(target), before)
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
  assert.equal(fs.existsSync(path.join(target, 'output')), false)
})

test(
  'Windows case aliases are accepted without relaxing junction rejection',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = temporary(t)
    const outputDir = path.join(root.toUpperCase(), 'MixedCaseOutput')
    assert.deepEqual(prepareFigPluginHost(options(root, 'figma', { outputDir })), {
      host: 'figma',
      fileCount: 4
    })
    assert.equal(fs.readdirSync(outputDir).length, 4)
  }
)

for (const name of ['manifest.template.json', 'code.js', 'ui.html']) {
  for (const kind of ['empty', 'oversized', 'hardlinked', 'directory']) {
    test(`source guard: ${name} is refused when ${kind}, without output or source mutation`, async (t) => {
      const { root, sourceDir, prepare, input } = await isolated(t)
      const source = path.join(sourceDir, name)
      if (kind === 'empty') fs.truncateSync(source, 0)
      if (kind === 'oversized') fs.truncateSync(source, MAX_FILE + 1)
      if (kind === 'hardlinked') fs.linkSync(source, path.join(root, 'synthetic-hardlink'))
      if (kind === 'directory') {
        fs.unlinkSync(source)
        fs.mkdirSync(source)
      }
      const before = snapshot(sourceDir)
      rejected(input, prepare)
      assert.equal(fs.existsSync(input.outputDir), false)
      assert.deepEqual(snapshot(sourceDir), before)
    })
  }
}

test('source junction ancestors are refused in an isolated copy', async (t) => {
  const { root, sourceDir, prepare, input } = await isolated(t)
  const target = path.join(root, 'synthetic-source-target')
  fs.renameSync(sourceDir, target)
  const before = snapshot(target)
  fs.symlinkSync(target, sourceDir, process.platform === 'win32' ? 'junction' : 'dir')
  rejected(input, prepare)
  assert.equal(fs.existsSync(input.outputDir), false)
  assert.deepEqual(snapshot(target), before)
})

test('bounded source reads accept exactly 2 MiB and never evaluate copied host code', async (t) => {
  const { sourceDir, prepare, input } = await isolated(t)
  const code = path.join(sourceDir, 'code.js')
  const content = Buffer.alloc(MAX_FILE, 32)
  content.write('throw new Error("HOST_CODE_MUST_NOT_RUN");\n')
  fs.writeFileSync(code, content)
  const originalRead = fs.readSync
  let reads = 0
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    reads++
    assert.ok(buffer.length <= MAX_FILE && length <= MAX_FILE)
    return originalRead(fd, buffer, offset, length, position)
  })
  t.mock.method(globalThis, 'fetch', () => assert.fail('preparation must remain offline'))
  prepare(input)
  assert.ok(reads >= 9)
  assert.deepEqual(fs.readFileSync(path.join(input.outputDir, 'code.js')), content)
})

test('source changes during a read are detected before output creation', async (t) => {
  const { sourceDir, prepare, input } = await isolated(t)
  const source = path.join(sourceDir, 'manifest.template.json')
  const originalRead = fs.readSync
  let changed = false
  t.mock.method(fs, 'readSync', (...args) => {
    const result = originalRead(...args)
    if (!changed) {
      changed = true
      fs.appendFileSync(source, ' ')
    }
    return result
  })
  rejected(input, prepare)
  assert.equal(changed, true)
  assert.equal(fs.existsSync(input.outputDir), false)
})

test('an output created concurrently before mkdir is preserved, not reused', (t) => {
  const root = temporary(t)
  const input = options(root)
  const originalMkdir = fs.mkdirSync
  let before
  t.mock.method(fs, 'mkdirSync', (name, ...args) => {
    if (name === input.outputDir && !before) {
      originalMkdir(name)
      fs.writeFileSync(path.join(name, 'manifest.json'), 'synthetic concurrent user file', {
        flag: 'wx'
      })
      before = snapshot(name)
    }
    return originalMkdir(name, ...args)
  })
  rejected(input)
  assert.ok(before)
  assert.deepEqual(snapshot(input.outputDir), before)
})

test('exclusive file creation preserves a concurrently inserted manifest', (t) => {
  const root = temporary(t)
  const input = options(root)
  const target = path.join(input.outputDir, 'manifest.json')
  const originalOpen = fs.openSync
  let inserted = false
  let before
  t.mock.method(fs, 'openSync', (name, ...args) => {
    if (name === target && !inserted) {
      inserted = true
      const handle = originalOpen(name, 'wx')
      fs.writeFileSync(handle, 'synthetic concurrent manifest')
      fs.closeSync(handle)
      before = snapshot(target)
    }
    return originalOpen(name, ...args)
  })
  rejected(input)
  assert.ok(before)
  assert.deepEqual(snapshot(target), before)
  assert.deepEqual(fs.readdirSync(input.outputDir), ['manifest.json'])
})

test('directory identity replacement is caught without writing into or removing user files', (t) => {
  const root = temporary(t)
  const parent = path.join(root, 'parent')
  const parked = path.join(root, 'parked')
  fs.mkdirSync(parent)
  fs.writeFileSync(path.join(parent, 'synthetic-user-file'), 'keep original', { flag: 'wx' })
  const input = options(parent)
  const originalMkdir = fs.mkdirSync
  let replaced = false
  t.mock.method(fs, 'mkdirSync', (name, ...args) => {
    if (name === input.outputDir && !replaced) {
      replaced = true
      fs.renameSync(parent, parked)
      originalMkdir(parent)
      fs.writeFileSync(path.join(parent, 'synthetic-user-file'), 'keep replacement', { flag: 'wx' })
    }
    return originalMkdir(name, ...args)
  })
  rejected(input)
  assert.equal(replaced, true)
  assert.equal(fs.readFileSync(path.join(parked, 'synthetic-user-file'), 'utf8'), 'keep original')
  assert.equal(
    fs.readFileSync(path.join(parent, 'synthetic-user-file'), 'utf8'),
    'keep replacement'
  )
  assert.deepEqual(fs.readdirSync(input.outputDir), [])
})

test('CLI errors never echo secret-shaped input, paths, stack traces, or raw filesystem errors', (t) => {
  const root = temporary(t)
  for (const change of [
    { pluginId: 'SYNTHETIC_SENSITIVE_PLUGIN' },
    { keyId: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NOT_A_KEY\n-----END PRIVATE KEY-----' },
    { outputDir: path.join(root, 'SYNTHETIC_PRIVATE_PATH', 'missing', 'output') },
    { issuedAt: 'SYNTHETIC_PRIVATE_DATE' },
    { bridgeOrigin: 'http://SYNTHETIC_PRIVATE_ORIGIN:24816' }
  ])
    cliRejected(cliArgs(options(root, 'figma', change)), root)
  assert.deepEqual(fs.readdirSync(root), [])
})

function configPrefix(input) {
  const config = {
    protocol: 1,
    origin: input.bridgeOrigin,
    pluginId: `user.${input.host}.${hash(input.pluginId).slice(0, 32)}`,
    host: input.host
  }
  return Buffer.from(
    `globalThis.MAGICPOT_BRIDGE_CONFIG = Object.freeze(${JSON.stringify(config)});\n`
  )
}

function checkConnected(input, sourceDir) {
  const spec = HOSTS[input.host]
  const read = (name) => fs.readFileSync(path.join(input.outputDir, name))
  assert.deepEqual(
    fs.readdirSync(input.outputDir).sort(),
    ['manifest.json', spec.code, spec.ui, 'package.template.json'].sort()
  )
  const native = JSON.parse(read('manifest.json'))
  const template = JSON.parse(read('package.template.json'))
  const expected = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.template.json')))
  expected.id = input.pluginId
  if (input.host === 'figma') {
    expected.networkAccess = {
      allowedDomains: [input.bridgeOrigin],
      reasoning: 'Connect only to the locally paired MagicPot desktop bridge.'
    }
  } else {
    expected.requiredPermissions = {
      localFileSystem: 'plugin',
      network: { domains: [input.bridgeOrigin] }
    }
  }
  assert.deepEqual(native, expected)
  assert.equal(template.schemaVersion, 2)
  assert.equal(template.host, input.host)
  assert.equal(template.entryPath, 'manifest.json')
  assert.equal(template.id, `user.${input.host}.${hash(input.pluginId).slice(0, 32)}`)
  assert.deepEqual(template.capabilities, ['dialogue', 'asset-transfer', 'result-transfer'])
  assert.deepEqual(template.permissions, {
    dialogue: 'prompt',
    backgroundRemoval: 'none',
    assetTransfer: 'read',
    resultTransfer: 'write',
    filesystem: 'none',
    network: 'desktop-bridge'
  })
  assert.deepEqual(template.bridge, { protocol: 1, origin: input.bridgeOrigin })
  assert.deepEqual(template.limits, {
    maxPayloadBytes: 64 * 1024,
    maxResultBytes: 32 * 1024,
    maxConfigBytes: 16 * 1024,
    maxCallTimeoutMs: 90_000,
    maxConcurrentCalls: 1
  })
  assert.deepEqual(template.provenance, {
    publisherId: input.publisherId,
    publisherName: 'User-provided development publisher',
    source: 'user-provided',
    issuedAt: input.issuedAt
  })
  assert.deepEqual(template.signature, {
    algorithm: 'ed25519',
    keyId: input.keyId,
    signedAt: input.issuedAt
  })
  assert.deepEqual(template.assets, [
    { id: 'native-manifest', path: 'manifest.json', mimeType: 'application/json' },
    { id: 'native-code', path: spec.code, mimeType: 'text/javascript' },
    { id: 'native-ui', path: spec.ui, mimeType: 'text/html' }
  ])
  for (const document of [native, template]) {
    assert.doesNotMatch(JSON.stringify(document), /__[A-Z_]+__|PRIVATE KEY/)
  }
  for (const asset of template.assets) assert.ok(read(asset.path).length > 0)
  assert.deepEqual(
    read(spec.code),
    Buffer.concat([
      configPrefix(input),
      fs.readFileSync(path.join(path.dirname(sourceDir), 'shared', 'selection-snapshot.js')),
      HELPER_SEPARATOR,
      fs.readFileSync(path.join(path.dirname(sourceDir), 'shared', 'plan-preview.js')),
      HELPER_SEPARATOR,
      fs.readFileSync(path.join(sourceDir, 'bridge', spec.code))
    ])
  )
  assert.doesNotThrow(() => new Script(read(spec.code).toString('utf8')))
  assert.deepEqual(read(spec.ui), fs.readFileSync(path.join(sourceDir, 'bridge', spec.ui)))
  return template
}

for (const [host, spec] of Object.entries(HOSTS)) {
  test(`${host} v2: exact native allowlist, root manifest only, four files and prepended config without execution`, async (t) => {
    const { root, sourceDir, prepare, input, script } = await isolated(t, host, true)
    const manifestPath = path.join(sourceDir, 'manifest.template.json')
    const native = JSON.parse(fs.readFileSync(manifestPath))
    if (host === 'figma') native.networkAccess = { allowedDomains: ['*'], devAllowedDomains: ['*'] }
    else
      native.requiredPermissions = { localFileSystem: 'fullAccess', network: { domains: ['all'] } }
    fs.writeFileSync(manifestPath, JSON.stringify(native))
    // Connected preparation must not read the old native code or UI.
    fs.unlinkSync(path.join(sourceDir, spec.code))
    fs.unlinkSync(path.join(sourceDir, spec.ui))
    const before = snapshot(sourceDir)
    t.mock.method(globalThis, 'fetch', () => assert.fail('preparation must remain offline'))
    for (const port of [1024, 65535]) {
      const value = {
        ...input,
        bridgeOrigin: `http://127.0.0.1:${port}`,
        outputDir: path.join(root, String(port))
      }
      assert.deepEqual(prepare(value), { host, fileCount: 4 })
      checkConnected(value, sourceDir)
      const copy = { ...value, outputDir: path.join(root, `cli-${port}`) }
      const result = cli(cliArgs(copy), root, script)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, '')
      assert.match(result.stdout, /prepared \(4 files\).*No host code executed; desktop not paired/)
      assert.match(result.stdout, /unsigned and does not establish publisher trust/)
      for (const name of fs.readdirSync(value.outputDir)) {
        assert.deepEqual(
          fs.readFileSync(path.join(value.outputDir, name)),
          fs.readFileSync(path.join(copy.outputDir, name))
        )
      }
    }
    assert.deepEqual(snapshot(sourceDir), before)
  })

  test(`${host} v2: real connected sources satisfy the same four-file artifact contract`, (t) => {
    const root = temporary(t)
    const input = options(root, host, { bridgeOrigin: ORIGIN })
    const sourceDir = path.join(SOURCES, spec.directory)
    const before = [spec.code, spec.ui].map((name) =>
      snapshot(path.join(sourceDir, 'bridge', name))
    )
    const helperPath = path.join(SOURCES, 'shared', 'selection-snapshot.js')
    const helperBefore = snapshot(helperPath)
    t.mock.method(globalThis, 'fetch', () => assert.fail('preparation must remain offline'))
    assert.equal(Object.hasOwn(globalThis, 'MagicPotSelectionSnapshotV1'), false)
    prepareFigPluginHost(input)
    checkConnected(input, sourceDir)
    assert.equal(Object.hasOwn(globalThis, 'MagicPotSelectionSnapshotV1'), false)
    assert.deepEqual(snapshot(helperPath), helperBefore)
    assert.deepEqual(
      [spec.code, spec.ui].map((name) => snapshot(path.join(sourceDir, 'bridge', name))),
      before
    )
  })

  test(`${host} v2: origin is signed in metadata and embedded native bytes; changes and tampering are visible`, async (t) => {
    const { root, sourceDir, prepare, input } = await isolated(t, host, true)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const packages = []
    for (const port of [24816, 24817]) {
      const value = {
        ...input,
        bridgeOrigin: `http://127.0.0.1:${port}`,
        outputDir: path.join(root, String(port))
      }
      prepare(value)
      const manifest = checkConnected(value, sourceDir)
      const files = manifest.assets.map(({ path: name }) => ({
        path: name,
        data: fs.readFileSync(path.join(value.outputDir, name))
      }))
      const result = buildFigPluginPackage({ manifest, files, privateKeyPem })
      assert.deepEqual(buildFigPluginPackage({ manifest, files, privateKeyPem }), result)
      const wire = JSON.parse(result.packageText)
      assert.equal(wire.format, 'magicpot.figplugin.package.v1')
      assert.equal(wire.files.length, 3)
      assert.equal(wire.manifest.schemaVersion, 2)
      const signature = Buffer.from(wire.manifest.signature.value, 'hex')
      const unsigned = structuredClone(wire.manifest)
      delete unsigned.signature.value
      const valid = (m) =>
        verify(null, Buffer.from(`${wire.format}\n${canonical(m)}`), publicKey, signature)
      assert.equal(valid(unsigned), true)
      for (const change of [
        (m) => {
          m.bridge.origin = 'http://127.0.0.1:24818'
        },
        (m) => {
          m.bridge.protocol = 2
        },
        (m) => {
          m.schemaVersion = 1
        },
        (m) => {
          m.permissions.network = 'none'
        },
        (m) => {
          m.assets.find(({ path: name }) => name === spec.code).sha256 = '0'.repeat(64)
        }
      ]) {
        const tampered = structuredClone(unsigned)
        change(tampered)
        assert.equal(valid(tampered), false)
      }
      for (const file of wire.files) {
        const expected = files.find(({ path: name }) => name === file.path).data
        assert.deepEqual(Buffer.from(file.contentBase64, 'base64'), expected)
        assert.equal(file.sha256, hash(expected))
        assert.equal(file.bytes, expected.length)
      }
      const code = wire.files.find(({ path: name }) => name === spec.code)
      const tamperedCode = Buffer.from(
        Buffer.from(code.contentBase64, 'base64')
          .toString()
          .replace(value.bridgeOrigin, 'http://127.0.0.1:24818')
      )
      assert.notEqual(hash(tamperedCode), code.sha256)
      packages.push(wire)
    }
    assert.equal(packages[0].manifest.id, packages[1].manifest.id)
    assert.notEqual(packages[0].manifest.signature.value, packages[1].manifest.signature.value)
    assert.notEqual(
      packages[0].manifest.provenance.artifactSha256,
      packages[1].manifest.provenance.artifactSha256
    )
  })

  test(`${host} v2: root native document must retain the unresolved host ID and declared native assets`, async (t) => {
    const { sourceDir, prepare, input } = await isolated(t, host, true)
    const name = path.join(sourceDir, 'manifest.template.json')
    const native = JSON.parse(fs.readFileSync(name))
    for (const change of [
      { id: spec.pluginId },
      { id: '__OTHER_ID__' },
      { main: '../other.js' },
      { main: 'missing.js' },
      ...(host === 'figma' ? [{ ui: 'missing.html' }] : [])
    ]) {
      fs.writeFileSync(name, JSON.stringify({ ...native, ...change }))
      rejected(input, prepare)
      assert.equal(fs.existsSync(input.outputDir), false)
    }
  })
}

test('optional bridge origin never accepts blank values, URL aliases, wildcard permissions or accessor properties', (t) => {
  const root = temporary(t)
  for (const bridgeOrigin of [
    undefined,
    null,
    24816,
    {},
    [],
    '',
    ' ',
    '*',
    'http://localhost:24816',
    'http://127.1:24816',
    'http://2130706433:24816',
    'http://0x7f000001:24816',
    'http://0177.0.0.1:24816',
    'http://[::1]:24816',
    'http://0.0.0.0:24816',
    'http://127.0.0.2:24816',
    'http://127.0.0.1.:24816',
    'http://127.0.0.1.example.invalid:24816',
    'https://127.0.0.1:24816',
    'HTTP://127.0.0.1:24816',
    'http://user@127.0.0.1:24816',
    'http://127.0.0.1:*',
    'http://127.0.0.1:80',
    'http://127.0.0.1:1023',
    'http://127.0.0.1:65536',
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
  ])
    rejected(options(root, 'figma', { bridgeOrigin }))
  const input = options(root, 'figma', { bridgeOrigin: ORIGIN })
  let reads = 0
  rejected(
    Object.defineProperty({ ...input }, 'bridgeOrigin', {
      enumerable: true,
      get() {
        reads++
        throw new Error('SYNTHETIC_SECRET')
      }
    })
  )
  assert.equal(reads, 0)
  rejected(Object.defineProperty({ ...input }, 'bridgeOrigin', { enumerable: false }))
  rejected({ ...input, network: '*' })
  rejected({ ...input, extra: 'secret' })
  for (const [, key] of FLAGS) {
    const missing = { ...input }
    delete missing[key]
    rejected(missing)
  }
  assert.deepEqual(fs.readdirSync(root), [])
})

test('bridge CLI flag is optional and singular; six original flags stay required and errors remain redacted', (t) => {
  const root = temporary(t)
  const args = cliArgs(options(root, 'figma', { bridgeOrigin: ORIGIN }))
  for (let index = 0; index < FLAGS.length; index++) {
    cliRejected(
      args.filter((_, position) => Math.floor(position / 2) !== index),
      root
    )
  }
  for (const invalid of [
    [...args, '--bridge-origin', ORIGIN],
    args.slice(0, -1),
    [...args.slice(0, -1), ''],
    [...args.slice(0, -1), ' '],
    [...args.slice(0, -1), 'http://localhost:24816'],
    [...args.slice(0, -1), 'http://127.0.0.1:1024\n'],
    [...args.slice(0, -1), '*'],
    [...args, '--network', '*'],
    [...args.slice(0, -2), '--bridgeOrigin', ORIGIN]
  ])
    cliRejected(invalid, root)
  assert.deepEqual(fs.readdirSync(root), [])
})

test('connected source guards reject missing, linked and oversized bridge inputs without falling back to v1', async (t) => {
  for (const kind of ['missing', 'hardlinked', 'junction', 'oversized']) {
    const { root, sourceDir, prepare, input } = await isolated(t, 'figma', true)
    const bridgeDir = path.join(sourceDir, 'bridge')
    const code = path.join(bridgeDir, 'code.js')
    if (kind === 'missing') fs.unlinkSync(code)
    if (kind === 'hardlinked') fs.linkSync(code, path.join(root, 'alias'))
    if (kind === 'oversized') fs.truncateSync(code, MAX_FILE + 1)
    if (kind === 'junction') {
      const parked = path.join(root, 'parked')
      fs.renameSync(bridgeDir, parked)
      fs.symlinkSync(parked, bridgeDir, process.platform === 'win32' ? 'junction' : 'dir')
    }
    rejected(input, prepare)
    assert.equal(fs.existsSync(input.outputDir), false)
  }
})

test('connected native byte bound includes the prepended config and helper', async (t) => {
  const { root, sourceDir, prepare, input } = await isolated(t, 'figma', true)
  const code = path.join(sourceDir, 'bridge', 'code.js')
  const content = Buffer.alloc(
    MAX_FILE -
      configPrefix(input).length -
      SYNTHETIC_HELPER.length -
      HELPER_SEPARATOR.length * 2 -
      fs.statSync(path.join(path.dirname(sourceDir), 'shared', 'plan-preview.js')).size,
    32
  )
  content.write('throw new Error("BRIDGE_CODE_MUST_NOT_RUN");\n')
  fs.writeFileSync(code, content)
  prepare(input)
  assert.equal(fs.statSync(path.join(input.outputDir, 'code.js')).size, MAX_FILE)
  fs.appendFileSync(code, ' ')
  const overflow = { ...input, outputDir: path.join(root, 'overflow') }
  rejected(overflow, prepare)
  assert.equal(fs.existsSync(overflow.outputDir), false)
})

for (const host of Object.keys(HOSTS)) {
  for (const kind of ['missing', 'empty', 'oversized', 'directory', 'hardlinked', 'junction']) {
    test(`${host}: connected helper guard rejects ${kind} before output, without v1 fallback`, async (t) => {
      const { root, sourceDir, prepare, input } = await isolated(t, host, true)
      const shared = path.join(path.dirname(sourceDir), 'shared')
      const helper = path.join(shared, 'selection-snapshot.js')
      if (kind === 'missing') fs.unlinkSync(helper)
      if (kind === 'empty') fs.truncateSync(helper, 0)
      if (kind === 'oversized') fs.truncateSync(helper, MAX_FILE + 1)
      if (kind === 'directory') {
        fs.unlinkSync(helper)
        fs.mkdirSync(helper)
      }
      if (kind === 'hardlinked') fs.linkSync(helper, path.join(root, 'helper-alias'))
      let target = shared
      if (kind === 'junction') {
        target = path.join(root, 'helper-target')
        fs.renameSync(shared, target)
        fs.symlinkSync(target, shared, process.platform === 'win32' ? 'junction' : 'dir')
      }
      const before = snapshot(target)
      rejected(input, prepare)
      const result = cli(
        cliArgs(input),
        root,
        path.join(root, 'scripts', 'prepare-figplugin-host.mjs')
      )
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, CLI_ERROR)
      assert.equal(fs.existsSync(input.outputDir), false)
      assert.deepEqual(snapshot(target), before)
    })
  }
  test(`${host}: default-off v1 never reads helper or bridge and keeps native bytes identical`, async (t) => {
    const { root, sourceDir, prepare, input } = await isolated(t, host)
    const shared = path.join(path.dirname(sourceDir), 'shared')
    fs.mkdirSync(shared)
    fs.mkdirSync(path.join(shared, 'selection-snapshot.js'))
    const open = fs.openSync
    t.mock.method(fs, 'openSync', (name, ...args) => {
      assert.equal(String(name).includes('selection-snapshot'), false)
      assert.equal(String(name).includes(path.sep + 'bridge' + path.sep), false)
      return open(name, ...args)
    })
    prepare(input)
    for (const name of [HOSTS[host].code, HOSTS[host].ui]) {
      assert.deepEqual(
        fs.readFileSync(path.join(input.outputDir, name)),
        fs.readFileSync(path.join(sourceDir, name))
      )
    }
    assert.equal(fs.readdirSync(input.outputDir).length, 4)
    assert.equal(fs.existsSync(path.join(root, 'selection-snapshot.js')), false)
  })
}

test('connected helper changes during a guarded read are refused before any output', async (t) => {
  const { sourceDir, prepare, input } = await isolated(t, 'figma', true)
  const helper = path.join(path.dirname(sourceDir), 'shared', 'selection-snapshot.js')
  const open = fs.openSync
  const read = fs.readSync
  let helperFd
  let changed = false
  t.mock.method(fs, 'openSync', (name, ...args) => {
    const fd = open(name, ...args)
    if (name === helper) helperFd = fd
    return fd
  })
  t.mock.method(fs, 'readSync', (...args) => {
    const count = read(...args)
    if (args[0] === helperFd && !changed) {
      changed = true
      fs.appendFileSync(helper, ' ')
    }
    return count
  })
  rejected(input, prepare)
  assert.equal(changed, true)
  assert.equal(fs.existsSync(input.outputDir), false)
})
