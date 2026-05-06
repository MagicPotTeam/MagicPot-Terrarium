import fs from 'fs/promises'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { DEFAULT_BUILD_ENV, type BuildEnv } from '@shared/config/buildEnv'
import type { TargetHistoryEntry } from '@shared/targetHistory'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import type { TargetScheme } from '@shared/targetScheme'
import { TargetSchemeFSCli } from './fs'

vi.mock(import('../config/buildEnv'), () => ({
  getBuildEnv: vi.fn()
}))

vi.mock(import('../config/config'), () => ({
  getConfig: vi.fn()
}))

const pathExists = async (targetPath: string): Promise<boolean> =>
  fs
    .access(targetPath)
    .then(() => true)
    .catch(() => false)

describe('TargetSchemeFSCli', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
    tempRoots.length = 0
  })

  it('migrates legacy target scheme files into the preferred userData directory', async () => {
    const tempRoot = await createNodeTestArtifactDir('target-scheme')
    tempRoots.push(tempRoot)

    const legacyDir = path.join(tempRoot, 'workspace', 'customChecks')
    const dataDir = path.join(tempRoot, 'userData')
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(legacyDir, { recursive: true })

    const scheme: TargetScheme = {
      id: 'target-1',
      name: '可读性目标',
      description: 'desc',
      enabled: true,
      files: [],
      createdAt: '2026-04-12T00:00:00.000Z',
      updatedAt: '2026-04-12T00:00:00.000Z'
    }

    await fs.writeFile(path.join(legacyDir, 'target-1.check.json'), JSON.stringify(scheme), 'utf8')

    const buildEnv: BuildEnv = {
      ...DEFAULT_BUILD_ENV,
      pathMap: {
        resources: '',
        file: path.join(tempRoot, 'workspace'),
        data: dataDir
      }
    }

    const cli = new TargetSchemeFSCli(DEFAULT_CONFIG as Config, buildEnv)
    const result = await cli.listSchemes()

    expect(result).toEqual([scheme])
    expect(
      await fs
        .access(path.join(dataDir, 'targetSchemes', 'target-1.target.json'))
        .then(() => true)
        .catch(() => false)
    ).toBe(true)
  })

  it('merges legacy scheme files even when the preferred directory already has newer entries', async () => {
    const tempRoot = await createNodeTestArtifactDir('target-scheme-mixed-state')
    tempRoots.push(tempRoot)

    const legacyDir = path.join(tempRoot, 'workspace', 'customChecks')
    const dataDir = path.join(tempRoot, 'userData')
    const preferredDir = path.join(dataDir, 'targetSchemes')
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(legacyDir, { recursive: true })
    await fs.mkdir(preferredDir, { recursive: true })

    const existingScheme: TargetScheme = {
      id: 'target-existing',
      name: 'existing',
      description: 'already migrated',
      enabled: true,
      files: [],
      createdAt: '2026-04-13T00:00:00.000Z',
      updatedAt: '2026-04-13T00:00:00.000Z'
    }
    const legacyScheme: TargetScheme = {
      id: 'target-legacy',
      name: 'legacy',
      description: 'needs merging',
      enabled: true,
      files: [],
      createdAt: '2026-04-12T00:00:00.000Z',
      updatedAt: '2026-04-12T00:00:00.000Z'
    }

    await fs.writeFile(
      path.join(preferredDir, 'target-existing.target.json'),
      JSON.stringify(existingScheme),
      'utf8'
    )
    await fs.writeFile(
      path.join(legacyDir, 'target-legacy.check.json'),
      JSON.stringify(legacyScheme),
      'utf8'
    )

    const buildEnv: BuildEnv = {
      ...DEFAULT_BUILD_ENV,
      pathMap: {
        resources: '',
        file: path.join(tempRoot, 'workspace'),
        data: dataDir
      }
    }

    const cli = new TargetSchemeFSCli(DEFAULT_CONFIG as Config, buildEnv)
    const result = await cli.listSchemes()

    expect(result).toEqual([existingScheme, legacyScheme])
    expect(
      await fs
        .access(path.join(preferredDir, 'target-legacy.target.json'))
        .then(() => true)
        .catch(() => false)
    ).toBe(true)
  })

  it('removes userData legacy sources after migration so deleted schemes do not reappear', async () => {
    const tempRoot = await createNodeTestArtifactDir('target-scheme-userdata-migration')
    tempRoots.push(tempRoot)

    const dataDir = path.join(tempRoot, 'userData')
    const legacyDir = path.join(dataDir, 'automationSchemes')
    const preferredDir = path.join(dataDir, 'targetSchemes')
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(legacyDir, { recursive: true })

    const scheme: TargetScheme = {
      id: 'target-userdata-legacy',
      name: 'legacy user scheme',
      description: 'migrated from userData automationSchemes',
      enabled: true,
      files: [],
      createdAt: '2026-04-12T00:00:00.000Z',
      updatedAt: '2026-04-12T00:00:00.000Z'
    }
    const legacyFilePath = path.join(legacyDir, 'target-userdata-legacy.automation.json')
    const preferredFilePath = path.join(preferredDir, 'target-userdata-legacy.target.json')
    await fs.writeFile(legacyFilePath, JSON.stringify(scheme), 'utf8')

    const buildEnv: BuildEnv = {
      ...DEFAULT_BUILD_ENV,
      pathMap: {
        resources: '',
        file: path.join(tempRoot, 'workspace'),
        data: dataDir
      }
    }

    const cli = new TargetSchemeFSCli(DEFAULT_CONFIG as Config, buildEnv)
    expect(await cli.listSchemes()).toEqual([scheme])
    expect(await pathExists(preferredFilePath)).toBe(true)
    expect(await pathExists(legacyFilePath)).toBe(false)

    await cli.deleteScheme(scheme.id)

    expect(await cli.listSchemes()).toEqual([])
    expect(await pathExists(preferredFilePath)).toBe(false)
  })

  it('removes stale userData legacy duplicates before deleting preferred schemes', async () => {
    const tempRoot = await createNodeTestArtifactDir('target-scheme-userdata-stale-legacy')
    tempRoots.push(tempRoot)

    const dataDir = path.join(tempRoot, 'userData')
    const legacyDir = path.join(dataDir, 'automationSchemes')
    const preferredDir = path.join(dataDir, 'targetSchemes')
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(legacyDir, { recursive: true })
    await fs.mkdir(preferredDir, { recursive: true })

    const scheme: TargetScheme = {
      id: 'target-stale-legacy',
      name: 'preferred scheme',
      description: 'already migrated',
      enabled: true,
      files: [],
      createdAt: '2026-04-12T00:00:00.000Z',
      updatedAt: '2026-04-13T00:00:00.000Z'
    }
    const staleLegacyScheme: TargetScheme = {
      ...scheme,
      name: 'stale legacy scheme',
      updatedAt: '2026-04-12T00:00:00.000Z'
    }
    const legacyFilePath = path.join(legacyDir, 'target-stale-legacy.automation.json')
    const preferredFilePath = path.join(preferredDir, 'target-stale-legacy.target.json')
    await fs.writeFile(legacyFilePath, JSON.stringify(staleLegacyScheme), 'utf8')
    await fs.writeFile(preferredFilePath, JSON.stringify(scheme), 'utf8')

    const buildEnv: BuildEnv = {
      ...DEFAULT_BUILD_ENV,
      pathMap: {
        resources: '',
        file: path.join(tempRoot, 'workspace'),
        data: dataDir
      }
    }

    const cli = new TargetSchemeFSCli(DEFAULT_CONFIG as Config, buildEnv)
    await cli.deleteScheme(scheme.id)

    expect(await pathExists(legacyFilePath)).toBe(false)
    expect(await cli.listSchemes()).toEqual([])
  })

  it('persists and sorts history targets by last run time', async () => {
    const tempRoot = await createNodeTestArtifactDir('target-history')
    tempRoots.push(tempRoot)

    const dataDir = path.join(tempRoot, 'userData')
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(dataDir, { recursive: true })

    const buildEnv: BuildEnv = {
      ...DEFAULT_BUILD_ENV,
      pathMap: {
        resources: '',
        file: path.join(tempRoot, 'workspace'),
        data: dataDir
      }
    }

    const olderTarget: TargetHistoryEntry = {
      id: 'history-1',
      name: 'Older target',
      schemeId: 'scheme-1',
      controlProfileId: 'control-1',
      userIntent: 'Inspect title hierarchy',
      stageProfiles: [],
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
      lastRunAt: '2026-04-10T01:00:00.000Z'
    }
    const newerTarget: TargetHistoryEntry = {
      id: 'history-2',
      name: 'Newer target',
      schemeId: 'scheme-2',
      controlProfileId: 'control-2',
      userIntent: 'Inspect CTA visibility',
      stageProfiles: [],
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      lastRunAt: '2026-04-11T02:00:00.000Z'
    }

    const cli = new TargetSchemeFSCli(DEFAULT_CONFIG as Config, buildEnv)
    await cli.saveHistoryTarget(olderTarget)
    await cli.saveHistoryTarget(newerTarget)

    expect(await cli.listHistoryTargets()).toEqual([newerTarget, olderTarget])
  })

  it('deletes a persisted history target', async () => {
    const tempRoot = await createNodeTestArtifactDir('target-history-delete')
    tempRoots.push(tempRoot)

    const dataDir = path.join(tempRoot, 'userData')
    await fs.rm(tempRoot, { recursive: true, force: true })
    await fs.mkdir(dataDir, { recursive: true })

    const buildEnv: BuildEnv = {
      ...DEFAULT_BUILD_ENV,
      pathMap: {
        resources: '',
        file: path.join(tempRoot, 'workspace'),
        data: dataDir
      }
    }

    const target: TargetHistoryEntry = {
      id: 'history-delete',
      name: 'Delete me',
      schemeId: 'scheme-1',
      controlProfileId: 'control-1',
      userIntent: 'Inspect spacing',
      stageProfiles: [],
      createdAt: '2026-04-12T00:00:00.000Z',
      updatedAt: '2026-04-12T00:00:00.000Z',
      lastRunAt: '2026-04-12T01:00:00.000Z'
    }

    const cli = new TargetSchemeFSCli(DEFAULT_CONFIG as Config, buildEnv)
    await cli.saveHistoryTarget(target)
    expect(await cli.listHistoryTargets()).toEqual([target])

    await cli.deleteHistoryTarget(target.id)

    expect(await cli.listHistoryTargets()).toEqual([])
  })
})
