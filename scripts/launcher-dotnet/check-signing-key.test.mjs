import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { checkSigningKey, deriveEd25519PublicKey } from './check-signing-key.mjs'

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  const jwk = publicKey.export({ format: 'jwk' })
  return { pem, publicKeyBase64: Buffer.from(jwk.x, 'base64url').toString('base64') }
}

const manifestUrl = 'https://example.test/owner/repo/releases/download/release%2F1/magicpot-launcher-stable-win32-x64-channel.json'
const configuration = (publicKeyBase64) => ({
  schema: 1,
  launcherVersion: '1.2.3',
  channels: {
    stable: manifestUrl,
    beta: 'https://example.test/owner/repo/releases/download/beta/channel.json',
    nightly: 'https://example.test/owner/repo/releases/download/nightly/channel.json'
  },
  trustedSources: [{ origin: 'https://example.test', repoPathPrefix: '/owner/repo' }],
  publicKeys: { 'release-key': publicKeyBase64 },
  bootstrapPublicKeys: { 'release-key': publicKeyBase64 }
})
const options = (pair) => ({
  privateKeyPem: pair.pem,
  configuration: configuration(pair.publicKeyBase64),
  launcherVersion: '1.2.3',
  keyId: 'release-key',
  expectedPublicKeyBase64: pair.publicKeyBase64,
  keySet: 'publicKeys',
  channel: 'stable',
  manifestUrl
})

test('derives the canonical raw Ed25519 public key from PKCS#8 private key material', () => {
  const pair = keyPair()
  assert.equal(deriveEd25519PublicKey(pair.pem).toString('base64'), pair.publicKeyBase64)
})

test('accepts a key that matches the expected manifest trust configuration', () => {
  const pair = keyPair()
  const checked = checkSigningKey(options(pair))
  assert.equal(checked.publicKeyBase64, pair.publicKeyBase64)
  assert.match(checked.fingerprint, /^[0-9a-f]{16}$/)
})

test('accepts a distinct key from bootstrapPublicKeys', () => {
  const manifest = keyPair()
  const bootstrap = keyPair()
  const value = options(manifest)
  value.privateKeyPem = bootstrap.pem
  value.expectedPublicKeyBase64 = bootstrap.publicKeyBase64
  value.keyId = 'bootstrap-key'
  value.keySet = 'bootstrapPublicKeys'
  value.channel = undefined
  value.manifestUrl = undefined
  value.configuration.bootstrapPublicKeys = { 'bootstrap-key': bootstrap.publicKeyBase64 }
  assert.equal(checkSigningKey(value).publicKeyBase64, bootstrap.publicKeyBase64)
})

test('rejects a private key that does not match the declared expected public key', () => {
  const pair = keyPair()
  assert.throws(() => checkSigningKey({ ...options(pair), expectedPublicKeyBase64: keyPair().publicKeyBase64 }), /private key does not match expected/)
})

test('rejects mismatched or missing manifest trust configuration', () => {
  const pair = keyPair()
  const mismatch = options(pair)
  mismatch.configuration.publicKeys['release-key'] = keyPair().publicKeyBase64
  assert.throws(() => checkSigningKey(mismatch), /publicKeys\.release-key does not match/)

  const missing = options(pair)
  missing.configuration.publicKeys = { 'other-key': pair.publicKeyBase64 }
  assert.throws(() => checkSigningKey(missing), /publicKeys must contain exactly one entry/)
})

test('rejects a selected channel URL that is not the manifest being published', () => {
  const pair = keyPair()
  assert.throws(() => checkSigningKey({ ...options(pair), manifestUrl: `${manifestUrl}.other` }), /does not point at the manifest being published/)
})

test('rejects non-Ed25519 private keys', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  assert.throws(() => deriveEd25519PublicKey(pem), /must be Ed25519/)
})
