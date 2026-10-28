import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  OFFLINE_REMBG_FILES,
  parseOfflineRembgFlag,
  stageOfflineRembg
} from './stage-offline-rembg.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixtures = path.join(root, '.magicpot-trash', 'offline-rembg-stage-tests')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sourceRelative = 'packages/runtime-assets/resources/comfy/magicpot_offline_rembg'
const parentRelative = '.staging/embedded/ComfyUI/custom_nodes'

function fixture(t) {
  fs.mkdirSync(fixtures, { recursive: true })
  const projectRoot = fs.mkdtempSync(path.join(fixtures, 'synthetic-'))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  const source = path.join(projectRoot, sourceRelative)
  const parent = path.join(projectRoot, parentRelative)
  const destination = path.join(parent, 'magicpot_offline_rembg')
  for (const file of OFFLINE_REMBG_FILES) {
    const target = path.join(source, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `# synthetic owned bundle file: ${file}\n`, { flag: 'wx' })
  }
  fs.mkdirSync(parent, { recursive: true })
  fs.writeFileSync(path.join(parent, 'existing-node.txt'), 'preserve existing node\n')
  fs.mkdirSync(path.join(projectRoot, 'vendor/comfyui'), { recursive: true })
  fs.writeFileSync(
    path.join(projectRoot, 'vendor/comfyui/untouched.txt'),
    'vendor remains unchanged\n'
  )
  return { projectRoot, source, parent, destination }
}

const walk = (directory) => {
  const result = {}
  const scan = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      assert(!entry.isSymbolicLink())
      if (entry.isDirectory()) scan(file)
      else
        result[path.relative(directory, file).split(path.sep).join('/')] = sha(
          fs.readFileSync(file)
        )
    }
  }
  scan(directory)
  return result
}

test('CLI flag defaults off and only the exact explicit opt-in enables staging', () => {
  assert.equal(parseOfflineRembgFlag([]), false)
  assert.equal(parseOfflineRembgFlag(['--offline-rembg']), true)
  for (const argv of [
    ['--offline-rembg=1'],
    ['--offline-rembg', '--offline-rembg'],
    ['--unknown'],
    ['--offline-rembg', '--unknown'],
    ['1'],
    '--offline-rembg',
    null,
    [true]
  ])
    assert.throws(() => parseOfflineRembgFlag(argv))
})

test('embedded entry parses opt-in before filesystem preparation and stages only after the existing transforms', () => {
  // Do not import the executable staging entry: that would clone/copy the real Comfy tree.
  const source = fs.readFileSync(path.join(root, 'scripts/prepare-embedded-staging.mjs'), 'utf8')
  assert(
    source.includes(
      "import { parseOfflineRembgFlag, stageOfflineRembg } from './comfy/stage-offline-rembg.mjs'"
    )
  )
  const parse = source.indexOf('parseOfflineRembgFlag(process.argv.slice(2))')
  assert(parse >= 0 && parse < source.indexOf('const localComfyRepo'))
  const main = source.slice(source.indexOf('function main()'))
  const stage = main.indexOf(
    'stageOfflineRembg({ projectRoot: repoRoot, enabled: offlineRembgEnabled })'
  )
  assert(stage > main.indexOf('applySeedVr2CpuDeviceFallback()'))
  assert(stage < main.indexOf('validateStaging()'))
})

test('default off is inert even with absent source and staging trees', () => {
  const projectRoot = path.join(fixtures, 'never-created-default-off')
  assert(!fs.existsSync(projectRoot))
  assert.deepEqual(stageOfflineRembg({ projectRoot }), { staged: false })
  assert.deepEqual(stageOfflineRembg({ projectRoot, enabled: false }), { staged: false })
  assert(!fs.existsSync(projectRoot))
})

test('staging inventory includes both upstream licenses and the accompanying notice', () => {
  const required = [
    '__init__.py',
    'nodes.py',
    'offline_loader.py',
    'rgba8_png.py',
    '_inspyrenet/__init__.py',
    '_inspyrenet/InSPyReNet.py',
    '_inspyrenet/backbones/__init__.py',
    '_inspyrenet/backbones/SwinTransformer.py',
    '_inspyrenet/modules/__init__.py',
    '_inspyrenet/modules/layers.py',
    '_inspyrenet/modules/context_module.py',
    '_inspyrenet/modules/attention_module.py',
    '_inspyrenet/modules/decoder_module.py',
    'LICENSE.inspyrenet',
    'LICENSE.swin',
    'NOTICE',
    'README.md',
    'provenance.json'
  ]
  assert.deepEqual([...OFFLINE_REMBG_FILES].sort(), required.sort())
})

test('the actual owned source bundle stages with all licenses and hashes preserved', (t) => {
  const f = fixture(t)
  const actual = path.join(root, sourceRelative)
  const original = walk(actual)
  for (const relative of Object.keys(original)) {
    const target = path.join(f.source, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(actual, relative), target)
  }
  const before = walk(f.projectRoot)
  const result = stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true })
  assert(result.staged)
  assert.equal(result.files.length, 18)
  assert.deepEqual(walk(f.destination), original)
  assert.deepEqual(walk(actual), original)
  for (const [file, digest] of Object.entries(before))
    assert.equal(sha(fs.readFileSync(path.join(f.projectRoot, file))), digest)
  for (const file of ['LICENSE.inspyrenet', 'LICENSE.swin', 'NOTICE'])
    assert.equal(sha(fs.readFileSync(path.join(f.destination, file))), original[file])
})

test('copies only the fixed owned bundle into a new node directory, never vendor or peers', (t) => {
  const f = fixture(t),
    before = walk(f.projectRoot)
  const result = stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true })
  assert.equal(result.staged, true)
  assert.equal(result.destination, f.destination)
  assert(Object.isFrozen(OFFLINE_REMBG_FILES))
  assert.equal(result.files.length, OFFLINE_REMBG_FILES.length)
  assert.deepEqual(walk(f.destination), walk(f.source))
  for (const [file, expected] of Object.entries(before))
    assert.equal(sha(fs.readFileSync(path.join(f.projectRoot, file))), expected)
  for (const row of result.files) {
    const file = path.join(f.destination, row.path)
    assert.equal(sha(fs.readFileSync(file)), row.sha256)
    assert.equal(fs.statSync(file).size, row.bytes)
  }
  assert.throws(() => stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true }))
  assert.deepEqual(walk(f.destination), walk(f.source))
})

for (const enabled of ['1', 'true', 1, null, [], {}]) {
  test(`rejects ambiguous opt-in ${JSON.stringify(enabled)}`, (t) => {
    const f = fixture(t)
    assert.throws(() => stageOfflineRembg({ projectRoot: f.projectRoot, enabled }))
    assert(!fs.existsSync(f.destination))
  })
}

for (const projectRoot of ['', '.', '../elsewhere', '//server/share/project']) {
  test(`rejects nonlocal or relative project root ${JSON.stringify(projectRoot)}`, () => {
    assert.throws(() => stageOfflineRembg({ projectRoot, enabled: true }))
  })
}

test('refuses unknown options without invoking getters', (t) => {
  const f = fixture(t)
  let calls = 0
  for (const options of [
    { projectRoot: f.projectRoot, enabled: true, source: f.source },
    Object.defineProperty({ projectRoot: f.projectRoot }, 'enabled', {
      enumerable: true,
      get() {
        calls++
        return true
      }
    })
  ])
    assert.throws(() => stageOfflineRembg(options))
  assert.equal(calls, 0)
  assert(!fs.existsSync(f.destination))
})

for (const file of ['checkpoint.pth', 'requirements.txt', '__pycache__/nodes.pyc', 'extra.py']) {
  test(`rejects unowned bundle entry ${file} before creating destination`, (t) => {
    const f = fixture(t),
      extra = path.join(f.source, file)
    fs.mkdirSync(path.dirname(extra), { recursive: true })
    fs.writeFileSync(extra, 'not an approved bundle source')
    assert.throws(() => stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true }))
    assert(!fs.existsSync(f.destination))
  })
}

for (const file of [
  'nodes.py',
  'offline_loader.py',
  '_inspyrenet/backbones/SwinTransformer.py',
  'LICENSE.inspyrenet',
  'LICENSE.swin',
  'NOTICE'
]) {
  test(`requires ${file} before any destination writes`, (t) => {
    const f = fixture(t)
    fs.unlinkSync(path.join(f.source, file))
    assert.throws(() => stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true }))
    assert(!fs.existsSync(f.destination))
  })
}

test('missing staged Comfy custom_nodes is not created as an implicit install', (t) => {
  const f = fixture(t)
  fs.rmSync(f.parent, { recursive: true })
  assert.throws(() => stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true }))
  assert(!fs.existsSync(f.parent))
})

test('an empty, oversized, directory or hardlinked source cannot be copied', (t) => {
  for (const mode of ['empty', 'oversized', 'directory', 'hardlink']) {
    const f = fixture(t),
      file = path.join(f.source, 'nodes.py')
    if (mode === 'empty') fs.writeFileSync(file, '')
    if (mode === 'oversized') fs.writeFileSync(file, Buffer.alloc(512 * 1024 + 1))
    if (mode === 'directory') {
      fs.unlinkSync(file)
      fs.mkdirSync(file)
    }
    if (mode === 'hardlink') fs.linkSync(file, path.join(f.projectRoot, 'peer.py'))
    assert.throws(() => stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true }))
    assert(!fs.existsSync(f.destination))
  }
})

test('total bundle allocation is bounded before any destination writes', (t) => {
  const f = fixture(t)
  for (const file of OFFLINE_REMBG_FILES)
    fs.writeFileSync(path.join(f.source, file), Buffer.alloc(256 * 1024, 32))
  assert.throws(() => stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true }))
  assert(!fs.existsSync(f.destination))
})

for (const branch of ['source', 'parent', 'destination']) {
  test(`refuses ${branch} junction and preserves its target`, (t) => {
    const f = fixture(t),
      outside = path.join(f.projectRoot, 'unowned-target')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged')
    const location = f[branch]
    if (fs.existsSync(location)) fs.rmSync(location, { recursive: true })
    fs.symlinkSync(outside, location, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true }))
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged')
    assert.deepEqual(fs.readdirSync(outside), ['sentinel'])
  })
}

test('an ancestor project junction is rejected before copying', (t) => {
  const f = fixture(t),
    alias = path.join(fixtures, path.basename(f.projectRoot) + '-junction')
  fs.symlinkSync(f.projectRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
  t.after(() => fs.unlinkSync(alias))
  assert.throws(() => stageOfflineRembg({ projectRoot: alias, enabled: true }))
  assert(!fs.existsSync(f.destination))
})

test('the first file exceeding the remaining total budget is never allocated', (t) => {
  const f = fixture(t)
  for (const file of OFFLINE_REMBG_FILES)
    fs.writeFileSync(path.join(f.source, file), Buffer.alloc(256 * 1024, 32))
  const original = Buffer.alloc
  const sizes = []
  const allocation = t.mock.method(Buffer, 'alloc', function (size, ...args) {
    sizes.push(size)
    return Reflect.apply(original, this, [size, ...args])
  })
  assert.throws(() => stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true }))
  allocation.mock.restore()
  assert.equal(sizes.filter((size) => size === 256 * 1024).length, 8)
  assert(!fs.existsSync(f.destination))
})

test('accepts the exact per-file and total byte limits with verified copies', (t) => {
  const f = fixture(t)
  assert.equal(OFFLINE_REMBG_FILES.length, 18)
  const sizes = [512 * 1024, ...Array(16).fill(84 * 1024), 192 * 1024]
  assert.equal(
    sizes.reduce((sum, size) => sum + size, 0),
    2 * 1024 * 1024
  )
  for (const [index, file] of OFFLINE_REMBG_FILES.entries())
    fs.writeFileSync(path.join(f.source, file), Buffer.alloc(sizes[index], 32))
  const result = stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true })
  assert(result.staged)
  assert.equal(
    result.files.reduce((sum, file) => sum + file.bytes, 0),
    2 * 1024 * 1024
  )
  assert.deepEqual(walk(f.destination), walk(f.source))
})

for (const failure of ['write', 'fsync', 'readback']) {
  test(`late ${failure} failure preserves peers and leaves a collision-refused partial destination`, (t) => {
    const f = fixture(t),
      before = walk(f.projectRoot)
    const error = new Error(`synthetic ${failure} failure`)
    let injected
    if (failure === 'write') {
      const original = fs.writeFileSync
      injected = t.mock.method(fs, 'writeFileSync', function (file, ...args) {
        if (typeof file === 'number') throw error
        return Reflect.apply(original, this, [file, ...args])
      })
    } else if (failure === 'fsync') {
      injected = t.mock.method(fs, 'fsyncSync', () => {
        throw error
      })
    } else {
      const original = fs.readSync
      injected = t.mock.method(fs, 'readSync', function (...args) {
        if (fs.existsSync(f.destination)) throw error
        return Reflect.apply(original, this, args)
      })
    }
    assert.throws(
      () => stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true }),
      (thrown) => thrown === error
    )
    injected.mock.restore()
    assert(fs.statSync(f.destination).isDirectory())
    const partial = walk(f.destination)
    for (const [file, expected] of Object.entries(before))
      assert.equal(sha(fs.readFileSync(path.join(f.projectRoot, file))), expected)
    assert.throws(() => stageOfflineRembg({ projectRoot: f.projectRoot, enabled: true }))
    assert.deepEqual(walk(f.destination), partial)
  })
}
