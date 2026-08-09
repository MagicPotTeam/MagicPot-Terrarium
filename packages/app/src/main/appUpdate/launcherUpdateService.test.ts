import { describe, expect, it, vi } from 'vitest'
import type { LauncherSettingsV1 } from '../../shared/appUpdate/launcherProtocol'
import type { LaunchSelection, ValidatedInstallation } from './launcherCore'
import type { LauncherUpdateAvailable, LauncherUpdateResult } from './launcherUpdateCoordinator'
import { createLauncherUpdateService } from './launcherUpdateService'

const settings: LauncherSettingsV1 = {
  schema: 1,
  updateMode: 'notify-on-launch',
  channel: 'stable',
  retainAppVersions: 3,
  retainNightlyVersions: 3,
  allowPrerelease: false
}
const available: LauncherUpdateAvailable = {
  channel: 'stable',
  version: '2.0.0',
  buildId: '20260717-053138-c9a892c',
  runtimeId: 'python-3.12.4',
  publishedAt: '2026-07-17T05:31:38Z',
  releaseNotesUrl: 'https://updates.example/release'
}
const installation = {
  app: { version: '1.0.0', buildId: '20260716-050000-b7c8d9e' },
  runtime: { runtimeId: 'python-3.12.3' }
} as ValidatedInstallation
const active = { ...installation, source: 'active' } as LaunchSelection

function serviceFor(result: LauncherUpdateResult | Promise<LauncherUpdateResult>) {
  const runOnLaunch = vi.fn().mockImplementation(() => Promise.resolve(result))
  return {
    runOnLaunch,
    service: createLauncherUpdateService({
      coordinator: { runOnLaunch },
      getSettings: async () => settings,
      getActive: async () => active,
      now: () => new Date('2026-08-01T00:00:00Z')
    })
  }
}

describe('LauncherUpdateService', () => {
  it.each([
    [{ status: 'manual' }, 'up-to-date'],
    [{ status: 'up-to-date', channel: 'stable' }, 'up-to-date'],
    [{ status: 'available', available }, 'available'],
    [{ status: 'activated', available, runtimeReused: true, installation }, 'ready'],
    [
      { status: 'locked', stage: 'lock', error: { name: 'LockError', message: 'busy' }, available },
      'error'
    ],
    [
      {
        status: 'failed',
        stage: 'download',
        error: { name: 'Error', message: 'failed' },
        available
      },
      'error'
    ]
  ] as const)('maps coordinator result %# to %s', async (result, phase) => {
    const { service } = serviceFor(result as LauncherUpdateResult)
    await expect(service.check('launch')).resolves.toMatchObject({ phase })
  })

  it('uses a notify-only coordinator run for a manual check when automatic mode is disabled', async () => {
    const runOnLaunch = vi.fn().mockResolvedValue({ status: 'up-to-date', channel: 'stable' })
    const service = createLauncherUpdateService({
      coordinator: { runOnLaunch },
      getSettings: async () => ({ ...settings, updateMode: 'manual' }),
      getActive: async () => active
    })
    await service.check('manual')
    expect(runOnLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ updateMode: 'notify-on-launch' })
    )
  })

  it('normalizes thrown errors without exposing arbitrary object fields', async () => {
    const service = createLauncherUpdateService({
      coordinator: { runOnLaunch: vi.fn().mockRejectedValue({ token: 'secret' }) },
      getSettings: async () => settings,
      getActive: async () => active
    })
    const status = await service.check('launch')
    expect(status).toMatchObject({ phase: 'error', message: 'Launcher update failed' })
    expect(JSON.stringify(status)).not.toContain('secret')
  })

  it('isolates listener failures and supports unsubscribe', async () => {
    const { service } = serviceFor({ status: 'available', available })
    const listener = vi.fn()
    service.subscribe(() => {
      throw new Error('listener failed')
    })
    const unsubscribe = service.subscribe(listener)
    await service.check('launch')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    await service.check('launch')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight coordinator run across concurrent checks', async () => {
    let resolve!: (result: LauncherUpdateResult) => void
    const deferred = new Promise<LauncherUpdateResult>((done) => (resolve = done))
    const { service, runOnLaunch } = serviceFor(deferred)
    const first = service.check('launch')
    const second = service.check('manual')
    expect(second).toBe(first)
    resolve({ status: 'available', available })
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ phase: 'available' }),
      expect.objectContaining({ phase: 'available' })
    ])
    expect(runOnLaunch).toHaveBeenCalledTimes(1)
  })
})
