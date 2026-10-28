import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const bridgeChildAssetPaths = ['out/bridge-child/index.cjs']
export const bridgeChildAssetProtocol = 'magicpot-figplugin-bridge-child-assets/v1'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function bridgeChildSourceManifest(root, buildResult) {
  const outputs = Array.isArray(buildResult) ? buildResult : [buildResult]
  const sources = new Map()
  for (const output of outputs) {
    if (!Array.isArray(output?.output)) throw new Error('Bridge child build output unavailable')
    for (const chunk of output.output) {
      if (chunk.type !== 'chunk') continue
      for (const id of Object.keys(chunk.modules)) {
        if (id.startsWith('\0')) continue
        const source = id.split('?')[0]
        if (!path.isAbsolute(source)) throw new Error('Bridge child source identity unavailable')
        const relative = path.relative(root, source).split(path.sep).join('/')
        const outside = relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)
        const normalized = source.replaceAll('\\', '/')
        // Linked package stores may be outside the workspace; never record an
        // absolute machine path or confuse two different versions of a source.
        const key =
          outside && normalized.includes('/node_modules/')
            ? 'node_modules/' + normalized.split('/node_modules/').at(-1)
            : outside
              ? undefined
              : relative
        if (!key || !fs.statSync(source).isFile())
          throw new Error('Bridge child source identity unavailable')
        const digest = hash(fs.readFileSync(source))
        if (sources.has(key) && sources.get(key) !== digest)
          throw new Error('Ambiguous bridge child source identity')
        sources.set(key, digest)
      }
    }
  }
  if (!sources.has('packages/app/src/main/figplugin/bridgeChildEntry.ts'))
    throw new Error('Bridge child entry missing from build output')
  return [...sources]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, sha256]) => ({ path, sha256 }))
}

/** Build the fixed utility-process entry without changing Electron's main bundle. */
export async function buildBridgeChild({ root = repoRoot } = {}) {
  const output = path.join(root, 'out/bridge-child')
  const buildResult = await build({
    root,
    configFile: false,
    logLevel: 'warn',
    resolve: {
      alias: { '@shared': path.join(root, 'packages/app/src/shared') }
    },
    build: {
      target: 'node24',
      outDir: output,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      lib: {
        entry: path.join(root, 'packages/app/src/main/figplugin/bridgeChildEntry.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs'
      },
      rollupOptions: {
        external: (id) => id.startsWith('node:') || id === 'electron',
        output: { inlineDynamicImports: true, dynamicImportInCjs: true }
      }
    }
  })
  const files = bridgeChildAssetPaths.map((relative) => ({
    path: relative,
    sha256: hash(fs.readFileSync(path.join(root, relative)))
  }))
  const manifest = {
    protocol: bridgeChildAssetProtocol,
    files,
    sourceFiles: bridgeChildSourceManifest(root, buildResult)
  }
  fs.writeFileSync(
    path.join(output, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildBridgeChild().catch((error) => {
    console.error('Bridge child build failed')
    if (process.env.DEBUG_BUILD === '1') console.error(error)
    process.exitCode = 1
  })
}
