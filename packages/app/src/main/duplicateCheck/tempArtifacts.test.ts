import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDuplicateCheckTempRoot } from './tempArtifacts'

const ORIGINAL_ENV = {
  MAGICPOT_TEST_AUTOMATED_RUN: process.env['MAGICPOT_TEST_AUTOMATED_RUN'],
  MAGICPOT_TEST_DESKTOP_PATH: process.env['MAGICPOT_TEST_DESKTOP_PATH'],
  MAGICPOT_TEST_RUN_ID: process.env['MAGICPOT_TEST_RUN_ID'],
  MAGICPOT_TEST_UI_MODE: process.env['MAGICPOT_TEST_UI_MODE'],
  RUN_ELECTRON_STARTUP_SMOKE: process.env['RUN_ELECTRON_STARTUP_SMOKE']
}

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
})

describe('resolveDuplicateCheckTempRoot', () => {
  it('uses desktop Codex-Junk/MagicPot/<run-id> during automated test runs', () => {
    process.env['MAGICPOT_TEST_AUTOMATED_RUN'] = '1'
    process.env['MAGICPOT_TEST_DESKTOP_PATH'] = path.join(os.homedir(), 'MagicPotDesktop')
    process.env['MAGICPOT_TEST_RUN_ID'] = 'run-123'
    delete process.env['MAGICPOT_TEST_UI_MODE']
    delete process.env['RUN_ELECTRON_STARTUP_SMOKE']

    expect(resolveDuplicateCheckTempRoot()).toBe(
      path.join(
        os.homedir(),
        'MagicPotDesktop',
        'Codex-Junk',
        'MagicPot',
        'run-123',
        'duplicate-check'
      )
    )
  })

  it('uses the system temp directory outside automated runs', () => {
    delete process.env['MAGICPOT_TEST_AUTOMATED_RUN']
    delete process.env['MAGICPOT_TEST_RUN_ID']
    delete process.env['MAGICPOT_TEST_UI_MODE']
    delete process.env['RUN_ELECTRON_STARTUP_SMOKE']

    expect(resolveDuplicateCheckTempRoot()).toBe(path.join(os.tmpdir(), 'duplicate-check'))
  })
})
