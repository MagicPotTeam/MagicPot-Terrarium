import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveNodeTestArtifactPath, resolveNodeTestArtifactRoot } from './nodeTestArtifacts'

afterEach(() => {
  delete process.env['MAGICPOT_TEST_DESKTOP_PATH']
})

describe('nodeTestArtifacts', () => {
  it('keeps disposable node test artifacts under Desktop/MagicPot-dev-trash/<run-id>', () => {
    expect(resolveNodeTestArtifactRoot()).toMatch(/MagicPot-dev-trash[\\/][^\\/]+$/)
    expect(resolveNodeTestArtifactPath('logs', 'run.json')).toBe(
      join(resolveNodeTestArtifactRoot(), 'node-tests', 'logs', 'run.json')
    )
  })

  it('honors the standardized desktop override for node-only test artifacts', () => {
    process.env['MAGICPOT_TEST_DESKTOP_PATH'] = 'D:/Redirected/Desktop'
    const root = resolveNodeTestArtifactRoot()

    expect(root).toMatch(/^D:[\\/]+Redirected[\\/]+Desktop[\\/]+MagicPot-dev-trash[\\/]+[^\\/]+$/)
  })
})
