import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LauncherHealthStateV1 } from '../../app/src/main/appUpdate/launcherHealth'
import { DEFAULT_LAUNCHER_SETTINGS } from '../../app/src/main/appUpdate/launcherSettingsStore'
import type { LauncherSettingsV1 } from '../../app/src/shared/appUpdate/launcherProtocol'
import {
  UPDATE_CHANNEL_ENV,
  UPDATE_MODE_ENV,
  UPDATE_STATUS_ENV,
  UPDATE_VERSION_ENV,
  LauncherAlreadyRunningError,
  createDisabledUpdateRunner,
  createLaunchEnvironment,
  forwardedLauncherArguments,
  resolveStableLauncherRoot,
  runStableLauncher,
  updateResultEnvironment
} from './main'

const roots: string[] = []
const settings = (updateMode: LauncherSettingsV1['updateMode']): LauncherSettingsV1 => ({
  ...DEFAULT_LAUNCHER_SETTINGS,
  updateMode
})

function harness(updateMode: LauncherSettingsV1['updateMode'], events: string[] = []) {
  const recoverExpiredPending = vi.fn(async () => {
    events.push('reconcile')
    return undefined
  })
  const resolveActive = vi.fn(async () => {
    events.push('resolve')
    return {} as never
  })
  const spawnActive = vi.fn(async (_options?: { env?: NodeJS.ProcessEnv }) => {
    events.push('spawn')
    return {} as never
  })
  const readHealthState = vi.fn<() => Promise<LauncherHealthStateV1>>(async () => ({
    schema: 1,
    failedAttemptCount: 0
  }))
  return {
    recoverExpiredPending,
    resolveActive,
    spawnActive,
    readHealthState,
    options: {
      launcherRoot: path.resolve('managed'),
      env: { SAFE: '1' },
      withSessionLock: async <T>(_root: string, operation: () => Promise<T>): Promise<T> =>
        operation(),
      createSettingsStore: () => ({
        get: vi.fn(async () => {
          events.push('settings')
          return settings(updateMode)
        })
      }),
      createCore: () => ({
        recoverExpiredPending,
        resolveActive,
        spawnActive,
        readHealthState
      })
    }
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  await fs.rm(path.resolve('launcher-settings-tests'), { recursive: true, force: true })
})

describe('stable launcher entrypoint', () => {
  it('resolves roots and forwards user arguments', () => {
    expect(
      resolveStableLauncherRoot({ execPath: path.join('C:\\MagicPot', 'launcher', 'Launcher.exe') })
    ).toBe(path.resolve('C:\\MagicPot'))
    expect(() => resolveStableLauncherRoot({ launcherRoot: 'relative' })).toThrow('absolute')
    expect(forwardedLauncherArguments(['launcher.exe', '--safe-mode'])).toEqual(['--safe-mode'])
  })

  it('holds the session lock around reconciliation, settings, update, resolve, and spawn', async () => {
    const events: string[] = []
    const h = harness('auto-on-launch', events)
    const updateRunner = {
      runOnLaunch: vi.fn(async () => {
        events.push('update')
        return { status: 'installed' as const, version: '2.0.0' }
      })
    }
    await runStableLauncher({
      ...h.options,
      updateRunner,
      withSessionLock: async (root, operation) => {
        expect(root).toBe(path.join(path.resolve('managed'), '.launcher-session-lock'))
        events.push('lock:start')
        const result = await operation()
        events.push('lock:end')
        return result
      }
    })
    expect(events).toEqual([
      'lock:start',
      'reconcile',
      'settings',
      'update',
      'resolve',
      'spawn',
      'lock:end'
    ])
  })

  it('reconciles before reading settings and manual mode does not run updates', async () => {
    const events: string[] = []
    const h = harness('manual', events)
    const updateRunner = { runOnLaunch: vi.fn() }
    await runStableLauncher({ ...h.options, updateRunner })
    expect(events).toEqual(['reconcile', 'settings', 'spawn'])
    expect(updateRunner.runOnLaunch).not.toHaveBeenCalled()
    expect(h.spawnActive).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ [UPDATE_MODE_ENV]: 'manual', [UPDATE_STATUS_ENV]: 'manual' })
      })
    )
  })

  it.each([
    [
      'available',
      {
        status: 'available',
        available: {
          channel: 'stable',
          version: '2.0.0',
          buildId: '20260717-053138-c9a892c',
          runtimeId: 'comfy-win-x64-20260701',
          publishedAt: '2026-07-17T00:00:00.000Z',
          releaseNotesUrl: 'https://example.invalid'
        }
      }
    ],
    [
      'failed',
      {
        status: 'failed',
        stage: 'manifest',
        error: { name: 'Error', message: 'external secret\nstack' }
      }
    ]
  ] as const)('notify-on-launch starts current active after %s', async (_name, result) => {
    const h = harness('notify-on-launch')
    const updateRunner = { runOnLaunch: vi.fn(async () => result) }
    await runStableLauncher({ ...h.options, updateRunner })
    expect(updateRunner.runOnLaunch).toHaveBeenCalledWith(settings('notify-on-launch'))
    expect(h.resolveActive).not.toHaveBeenCalled()
    const env = h.spawnActive.mock.calls[0]![0]!.env!
    expect(env[UPDATE_STATUS_ENV]).toBe(result.status)
    expect(Object.values(env).join(' ')).not.toContain('external secret')
  })

  it('auto-on-launch resolves the newly activated version after installation', async () => {
    const h = harness('auto-on-launch')
    await runStableLauncher({
      ...h.options,
      updateRunner: {
        runOnLaunch: vi.fn(async () => ({ status: 'installed' as const, version: '2.0.0' }))
      }
    })
    expect(h.resolveActive).toHaveBeenCalledOnce()
    expect(h.spawnActive.mock.calls[0]![0]!.env).toEqual(
      expect.objectContaining({ [UPDATE_STATUS_ENV]: 'installed', [UPDATE_VERSION_ENV]: '2.0.0' })
    )
  })

  it('auto-on-launch starts the old active when update runner fails', async () => {
    const h = harness('auto-on-launch')
    await runStableLauncher({
      ...h.options,
      updateRunner: {
        runOnLaunch: vi.fn(async () => {
          throw new Error('token=secret')
        })
      }
    })
    expect(h.spawnActive).toHaveBeenCalledOnce()
    expect(h.spawnActive.mock.calls[0]![0]!.env).toEqual(
      expect.objectContaining({ [UPDATE_STATUS_ENV]: 'failed' })
    )
    expect(Object.values(h.spawnActive.mock.calls[0]![0]!.env!).join(' ')).not.toContain('secret')
  })

  it('starts rollback active selected after reconciliation', async () => {
    const events: string[] = []
    const h = harness('manual', events)
    await runStableLauncher(h.options)
    expect(events).toEqual(['reconcile', 'settings', 'spawn'])
  })

  it('rejects an unexpired pending launch without updating or spawning', async () => {
    const h = harness('auto-on-launch')
    h.readHealthState.mockResolvedValueOnce({
      schema: 1,
      failedAttemptCount: 0,
      pending: {
        buildId: 'build-1',
        runtimeId: 'runtime-1',
        launchToken: 'token-1',
        attemptCount: 1,
        startedAt: '2026-07-17T00:00:00.000Z',
        deadline: '2026-07-17T00:01:00.000Z'
      }
    })
    const updateRunner = { runOnLaunch: vi.fn() }
    await expect(runStableLauncher({ ...h.options, updateRunner })).rejects.toBeInstanceOf(
      LauncherAlreadyRunningError
    )
    expect(updateRunner.runOnLaunch).not.toHaveBeenCalled()
    expect(h.resolveActive).not.toHaveBeenCalled()
    expect(h.spawnActive).not.toHaveBeenCalled()
  })

  it('propagates synchronous spawn failure after core records it', async () => {
    const h = harness('manual')
    h.spawnActive.mockImplementationOnce(async () => {
      throw new Error('spawn failed')
    })
    await expect(runStableLauncher(h.options)).rejects.toThrow('spawn failed')
    expect(h.readHealthState).toHaveBeenCalledOnce()
  })

  it('propagates session lock waiting errors without starting the session', async () => {
    const h = harness('auto-on-launch')
    const lockError = new Error('session lock timed out')
    await expect(
      runStableLauncher({
        ...h.options,
        withSessionLock: vi.fn(async () => Promise.reject(lockError))
      })
    ).rejects.toBe(lockError)
    expect(h.recoverExpiredPending).not.toHaveBeenCalled()
    expect(h.spawnActive).not.toHaveBeenCalled()
  })

  it('recovers corrupt settings to defaults', async () => {
    const temporaryRoot = path.resolve('launcher-settings-tests')
    await fs.mkdir(temporaryRoot, { recursive: true })
    const root = await fs.mkdtemp(path.join(temporaryRoot, 'magicpot-launcher-'))
    roots.push(root)
    await fs.writeFile(path.join(root, 'settings.json'), '{broken')
    const h = harness('manual')
    const updateRunner = { runOnLaunch: vi.fn() }
    await runStableLauncher({
      ...h.options,
      launcherRoot: root,
      createSettingsStore: undefined,
      updateRunner
    })
    expect(updateRunner.runOnLaunch).not.toHaveBeenCalled()
    expect(h.spawnActive.mock.calls[0]![0]!.env?.[UPDATE_MODE_ENV]).toBe('manual')
  })

  it('default update runner is disabled and performs no network work', async () => {
    await expect(
      createDisabledUpdateRunner().runOnLaunch(settings('auto-on-launch'))
    ).resolves.toEqual({ status: 'disabled' })
    const h = harness('auto-on-launch')
    await runStableLauncher(h.options)
    expect(h.spawnActive.mock.calls[0]![0]!.env?.[UPDATE_STATUS_ENV]).toBe('disabled')
  })

  it('only exports validated update metadata', () => {
    expect(
      updateResultEnvironment(settings('notify-on-launch'), {
        status: 'installed',
        version: 'bad value\nSECRET'
      })
    ).toEqual({
      [UPDATE_MODE_ENV]: 'notify-on-launch',
      [UPDATE_STATUS_ENV]: 'installed',
      [UPDATE_CHANNEL_ENV]: 'stable'
    })
  })

  it('removes inherited update notification values before adding current validated values', () => {
    expect(
      createLaunchEnvironment(
        {
          SAFE: '1',
          [UPDATE_MODE_ENV]: 'stale-mode',
          [UPDATE_STATUS_ENV]: 'stale-status',
          [UPDATE_CHANNEL_ENV]: 'stale-channel',
          [UPDATE_VERSION_ENV]: 'stale-version'
        },
        settings('manual'),
        { status: 'manual' }
      )
    ).toEqual({
      SAFE: '1',
      [UPDATE_MODE_ENV]: 'manual',
      [UPDATE_STATUS_ENV]: 'manual',
      [UPDATE_CHANNEL_ENV]: 'stable'
    })
  })
})
