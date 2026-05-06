import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveNodeTestArtifactPath, resolveNodeTestArtifactRoot } from './nodeTestArtifacts'

afterEach(() => {
  delete process.env['MAGICPOT_TEST_DESKTOP_PATH']
  delete process.env['MAGICPOT_TEST_ARTIFACT_BASE']
})

describe('nodeTestArtifacts', () => {
  it('keeps disposable node test artifacts under repo .magicpot-trash/<run-id>', () => {
    expect(resolveNodeTestArtifactRoot()).toMatch(/\.magicpot-trash[\\/][^\\/]+$/)
    expect(resolveNodeTestArtifactPath('logs', 'run.json')).toBe(
      join(resolveNodeTestArtifactRoot(), 'node-tests', 'logs', 'run.json')
    )
  })

  it('honors the standardized artifact base override for node-only test artifacts', () => {
    process.env['MAGICPOT_TEST_ARTIFACT_BASE'] = 'D:/Redirected/MagicPot'
    const root = resolveNodeTestArtifactRoot()

    expect(root).toMatch(/^D:[\\/]+Redirected[\\/]+MagicPot[\\/]+\.magicpot-trash[\\/]+[^\\/]+$/)
  })
})
