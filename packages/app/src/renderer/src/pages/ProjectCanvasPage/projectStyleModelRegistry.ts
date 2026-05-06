export type ProjectStyleModelOption = {
  id: string
  label: string
  description?: string
  qAppKey?: string
  qAppName?: string
  createdAt: string
}

const STORAGE_PREFIX = 'project-style-models.'

function getStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId.trim() || 'default'}`
}

function normalizeText(value: string | undefined): string {
  return (value || '').trim()
}

function normalizeOption(option: Partial<ProjectStyleModelOption>): ProjectStyleModelOption | null {
  const label = normalizeText(option.label)
  if (!label) return null

  const id =
    normalizeText(option.id) ||
    `project-style-model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const createdAt = normalizeText(option.createdAt) || new Date().toISOString()
  const description = normalizeText(option.description)
  const qAppKey = normalizeText(option.qAppKey)
  const qAppName = normalizeText(option.qAppName) || qAppKey

  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(qAppKey ? { qAppKey } : {}),
    ...(qAppName ? { qAppName } : {}),
    createdAt
  }
}

export function listProjectStyleModels(projectId: string): ProjectStyleModelOption[] {
  try {
    const raw = localStorage.getItem(getStorageKey(projectId))
    if (!raw) return []

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    const normalized = parsed
      .map((entry) => normalizeOption(entry as Partial<ProjectStyleModelOption>))
      .filter((entry): entry is ProjectStyleModelOption => Boolean(entry))

    const deduped: ProjectStyleModelOption[] = []
    const seen = new Set<string>()
    for (const entry of normalized) {
      const dedupeKey = `${entry.id}::${entry.label.toLowerCase()}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      deduped.push(entry)
    }

    return deduped
  } catch {
    return []
  }
}

function saveProjectStyleModels(
  projectId: string,
  models: ProjectStyleModelOption[]
): ProjectStyleModelOption[] {
  const normalized = models
    .map((entry) => normalizeOption(entry))
    .filter((entry): entry is ProjectStyleModelOption => Boolean(entry))

  try {
    localStorage.setItem(getStorageKey(projectId), JSON.stringify(normalized))
  } catch {
    /* ignore */
  }

  return normalized
}

export function upsertProjectStyleModel(
  projectId: string,
  option: Pick<ProjectStyleModelOption, 'label'> & Partial<ProjectStyleModelOption>
): { models: ProjectStyleModelOption[]; added: ProjectStyleModelOption | null } {
  const normalized = normalizeOption(option)
  if (!normalized) {
    return {
      models: listProjectStyleModels(projectId),
      added: null
    }
  }

  const current = listProjectStyleModels(projectId)
  const existingIndex = current.findIndex(
    (entry) =>
      entry.id === normalized.id ||
      entry.label.trim().toLowerCase() === normalized.label.trim().toLowerCase()
  )

  const next = [...current]
  if (existingIndex >= 0) {
    const existing = next[existingIndex]
    next[existingIndex] = {
      ...existing,
      ...normalized,
      createdAt: existing.createdAt
    }
  } else {
    next.push(normalized)
  }

  const models = saveProjectStyleModels(projectId, next)
  const added =
    models.find((entry) => entry.id === normalized.id || entry.label === normalized.label) ||
    normalized

  return { models, added }
}

export function removeProjectStyleModel(
  projectId: string,
  modelId: string
): ProjectStyleModelOption[] {
  const targetId = normalizeText(modelId)
  if (!targetId) return listProjectStyleModels(projectId)

  const next = listProjectStyleModels(projectId).filter((entry) => entry.id !== targetId)
  return saveProjectStyleModels(projectId, next)
}
