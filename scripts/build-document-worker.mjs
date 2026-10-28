import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const documentWorkerAssetPaths = [
  'out/document-worker/index.cjs',
  'out/document-worker/THIRD-PARTY-NOTICES.txt',
  'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  'node_modules/pdfjs-dist/LICENSE'
]

const resolvePackageJson = (require, name) => {
  try {
    return require.resolve(`${name}/package.json`)
  } catch (error) {
    if (name !== 'xmlchars' || error?.code !== 'MODULE_NOT_FOUND') throw error
    const saxesPackageJson = require.resolve('saxes/package.json')
    return createRequire(saxesPackageJson).resolve('xmlchars/package.json')
  }
}

/** Independent fixed input. Never adds a second electron-vite main input or clears out/main. */
export async function buildDocumentWorker({ repoRoot = defaultRoot } = {}) {
  const require = createRequire(path.join(repoRoot, 'package.json'))
  const versions = {}
  let notices = 'MagicPot document text worker third-party notices\n\n'
  for (const [name, expected] of [
    ['pdfjs-dist', '6.3.289'],
    ['saxes', '6.0.0'],
    ['xmlchars', '2.2.0'],
    ['zod', null]
  ]) {
    const jsonPath = resolvePackageJson(require, name)
    const pkg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    if (expected && pkg.version !== expected)
      throw new Error('Document dependency version mismatch')
    if (
      name === 'pdfjs-dist' &&
      (pkg.name !== name || pkg.main !== 'build/pdf.mjs' || Object.hasOwn(pkg, 'exports'))
    )
      throw new Error('Document dependency resolution mismatch')
    versions[name] = pkg.version
    const root = path.dirname(jsonPath)
    const licenseName = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find((file) =>
      fs.existsSync(path.join(root, file))
    )
    // saxes 6's npm tarball omits its upstream LICENSE. Preserve the exact tagged
    // license offline; no network fetch or install script is allowed at build time.
    const licensePath = licenseName
      ? path.join(root, licenseName)
      : name === 'saxes'
        ? path.join(repoRoot, 'scripts/licenses/saxes-6.0.0-LICENSE.txt')
        : null
    if (!licensePath) throw new Error('Document dependency license missing')
    notices += `=== ${name} ${pkg.version} (${pkg.license}) ===\n${fs.readFileSync(licensePath, 'utf8')}\n\n`
    if (name === 'saxes')
      notices += 'Source: https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE\n\n'
  }
  const output = path.join(repoRoot, 'out/document-worker')
  fs.mkdirSync(output, { recursive: true })
  await build({
    root: repoRoot,
    configFile: false,
    logLevel: 'warn',
    build: {
      target: 'node24',
      outDir: output,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      lib: {
        entry: path.join(
          repoRoot,
          'packages/app/src/main/agentLocalFiles/documents/documentWorkerEntry.ts'
        ),
        formats: ['cjs'],
        fileName: () => 'index.cjs'
      },
      rollupOptions: {
        external: (id) => id.startsWith('node:') || id.startsWith('pdfjs-dist/'),
        output: { inlineDynamicImports: true, dynamicImportInCjs: true }
      }
    }
  })
  fs.writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.txt'), notices)
  const manifest = {
    protocol: 'magicpot-document-worker-assets/v2',
    pdfjsVersion: versions['pdfjs-dist'],
    saxesVersion: versions.saxes,
    bundledVersions: { saxes: versions.saxes, xmlchars: versions.xmlchars, zod: versions.zod },
    files: documentWorkerAssetPaths.map((relative) => ({
      path: relative,
      sha256: hash(fs.readFileSync(path.join(repoRoot, relative)))
    })),
    sourceFiles: fs
      .readdirSync(path.join(repoRoot, 'packages/app/src/main/agentLocalFiles/documents'))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .sort()
      .map((name) => {
        const relative = `packages/app/src/main/agentLocalFiles/documents/${name}`
        return { path: relative, sha256: hash(fs.readFileSync(path.join(repoRoot, relative))) }
      })
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ output, versions, files: manifest.files }, null, 2))
  return manifest
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildDocumentWorker().catch(() => {
    console.error('Document worker build failed')
    process.exitCode = 1
  })
}
