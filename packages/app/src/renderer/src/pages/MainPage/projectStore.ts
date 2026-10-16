import { buildProjectStorageDirName, normalizeGeneratedRootDirName } from '@shared/projectStorage'

export const PROJECTS_STORAGE_KEY = 'magicpot.projects.v1'
export const LEGACY_PROJECTS_STORAGE_KEY = 'ai_engine_projects'
export const PROJECTS_CHANGED_EVENT = 'app:projects-changed'
export const PROJECTS_LEGACY_SYNC_EVENT = 'app:project-created'
export const PROJECT_NAME_MAX_LENGTH = 120
export const PROJECT_INTRODUCTION_MAX_LENGTH = 4000
export const PROJECT_ANALYSIS_PROFILE_ID_MAX_LENGTH = 512

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
  introduction?: string
  analysisProfileId?: string
  analysisMode?: 'manual'
}

export type ProjectAnalysisDetails = Pick<ProjectRecord, 'introduction' | 'analysisProfileId'>

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

const normalizeAnalysisDetails = (value: ProjectAnalysisDetails): ProjectAnalysisDetails => ({
  ...(typeof value.introduction === 'string' &&
  value.introduction.length <= PROJECT_INTRODUCTION_MAX_LENGTH
    ? { introduction: value.introduction }
    : {}),
  ...(typeof value.analysisProfileId === 'string' &&
  value.analysisProfileId.trim() &&
  value.analysisProfileId.length <= PROJECT_ANALYSIS_PROFILE_ID_MAX_LENGTH
    ? { analysisProfileId: value.analysisProfileId }
    : {})
})

const validateAnalysisDetails = (value: ProjectAnalysisDetails): void => {
  if (
    (value.introduction !== undefined &&
      (typeof value.introduction !== 'string' ||
        value.introduction.length > PROJECT_INTRODUCTION_MAX_LENGTH)) ||
    (value.analysisProfileId !== undefined &&
      (typeof value.analysisProfileId !== 'string' ||
        value.analysisProfileId.length > PROJECT_ANALYSIS_PROFILE_ID_MAX_LENGTH))
  ) {
    throw new Error('Invalid project analysis details.')
  }
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

  const record = value as Partial<ProjectRecord>
  const createdAt = normalizeTimestamp(record.createdAt, Date.now())
  const updatedAt = normalizeTimestamp(record.updatedAt, createdAt)
  const lastOpenedAt = normalizeOptionalTimestamp(record.lastOpenedAt)
  const defaultQAppKey = normalizeText(record.defaultQAppKey) || readStoredProjectQAppKey(id)

  return {
    id,
    name,
    createdAt,
    updatedAt,
    canvasStorageKey: normalizeText(record.canvasStorageKey) || id,
    chatStorageScopePrefix: normalizeText(record.chatStorageScopePrefix) || id,
    defaultQAppKey,
    storageDirName: normalizeStoredProjectStorageDirName(record.storageDirName, name, id),
    ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}),
    ...normalizeAnalysisDetails(record),
    ...(record.analysisMode === 'manual' ? { analysisMode: 'manual' as const } : {})
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

const writeProjectArray = (storageKey: string, value: unknown): boolean => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

const normalizeProjects = (projects: ProjectRecord[]): ProjectRecord[] =>
  projects.map(toProjectRecord).filter((project): project is ProjectRecord => Boolean(project))

const persistProjects = (projects: ProjectRecord[], emitEvent: boolean): ProjectRecord[] => {
  const normalized = normalizeProjects(projects)
  writeProjectArray(PROJECTS_STORAGE_KEY, normalized)
  writeProjectArray(LEGACY_PROJECTS_STORAGE_KEY, toLegacyProjects(normalized))

  if (emitEvent) {
    dispatchProjectsChanged()
  }

  return normalized
}

const migrateLegacyProjects = (): ProjectRecord[] => {
  const migrated = readProjectArray<LegacyProjectItem>(LEGACY_PROJECTS_STORAGE_KEY)
    .map(toProjectRecord)
    .filter((project): project is ProjectRecord => Boolean(project))

  if (migrated.length === 0) {
    return []
  }

  return persistProjects(migrated, false)
}

export const listProjects = (): ProjectRecord[] => {
  const stored = readProjectArray<ProjectRecord>(PROJECTS_STORAGE_KEY)
    .map(toProjectRecord)
    .filter((project): project is ProjectRecord => Boolean(project))

  if (stored.length > 0) {
    return persistProjects(stored, false)
  }

  return migrateLegacyProjects()
}

export const saveProjects = (projects: ProjectRecord[]): ProjectRecord[] =>
  persistProjects(projects, true)

// Explicit form saves require the authoritative registry write to succeed. The
// legacy mirror and read-time migrations retain their best-effort behavior.
export const trySaveProjects = (projects: ProjectRecord[]): ProjectRecord[] | null => {
  const normalized = normalizeProjects(projects)
  if (!writeProjectArray(PROJECTS_STORAGE_KEY, normalized)) return null
  writeProjectArray(LEGACY_PROJECTS_STORAGE_KEY, toLegacyProjects(normalized))
  dispatchProjectsChanged()
  return normalized
}

export const createProjectRecord = (
  project: LegacyProjectItem & ProjectAnalysisDetails
): ProjectRecord => {
  const name = normalizeText(project.name)
  if (!name || typeof project.name !== 'string' || project.name.length > PROJECT_NAME_MAX_LENGTH) {
    throw new Error('Invalid project name.')
  }
  validateAnalysisDetails(project)
  const createdAt = normalizeTimestamp(project.createdAt, Date.now())
  return {
    id: project.id,
    name,
    createdAt,
    updatedAt: createdAt,
    canvasStorageKey: project.id,
    chatStorageScopePrefix: project.id,
    defaultQAppKey: readStoredProjectQAppKey(project.id),
    storageDirName: buildProjectStorageDirName(name, project.id),
    ...normalizeAnalysisDetails(project),
    analysisMode: 'manual'
  }
}

export const updateProjectAnalysisDetails = (
  projectId: string,
  details: ProjectAnalysisDetails
): ProjectRecord[] => {
  validateAnalysisDetails(details)
  const projects = listProjects()
  if (!projects.some((project) => project.id === projectId)) return projects
  const next = projects.map((project) =>
    project.id === projectId
      ? {
          ...project,
          analysisMode: 'manual' as const,
          ...('introduction' in details ? { introduction: details.introduction } : {}),
          ...('analysisProfileId' in details
            ? { analysisProfileId: details.analysisProfileId }
            : {}),
          updatedAt: Date.now()
        }
      : project
  )
  const saved = trySaveProjects(next)
  if (!saved) throw new Error('Unable to save project details.')
  return saved
}

export const updateProjectName = (projectId: string, name: string): ProjectRecord[] => {
  const trimmed = normalizeText(name)
  if (!projectId || !trimmed || name.length > PROJECT_NAME_MAX_LENGTH) {
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
