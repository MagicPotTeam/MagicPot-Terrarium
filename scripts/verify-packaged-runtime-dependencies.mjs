import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

export const requiredRuntimeFiles = [
  'node_modules/@modelcontextprotocol/sdk/package.json',
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/server/streamableHttp.js',
  'node_modules/@hono/node-server/package.json',
  'node_modules/@hono/node-server/dist/index.js',
  'node_modules/hono/package.json',
  'node_modules/hono/dist/cjs/index.js'
]

function toArchivePath(relativePath) {
  return relativePath.split('/').join(path.sep)
}

export function verifyPackagedRuntimeDependencies(appOutDir, packager) {
  const resourcesDir = packager?.getResourcesDir
    ? packager.getResourcesDir(appOutDir)
    : path.join(appOutDir, 'resources')
  const asarPath = path.join(resourcesDir, 'app.asar')
  if (!fs.existsSync(asarPath)) {
    throw new Error(`Packaged app.asar was not found: ${asarPath}`)
  }

  const missing = []
  for (const relativePath of requiredRuntimeFiles) {
    try {
      asar.extractFile(asarPath, toArchivePath(relativePath))
    } catch {
      missing.push(relativePath)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      [
        'Packaged app is missing required runtime dependencies:',
        ...missing.map((item) => `- ${item}`)
      ].join('\n')
    )
  }

  console.log(
    `[verify-packaged-runtime-dependencies] Verified ${requiredRuntimeFiles.length} files in ${asarPath}`
  )
}

function main(argv = process.argv.slice(2)) {
  const appOutDir = argv[0]
    ? path.resolve(argv[0])
    : path.join(repoRoot, 'dist', process.env.PACKAGE_MODE || 'pure', 'win-unpacked')
  verifyPackagedRuntimeDependencies(appOutDir)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
