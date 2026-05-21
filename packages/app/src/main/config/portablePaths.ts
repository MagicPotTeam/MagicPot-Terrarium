import fs from 'fs'
import path from 'path'
import { app } from 'electron'

export const USER_DATA_OVERRIDE_ENV = 'MAGICPOT_USER_DATA_DIR'
export const USER_DATA_DIRNAME = 'aiengineelectron'
export const DEV_USER_DATA_DIRNAME = '.aiengineelectron-dev'
export const USER_DATA_BOOTSTRAP_FILENAME = 'user-data-bootstrap.json'

type BootstrapLike = {
  customUserDataDir?: unknown
}

export type PortableRuntimePaths = {
  root: string
  cache: string
  home: string
  temp: string
  appData: string
  localAppData: string
  xdgCache: string
  huggingface: string
  huggingfaceHub: string
  transformers: string
  torch: string
  pip: string
  matplotlib: string
  numba: string
  gradioTemp: string
  pythonUserBase: string
  pythonPycache: string
}

function sanitizeText(text: string): string {
  return text.replace(/\uFEFF/g, '').replaceAll('\0', '')
}

function cleanPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? path.resolve(trimmed) : null
}

export function getDefaultPortableUserDataDirectory(): string {
  if (!app.isPackaged) {
    return path.join(process.cwd(), DEV_USER_DATA_DIRNAME)
  }
  return path.join(process.resourcesPath, '..', USER_DATA_DIRNAME)
}

export function getPortableUserDataBootstrapPath(): string {
  return path.join(getDefaultPortableUserDataDirectory(), USER_DATA_BOOTSTRAP_FILENAME)
}

export function readPortableBootstrapCustomUserDataDirSync(): string | null {
  const bootstrapPath = getPortableUserDataBootstrapPath()
  if (!fs.existsSync(bootstrapPath)) {
    return null
  }

  try {
    const raw = JSON.parse(sanitizeText(fs.readFileSync(bootstrapPath, 'utf8'))) as BootstrapLike
    return cleanPath(raw.customUserDataDir)
  } catch {
    return null
  }
}

export function resolveEarlyPortableUserDataDirectory(): string {
  const envOverride = cleanPath(process.env[USER_DATA_OVERRIDE_ENV])
  if (envOverride) {
    return envOverride
  }

  return readPortableBootstrapCustomUserDataDirSync() ?? getDefaultPortableUserDataDirectory()
}

export function getPortableRuntimePaths(userDataDir: string): PortableRuntimePaths {
  const root = path.join(userDataDir, 'runtime')
  const cache = path.join(root, 'cache')
  const home = path.join(root, 'home')
  const temp = path.join(root, 'temp')
  const appData = path.join(home, 'AppData', 'Roaming')
  const localAppData = path.join(home, 'AppData', 'Local')
  const huggingface = path.join(cache, 'huggingface')

  return {
    root,
    cache,
    home,
    temp,
    appData,
    localAppData,
    xdgCache: path.join(cache, 'xdg'),
    huggingface,
    huggingfaceHub: path.join(huggingface, 'hub'),
    transformers: path.join(huggingface, 'transformers'),
    torch: path.join(cache, 'torch'),
    pip: path.join(cache, 'pip'),
    matplotlib: path.join(cache, 'matplotlib'),
    numba: path.join(cache, 'numba'),
    gradioTemp: path.join(temp, 'gradio'),
    pythonUserBase: path.join(cache, 'python-userbase'),
    pythonPycache: path.join(cache, 'pycache')
  }
}

export function ensurePortableRuntimePaths(userDataDir: string): PortableRuntimePaths {
  const paths = getPortableRuntimePaths(userDataDir)
  for (const targetPath of Object.values(paths)) {
    fs.mkdirSync(targetPath, { recursive: true })
  }
  return paths
}

export function createPortablePythonEnv(
  userDataDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const paths = ensurePortableRuntimePaths(userDataDir)

  return {
    ...baseEnv,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    XDG_CACHE_HOME: paths.xdgCache,
    HF_HOME: paths.huggingface,
    HUGGINGFACE_HUB_CACHE: paths.huggingfaceHub,
    TRANSFORMERS_CACHE: paths.transformers,
    TORCH_HOME: paths.torch,
    PIP_CACHE_DIR: paths.pip,
    MPLCONFIGDIR: paths.matplotlib,
    NUMBA_CACHE_DIR: paths.numba,
    GRADIO_TEMP_DIR: paths.gradioTemp,
    PYTHONUSERBASE: paths.pythonUserBase,
    PYTHONPYCACHEPREFIX: paths.pythonPycache,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONLEGACYWINDOWSSTDIO: '1',
    PYTHONUNBUFFERED: '1'
  }
}
