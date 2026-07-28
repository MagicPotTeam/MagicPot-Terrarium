import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  type KeyObject
} from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, dirname, isAbsolute, parse as parsePath, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishExactNoReplace, type PublishHooks as SafePublishHooks } from './safe-file.ts'
import {
  CHANNEL_MANIFEST_KEY_ID_PATTERN,
  channelManifestSigningPayload,
  parseChannelManifestV1,
  verifyChannelManifestSignature,
  type ChannelManifestV1,
  type UpdateChannel
} from '../../packages/app/src/main/appUpdate/channelManifestProtocol.ts'

const MAX_PRIVATE_KEY_BYTES = 16 * 1024
const MAX_INPUT_BYTES = 2 * 1024 * 1024
const MAX_JSON_DEPTH = 128
const UNSIGNED_KEYS = ['schema', 'channel', 'generatedAt', 'releases'] as const
const PLACEHOLDER_SIGNATURE = Buffer.alloc(64).toString('base64')
class SigningError extends Error {}
interface CliOptions {
  input: string
  output: string
  privateKey: string
  keyId: string
  expectedPublicKeyBase64?: string
}
function fail(reason: string): never {
  throw new SigningError(reason)
}
function systemCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}
function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}
function sameSnapshot(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.nlink === right.nlink
}

function parseArgs(args: readonly string[]): CliOptions {
  const values = new Map<string, string>()
  const valueOptions = new Set([
    '--input',
    '--output',
    '--private-key',
    '--key-id',
    '--expected-public-key-base64'
  ])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!valueOptions.has(arg)) fail('unknown option')
    const value = args[++index]
    if (!value || value.startsWith('--')) fail('missing option value')
    if (values.has(arg)) fail('duplicate option')
    values.set(arg, value)
  }
  for (const required of ['--input', '--output', '--private-key', '--key-id'])
    if (!values.has(required)) fail('missing required option')
  const options: CliOptions = {
    input: values.get('--input')!,
    output: values.get('--output')!,
    privateKey: values.get('--private-key')!,
    keyId: values.get('--key-id')!,
    expectedPublicKeyBase64: values.get('--expected-public-key-base64')
  }
  if (![options.input, options.output, options.privateKey].every(isAbsolute))
    fail('all file paths must be absolute')
  if (!CHANNEL_MANIFEST_KEY_ID_PATTERN.test(options.keyId) || options.keyId.includes('..'))
    fail('invalid key ID')
  return options
}

function assertNoSymlinkChain(path: string, includeFinal: boolean, reason: string): void {
  const absolute = resolve(path)
  const root = parsePath(absolute).root
  const parts: string[] = []
  let current = includeFinal ? absolute : dirname(absolute)
  while (normalizedPath(current) !== normalizedPath(root)) {
    parts.push(current)
    current = dirname(current)
  }
  parts.push(root)
  for (const part of parts.reverse()) {
    try {
      if (lstatSync(part).isSymbolicLink()) fail(reason)
    } catch (error) {
      if (error instanceof SigningError) throw error
      fail(reason)
    }
  }
}

function assertDistinctPaths(options: CliOptions): void {
  const paths = [options.input, options.output, options.privateKey].map(normalizedPath)
  if (new Set(paths).size !== paths.length) fail('input, output, and private key must differ')
}

function readStableFile(
  path: string,
  maximumBytes: number,
  label: 'input' | 'private key'
): { bytes: Buffer; parentRealPath: string; fileRealPath: string } {
  const safetyFailure = `${label} failed safety checks`
  assertNoSymlinkChain(path, true, safetyFailure)
  let before: Stats
  let parentRealPath: string
  let fileRealPath: string
  try {
    before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail(safetyFailure)
    if (before.size > maximumBytes) fail(`${label} exceeds size limit`)
    parentRealPath = realpathSync(dirname(path))
    fileRealPath = realpathSync(path)
    if (normalizedPath(dirname(fileRealPath)) !== normalizedPath(parentRealPath))
      fail(safetyFailure)
  } catch (error) {
    if (error instanceof SigningError) throw error
    fail(`${label} is unavailable`)
  }

  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY)
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximumBytes) fail(safetyFailure)
    if (
      !sameIdentity(before, opened) ||
      normalizedPath(realpathSync(path)) !== normalizedPath(fileRealPath)
    )
      fail(safetyFailure)
    if (normalizedPath(realpathSync(dirname(path))) !== normalizedPath(parentRealPath))
      fail(safetyFailure)
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    const finalPathStat = lstatSync(path)
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      !sameSnapshot(opened, after) ||
      bytes.length !== after.size ||
      !finalPathStat.isFile() ||
      finalPathStat.isSymbolicLink() ||
      !sameIdentity(after, finalPathStat)
    )
      fail(safetyFailure)
    if (normalizedPath(realpathSync(path)) !== normalizedPath(fileRealPath)) fail(safetyFailure)
    if (normalizedPath(realpathSync(dirname(path))) !== normalizedPath(parentRealPath))
      fail(safetyFailure)
    return { bytes, parentRealPath, fileRealPath }
  } catch (error) {
    if (error instanceof SigningError) throw error
    fail(`${label} could not be read safely`)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  return fail(`${label} could not be read safely`)
}

function parseStrictJson(text: string): unknown {
  let index = 0
  function invalid(): never {
    fail('input is not valid strict JSON')
  }
  function whitespace(): void {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1
  }
  function stringValue(): string {
    if (text[index] !== '"') invalid()
    const start = index++
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code === 0x22) {
        index += 1
        try {
          return JSON.parse(text.slice(start, index)) as string
        } catch {
          invalid()
        }
      }
      if (code <= 0x1f) invalid()
      if (code === 0x5c) {
        index += 1
        const escape = text[index]
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) invalid()
          index += 5
        } else {
          if (!escape || !'"\\/bfnrt'.includes(escape)) invalid()
          index += 1
        }
      } else {
        index += 1
      }
    }
    invalid()
  }
  function value(depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) fail('JSON nesting exceeds 128 levels')
    whitespace()
    const character = text[index]
    if (character === '"') return stringValue()
    if (character === '{') {
      index += 1
      whitespace()
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      const keys = new Set<string>()
      if (text[index] === '}') {
        index += 1
        return result
      }
      while (true) {
        whitespace()
        const key = stringValue()
        if (keys.has(key)) fail('JSON contains a duplicate object key')
        keys.add(key)
        whitespace()
        if (text[index++] !== ':') invalid()
        result[key] = value(depth + 1)
        whitespace()
        if (text[index] === '}') {
          index += 1
          return result
        }
        if (text[index++] !== ',') invalid()
      }
    }
    if (character === '[') {
      index += 1
      whitespace()
      const result: unknown[] = []
      if (text[index] === ']') {
        index += 1
        return result
      }
      while (true) {
        result.push(value(depth + 1))
        whitespace()
        if (text[index] === ']') {
          index += 1
          return result
        }
        if (text[index++] !== ',') invalid()
      }
    }
    for (const [literal, parsed] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ] as const) {
      if (text.startsWith(literal, index)) {
        index += literal.length
        return parsed
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index))?.[0]
    if (!number) invalid()
    index += number.length
    const parsed = Number(number)
    if (!Number.isFinite(parsed)) invalid()
    return parsed
  }
  const result = value(0)
  whitespace()
  if (index !== text.length) invalid()
  return result
}

function decodeCanonicalBase64(value: string, bytes: number, reason: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(reason)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== bytes || decoded.toString('base64') !== value) fail(reason)
  return decoded
}
function publicKeyBytes(publicKey: KeyObject): Buffer {
  try {
    const jwk = publicKey.export({ format: 'jwk' })
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string')
      fail('could not export Ed25519 public key')
    const padded =
      jwk.x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (jwk.x.length % 4)) % 4)
    return decodeCanonicalBase64(padded, 32, 'invalid public key')
  } catch (error) {
    if (error instanceof SigningError) throw error
    fail('could not export Ed25519 public key')
  }
}
function parseUnsignedManifest(text: string, keyId: string): ChannelManifestV1 {
  const unsigned = parseStrictJson(text)
  if (typeof unsigned !== 'object' || unsigned === null || Array.isArray(unsigned))
    fail('unsigned manifest must be an object')
  const keys = Object.keys(unsigned)
  if (keys.length !== UNSIGNED_KEYS.length || UNSIGNED_KEYS.some((key) => !keys.includes(key)))
    fail('unsigned manifest must contain exactly schema, channel, generatedAt, and releases')
  const source = unsigned as Record<string, unknown>
  if (!['stable', 'beta', 'nightly'].includes(source.channel as string)) fail('invalid channel')
  try {
    return parseChannelManifestV1(
      {
        schema: source.schema,
        channel: source.channel,
        generatedAt: source.generatedAt,
        releases: source.releases,
        signature: { algorithm: 'ed25519', keyId, value: PLACEHOLDER_SIGNATURE }
      },
      { expectedChannel: source.channel as UpdateChannel }
    )
  } catch {
    fail('unsigned manifest failed protocol validation')
  }
}
function loadPrivateKey(pem: Buffer): KeyObject {
  if (
    !/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]*\r?\n-----END PRIVATE KEY-----\r?\n?$/.test(
      pem.toString('utf8')
    )
  )
    fail('private key must be PKCS#8 PEM')
  try {
    const key = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' })
    if (key.asymmetricKeyType !== 'ed25519') fail('private key must be Ed25519')
    return key
  } catch (error) {
    if (error instanceof SigningError) throw error
    fail('private key is invalid')
  }
}

function assertOutputAbsent(path: string): void {
  try {
    lstatSync(path)
    fail('output already exists')
  } catch (error) {
    if (error instanceof SigningError) throw error
    if (systemCode(error) !== 'ENOENT') fail('output availability could not be determined')
  }
}
function assertOutputIdentityDistinct(options: CliOptions): void {
  try {
    const outputStat = lstatSync(options.output)
    for (const source of [options.input, options.privateKey]) {
      if (sameIdentity(outputStat, lstatSync(source)))
        fail('input, output, and private key must differ')
    }
  } catch (error) {
    if (error instanceof SigningError) throw error
    if (systemCode(error) !== 'ENOENT') fail('output availability could not be determined')
  }
}
type PublishHooks = SafePublishHooks
interface ParentIdentity {
  realPath: string
  stat: Stats
}
function readDescriptorExactly(descriptor: number, size: number): Buffer {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const read = readSync(descriptor, bytes, offset, size - offset, offset)
    if (read === 0) fail('published output failed safety checks')
    offset += read
  }
  return bytes
}
function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}
function snapshotOutputParent(parent: string): ParentIdentity {
  assertNoSymlinkChain(parent, true, 'output parent failed safety checks')
  try {
    const linkStat = lstatSync(parent)
    const targetStat = statSync(parent)
    if (
      linkStat.isSymbolicLink() ||
      !linkStat.isDirectory() ||
      !targetStat.isDirectory() ||
      !sameIdentity(linkStat, targetStat)
    )
      fail('output parent failed safety checks')
    return { realPath: realpathSync(parent), stat: targetStat }
  } catch (error) {
    if (error instanceof SigningError) throw error
    fail('output parent is unavailable')
  }
}
function assertOutputParentUnchanged(parent: string, expected: ParentIdentity): void {
  const current = snapshotOutputParent(parent)
  if (
    normalizedPath(current.realPath) !== normalizedPath(expected.realPath) ||
    !sameIdentity(current.stat, expected.stat)
  )
    fail('output parent changed during publication')
}
function assertPathIdentity(path: string, expected: Stats, minimumLinks: number): Stats {
  try {
    const linkStat = lstatSync(path)
    if (
      linkStat.isSymbolicLink() ||
      !linkStat.isFile() ||
      !sameIdentity(linkStat, expected) ||
      linkStat.nlink < minimumLinks
    )
      fail('published output failed safety checks')
    return linkStat
  } catch (error) {
    if (error instanceof SigningError) throw error
    fail('published output failed safety checks')
  }
}
function verifyManifestBytes(
  bytes: Buffer,
  expectedChannel: UpdateChannel,
  keyId: string,
  publicKey: KeyObject
): void {
  try {
    const strictValue = parseStrictJson(bytes.toString('utf8'))
    const written = parseChannelManifestV1(strictValue, { expectedChannel })
    if (!verifyChannelManifestSignature(written, { [keyId]: publicKey }))
      fail('published output failed self-verification')
  } catch (error) {
    if (error instanceof SigningError) throw error
    fail('published output failed self-verification')
  }
}

export function publishNoReplace(
  path: string,
  contents: string,
  expectedChannel: UpdateChannel,
  keyId: string,
  publicKey: KeyObject,
  hooks: PublishHooks = {}
): void {
  try {
    return publishExactNoReplace(
      path,
      contents,
      (bytes) => verifyManifestBytes(bytes, expectedChannel, keyId, publicKey),
      hooks
    )
  } catch (error) {
    if (error instanceof Error) throw error
    fail('could not publish output safely')
  }
}

function legacyPublishNoReplace(
  path: string,
  contents: string,
  expectedChannel: UpdateChannel,
  keyId: string,
  publicKey: KeyObject,
  hooks: PublishHooks = {}
): void {
  if ((hooks.beforeLink || hooks.afterLink) && process.env.NODE_ENV !== 'test')
    fail('publication hooks are test-only')
  const parent = dirname(path)
  const parentIdentity = snapshotOutputParent(parent)
  assertOutputAbsent(path)
  const temporary = resolve(
    parent,
    `.${basename(path)}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`
  )
  const expected = Buffer.from(contents, 'utf8')
  const expectedDigest = createHash('sha256').update(expected).digest()
  let temporaryDescriptor: number | undefined
  let outputDescriptor: number | undefined
  let temporaryIdentity: Stats | undefined
  let temporaryRemoved = false
  try {
    temporaryDescriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600
    )
    temporaryIdentity = fstatSync(temporaryDescriptor)
    if (
      !temporaryIdentity.isFile() ||
      temporaryIdentity.nlink !== 1 ||
      temporaryIdentity.size !== 0
    )
      fail('temporary output failed safety checks')
    writeFileSync(temporaryDescriptor, expected)
    fsyncSync(temporaryDescriptor)
    const writtenStat = fstatSync(temporaryDescriptor)
    const descriptorBytes = readDescriptorExactly(temporaryDescriptor, expected.length)
    const descriptorDigest = createHash('sha256').update(descriptorBytes).digest()
    if (
      !writtenStat.isFile() ||
      !sameIdentity(writtenStat, temporaryIdentity) ||
      writtenStat.size !== expected.length ||
      writtenStat.nlink !== 1 ||
      !sameBytes(descriptorBytes, expected) ||
      !timingSafeEqual(descriptorDigest, expectedDigest)
    )
      fail('temporary output failed safety checks')
    temporaryIdentity = writtenStat

    hooks.beforeLink?.({ temporary, output: path, parent })
    assertOutputParentUnchanged(parent, parentIdentity)
    assertPathIdentity(temporary, temporaryIdentity, 1)
    try {
      linkSync(temporary, path)
    } catch (error) {
      if (systemCode(error) === 'EEXIST') fail('output already exists')
      fail('could not atomically publish output')
    }

    outputDescriptor = openSync(path, constants.O_RDONLY)
    hooks.afterLink?.({ temporary, output: path, parent })
    const outputPathStat = assertPathIdentity(path, temporaryIdentity, 2)
    const outputStat = fstatSync(outputDescriptor)
    if (
      !outputStat.isFile() ||
      !sameIdentity(outputStat, temporaryIdentity) ||
      !sameIdentity(outputPathStat, outputStat) ||
      outputStat.size !== expected.length ||
      outputStat.nlink < 2
    )
      fail('published output failed safety checks')
    const outputBytes = readDescriptorExactly(outputDescriptor, expected.length)
    if (!sameBytes(outputBytes, expected)) fail('published output failed safety checks')
    verifyManifestBytes(outputBytes, expectedChannel, keyId, publicKey)

    assertOutputParentUnchanged(parent, parentIdentity)
    assertPathIdentity(path, temporaryIdentity, 2)
    assertPathIdentity(temporary, temporaryIdentity, 2)
    unlinkSync(temporary)
    temporaryRemoved = true

    const finalFdStat = fstatSync(outputDescriptor)
    const finalPathStat = assertPathIdentity(path, temporaryIdentity, 1)
    const finalBytes = readDescriptorExactly(outputDescriptor, expected.length)
    if (
      !sameIdentity(finalFdStat, temporaryIdentity) ||
      !sameIdentity(finalPathStat, temporaryIdentity) ||
      finalFdStat.size !== expected.length ||
      finalFdStat.nlink !== 1 ||
      finalPathStat.nlink !== 1 ||
      !sameBytes(finalBytes, expected)
    )
      fail('published output failed safety checks')
    verifyManifestBytes(finalBytes, expectedChannel, keyId, publicKey)
    assertOutputParentUnchanged(parent, parentIdentity)
  } catch (error) {
    if (error instanceof SigningError) throw error
    fail('could not publish output safely')
  } finally {
    if (outputDescriptor !== undefined) closeSync(outputDescriptor)
    if (temporaryDescriptor !== undefined) closeSync(temporaryDescriptor)
    if (!temporaryRemoved && temporaryIdentity !== undefined) {
      try {
        const current = lstatSync(temporary)
        if (
          !current.isSymbolicLink() &&
          current.isFile() &&
          sameIdentity(current, temporaryIdentity)
        )
          unlinkSync(temporary)
      } catch {
        // Never remove an unverified path, and never roll back an output path.
      }
    }
  }
}

export function run(args: readonly string[]): void {
  const options = parseArgs(args)
  assertDistinctPaths(options)
  assertOutputIdentityDistinct(options)
  const input = readStableFile(options.input, MAX_INPUT_BYTES, 'input')
  const privateKeyFile = readStableFile(options.privateKey, MAX_PRIVATE_KEY_BYTES, 'private key')
  if (normalizedPath(input.fileRealPath) === normalizedPath(privateKeyFile.fileRealPath))
    fail('input, output, and private key must differ')
  assertOutputAbsent(options.output)

  const privateKey = loadPrivateKey(privateKeyFile.bytes)
  const publicKey = createPublicKey(privateKey)
  const rawPublicKey = publicKeyBytes(publicKey)
  if (options.expectedPublicKeyBase64) {
    const expected = decodeCanonicalBase64(
      options.expectedPublicKeyBase64,
      32,
      'expected public key must be canonical base64 for 32 bytes'
    )
    if (!timingSafeEqual(rawPublicKey, expected)) fail('expected public key does not match')
  }
  const parsed = parseUnsignedManifest(input.bytes.toString('utf8'), options.keyId)
  const signature = sign(null, channelManifestSigningPayload(parsed), privateKey)
  if (signature.length !== 64) fail('signing returned an invalid signature')
  const outputManifest: ChannelManifestV1 = {
    schema: parsed.schema,
    channel: parsed.channel,
    generatedAt: parsed.generatedAt,
    releases: parsed.releases,
    signature: { algorithm: 'ed25519', keyId: options.keyId, value: signature.toString('base64') }
  }
  publishNoReplace(
    options.output,
    `${JSON.stringify(outputManifest, null, 2)}\n`,
    outputManifest.channel,
    options.keyId,
    publicKey
  )
  const fingerprint = createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16)
  process.stdout.write(
    `signed keyId=${options.keyId} publicKeyFingerprint=${fingerprint} output=${basename(options.output)}\n`
  )
}
if (normalizedPath(process.argv[1] ?? '') === normalizedPath(fileURLToPath(import.meta.url))) {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unexpected error'
    process.stderr.write(`signing failed: ${reason}\n`)
    process.exitCode = 1
  }
}
