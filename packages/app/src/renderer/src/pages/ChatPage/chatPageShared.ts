import type { Hy3dParams } from './hy3d/types'
import { getFileNameHintFromUrl } from '@shared/utils/urlFileHints'

export interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null
  onend: ((this: SpeechRecognition, ev: Event) => void) | null
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
}

export interface SpeechRecognitionConstructor {
  new (): SpeechRecognition
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

export interface SpeechRecognitionEvent extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}

export interface SpeechRecognitionErrorEvent extends Event {
  error: string
  message: string
}

export interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

export interface SpeechRecognitionResult {
  readonly length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
  isFinal: boolean
}

export interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

export const STORAGE_KEY_CURRENT_SESSION_ID = 'chat.currentSessionId'
export const STORAGE_KEY_SELECTED_PROFILE = 'chat.selectedProfileId'
export const STORAGE_KEY_LOADING_IDS = 'chat.loadingSessionIds'
export const STORAGE_KEY_EXTERNAL_LOADING_IDS = 'chat.externalLoadingSessionIds'
export const HUNYUAN_3D_PROFILE_ID = 'hunyuan3d-pro'
export const MODEL3D_FILE_EXTENSIONS = [
  '.glb',
  '.gltf',
  '.obj',
  '.fbx',
  '.dae',
  '.3ds',
  '.ply',
  '.stl'
]

export const scopedStorageKey = (baseKey: string, scope: string): string =>
  scope === 'default' ? baseKey : `${baseKey}.${scope}`

export const AUTO_SAVED_CHAT_IMAGE_TRACKER_LIMIT = 512

export interface AutoSavedChatImageKeyParts {
  sessionId: string
  messageIndex: number
  attachmentIndex: number
  url: string
}

export const getAutoSavedChatImageShortHash = (value: string): string => {
  let hash = 0x811c9dc5

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 8)
}

export const buildAutoSavedChatImageKey = ({
  sessionId,
  messageIndex,
  attachmentIndex,
  url
}: AutoSavedChatImageKeyParts): string =>
  [
    'chat-img',
    encodeURIComponent(sessionId || 'unknown'),
    `m${Math.max(0, messageIndex)}`,
    `a${Math.max(0, attachmentIndex)}`,
    getAutoSavedChatImageShortHash(url)
  ].join(':')

const compactAutoSavedChatImageTrackerKey = (value: string): string =>
  value.startsWith('chat-img:') ? value : `chat-img:legacy:${getAutoSavedChatImageShortHash(value)}`

class BoundedAutoSavedChatImageTracker implements Iterable<string> {
  private readonly keys = new Set<string>()

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.keys.size
  }

  add(value: string): this {
    const key = compactAutoSavedChatImageTrackerKey(value)

    if (this.keys.has(key)) {
      return this
    }

    this.keys.add(key)

    while (this.keys.size > this.limit) {
      const oldestKey = this.keys.values().next().value
      if (typeof oldestKey !== 'string') break
      this.keys.delete(oldestKey)
    }

    return this
  }

  clear(): void {
    this.keys.clear()
  }

  delete(value: string): boolean {
    return this.keys.delete(compactAutoSavedChatImageTrackerKey(value))
  }

  has(value: string): boolean {
    return this.keys.has(compactAutoSavedChatImageTrackerKey(value))
  }

  values(): IterableIterator<string> {
    return this.keys.values()
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.values()
  }
}

export const autoSavedChatImageTracker = new BoundedAutoSavedChatImageTracker(
  AUTO_SAVED_CHAT_IMAGE_TRACKER_LIMIT
)

export const recordAutoSavedChatImageKey = (key: string): void => {
  autoSavedChatImageTracker.add(key)
}

export const hasAutoSavedChatImageKey = (key: string): boolean => autoSavedChatImageTracker.has(key)

const readStoredSessionIds = (storageKey: string): string[] => {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []

    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
  } catch {
    return []
  }
}

const externalLoadingSessionIdsByScope = new Map<string, Set<string>>()

export const getScopedLoadingIdsStorageKey = (scope: string): string =>
  scopedStorageKey(STORAGE_KEY_LOADING_IDS, scope)

export const getScopedExternalLoadingIdsStorageKey = (scope: string): string =>
  scopedStorageKey(STORAGE_KEY_EXTERNAL_LOADING_IDS, scope)

const clearLegacyExternalLoadingSessionIds = (scope: string): void => {
  try {
    localStorage.removeItem(getScopedExternalLoadingIdsStorageKey(scope))
  } catch {
    /* ignore storage failures */
  }
}

export const clearScopedExternalLoadingSessionIds = (scope?: string): void => {
  if (scope) {
    externalLoadingSessionIdsByScope.delete(scope)
    clearLegacyExternalLoadingSessionIds(scope)
    return
  }

  externalLoadingSessionIdsByScope.clear()
}

export const readScopedExternalLoadingSessionIds = (scope: string): string[] => {
  clearLegacyExternalLoadingSessionIds(scope)
  return [...(externalLoadingSessionIdsByScope.get(scope) || new Set<string>())]
}

export const readScopedLoadingSessionIds = (scope: string): string[] =>
  Array.from(
    new Set([
      ...readStoredSessionIds(getScopedLoadingIdsStorageKey(scope)),
      ...readScopedExternalLoadingSessionIds(scope)
    ])
  )

export const updateScopedExternalLoadingSessionId = (
  scope: string,
  sessionId: string,
  loading: boolean
): string[] => {
  const nextIds = new Set(externalLoadingSessionIdsByScope.get(scope) || [])

  if (loading) {
    nextIds.add(sessionId)
  } else {
    nextIds.delete(sessionId)
  }

  if (nextIds.size > 0) {
    externalLoadingSessionIdsByScope.set(scope, nextIds)
  } else {
    externalLoadingSessionIdsByScope.delete(scope)
  }

  clearLegacyExternalLoadingSessionIds(scope)

  return [...nextIds]
}

export const getBaseProfileId = (profileId: string | null | undefined): string | null => {
  if (!profileId) return null

  const [baseProfileId] = profileId.split('::')
  return baseProfileId || null
}

export const normalizeChatProfileIdForStorage = (
  profileId: string | null | undefined
): string | undefined => {
  const normalizedProfileId = String(profileId || '').trim()
  if (!normalizedProfileId) return undefined

  return getBaseProfileId(normalizedProfileId) ?? undefined
}

export const buildHy3dProfileId = (params: Hy3dParams): string => {
  const hy3dEnablePBR =
    params.apiAction === 'SubmitTextureTo3DJob' ? params.textureEnablePBR : params.enablePBR

  const profileSegments = [
    HUNYUAN_3D_PROFILE_ID,
    params.apiAction,
    params.modelVersion,
    params.generateType,
    String(params.faceCount),
    params.apiAction === 'Convert3DFormat' ? params.convertTargetFormat : params.targetFormat,
    params.apiAction === 'SubmitReduceFaceJob' ? params.topoFaceLevel || 'low' : params.polygonType,
    params.polygonType || 'triangle',
    hy3dEnablePBR ? '1' : '0',
    params.profileTemplate || 'DEFAULT'
  ]

  const encodedModelSourceFileName = encodeURIComponent(params.modelSourceFileName || '')
  if (encodedModelSourceFileName) {
    profileSegments.push(encodedModelSourceFileName)
  }

  return profileSegments.join('::')
}

export const normalizeLocalMediaUrl = (url: string): string => {
  if (!url) return url
  if (url.startsWith('local-media://')) return url
  if (url.startsWith('file:///')) {
    return `local-media:///${url.slice('file:///'.length)}`
  }
  if (url.startsWith('file://')) {
    return `local-media:///${url.slice('file://'.length).replace(/^\/+/, '')}`
  }
  return url
}

export const getDownloadFileNameFromUrl = (url: string, fallback: string): string => {
  try {
    const normalized = normalizeLocalMediaUrl(url)
    const hintedFileName = getFileNameHintFromUrl(normalized)
    if (hintedFileName) {
      return hintedFileName
    }

    if (normalized.startsWith('local-media://')) {
      const filePath = decodeURIComponent(normalized.replace('local-media://', ''))
      return filePath.split(/[\\/]/).pop() || fallback
    }

    return decodeURIComponent(new URL(normalized).pathname.split('/').pop() || fallback)
  } catch {
    return fallback
  }
}

export const isModel3DUrl = (url: string): boolean => {
  const hintedFileName = getFileNameHintFromUrl(normalizeLocalMediaUrl(url)).toLowerCase()
  if (hintedFileName) {
    return MODEL3D_FILE_EXTENSIONS.some((ext) => hintedFileName.endsWith(ext))
  }

  try {
    const pathname = new URL(normalizeLocalMediaUrl(url)).pathname.toLowerCase()
    return MODEL3D_FILE_EXTENSIONS.some((ext) => pathname.includes(ext))
  } catch {
    const normalized = url.toLowerCase()
    return MODEL3D_FILE_EXTENSIONS.some((ext) => normalized.includes(ext))
  }
}

export const generateUUID = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
