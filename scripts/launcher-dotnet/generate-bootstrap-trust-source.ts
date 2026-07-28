import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
function fail(message: string): never {
  throw new Error(`bootstrap trust generation rejected: ${message}`)
}
function file(path: string): string {
  if (!isAbsolute(path)) fail('paths must be absolute')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    fail('input must be a single-link regular file')
  return resolve(path)
}
function key(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== 32 || bytes.toString('base64') !== value)
    fail(`${label} must be canonical base64 for 32 bytes`)
  return bytes
}
function literal(value: string): string {
  return JSON.stringify(value)
}
export function buildBootstrapTrustSource(
  descriptorKeyId: string,
  descriptorPublicKey: string,
  manifestKeyId: string,
  manifestPublicKey: string
): string {
  if (
    !KEY_ID.test(descriptorKeyId) ||
    descriptorKeyId.includes('..') ||
    !KEY_ID.test(manifestKeyId) ||
    manifestKeyId.includes('..')
  )
    fail('key ID is invalid')
  const descriptor = [...key(descriptorPublicKey, 'descriptor public key')].join(', '),
    manifest = [...key(manifestPublicKey, 'manifest public key')].join(', ')
  return `namespace MagicPot.Launcher;\n\ninternal static class CompiledBootstrapTrustConfiguration\n{\n    internal static BootstrapTrustConfiguration Create() => BootstrapTrustConfiguration.CreateCompiled(true,\n        new Dictionary<string, byte[]>(StringComparer.Ordinal) { [${literal(descriptorKeyId)}] = new byte[] { ${descriptor} } },\n        new Dictionary<string, byte[]>(StringComparer.Ordinal) { [${literal(manifestKeyId)}] = new byte[] { ${manifest} } });\n}\n`
}
export function run(argv: readonly string[]): void {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i],
      v = argv[i + 1]
    if (!k || !v || values.has(k)) fail('invalid arguments')
    values.set(k, v)
  }
  const get = (name: string) => values.get(name) ?? fail(`missing ${name}`)
  const output = get('--output')
  if (!isAbsolute(output)) fail('output must be absolute')
  const manifestId = get('--manifest-key-id'),
    manifestKey = get('--manifest-public-key-base64')
  writeFileSync(
    resolve(output),
    buildBootstrapTrustSource(
      values.get('--descriptor-key-id') ?? manifestId,
      values.get('--descriptor-public-key-base64') ?? manifestKey,
      manifestId,
      manifestKey
    ),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  )
}
if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'bootstrap trust generation failed'}\n`
    )
    process.exitCode = 1
  }
}
