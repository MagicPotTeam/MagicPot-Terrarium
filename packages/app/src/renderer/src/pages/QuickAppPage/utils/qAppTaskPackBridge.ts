export const QAPP_APPLY_TASK_PACK_EVENT = 'qapp:apply-task-pack'

export type QAppTaskPackImageSource = {
  src: string
  fileName: string
}

export type QAppApplyTaskPackDetail = {
  qAppKey: string
  promptText: string
  referenceImages: QAppTaskPackImageSource[]
  generationSessionId?: string
}

const PENDING_QAPP_TASK_PACK_PREFIX = 'qapp.pendingTaskPack.'

const getPendingQAppTaskPackStorageKey = (qAppKey: string): string =>
  `${PENDING_QAPP_TASK_PACK_PREFIX}${qAppKey.trim()}`

export const writePendingQAppTaskPack = (detail: QAppApplyTaskPackDetail): void => {
  if (!detail.qAppKey.trim()) return

  try {
    localStorage.setItem(getPendingQAppTaskPackStorageKey(detail.qAppKey), JSON.stringify(detail))
  } catch {
    /* ignore storage failures */
  }
}

export const readPendingQAppTaskPack = (qAppKey: string): QAppApplyTaskPackDetail | null => {
  const normalizedQAppKey = qAppKey.trim()
  if (!normalizedQAppKey) return null

  try {
    const raw = localStorage.getItem(getPendingQAppTaskPackStorageKey(normalizedQAppKey))
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<QAppApplyTaskPackDetail>
    if (
      typeof parsed?.qAppKey !== 'string' ||
      typeof parsed.promptText !== 'string' ||
      !Array.isArray(parsed.referenceImages)
    ) {
      return null
    }

    return {
      qAppKey: parsed.qAppKey,
      promptText: parsed.promptText,
      generationSessionId:
        typeof parsed.generationSessionId === 'string' && parsed.generationSessionId.trim()
          ? parsed.generationSessionId
          : undefined,
      referenceImages: parsed.referenceImages
        .map((entry) =>
          entry &&
          typeof entry === 'object' &&
          typeof entry.src === 'string' &&
          typeof entry.fileName === 'string'
            ? { src: entry.src, fileName: entry.fileName }
            : null
        )
        .filter((entry): entry is QAppTaskPackImageSource => Boolean(entry))
    }
  } catch {
    return null
  }
}

export const readPendingQAppGenerationSessionId = (qAppKey: string): string | null =>
  readPendingQAppTaskPack(qAppKey)?.generationSessionId ?? null

export const clearPendingQAppTaskPack = (qAppKey: string): void => {
  const normalizedQAppKey = qAppKey.trim()
  if (!normalizedQAppKey) return

  try {
    localStorage.removeItem(getPendingQAppTaskPackStorageKey(normalizedQAppKey))
  } catch {
    /* ignore storage failures */
  }
}
