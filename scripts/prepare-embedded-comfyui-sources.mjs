#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const vendorRoot = path.join(repoRoot, 'vendor', 'comfyui')
const sourcesPath = path.join(scriptDir, 'comfy', 'embedded-sources.json')
const dryRun = process.argv.includes('--dry-run') || process.env.EMBEDDED_SOURCES_DRY_RUN === '1'
const force = process.argv.includes('--force') || process.env.EMBEDDED_SOURCE_REFRESH === '1'
const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8')).sources

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
  console.log(`[prepare-embedded-comfyui-sources] git ${args.join(' ')}`)
  return execFileSync('git', args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
  })
}

function isGitWorktree(targetPath) {
  try {
    runGit(['-C', targetPath, 'rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

const repoRootHasGitWorktree = isGitWorktree(repoRoot)

function currentCommit(targetPath) {
  return runGit(['-C', targetPath, 'rev-parse', 'HEAD']).trim()
}

function fetchCommit(targetPath, commit) {
  try {
    runGit(['-C', targetPath, 'fetch', '--depth=1', 'origin', commit], { inherit: true })
  } catch {
    runGit(['-C', targetPath, 'fetch', 'origin'], { inherit: true })
  }
}

function prepareSource(source) {
  const targetPath = assertInsideVendor(path.join(repoRoot, toNative(source.relativePath)))
  if (dryRun) {
    const sourceType = source.parentRelativePath ? 'nested submodule' : 'submodule'
    console.log(
      `${source.name}: ${sourceType} ${source.commit} ${source.url} -> ${source.relativePath}`
    )
    return
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  if (
    !source.parentRelativePath &&
    force &&
    fs.existsSync(targetPath) &&
    !isGitWorktree(targetPath)
  ) {
    fs.rmSync(targetPath, { recursive: true, force: true })
  }

  if (source.parentRelativePath) {
    const parentPath = assertInsideVendor(path.join(repoRoot, toNative(source.parentRelativePath)))
    if (!isGitWorktree(parentPath)) {
      throw new Error(`Missing parent submodule for ${source.name}: ${source.parentRelativePath}`)
    }
    runGit(['-C', parentPath, 'submodule', 'sync', '--recursive'], { inherit: true })
    runGit(['-C', parentPath, 'submodule', 'update', '--init', '--recursive'], { inherit: true })
  } else {
    if (fs.existsSync(targetPath) && !isGitWorktree(targetPath)) {
      throw new Error(
        `${source.relativePath} exists but is not a git submodule. Move it aside or rerun with --force.`
      )
    }
    if (repoRootHasGitWorktree) {
      runGit(['submodule', 'sync', '--', source.relativePath], { inherit: true })
      runGit(
        ['submodule', 'update', '--init', ...(force ? ['--force'] : []), '--', source.relativePath],
        {
          inherit: true
        }
      )
    } else if (!fs.existsSync(targetPath)) {
      throw new Error(
        `Missing source for ${source.name}: ${source.relativePath}. The workspace is not a git repository, so submodules cannot be initialized here.`
      )
    }
  }

  if (!fs.existsSync(targetPath) || !isGitWorktree(targetPath)) {
    throw new Error(`Missing source submodule for ${source.name}: ${source.relativePath}`)
  }
  runGit(['-C', targetPath, 'remote', 'set-url', 'origin', source.url], { inherit: true })
  if (currentCommit(targetPath) !== source.commit) {
    fetchCommit(targetPath, source.commit)
    runGit(['-C', targetPath, 'checkout', '--detach', source.commit], { inherit: true })
  }

  if (currentCommit(targetPath) !== source.commit) {
    throw new Error(`${source.name} is not at expected commit ${source.commit}`)
  }
}

for (const source of sources) {
  prepareSource(source)
}

if (!dryRun) {
  console.log(`[prepare-embedded-comfyui-sources] Wrote ${vendorRoot}`)
}
