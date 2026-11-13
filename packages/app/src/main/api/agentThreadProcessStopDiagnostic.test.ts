import { spawn } from 'node:child_process'
import path from 'node:path'
import { it, expect, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
it.skipIf(process.platform !== 'win32' || !process.env.MAGICPOT_TEST_SHELL)('confirms immediate native-helper termination independently of the thread policy host', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helper-diagnostic-'))
  const helper = path.resolve('packages/runtime-assets/resources/bin/magicpot-command-job/magicpot-command-job.exe')
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec']) if (process.env[key]) env[key] = process.env[key]
  const args = process.env.MAGICPOT_TEST_SHELL_KIND === 'bash'
    ? ['--noprofile', '--norc', '-c', 'sleep 8; printf BAD']
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 8; [Console]::WriteLine("BAD")']
  const child = spawn(helper, ['536870912', '60000', '-', '--', process.env.MAGICPOT_TEST_SHELL!, ...args], { cwd: root, env, shell: false, detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let closed = false, exit = false, killerCode: number | null = null
  child.stdout.on('data', () => undefined); child.stderr.on('data', () => undefined)
  child.once('exit', () => { exit = true }); child.once('close', () => { closed = true })
  child.unref()
  const killed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => queueMicrotask(() => {
      const killer = spawn(path.join(process.env.SystemRoot!, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      killer.once('error', reject); killer.once('close', (code) => { killerCode = code; resolve() })
    }))
  })
  try { await killed; await vi.waitFor(() => expect({ closed, exit, killerCode, stdout: child.stdout.readableEnded, stderr: child.stderr.readableEnded }).toMatchObject({ closed: true, killerCode: 0 }), { timeout: 4000 }) }
  finally { if (!closed) child.kill(); rmSync(root, { recursive: true, force: true }) }
}, 15000)
