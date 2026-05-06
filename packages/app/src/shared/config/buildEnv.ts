/**
 * buildEnv 中的值都必须为构建时就确定的常量
 * 不能被用户改变
 */

////////////////
// 构建环境
////////////////

export type Build =
  | 'development' // 本地研发环境，断点调试时或 npm run dev 热重载时
  | 'prod' // 打包好后的环境， npm run build:mac 或 npm run build:win 后的产物

export type Platform =
  | 'windows' // Windows 平台
  | 'macos' // MacOS 平台
  | 'unknown' // 现在未做 Linux 平台，其余一律当作未知平台

export type BuildMode =
  | 'embedded' // 嵌入模式
  | 'pure' // 纯净模式

export type Env = {
  build: Build
  platform: Platform
  buildMode: BuildMode
  packageVersion: string
}

////////////////
// 各环境中 Electron 目录映射
// By Build
////////////////

export type PathType = 'resources' | 'file' | 'data'

export type PathMap = Record<PathType, string>

////////////////
// 嵌入目录
// By Platform
////////////////

export type EmbeddedDefaults = {
  pythonCmd: string
  comfyuiDir: string
  comfyuiArgs: string[]
}

////////////////
// 总结构
////////////////

export type BuildEnv = {
  env: Env
  pathMap: PathMap
  embeddedDefaults: EmbeddedDefaults
}

/**
 * 在 buildEnv 未初始化时，使用这个默认值
 * 一旦 buildEnv 初始化完成，就全局固定，不要再使用这个默认值
 */
export const DEFAULT_BUILD_ENV: BuildEnv = {
  env: {
    build: 'prod',
    platform: 'unknown',
    buildMode: 'pure',
    packageVersion: 'unknown'
  },
  pathMap: {
    resources: '',
    file: '',
    data: ''
  },
  embeddedDefaults: {
    pythonCmd: '',
    comfyuiDir: '',
    comfyuiArgs: []
  }
}
