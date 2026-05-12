import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  delete process.env['MAGICPOT_TEST_DESKTOP_PATH']
  vi.resetModules()
})

describe('nodeTestArtifacts', () => {
  it('keeps disposable node test artifacts under desktop Codex-Junk/MagicPot/<run-id>', async () => {
    const { resolveNodeTestArtifactPath, resolveNodeTestArtifactRoot } =
      await import('./nodeTestArtifacts')

    expect(resolveNodeTestArtifactRoot()).toMatch(/[\\/]Codex-Junk[\\/]MagicPot[\\/]run-[^\\/]+$/)
    expect(resolveNodeTestArtifactPath('logs', 'run.json')).toBe(
      join(resolveNodeTestArtifactRoot(), 'node-tests', 'logs', 'run.json')
    )
  })

  it('honors the standardized desktop override for node-only test artifacts', async () => {
    process.env['MAGICPOT_TEST_DESKTOP_PATH'] = 'D:/Redirected/Desktop'
    const { resolveNodeTestArtifactRoot } = await import('./nodeTestArtifacts')
    const root = resolveNodeTestArtifactRoot()

    expect(root).toMatch(
      /^D:[\\/]+Redirected[\\/]+Desktop[\\/]+Codex-Junk[\\/]+MagicPot[\\/]+[^\\/]+$/
    )
  })
})
