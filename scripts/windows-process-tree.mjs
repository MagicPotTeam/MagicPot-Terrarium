import { execFileSync } from 'node:child_process'

export function killWindowsProcessTree(pid, execFile = execFileSync) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    return true
  } catch {
    // The process may already have exited. Shutdown cleanup is best effort.
    return false
  }
}
