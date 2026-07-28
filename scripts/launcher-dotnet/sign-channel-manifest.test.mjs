import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { installSafeDeleteTestDelegate, resetSafeDeleteTestHooks, safeDeleteTestHooks } from './test-safe-delete.mjs'
installSafeDeleteTestDelegate()
test.afterEach(resetSafeDeleteTestHooks)

const root = resolve(import.meta.dirname, '../..')
const script = join(root, 'scripts/launcher-dotnet/sign-channel-manifest.ts')
const mockSafeFileOps = join(import.meta.dirname, 'mock-safe-file-ops.mjs')
const helperDirectory = mkdtempSync(join(tmpdir(), 'safe-file-ops-'))
const helper = join(helperDirectory, process.platform === 'win32' ? 'safe-file-ops.cmd' : 'safe-file-ops')
if (process.platform === 'win32') {
  writeFileSync(helper, `@echo off\r\n"${process.execPath}" "${mockSafeFileOps}" %*\r\n`)
} else {
  writeFileSync(helper, `#!/bin/sh\nexec "${process.execPath}" "${mockSafeFileOps}" "$@"\n`)
  chmodSync(helper, 0o700)
}
const childEnvironment = { ...process.env, NODE_ENV: 'test', NODE_NO_WARNINGS: '1', MAGICPOT_SAFE_FILE_OPS: resolve(helper) }
const unsigned = {
  schema: 1,
  channel: 'stable',
  generatedAt: '2025-01-02T03:04:05Z',
  releases: []
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`
}
function setup(keyType = 'ed25519') {
  const directory = mkdtempSync(join(tmpdir(), 'manifest-sign-'))
  const pair =
    keyType === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('rsa', { modulusLength: 2048 })
  const input = join(directory, 'unsigned.json')
  const key = join(directory, 'offline-private.pem')
  writeFileSync(input, JSON.stringify(unsigned))
  writeFileSync(key, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  return { directory, input, key, ...pair }
}
function run(arguments_, cwd = root) {
  return spawnSync(
    'npx',
    ['tsx', '--tsconfig', join(root, 'config/tsconfig/tsconfig.node.json'), script, ...arguments_],
    { cwd, encoding: 'utf8', shell: process.platform === 'win32', env: childEnvironment }
  )
}
function args(state, output, extra = []) {
  return [
    '--input',
    state.input,
    '--output',
    output,
    '--private-key',
    state.key,
    '--key-id',
    'release-2025',
    ...extra
  ]
}
function expectFailure(result, state) {
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /^signing failed: /)
  assert.ok(!result.stderr.includes('BEGIN PRIVATE KEY'))
  assert.ok(!result.stderr.includes(state.key))
  assert.ok(!result.stderr.includes(basename(state.key)))
}
let signerModulePromise
async function signerModule() {
  process.env.NODE_ENV = 'test'
  signerModulePromise ??= import('./sign-channel-manifest.ts')
  return signerModulePromise
}
function signedContents(state) {
  const value = sign(null, Buffer.from(canonical(unsigned)), state.privateKey)
  return `${JSON.stringify(
    {
      ...unsigned,
      signature: { algorithm: 'ed25519', keyId: 'release-2025', value: value.toString('base64') }
    },
    null,
    2
  )}\n`
}

test('publishes a verified deterministic manifest', () => {
  const state = setup()
  const first = join(state.directory, 'signed-1.json')
  const second = join(state.directory, 'signed-2.json')
  const jwk = state.publicKey.export({ format: 'jwk' })
  const expected = Buffer.from(jwk.x, 'base64url').toString('base64')
  const firstResult = run(args(state, first, ['--expected-public-key-base64', expected]))
  assert.equal(firstResult.status, 0, firstResult.stderr)
  const secondResult = run(args(state, second))
  assert.equal(secondResult.status, 0, secondResult.stderr)
  assert.deepEqual(readFileSync(first), readFileSync(second))
  const manifest = JSON.parse(readFileSync(first, 'utf8'))
  const { signature, ...payload } = manifest
  assert.equal(
    verify(
      null,
      Buffer.from(canonical(payload)),
      state.publicKey,
      Buffer.from(signature.value, 'base64')
    ),
    true
  )
  payload.generatedAt = '2025-01-02T03:04:06Z'
  assert.equal(
    verify(
      null,
      Buffer.from(canonical(payload)),
      state.publicKey,
      Buffer.from(signature.value, 'base64')
    ),
    false
  )
  assert.deepEqual(Object.keys(manifest), [
    'schema',
    'channel',
    'generatedAt',
    'releases',
    'signature'
  ])
})

test('rejects signed and unknown or private top-level fields', () => {
  for (const extra of [{ signature: {} }, { unknown: true }, { private: 'secret' }]) {
    const state = setup()
    writeFileSync(state.input, JSON.stringify({ ...unsigned, ...extra }))
    expectFailure(run(args(state, join(state.directory, 'out.json'))), state)
  }
})

test('rejects relative paths and removed --force option', () => {
  const state = setup()
  expectFailure(
    run(
      [
        '--input',
        'unsigned.json',
        '--output',
        'out.json',
        '--private-key',
        'key.pem',
        '--key-id',
        'release-2025'
      ],
      state.directory
    ),
    state
  )
  expectFailure(run(args(state, join(state.directory, 'forced.json'), ['--force'])), state)
})

test('concurrent publishers never replace the winner output', async () => {
  const state = setup()
  const output = join(state.directory, 'race.json')
  const command = [
    'tsx',
    '--tsconfig',
    join(root, 'config/tsconfig/tsconfig.node.json'),
    script,
    ...args(state, output)
  ]
  const launch = () =>
    new Promise((resolvePromise) => {
      const child = spawn('npx', command, {
        cwd: root,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnvironment
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('close', (status) => resolvePromise({ status, stderr }))
    })
  const results = await Promise.all([launch(), launch()])
  assert.deepEqual(results.map(({ status }) => status).sort(), [0, 1])
  const loser = results.find(({ status }) => status !== 0)
  expectFailure(loser, state)
  assert.match(loser.stderr, /output already exists/)
  const manifest = JSON.parse(readFileSync(output, 'utf8'))
  const { signature, ...payload } = manifest
  assert.equal(
    verify(
      null,
      Buffer.from(canonical(payload)),
      state.publicKey,
      Buffer.from(signature.value, 'base64')
    ),
    true
  )
})

test('rejects bad key type, wrong expected key, invalid key ID, and existing output', () => {
  const rsa = setup('rsa')
  expectFailure(run(args(rsa, join(rsa.directory, 'rsa.json'))), rsa)
  const wrong = setup()
  const other = setup()
  const otherJwk = other.publicKey.export({ format: 'jwk' })
  const expected = Buffer.from(otherJwk.x, 'base64url').toString('base64')
  expectFailure(
    run(
      args(wrong, join(wrong.directory, 'wrong.json'), ['--expected-public-key-base64', expected])
    ),
    wrong
  )
  expectFailure(
    run([
      '--input',
      wrong.input,
      '--output',
      join(wrong.directory, 'id.json'),
      '--private-key',
      wrong.key,
      '--key-id',
      'BAD_ID'
    ]),
    wrong
  )
  const existing = join(wrong.directory, 'existing.json')
  writeFileSync(existing, 'keep')
  expectFailure(run(args(wrong, existing)), wrong)
  assert.equal(readFileSync(existing, 'utf8'), 'keep')
})

test('rejects hard-linked private keys and inputs', () => {
  const privateState = setup()
  linkSync(privateState.key, join(privateState.directory, 'private-alias.pem'))
  expectFailure(
    run(args(privateState, join(privateState.directory, 'private-out.json'))),
    privateState
  )

  const inputState = setup()
  linkSync(inputState.input, join(inputState.directory, 'input-alias.json'))
  expectFailure(run(args(inputState, join(inputState.directory, 'input-out.json'))), inputState)
})

test('rejects duplicate JSON keys at top, release, artifact, and escaped-equivalent levels', () => {
  const cases = [
    '{"schema":1,"schema":1,"channel":"stable","generatedAt":"2025-01-02T03:04:05Z","releases":[]}',
    '{"schema":1,"channel":"stable","generatedAt":"2025-01-02T03:04:05Z","releases":[{"version":"1.0.0","version":"1.0.0"}]}',
    '{"schema":1,"channel":"stable","generatedAt":"2025-01-02T03:04:05Z","releases":[{"artifacts":{"app":{"kind":"app","kind":"app"}}}]}',
    '{"schema":1,"\\u0073chema":1,"channel":"stable","generatedAt":"2025-01-02T03:04:05Z","releases":[]}'
  ]
  for (const contents of cases) {
    const state = setup()
    writeFileSync(state.input, contents)
    const result = run(args(state, join(state.directory, 'duplicate.json')))
    expectFailure(result, state)
    assert.match(result.stderr, /duplicate object key/)
  }
})

test('rejects parent replacement before linking without publishing into replacement', async () => {
  const state = setup()
  const { publishNoReplace } = await signerModule()
  const parent = join(state.directory, 'publish')
  const moved = join(state.directory, 'publish-original')
  const output = join(parent, 'signed.json')
  mkdirSync(parent)
  assert.throws(
    () =>
      publishNoReplace(output, signedContents(state), 'stable', 'release-2025', state.publicKey, {
        beforeLink() {
          renameSync(parent, moved)
          mkdirSync(parent)
        }
      }),
    /output parent changed during publication|could not publish output safely|EPERM/
  )
  assert.equal(existsSync(output), false)
  assert.equal(existsSync(join(moved, 'signed.json')), false)
})

test('self-verification failure after writing removes its own output', async () => {
  const state = setup()
  const { publishNoReplace } = await signerModule()
  const output = join(state.directory, 'signed.json')
  assert.throws(
    () => publishNoReplace(output, signedContents(state), 'stable', 'release-2025', state.publicKey, {
      afterLink({ output: linkedOutput }) { writeFileSync(linkedOutput, 'corrupted') }
    }),
    /self-verification|safety checks|could not publish output safely/
  )
  assert.equal(existsSync(output), false)
})

test('rejects output replacement after linking and never deletes replacement output', async () => {
  const state = setup()
  const { publishNoReplace } = await signerModule()
  const output = join(state.directory, 'signed.json')
  const replacement = join(state.directory, 'old-valid.json')
  writeFileSync(replacement, signedContents(state))
  assert.throws(
    () =>
      publishNoReplace(output, signedContents(state), 'stable', 'release-2025', state.publicKey, {
        afterLink() {
          unlinkSync(output)
          renameSync(replacement, output)
        }
      }),
    /published output failed safety checks.*output path was replaced and requires quarantine/
  )
  assert.equal(readFileSync(output, 'utf8'), signedContents(state))
})

test('cleanup failures are aggregated instead of reporting publication success', async () => {
  const state = setup()
  const { publishNoReplace } = await signerModule()
  const output = join(state.directory, 'signed.json')
  safeDeleteTestHooks.beforeUnlink = (request) => { if (request.path === output) throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
  try {
    assert.throws(
      () => publishNoReplace(output, signedContents(state), 'stable', 'release-2025', state.publicKey, { afterLink() { throw new Error('injected publication failure') } }),
      (error) => error instanceof AggregateError && error.message === 'publication failed and unverified output could not be removed' && error.errors.length === 2
    )
    assert.equal(existsSync(output), true)
  } finally { resetSafeDeleteTestHooks(); if (existsSync(output)) unlinkSync(output) }
})

test('cleanup lstat ENOENT preserves the original publication error', async () => {
  const state = setup()
  const { publishNoReplace } = await signerModule()
  const output = join(state.directory, 'signed.json')
  try {
    assert.throws(
      () => publishNoReplace(output, signedContents(state), 'stable', 'release-2025', state.publicKey, { afterLink() { unlinkSync(output); throw new Error('injected publication failure') } }),
      /injected publication failure/
    )
    assert.equal(existsSync(output), false)
  } finally { resetSafeDeleteTestHooks() }
})

test('rejects temporary path replacement and cleans neither attacker path nor output', async () => {
  const state = setup()
  const { publishNoReplace } = await signerModule()
  const output = join(state.directory, 'signed.json')
  let attackerTemporary
  const expected = signedContents(state)
  assert.throws(
    () => publishNoReplace(output, expected, 'stable', 'release-2025', state.publicKey, {
      beforeLink({ temporary }) {
        unlinkSync(temporary)
        writeFileSync(temporary, 'attacker-owned')
        attackerTemporary = temporary
      }
    }),
    /published output failed safety checks|could not publish output safely/
  )
  assert.equal(readFileSync(attackerTemporary, 'utf8'), 'attacker-owned')
  if (existsSync(output)) {
    const bytes = readFileSync(output)
    assert.deepEqual(bytes, Buffer.from(expected))
    const parsed = JSON.parse(bytes.toString('utf8'))
    const signature = Buffer.from(parsed.signature.value, 'base64')
    delete parsed.signature
    assert.equal(verify(null, Buffer.from(canonical(parsed)), state.publicKey, signature), true)
  }
})

test('rejects identical paths without leaking private material or path', () => {
  const state = setup()
  const pem = readFileSync(state.key, 'utf8')
  const result = run([
    '--input',
    state.key,
    '--output',
    join(state.directory, 'out.json'),
    '--private-key',
    state.key,
    '--key-id',
    'release-2025'
  ])
  expectFailure(result, state)
  assert.ok(!result.stderr.includes(pem.trim()))
})
