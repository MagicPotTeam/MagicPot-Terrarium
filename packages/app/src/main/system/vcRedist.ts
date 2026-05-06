import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const VC_REDIST_INSTALLER_NAME = 'VC_redist.x64.exe'
const VC_RUNTIME_REG_KEY = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'

type ExecFileResult = {
  stdout: string
  stderr: string
}

type ExecFileFn = (
  file: string,
  args: string[],
  options?: { timeout?: number; windowsHide?: boolean }
) => Promise<ExecFileResult>

export type VcRedistLogger = {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export type VcRedistDeps = {
  execFile?: ExecFileFn
  existsSync?: (targetPath: string) => boolean
  confirmInstall?: (installerPath: string) => Promise<boolean>
  platform?: NodeJS.Platform
}

export type VcRedistEnsureResult =
  | 'not-windows'
  | 'already-installed'
  | 'installer-missing'
  | 'declined'
  | 'installed'
  | 'installed-not-detected'

function defaultExecFile(
  file: string,
  args: string[],
  options?: { timeout?: number; windowsHide?: boolean }
): Promise<ExecFileResult> {
  return execFileAsync(file, args, {
    timeout: options?.timeout,
    windowsHide: options?.windowsHide
  }) as Promise<ExecFileResult>
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function parseVcRedistInstalled(stdout: string): boolean {
  return /Installed\s+REG_DWORD\s+0x1/i.test(stdout)
}

export async function isVcRedistInstalled(deps: VcRedistDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return true
  }

  const run = deps.execFile ?? defaultExecFile
  try {
    const result = await run('reg', ['query', VC_RUNTIME_REG_KEY, '/v', 'Installed', '/reg:64'], {
      timeout: 10000,
      windowsHide: true
    })
    return parseVcRedistInstalled(result.stdout)
  } catch {
    return false
  }
}

export function resolveBundledVcRedistInstaller(
  appRoot: string,
  existsSync: (targetPath: string) => boolean = fs.existsSync
): string | null {
  const candidates = [
    path.join(appRoot, 'drivers', VC_REDIST_INSTALLER_NAME),
    path.join(appRoot, 'vendor', 'windows', VC_REDIST_INSTALLER_NAME)
  ]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export async function runVcRedistInstaller(
  installerPath: string,
  deps: VcRedistDeps = {}
): Promise<void> {
  const run = deps.execFile ?? defaultExecFile
  const script = [
    `$installer = ${quotePowerShellSingle(installerPath)}`,
    `$p = Start-Process -FilePath $installer -ArgumentList '/install /quiet /norestart' -Wait -Verb RunAs -PassThru`,
    `if ($null -ne $p.ExitCode) { exit $p.ExitCode }`
  ].join('; ')

  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeout: 300000,
    windowsHide: true
  })
}

export async function ensureVcRedistInstalled(
  appRoot: string,
  logger: VcRedistLogger = {},
  deps: VcRedistDeps = {}
): Promise<VcRedistEnsureResult> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return 'not-windows'
  }

  if (await isVcRedistInstalled(deps)) {
    return 'already-installed'
  }

  const installerPath = resolveBundledVcRedistInstaller(appRoot, deps.existsSync ?? fs.existsSync)
  if (!installerPath) {
    logger.warn?.('VC++ Redistributable x64 is not installed and bundled installer is missing')
    return 'installer-missing'
  }

  if (deps.confirmInstall) {
    const approved = await deps.confirmInstall(installerPath)
    if (!approved) {
      logger.warn?.('VC++ Redistributable x64 installation was cancelled by the user')
      return 'declined'
    }
  }

  logger.info?.('VC++ Redistributable x64 is missing; launching bundled installer')
  await runVcRedistInstaller(installerPath, deps)

  if (await isVcRedistInstalled(deps)) {
    logger.info?.('VC++ Redistributable x64 installed')
    return 'installed'
  }

  logger.warn?.('VC++ Redistributable x64 installer finished but registry check still failed')
  return 'installed-not-detected'
}
