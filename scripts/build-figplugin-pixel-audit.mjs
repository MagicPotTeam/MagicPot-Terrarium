import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'packages/app/src/shared/figplugin/pixelAuditRuntime.ts')
const require = createRequire(import.meta.url)
const fflateLicense = fs.readFileSync(
  path.join(path.dirname(require.resolve('fflate/package.json')), 'LICENSE'),
  'utf8'
)
const destination = path.join(root, 'packages/figplugin-hosts/shared/pixel-audit.js')

/** Build only the bounded host-local pixel decoder and comparison functions. No native mutation API. */
export async function buildHostPixelAudit() {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'MagicPotPixelAuditBundle',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    metafile: true,
    absWorkingDir: root
  })
  const sourceHashes = {}
  for (const file of Object.keys(result.metafile.inputs).sort()) {
    const normalized = file.replaceAll('\\', '/')
    const key = normalized.includes('/node_modules/')
      ? 'node_modules/' + normalized.split('/node_modules/').at(-1)
      : normalized.replace(/^.*\/packages\//, 'packages/')
    if (Object.hasOwn(sourceHashes, key)) throw new Error('Ambiguous validator source identity')
    // Git's checkout line ending policy must not make a semantically identical generated file stale.
    const source = fs.readFileSync(path.resolve(root, file), 'utf8').replaceAll('\r\n', '\n')
    sourceHashes[key] = createHash('sha256').update(source).digest('hex')
  }
  const binding = createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex')
  const text =
    `// Generated host-local FIGPLUGIN pixel audit; source binding ${binding}.\n` +
    '/* Includes fflate 0.8.3 (MIT):\n' +
    fflateLicense.replaceAll('*/', '* /') +
    '\n*/\n' +
    result.outputFiles[0].text +
    '\nObject.defineProperty(globalThis,"MagicPotPixelAuditV1",{value:MagicPotPixelAuditBundle.hostPixelAudit,writable:false,configurable:false});\n'
  return { text, sourceHashes, binding, destination }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv.slice(2)
  if (mode.length !== 1 || !['--check', '--write'].includes(mode[0]))
    throw new Error('Use --check or --write')
  const output = await buildHostPixelAudit()
  if (mode[0] === '--check') {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== output.text)
      throw new Error('FIGPLUGIN pixel audit bundle is stale. Rebuild from the shared source.')
    console.log('Pixel audit bundle matches the shared source.')
  } else {
    fs.writeFileSync(destination, output.text, 'utf8')
    console.log('Generated pixel audit bundle; no host code was executed.')
  }
}
