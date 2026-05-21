import type { Config } from '@shared/config/config'
import { normalizeGeneratedRootDirName } from '@shared/projectStorage'
import { buildProjectStorageDirName, getProjectById } from '@renderer/pages/MainPage/projectStore'

const DEFAULT_PROJECT_ID = 'default'
const DEFAULT_PROJECT_NAME = 'default-project'
const DOWNLOAD_DIR_KEY = 'qapp.downloadDir'

type ProjectResourceOptions = {
  config: Pick<Config, 'download_dir'>
  projectId?: string | null
  projectName?: string | null
  segments?: readonly string[]
}

const normalizeText = (value: unknown): string => String(value ?? '').trim()

export function resolveProjectIdFromStorageScope(storageScope?: string | null): string | undefined {
  const scope = normalizeText(storageScope)
  if (!scope || scope === DEFAULT_PROJECT_ID) {
    return undefined
  }

  const firstPart = scope.split('.')[0]?.trim()
  return firstPart || undefined
}

export function resolveConfiguredProjectRoot(config: Pick<Config, 'download_dir'>): string {
  try {
    const cachedDir = localStorage.getItem(DOWNLOAD_DIR_KEY)?.trim()
    if (cachedDir) {
      return cachedDir
    }
  } catch {
    // Ignore localStorage failures and fall back to config.
  }

  return normalizeText(config.download_dir)
}

export function resolveProjectStorageDirName(
  projectId?: string | null,
  projectName?: string | null
): string {
  const normalizedProjectId = normalizeText(projectId) || DEFAULT_PROJECT_ID
  const project = getProjectById(normalizedProjectId)
  const normalizedStoredDirName = project?.storageDirName
    ? normalizeGeneratedRootDirName(project.storageDirName)
    : ''
  if (normalizedStoredDirName) {
    return normalizedStoredDirName
  }

  const normalizedProjectName = normalizeText(projectName) || project?.name || DEFAULT_PROJECT_NAME
  return buildProjectStorageDirName(normalizedProjectName, normalizedProjectId)
}

export function resolveProjectResourceDir({
  config,
  projectId,
  projectName,
  segments = []
}: ProjectResourceOptions): string | undefined {
  const root = resolveConfiguredProjectRoot(config)
  if (!root || !window.path || typeof window.path.join !== 'function') {
    return undefined
  }

  return window.path.join(root, resolveProjectStorageDirName(projectId, projectName), ...segments)
}
