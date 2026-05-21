import { buildProjectStorageDirName, normalizeGeneratedRootDirName } from '@shared/projectStorage'

export const PROJECTS_STORAGE_KEY = 'magicpot.projects.v1'
export const LEGACY_PROJECTS_STORAGE_KEY = 'ai_engine_projects'
export const PROJECTS_CHANGED_EVENT = 'app:projects-changed'
export const PROJECTS_LEGACY_SYNC_EVENT = 'app:project-created'

export interface LegacyProjectItem {
  id: string
  name: string
  createdAt: number
}

export interface ProjectRecord extends LegacyProjectItem {
  updatedAt: number
  lastOpenedAt?: number
  canvasStorageKey: string
  chatStorageScopePrefix: string
  defaultQAppKey: string
  storageDirName: string
}

const normalizeText = (value: unknown): string => String(value ?? '').trim()
export { buildProjectStorageDirName }

const normalizeTimestamp = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const normalizeOptionalTimestamp = (value: unknown): number | undefined => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

const normalizeStoredProjectStorageDirName = (
  value: unknown,
  projectName: string,
  projectId: string
): string => {
  const stored = normalizeText(value)
  if (!stored) {
    return buildProjectStorageDirName(projectName, projectId)
  }

  return normalizeGeneratedRootDirName(stored) || buildProjectStorageDirName(projectName, projectId)
}

const readStoredProjectQAppKey = (projectId: string): string => {
  try {
    return (
      localStorage.getItem(`qapp.currentQAppKey.${projectId}`) ||
      localStorage.getItem('qapp.currentQAppKey') ||
      ''
    )
  } catch {
    return ''
  }
}

const dispatchProjectsChanged = (): void => {
  window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT))
  window.dispatchEvent(new CustomEvent(PROJECTS_LEGACY_SYNC_EVENT))
}

const toLegacyProjects = (projects: ProjectRecord[]): LegacyProjectItem[] =>
  projects.map(({ id, name, createdAt }) => ({
    id,
    name,
    createdAt
  }))

const toProjectRecord = (
  value: Partial<ProjectRecord> | LegacyProjectItem | null | undefined
): ProjectRecord | null => {
  const id = normalizeText(value?.id)
  const name = normalizeText(value?.name)
  if (!id || !name) return null

  const createdAt = normalizeTimestamp(value?.createdAt, Date.now())
  const updatedAt = normalizeTimestamp((value as ProjectRecord | undefined)?.updatedAt, createdAt)
  const lastOpenedAt = normalizeOptionalTimestamp(
    (value as ProjectRecord | undefined)?.lastOpenedAt
  )
  const defaultQAppKey =
    normalizeText((value as ProjectRecord | undefined)?.defaultQAppKey) ||
    readStoredProjectQAppKey(id)

  return {
    id,
    name,
    createdAt,
    updatedAt,
    canvasStorageKey: normalizeText((value as ProjectRecord | undefined)?.canvasStorageKey) || id,
    chatStorageScopePrefix:
      normalizeText((value as ProjectRecord | undefined)?.chatStorageScopePrefix) || id,
    defaultQAppKey,
    storageDirName: normalizeStoredProjectStorageDirName(
      (value as ProjectRecord | undefined)?.storageDirName,
      name,
      id
    ),
    ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {})
  }
}

const readProjectArray = <T>(storageKey: string): T[] => {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

const writeProjectArray = (storageKey: string, value: unknown): void => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value))
  } catch {
    /* ignore storage failures */
  }
}

const persistProjects = (projects: ProjectRecord[], emitEvent: boolean): ProjectRecord[] => {
  const normalized = projects
    .map((project) => toProjectRecord(project))
    .filter((project): project is ProjectRecord => Boolean(project))

  writeProjectArray(PROJECTS_STORAGE_KEY, normalized)
  writeProjectArray(LEGACY_PROJECTS_STORAGE_KEY, toLegacyProjects(normalized))

  if (emitEvent) {
    dispatchProjectsChanged()
  }

  return normalized
}

const migrateLegacyProjects = (): ProjectRecord[] => {
  const migrated = readProjectArray<LegacyProjectItem>(LEGACY_PROJECTS_STORAGE_KEY)
    .map((project) => toProjectRecord(project))
    .filter((project): project is ProjectRecord => Boolean(project))

  if (migrated.length === 0) {
    return []
  }

  return persistProjects(migrated, false)
}

export const listProjects = (): ProjectRecord[] => {
  const stored = readProjectArray<ProjectRecord>(PROJECTS_STORAGE_KEY)
    .map((project) => toProjectRecord(project))
    .filter((project): project is ProjectRecord => Boolean(project))

  if (stored.length > 0) {
    const normalized = persistProjects(stored, false)
    return normalized
  }

  return migrateLegacyProjects()
}

export const saveProjects = (projects: ProjectRecord[]): ProjectRecord[] =>
  persistProjects(projects, true)

export const createProjectRecord = (project: LegacyProjectItem): ProjectRecord => {
  const createdAt = normalizeTimestamp(project.createdAt, Date.now())
  return {
    id: project.id,
    name: project.name,
    createdAt,
    updatedAt: createdAt,
    canvasStorageKey: project.id,
    chatStorageScopePrefix: project.id,
    defaultQAppKey: readStoredProjectQAppKey(project.id),
    storageDirName: buildProjectStorageDirName(project.name, project.id)
  }
}

export const updateProjectName = (projectId: string, name: string): ProjectRecord[] => {
  const trimmed = normalizeText(name)
  if (!projectId || !trimmed) {
    return listProjects()
  }

  const next = listProjects().map((project) =>
    project.id === projectId
      ? {
          ...project,
          name: trimmed,
          updatedAt: Date.now()
        }
      : project
  )
  return saveProjects(next)
}

export const touchProjectOpen = (projectId: string): ProjectRecord[] => {
  if (!projectId) {
    return listProjects()
  }

  const now = Date.now()
  const next = listProjects().map((project) =>
    project.id === projectId
      ? {
          ...project,
          updatedAt: now,
          lastOpenedAt: now
        }
      : project
  )
  return saveProjects(next)
}

export const setProjectDefaultQAppKey = (
  projectId: string | undefined,
  qAppKey: string
): ProjectRecord[] => {
  const normalizedProjectId = normalizeText(projectId)
  if (!normalizedProjectId) {
    return listProjects()
  }

  const next = listProjects().map((project) =>
    project.id === normalizedProjectId
      ? {
          ...project,
          updatedAt: Date.now(),
          defaultQAppKey: normalizeText(qAppKey)
        }
      : project
  )
  return saveProjects(next)
}

export const getProjectById = (projectId: string): ProjectRecord | undefined =>
  listProjects().find((project) => project.id === projectId)
