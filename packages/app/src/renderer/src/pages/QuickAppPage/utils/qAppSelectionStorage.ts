import { setProjectDefaultQAppKey } from '@renderer/pages/MainPage/projectStore'

const LEGACY_QAPP_STORAGE_KEY = 'qapp.currentQAppKey'

export const getProjectQAppStorageKey = (projectId?: string): string =>
  projectId ? `qapp.currentQAppKey.${projectId}` : LEGACY_QAPP_STORAGE_KEY

export const readCurrentQAppKey = (projectId?: string): string => {
  const storageKey = getProjectQAppStorageKey(projectId)

  try {
    return localStorage.getItem(storageKey) || localStorage.getItem(LEGACY_QAPP_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export const persistCurrentQAppKey = (projectId: string | undefined, qAppKey: string): void => {
  const storageKey = getProjectQAppStorageKey(projectId)
  const normalizedQAppKey = qAppKey.trim()

  try {
    if (normalizedQAppKey) {
      localStorage.setItem(storageKey, normalizedQAppKey)
      localStorage.setItem(LEGACY_QAPP_STORAGE_KEY, normalizedQAppKey)
      setProjectDefaultQAppKey(projectId, normalizedQAppKey)
      return
    }

    localStorage.removeItem(storageKey)
    localStorage.removeItem(LEGACY_QAPP_STORAGE_KEY)
    setProjectDefaultQAppKey(projectId, '')
  } catch {
    /* ignore storage failures */
  }
}
