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
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js',
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js',
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js',
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js',
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/server/sse.js',
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js',
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/server/streamableHttp.js',
  'node_modules/@hono/node-server/package.json',
  'node_modules/@hono/node-server/dist/index.js',
  'node_modules/hono/package.json',
  'node_modules/hono/dist/cjs/index.js',
  'node_modules/ajv-formats/package.json',
  'node_modules/content-type/package.json',
  'node_modules/cors/package.json',
  'node_modules/cross-spawn/package.json',
  'node_modules/eventsource/package.json',
  'node_modules/eventsource-parser/package.json',
  'node_modules/express/package.json',
  'node_modules/express-rate-limit/package.json',
  'node_modules/jose/package.json',
  'node_modules/json-schema-typed/package.json',
  'node_modules/pkce-challenge/package.json',
  'node_modules/raw-body/package.json',
  'node_modules/zod/package.json',
  'node_modules/zod-to-json-schema/package.json'
]

const runtimeRootPackages = ['@modelcontextprotocol/sdk']

function toArchivePath(relativePath) {
  return relativePath.split('/').join(path.sep)
}

function archiveFileExists(asarPath, relativePath) {
  try {
    asar.extractFile(asarPath, toArchivePath(relativePath))
    return true
  } catch {
    return false
  }
}

function readArchivePackageJson(asarPath, packageRoot) {
  const packageJsonPath = path.posix.join(packageRoot, 'package.json')
  const contents = asar.extractFile(asarPath, toArchivePath(packageJsonPath))
  return JSON.parse(contents.toString('utf8'))
}

function resolveArchivePackageRoot(asarPath, fromPackageRoot, dependencyName) {
  let current = fromPackageRoot
  while (true) {
    const candidate = path.posix.join(current, 'node_modules', dependencyName, 'package.json')
    if (archiveFileExists(asarPath, candidate)) {
      return path.posix.dirname(candidate)
    }

    const parent = path.posix.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

export function findMissingRuntimeDependencyClosure(asarPath) {
  const missing = []
  const visited = new Set()
  const queue = runtimeRootPackages.map((packageName) => ({
    packageName,
    packageRoot: path.posix.join('node_modules', packageName)
  }))

  while (queue.length > 0) {
    const current = queue.shift()
    if (visited.has(current.packageRoot)) {
      continue
    }
    visited.add(current.packageRoot)

    let packageJson
    try {
      packageJson = readArchivePackageJson(asarPath, current.packageRoot)
    } catch {
      missing.push(`${current.packageName}: invalid or missing package.json`)
      continue
    }

    const requiredDependencies = new Set(Object.keys(packageJson.dependencies || {}))
    for (const dependencyName of Object.keys(packageJson.peerDependencies || {})) {
      if (!packageJson.peerDependenciesMeta?.[dependencyName]?.optional) {
        requiredDependencies.add(dependencyName)
      }
    }
    for (const dependencyName of Object.keys(packageJson.optionalDependencies || {})) {
      requiredDependencies.delete(dependencyName)
      const optionalRoot = resolveArchivePackageRoot(asarPath, current.packageRoot, dependencyName)
      if (optionalRoot) {
        queue.push({ packageName: dependencyName, packageRoot: optionalRoot })
      }
    }

    for (const dependencyName of requiredDependencies) {
      const dependencyRoot = resolveArchivePackageRoot(
        asarPath,
        current.packageRoot,
        dependencyName
      )
      if (!dependencyRoot) {
        missing.push(`${packageJson.name || current.packageName} -> ${dependencyName}`)
        continue
      }
      queue.push({ packageName: dependencyName, packageRoot: dependencyRoot })
    }
  }

  return { missing, packageCount: visited.size }
}

export function verifyPackagedRuntimeDependencies(appOutDir, packager) {
  const resourcesDir = packager?.getResourcesDir
    ? packager.getResourcesDir(appOutDir)
    : path.join(appOutDir, 'resources')
  const asarPath = path.join(resourcesDir, 'app.asar')
  if (!fs.existsSync(asarPath)) {
    throw new Error(`Packaged app.asar was not found: ${asarPath}`)
  }

  const missingFiles = requiredRuntimeFiles.filter(
    (relativePath) => !archiveFileExists(asarPath, relativePath)
  )
  const closure = findMissingRuntimeDependencyClosure(asarPath)

  if (missingFiles.length > 0 || closure.missing.length > 0) {
    throw new Error(
      [
        'Packaged app is missing required runtime dependencies:',
        ...missingFiles.map((item) => `- ${item}`),
        ...closure.missing.map((item) => `- ${item}`)
      ].join('\n')
    )
  }

  console.log(
    `[verify-packaged-runtime-dependencies] Verified ${requiredRuntimeFiles.length} files and ${closure.packageCount} runtime packages in ${asarPath}`
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
