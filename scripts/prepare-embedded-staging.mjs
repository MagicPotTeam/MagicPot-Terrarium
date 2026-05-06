#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const portableSrc = path.join(repoRoot, 'vendor', 'comfyui')
const stagingRoot = path.join(repoRoot, '.staging', 'embedded')
const localComfyRepo = fs.existsSync(path.join(portableSrc, 'ComfyUI'))
  ? fs.realpathSync(path.join(portableSrc, 'ComfyUI'))
  : path.join(portableSrc, 'ComfyUI')
const comfyDst = path.join(stagingRoot, 'ComfyUI')
const customNodesSrc = path.join(portableSrc, 'comfyui_data', 'custom_nodes')
const customNodesDst = path.join(comfyDst, 'custom_nodes')

const modelFileExtensions = new Set([
  '.safetensors',
  '.ckpt',
  '.pt',
  '.pth',
  '.gguf',
  '.onnx',
  '.bin'
])

function assertInsideRepo(targetPath) {
  const resolved = path.resolve(targetPath)
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`
  if (resolved !== repoRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Refusing to touch path outside repo: ${resolved}`)
  }
  return resolved
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function removeDir(dirPath) {
  const resolved = assertInsideRepo(dirPath)
  if (fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

function runGit(args, options = {}) {
  const output = execFileSync('git', args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
  })
  return typeof output === 'string' ? output.trim() : ''
}

function cloneFreshComfySource() {
  const commit = runGit(['rev-parse', 'HEAD'], { cwd: localComfyRepo })

  console.log(`[prepare-embedded-staging] Cloning clean ComfyUI source from ${localComfyRepo}`)
  runGit(['clone', '--no-hardlinks', localComfyRepo, comfyDst], { inherit: true })
  runGit(['checkout', '--detach', commit], { cwd: comfyDst, inherit: true })

  removeDir(path.join(comfyDst, '.git'))
  removeRepositoryMetadata(comfyDst)
}

function pathParts(root, targetPath) {
  const rel = path.relative(root, targetPath)
  return rel ? rel.split(path.sep).filter(Boolean) : []
}

function shouldSkipCache(parts, fileName) {
  return parts.includes('__pycache__') || fileName.endsWith('.pyc')
}

function shouldSkipRepositoryMetadata(parts, fileName) {
  return (
    parts.includes('.git') ||
    parts.includes('.github') ||
    parts.includes('.gitlab') ||
    fileName === '.gitmodules' ||
    fileName === '.gitattributes' ||
    fileName === '.gitignore'
  )
}

function shouldSkipCustomNodeSource(sourcePath, fileName) {
  const parts = pathParts(customNodesSrc, sourcePath)
  if (shouldSkipRepositoryMetadata(parts, fileName)) {
    return true
  }
  return shouldSkipCache(parts, fileName)
}

function removeRepositoryMetadata(root) {
  if (!fs.existsSync(root)) {
    return
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === '.github' || entry.name === '.gitlab') {
        fs.rmSync(entryPath, { recursive: true, force: true })
        continue
      }
      removeRepositoryMetadata(entryPath)
      continue
    }

    if (
      entry.isFile() &&
      (entry.name === '.gitmodules' || entry.name === '.gitattributes' || entry.name === '.gitignore')
    ) {
      fs.rmSync(entryPath, { force: true })
    }
  }
}

function copyTree(source, destination, shouldSkip = () => false) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing required source: ${source}`)
  }

  const sourceStat = fs.statSync(source)
  if (!sourceStat.isDirectory()) {
    throw new Error(`Expected directory: ${source}`)
  }

  ensureDir(destination)
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (shouldSkip(sourcePath, entry.name)) {
      continue
    }

    const stat = fs.statSync(sourcePath)
    if (stat.isDirectory()) {
      copyTree(sourcePath, destinationPath, shouldSkip)
      continue
    }
    if (stat.isFile()) {
      ensureDir(path.dirname(destinationPath))
      fs.copyFileSync(sourcePath, destinationPath)
    }
  }
}

function walkFiles(root, onFile) {
  if (!fs.existsSync(root)) {
    return
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    const stat = fs.statSync(entryPath)
    if (stat.isDirectory()) {
      walkFiles(entryPath, onFile)
    } else if (stat.isFile()) {
      onFile(entryPath)
    }
  }
}

function validateStaging() {
  const comfyDataPath = path.join(stagingRoot, 'comfyui_data')
  if (fs.existsSync(comfyDataPath)) {
    throw new Error(`Staging must not contain comfyui_data: ${comfyDataPath}`)
  }

  let customNodeFileCount = 0
  walkFiles(customNodesDst, () => {
    customNodeFileCount += 1
  })
  if (customNodeFileCount === 0) {
    throw new Error('Staged ComfyUI/custom_nodes is empty')
  }

  const forbiddenModelFiles = []
  walkFiles(path.join(comfyDst, 'models'), (filePath) => {
    if (modelFileExtensions.has(path.extname(filePath).toLowerCase())) {
      forbiddenModelFiles.push(filePath)
    }
  })
  if (forbiddenModelFiles.length > 0) {
    throw new Error(
      `Staging contains model files under ComfyUI/models:\n${forbiddenModelFiles.join('\n')}`
    )
  }
}

function main() {
  if (!fs.existsSync(localComfyRepo)) {
    throw new Error(`Missing ComfyUI source repo: ${localComfyRepo}`)
  }
  if (!fs.existsSync(customNodesSrc)) {
    throw new Error(`Missing custom_nodes source: ${customNodesSrc}`)
  }

  removeDir(stagingRoot)
  ensureDir(stagingRoot)

  cloneFreshComfySource()
  copyTree(customNodesSrc, customNodesDst, shouldSkipCustomNodeSource)
  removeRepositoryMetadata(customNodesDst)

  validateStaging()
  console.log(`[prepare-embedded-staging] Wrote ${comfyDst}`)
}

main()
