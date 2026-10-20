import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'packages/app/src/shared/figplugin/hostPlanningClient.ts')
const require = createRequire(import.meta.url)
const zodLicense = fs.readFileSync(
  path.join(path.dirname(require.resolve('zod/package.json')), 'LICENSE'),
  'utf8'
)
const destination = path.join(root, 'packages/figplugin-hosts/shared/plan-preview.js')

/** Build only the shared read-only snapshot/plan validators. No native mutation API. */
export async function buildHostPlanPreview() {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'MagicPotPlanPreviewBundle',
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
    `// Generated read-only FIGPLUGIN plan preview; source binding ${binding}.\n` +
    '/* Includes Zod (MIT):\n' +
    zodLicense.replaceAll('*/', '* /') +
    '\n*/\n' +
    result.outputFiles[0].text +
    '\nObject.defineProperty(globalThis,"MagicPotPlanPreviewV1",{value:Object.freeze(MagicPotPlanPreviewBundle),writable:false,configurable:false});\n'
  return { text, sourceHashes, binding, destination }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv.slice(2)
  if (mode.length !== 1 || !['--check', '--write'].includes(mode[0]))
    throw new Error('Use --check or --write')
  const output = await buildHostPlanPreview()
  if (mode[0] === '--check') {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== output.text)
      throw new Error(
        'FIGPLUGIN read-only plan preview bundle is stale. Rebuild from the shared source.'
      )
    console.log('Read-only plan preview bundle matches the shared source.')
  } else {
    fs.writeFileSync(destination, output.text, 'utf8')
    console.log('Generated read-only plan preview bundle; no host code was executed.')
  }
}
