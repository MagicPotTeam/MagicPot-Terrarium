import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import { vol } from 'memfs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ActivePointerV1,
  InstalledAppManifestV1,
  InstalledRuntimeManifestV1
} from '../../shared/appUpdate/launcherProtocol'
import {
  LauncherCoreError,
  LocalLauncherCore,
  selectLaunchInstallation,
  spawnSelectedApp,
  validateInstalledPair,
  type LauncherCoreFileSystem
} from './launcherCore'
import { createLauncherLayout, resolveInstalledPath } from './launcherLayout'

const root = '/launcher'
const build1 = '20260717-053138-c9a892c'
const build2 = '20260718-063138-a1b2c3d'
const runtime1 = 'python-3.12.1'
const runtime2 = 'python-3.13.0'
const commit1 = `c9a892c${'0'.repeat(33)}`
const commit2 = `a1b2c3d${'0'.repeat(33)}`
const fileSystem = vol.promises as unknown as LauncherCoreFileSystem

function appManifest(
  buildId = build1,
  runtimeId = runtime1,
  createdAt = '2026-07-17T05:31:38Z'
): InstalledAppManifestV1 {
  return {
    schema: 1,
    kind: 'magicpot-app',
    version: '1.0.0',
    buildId,
    commitSha: buildId === build1 ? commit1 : commit2,
    platform: 'win32',
    arch: 'x64',
    runtimeId,
    entrypoint: 'MagicPot.exe',
    createdAt,
    unpackedSize: 100
  }
}

function runtimeManifest(
  runtimeId = runtime1,
  createdAt = '2026-07-17T05:00:00Z'
): InstalledRuntimeManifestV1 {
  return {
    schema: 1,
    kind: 'magicpot-runtime',
    runtimeId,
    platform: 'win32',
    arch: 'x64',
    createdAt,
    entrypoints: { python: 'python.exe', comfyui: 'ComfyUI/main.py' },
    unpackedSize: 100
  }
}

function pointer(activeBuildId = build1, activeRuntimeId = runtime1): ActivePointerV1 {
  return {
    schema: 1,
    activeBuildId,
    activeRuntimeId,
    activatedAt: '2026-07-18T07:00:00Z'
  }
}

function install(
  app = appManifest(),
  runtime = runtimeManifest(app.runtimeId),
  files = true
): void {
  const appDirectory = path.join(root, 'apps', app.buildId)
  const runtimeDirectory = path.join(root, 'runtimes', runtime.runtimeId)
  vol.mkdirSync(path.join(runtimeDirectory, 'ComfyUI'), { recursive: true })
  vol.mkdirSync(appDirectory, { recursive: true })
  vol.writeFileSync(path.join(appDirectory, 'manifest.json'), JSON.stringify(app))
  vol.writeFileSync(path.join(runtimeDirectory, 'manifest.json'), JSON.stringify(runtime))
  if (files) {
    vol.writeFileSync(path.join(appDirectory, app.entrypoint), '')
    vol.writeFileSync(path.join(runtimeDirectory, runtime.entrypoints.python), '')
    vol.writeFileSync(path.join(runtimeDirectory, runtime.entrypoints.comfyui), '')
  }
}

beforeEach(() => vol.reset())

describe('launcher layout', () => {
  it('requires an absolute root and rejects unsafe relative paths', () => {
    expect(() => createLauncherLayout('relative')).toThrow('absolute')
    expect(() => resolveInstalledPath('/app', '../outside.exe')).toThrow('Invalid')
    expect(resolveInstalledPath('/app', 'bin/MagicPot.exe')).toBe(
      path.resolve('/app/bin/MagicPot.exe')
    )
  })
})

describe('LocalLauncherCore activation', () => {
  it('validates and atomically activates an exact pair while retaining previous', async () => {
    install()
    install(appManifest(build2, runtime2), runtimeManifest(runtime2))
    vol.writeFileSync(path.join(root, 'active.json'), JSON.stringify(pointer()))
    vol.writeFileSync(
      path.join(root, 'launcher-health.json'),
      JSON.stringify({
        schema: 1,
        consecutiveFailures: 0,
        pending: {
          buildId: build1,
          runtimeId: runtime1,
          launchToken: 'token',
          deadline: '2026-07-20T00:00:00Z'
        }
      })
    )
    const core = new LocalLauncherCore(createLauncherLayout(root), fileSystem, {
      now: () => new Date('2026-07-19T00:00:00Z')
    })

    await expect(core.activate(build2, runtime2)).resolves.toMatchObject({
      app: { buildId: build2 },
      runtime: { runtimeId: runtime2 }
    })
    expect(
      JSON.parse(vol.readFileSync(path.join(root, 'active.json'), 'utf8') as string)
    ).toMatchObject({
      activeBuildId: build2,
      activeRuntimeId: runtime2,
      previousBuildId: build1,
      previousRuntimeId: runtime1
    })
    expect(
      JSON.parse(vol.readFileSync(path.join(root, 'launcher-health.json'), 'utf8') as string)
        .pending
    ).toBeUndefined()
    await expect(core.activate(build2, runtime1)).rejects.toThrow()
    await expect(core.getActive()).resolves.toMatchObject({ app: { buildId: build2 } })
    await expect(core.validateRuntime(runtime2)).resolves.toMatchObject({ runtimeId: runtime2 })
    expect(vol.existsSync(path.join(root, 'activation-journal.json'))).toBe(false)
  })

  it('recovers after active save when health reset fails and preserves previous', async () => {
    install()
    install(appManifest(build2, runtime2), runtimeManifest(runtime2))
    vol.writeFileSync(path.join(root, 'active.json'), JSON.stringify(pointer()))
    const healthPath = path.join(root, 'launcher-health.json')
    vol.writeFileSync(healthPath, JSON.stringify({ schema: 1, failedAttemptCount: 2 }))
    let failHealthRename = true
    const failingFileSystem: LauncherCoreFileSystem = {
      ...fileSystem,
      rename: async (oldPath, newPath) => {
        if (failHealthRename && newPath === healthPath) {
          failHealthRename = false
          throw new Error('injected health reset failure')
        }
        await fileSystem.rename(oldPath, newPath)
      }
    }
    const layout = createLauncherLayout(root)
    const core = new LocalLauncherCore(layout, failingFileSystem, {
      now: () => new Date('2026-07-19T00:00:00Z')
    })

    await expect(core.activate(build2, runtime2)).rejects.toThrow('injected health reset failure')
    expect(vol.existsSync(layout.activationJournal)).toBe(true)
    expect(JSON.parse(vol.readFileSync(layout.activePointer, 'utf8') as string)).toMatchObject({
      activeBuildId: build2,
      previousBuildId: build1
    })

    const restarted = new LocalLauncherCore(layout, fileSystem)
    await expect(restarted.getActive()).resolves.toMatchObject({
      pointer: { activeBuildId: build2, previousBuildId: build1 }
    })
    expect(JSON.parse(vol.readFileSync(healthPath, 'utf8') as string)).toEqual({
      schema: 1,
      failedAttemptCount: 0
    })
    expect(vol.existsSync(layout.activationJournal)).toBe(false)
    await expect(restarted.getActive()).resolves.toMatchObject({ app: { buildId: build2 } })
  })

  it('clears a prepared journal when active is still from', async () => {
    install()
    install(appManifest(build2, runtime2), runtimeManifest(runtime2))
    const layout = createLauncherLayout(root)
    const from = pointer()
    const to = {
      ...pointer(build2, runtime2),
      previousBuildId: build1,
      previousRuntimeId: runtime1
    }
    vol.writeFileSync(layout.activePointer, JSON.stringify(from))
    vol.writeFileSync(
      layout.activationJournal,
      JSON.stringify({
        schema: 1,
        phase: 'prepared',
        createdAt: '2026-07-19T00:00:00.000Z',
        from,
        to
      })
    )

    const core = new LocalLauncherCore(layout, fileSystem)
    await expect(core.getActive()).resolves.toMatchObject({ app: { buildId: build1 } })
    expect(vol.existsSync(layout.activationJournal)).toBe(false)
  })

  it('rejects an active pointer inconsistent with the journal', async () => {
    install()
    install(appManifest(build2, runtime2), runtimeManifest(runtime2))
    const layout = createLauncherLayout(root)
    vol.writeFileSync(layout.activePointer, JSON.stringify(pointer(build2, runtime2)))
    vol.writeFileSync(
      layout.activationJournal,
      JSON.stringify({
        schema: 1,
        phase: 'prepared',
        createdAt: '2026-07-19T00:00:00.000Z',
        from: pointer(),
        to: { ...pointer(build2, runtime2), previousBuildId: build1, previousRuntimeId: runtime1 }
      })
    )

    const core = new LocalLauncherCore(layout, fileSystem)
    await expect(core.getActive()).rejects.toThrow('inconsistent')
    expect(vol.existsSync(layout.activationJournal)).toBe(true)
  })
})

describe('local installation selection', () => {
  it('uses a valid active pointer', async () => {
    install()
    vol.writeFileSync(path.join(root, 'active.json'), JSON.stringify(pointer()))
    await expect(selectLaunchInstallation(root, fileSystem)).resolves.toMatchObject({
      source: 'active',
      app: { buildId: build1 },
      runtime: { runtimeId: runtime1 }
    })
  })

  it('recovers from a corrupt active pointer using installed versions', async () => {
    install()
    vol.writeFileSync(path.join(root, 'active.json'), '{broken')
    await expect(selectLaunchInstallation(root, fileSystem)).resolves.toMatchObject({
      source: 'installed',
      app: { buildId: build1 }
    })
  })

  it('falls back to previous when active points to an invalid installation', async () => {
    install()
    const value = {
      ...pointer(build2, runtime2),
      previousBuildId: build1,
      previousRuntimeId: runtime1
    }
    vol.mkdirSync(root, { recursive: true })
    vol.writeFileSync(path.join(root, 'active.json'), JSON.stringify(value))
    await expect(selectLaunchInstallation(root, fileSystem)).resolves.toMatchObject({
      source: 'previous',
      app: { buildId: build1 }
    })
  })

  it('selects the newest valid combination by app createdAt', async () => {
    install(appManifest(build1, runtime1, '2026-07-19T00:00:00Z'))
    install(appManifest(build2, runtime2, '2026-07-20T00:00:00Z'), runtimeManifest(runtime2))
    vol.unlinkSync(path.join(root, 'apps', build2, 'MagicPot.exe'))
    await expect(selectLaunchInstallation(root, fileSystem)).resolves.toMatchObject({
      source: 'installed',
      app: { buildId: build1 }
    })
    vol.writeFileSync(path.join(root, 'apps', build2, 'MagicPot.exe'), '')
    await expect(selectLaunchInstallation(root, fileSystem)).resolves.toMatchObject({
      app: { buildId: build2 }
    })
  })

  it('reports when no valid version is available', async () => {
    await expect(selectLaunchInstallation(root, fileSystem)).rejects.toThrow(
      'No valid installed app/runtime combination'
    )
  })

  it('rejects manifest identity mismatches', async () => {
    install()
    const wrong = appManifest(build2, runtime1)
    vol.writeFileSync(path.join(root, 'apps', build1, 'manifest.json'), JSON.stringify(wrong))
    await expect(
      validateInstalledPair(createLauncherLayout(root), build1, runtime1, fileSystem)
    ).rejects.toThrow()
  })

  it('rejects missing entrypoints', async () => {
    install(appManifest(), runtimeManifest(), false)
    await expect(
      validateInstalledPair(createLauncherLayout(root), build1, runtime1, fileSystem)
    ).rejects.toThrow()
  })

  it('rejects redirected managed roots, including Windows junction-style link stats', async () => {
    install()
    const redirectedFs: LauncherCoreFileSystem = {
      ...fileSystem,
      readFile: fileSystem.readFile.bind(fileSystem),
      readdir: fileSystem.readdir.bind(fileSystem),
      realpath: fileSystem.realpath.bind(fileSystem),
      lstat: async (target) => {
        if (target === path.join(root, 'runtimes'))
          return {
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => true,
            size: 0
          }
        return fileSystem.lstat(target)
      }
    }
    await expect(
      validateInstalledPair(createLauncherLayout(root), build1, runtime1, redirectedFs)
    ).rejects.toThrow('Managed runtimes root is not a real directory')
  })

  it('rejects symlink manifests', async () => {
    install()
    const manifestPath = path.join(root, 'apps', build1, 'manifest.json')
    vol.mkdirSync('/outside', { recursive: true })
    vol.writeFileSync('/outside/manifest.json', vol.readFileSync(manifestPath))
    vol.unlinkSync(manifestPath)
    vol.symlinkSync('/outside/manifest.json', manifestPath)
    await expect(
      validateInstalledPair(createLauncherLayout(root), build1, runtime1, fileSystem)
    ).rejects.toThrow('App manifest is not a regular file')
  })

  it('rejects symlink entrypoints and realpath escapes', async () => {
    install()
    vol.mkdirSync('/outside', { recursive: true })
    vol.writeFileSync('/outside/evil.exe', '')
    vol.unlinkSync(path.join(root, 'apps', build1, 'MagicPot.exe'))
    vol.symlinkSync('/outside/evil.exe', path.join(root, 'apps', build1, 'MagicPot.exe'))
    await expect(
      validateInstalledPair(createLauncherLayout(root), build1, runtime1, fileSystem)
    ).rejects.toThrow(LauncherCoreError)

    vol.reset()
    install()
    const escapingFs: LauncherCoreFileSystem = {
      ...fileSystem,
      realpath: async (target) =>
        target.endsWith('MagicPot.exe') ? '/outside/evil.exe' : fileSystem.realpath(target)
    }
    await expect(
      validateInstalledPair(createLauncherLayout(root), build1, runtime1, escapingFs)
    ).rejects.toThrow('escapes')
  })
})

describe('safe spawn', () => {
  it('revalidates and spawns the direct executable with explicit cwd, env and shell disabled', async () => {
    install()
    const spawn = vi.fn(() => ({}) as ChildProcess)
    const verified = await validateInstalledPair(
      createLauncherLayout(root),
      build1,
      runtime1,
      fileSystem
    )
    const selected = {
      app: appManifest(),
      runtime: runtimeManifest(),
      appDirectory: path.join(root, 'apps', build1),
      runtimeDirectory: path.join(root, 'runtimes', runtime1),
      appEntrypoint: path.join(root, 'apps', build1, 'MagicPot.exe'),
      pythonEntrypoint: path.join(root, 'runtimes', runtime1, 'python.exe'),
      comfyuiEntrypoint: path.join(root, 'runtimes', runtime1, 'ComfyUI', 'main.py')
    }
    const launcher = new LocalLauncherCore(createLauncherLayout(root), fileSystem)
    await spawnSelectedApp(launcher, selected, {
      args: ['--safe'],
      env: { TEST_ONLY: '1' },
      spawn
    })
    expect(spawn).toHaveBeenCalledWith(verified!.appEntrypoint, ['--safe'], {
      shell: false,
      cwd: verified!.appDirectory,
      env: { TEST_ONLY: '1' },
      windowsHide: true
    })
  })

  it('spawns only the canonical entrypoint and cwd returned by revalidation', async () => {
    install()
    const launcher = new LocalLauncherCore(createLauncherLayout(root), fileSystem)
    const verified = await launcher.validateBuild(build1)
    expect(verified).not.toBeNull()
    const selected = {
      ...verified!,
      appDirectory: '/attacker/cwd',
      appEntrypoint: '/attacker/MagicPot.exe'
    }
    const spawn = vi.fn(() => ({}) as ChildProcess)

    await spawnSelectedApp(launcher, selected, { spawn })

    expect(spawn).toHaveBeenCalledWith(verified!.appEntrypoint, [], {
      shell: false,
      cwd: verified!.appDirectory,
      env: { ...process.env },
      windowsHide: true
    })
  })

  it('rechecks the canonical entrypoint immediately before spawn', async () => {
    install()
    let redirectEntrypoint = false
    const changingFs: LauncherCoreFileSystem = {
      ...fileSystem,
      readFile: fileSystem.readFile.bind(fileSystem),
      readdir: fileSystem.readdir.bind(fileSystem),
      lstat: fileSystem.lstat.bind(fileSystem),
      realpath: async (target) => {
        if (target.endsWith('MagicPot.exe') && redirectEntrypoint) return '/outside/replaced.exe'
        return fileSystem.realpath(target)
      }
    }
    const launcher = new LocalLauncherCore(createLauncherLayout(root), changingFs)
    const selected = await launcher.validateBuild(build1)
    expect(selected).not.toBeNull()
    const spawn = vi.fn(() => ({}) as ChildProcess)
    redirectEntrypoint = true

    await expect(spawnSelectedApp(launcher, selected!, { spawn })).rejects.toThrow()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('records an immediate failure when the child exits before health confirmation', async () => {
    install()
    vol.writeFileSync(path.join(root, 'active.json'), JSON.stringify(pointer(build1, runtime1)))
    const launcher = new LocalLauncherCore(createLauncherLayout(root), fileSystem, {
      createLaunchToken: () => 'early-exit-token'
    })
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const child = {
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener)
        return child
      })
    } as unknown as ChildProcess

    await launcher.spawnActive({ spawn: vi.fn(() => child) })
    listeners.get('exit')?.(1, null)
    await vi.waitFor(async () => {
      expect((await launcher.readHealthState()).pending).toBeUndefined()
    })

    expect((await launcher.readHealthState()).failedAttemptCount).toBe(1)
  })

  it('records an early child failure only once when error and exit both fire', async () => {
    install()
    vol.writeFileSync(path.join(root, 'active.json'), JSON.stringify(pointer(build1, runtime1)))
    const launcher = new LocalLauncherCore(createLauncherLayout(root), fileSystem, {
      createLaunchToken: () => 'early-error-token'
    })
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const child = {
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener)
        return child
      })
    } as unknown as ChildProcess

    await launcher.spawnActive({ spawn: vi.fn(() => child) })
    listeners.get('error')?.(new Error('boom'))
    listeners.get('exit')?.(1, null)
    await vi.waitFor(async () => {
      expect((await launcher.readHealthState()).pending).toBeUndefined()
    })

    expect((await launcher.readHealthState()).failedAttemptCount).toBe(1)
  })

  it('refuses to spawn a selection that is no longer valid', async () => {
    install()
    const launcher = new LocalLauncherCore(createLauncherLayout(root), fileSystem)
    const selected = await launcher.validateBuild(build1)
    expect(selected).not.toBeNull()
    vol.unlinkSync(path.join(root, 'apps', build1, 'MagicPot.exe'))
    const spawn = vi.fn(() => ({}) as ChildProcess)

    await expect(spawnSelectedApp(launcher, selected!, { spawn })).rejects.toThrow(
      'no longer valid'
    )
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('persistent launcher health integration', () => {
  it('passes the launcher root with the health token when spawning the active app', async () => {
    install()
    vol.writeFileSync(path.join(root, 'active.json'), JSON.stringify(pointer()))
    const launcher = new LocalLauncherCore(createLauncherLayout(root), fileSystem, {
      createLaunchToken: () => 'spawn-token'
    })
    const spawn = vi.fn(() => ({}) as ChildProcess)

    await launcher.spawnActive({ spawn, env: { TEST_ONLY: '1' } })

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          MAGICPOT_LAUNCH_TOKEN: 'spawn-token',
          MAGICPOT_LAUNCH_BUILD_ID: build1,
          MAGICPOT_LAUNCHER_ROOT: createLauncherLayout(root).root
        })
      })
    )
  })

  it('persists build/runtime/token/deadline and rejects mismatched health confirmation', async () => {
    install()
    vol.writeFileSync(path.join(root, 'active.json'), JSON.stringify(pointer()))
    const now = new Date('2026-07-18T08:00:00.000Z')
    const launcher = new LocalLauncherCore(createLauncherLayout(root), fileSystem, {
      now: () => now,
      createLaunchToken: () => 'generated-token',
      healthDeadlineMs: 5_000
    })

    const state = await launcher.beginPendingLaunch(build1, runtime1)
    expect(state.pending).toMatchObject({
      buildId: build1,
      runtimeId: runtime1,
      launchToken: 'generated-token',
      deadline: '2026-07-18T08:00:05.000Z'
    })
    await expect(
      launcher.confirmHealthy({ buildId: build1, runtimeId: runtime1, launchToken: 'wrong-token' })
    ).resolves.toMatchObject({ accepted: false })
    await expect(
      launcher.confirmHealthy({
        buildId: build2,
        runtimeId: runtime1,
        launchToken: 'generated-token'
      })
    ).resolves.toMatchObject({ accepted: false })
    await expect(
      launcher.confirmHealthy({
        buildId: build1,
        runtimeId: runtime1,
        launchToken: 'generated-token'
      })
    ).resolves.toMatchObject({ accepted: true, state: { failedAttemptCount: 0 } })
  })

  it('records spawn failure, rolls back at the threshold, and resets health after active changes', async () => {
    install(appManifest(build1, runtime1))
    install(appManifest(build2, runtime2), runtimeManifest(runtime2))
    vol.writeFileSync(
      path.join(root, 'active.json'),
      JSON.stringify({
        ...pointer(build2, runtime2),
        previousBuildId: build1,
        previousRuntimeId: runtime1
      })
    )
    const launcher = new LocalLauncherCore(createLauncherLayout(root), fileSystem, {
      consecutiveFailureThreshold: 1,
      createLaunchToken: () => 'failure-token'
    })

    await expect(
      launcher.spawnActive({
        spawn: () => {
          throw new Error('spawn failed')
        }
      })
    ).rejects.toThrow('spawn failed')
    expect(
      JSON.parse(String(vol.readFileSync(path.join(root, 'active.json'), 'utf8')))
    ).toMatchObject({
      activeBuildId: build1,
      previousBuildId: build2
    })
    expect(
      JSON.parse(String(vol.readFileSync(path.join(root, 'launcher-health.json'), 'utf8')))
    ).toEqual({
      schema: 1,
      failedAttemptCount: 0
    })
  })

  it('counts an expired pending launch on the next startup without changing active early', async () => {
    install(appManifest(build1, runtime1))
    install(appManifest(build2, runtime2), runtimeManifest(runtime2))
    vol.writeFileSync(
      path.join(root, 'active.json'),
      JSON.stringify({
        ...pointer(build2, runtime2),
        previousBuildId: build1,
        previousRuntimeId: runtime1
      })
    )
    let now = new Date('2026-07-18T08:00:00.000Z')
    const options = { now: () => now, consecutiveFailureThreshold: 1 }
    const first = new LocalLauncherCore(createLauncherLayout(root), fileSystem, options)
    await first.beginPendingLaunch(build2, runtime2, {
      launchToken: 'expired-token',
      healthDeadline: '2026-07-18T08:00:01.000Z'
    })
    expect(
      JSON.parse(String(vol.readFileSync(path.join(root, 'active.json'), 'utf8'))).activeBuildId
    ).toBe(build2)

    now = new Date('2026-07-18T08:00:02.000Z')
    const restarted = new LocalLauncherCore(createLauncherLayout(root), fileSystem, options)
    await restarted.recoverExpiredPending()
    expect(
      JSON.parse(String(vol.readFileSync(path.join(root, 'active.json'), 'utf8'))).activeBuildId
    ).toBe(build1)
  })
})
