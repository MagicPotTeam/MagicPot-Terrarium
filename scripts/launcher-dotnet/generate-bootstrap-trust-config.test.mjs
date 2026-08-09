import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { generateBootstrapTrustSource, main } from './generate-bootstrap-trust-config.mjs'

const descriptorKey = Buffer.alloc(32, 1).toString('base64')
const manifestKey = Buffer.alloc(32, 2).toString('base64')

test('emits deterministic compiled public trust only', () => {
  const source = generateBootstrapTrustSource('descriptor-key', descriptorKey, 'manifest-key', manifestKey)
  assert.equal(source, generateBootstrapTrustSource('descriptor-key', descriptorKey, 'manifest-key', manifestKey))
  assert.match(source, /CompiledBootstrapTrustConfiguration/)
  assert.match(source, /CreateCompiled\(\s*true,/)
  assert.match(source, /\["descriptor-key"\]/)
  assert.match(source, /\["manifest-key"\]/)
  assert.doesNotMatch(source, /private|secret|seed|token/i)
  assert.ok(!source.includes('\r'))
})

test('rejects non-canonical or non-32-byte public keys and unsafe key IDs', () => {
  assert.throws(() => generateBootstrapTrustSource('bad key', descriptorKey, 'manifest-key', manifestKey), /key-id is invalid/)
  assert.throws(() => generateBootstrapTrustSource('key', Buffer.alloc(31).toString('base64'), 'manifest-key', manifestKey), /32 bytes/)
  assert.throws(() => generateBootstrapTrustSource('key', descriptorKey.replace(/=$/, ''), 'manifest-key', manifestKey), /canonical base64/)
})

test('requires an absolute safe C# output and atomically replaces a regular file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magicpot-bootstrap-trust-'))
  const output = path.join(root, 'CompiledBootstrapTrustConfiguration.Generated.cs')
  const args = ['--output', output, '--descriptor-key-id', 'descriptor-key', '--descriptor-public-key-base64', descriptorKey, '--manifest-key-id', 'manifest-key', '--manifest-public-key-base64', manifestKey]
  await main(args)
  const first = await readFile(output, 'utf8')
  await main(args)
  assert.equal(await readFile(output, 'utf8'), first)
  await assert.rejects(main(['--output', 'relative.cs', ...args.slice(2)]), /absolute/)
})

test('rejects a symlinked output parent', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation is not generally available on Windows test hosts')
  const root = await mkdtemp(path.join(os.tmpdir(), 'magicpot-bootstrap-trust-link-'))
  const real = path.join(root, 'real')
  const linked = path.join(root, 'linked')
  await mkdir(real)
  await symlink(real, linked, 'dir')
  await assert.rejects(main(['--output', path.join(linked, 'trust.cs'), '--descriptor-key-id', 'descriptor-key', '--descriptor-public-key-base64', descriptorKey, '--manifest-key-id', 'manifest-key', '--manifest-public-key-base64', manifestKey]), /real directories/)
})
