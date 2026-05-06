#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const vendorRoot = path.join(repoRoot, 'vendor', 'comfyui')
const dryRun = process.argv.includes('--dry-run') || process.env.EMBEDDED_SOURCES_DRY_RUN === '1'
const force = process.argv.includes('--force') || process.env.EMBEDDED_SOURCE_REFRESH === '1'

const sources = [
  {
    name: 'ComfyUI',
    url: 'https://github.com/Comfy-Org/ComfyUI.git',
    commit: '6bcd8b96ab4650db6e834dcbb54357ebf72edfe6',
    relativePath: 'vendor/comfyui/ComfyUI'
  },
  {
    name: 'ComfyUI-Advanced-ControlNet',
    url: 'https://github.com/chinoll/ComfyUI-Advanced-ControlNet.git',
    commit: '3537c5b1b0b6d6a59e09d2c520bbd0afcf694d71',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI-Advanced-ControlNet'
  },
  {
    name: 'ComfyUI-Custom-Scripts',
    url: 'https://github.com/pythongosssss/ComfyUI-Custom-Scripts.git',
    commit: '609f3afaa74b2f88ef9ce8d939626065e3247469',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI-Custom-Scripts'
  },
  {
    name: 'ComfyUI-Easy-Use',
    url: 'https://github.com/yolain/ComfyUI-Easy-Use.git',
    commit: '130c1b5796d9876a5f853fa0bea88e808cfda4ad',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI-Easy-Use'
  },
  {
    name: 'ComfyUI-Easy-Use-Frontend',
    url: 'https://github.com/yolain/ComfyUI-Easy-Use-Frontend.git',
    commit: '8b95a4210032072773929b7c8176c43804ebf6ee',
    parentRelativePath: 'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI-Easy-Use',
    relativePath:
      'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI-Easy-Use/ComfyUI-Easy-Use-Frontend'
  },
  {
    name: 'ComfyUI-Inspyrenet-Rembg',
    url: 'https://github.com/john-mnz/ComfyUI-Inspyrenet-Rembg.git',
    commit: '87ac452ef1182e8f35f59b04010158d74dcefd06',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI-Inspyrenet-Rembg'
  },
  {
    name: 'ComfyUI-KJNodes',
    url: 'https://github.com/kijai/ComfyUI-KJNodes.git',
    commit: '9c3255f39cd2ea0ebf94a2016af4bd2e5d6eb91b',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI-KJNodes'
  },
  {
    name: 'ComfyUI-Manager',
    url: 'https://github.com/Comfy-Org/ComfyUI-Manager.git',
    commit: '8d5c12037f873c2f9e059e4f9c409a2835a9b8cf',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI-Manager'
  },
  {
    name: 'ComfyUI-qwenmultiangle',
    url: 'https://github.com/jtydhr88/ComfyUI-qwenmultiangle.git',
    commit: '6f93d9b15a50c07c13411734723fe5cae287e7aa',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI-qwenmultiangle'
  },
  {
    name: 'ComfyUI-SeedVR2_VideoUpscaler',
    url: 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git',
    commit: '4490bd1f482e026674543386bb2a4d176da245b9',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI-SeedVR2_VideoUpscaler'
  },
  {
    name: 'comfyui_controlnet_aux',
    url: 'https://github.com/Fannovel16/comfyui_controlnet_aux.git',
    commit: 'e8b689a513c3e6b63edc44066560ca5919c0576e',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/comfyui_controlnet_aux'
  },
  {
    name: 'comfyui_LLM_party',
    url: 'https://github.com/heshengtao/comfyui_LLM_party.git',
    commit: '4d279969d7b08a24857f7455b362b745d6dcf2d0',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/comfyui_LLM_party'
  },
  {
    name: 'ComfyUI_smZNodes',
    url: 'https://github.com/shiimizu/ComfyUI_smZNodes.git',
    commit: '9562d76c3cf206a3c2362e2baf8bbf717a4869a5',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/ComfyUI_smZNodes'
  },
  {
    name: 'z-tipo-extension',
    url: 'https://github.com/KohakuBlueleaf/z-tipo-extension.git',
    commit: 'd6bbb86726e06f3e3ab60c804f811993dc740223',
    relativePath: 'vendor/comfyui/comfyui_data/custom_nodes/z-tipo-extension'
  }
]

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
    runGit(['submodule', 'sync', '--', source.relativePath], { inherit: true })
    runGit(
      ['submodule', 'update', '--init', ...(force ? ['--force'] : []), '--', source.relativePath],
      {
        inherit: true
      }
    )
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
