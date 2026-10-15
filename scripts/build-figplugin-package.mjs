import * as fs from 'node:fs'
import path from 'node:path'
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Standalone Node CLI: keep this contract in sync with shared/figplugin/{manifest,package}.ts.
// No TypeScript loader, plugin execution, key generation, trust registration or network access.
const FORMAT = 'magicpot.figplugin.package.v1'
const MAX_FILE = 2 * 1024 * 1024
const MAX_CONTENT = 8 * 1024 * 1024
const MAX_WIRE = 12 * 1024 * 1024
const MAX_MANIFEST = 64 * 1024
const INVALID = 'Invalid FIGPLUGIN package input'
const CLI_ERROR =
  'FIGPLUGIN package build failed. Existing files were not overwritten; newly created outputs may remain.\n'
const identifierPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const permissionPairs = [
  ['dialogue', 'dialogue', 'prompt'],
  ['background-removal', 'backgroundRemoval', 'prompt'],
  ['asset-transfer', 'assetTransfer', 'read'],
  ['result-transfer', 'resultTransfer', 'write']
]
const limitBounds = {
  maxPayloadBytes: [1, MAX_CONTENT, MAX_CONTENT],
  maxResultBytes: [1, MAX_CONTENT, MAX_CONTENT],
  maxConfigBytes: [1, MAX_MANIFEST, 16 * 1024],
  maxCallTimeoutMs: [100, 120_000, 60_000],
  maxConcurrentCalls: [1, 8, 1]
}

function requireValid(condition) {
  if (!condition) throw new Error(INVALID)
}

function record(value, allowed) {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value))
  requireValid([Object.prototype, null].includes(Object.getPrototypeOf(value)))
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    requireValid(
      typeof key === 'string' &&
        (!allowed || allowed.includes(key)) &&
        descriptor.enumerable &&
        Object.hasOwn(descriptor, 'value')
    )
  }
  return value
}

function array(value, min, max) {
  requireValid(Array.isArray(value) && value.length >= min && value.length <= max)
  requireValid(Object.getPrototypeOf(value) === Array.prototype)
  requireValid(Reflect.ownKeys(value).length === value.length + 1)
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    requireValid(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'))
  }
  return value
}

// Budgeted serialization also rejects hooks, cycles, sparse arrays and non-JSON values.
function canonical(value, maxBytes, maxDepth = 16) {
  const chunks = []
  const ancestors = new Set()
  let bytes = 0
  let nodes = 0
  const append = (text) => {
    bytes += Buffer.byteLength(text)
    requireValid(bytes <= maxBytes)
    chunks.push(text)
  }
  const visit = (current, depth) => {
    requireValid(depth <= maxDepth && ++nodes <= 16_384)
    if (current === null || typeof current === 'boolean') return append(JSON.stringify(current))
    if (typeof current === 'string') {
      requireValid(current.length <= maxBytes)
      return append(JSON.stringify(current))
    }
    if (typeof current === 'number') {
      requireValid(Number.isFinite(current))
      return append(JSON.stringify(current))
    }
    requireValid(typeof current === 'object' && !ancestors.has(current))
    ancestors.add(current)
    if (Array.isArray(current)) {
      array(current, 0, 16_384)
      append('[')
      current.forEach((item, index) => {
        if (index) append(',')
        visit(item, depth + 1)
      })
      append(']')
    } else {
      record(current)
      const keys = Object.keys(current).sort()
      requireValid(keys.length <= 16_384)
      append('{')
      keys.forEach((key, index) => {
        if (index) append(',')
        requireValid(key.length <= maxBytes)
        append(JSON.stringify(key))
        append(':')
        visit(current[key], depth + 1)
      })
      append('}')
    }
    ancestors.delete(current)
  }
  visit(value, 0)
  return chunks.join('')
}

// JSON.parse alone silently accepts duplicate keys. Scan first, with bounded nesting,
// and compare decoded property names (including escaped spellings) before parsing.
function parseManifestText(text) {
  requireValid(Buffer.byteLength(text) <= MAX_MANIFEST)
  let offset = 0
  const whitespace = () => {
    while (/^[ \t\r\n]$/.test(text[offset] ?? '')) offset++
  }
  const string = () => {
    const start = offset++
    while (offset < text.length) {
      const character = text[offset++]
      if (character === '"') return JSON.parse(text.slice(start, offset))
      if (character === '\\') offset++
    }
    throw new Error(INVALID)
  }
  const visit = (depth) => {
    requireValid(depth <= 16)
    whitespace()
    const character = text[offset]
    if (character === '"') {
      string()
    } else if (character === '{' || character === '[') {
      const object = character === '{'
      const end = object ? '}' : ']'
      const keys = new Set()
      offset++
      whitespace()
      if (text[offset] === end) {
        offset++
        return
      }
      while (offset < text.length) {
        if (object) {
          whitespace()
          requireValid(text[offset] === '"')
          const key = string()
          requireValid(!keys.has(key))
          keys.add(key)
          whitespace()
          requireValid(text[offset++] === ':')
        }
        visit(depth + 1)
        whitespace()
        if (text[offset] === end) {
          offset++
          return
        }
        requireValid(text[offset++] === ',')
      }
      throw new Error(INVALID)
    } else {
      const start = offset
      while (offset < text.length && !/^[,}\]\s]$/.test(text[offset])) offset++
      requireValid(offset > start)
      JSON.parse(text.slice(start, offset))
    }
  }
  visit(0)
  whitespace()
  requireValid(offset === text.length)
  return JSON.parse(text)
}

function text(value, max = 128) {
  requireValid(typeof value === 'string')
  const normalized = value.trim()
  requireValid(normalized.length > 0 && normalized.length <= max)
  return normalized
}

function identifier(value) {
  const normalized = text(value)
  requireValid(identifierPattern.test(normalized))
  return normalized
}

function timestamp(value) {
  const normalized = text(value, 24)
  requireValid(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(normalized))
  requireValid(Number.isFinite(Date.parse(normalized)))
  requireValid(
    new Date(normalized).toISOString() ===
      (normalized.includes('.') ? normalized : normalized.replace('Z', '.000Z'))
  )
  return normalized
}

function bridgeOrigin(value) {
  // Exact signed origin, not a URL to normalize (including trailing newlines).
  requireValid(
    typeof value === 'string' &&
      value.length <= 22 &&
      /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$(?![\s\S])/.test(value)
  )
  const port = Number(value.slice('http://127.0.0.1:'.length))
  requireValid(port >= 1024 && port <= 65_535)
  return value
}

function deviceName(segment) {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i.test(segment.split('.')[0])
}

function safePath(value) {
  requireValid(typeof value === 'string' && value.length > 0 && value.length <= 512)
  requireValid(!/[^A-Za-z0-9._/-]/.test(value))
  for (const segment of value.split('/')) {
    requireValid(segment.length > 0 && segment.length <= 128 && !segment.endsWith('.'))
    requireValid(
      !['.', '..', '__proto__', 'prototype', 'constructor'].includes(segment.toLowerCase())
    )
    requireValid(!deviceName(segment))
  }
  return value
}

function distinctPaths(paths) {
  const folded = new Set(paths.map((value) => safePath(value).toLowerCase()))
  requireValid(folded.size === paths.length)
  for (const value of folded) {
    for (let slash = value.indexOf('/'); slash !== -1; slash = value.indexOf('/', slash + 1)) {
      requireValid(!folded.has(value.slice(0, slash)))
    }
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function digest(value) {
  requireValid(/^[a-f0-9]{64}$/i.test(text(value, 64)))
}

function normalizeManifest(input) {
  const manifest = JSON.parse(canonical(input, MAX_MANIFEST))
  record(manifest, [
    'schemaVersion',
    'id',
    'name',
    'version',
    'host',
    'entryPath',
    'capabilities',
    'permissions',
    'limits',
    'provenance',
    'signature',
    'assets',
    'bridge'
  ])
  requireValid(manifest.schemaVersion === 1 || manifest.schemaVersion === 2)
  const connected = manifest.schemaVersion === 2
  if (connected) {
    record(manifest.bridge, ['protocol', 'origin'])
    requireValid(manifest.bridge.protocol === 1)
    manifest.bridge.origin = bridgeOrigin(manifest.bridge.origin)
  } else {
    requireValid(!Object.hasOwn(manifest, 'bridge'))
  }
  manifest.id = identifier(manifest.id)
  manifest.name = text(manifest.name)
  requireValid(typeof manifest.version === 'string' && manifest.version.length <= 128)
  manifest.version = text(manifest.version)
  requireValid(versionPattern.test(manifest.version))
  requireValid(['figma', 'photoshop'].includes(manifest.host))
  manifest.entryPath = safePath(connected ? text(manifest.entryPath, 512) : manifest.entryPath)
  array(manifest.capabilities, 1, 4)
  requireValid(new Set(manifest.capabilities).size === manifest.capabilities.length)
  requireValid(manifest.capabilities.every((item) => permissionPairs.some(([cap]) => item === cap)))
  if (connected) {
    requireValid(
      ['dialogue', 'asset-transfer'].every((capability) =>
        manifest.capabilities.includes(capability)
      )
    )
  }

  if (!Object.hasOwn(manifest, 'permissions')) manifest.permissions = {}
  record(manifest.permissions, [...permissionPairs.map(([, key]) => key), 'filesystem', 'network'])
  for (const [capability, key, enabled] of permissionPairs) {
    if (!Object.hasOwn(manifest.permissions, key)) manifest.permissions[key] = 'none'
    requireValid(
      manifest.permissions[key] === (manifest.capabilities.includes(capability) ? enabled : 'none')
    )
  }
  for (const key of ['filesystem', 'network']) {
    if (!Object.hasOwn(manifest.permissions, key)) manifest.permissions[key] = 'none'
    requireValid(
      manifest.permissions[key] === (connected && key === 'network' ? 'desktop-bridge' : 'none')
    )
  }
  if (!Object.hasOwn(manifest, 'limits')) manifest.limits = {}
  record(manifest.limits, Object.keys(limitBounds))
  for (const [key, [min, max, fallback]] of Object.entries(limitBounds)) {
    if (!Object.hasOwn(manifest.limits, key)) manifest.limits[key] = fallback
    requireValid(
      Number.isInteger(manifest.limits[key]) &&
        manifest.limits[key] >= min &&
        manifest.limits[key] <= max
    )
  }
  requireValid(manifest.limits.maxResultBytes <= manifest.limits.maxPayloadBytes)

  const provenance = record(manifest.provenance, [
    'publisherId',
    'publisherName',
    'source',
    'artifactSha256',
    'sourceUrl',
    'issuedAt'
  ])
  provenance.publisherId = identifier(provenance.publisherId)
  provenance.publisherName = text(provenance.publisherName)
  // A caller-supplied source is signed metadata, never evidence of publisher trust.
  if (!Object.hasOwn(provenance, 'source')) provenance.source = 'user-provided'
  requireValid(['official', 'verified-publisher', 'user-provided'].includes(provenance.source))
  if (Object.hasOwn(provenance, 'artifactSha256')) digest(provenance.artifactSha256)
  if (Object.hasOwn(provenance, 'sourceUrl')) {
    provenance.sourceUrl = text(provenance.sourceUrl, MAX_MANIFEST)
    requireValid(provenance.sourceUrl.startsWith('https://'))
    new URL(provenance.sourceUrl)
  }
  provenance.issuedAt = timestamp(provenance.issuedAt)
  const signature = record(manifest.signature, ['algorithm', 'keyId', 'value', 'signedAt'])
  if (!Object.hasOwn(signature, 'algorithm')) signature.algorithm = 'ed25519'
  requireValid(signature.algorithm === 'ed25519')
  signature.keyId = identifier(signature.keyId)
  signature.signedAt = timestamp(signature.signedAt)
  if (Object.hasOwn(signature, 'value')) {
    const value = text(signature.value, 128)
    requireValid(/^(?:[A-Fa-f0-9]{128}|[A-Za-z0-9_-]{85}[AQgw](?:==)?)$/.test(value))
  }

  array(manifest.assets, 1, 64)
  for (const asset of manifest.assets) {
    record(asset, ['id', 'path', 'mimeType', 'sizeBytes', 'sha256'])
    asset.id = identifier(asset.id)
    asset.path = safePath(connected ? text(asset.path, 512) : asset.path)
    if (Object.hasOwn(asset, 'mimeType')) {
      asset.mimeType = text(asset.mimeType, 192).toLowerCase()
      requireValid(
        /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/.test(asset.mimeType)
      )
    }
    if (Object.hasOwn(asset, 'sizeBytes')) {
      requireValid(
        Number.isInteger(asset.sizeBytes) && asset.sizeBytes >= 1 && asset.sizeBytes <= MAX_CONTENT
      )
    }
    if (Object.hasOwn(asset, 'sha256')) digest(asset.sha256)
  }
  requireValid(new Set(manifest.assets.map(({ id }) => id)).size === manifest.assets.length)
  distinctPaths(manifest.assets.map(({ path }) => path))
  requireValid(manifest.assets.some(({ path }) => path === manifest.entryPath))
  return manifest
}

function signingKey(privateKeyPem) {
  requireValid(typeof privateKeyPem === 'string' || Buffer.isBuffer(privateKeyPem))
  requireValid(Buffer.byteLength(privateKeyPem) <= 4096)
  const pem = privateKeyPem.toString()
  requireValid(
    /^-----BEGIN PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PRIVATE KEY-----(?:\r?\n)?$/.test(
      pem
    )
  )
  const encoded = pem
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('-----'))
    .join('')
  const der = Buffer.from(encoded, 'base64')
  requireValid(der.toString('base64') === encoded)
  const key = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' })
  requireValid(key.asymmetricKeyType === 'ed25519')
  requireValid(key.export({ format: 'der', type: 'pkcs8' }).equals(der))
  return key
}

/**
 * Offline, synchronous and side-effect-free. All inputs are required; no key or time is generated.
 * Template assets must list every file as { id, path, mimeType? }; entryPath must be listed.
 * Generated asset sizes/hashes, artifactSha256 and signature.value replace supplied values.
 * Other schema fields are preserved with shared-schema normalization/defaults before signing.
 * Returns { packageText, publicKeyPem, keyFingerprint }; fingerprint is lowercase SHA-256 of SPKI DER.
 */
export function buildFigPluginPackage(options) {
  try {
    record(options, ['manifest', 'files', 'privateKeyPem'])
    const manifest = normalizeManifest(options.manifest)
    const files = array(options.files, 1, 64)
    const key = signingKey(options.privateKeyPem)
    const privateBody = key.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    requireValid(!canonical(manifest, MAX_MANIFEST).includes(privateBody))
    let total = 0
    for (const file of files) {
      record(file, ['path', 'data'])
      safePath(file.path)
      requireValid(
        Buffer.isBuffer(file.data) && file.data.length >= 1 && file.data.length <= MAX_FILE
      )
      // Refuse accidental inclusion of the signing key as an asset as well as in metadata.
      requireValid(!file.data.includes(privateBody) && !file.data.includes(options.privateKeyPem))
      total += file.data.length
      requireValid(total <= MAX_CONTENT)
    }
    distinctPaths(files.map(({ path }) => path))
    requireValid(files.length === manifest.assets.length)
    const byPath = new Map(files.map((file) => [file.path, file]))
    requireValid(manifest.assets.every(({ path }) => byPath.has(path)))
    const packaged = files
      .map(({ path, data }) => {
        const snapshot = Buffer.from(data)
        return {
          path,
          bytes: snapshot.length,
          sha256: hash(snapshot),
          contentBase64: snapshot.toString('base64')
        }
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const inventory = new Map(packaged.map((file) => [file.path, file]))
    for (const asset of manifest.assets) {
      const file = inventory.get(asset.path)
      asset.sizeBytes = file.bytes
      asset.sha256 = file.sha256
    }
    manifest.provenance.artifactSha256 = hash(
      canonical(
        {
          format: FORMAT,
          files: packaged.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
        },
        MAX_MANIFEST
      )
    )
    delete manifest.signature.value
    const payload = `${FORMAT}\n${canonical(manifest, MAX_MANIFEST)}`
    manifest.signature.value = sign(null, Buffer.from(payload), key).toString('hex')
    canonical(manifest, MAX_MANIFEST)
    const publicKey = createPublicKey(key)
    return {
      packageText: canonical({ format: FORMAT, manifest, files: packaged }, MAX_WIRE),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      keyFingerprint: hash(publicKey.export({ type: 'spki', format: 'der' }))
    }
  } catch {
    // Do not expose OpenSSL, filesystem, validation details or caller-supplied secrets.
    throw new Error(INVALID)
  }
}

function localPath(value) {
  requireValid(typeof value === 'string' && value.length > 0 && value.length <= 32_768)
  requireValid(!Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
  requireValid(
    !value.startsWith('\\\\') && !value.startsWith('//') && !/^[A-Za-z]:[^\\/]/.test(value)
  )
  requireValid(!value.split(/[\\/]/).includes('..'))
  const absolute = path.resolve(value)
  const root = path.parse(absolute).root
  requireValid(root === '/' || /^[A-Za-z]:\\$/.test(root))
  for (const part of absolute.slice(root.length).split(path.sep)) {
    requireValid(part && !/[\\:]/.test(part) && !/[. ]$/.test(part) && !deviceName(part))
  }
  return absolute
}

const stat = (name) => fs.lstatSync(name, { bigint: true })
const real = (name) => fs.realpathSync.native(name)
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino
const sameSnapshot = (a, b) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.nlink === b.nlink &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs
const regular = (value, max) =>
  value.isFile() &&
  !value.isSymbolicLink() &&
  value.nlink === 1n &&
  value.size >= 1n &&
  value.size <= BigInt(max)

function directories(directory) {
  const root = path.parse(directory).root
  const names = [root]
  let current = root
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    names.push(current)
  }
  return names.map((name) => {
    const value = stat(name)
    requireValid(value.isDirectory() && !value.isSymbolicLink() && real(name) === name)
    return { name, value }
  })
}

function unchangedDirectories(snapshot) {
  for (const { name, value } of snapshot) {
    const now = stat(name)
    requireValid(
      now.isDirectory() && !now.isSymbolicLink() && sameIdentity(value, now) && real(name) === name
    )
  }
}

function readBounded(name, max) {
  const parents = directories(path.dirname(name))
  const before = stat(name)
  requireValid(regular(before, max) && real(name) === name)
  const handle = fs.openSync(
    name,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
  )
  try {
    const opened = fs.fstatSync(handle, { bigint: true })
    requireValid(regular(opened, max) && sameSnapshot(before, opened))
    unchangedDirectories(parents)
    const buffer = Buffer.alloc(Number(opened.size) + 1)
    let count = 0
    while (count < buffer.length) {
      const read = fs.readSync(handle, buffer, count, buffer.length - count, count)
      if (!read) break
      count += read
    }
    const after = fs.fstatSync(handle, { bigint: true })
    requireValid(
      count === Number(opened.size) && regular(after, max) && sameSnapshot(opened, after)
    )
    const named = stat(name)
    requireValid(regular(named, max) && sameSnapshot(after, named) && real(name) === name)
    unchangedDirectories(parents)
    return buffer.subarray(0, count)
  } finally {
    fs.closeSync(handle)
  }
}

function absent(name) {
  try {
    stat(name)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(INVALID)
}

function outputTarget(name) {
  const parents = directories(path.dirname(name))
  absent(name)
  return { name, parents }
}

function writeNew({ name, parents }, content) {
  unchangedDirectories(parents)
  const handle = fs.openSync(
    name,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600
  )
  try {
    const created = fs.fstatSync(handle, { bigint: true })
    requireValid(created.isFile() && created.nlink === 1n)
    unchangedDirectories(parents)
    requireValid(sameSnapshot(created, stat(name)) && real(name) === name)
    fs.writeFileSync(handle, content, 'utf8')
    fs.fsyncSync(handle)
    const finished = fs.fstatSync(handle, { bigint: true })
    requireValid(
      regular(finished, MAX_WIRE) && finished.size === BigInt(Buffer.byteLength(content))
    )
    requireValid(sameSnapshot(finished, stat(name)) && real(name) === name)
    unchangedDirectories(parents)
  } finally {
    fs.closeSync(handle)
  }
  // Never unlink on failure: another process may own the name now. Partial outputs are reported.
}

function runCli(args) {
  const flags = ['--manifest', '--files-root', '--private-key', '--output', '--public-key-output']
  const values = new Map()
  requireValid(args.length === flags.length * 2)
  for (let index = 0; index < args.length; index += 2) {
    requireValid(flags.includes(args[index]) && !values.has(args[index]))
    values.set(args[index], localPath(args[index + 1]))
  }
  requireValid(values.size === flags.length)
  const output = values.get('--output')
  const publicOutput = values.get('--public-key-output')
  requireValid(output.toLowerCase() !== publicOutput.toLowerCase())
  const targets = [outputTarget(output), outputTarget(publicOutput)]
  const keyPath = values.get('--private-key')
  requireValid(keyPath.toLowerCase() !== values.get('--manifest').toLowerCase())
  const manifest = normalizeManifest(
    parseManifestText(
      new TextDecoder('utf-8', { fatal: true }).decode(
        readBounded(values.get('--manifest'), MAX_MANIFEST)
      )
    )
  )
  const root = values.get('--files-root')
  const rootSnapshot = directories(root)
  const files = []
  let total = 0
  for (const asset of manifest.assets) {
    const name = path.resolve(root, asset.path)
    requireValid(name.toLowerCase() !== keyPath.toLowerCase())
    requireValid(path.relative(root, name).split(path.sep).join('/') === asset.path)
    const data = readBounded(name, Math.min(MAX_FILE, MAX_CONTENT - total))
    total += data.length
    files.push({ path: asset.path, data })
  }
  unchangedDirectories(rootSnapshot)
  const privateKeyPem = readBounded(keyPath, 4096)
  let result
  try {
    result = buildFigPluginPackage({ manifest, files, privateKeyPem })
  } finally {
    privateKeyPem.fill(0)
  }
  writeNew(targets[0], result.packageText)
  writeNew(targets[1], result.publicKeyPem)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli(process.argv.slice(2))
  } catch {
    process.stderr.write(CLI_ERROR)
    process.exitCode = 1
  }
}
