import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LauncherSettingsV1 } from '../../shared/appUpdate/launcherProtocol'
import type { ChannelManifestV1 } from './channelManifestProtocol'
import type { ValidatedInstallation } from './launcherCore'
import { createLauncherLayout } from './launcherLayout'
import {
  LauncherUpdateCoordinator,
  type LauncherUpdateCoordinatorDependencies
} from './launcherUpdateCoordinator'
import { UpdateLockError } from './updateLock'

const buildId = '20260718-120000-abcdef0'
const runtimeId = 'runtime-1'
const root = path.resolve('launcher-update-coordinator-test')
const manifest: ChannelManifestV1 = {
  schema: 1,
  channel: 'stable',
  generatedAt: '2026-07-18T12:00:00Z',
  releases: [
    {
      version: '2.0.0',
      buildId,
      commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
      publishedAt: '2026-07-18T12:00:00Z',
      releaseNotesUrl:
        'https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/tag/v2.0.0',
      minimumLauncherVersion: '1.0.0',
      artifacts: {
        app: {
          kind: 'app',
          version: '2.0.0',
          buildId,
          commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
          runtimeId,
          platform: 'win32',
          arch: 'x64',
          url: 'https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/v2/app.zip',
          sha256: 'a'.repeat(64),
          size: 10,
          unpackedSize: 20,
          entrypoint: 'MagicPot.exe',
          createdAt: '2026-07-18T12:00:00Z'
        },
        runtime: {
          kind: 'runtime',
          runtimeId,
          platform: 'win32',
          arch: 'x64',
          url: 'https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/v2/runtime.zip',
          sha256: 'b'.repeat(64),
          size: 30,
          unpackedSize: 40,
          entrypoint: 'python.exe',
          createdAt: '2026-07-18T12:00:00Z'
        }
      }
    }
  ],
  signature: { algorithm: 'ed25519', keyId: 'release-key', value: 'A'.repeat(88) }
}
const installation = {
  app: { buildId, runtimeId, version: '2.0.0' },
  runtime: { runtimeId }
} as ValidatedInstallation

function settings(updateMode: LauncherSettingsV1['updateMode']): LauncherSettingsV1 {
  return {
    schema: 1,
    updateMode,
    channel: 'stable',
    retainAppVersions: 3,
    retainNightlyVersions: 3,
    allowPrerelease: false
  }
}
function fixture(overrides: Partial<LauncherUpdateCoordinatorDependencies> = {}) {
  const fetchManifest = vi.fn(async () => manifest)
  const downloadArtifact = vi.fn(async (artifact: { kind: string }) => ({
    path: path.join(root, `${artifact.kind}.staging`)
  }))
  const installDirectory = vi.fn(async (options: { kind: string }) => ({
    destination: path.join(root, options.kind),
    manifest: installation.app,
    installed: true
  }))
  const smokeTest = vi.fn(async () => undefined)
  const activate = vi.fn(async () => undefined)
  const validateBuild = vi.fn(async () => installation)
  const getActive = vi.fn(async () => null)
  const all: LauncherUpdateCoordinatorDependencies = {
    fetchManifest,
    core: {
      layout: createLauncherLayout(root),
      validateBuild,
      validateRuntime: vi.fn(async () => null),
      getActive,
      activate
    },
    downloadArtifact,
    prepareArtifact: vi.fn(async ({ downloadedPath }) => downloadedPath),
    installDirectory: installDirectory as LauncherUpdateCoordinatorDependencies['installDirectory'],
    smokeTest,
    withLock: vi.fn(async (_root, operation) => operation()),
    isRuntimeInstalled: vi.fn(async () => false),
    launcherVersion: '1.0.0',
    ...overrides
  }
  return { all, fetchManifest, downloadArtifact, smokeTest, activate }
}

describe('LauncherUpdateCoordinator', () => {
  it('does not access the network in manual mode', async () => {
    const f = fixture()
    expect(await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('manual'))).toEqual({
      status: 'manual'
    })
    expect(f.fetchManifest).not.toHaveBeenCalled()
  })
  it('reports availability without downloading in notify mode', async () => {
    const f = fixture()
    expect(
      (await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('notify-on-launch'))).status
    ).toBe('available')
    expect(f.downloadArtifact).not.toHaveBeenCalled()
  })
  it('prepares runtime before app and activates an auto update', async () => {
    const f = fixture()
    expect(
      (await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('auto-on-launch'))).status
    ).toBe('activated')
    expect(f.downloadArtifact.mock.calls.map(([artifact]) => artifact.kind)).toEqual([
      'runtime',
      'app'
    ])
    expect(f.smokeTest).toHaveBeenCalledWith(installation)
    expect(f.activate).toHaveBeenCalledWith(buildId, runtimeId)
  })
  it('cleans owned staging directories after successful installs', async () => {
    const cleanup = vi.fn(async () => undefined)
    const f = fixture({
      prepareArtifact: vi.fn(async ({ downloadedPath }) => ({
        sourceDirectory: downloadedPath,
        cleanup
      }))
    })
    expect(
      (await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('auto-on-launch'))).status
    ).toBe('activated')
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('cleans owned staging after install failure without deleting legacy injected sources', async () => {
    const cleanup = vi.fn(async () => undefined)
    const failing = fixture({
      prepareArtifact: vi.fn(async ({ downloadedPath }) => ({
        sourceDirectory: downloadedPath,
        cleanup
      })),
      installDirectory: vi.fn(async () => Promise.reject(new Error('install')))
    })
    expect(
      await new LauncherUpdateCoordinator(failing.all).runOnLaunch(settings('auto-on-launch'))
    ).toMatchObject({ status: 'failed', stage: 'install' })
    expect(cleanup).toHaveBeenCalledTimes(1)

    const failingCleanup = fixture({
      prepareArtifact: vi.fn(async ({ downloadedPath }) => ({
        sourceDirectory: downloadedPath,
        cleanup: vi.fn(async () => Promise.reject(new Error('cleanup')))
      })),
      installDirectory: vi.fn(async () => Promise.reject(new Error('install-primary')))
    })
    expect(
      await new LauncherUpdateCoordinator(failingCleanup.all).runOnLaunch(
        settings('auto-on-launch')
      )
    ).toMatchObject({ status: 'failed', stage: 'install', error: { message: 'install-primary' } })

    const legacy = fixture({
      installDirectory: vi.fn(async () => Promise.reject(new Error('install')))
    })
    expect(
      await new LauncherUpdateCoordinator(legacy.all).runOnLaunch(settings('auto-on-launch'))
    ).toMatchObject({ status: 'failed', stage: 'install' })
  })

  it('reuses an installed runtime', async () => {
    const f = fixture({ isRuntimeInstalled: vi.fn(async () => true) })
    expect(
      await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('auto-on-launch'))
    ).toMatchObject({ status: 'activated', runtimeReused: true })
    expect(f.downloadArtifact.mock.calls.map(([artifact]) => artifact.kind)).toEqual(['app'])
  })
  it.each([
    ['download', { downloadArtifact: vi.fn(async () => Promise.reject(new Error('download'))) }],
    ['install', { installDirectory: vi.fn(async () => Promise.reject(new Error('install'))) }],
    ['smoke-test', { smokeTest: vi.fn(async () => Promise.reject(new Error('smoke'))) }]
  ] as const)('does not activate after a %s failure', async (stage, override) => {
    const f = fixture(override as Partial<LauncherUpdateCoordinatorDependencies>)
    expect(
      await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('auto-on-launch'))
    ).toMatchObject({ status: 'failed', stage })
    expect(f.activate).not.toHaveBeenCalled()
  })
  it('does not treat an inactive preinstalled target as up-to-date', async () => {
    const f = fixture({
      core: {
        layout: createLauncherLayout(root),
        validateBuild: vi.fn(async () => installation),
        validateRuntime: vi.fn(async () => installation.runtime),
        getActive: vi.fn(
          async () =>
            ({
              ...installation,
              app: { ...installation.app, buildId: '20260717-120000-abcdef0', version: '1.0.0' }
            }) as never
        ),
        activate: vi.fn(async () => undefined)
      }
    })
    expect(
      (await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('auto-on-launch'))).status
    ).toBe('activated')
  })

  it('uses the built-in preparer when no override is configured', async () => {
    const f = fixture({ prepareArtifact: undefined })
    expect(
      await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('auto-on-launch'))
    ).toMatchObject({
      status: 'failed',
      stage: 'prepare',
      error: { name: 'Error' }
    })
    expect(f.downloadArtifact).toHaveBeenCalledTimes(1)
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('rechecks the active pair after acquiring the lock', async () => {
    const f = fixture()
    const active = { ...installation, app: { ...installation.app, version: '2.0.0' } } as never
    f.all.core.getActive = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(active)
    expect(
      await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('auto-on-launch'))
    ).toMatchObject({ status: 'up-to-date' })
    expect(f.downloadArtifact).not.toHaveBeenCalled()
  })

  it('filters prereleases and releases requiring a newer launcher', async () => {
    const prereleaseManifest = structuredClone(manifest)
    prereleaseManifest.releases[0].version = '3.0.0-beta.1'
    prereleaseManifest.releases[0].artifacts.app.version = '3.0.0-beta.1'
    const prerelease = fixture({ fetchManifest: vi.fn(async () => prereleaseManifest) })
    expect(
      await new LauncherUpdateCoordinator(prerelease.all).runOnLaunch(settings('notify-on-launch'))
    ).toMatchObject({ status: 'failed', stage: 'selection' })

    const incompatibleManifest = structuredClone(manifest)
    incompatibleManifest.releases[0].minimumLauncherVersion = '2.0.0'
    const incompatible = fixture({ fetchManifest: vi.fn(async () => incompatibleManifest) })
    expect(
      await new LauncherUpdateCoordinator(incompatible.all).runOnLaunch(
        settings('notify-on-launch')
      )
    ).toMatchObject({ status: 'failed', stage: 'selection' })
  })

  it('does not downgrade the active app', async () => {
    const f = fixture()
    f.all.core.getActive = vi.fn(
      async () =>
        ({
          ...installation,
          app: { ...installation.app, version: '3.0.0' }
        }) as never
    )
    expect(
      await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('auto-on-launch'))
    ).toMatchObject({ status: 'up-to-date' })
    expect(f.downloadArtifact).not.toHaveBeenCalled()
  })

  it('returns a structured lock conflict', async () => {
    const f = fixture({ withLock: vi.fn(async () => Promise.reject(new UpdateLockError('held'))) })
    expect(
      await new LauncherUpdateCoordinator(f.all).runOnLaunch(settings('auto-on-launch'))
    ).toMatchObject({ status: 'locked', stage: 'lock', error: { message: 'held' } })
    expect(f.activate).not.toHaveBeenCalled()
  })
})
