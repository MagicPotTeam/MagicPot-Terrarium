import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MAX_FILE = 2 * 1024 * 1024
const INVALID = 'Invalid FIGPLUGIN host preparation input'
const CLI_ERROR =
  'FIGPLUGIN host preparation failed. Existing files were not overwritten; newly created outputs may remain.\n'
const SUCCESS =
  'FIGPLUGIN development host prepared (4 files). No host code executed; desktop not paired. Package template is unsigned and does not establish publisher trust.\n'
const USAGE =
  'Usage: node scripts/prepare-figplugin-host.mjs --host figma|photoshop --plugin-id ID --publisher-id ID --key-id ID --issued-at ISO_UTC --output ABSOLUTE_NEW_DIRECTORY [--bridge-origin http://127.0.0.1:PORT]\n' +
  'All six flags are required. Use your own host-assigned plugin ID and signing metadata.\n' +
  'Optional --bridge-origin enables v2 with one exact loopback origin (port 1024..65535); omission preserves offline v1.\n' +
  'The output must not exist; its parent must exist without symlink/junction ancestors.\n' +
  'Creates manifest.json, two native files, and unsigned package.template.json for build-figplugin-package.mjs.\n' +
  'No keys are read or created, no host code is executed, and desktop remains not paired.\n'
const SOURCE_ROOT = fileURLToPath(new URL('../packages/figplugin-hosts/', import.meta.url))
const HOSTS = {
  figma: {
    directory: 'figma',
    placeholder: '__FIGMA_ASSIGNED_PLUGIN_ID__',
    code: 'code.js',
    ui: 'ui.html'
  },
  photoshop: {
    directory: 'photoshop-uxp',
    placeholder: '__PHOTOSHOP_PLUGIN_ID__',
    code: 'main.js',
    ui: 'index.html'
  }
}
const FLAGS = new Map([
  ['--host', 'host'],
  ['--plugin-id', 'pluginId'],
  ['--publisher-id', 'publisherId'],
  ['--key-id', 'keyId'],
  ['--issued-at', 'issuedAt'],
  ['--output', 'outputDir']
])
const identifierPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/
const sha = (value) => createHash('sha256').update(value).digest('hex')
const stat = (name) => fs.lstatSync(name, { bigint: true })
const real = (name) => fs.realpathSync.native(name)
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino
const sameSnapshot = (a, b) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.nlink === b.nlink &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs
const regular = (value) =>
  value.isFile() &&
  !value.isSymbolicLink() &&
  value.nlink === 1n &&
  value.size >= 1n &&
  value.size <= BigInt(MAX_FILE)

function requireValid(condition) {
  if (!condition) throw new Error(INVALID)
}

function providedText(value, max) {
  requireValid(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= max &&
      value === value.trim() &&
      /^[\x20-\x7e]+$/.test(value)
  )
  requireValid(
    !/__[^\r\n]*__/.test(value) &&
      !/^(?:placeholder|your[-_ ](?:plugin|publisher|key)[-_ ]id|<(?:plugin|publisher|key)[-_ ]id>)$/i.test(
        value
      )
  )
}

function identifier(value) {
  providedText(value, 128)
  requireValid(identifierPattern.test(value))
}

function timestamp(value) {
  providedText(value, 24)
  requireValid(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
  requireValid(Number.isFinite(Date.parse(value)))
  requireValid(
    new Date(value).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'))
  )
}

function bridgeOrigin(value) {
  // Keep identical to the shared manifest's exact signed-origin contract; do not normalize URLs.
  requireValid(
    typeof value === 'string' &&
      value.length <= 22 &&
      /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$(?![\s\S])/.test(value)
  )
  const port = Number(value.slice('http://127.0.0.1:'.length))
  requireValid(port >= 1024 && port <= 65_535)
}

function deviceName(segment) {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i.test(segment.split('.')[0])
}

function outputPath(value) {
  requireValid(typeof value === 'string' && value.length > 0 && value.length <= 32_768)
  requireValid(!Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
  requireValid(path.isAbsolute(value))
  requireValid(!value.startsWith('\\\\') && !value.startsWith('//'))
  requireValid(!value.split(/[\\/]/).some((part) => part === '.' || part === '..'))
  const absolute = path.resolve(value)
  const root = path.parse(absolute).root
  requireValid(root === '/' || /^[A-Za-z]:\\$/.test(root))
  for (const part of absolute.slice(root.length).split(path.sep)) {
    requireValid(part && !/[\\<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !deviceName(part))
  }
  return absolute
}

function validateOptions(options) {
  requireValid(options !== null && typeof options === 'object' && !Array.isArray(options))
  requireValid([Object.prototype, null].includes(Object.getPrototypeOf(options)))
  const keys = [...FLAGS.values()]
  if (Object.hasOwn(options, 'bridgeOrigin')) keys.push('bridgeOrigin')
  requireValid(Reflect.ownKeys(options).length === keys.length)
  const values = Object.create(null)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    requireValid(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'))
    values[key] = descriptor.value
  }
  requireValid(values.host === 'figma' || values.host === 'photoshop')
  providedText(values.pluginId, values.host === 'figma' ? 32 : 128)
  requireValid(
    (values.host === 'figma' ? /^\d{5,32}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).test(
      values.pluginId
    )
  )
  identifier(values.publisherId)
  identifier(values.keyId)
  timestamp(values.issuedAt)
  if (Object.hasOwn(values, 'bridgeOrigin')) bridgeOrigin(values.bridgeOrigin)
  values.outputDir = outputPath(values.outputDir)
  return values
}

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
    requireValid(value.isDirectory() && !value.isSymbolicLink() && samePath(real(name), name))
    return { name, value }
  })
}

function unchangedDirectories(snapshot) {
  for (const { name, value } of snapshot) {
    const now = stat(name)
    requireValid(
      now.isDirectory() &&
        !now.isSymbolicLink() &&
        sameIdentity(value, now) &&
        samePath(real(name), name)
    )
  }
}

function readSource(name) {
  const parents = directories(path.dirname(name))
  const before = stat(name)
  requireValid(regular(before) && samePath(real(name), name))
  const handle = fs.openSync(
    name,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
  )
  try {
    const opened = fs.fstatSync(handle, { bigint: true })
    requireValid(regular(opened) && sameSnapshot(before, opened))
    unchangedDirectories(parents)
    const data = Buffer.alloc(Number(opened.size))
    let count = 0
    while (count < data.length) {
      const read = fs.readSync(handle, data, count, data.length - count, count)
      if (!read) break
      count += read
    }
    const after = fs.fstatSync(handle, { bigint: true })
    requireValid(count === data.length && regular(after) && sameSnapshot(opened, after))
    requireValid(sameSnapshot(after, stat(name)) && samePath(real(name), name))
    unchangedDirectories(parents)
    return { name, data, value: after, parents }
  } finally {
    fs.closeSync(handle)
  }
}

function readSourceRegular(base, parts) {
  return readSource(path.join(base, ...parts))
}

function unchangedSources(sources) {
  for (const source of sources) {
    unchangedDirectories(source.parents)
    const current = readSource(source.name)
    requireValid(
      sameSnapshot(source.value, current.value) && sha(source.data) === sha(current.data)
    )
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

function writeNew(name, data, parents) {
  unchangedDirectories(parents)
  const handle = fs.openSync(name, 'wx', 0o600)
  try {
    const created = fs.fstatSync(handle, { bigint: true })
    requireValid(created.isFile() && created.nlink === 1n)
    requireValid(sameSnapshot(created, stat(name)) && samePath(real(name), name))
    unchangedDirectories(parents)
    fs.writeFileSync(handle, data)
    fs.fsyncSync(handle)
    const finished = fs.fstatSync(handle, { bigint: true })
    requireValid(regular(finished) && finished.size === BigInt(data.length))
    requireValid(sameSnapshot(finished, stat(name)) && samePath(real(name), name))
    unchangedDirectories(parents)
  } finally {
    fs.closeSync(handle)
  }
  // Never clean up by name after failure: another process may now own that name.
}

const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

/**
 * Copies only this script's repository templates into a new, caller-selected directory.
 * Optional bridgeOrigin selects v2 bridge sources and embeds config in the native entry script.
 * No identity, timestamp, key, trust, pairing or host execution is generated implicitly.
 * Failure may leave newly created outputs; existing names are never overwritten.
 */
export function prepareFigPluginHost(options) {
  try {
    const {
      host,
      pluginId,
      publisherId,
      keyId,
      issuedAt,
      bridgeOrigin: origin,
      outputDir: output
    } = validateOptions(options)
    const connected = origin !== undefined
    const parentSnapshot = directories(path.dirname(output))
    absent(output)
    const spec = HOSTS[host]
    const sourceDir = path.join(SOURCE_ROOT, spec.directory)
    const runtimeDir = connected ? path.join(sourceDir, 'bridge') : sourceDir
    const sources = [
      readSource(path.join(sourceDir, 'manifest.template.json')),
      readSource(path.join(runtimeDir, spec.code)),
      readSource(path.join(runtimeDir, spec.ui))
    ]
    const helperSource = connected
      ? readSourceRegular(SOURCE_ROOT, ['shared', 'selection-snapshot.js'])
      : null
    if (helperSource) sources.push(helperSource)
    const planningSource = connected
      ? readSourceRegular(SOURCE_ROOT, ['shared', 'plan-preview.js'])
      : null
    if (planningSource) sources.push(planningSource)
    const visualEvidenceSource = connected
      ? readSourceRegular(SOURCE_ROOT, ['shared', 'visual-evidence.js'])
      : null
    if (visualEvidenceSource) sources.push(visualEvidenceSource)
    const executionJournalSource = connected
      ? readSourceRegular(SOURCE_ROOT, ['shared', 'execution-journal.js'])
      : null
    if (executionJournalSource) sources.push(executionJournalSource)
    const pixelAuditSource = connected
      ? readSourceRegular(SOURCE_ROOT, ['shared', 'pixel-audit.js'])
      : null
    if (pixelAuditSource) sources.push(pixelAuditSource)
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sources[0].data))
    requireValid(manifest.id === spec.placeholder)
    requireValid(manifest.main === (host === 'figma' ? spec.code : spec.ui))
    if (host === 'figma') requireValid(manifest.ui === spec.ui)
    manifest.id = pluginId
    const template = {
      schemaVersion: connected ? 2 : 1,
      id: `user.${host}.${sha(pluginId).slice(0, 32)}`,
      name: 'MagicPot',
      version: '1.0.0',
      host,
      entryPath: 'manifest.json',
      capabilities: connected
        ? ['dialogue', 'asset-transfer', 'result-transfer']
        : ['asset-transfer'],
      permissions: {
        dialogue: connected ? 'prompt' : 'none',
        backgroundRemoval: 'none',
        assetTransfer: 'read',
        resultTransfer: connected ? 'write' : 'none',
        filesystem: 'none',
        network: connected ? 'desktop-bridge' : 'none'
      },
      limits: connected
        ? {
            maxPayloadBytes: 64 * 1024,
            maxResultBytes: 32 * 1024,
            maxConfigBytes: 16 * 1024,
            maxCallTimeoutMs: 90_000,
            maxConcurrentCalls: 1
          }
        : {},
      provenance: {
        publisherId,
        publisherName: 'User-provided development publisher',
        source: 'user-provided',
        issuedAt
      },
      signature: { algorithm: 'ed25519', keyId, signedAt: issuedAt },
      assets: [
        { id: 'native-manifest', path: 'manifest.json', mimeType: 'application/json' },
        { id: 'native-code', path: spec.code, mimeType: 'text/javascript' },
        { id: 'native-ui', path: spec.ui, mimeType: 'text/html' }
      ]
    }
    let code = sources[1].data
    if (connected) {
      template.bridge = { protocol: 1, origin }
      if (host === 'figma') {
        manifest.networkAccess = {
          allowedDomains: [origin],
          reasoning: 'Connect only to the locally paired MagicPot desktop bridge.'
        }
      } else {
        manifest.requiredPermissions = {
          localFileSystem: 'plugin',
          network: { domains: [origin] }
        }
      }
      const config = { protocol: 1, origin, pluginId: template.id, host }
      // Figma's sandbox cannot require a config module. Both hosts keep the four-file contract.
      code = Buffer.concat([
        Buffer.from(
          `globalThis.MAGICPOT_BRIDGE_CONFIG = Object.freeze(${JSON.stringify(config)});\n`
        ),
        helperSource.data,
        Buffer.from('\n;\n'),
        pixelAuditSource.data,
        Buffer.from('\n;\n'),
        visualEvidenceSource.data,
        Buffer.from('\n;\n'),
        planningSource.data,
        Buffer.from('\n;\n'),
        executionJournalSource.data,
        Buffer.from('\n;\n'),
        code
      ])
    }
    const files = [
      ['manifest.json', json(manifest)],
      [spec.code, code],
      [spec.ui, sources[2].data],
      ['package.template.json', json(template)]
    ]
    requireValid(files.every(([, data]) => data.length > 0 && data.length <= MAX_FILE))
    unchangedSources(sources)
    unchangedDirectories(parentSnapshot)
    // mkdir is deliberately nonrecursive and fails even for an existing empty directory.
    fs.mkdirSync(output, { mode: 0o700 })
    const parents = [...parentSnapshot, { name: output, value: stat(output) }]
    unchangedDirectories(parents)
    for (const [name, data] of files) writeNew(path.join(output, name), data, parents)
    unchangedSources(sources)
    unchangedDirectories(parents)
    return { host, fileCount: 4 }
  } catch {
    throw new Error(INVALID)
  }
}

function runCli(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(USAGE)
    return
  }
  requireValid(args.length === FLAGS.size * 2 || args.length === (FLAGS.size + 1) * 2)
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index] === '--bridge-origin' ? 'bridgeOrigin' : FLAGS.get(args[index])
    requireValid(key && !Object.hasOwn(options, key))
    options[key] = args[index + 1]
  }
  prepareFigPluginHost(options)
  process.stdout.write(SUCCESS)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli(process.argv.slice(2))
  } catch {
    process.stderr.write(CLI_ERROR)
    process.exitCode = 1
  }
}
