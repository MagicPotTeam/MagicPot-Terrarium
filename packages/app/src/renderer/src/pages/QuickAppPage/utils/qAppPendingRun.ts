export type PendingQAppRun = {
  promptId: string
  qAppKey: string
  projectId?: string
  createdAt: number
}

const PENDING_QAPP_RUN_PREFIX = 'qapp.pendingRun.'

const normalizeStoragePart = (value?: string): string => {
  const trimmed = value?.trim()
  return trimmed || 'default'
}

const getPendingQAppRunStorageKey = (qAppKey: string, projectId?: string): string =>
  `${PENDING_QAPP_RUN_PREFIX}${normalizeStoragePart(projectId)}.${normalizeStoragePart(qAppKey)}`

export const writePendingQAppRun = (detail: Omit<PendingQAppRun, 'createdAt'>): void => {
  const qAppKey = detail.qAppKey.trim()
  const promptId = detail.promptId.trim()
  if (!qAppKey || !promptId) return

  const nextValue: PendingQAppRun = {
    promptId,
    qAppKey,
    projectId: detail.projectId?.trim() || undefined,
    createdAt: Date.now()
  }

  try {
    localStorage.setItem(
      getPendingQAppRunStorageKey(nextValue.qAppKey, nextValue.projectId),
      JSON.stringify(nextValue)
    )
  } catch {
    /* ignore storage failures */
  }
}

export const readPendingQAppRun = (qAppKey: string, projectId?: string): PendingQAppRun | null => {
  const normalizedQAppKey = qAppKey.trim()
  if (!normalizedQAppKey) return null

  try {
    const raw = localStorage.getItem(getPendingQAppRunStorageKey(normalizedQAppKey, projectId))
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<PendingQAppRun>
    if (typeof parsed?.promptId !== 'string' || !parsed.promptId.trim()) {
      return null
    }

    if (typeof parsed.qAppKey !== 'string' || parsed.qAppKey.trim() !== normalizedQAppKey) {
      return null
    }

    return {
      promptId: parsed.promptId.trim(),
      qAppKey: normalizedQAppKey,
      projectId:
        typeof parsed.projectId === 'string' && parsed.projectId.trim()
          ? parsed.projectId
          : undefined,
      createdAt: Number.isFinite(parsed.createdAt) ? Number(parsed.createdAt) : 0
    }
  } catch {
    return null
  }
}

export const clearPendingQAppRun = (qAppKey: string, projectId?: string): void => {
  const normalizedQAppKey = qAppKey.trim()
  if (!normalizedQAppKey) return

  try {
    localStorage.removeItem(getPendingQAppRunStorageKey(normalizedQAppKey, projectId))
  } catch {
    /* ignore storage failures */
  }
}
