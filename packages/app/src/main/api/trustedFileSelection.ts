const TRUSTED_SELECTION_TTL_MS = 2 * 60 * 1000
const MAX_TRUSTED_SELECTIONS = 200

type TrustedFileSelection = {
  path: string
  expiresAt: number
}

const trustedFileSelections = new Map<string, TrustedFileSelection>()

const normalizeTrustedFilePath = (filePath: string): string => String(filePath || '').trim()

const pruneTrustedFileSelections = (now = Date.now()): void => {
  for (const [key, selection] of trustedFileSelections.entries()) {
    if (selection.expiresAt <= now) {
      trustedFileSelections.delete(key)
    }
  }

  while (trustedFileSelections.size > MAX_TRUSTED_SELECTIONS) {
    const oldestKey = trustedFileSelections.keys().next().value
    if (!oldestKey) break
    trustedFileSelections.delete(oldestKey)
  }
}

export const rememberTrustedLocalFileSelections = (
  filePaths: readonly string[],
  now = Date.now()
): void => {
  pruneTrustedFileSelections(now)
  const expiresAt = now + TRUSTED_SELECTION_TTL_MS

  for (const filePath of filePaths) {
    const normalized = normalizeTrustedFilePath(filePath)
    if (!normalized) continue
    trustedFileSelections.set(normalized, { path: normalized, expiresAt })
  }

  pruneTrustedFileSelections(now)
}

export const consumeTrustedLocalFileSelection = (filePath: string, now = Date.now()): string => {
  const normalized = normalizeTrustedFilePath(filePath)
  pruneTrustedFileSelections(now)

  const selection = trustedFileSelections.get(normalized)
  if (!selection || selection.expiresAt <= now) {
    throw new Error('[FileAccess] Local file path was not selected through a trusted dialog.')
  }

  trustedFileSelections.delete(normalized)
  return selection.path
}

export const clearTrustedLocalFileSelectionsForTest = (): void => {
  trustedFileSelections.clear()
}
