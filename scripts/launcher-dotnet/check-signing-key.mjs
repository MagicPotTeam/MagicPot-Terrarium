import {
  createHash,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual
} from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateConfiguration } from './generate-update-config.mjs'

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CHANNELS = new Set(['stable', 'beta', 'nightly'])
const MAX_PRIVATE_KEY_BYTES = 16 * 1024
const MAX_CONFIG_BYTES = 2 * 1024 * 1024

function fail(message) {
  throw new Error(`signing key check rejected: ${message}`)
}

function decodePublicKey(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(value)) {
    fail(`${label} must be canonical Base64 for exactly 32 bytes`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== 32 || bytes.toString('base64') !== value) {
    fail(`${label} must be canonical Base64 for exactly 32 bytes`)
  }
  return bytes
}

export function deriveEd25519PublicKey(privateKeyPem) {
  const pem = Buffer.isBuffer(privateKeyPem) ? privateKeyPem : Buffer.from(privateKeyPem)
  if (!/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]*\r?\n-----END PRIVATE KEY-----\r?\n?$/.test(pem.toString('utf8'))) {
    fail('private key must be PKCS#8 PEM')
  }

  let privateKey
  try {
    privateKey = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' })
  } catch {
    fail('private key is invalid')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('private key must be Ed25519')

  let jwk
  try {
    jwk = createPublicKey(privateKey).export({ format: 'jwk' })
  } catch {
    fail('Ed25519 public key derivation failed')
  }
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    fail('derived public key is not Ed25519')
  }
  const raw = Buffer.from(jwk.x, 'base64url')
  if (raw.length !== 32) fail('derived Ed25519 public key is not 32 bytes')
  return raw
}

function configuredKey(entries, keyId, location) {
  const matches = entries.filter(([candidate]) => candidate === keyId)
  if (matches.length !== 1) fail(`${location} must contain exactly one entry for key ID ${keyId}`)
  return matches[0][1]
}

export function checkSigningKey(options) {
  if (!KEY_ID.test(options.keyId) || options.keyId.includes('..')) fail('key ID is invalid')
  if (!['publicKeys', 'bootstrapPublicKeys'].includes(options.keySet)) fail('key set must be publicKeys or bootstrapPublicKeys')
  if (options.keySet === 'publicKeys' && !CHANNELS.has(options.channel)) fail('channel must be stable, beta, or nightly')

  const configuration = validateConfiguration(options.configuration, options.launcherVersion)
  const expected = decodePublicKey(options.expectedPublicKeyBase64, 'expected public key')
  const derived = deriveEd25519PublicKey(options.privateKeyPem)
  if (!timingSafeEqual(derived, expected)) fail('private key does not match expected public key')

  const configured = configuredKey(configuration[options.keySet], options.keyId, options.keySet)
  if (!timingSafeEqual(derived, configured)) {
    fail(`${options.keySet}.${options.keyId} does not match the signing private key`)
  }
  if (options.keySet === 'publicKeys') {
    let manifestUrl
    try {
      manifestUrl = new URL(options.manifestUrl)
    } catch {
      fail('manifest URL must be an absolute HTTPS URL')
    }
    if (manifestUrl.protocol !== 'https:' || manifestUrl.username || manifestUrl.password || manifestUrl.hash) {
      fail('manifest URL must be credential-free HTTPS without a fragment')
    }
    if (configuration.channels[options.channel].href !== manifestUrl.href) {
      fail(`channels.${options.channel} does not point at the manifest being published`)
    }
  }

  return {
    publicKeyBase64: derived.toString('base64'),
    fingerprint: createHash('sha256').update(derived).digest('hex').slice(0, 16)
  }
}

function readRegularFile(filePath, maximumBytes, label) {
  if (!path.isAbsolute(filePath)) fail(`${label} path must be absolute`)
  const resolved = path.resolve(filePath)
  let current = resolved
  while (true) {
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      fail(`${label} is unavailable`)
    }
    if (stat.isSymbolicLink()) fail(`${label} path must not traverse a symbolic link`)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  const before = lstatSync(resolved)
  if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > maximumBytes) {
    fail(`${label} must be a nonempty single-link regular file within the size limit`)
  }
  const bytes = readFileSync(resolved)
  const after = lstatSync(resolved)
  if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1 || after.size !== bytes.length) {
    fail(`${label} changed while it was being read`)
  }
  return bytes
}

function parseArgs(argv) {
  const allowed = new Set([
    '--private-key',
    '--config',
    '--launcher-version',
    '--key-id',
    '--expected-public-key-base64',
    '--key-set',
    '--channel',
    '--manifest-url'
  ])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(name) || !value || value.startsWith('--') || values.has(name)) fail('invalid command line')
    values.set(name, value)
  }
  for (const name of ['--private-key', '--config', '--launcher-version', '--key-id', '--expected-public-key-base64', '--key-set']) {
    if (!values.has(name)) fail(`${name} is required`)
  }
  const keySet = values.get('--key-set')
  if (!['publicKeys', 'bootstrapPublicKeys'].includes(keySet)) fail('--key-set must be publicKeys or bootstrapPublicKeys')
  if (keySet === 'publicKeys' && (!values.has('--channel') || !values.has('--manifest-url'))) {
    fail('--channel and --manifest-url are required for publicKeys')
  }
  if (keySet === 'bootstrapPublicKeys' && (values.has('--channel') || values.has('--manifest-url'))) {
    fail('--channel and --manifest-url are not valid for bootstrapPublicKeys')
  }
  return Object.fromEntries([...values].map(([name, value]) => [name.slice(2), value]))
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const privateKeyPem = readRegularFile(args['private-key'], MAX_PRIVATE_KEY_BYTES, 'private key')
  const configBytes = readRegularFile(args.config, MAX_CONFIG_BYTES, 'configuration')
  let configuration
  try {
    configuration = JSON.parse(configBytes.toString('utf8'))
  } catch {
    fail('configuration is not valid JSON')
  }
  const result = checkSigningKey({
    privateKeyPem,
    configuration,
    launcherVersion: args['launcher-version'],
    keyId: args['key-id'],
    expectedPublicKeyBase64: args['expected-public-key-base64'],
    keySet: args['key-set'],
    channel: args.channel,
    manifestUrl: args['manifest-url']
  })
  process.stdout.write(`signing key verified keyId=${args['key-id']} publicKeyFingerprint=${result.fingerprint}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'signing key check failed'}\n`)
    process.exitCode = 1
  }
}
