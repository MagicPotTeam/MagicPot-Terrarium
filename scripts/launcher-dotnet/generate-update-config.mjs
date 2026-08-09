#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REPO_PREFIX = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FORBIDDEN_FIELD = /(private|secret|seed|token)/i
const CHANNELS = ['stable', 'beta', 'nightly']

function fail(message) { throw new Error(`update configuration rejected: ${message}`) }
function exactObject(value, allowed, required, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${location}: expected object`)
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_FIELD.test(key)) fail(`${location}: forbidden field name`)
    if (!allowed.includes(key)) fail(`${location}: unknown field`)
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${location}: missing required field`)
}
function rejectForbiddenFields(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(key)) fail('forbidden field name')
    rejectForbiddenFields(child)
  }
}
function parseHttpsUrl(value, location, originOnly = false) {
  if (typeof value !== 'string') fail(`${location}: expected string`)
  let url
  try { url = new URL(value) } catch { fail(`${location}: expected absolute HTTPS URL`) }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail(`${location}: expected credential-free HTTPS URL without hash`)
  if (originOnly && (url.pathname !== '/' || url.search)) fail(`${location}: expected HTTPS origin without path/query/hash`)
  return url
}
function strictBase64(value, location) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(value)) fail(`${location}: expected canonical base64`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== 32 || bytes.toString('base64') !== value) fail(`${location}: expected exactly 32 bytes`)
  return bytes
}

export function validateConfiguration(value, launcherVersion) {
  rejectForbiddenFields(value)
  exactObject(value, ['schema', 'launcherVersion', 'channels', 'trustedSources', 'publicKeys', 'bootstrapPublicKeys'], ['schema', 'launcherVersion', 'channels', 'trustedSources', 'publicKeys', 'bootstrapPublicKeys'], '$')
  if (value.schema !== 1) fail('schema: expected 1')
  if (typeof value.launcherVersion !== 'string' || !SEMVER.test(value.launcherVersion)) fail('launcherVersion: expected SemVer')
  if (value.launcherVersion !== launcherVersion) fail('launcherVersion: does not match --launcher-version')
  exactObject(value.channels, CHANNELS, CHANNELS, 'channels')
  const channels = Object.fromEntries(CHANNELS.map(name => [name, parseHttpsUrl(value.channels[name], `channels.${name}`)]))
  if (!Array.isArray(value.trustedSources) || value.trustedSources.length === 0) fail('trustedSources: expected non-empty array')
  const trustedSources = value.trustedSources.map((source, index) => {
    exactObject(source, ['origin', 'repoPathPrefix'], ['origin', 'repoPathPrefix'], `trustedSources[${index}]`)
    const origin = parseHttpsUrl(source.origin, `trustedSources[${index}].origin`, true)
    if (typeof source.repoPathPrefix !== 'string' || !REPO_PREFIX.test(source.repoPathPrefix)) fail(`trustedSources[${index}].repoPathPrefix: expected /owner/repository`)
    return { origin: origin.origin, repoPathPrefix: source.repoPathPrefix }
  })
  const parseKeys = (value, location) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) fail(`${location}: expected non-empty object`)
    return Object.entries(value).map(([keyId, encoded]) => {
      if (!KEY_ID.test(keyId)) fail(`${location}: unsafe key id`)
      return [keyId, strictBase64(encoded, `${location}.${keyId}`)]
    }).sort(([a], [b]) => a.localeCompare(b, 'en'))
  }
  const publicKeys = parseKeys(value.publicKeys, 'publicKeys')
  const bootstrapPublicKeys = parseKeys(value.bootstrapPublicKeys, 'bootstrapPublicKeys')
  for (const [name, url] of Object.entries(channels)) {
    const matched = trustedSources.some(source => url.origin === source.origin && (url.pathname.startsWith(`${source.repoPathPrefix}/releases/download/`) || url.pathname.startsWith(`${source.repoPathPrefix}/releases/tag/`)))
    if (!matched) fail(`channels.${name}: URL does not match a trusted source release path`)
  }
  return { launcherVersion, channels, trustedSources, publicKeys, bootstrapPublicKeys }
}
export function csString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`
}
export function generateSource(config) {
  if (config === null) return `// <auto-generated />\nnamespace MagicPot.Launcher;\n\ninternal static class CompiledLauncherUpdateConfiguration\n{\n    internal static LauncherUpdateConfiguration Create() => LauncherUpdateConfiguration.Disabled;\n}\n`
  const channels = CHANNELS.map(name => `            [${csString(name)}] = ${csString(config.channels[name].href)}`).join(',\n')
  const sources = config.trustedSources.map(source => `            new(${csString(source.origin)}, ${csString(source.repoPathPrefix)})`).join(',\n')
  const keys = config.publicKeys.map(([id, bytes]) => `            [${csString(id)}] = new byte[] { ${[...bytes].join(', ')} }`).join(',\n')
  return `// <auto-generated />\nusing System;\nusing System.Collections.Generic;\n\nnamespace MagicPot.Launcher;\n\ninternal static class CompiledLauncherUpdateConfiguration\n{\n    internal static LauncherUpdateConfiguration Create() => new(\n        true,\n        ${csString(config.launcherVersion)},\n        new Dictionary<string, string>(StringComparer.Ordinal)\n        {\n${channels}\n        },\n        new TrustedReleaseSource[]\n        {\n${sources}\n        },\n        new Dictionary<string, byte[]>(StringComparer.Ordinal)\n        {\n${keys}\n        });\n}\n`
}
function parseArgs(argv) {
  const result = { disabled: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--disabled') result.disabled = true
    else if (['--input', '--output', '--launcher-version'].includes(arg) && i + 1 < argv.length) result[arg.slice(2)] = argv[++i]
    else fail('invalid command line')
  }
  if (!result.output || !result['launcher-version']) fail('--output and --launcher-version are required')
  if (!SEMVER.test(result['launcher-version'])) fail('--launcher-version must be SemVer')
  if (!result.disabled && !result.input) fail('--input is required unless --disabled is used')
  if (result.disabled && result.input) fail('--input cannot be used with --disabled')
  return result
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  let config = null
  if (!args.disabled) {
    let parsed
    try { parsed = JSON.parse(await readFile(args.input, 'utf8')) } catch { fail('input is not valid JSON') }
    config = validateConfiguration(parsed, args['launcher-version'])
  }
  const output = path.resolve(args.output)
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, generateSource(config), { encoding: 'utf8' })
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
