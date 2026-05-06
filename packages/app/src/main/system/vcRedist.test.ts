import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  ensureVcRedistInstalled,
  parseVcRedistInstalled,
  resolveBundledVcRedistInstaller
} from './vcRedist'

describe('vcRedist', () => {
  it('parses installed registry output', () => {
    expect(
      parseVcRedistInstalled(
        [
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
          '    Installed    REG_DWORD    0x1'
        ].join('\n')
      )
    ).toBe(true)

    expect(parseVcRedistInstalled('    Installed    REG_DWORD    0x0')).toBe(false)
  })

  it('prefers the packaged installer path and falls back to the dev path', () => {
    const appRoot = 'C:\\MagicPot'
    const packagedPath = path.join(appRoot, 'drivers', 'VC_redist.x64.exe')
    const devPath = path.join(appRoot, 'vendor', 'windows', 'VC_redist.x64.exe')

    expect(resolveBundledVcRedistInstaller(appRoot, (target) => target === packagedPath)).toBe(
      packagedPath
    )
    expect(resolveBundledVcRedistInstaller(appRoot, (target) => target === devPath)).toBe(devPath)
  })

  it('installs when the runtime is missing and an installer is bundled', async () => {
    const appRoot = 'C:\\MagicPot'
    const packagedPath = path.join(appRoot, 'drivers', 'VC_redist.x64.exe')
    const confirmInstall = vi.fn(async () => true)
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'Installed    REG_DWORD    0x0', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Installed    REG_DWORD    0x1', stderr: '' })

    const result = await ensureVcRedistInstalled(
      appRoot,
      {},
      {
        confirmInstall,
        execFile,
        existsSync: (target) => target === packagedPath,
        platform: 'win32'
      }
    )

    expect(result).toBe('installed')
    expect(confirmInstall).toHaveBeenCalledOnce()
    expect(execFile).toHaveBeenCalledTimes(3)
    expect(execFile.mock.calls[1][0]).toBe('powershell.exe')
  })

  it('does not install when the user declines the prompt', async () => {
    const appRoot = 'C:\\MagicPot'
    const packagedPath = path.join(appRoot, 'drivers', 'VC_redist.x64.exe')
    const confirmInstall = vi.fn(async () => false)
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'Installed    REG_DWORD    0x0', stderr: '' })

    const result = await ensureVcRedistInstalled(
      appRoot,
      {},
      {
        confirmInstall,
        execFile,
        existsSync: (target) => target === packagedPath,
        platform: 'win32'
      }
    )

    expect(result).toBe('declined')
    expect(confirmInstall).toHaveBeenCalledOnce()
    expect(execFile).toHaveBeenCalledTimes(1)
  })
})
