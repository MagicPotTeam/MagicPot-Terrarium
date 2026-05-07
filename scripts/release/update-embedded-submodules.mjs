#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..')
const manifestPath = path.join(repoRoot, 'scripts', 'comfy', 'embedded-sources.json')
const vendorRoot = path.join(repoRoot, 'vendor', 'comfyui')

function toNative(relativePath) {
  return path.join(...relativePath.split('/'))
}

function assertInsideVendor(targetPath) {
  const resolved = path.resolve(targetPath)
  const vendor = path.resolve(vendorRoot)
  const vendorWithSep = vendor.endsWith(path.sep) ? vendor : `${vendor}${path.sep}`
  if (resolved !== vendor && !resolved.startsWith(vendorWithSep)) {
    throw new Error(`Refusing to touch path outside vendor/comfyui: ${resolved}`)
  }
  return resolved
}

function runGit(args, options = {}) {
  const output = execFileSync('git', args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
  })
  return typeof output === 'string' ? output.trim() : ''
}

function isGitWorktree(targetPath) {
  try {
    runGit(['-C', targetPath, 'rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

function currentCommit(targetPath) {
  return runGit(['-C', targetPath, 'rev-parse', 'HEAD']).trim()
}

function ensureRootSubmodules() {
  runGit(['submodule', 'sync', '--recursive'], { inherit: true })
  runGit(['submodule', 'update', '--init', '--recursive'], { inherit: true })
}

function ensureNestedSubmodules(parentPath) {
  runGit(['-C', parentPath, 'submodule', 'sync', '--recursive'], { inherit: true })
  runGit(['-C', parentPath, 'submodule', 'update', '--init', '--recursive'], { inherit: true })
}

function resolveRemoteHead(targetPath) {
  try {
    return runGit([
      '-C',
      targetPath,
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD'
    ])
  } catch {
    try {
      runGit(['-C', targetPath, 'remote', 'set-head', 'origin', '--auto'], { inherit: true })
      return runGit([
        '-C',
        targetPath,
        'symbolic-ref',
        '--quiet',
        '--short',
        'refs/remotes/origin/HEAD'
      ])
    } catch {
      const remoteInfo = runGit(['-C', targetPath, 'remote', 'show', 'origin'])
      const match = remoteInfo.match(/HEAD branch:\s+([^\r\n]+)/)
      if (match && match[1] !== '(unknown)') {
        return `origin/${match[1].trim()}`
      }
      throw new Error(`Could not resolve origin HEAD for ${targetPath}`)
    }
  }
}

function updateSource(source, options) {
  const targetPath = assertInsideVendor(path.join(repoRoot, toNative(source.relativePath)))

  if (source.parentRelativePath) {
    const parentPath = assertInsideVendor(path.join(repoRoot, toNative(source.parentRelativePath)))
    if (!isGitWorktree(parentPath)) {
      throw new Error(`Missing parent submodule for ${source.name}: ${source.parentRelativePath}`)
    }
    ensureNestedSubmodules(parentPath)
  }

  if (!fs.existsSync(targetPath) || !isGitWorktree(targetPath)) {
    throw new Error(`Missing source submodule for ${source.name}: ${source.relativePath}`)
  }

  runGit(['-C', targetPath, 'remote', 'set-url', 'origin', source.url], { inherit: true })
  runGit(['-C', targetPath, 'fetch', 'origin'], { inherit: true })

  const remoteHead = resolveRemoteHead(targetPath)
  const nextCommit = runGit(['-C', targetPath, 'rev-parse', `${remoteHead}^{commit}`])
  const previousCommit = currentCommit(targetPath)

  console.log(`${source.name}: ${previousCommit} -> ${nextCommit}`)

  if (!options.dryRun && previousCommit !== nextCommit) {
    runGit(['-C', targetPath, 'checkout', '--detach', nextCommit], { inherit: true })
  }

  return {
    ...source,
    commit: nextCommit
  }
}

function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest.sources)) {
    throw new Error(`Invalid embedded source manifest: ${manifestPath}`)
  }

  ensureRootSubmodules()

  const sources = manifest.sources.map((source) => updateSource(source, { dryRun }))
  if (!dryRun) {
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, sources }, null, 2)}\n`, 'utf8')
    console.log(`Updated embedded source manifest: ${manifestPath}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export { main }
