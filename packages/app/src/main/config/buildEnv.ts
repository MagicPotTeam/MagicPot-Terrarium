import { is, platform } from '@electron-toolkit/utils'
import { app } from 'electron'
import { Build, BuildEnv, BuildMode, EmbeddedDefaults, Env, PathMap } from '@shared/config/buildEnv'
import path from 'path'
import { BUILD_MODE, PACKAGE_VERSION } from '@shared/config/viteEnv'

/**
 * 构建环境相关参数
 *
 * 由构建环境唯一确定，不能被用户修改
 * 在一个固定的构建环境里，buildEnv 中的值相当于常数
 */

////////////////
// 构建环境
////////////////

function getEnv(): Env {
  const buildEnv = is.dev ? 'development' : 'prod'
  const buildPlatform = platform.isWindows ? 'windows' : platform.isMacOS ? 'macos' : 'unknown'
  const buildMode = BUILD_MODE
  const packageVersion = PACKAGE_VERSION

  return {
    build: buildEnv,
    platform: buildPlatform,
    buildMode: buildMode as BuildMode,
    packageVersion: packageVersion
  }
}

////////////////
// 各环境中 Electron 目录映射
////////////////
const runtimeAssetsDir = path.join(process.cwd(), 'packages', 'runtime-assets')
const resolvedResourcesPath = process.resourcesPath || path.join(runtimeAssetsDir, 'resources')

const pathMapByBuild: Record<Build, Omit<PathMap, 'data'>> = {
  development: {
    resources: path.join(runtimeAssetsDir, 'resources'), // development runtime resources
    file: process.cwd() // project root
  },
  prod: {
    resources: path.join(
      path.join(resolvedResourcesPath, '..'),
      'packages/runtime-assets/resources'
    ),
    file: path.join(resolvedResourcesPath, '..') // inside app folder
  }
}

function getPathMap(): PathMap {
  const env = getEnv()
  return {
    ...pathMapByBuild[env.build],
    data: app.getPath('userData') // Lazy evaluation ensures we get the overriden path set in index.ts
  }
}

function getDataDir() {
  return getPathMap().data
}

////////////////
// 嵌入目录
////////////////

function getComfyRuntimeRoot(env: Env): string {
  return env.build === 'development' ? 'vendor/comfyui' : 'ComfyUI_windows_portable'
}

function getEmbeddedDefaultsByPlatform(env: Env): EmbeddedDefaults {
  const comfyRuntimeRoot = getComfyRuntimeRoot(env)

  if (env.platform === 'windows') {
    return {
      pythonCmd: `${comfyRuntimeRoot}/python_embeded/python.exe`,
      comfyuiDir: `${comfyRuntimeRoot}/ComfyUI`,
      comfyuiArgs: ['--enable-cors-header', '--listen']
    }
  }

  if (env.platform === 'macos') {
    return {
      pythonCmd: `${comfyRuntimeRoot}/python_embedded_macos/python3_wrapper.sh`,
      comfyuiDir: `${comfyRuntimeRoot}/ComfyUI`,
      comfyuiArgs: ['--enable-cors-header', '--listen']
    }
  }

  return { pythonCmd: '', comfyuiDir: '', comfyuiArgs: [] }
}

function resolveEmbeddedDefaults(baseDir: string, defaults: EmbeddedDefaults): EmbeddedDefaults {
  return {
    pythonCmd: defaults.pythonCmd ? path.join(baseDir, defaults.pythonCmd) : '',
    comfyuiDir: defaults.comfyuiDir ? path.join(baseDir, defaults.comfyuiDir) : '',
    comfyuiArgs: defaults.comfyuiArgs
  }
}

function getEmbeddedDefaults(): EmbeddedDefaults {
  const env = getEnv()
  const defaults = getEmbeddedDefaultsByPlatform(env)
  if (env.buildMode !== 'embedded') {
    return defaults
  }
  return resolveEmbeddedDefaults(getPathMap().file, defaults)
}

////////////////
// 总结构
////////////////

export function getBuildEnv(): BuildEnv {
  return {
    env: getEnv(),
    pathMap: getPathMap(),
    embeddedDefaults: getEmbeddedDefaults()
  }
}

export function isDev() {
  return getBuildEnv().env.build === 'development'
}
