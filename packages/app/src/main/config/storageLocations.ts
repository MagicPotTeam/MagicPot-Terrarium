import fs from 'fs/promises'
import path from 'path'
import { ConfigUtils } from '@shared/config/configUtils'
import type { StorageLocationSnapshot } from '@shared/api/svcState'
import type { BuildEnv } from '@shared/config/buildEnv'
import type { Config } from '@shared/config/config'
import { getBuildEnv } from './buildEnv'
import { getConfig } from './config'
import { DEV_USER_DATA_DIRNAME, getLegacyPortableUserDataDirectory } from './portablePaths'
import { getDefaultUserDataDirectory } from './userDataDirectory'

const USER_DATA_DIRNAME = 'aiengineelectron'

type StorageLocationSeed = Pick<StorageLocationSnapshot, 'id' | 'kind' | 'isCurrent'> & {
  userDataDir: string
  fileRootDir: string
  qAppDir?: string
  customSkillDir?: string
  targetSchemeDir?: string
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function normalizePathKey(targetPath: string): string {
  const normalized = path.normalize(targetPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function buildCurrentLocation(config: Config, buildEnv: BuildEnv): StorageLocationSeed {
  const configUtils = new ConfigUtils(config, buildEnv, path)
  const userDataDir = buildEnv.pathMap.data
  const defaultUserDataDir = getDefaultUserDataDirectory()
  return {
    id: 'current',
    kind:
      normalizePathKey(userDataDir) !== normalizePathKey(defaultUserDataDir)
        ? 'current-override'
        : buildEnv.env.build === 'development'
          ? 'current-development'
          : 'current-production',
    isCurrent: true,
    userDataDir,
    fileRootDir: buildEnv.pathMap.file,
    qAppDir: configUtils.getQAppDir(),
    customSkillDir: configUtils.getCustomSkillDir(),
    targetSchemeDir: configUtils.getTargetSchemeDir()
  }
}

function buildDefaultLocation(buildEnv: BuildEnv): StorageLocationSeed {
  if (buildEnv.env.build === 'development') {
    return {
      id: 'default-development',
      kind: 'default-development',
      isCurrent: false,
      userDataDir: path.join(process.cwd(), DEV_USER_DATA_DIRNAME, 'Data'),
      fileRootDir: process.cwd()
    }
  }

  const fileRootDir = path.join(process.resourcesPath, '..')
  return {
    id: 'default-production',
    kind: 'default-production',
    isCurrent: false,
    userDataDir: getDefaultUserDataDirectory(),
    fileRootDir
  }
}

function buildLegacyAppRootLocation(buildEnv: BuildEnv): StorageLocationSeed | null {
  if (buildEnv.env.build === 'development') {
    return null
  }

  const legacyDir = getLegacyPortableUserDataDirectory()
  if (!legacyDir) {
    return null
  }

  return {
    id: 'legacy-app-root',
    kind: 'legacy-app-root',
    isCurrent: false,
    userDataDir: legacyDir,
    fileRootDir: path.join(process.resourcesPath, '..')
  }
}

function buildStandardInstallLocations(): StorageLocationSeed[] {
  const localAppData = process.env['LOCALAPPDATA']?.trim()
  if (!localAppData) {
    return []
  }

  const fileRootDir = path.join(localAppData, 'Programs', 'magicpot')
  return [
    {
      id: 'standard-installed',
      kind: 'standard-installed',
      isCurrent: false,
      userDataDir: path.join(fileRootDir, USER_DATA_DIRNAME),
      fileRootDir
    }
  ]
}

async function inspectLocation(seed: StorageLocationSeed): Promise<StorageLocationSnapshot> {
  const configPath = path.join(seed.userDataDir, 'config.json')
  const qAppDir = seed.qAppDir || path.join(seed.fileRootDir, 'qApps')
  const preferredCustomSkillDir = seed.customSkillDir || path.join(seed.userDataDir, 'customSkills')
  const legacyCustomSkillDir = path.join(seed.fileRootDir, 'customSkills')
  const preferredTargetSchemeDir =
    seed.targetSchemeDir || path.join(seed.userDataDir, 'targetSchemes')
  const legacyTargetSchemeDir = path.join(seed.userDataDir, 'automationSchemes')
  const legacyTargetCheckDir = path.join(seed.userDataDir, 'customChecks')
  const legacyWorkspaceAutomationSchemeDir = path.join(seed.fileRootDir, 'automationSchemes')
  const legacyWorkspaceTargetSchemeDir = path.join(seed.fileRootDir, 'targetSchemes')
  const legacyWorkspaceCompatibilityDir = path.join(seed.fileRootDir, 'customChecks')

  const [
    preferredCustomSkillExists,
    legacyCustomSkillExists,
    preferredTargetSchemeExists,
    legacyTargetSchemeExists,
    legacyTargetCheckExists,
    legacyWorkspaceAutomationSchemeExists,
    legacyWorkspaceTargetSchemeExists,
    legacyWorkspaceCompatibilityExists
  ] = await Promise.all([
    pathExists(preferredCustomSkillDir),
    pathExists(legacyCustomSkillDir),
    pathExists(preferredTargetSchemeDir),
    pathExists(legacyTargetSchemeDir),
    pathExists(legacyTargetCheckDir),
    pathExists(legacyWorkspaceAutomationSchemeDir),
    pathExists(legacyWorkspaceTargetSchemeDir),
    pathExists(legacyWorkspaceCompatibilityDir)
  ])

  const customSkillDir =
    preferredCustomSkillExists || !legacyCustomSkillExists
      ? preferredCustomSkillDir
      : legacyCustomSkillDir
  const targetSchemeDir = preferredTargetSchemeExists
    ? preferredTargetSchemeDir
    : legacyTargetSchemeExists
      ? legacyTargetSchemeDir
      : legacyTargetCheckExists
        ? legacyTargetCheckDir
        : legacyWorkspaceAutomationSchemeExists
          ? legacyWorkspaceAutomationSchemeDir
          : legacyWorkspaceTargetSchemeExists
            ? legacyWorkspaceTargetSchemeDir
            : legacyWorkspaceCompatibilityExists
              ? legacyWorkspaceCompatibilityDir
              : preferredTargetSchemeDir

  const [configExists, qAppsExists, customSkillsExists, targetSchemesExists] = await Promise.all([
    pathExists(configPath),
    pathExists(qAppDir),
    Promise.resolve(preferredCustomSkillExists || legacyCustomSkillExists),
    Promise.resolve(
      preferredTargetSchemeExists ||
        legacyTargetSchemeExists ||
        legacyTargetCheckExists ||
        legacyWorkspaceAutomationSchemeExists ||
        legacyWorkspaceTargetSchemeExists ||
        legacyWorkspaceCompatibilityExists
    )
  ])

  return {
    id: seed.id,
    kind: seed.kind,
    isCurrent: seed.isCurrent,
    userDataDir: seed.userDataDir,
    fileRootDir: seed.fileRootDir,
    configPath,
    qAppDir,
    customSkillDir,
    targetSchemeDir,
    configExists,
    qAppsExists,
    customSkillsExists,
    targetSchemesExists
  }
}

export async function getStorageLocations(): Promise<StorageLocationSnapshot[]> {
  const buildEnv = getBuildEnv()
  const config = getConfig()

  const deduped = new Map<string, StorageLocationSeed>()
  const seeds = [
    buildCurrentLocation(config, buildEnv),
    buildDefaultLocation(buildEnv),
    buildLegacyAppRootLocation(buildEnv),
    ...buildStandardInstallLocations()
  ].filter((seed): seed is StorageLocationSeed => Boolean(seed))

  for (const seed of seeds) {
    const key = normalizePathKey(seed.userDataDir)
    const existing = deduped.get(key)
    if (!existing || seed.isCurrent) {
      deduped.set(key, seed)
    }
  }

  const inspected = await Promise.all(
    Array.from(deduped.values()).map((seed) => inspectLocation(seed))
  )

  return inspected.sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) {
      return left.isCurrent ? -1 : 1
    }

    const leftScore =
      Number(left.configExists) +
      Number(left.qAppsExists) +
      Number(left.customSkillsExists) +
      Number(left.targetSchemesExists)
    const rightScore =
      Number(right.configExists) +
      Number(right.qAppsExists) +
      Number(right.customSkillsExists) +
      Number(right.targetSchemesExists)

    if (leftScore !== rightScore) {
      return rightScore - leftScore
    }

    return left.userDataDir.localeCompare(right.userDataDir)
  })
}
