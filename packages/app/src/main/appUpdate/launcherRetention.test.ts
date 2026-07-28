import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ActivePointerV1,
  InstalledAppManifestV1,
  InstalledRuntimeManifestV1,
  LauncherSettingsV1
} from '../../shared/appUpdate/launcherProtocol'
import { createLauncherLayout } from './launcherLayout'
import { applyLauncherRetention, type LauncherRetentionFileSystem } from './launcherRetention'

const builds = {
  old: '20260101-010101-aaaaaaa',
  active: '20260201-010101-bbbbbbb',
  previous: '20260301-010101-ccccccc',
  pending: '20260401-010101-ddddddd',
  newest: '20260501-010101-eeeeeee',
  nightlyOld: '20260601-010101-fffffff',
  nightlyNew: '20260701-010101-1111111'
}
const runtimes = {
  old: 'runtime-old',
  active: 'runtime-active',
  previous: 'runtime-previous',
  pending: 'runtime-pending',
  shared: 'runtime-shared',
  unused: 'runtime-unused'
}
const roots: string[] = []
const settings: LauncherSettingsV1 = {
  schema: 1,
  updateMode: 'manual',
  channel: 'stable',
  retainAppVersions: 1,
  retainNightlyVersions: 1,
  allowPrerelease: false
}

async function makeTemp(prefix: string) {
  const temporaryRoot = os.tmpdir()
  await fs.mkdir(temporaryRoot, { recursive: true })
  return fs.mkdtemp(path.join(temporaryRoot, prefix))
}

async function tempLayout() {
  const root = await makeTemp('launcher-retention-')
  roots.push(root)
  const layout = createLauncherLayout(root)
  await Promise.all([fs.mkdir(layout.apps), fs.mkdir(layout.runtimes)])
  return layout
}
function appManifest(
  buildId: string,
  runtimeId: string,
  createdAt: string,
  version = '1.0.0'
): InstalledAppManifestV1 {
  return {
    schema: 1,
    kind: 'magicpot-app',
    version,
    buildId,
    commitSha: `${buildId.slice(-7)}000000000000000000000000000000000`,
    platform: 'win32',
    arch: 'x64',
    runtimeId,
    entrypoint: 'MagicPot.exe',
    createdAt,
    unpackedSize: 1
  }
}
function runtimeManifest(runtimeId: string): InstalledRuntimeManifestV1 {
  return {
    schema: 1,
    kind: 'magicpot-runtime',
    runtimeId,
    platform: 'win32',
    arch: 'x64',
    createdAt: '2026-01-01T00:00:00.000Z',
    entrypoints: { python: 'python.exe', comfyui: 'main.py' },
    unpackedSize: 1
  }
}
async function writeApp(
  layout: ReturnType<typeof createLauncherLayout>,
  manifest: InstalledAppManifestV1
) {
  const directory = path.join(layout.apps, manifest.buildId)
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
}
async function writeRuntime(layout: ReturnType<typeof createLauncherLayout>, runtimeId: string) {
  const directory = path.join(layout.runtimes, runtimeId)
  await fs.mkdir(directory)
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify(runtimeManifest(runtimeId))
  )
}
const activePointer: ActivePointerV1 = {
  schema: 1,
  activeBuildId: builds.active,
  activeRuntimeId: runtimes.active,
  previousBuildId: builds.previous,
  previousRuntimeId: runtimes.previous,
  activatedAt: '2026-01-01T00:00:00.000Z'
}
async function exists(target: string) {
  return fs.stat(target).then(
    () => true,
    () => false
  )
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('applyLauncherRetention', () => {
  it('protects active, previous and pending pairs and retained app runtime references', async () => {
    const layout = await tempLayout()
    const apps = [
      appManifest(builds.old, runtimes.old, '2026-01-01T00:00:00.000Z'),
      appManifest(builds.active, runtimes.active, '2026-02-01T00:00:00.000Z'),
      appManifest(builds.previous, runtimes.previous, '2026-03-01T00:00:00.000Z'),
      appManifest(builds.pending, runtimes.pending, '2026-04-01T00:00:00.000Z'),
      appManifest(builds.newest, runtimes.shared, '2026-05-01T00:00:00.000Z')
    ]
    await Promise.all(apps.map((app) => writeApp(layout, app)))
    await Promise.all(Object.values(runtimes).map((runtime) => writeRuntime(layout, runtime)))
    const result = await applyLauncherRetention({
      layout,
      settings,
      activePointer,
      healthState: {
        schema: 1,
        failedAttemptCount: 0,
        pending: {
          buildId: builds.pending,
          runtimeId: runtimes.pending,
          launchToken: 'token',
          attemptCount: 1,
          startedAt: '2026-01-01T00:00:00.000Z',
          deadline: '2026-01-01T00:01:00.000Z'
        }
      }
    })
    expect(result.keptApps).toEqual(
      [builds.active, builds.previous, builds.pending, builds.newest].sort()
    )
    expect(result.deletedApps).toEqual([builds.old])
    expect(result.keptRuntimes).toEqual(
      [runtimes.active, runtimes.previous, runtimes.pending, runtimes.shared].sort()
    )
    expect(result.deletedRuntimes).toEqual([runtimes.old, runtimes.unused].sort())
  })

  it('uses stable newest-first slots and adds separate nightly slots', async () => {
    const layout = await tempLayout()
    await Promise.all([
      writeApp(layout, appManifest(builds.old, runtimes.old, '2026-01-01T00:00:00.000Z')),
      writeApp(layout, appManifest(builds.newest, runtimes.shared, '2026-05-01T00:00:00.000Z')),
      writeApp(
        layout,
        appManifest(builds.nightlyOld, runtimes.old, '2026-06-01T00:00:00.000Z', '1.0.0-nightly.1')
      ),
      writeApp(
        layout,
        appManifest(
          builds.nightlyNew,
          runtimes.shared,
          '2026-07-01T00:00:00.000Z',
          '1.0.0+nightly.2'
        )
      )
    ])
    const result = await applyLauncherRetention({ layout, settings, dryRun: true })
    expect(result.keptApps).toEqual([builds.nightlyNew])
    expect(result.deletedApps).toEqual([builds.newest, builds.nightlyOld, builds.old].sort())
  })

  it('fails closed on corrupt manifests and directory links', async () => {
    const layout = await tempLayout()
    const corrupt = path.join(layout.apps, builds.old)
    await fs.mkdir(corrupt)
    await fs.writeFile(path.join(corrupt, 'manifest.json'), '{')
    const target = path.join(layout.root, 'link-target')
    await fs.mkdir(target)
    const link = path.join(layout.apps, builds.newest)
    try {
      await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    const result = await applyLauncherRetention({ layout, settings })
    expect(result.skipped).toHaveLength(2)
    expect(await exists(corrupt)).toBe(true)
    expect(await exists(link)).toBe(true)
  })

  it('reports failed removals as pending and keeps the still-referenced runtime', async () => {
    const layout = await tempLayout()
    await writeApp(layout, appManifest(builds.old, runtimes.old, '2026-01-01T00:00:00.000Z'))
    await writeRuntime(layout, runtimes.old)
    const fileSystem: LauncherRetentionFileSystem = {
      readdir: (directory) => fs.readdir(directory),
      lstat: (target) => fs.lstat(target),
      realpath: (target) => fs.realpath(target),
      readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
      rm: async (target, options) => {
        if (target === path.join(layout.apps, builds.old)) throw new Error('locked')
        await fs.rm(target, options)
      }
    }
    const result = await applyLauncherRetention({
      layout,
      settings: { ...settings, retainAppVersions: 0 },
      fileSystem
    })
    expect(result.pendingDeletes).toEqual([path.join(layout.apps, builds.old)])
    expect(result.errors[0].message).toBe('locked')
    expect(result.keptRuntimes).toEqual([runtimes.old])
  })

  it('dry-run reports deletions without touching disk', async () => {
    const layout = await tempLayout()
    await writeApp(layout, appManifest(builds.old, runtimes.old, '2026-01-01T00:00:00.000Z'))
    await writeRuntime(layout, runtimes.old)
    const result = await applyLauncherRetention({
      layout,
      settings: { ...settings, retainAppVersions: 0 },
      dryRun: true
    })
    expect(result.deletedApps).toEqual([builds.old])
    expect(result.deletedRuntimes).toEqual([runtimes.old])
    expect(await exists(path.join(layout.apps, builds.old))).toBe(true)
    expect(await exists(path.join(layout.runtimes, runtimes.old))).toBe(true)
  })

  it('rejects layouts whose managed directories escape the launcher root', async () => {
    const layout = await tempLayout()
    const outside = await makeTemp('launcher-outside-')
    roots.push(outside)
    const result = await applyLauncherRetention({ layout: { ...layout, apps: outside }, settings })
    expect(result.errors).toEqual([{ path: layout.root, message: 'Unsafe launcher layout' }])
    expect(await exists(outside)).toBe(true)
  })

  it.each(['apps', 'runtimes'] as const)(
    'rejects an outside-pointing %s junction without deleting its target',
    async (managedName) => {
      const layout = await tempLayout()
      const outside = await makeTemp(`launcher-${managedName}-outside-`)
      roots.push(outside)
      await fs.rm(layout[managedName], { recursive: true })
      try {
        await fs.symlink(
          outside,
          layout[managedName],
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      } catch {
        return
      }
      const result = await applyLauncherRetention({ layout, settings })
      expect(result.deletedApps).toEqual([])
      expect(result.deletedRuntimes).toEqual([])
      expect(result.errors).toHaveLength(1)
      expect(await exists(outside)).toBe(true)
    }
  )

  it('refuses deletion when a candidate is replaced after scanning', async () => {
    const layout = await tempLayout()
    const appDirectory = path.join(layout.apps, builds.old)
    await writeApp(layout, appManifest(builds.old, runtimes.old, '2026-01-01T00:00:00.000Z'))
    await writeRuntime(layout, runtimes.old)
    let candidateStats = 0
    const fileSystem: LauncherRetentionFileSystem = {
      readdir: (directory) => fs.readdir(directory),
      lstat: async (target) => {
        if (target === appDirectory && ++candidateStats === 2) {
          return { isDirectory: () => true, isSymbolicLink: () => true }
        }
        return fs.lstat(target)
      },
      realpath: (target) => fs.realpath(target),
      readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
      rm: (target, options) => fs.rm(target, options)
    }
    const result = await applyLauncherRetention({
      layout,
      settings: { ...settings, retainAppVersions: 0 },
      fileSystem
    })
    expect(result.deletedApps).toEqual([])
    expect(result.pendingDeletes).toEqual([appDirectory])
    expect(await exists(appDirectory)).toBe(true)
  })

  it.each([
    ['apps', 'runtime'],
    ['runtimes', 'app']
  ] as const)(
    'does not clean %s when the other scan fails',
    async (failedDirectory, preservedKind) => {
      const layout = await tempLayout()
      await writeApp(layout, appManifest(builds.old, runtimes.old, '2026-01-01T00:00:00.000Z'))
      await writeRuntime(layout, runtimes.old)
      const fileSystem: LauncherRetentionFileSystem = {
        readdir: async (directory) => {
          if (directory === layout[failedDirectory])
            throw new Error(`${failedDirectory} scan failed`)
          return fs.readdir(directory)
        },
        lstat: (target) => fs.lstat(target),
        realpath: (target) => fs.realpath(target),
        readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
        rm: (target, options) => fs.rm(target, options)
      }
      const result = await applyLauncherRetention({
        layout,
        settings: { ...settings, retainAppVersions: 0 },
        fileSystem
      })
      expect(result.deletedApps).toEqual([])
      expect(result.deletedRuntimes).toEqual([])
      const preserved =
        preservedKind === 'app'
          ? path.join(layout.apps, builds.old)
          : path.join(layout.runtimes, runtimes.old)
      expect(await exists(preserved)).toBe(true)
    }
  )
})
