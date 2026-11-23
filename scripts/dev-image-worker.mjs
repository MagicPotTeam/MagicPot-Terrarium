import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { buildImageWorker, getImageWorkerBuildPaths } from './build-image-worker.mjs'

// `npm run dev` has no packaged image worker. Build it into the same
// packages/runtime-assets location the release build uses; the main process
// already looks there relative to the dev cwd (the repo root). This step never
// downloads crates (CARGO_NET_OFFLINE) and never blocks dev startup: on any
// problem it prints a short warning and thumbnails fall back to the original.

const SIDECAR_PATH_ENV = 'MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_PATH'
const FIRST_BUILD_MINUTES = '2-5'

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

function envKey(env, name, platform) {
  return Object.keys(env).find((key) =>
    platform === 'win32' ? key.toUpperCase() === name : key === name
  )
}

function isFile(fsModule, candidate) {
  try {
    return fsModule.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function mtimeOrNull(fsModule, file) {
  try {
    return fsModule.statSync(file).mtimeMs
  } catch {
    return null
  }
}

function newestMtime(fsModule, entryPath) {
  let stat
  try {
    stat = fsModule.statSync(entryPath)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.mtimeMs
  // Only file times count: editors touch directory times with temporary files.
  let newest = 0
  for (const name of fsModule.readdirSync(entryPath)) {
    newest = Math.max(newest, newestMtime(fsModule, path.join(entryPath, name)))
  }
  return newest
}

export function getImageWorkerSourceMtime(manifestPath, fsModule = fs) {
  const crateDir = path.dirname(manifestPath)
  return Math.max(
    ...['Cargo.toml', 'Cargo.lock', 'build.rs', 'src'].map((name) =>
      newestMtime(fsModule, path.join(crateDir, name))
    )
  )
}

export function findCargo({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  fsModule = fs
} = {}) {
  const paths = pathApi(platform)
  const executable = platform === 'win32' ? 'cargo.exe' : 'cargo'
  const pathKey = envKey(env, 'PATH', platform)
  const pathDirs = (pathKey ? env[pathKey] : '').split(paths.delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    const candidate = paths.join(dir, executable)
    if (isFile(fsModule, candidate)) return { cargo: candidate, fromPath: true }
  }
  const fallback = paths.join(homedir, '.cargo', 'bin', executable)
  if (homedir && isFile(fsModule, fallback)) return { cargo: fallback, fromPath: false }
  return null
}

function buildEnv(env, platform, cargoInfo) {
  const next = { ...env }
  const offlineKey = envKey(next, 'CARGO_NET_OFFLINE', platform)
  if (offlineKey) delete next[offlineKey]
  next.CARGO_NET_OFFLINE = 'true'
  if (!cargoInfo.fromPath) {
    // rustup's cargo proxy and the rustc it starts are found through PATH.
    const paths = pathApi(platform)
    const pathKey = envKey(next, 'PATH', platform) ?? 'PATH'
    next[pathKey] = [paths.dirname(cargoInfo.cargo), next[pathKey]]
      .filter(Boolean)
      .join(paths.delimiter)
  }
  return next
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function ensureDevImageWorker({
  repoRoot = process.cwd(),
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  homedir = os.homedir(),
  fsModule = fs,
  build = buildImageWorker,
  log = console.log,
  warn = console.warn
} = {}) {
  let hadOutput = false
  try {
    const overrideKey = envKey(env, SIDECAR_PATH_ENV, platform)
    if (overrideKey && env[overrideKey]?.trim()) return { status: 'env-override' }

    const paths = getImageWorkerBuildPaths({ repoRoot, platform, arch })
    const outputMtime = mtimeOrNull(fsModule, paths.outputBinaryPath)
    hadOutput = outputMtime !== null
    if (hadOutput && outputMtime >= getImageWorkerSourceMtime(paths.manifestPath, fsModule)) {
      return { status: 'up-to-date' }
    }

    const cargoInfo = findCargo({ env, platform, homedir, fsModule })
    if (!cargoInfo) {
      warn(
        hadOutput
          ? '[image-worker] 缩略图程序源码有改动，但没找到 cargo，先继续用旧版本。'
          : '[image-worker] 没找到 cargo（PATH 和 ~/.cargo/bin 里都没有），开发版缩略图会直接显示原图。\n' +
              `[image-worker] 装好 Rust 后重新 npm run dev；或设置 ${SIDECAR_PATH_ENV} 指向现成的 magicpot-image-worker。`
      )
      return { status: 'cargo-missing' }
    }

    log(
      hadOutput
        ? '[image-worker] 缩略图程序源码有改动，正在重新构建…'
        : `[image-worker] 正在首次构建开发版缩略图程序，约需 ${FIRST_BUILD_MINUTES} 分钟…`
    )
    build({
      repoRoot,
      platform,
      arch,
      env: buildEnv(env, platform, cargoInfo),
      cargo: cargoInfo.cargo
    })
    // The copy may keep cargo's link time; stamp it so the next start skips cargo.
    const now = new Date()
    fsModule.utimesSync(paths.outputBinaryPath, now, now)
    return { status: 'built' }
  } catch (error) {
    warn(
      hadOutput
        ? `[image-worker] 缩略图程序重新构建失败（${errorMessage(error)}），先继续用旧版本。`
        : `[image-worker] 开发版缩略图程序构建失败（${errorMessage(error)}），缩略图会直接显示原图。\n` +
            '[image-worker] 首次构建要下载依赖：联网后运行一次 npm run build:image-worker。'
    )
    return { status: 'failed', error }
  }
}
