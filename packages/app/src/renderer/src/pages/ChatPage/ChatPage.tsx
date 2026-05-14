/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Box, Typography, CircularProgress, Alert, Tooltip, useTheme, Button } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@renderer/hooks/useConfig'
import { useRuntimeMcpStatus } from '@renderer/hooks/useRuntimeMcpStatus'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import { resolveAvailableChatProfileId } from '@renderer/utils/llmProfileUtils'
import { DccBridgeTarget, isSupportedDccBridgeModelSourceFormat } from '@shared/api/svcDccBridge'
import {
  cliFromProfile,
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import {
  type ChatCapabilityProfile,
  type LLMReasoningEffort,
  type OpenAIImageGenerationOptions,
  normalizeReasoningEffort,
  resolveChatProfileCapabilities
} from '@shared/llm'
import type { AgentRouteLike } from '@shared/agent'
import type { ProjectTraceEventStatus } from '@shared/projectTrace'
import {
  selectFile,
  fileToBlobUrl,
  fileToDataUrl,
  checkFileSize,
  formatFileSize
} from '@renderer/utils/fileUtils'
import {
  loadAllSessions,
  saveSessionToDB,
  deleteSessionFromDB,
  deleteSessionDraftBackup,
  migrateFromLocalStorage,
  readSessionDraftBackup,
  debouncedSaveAllSessions,
  writeSessionDraftBackup,
  type ChatSession,
  type ChatSessionDraft
} from './chatStorage'
import {
  buildAutoSavedChatImageKey,
  buildHy3dProfileId,
  getBaseProfileId,
  getDownloadFileNameFromUrl,
  hasAutoSavedChatImageKey,
  HUNYUAN_3D_PROFILE_ID,
  normalizeChatProfileIdForStorage,
  normalizeLocalMediaUrl,
  readScopedExternalLoadingSessionIds,
  recordAutoSavedChatImageKey,
  scopedStorageKey,
  STORAGE_KEY_CURRENT_SESSION_ID,
  STORAGE_KEY_LOADING_IDS,
  STORAGE_KEY_SELECTED_PROFILE,
  updateScopedExternalLoadingSessionId
} from './chatPageShared'
import {
  buildChatContextCompressionPlan,
  type ChatContextCompressionSummary
} from './chatContextCompression'
import type { ChatLoadingStatus } from './chatLoadingStatus'
import { buildAssistantMessageFromResult } from './chatMessageUtils'
import {
  appendAssistantDeltaToSession,
  appendAssistantPlaceholderToSession,
  applyUserMessageToSession,
  createChatSession,
  collectAssistantImageUrls,
  filterVisibleSessions,
  mergeLoadedSessionsWithLocal,
  removeTrailingEmptyAssistantMessage,
  replaceLastMessageInSession,
  replaceLastMessageWithMessagesInSession,
  normalizeRestoredSkillSelection,
  sortSessionsByRecencyDesc
} from './chatSessionUtils'
import { getLocalizedConversationTitle } from './chatLocaleUtils'
import {
  requestChatCompletion,
  requestChatCompletionStream,
  resolveAttachmentBatchCapability,
  supportsStreamingChatCompletion
} from './chatRequestUtils'
import {
  NO_SKILL_VALUE,
  buildCustomSkillCategories,
  findCustomSkillById,
  getCustomSkillName,
  getSkillCategoryForSkillId,
  getSkillsForCategory,
  normalizeProfileIdForSkill,
  resolveCustomSkillId
} from './chatSkillUtils'
import { shouldShowNoApiWarning } from './chatAvailability'
import { inspectSkillAttachmentSupport } from './chatSkillAttachmentSupport'
import { augmentAttachmentsWithVideoBoundaryFrames } from './chatVideoAttachmentUtils'
import { normalizeFileMimeType } from '@renderer/utils/fileDisplay'
import {
  buildHy3dSubmissionContent,
  getHy3dMissingInputMessage,
  getHy3dParams,
  getHy3dSubmissionConflictMessage,
  saveHy3dParams
} from './hy3d/types'
import {
  buildAttachmentBatchEntries,
  buildAttachmentBatchPrompt,
  chunkAttachmentBatchEntries,
  parseAttachmentBatchResponse,
  shouldBatchAttachments
} from './chatAttachmentBatchUtils'
import { mergeChatAttachmentsWithSkillReferenceAttachments } from '@renderer/utils/customSkillReferenceAttachments'
import {
  isImageOnlyInternalDragPayload,
  parseInternalImageDragPayload
} from '@renderer/utils/droppedImageUtils'
import { collectDroppedDirectoryFiles } from '../ProjectCanvasPage/dropDirectory'
import {
  BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
  BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
  mergeBuiltInSkills
} from './builtInSkills'
import { hasDroppedDirectory, resolveDroppedDirectoryImageFiles } from './chatDropFileUtils'
import {
  resolveTaggingSkillBootstrapProfileId,
  resolveTaggingSkillProfileId
} from './chatTaggingProfileUtils'
import { resolveSkillExecutionContext } from './chatTaggingExecutionUtils'
import { buildMagicPotAppCatalog, enrichMagicPotAppCatalogWithRuntime } from '@shared/app/catalog'
import {
  buildSkillRuntimeCapabilityContext,
  serializeSkillRuntimeSpec,
  buildSystemPromptFromSkillRuntime,
  buildUserPromptFromSkillRuntime,
  resolveSkillRuntimeSpec
} from './chatSkillRuntime'
import {
  buildSkillRuntimeResourceContext,
  resolveSkillRuntimeResourceEntries
} from './chatSkillRuntimeResources'
import {
  buildSkillRuntimePreScriptContext,
  resolveSkillRuntimePreScripts,
  runSkillRuntimePostScripts
} from './chatSkillRuntimeScripts'
import {
  executeExplicitSkillToolCommand,
  parseExplicitToolCommand,
  resolveAllowedSkillTools
} from './chatToolExecution'
import { getQAppPromptSettings } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/qAppPromptSettings'
import { emitProjectTraceRuntimeEvent } from '@renderer/features/projectTrace/projectTraceRuntime'
import {
  resolveProjectIdFromStorageScope,
  resolveProjectResourceDir
} from '@renderer/utils/projectResourcePaths'

// Hooks
import { useImagePreview } from './hooks/useImagePreview'
import { useSpeechRecognition } from './hooks/useSpeechRecognition'
import { useChatProfiles } from './hooks/useChatProfiles'

// Components
import SessionSidebar from './components/SessionSidebar'
import SessionHistoryDialog from './components/SessionHistoryDialog'
import ChatMessageList, { type ChatPendingConfirmation } from './components/ChatMessageList'
import ChatComposer from './components/ChatComposer'
import ImagePreviewOverlay from './components/ImagePreviewOverlay'
import ImageContextMenu from './components/ImageContextMenu'
import ChatPrimarySelection from './components/ChatPrimarySelection'
import ChatSkillPicker from './components/ChatSkillPicker'
import ChatImageGenerationSettings from './components/ChatImageGenerationSettings'
import { DEFAULT_CHAT_IMAGE_GENERATION_OPTIONS } from './components/ChatImageGenerationSettings.constants'

interface ChatPageProps {
  storageScope?: string
  route?: AgentRouteLike
  acceptExternalInput?: boolean
  active?: boolean
  compact?: boolean
}

type ExternalSendToAgentDetail = {
  image?: string
  text?: string
  hiddenText?: string
  attachment?: ChatAttachment
  attachments?: ChatAttachment[]
  scope?: string
  targetScope?: string
  autoSend?: boolean
}

type ExternalInitialChatMessage = {
  role: ChatMessage['role']
  content?: string
  attachments?: ChatAttachment[]
  ocrResult?: ChatMessage['ocrResult']
  modelName?: string
}

type ExternalConfirmationRequest = ChatPendingConfirmation & {
  sessionId: string
  confirmedUserContent: string
  cancelledUserContent: string
}

const HY3D_SIGNED_URL_REFRESH_BUFFER_MS = 5 * 60 * 1000
const CHAT_DRAFT_PERSIST_DELAY_MS = 200
const CHAT_MODEL3D_EXTENSIONS = ['.glb', '.gltf', '.obj', '.fbx', '.dae', '.3ds', '.ply', '.stl']
const STORAGE_KEY_REASONING_EFFORT = 'chat.reasoningEffort'
const STORAGE_KEY_IMAGE_GENERATION_OPTIONS = 'chat.imageGenerationOptions'
const CHAT_REASONING_EFFORT_SYNC_EVENT = 'chat:reasoning-effort-sync'
const AUTO_CONTEXT_COMPRESSION_TRIGGER_PERCENT = 80
const HY3D_POST_PROCESS_ACTIONS = new Set([
  'SubmitHunyuan3DPartJob',
  'SubmitReduceFaceJob',
  'SubmitHunyuanTo3DUVJob',
  'SubmitTextureTo3DJob',
  'Convert3DFormat'
])

function resolveTraceProjectIdFromAgentRoute(route?: AgentRouteLike): string | undefined {
  return route?.channel === 'canvas' && route.scopeId ? route.scopeId : undefined
}

function summarizeChatAttachmentKindsForTrace(attachments?: ChatAttachment[]): string[] {
  return Array.from(new Set((attachments || []).map((attachment) => attachment.type))).slice(0, 12)
}

const getFriendlyHy3dRuntimeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || '')
  if (
    message.includes("No handler registered for 'svcLLMProxy.uploadHy3DModel'") ||
    message.includes("No handler registered for 'svcLLMProxy.signHy3DModel'")
  ) {
    return '当前运行中的主进程还是旧版本，Hy3D 本地上传能力尚未加载。请完全退出应用后重新启动一次。'
  }
  return message || 'Hy3D 模型链接处理失败'
}

const getChatAttachmentTypeForFile = (
  file: Pick<File, 'name' | 'type'>
): ChatAttachment['type'] => {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'

  const extensionIndex = file.name.lastIndexOf('.')
  const extension = extensionIndex >= 0 ? file.name.toLowerCase().slice(extensionIndex) : ''
  if (CHAT_MODEL3D_EXTENSIONS.includes(extension)) return 'model3d'

  return 'file'
}

const getChatAttachmentMaxSizeMB = (type: ChatAttachment['type']): number => {
  if (type === 'video') return 500
  if (type === 'model3d') return 200
  return 50
}

const getLocalFilePath = (file: File): string =>
  typeof (file as any).path === 'string' ? (file as any).path.replace(/\\/g, '/') : ''

const cloneChatAttachment = (attachment: ChatAttachment): ChatAttachment => ({ ...attachment })

const cloneChatSessionDraft = (draft?: ChatSessionDraft | null): ChatSessionDraft | undefined =>
  draft
    ? {
        ...draft,
        pendingAttachments: draft.pendingAttachments.map(cloneChatAttachment)
      }
    : undefined

const normalizeChatSessionDraft = (
  draft?: Partial<ChatSessionDraft> | null
): ChatSessionDraft | undefined => {
  if (!draft) {
    return undefined
  }

  const inputValue = typeof draft.inputValue === 'string' ? draft.inputValue : ''
  const pendingHiddenContext =
    typeof draft.pendingHiddenContext === 'string' ? draft.pendingHiddenContext : ''
  const pendingAttachments = Array.isArray(draft.pendingAttachments)
    ? draft.pendingAttachments.map(cloneChatAttachment)
    : []
  const updatedAt =
    typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt)
      ? draft.updatedAt
      : Date.now()

  if (!inputValue && !pendingHiddenContext && pendingAttachments.length === 0) {
    return undefined
  }

  return {
    inputValue,
    pendingHiddenContext,
    pendingAttachments,
    updatedAt
  }
}

const buildChatDraftComparableValue = (
  draft?: ChatSessionDraft
): {
  inputValue: string
  pendingHiddenContext: string
  pendingAttachments: ChatAttachment[]
} | null =>
  draft
    ? {
        inputValue: draft.inputValue,
        pendingHiddenContext: draft.pendingHiddenContext,
        pendingAttachments: draft.pendingAttachments
      }
    : null

const areChatSessionDraftsEqual = (
  left?: ChatSessionDraft | null,
  right?: ChatSessionDraft | null
): boolean =>
  JSON.stringify(buildChatDraftComparableValue(left || undefined)) ===
  JSON.stringify(buildChatDraftComparableValue(right || undefined))

const stripSessionDraft = (session: ChatSession): ChatSession => {
  const { draft, ...rest } = session
  return rest
}

const serializeDraftAttachment = async (
  attachment: ChatAttachment
): Promise<ChatAttachment | null> => {
  if (!attachment.url.startsWith('blob:')) {
    return cloneChatAttachment(attachment)
  }

  try {
    const response = await fetch(attachment.url)
    const blob = await response.blob()
    const file = new File([blob], attachment.fileName || 'attachment', {
      type: attachment.mimeType || blob.type || 'application/octet-stream'
    })
    const dataUrl = await fileToDataUrl(file)
    return {
      ...attachment,
      url: dataUrl,
      mimeType: attachment.mimeType || blob.type || undefined
    }
  } catch (error) {
    console.warn('[ChatPage] Failed to serialize draft attachment:', error)
    return null
  }
}

const serializeDraftAttachments = async (
  attachments: ChatAttachment[]
): Promise<ChatAttachment[]> => {
  const serialized = await Promise.all(
    attachments.map((attachment) => serializeDraftAttachment(attachment))
  )
  return serialized.filter((attachment): attachment is ChatAttachment => Boolean(attachment))
}

const resolvePreferredSessionDraft = (
  sessionId: string | null,
  sessionDraft: ChatSessionDraft | undefined,
  storageScope: string
): ChatSessionDraft | undefined => {
  const normalizedSessionDraft = cloneChatSessionDraft(normalizeChatSessionDraft(sessionDraft))
  if (!sessionId) {
    return normalizedSessionDraft
  }

  const backupRecord = readSessionDraftBackup(sessionId, storageScope)
  if (!backupRecord) {
    return normalizedSessionDraft
  }

  const normalizedBackupDraft = cloneChatSessionDraft(normalizeChatSessionDraft(backupRecord.draft))
  const sessionUpdatedAt = normalizedSessionDraft?.updatedAt ?? 0
  if (backupRecord.updatedAt >= sessionUpdatedAt) {
    return normalizedBackupDraft
  }

  return normalizedSessionDraft
}

const createDraftRecoverySession = (options: {
  sessionId: string
  title: string
  profileId?: string | null
  skillId?: string | null
  draft?: ChatSessionDraft
}): ChatSession => ({
  ...createChatSession(options.title, options.profileId, options.skillId),
  id: options.sessionId,
  ...(options.draft ? { draft: cloneChatSessionDraft(options.draft) } : {})
})

const formatChatFailureMessage = (message: string, runId?: string | null): string => {
  const normalized = message.trim()
  if (!runId || !normalized) return message
  return `${normalized} (Run: ${runId})`
}

const resolveChatFailureArchiveRootDir = (options: {
  configDownloadDir?: string | null
  buildDataDir?: string | null
}): string | null => {
  const downloadDirKey = 'qapp.downloadDir'
  const localOverride = (() => {
    try {
      return localStorage.getItem(downloadDirKey)
    } catch {
      return null
    }
  })()
  const baseDir = (localOverride || options.configDownloadDir || options.buildDataDir || '').trim()
  return baseDir || null
}

const resolveChatFailureArchiveDir = (baseDir: string, runId: string): string => {
  if (window.path?.join) {
    return window.path.join(baseDir, 'chat-failures', runId)
  }
  return `${baseDir.replace(/[\\/]+$/g, '')}/chat-failures/${runId}`
}

const formatCompactTokenCount = (value?: number | null): string => {
  if (!value || !Number.isFinite(value)) {
    return '0'
  }

  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`
  }

  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`
  }

  return `${Math.round(value)}`
}

const CHAT_LOADING_TOTAL_STEPS = 4

const normalizeReasoningPreferenceMap = (
  value: Record<string, string | LLMReasoningEffort>
): Record<string, LLMReasoningEffort> =>
  Object.fromEntries(
    Object.entries(value)
      .map(([profileKey, effort]) => [profileKey, normalizeReasoningEffort(effort)] as const)
      .filter(
        (entry): entry is readonly [string, LLMReasoningEffort] =>
          Boolean(entry[0]?.trim()) && Boolean(entry[1])
      )
  )

const resolveReasoningPreferenceKey = (
  profileId: string | null | undefined,
  profile?: ChatCapabilityProfile | null
): string | null => {
  const baseProfileId = getBaseProfileId(profileId)
  if (baseProfileId) {
    return baseProfileId
  }

  const modelName = String(profile?.model_name || '')
    .trim()
    .toLowerCase()
  return modelName || null
}

const dispatchReasoningEffortSync = (map: Record<string, LLMReasoningEffort>) => {
  window.dispatchEvent(
    new CustomEvent<Record<string, LLMReasoningEffort>>(CHAT_REASONING_EFFORT_SYNC_EVENT, {
      detail: map
    })
  )
}

const readStoredReasoningEffortMap = (storageKey: string): Record<string, LLMReasoningEffort> => {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as Record<string, string>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return normalizeReasoningPreferenceMap(parsed)
  } catch {
    return {}
  }
}

const readStoredImageGenerationOptions = (storageKey: string): OpenAIImageGenerationOptions => {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) {
      return { ...DEFAULT_CHAT_IMAGE_GENERATION_OPTIONS }
    }

    const parsed = JSON.parse(raw) as OpenAIImageGenerationOptions
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_CHAT_IMAGE_GENERATION_OPTIONS }
    }

    return {
      ...DEFAULT_CHAT_IMAGE_GENERATION_OPTIONS,
      ...parsed
    }
  } catch {
    return { ...DEFAULT_CHAT_IMAGE_GENERATION_OPTIONS }
  }
}

const buildChatFailureArchivePayload = (options: {
  sessionId?: string | null
  profileId?: string | null
  skillId?: string | null
  error: string
  userMessage?: ChatMessage
  timestamp?: number
}) => ({
  runId: options.sessionId || null,
  profileId: options.profileId || null,
  skillId: options.skillId || null,
  error: options.error,
  createdAt: new Date(options.timestamp ?? Date.now()).toISOString(),
  userMessage: options.userMessage
    ? {
        role: options.userMessage.role,
        content: options.userMessage.content,
        attachments: options.userMessage.attachments?.map((attachment) => ({
          type: attachment.type,
          url: attachment.url,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes
        }))
      }
    : null
})

const persistChatFailureArchive = async (options: {
  baseDir?: string | null
  runId?: string | null
  payload: ReturnType<typeof buildChatFailureArchivePayload>
}): Promise<void> => {
  if (!options.baseDir || !options.runId) return
  const svcFs = api().svcFs
  if (!svcFs || typeof svcFs.writeTextFile !== 'function') return

  try {
    await svcFs.writeTextFile({
      outputPath: resolveChatFailureArchiveDir(options.baseDir, options.runId),
      filename: 'error.json',
      content: JSON.stringify(options.payload, null, 2)
    })
  } catch (error) {
    console.warn('[ChatPage] Failed to archive chat failure:', error)
  }
}

const readImageDimensionsFromUrl = async (
  url: string
): Promise<Pick<ChatAttachment, 'sourceWidth' | 'sourceHeight'>> =>
  new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      resolve({
        sourceWidth: image.naturalWidth || image.width || undefined,
        sourceHeight: image.naturalHeight || image.height || undefined
      })
    }
    image.onerror = () => resolve({})
    image.src = url
  })

const revokeBlobUrl = (url?: string): void => {
  if (!url?.startsWith('blob:')) return
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  URL.revokeObjectURL(url)
}

const buildImageChatAttachmentFromFile = async (
  file: File,
  preferredUrl?: string,
  options?: {
    relativePath?: string
  }
): Promise<ChatAttachment> => {
  const filePath = getLocalFilePath(file)
  const previewUrl = fileToBlobUrl(file)
  const dimensions = await readImageDimensionsFromUrl(previewUrl)
  const attachmentUrl = preferredUrl || (filePath ? `file://${filePath}` : previewUrl)
  if (previewUrl !== attachmentUrl) {
    revokeBlobUrl(previewUrl)
  }

  return {
    type: 'image',
    url: attachmentUrl,
    mimeType: normalizeFileMimeType(file.name, file.type),
    fileName: file.name,
    relativePath: options?.relativePath,
    sizeBytes: file.size,
    sourceWidth: dimensions.sourceWidth,
    sourceHeight: dimensions.sourceHeight
  }
}

const buildChatAttachmentFromDroppedFile = async (
  file: File,
  options?: {
    relativePath?: string
  }
): Promise<ChatAttachment> => {
  const attachmentType = getChatAttachmentTypeForFile(file)
  const filePath = getLocalFilePath(file)

  if (attachmentType === 'image') {
    return buildImageChatAttachmentFromFile(file, undefined, options)
  }

  if (filePath) {
    return {
      type: attachmentType,
      url: `file://${filePath}`,
      mimeType: normalizeFileMimeType(file.name, file.type),
      fileName: file.name,
      relativePath: options?.relativePath,
      sizeBytes: file.size
    }
  }

  return {
    type: attachmentType,
    url: fileToBlobUrl(file),
    mimeType: normalizeFileMimeType(file.name, file.type),
    fileName: file.name,
    relativePath: options?.relativePath,
    sizeBytes: file.size
  }
}

const summarizeChatAttachmentsForLog = (attachments: ChatAttachment[] | undefined) =>
  attachments?.map((attachment) => ({
    type: attachment.type,
    fileName: attachment.fileName,
    relativePath: attachment.relativePath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    url:
      typeof attachment.url === 'string'
        ? attachment.url.startsWith('data:')
          ? `[data-url length=${attachment.url.length}]`
          : attachment.url
        : attachment.url
  }))

const ChatPage: React.FC<ChatPageProps> = ({
  compact = false,
  storageScope = 'default',
  route,
  acceptExternalInput = true,
  active = true
}) => {
  const { t, i18n } = useTranslation()
  const isChineseUi = (i18n?.resolvedLanguage || i18n?.language || '').startsWith('zh')
  const theme = useTheme()
  const { config, buildEnv, isReady } = useConfig()
  const { notifySuccess, notifyError, notifyWarning } = useMessage()
  const emitPreviewRefresh = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('chat:preview-refresh', {
        detail: { scope: storageScope }
      })
    )
  }, [storageScope])
  const buildSkillAttachmentUnsupportedMessage = useCallback(
    (params: {
      skillName?: string | null
      profileName?: string | null
      supportsImages: boolean
      supportsDocuments: boolean
      unsupportedImages: boolean
      unsupportedDocuments: boolean
    }): string => {
      const skillName = params.skillName?.trim()
      const profileName = params.profileName?.trim()
      const subject = isChineseUi
        ? skillName
          ? `技能「${skillName}」当前使用的模型${profileName ? `「${profileName}」` : ''}`
          : `当前模型${profileName ? `「${profileName}」` : ''}`
        : skillName
          ? `The model${profileName ? ` "${profileName}"` : ''} currently used by skill "${skillName}"`
          : `The current model${profileName ? ` "${profileName}"` : ''}`

      if (params.unsupportedImages && params.unsupportedDocuments) {
        return isChineseUi
          ? `${subject}不支持图片和文档输入，仅支持文本输入。请移除附件或更换支持图片/文档输入的模型后再试。`
          : `${subject} does not support image or document inputs. Text-only input is supported. Remove the attachments or switch to a model that supports image/document input, then try again.`
      }

      if (params.unsupportedDocuments && params.supportsImages) {
        return isChineseUi
          ? `${subject}仅支持图片输入，不支持文档输入。请移除文档附件或更换支持文档输入的模型后再试。`
          : `${subject} supports image input only, not document input. Remove the document attachment or switch to a model that supports document input, then try again.`
      }

      if (params.unsupportedImages && params.supportsDocuments) {
        return isChineseUi
          ? `${subject}仅支持文档输入，不支持图片输入。请移除图片附件或更换支持图片输入的模型后再试。`
          : `${subject} supports document input only, not image input. Remove the image attachment or switch to a model that supports image input, then try again.`
      }

      if (params.unsupportedDocuments) {
        return isChineseUi
          ? `${subject}不支持文档输入。请移除文档附件或更换支持文档输入的模型后再试。`
          : `${subject} does not support document input. Remove the document attachment or switch to a model that supports document input, then try again.`
      }

      return isChineseUi
        ? `${subject}不支持图片输入。请移除图片附件或更换支持图片输入的模型后再试。`
        : `${subject} does not support image input. Remove the image attachment or switch to a model that supports image input, then try again.`
    },
    [isChineseUi]
  )
  const currentSessionStorageKey = scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, storageScope)
  const selectedProfileStorageKey = scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, storageScope)
  const loadingIdsStorageKey = scopedStorageKey(STORAGE_KEY_LOADING_IDS, storageScope)
  const reasoningEffortStorageKey = STORAGE_KEY_REASONING_EFFORT
  const imageGenerationOptionsStorageKey = scopedStorageKey(
    STORAGE_KEY_IMAGE_GENERATION_OPTIONS,
    storageScope
  )
  const hasScopedSelectedProfileStorage = selectedProfileStorageKey !== STORAGE_KEY_SELECTED_PROFILE

  // ==================== Portal State ====================
  const [portalElement, setPortalElement] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (compact) {
      setPortalElement(document.getElementById('agent-workspace-skill-portal'))
    }
  }, [compact])

  // ==================== Sessions 状态 ====================
  const [sessions, setSessionsState] = useState<ChatSession[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const skipSaveRef = useRef(false)
  const sessionsRef = useRef<ChatSession[]>([])
  const autoSaveScanInitializedRef = useRef(false)
  const autoSaveScanCursorBySessionIdRef = useRef<Map<string, number>>(new Map())
  const setSessions = useCallback<React.Dispatch<React.SetStateAction<ChatSession[]>>>((value) => {
    const next = typeof value === 'function' ? value(sessionsRef.current) : value
    sessionsRef.current = next
    setSessionsState(next)
  }, [])
  const persistCurrentSessionSnapshot = useCallback(
    async (sessionId: string, label = ''): Promise<void> => {
      try {
        const session = sessionsRef.current.find((candidate) => candidate.id === sessionId)
        if (!session) {
          return
        }

        await saveSessionToDB(session, storageScope)
        emitPreviewRefresh()
        console.log(`[ChatPage] persistCurrentSessionSnapshot(${label}): saved`)
      } catch (e) {
        console.warn('[ChatPage] persistCurrentSessionSnapshot failed:', e)
      }
    },
    [emitPreviewRefresh, storageScope]
  )
  const persistAssistantAttachmentFileReference = useCallback(
    (sessionId: string, messageIndex: number, attachmentIndex: number, savedPath: string) => {
      const savedUrl = `file://${savedPath}`
      let sessionToPersist: ChatSession | null = null

      setSessions((prev) => {
        let changed = false
        const next = prev.map((session) => {
          if (session.id !== sessionId) return session

          const message = session.messages[messageIndex]
          const attachment = message?.attachments?.[attachmentIndex]
          if (!message || !attachment || attachment.url === savedUrl) {
            return session
          }

          const attachments = [...(message.attachments || [])]
          attachments[attachmentIndex] = {
            ...attachment,
            url: savedUrl
          }

          const messages = [...session.messages]
          messages[messageIndex] = {
            ...message,
            attachments
          }

          const updatedSession = {
            ...session,
            messages
          }
          sessionToPersist = updatedSession
          changed = true
          return updatedSession
        })

        return changed ? next : prev
      })

      if (!sessionToPersist) {
        return
      }

      skipSaveRef.current = true
      saveSessionToDB(sessionToPersist, storageScope).catch((error) => {
        console.warn('[ChatPage] persistAssistantAttachmentFileReference failed:', error)
      })
    },
    [storageScope]
  )
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(currentSessionStorageKey) || null
    } catch {
      return null
    }
  })
  const currentSessionIdRef = useRef<string | null>(currentSessionId)
  const isMountedRef = useRef(true)
  const selectSessionRef = useRef<(sessionId: string) => void>(() => {})
  const pendingSessionIdRef = useRef<string | null>(null)
  useEffect(
    () => () => {
      isMountedRef.current = false
    },
    []
  )

  // 从 IndexedDB 加载 sessions（含 localStorage 迁移）
  useEffect(() => {
    ;(async () => {
      try {
        const migrated = storageScope === 'default' ? await migrateFromLocalStorage() : null
        if (migrated) {
          setSessions((prev) =>
            mergeLoadedSessionsWithLocal(sortSessionsByRecencyDesc(migrated), prev, [
              pendingSessionIdRef.current,
              currentSessionIdRef.current
            ])
          )
        } else {
          const loaded = await loadAllSessions(storageScope)
          setSessions((prev) =>
            mergeLoadedSessionsWithLocal(sortSessionsByRecencyDesc(loaded), prev, [
              pendingSessionIdRef.current,
              currentSessionIdRef.current
            ])
          )
        }
      } catch (e) {
        console.error('[ChatPage] 加载会话失败', e)
      } finally {
        setSessionsLoaded(true)
      }
    })()
  }, [setSessions, storageScope])

  const setActiveSessionId = useCallback(
    (sessionId: string | null) => {
      currentSessionIdRef.current = sessionId
      setCurrentSessionId(sessionId)
      try {
        if (sessionId) {
          localStorage.setItem(currentSessionStorageKey, sessionId)
        } else {
          localStorage.removeItem(currentSessionStorageKey)
        }
      } catch (e) {
        console.error('[ChatPage] Failed to save currentSessionId:', e)
      }
    },
    [currentSessionStorageKey]
  )

  // ==================== Loading 状态 ====================
  const [loadingSessionIds, setLoadingSessionIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(loadingIdsStorageKey)
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set()
    } catch {
      return new Set()
    }
  })
  const loadingSessionIdsRef = useRef<Set<string>>(loadingSessionIds)
  useEffect(() => {
    loadingSessionIdsRef.current = loadingSessionIds
  }, [loadingSessionIds])
  const [externalLoadingSessionIds, setExternalLoadingSessionIds] = useState<Set<string>>(() => {
    return new Set(readScopedExternalLoadingSessionIds(storageScope))
  })
  const externalLoadingSessionIdsRef = useRef<Set<string>>(externalLoadingSessionIds)
  const sessionAbortControllersRef = useRef<Map<string, AbortController>>(new Map())
  const cancelledSessionsRef = useRef<Set<string>>(new Set())
  const [loadingStatusBySessionId, setLoadingStatusBySessionId] = useState<
    Record<string, ChatLoadingStatus>
  >({})
  useEffect(() => {
    externalLoadingSessionIdsRef.current = externalLoadingSessionIds
  }, [externalLoadingSessionIds])
  const isLoading = currentSessionId
    ? loadingSessionIds.has(currentSessionId) || externalLoadingSessionIds.has(currentSessionId)
    : false
  const currentLoadingStatus = currentSessionId
    ? loadingStatusBySessionId[currentSessionId]
    : undefined

  const setSessionLoadingStatus = useCallback(
    (sessionId: string | null | undefined, status?: ChatLoadingStatus | null) => {
      if (!sessionId) {
        return
      }

      setLoadingStatusBySessionId((prev) => {
        if (!status) {
          if (!(sessionId in prev)) {
            return prev
          }

          const next = { ...prev }
          delete next[sessionId]
          return next
        }

        const current = prev[sessionId]
        if (JSON.stringify(current) === JSON.stringify(status)) {
          return prev
        }

        return {
          ...prev,
          [sessionId]: status
        }
      })
    },
    []
  )

  const updateExternalLoadingSessionState = useCallback(
    (sessionId: string, loading: boolean) => {
      const nextLoadingIds = new Set(
        updateScopedExternalLoadingSessionId(storageScope, sessionId, loading)
      )

      externalLoadingSessionIdsRef.current = nextLoadingIds
      setExternalLoadingSessionIds(nextLoadingIds)

      window.dispatchEvent(
        new CustomEvent('chat:preview-refresh', {
          detail: { scope: storageScope }
        })
      )
    },
    [storageScope]
  )

  const clearLoadingSessionTracking = useCallback(
    (sessionId: string) => {
      const nextLoadingIds = new Set(loadingSessionIdsRef.current)
      nextLoadingIds.delete(sessionId)
      loadingSessionIdsRef.current = nextLoadingIds
      setLoadingSessionIds(nextLoadingIds)
      setSessionLoadingStatus(sessionId, null)

      try {
        const stored = JSON.parse(localStorage.getItem(loadingIdsStorageKey) || '[]') as string[]
        localStorage.setItem(
          loadingIdsStorageKey,
          JSON.stringify(stored.filter((id) => id !== sessionId))
        )
      } catch (_error) {
        /* ignore storage failures */
      }

      updateExternalLoadingSessionState(sessionId, false)
    },
    [loadingIdsStorageKey, setSessionLoadingStatus, updateExternalLoadingSessionState]
  )

  const terminateSession = useCallback(
    (sessionId: string) => {
      cancelledSessionsRef.current.add(sessionId)
      sessionAbortControllersRef.current.get(sessionId)?.abort('Chat session cancelled.')
      sessionAbortControllersRef.current.delete(sessionId)
      clearLoadingSessionTracking(sessionId)
      setSessions((prev) => removeTrailingEmptyAssistantMessage(prev, sessionId))
      window.dispatchEvent(
        new CustomEvent('chat:preview-refresh', {
          detail: { scope: storageScope }
        })
      )
      window.dispatchEvent(
        new CustomEvent('chat:session-terminated', {
          detail: {
            scope: storageScope,
            sessionId
          }
        })
      )
    },
    [clearLoadingSessionTracking, setSessions, storageScope]
  )

  // 后台恢复：轮询 localStorage 检测 loading 是否完成
  useEffect(() => {
    if (!active) return
    let intervalId: ReturnType<typeof setInterval> | null = null
    try {
      const savedLoadingIds = localStorage.getItem(loadingIdsStorageKey)
      const pendingIds: string[] = savedLoadingIds ? JSON.parse(savedLoadingIds) : []
      if (pendingIds.length > 0) {
        console.log('[ChatPage] 检测到后台生成任务:', pendingIds)
        intervalId = setInterval(async () => {
          const currentLoadingIds = JSON.parse(
            localStorage.getItem(loadingIdsStorageKey) || '[]'
          ) as string[]
          if (currentLoadingIds.length === 0) {
            console.log('[ChatPage] 后台任务完成，重新加载 sessions')
            const stored = await loadAllSessions(storageScope)
            skipSaveRef.current = true
            setSessions((prev) =>
              mergeLoadedSessionsWithLocal(sortSessionsByRecencyDesc(stored), prev, [
                pendingSessionIdRef.current,
                currentSessionIdRef.current
              ])
            )
            setLoadingSessionIds(new Set())
            if (intervalId) clearInterval(intervalId)
            intervalId = null
          } else {
            const stored = await loadAllSessions(storageScope)
            skipSaveRef.current = true
            setSessions((prev) =>
              mergeLoadedSessionsWithLocal(sortSessionsByRecencyDesc(stored), prev, [
                pendingSessionIdRef.current,
                currentSessionIdRef.current
              ])
            )
            setLoadingSessionIds((prev) => {
              const prevIds = [...prev].sort().join(',')
              const newIds = currentLoadingIds.sort().join(',')
              return prevIds === newIds ? prev : new Set(currentLoadingIds)
            })
          }
        }, 2000)
      }
    } catch (_e) {
      /* ignore */
    }
    return () => {
      if (intervalId) clearInterval(intervalId)
    }
  }, [active, loadingIdsStorageKey, setSessions, storageScope])

  // 校验 loading IDs：移除无效的（已有 content 或无空 assistant 占位符的）
  useEffect(() => {
    if (!sessionsLoaded) return

    const removedLoadingIds: string[] = []
    const validLoadingIds = [...loadingSessionIds].filter((sessionId) => {
      const session = sessions.find((item) => item.id === sessionId)
      const hasLiveRequest =
        sessionAbortControllersRef.current.has(sessionId) ||
        externalLoadingSessionIdsRef.current.has(sessionId)
      if (!session || session.messages.length === 0 || !hasLiveRequest) {
        removedLoadingIds.push(sessionId)
        return false
      }

      const lastMessage = session.messages[session.messages.length - 1]
      const hasPendingAssistantPlaceholder =
        lastMessage?.role === 'assistant' &&
        !lastMessage.content &&
        (!lastMessage.attachments || lastMessage.attachments.length === 0)
      if (!hasPendingAssistantPlaceholder) {
        removedLoadingIds.push(sessionId)
      }
      return hasPendingAssistantPlaceholder
    })

    if (validLoadingIds.length === loadingSessionIds.size) return

    const nextLoadingIds = new Set(validLoadingIds)
    loadingSessionIdsRef.current = nextLoadingIds
    setLoadingSessionIds(nextLoadingIds)
    for (const sessionId of removedLoadingIds) {
      setSessionLoadingStatus(sessionId, null)
    }

    try {
      localStorage.setItem(loadingIdsStorageKey, JSON.stringify(validLoadingIds))
    } catch (e) {
      console.warn('[ChatPage] Failed to sanitize loading session ids:', e)
    }
    window.dispatchEvent(
      new CustomEvent('chat:preview-refresh', {
        detail: { scope: storageScope }
      })
    )
  }, [
    sessionsLoaded,
    sessions,
    loadingSessionIds,
    loadingIdsStorageKey,
    setSessionLoadingStatus,
    storageScope
  ])

  useEffect(() => {
    const handleExternalLoading = (event: Event) => {
      const customEvent = event as CustomEvent<{
        scope?: string
        sessionId?: string
        loading?: boolean
      }>

      if (customEvent.detail?.scope) {
        if (customEvent.detail.scope !== storageScope) return
      } else if (!active) {
        return
      }

      const sessionId = customEvent.detail?.sessionId
      if (!sessionId) return

      updateExternalLoadingSessionState(sessionId, customEvent.detail.loading !== false)
    }

    window.addEventListener('chat:set-external-loading', handleExternalLoading)
    return () => window.removeEventListener('chat:set-external-loading', handleExternalLoading)
  }, [active, storageScope, updateExternalLoadingSessionState])

  // ==================== 输入 & 附件 ====================
  const [inputValue, setInputValueState] = useState('')
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [pendingAttachments, setPendingAttachmentsState] = useState<ChatAttachment[]>([])
  const [pendingHiddenContext, setPendingHiddenContextState] = useState('')
  const [pendingExternalConfirmations, setPendingExternalConfirmations] = useState<
    Record<string, ExternalConfirmationRequest>
  >({})
  const [uploadProgress, setUploadProgress] = useState<{ [key: number]: number }>({})
  const composerInputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const [searchKeyword, setSearchKeyword] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const inputValueRef = useRef(inputValue)
  const pendingAttachmentsRef = useRef<ChatAttachment[]>(pendingAttachments)
  const pendingHiddenContextRef = useRef(pendingHiddenContext)
  const pendingExternalSendToAgentRef = useRef<ExternalSendToAgentDetail[]>([])
  const isApplyingDraftRef = useRef(false)
  const composerDraftSessionIdRef = useRef<string | null>(currentSessionIdRef.current)
  const composerDraftMutationRef = useRef<{ sessionId: string | null; updatedAt: number }>({
    sessionId: currentSessionIdRef.current,
    updatedAt: 0
  })

  const markComposerDraftMutated = useCallback(() => {
    if (isApplyingDraftRef.current) return
    composerDraftSessionIdRef.current = currentSessionIdRef.current
    composerDraftMutationRef.current = {
      sessionId: currentSessionIdRef.current,
      updatedAt: Date.now()
    }
  }, [])

  const mergeHiddenContext = useCallback(
    (currentValue: string, ...nextValues: Array<string | undefined>) => {
      let merged = currentValue.trim()

      nextValues.forEach((nextValue) => {
        const normalizedNext = nextValue?.trim()
        if (!normalizedNext) return
        if (!merged) {
          merged = normalizedNext
          return
        }
        if (merged.includes(normalizedNext)) return
        merged = `${merged}\n\n${normalizedNext}`
      })

      return merged
    },
    []
  )

  const setInputValue = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (value) => {
      setInputValueState((prev) => {
        const next = typeof value === 'function' ? value(prev) : value
        inputValueRef.current = next
        if (next !== prev) {
          markComposerDraftMutated()
        }
        return next
      })
    },
    [markComposerDraftMutated]
  )
  const setPendingAttachments = useCallback<React.Dispatch<React.SetStateAction<ChatAttachment[]>>>(
    (value) => {
      setPendingAttachmentsState((prev) => {
        const next = typeof value === 'function' ? value(prev) : value
        pendingAttachmentsRef.current = next
        if (next !== prev) {
          markComposerDraftMutated()
        }
        return next
      })
    },
    [markComposerDraftMutated]
  )
  const setPendingHiddenContext = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (value) => {
      setPendingHiddenContextState((prev) => {
        const next = typeof value === 'function' ? value(prev) : value
        pendingHiddenContextRef.current = next
        if (next !== prev) {
          markComposerDraftMutated()
        }
        return next
      })
    },
    [markComposerDraftMutated]
  )

  const applyExternalSendToAgentInput = useCallback(
    ({ image, text, hiddenText, attachment, attachments, autoSend }: ExternalSendToAgentDetail) => {
      if (autoSend && sendMessageRef.current) {
        const sendAttachments = attachments && attachments.length > 0 ? attachments : undefined
        void sendMessageRef.current({
          content: text || '',
          attachments: sendAttachments,
          hiddenContext: hiddenText
        })
        return
      }

      if (attachment?.url) {
        setPendingAttachments((prev) => {
          if (prev.some((item) => item.url === attachment.url)) return prev
          return [...prev, attachment]
        })
      }

      if (image) {
        fetch(image)
          .then((res) => res.blob())
          .then(async (blob) => {
            const nextAttachment = await buildImageChatAttachmentFromFile(
              new File([blob], getDownloadFileNameFromUrl(image, 'image.png'), {
                type: blob.type || 'image/png'
              }),
              image
            )
            setPendingAttachments((prev) => {
              if (prev.some((item) => item.url === image)) return prev
              return [...prev, nextAttachment]
            })
          })
          .catch((err) => console.error('[ChatPage] Failed to parse canvas image:', err))
      }

      if (text) {
        setInputValue((prev) => {
          const base = prev.trim()
          return base ? `${base}\n\n${text}` : text
        })
      }

      if (hiddenText) {
        setPendingHiddenContext((prev) => mergeHiddenContext(prev, hiddenText))
      }
    },
    [mergeHiddenContext, setInputValue, setPendingAttachments, setPendingHiddenContext]
  )

  // ==================== Profile 选择 ====================
  const draftPersistTimerRef = useRef<number | null>(null)

  const buildCurrentDraftSnapshot = useCallback(
    (updatedAt: number): ChatSessionDraft | undefined =>
      normalizeChatSessionDraft({
        inputValue: inputValueRef.current,
        pendingAttachments: pendingAttachmentsRef.current.map(cloneChatAttachment),
        pendingHiddenContext: pendingHiddenContextRef.current,
        updatedAt
      }),
    []
  )

  const applyDraftToComposerState = useCallback(
    (draft?: ChatSessionDraft | null) => {
      const normalizedDraft = cloneChatSessionDraft(normalizeChatSessionDraft(draft))
      const targetSessionId = currentSessionIdRef.current
      const localMutation = composerDraftMutationRef.current
      if (
        composerDraftSessionIdRef.current === targetSessionId &&
        localMutation.sessionId === targetSessionId &&
        localMutation.updatedAt > (normalizedDraft?.updatedAt ?? 0)
      ) {
        return
      }

      const nextInputValue = normalizedDraft?.inputValue ?? ''
      const nextPendingAttachments = normalizedDraft?.pendingAttachments ?? []
      const nextPendingHiddenContext = normalizedDraft?.pendingHiddenContext ?? ''

      isApplyingDraftRef.current = true
      try {
        if (inputValueRef.current !== nextInputValue) {
          inputValueRef.current = nextInputValue
          setInputValue(nextInputValue)
        }

        const currentDraft = normalizeChatSessionDraft({
          inputValue: inputValueRef.current,
          pendingAttachments: pendingAttachmentsRef.current,
          pendingHiddenContext: pendingHiddenContextRef.current,
          updatedAt: normalizedDraft?.updatedAt ?? 0
        })

        if (!areChatSessionDraftsEqual(currentDraft, normalizedDraft)) {
          pendingAttachmentsRef.current = nextPendingAttachments
          pendingHiddenContextRef.current = nextPendingHiddenContext
          setPendingAttachments(nextPendingAttachments)
          setPendingHiddenContext(nextPendingHiddenContext)
        }
      } finally {
        isApplyingDraftRef.current = false
      }

      composerDraftMutationRef.current = {
        sessionId: targetSessionId,
        updatedAt: normalizedDraft?.updatedAt ?? 0
      }
      composerDraftSessionIdRef.current = targetSessionId
    },
    [setInputValue, setPendingAttachments, setPendingHiddenContext]
  )

  const persistDraftSnapshot = useCallback(
    async (sessionId: string | null, snapshot?: ChatSessionDraft) => {
      if (!sessionId) {
        return
      }

      const normalizedSnapshot = normalizeChatSessionDraft(snapshot)
      const isStaleCurrentComposerSnapshot = (updatedAt = 0): boolean => {
        const localMutation = composerDraftMutationRef.current
        return (
          sessionId === currentSessionIdRef.current &&
          localMutation.sessionId === sessionId &&
          localMutation.updatedAt > updatedAt
        )
      }

      if (isStaleCurrentComposerSnapshot(normalizedSnapshot?.updatedAt ?? 0)) {
        return
      }

      const initialSessions = sessionsRef.current
      const initialSessionIndex = initialSessions.findIndex((session) => session.id === sessionId)
      if (initialSessionIndex < 0) {
        return
      }

      const initialSession = initialSessions[initialSessionIndex]
      if (
        initialSession.draft &&
        normalizedSnapshot &&
        initialSession.draft.updatedAt > normalizedSnapshot.updatedAt
      ) {
        return
      }

      writeSessionDraftBackup(
        sessionId,
        normalizedSnapshot?.updatedAt ?? Date.now(),
        normalizedSnapshot,
        storageScope
      )
      const persistedDraft = normalizedSnapshot
        ? normalizeChatSessionDraft({
            ...normalizedSnapshot,
            pendingAttachments: await serializeDraftAttachments(
              normalizedSnapshot.pendingAttachments
            )
          })
        : undefined
      if (
        isStaleCurrentComposerSnapshot(
          persistedDraft?.updatedAt ?? normalizedSnapshot?.updatedAt ?? 0
        )
      ) {
        return
      }

      writeSessionDraftBackup(
        sessionId,
        persistedDraft?.updatedAt ?? normalizedSnapshot?.updatedAt ?? Date.now(),
        persistedDraft,
        storageScope
      )

      const currentSessions = sessionsRef.current
      const currentSessionIndex = currentSessions.findIndex((session) => session.id === sessionId)
      if (currentSessionIndex < 0) {
        return
      }

      const currentSession = currentSessions[currentSessionIndex]
      if (
        currentSession.draft &&
        persistedDraft &&
        currentSession.draft.updatedAt > persistedDraft.updatedAt
      ) {
        return
      }

      if (areChatSessionDraftsEqual(currentSession.draft, persistedDraft)) {
        return
      }

      const updatedSession = persistedDraft
        ? { ...currentSession, draft: persistedDraft }
        : stripSessionDraft(currentSession)
      const nextSessions = currentSessions.map((session, index) =>
        index === currentSessionIndex ? updatedSession : session
      )

      sessionsRef.current = nextSessions
      if (isMountedRef.current) {
        setSessionsState(nextSessions)
      }

      try {
        await saveSessionToDB(updatedSession, storageScope)
      } catch (error) {
        console.error('[ChatPage] Failed to persist session draft:', error)
      }
    },
    [storageScope]
  )

  const clearScheduledDraftPersistence = useCallback(() => {
    if (draftPersistTimerRef.current != null) {
      window.clearTimeout(draftPersistTimerRef.current)
      draftPersistTimerRef.current = null
    }
  }, [])

  const flushSessionDraft = useCallback(
    (sessionId: string | null = currentSessionIdRef.current) => {
      clearScheduledDraftPersistence()
      return persistDraftSnapshot(sessionId, buildCurrentDraftSnapshot(Date.now()))
    },
    [buildCurrentDraftSnapshot, clearScheduledDraftPersistence, persistDraftSnapshot]
  )

  useEffect(() => {
    if (!sessionsLoaded || !currentSessionId) {
      clearScheduledDraftPersistence()
      return
    }

    const updatedAt = Date.now()
    clearScheduledDraftPersistence()
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = null
      void persistDraftSnapshot(currentSessionId, buildCurrentDraftSnapshot(updatedAt))
    }, CHAT_DRAFT_PERSIST_DELAY_MS)

    return clearScheduledDraftPersistence
  }, [
    buildCurrentDraftSnapshot,
    clearScheduledDraftPersistence,
    currentSessionId,
    inputValue,
    pendingAttachments,
    pendingHiddenContext,
    persistDraftSnapshot,
    sessionsLoaded,
    setSessions
  ])

  useEffect(() => {
    const flushPendingDraft = () => {
      void flushSessionDraft()
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        flushPendingDraft()
      }
    }

    window.addEventListener('blur', flushPendingDraft)
    window.addEventListener('beforeunload', flushPendingDraft)
    window.addEventListener('pagehide', flushPendingDraft)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      flushPendingDraft()
      window.removeEventListener('blur', flushPendingDraft)
      window.removeEventListener('beforeunload', flushPendingDraft)
      window.removeEventListener('pagehide', flushPendingDraft)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [flushSessionDraft])

  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(() => {
    try {
      const scopedProfileId = normalizeChatProfileIdForStorage(
        localStorage.getItem(selectedProfileStorageKey)
      )
      if (scopedProfileId) {
        return scopedProfileId
      }

      return hasScopedSelectedProfileStorage
        ? normalizeChatProfileIdForStorage(localStorage.getItem(STORAGE_KEY_SELECTED_PROFILE)) ||
            null
        : scopedProfileId || null
    } catch {
      return null
    }
  })
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [selectedSkillCategory, setSelectedSkillCategory] = useState<string>(NO_SKILL_VALUE)
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false)
  const [reasoningEffortByProfileId, setReasoningEffortByProfileId] = useState<
    Record<string, LLMReasoningEffort>
  >(() => readStoredReasoningEffortMap(reasoningEffortStorageKey))
  const [imageGenerationOptions, setImageGenerationOptions] =
    useState<OpenAIImageGenerationOptions>(() =>
      readStoredImageGenerationOptions(imageGenerationOptionsStorageKey)
    )
  useEffect(() => {
    setReasoningEffortByProfileId(readStoredReasoningEffortMap(reasoningEffortStorageKey))
  }, [reasoningEffortStorageKey])
  useEffect(() => {
    setImageGenerationOptions(readStoredImageGenerationOptions(imageGenerationOptionsStorageKey))
  }, [imageGenerationOptionsStorageKey])
  useEffect(() => {
    const handleReasoningEffortSync = (event: Event | StorageEvent) => {
      if (event instanceof StorageEvent) {
        if (event.key && event.key !== reasoningEffortStorageKey) {
          return
        }
        if (event.storageArea && event.storageArea !== localStorage) {
          return
        }

        setReasoningEffortByProfileId(readStoredReasoningEffortMap(reasoningEffortStorageKey))
        return
      }

      const nextMap = normalizeReasoningPreferenceMap(
        ((event as CustomEvent<Record<string, LLMReasoningEffort>>).detail || {}) as Record<
          string,
          string | LLMReasoningEffort
        >
      )
      setReasoningEffortByProfileId((prev) =>
        JSON.stringify(prev) === JSON.stringify(nextMap) ? prev : nextMap
      )
    }

    window.addEventListener(
      CHAT_REASONING_EFFORT_SYNC_EVENT,
      handleReasoningEffortSync as EventListener
    )
    window.addEventListener('storage', handleReasoningEffortSync)
    return () => {
      window.removeEventListener(
        CHAT_REASONING_EFFORT_SYNC_EVENT,
        handleReasoningEffortSync as EventListener
      )
      window.removeEventListener('storage', handleReasoningEffortSync)
    }
  }, [reasoningEffortStorageKey])
  useEffect(() => {
    try {
      if (selectedProfileId) {
        localStorage.setItem(selectedProfileStorageKey, selectedProfileId)
        if (!hasScopedSelectedProfileStorage || active) {
          localStorage.setItem(STORAGE_KEY_SELECTED_PROFILE, selectedProfileId)
        }
      } else if (hasScopedSelectedProfileStorage) {
        localStorage.removeItem(selectedProfileStorageKey)
      }
    } catch (e) {
      console.error('[ChatPage] Failed to save selectedProfileId:', e)
    }
  }, [active, hasScopedSelectedProfileStorage, selectedProfileId, selectedProfileStorageKey])
  useEffect(() => {
    try {
      const normalizedMap = normalizeReasoningPreferenceMap(reasoningEffortByProfileId)
      localStorage.setItem(reasoningEffortStorageKey, JSON.stringify(normalizedMap))
    } catch (error) {
      console.error('[ChatPage] Failed to save reasoningEffortByProfileId:', error)
    }
  }, [reasoningEffortByProfileId, reasoningEffortStorageKey])
  useEffect(() => {
    try {
      localStorage.setItem(imageGenerationOptionsStorageKey, JSON.stringify(imageGenerationOptions))
    } catch (error) {
      console.error('[ChatPage] Failed to save imageGenerationOptions:', error)
    }
  }, [imageGenerationOptions, imageGenerationOptionsStorageKey])

  // ==================== Hooks ====================
  const { availableProfiles } = useChatProfiles(config, isReady, active)
  const persistedCustomSkills = useMemo(() => config?.llm_config?.customSkills || [], [config])
  const customSkills = useMemo(
    () =>
      mergeBuiltInSkills(persistedCustomSkills, {
        language: i18n?.resolvedLanguage || i18n?.language,
        config
      }),
    [config, i18n?.language, i18n?.resolvedLanguage, persistedCustomSkills]
  )
  const { runtimeMcpStatus } = useRuntimeMcpStatus(undefined, active)
  const availableRuntimeApps = useMemo(
    () => enrichMagicPotAppCatalogWithRuntime(buildMagicPotAppCatalog(config), runtimeMcpStatus),
    [config, runtimeMcpStatus]
  )
  const hasCustomSkills = customSkills.length > 0
  const skillCategories = useMemo(() => buildCustomSkillCategories(customSkills), [customSkills])
  const skillsForSelectedCategory = useMemo(
    () => getSkillsForCategory(customSkills, selectedSkillCategory),
    [customSkills, selectedSkillCategory]
  )
  const selectedCustomSkill = useMemo(
    () => findCustomSkillById(customSkills, selectedSkillId),
    [customSkills, selectedSkillId]
  )
  const selectedSkillReferenceAttachments = useMemo(
    () =>
      selectedCustomSkill?.type === 'agent' ? [] : selectedCustomSkill?.referenceAttachments || [],
    [selectedCustomSkill?.referenceAttachments, selectedCustomSkill?.type]
  )
  const composerPendingAttachments = useMemo(
    () =>
      mergeChatAttachmentsWithSkillReferenceAttachments(
        pendingAttachments,
        selectedSkillReferenceAttachments
      ) || [],
    [pendingAttachments, selectedSkillReferenceAttachments]
  )
  const imageGenerationReferenceSize = useMemo(() => {
    const referenceImage = composerPendingAttachments.find((attachment) => {
      if (attachment.type !== 'image') return false
      const width = Number(attachment.sourceWidth)
      const height = Number(attachment.sourceHeight)
      return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    })

    if (!referenceImage) {
      return undefined
    }

    return {
      width: Math.round(Number(referenceImage.sourceWidth)),
      height: Math.round(Number(referenceImage.sourceHeight))
    }
  }, [composerPendingAttachments])
  const isImageGenerationSelected =
    imageGenerationOptions.enabled === true ||
    imageGenerationOptions.action === 'generate' ||
    imageGenerationOptions.action === 'edit'
  const selectedSkillRuntime = useMemo(
    () =>
      selectedCustomSkill
        ? resolveSkillRuntimeSpec(selectedCustomSkill, config, availableRuntimeApps)
        : resolveSkillRuntimeSpec(null, config, availableRuntimeApps),
    [availableRuntimeApps, config, selectedCustomSkill]
  )
  const selectedSkillToolHelpItems = useMemo(
    () => resolveAllowedSkillTools(selectedSkillRuntime),
    [selectedSkillRuntime]
  )
  const hasExternalAgentSkills = useMemo(
    () => customSkills.some((skill) => skill.type === 'agent' && skill.apiAddress?.trim()),
    [customSkills]
  )
  const isAgentSkillSelected = selectedCustomSkill?.type === 'agent'
  const resolveAvailableProfileId = useCallback(
    (profileId: string | null | undefined): string | null =>
      resolveAvailableChatProfileId(availableProfiles, profileId),
    [availableProfiles]
  )
  const qappPromptSettings = useMemo(() => getQAppPromptSettings(config), [config])
  const resolveConfiguredProfileIdForSkill = useCallback(
    (skillId: string | null | undefined): string | null => {
      switch (skillId) {
        case BUILT_IN_IMAGE_INTERROGATION_SKILL_ID:
          return resolveAvailableProfileId(qappPromptSettings.imageInterrogationProfileId)
        case BUILT_IN_PROMPT_TRANSLATION_SKILL_ID:
          return resolveAvailableProfileId(qappPromptSettings.promptTranslationProfileId)
        default:
          return null
      }
    },
    [
      qappPromptSettings.imageInterrogationProfileId,
      qappPromptSettings.promptTranslationProfileId,
      resolveAvailableProfileId
    ]
  )
  const resolveProfileIdForSkill = useCallback(
    (
      skillId: string | null | undefined,
      profileId: string | null | undefined,
      options?: { preferConfiguredProfile?: boolean }
    ): string | null =>
      resolveTaggingSkillProfileId({
        skillId,
        currentProfileId: normalizeProfileIdForSkill(
          customSkills,
          skillId,
          resolveAvailableProfileId(profileId)
        ),
        configuredProfileId: resolveConfiguredProfileIdForSkill(skillId),
        preferConfiguredProfile: options?.preferConfiguredProfile
      }),
    [customSkills, resolveAvailableProfileId, resolveConfiguredProfileIdForSkill]
  )
  const resolveAvailableSkillId = useCallback(
    (skillId: string | null | undefined): string | null =>
      resolveCustomSkillId(customSkills, skillId),
    [customSkills]
  )

  const refreshHy3dModelUrlIfNeeded = useCallback(
    async (params: ReturnType<typeof getHy3dParams>) => {
      if (!HY3D_POST_PROCESS_ACTIONS.has(params.apiAction)) {
        return params
      }

      if (!params.modelStorageKey || !params.modelStorageBucket || !params.modelStorageRegion) {
        return params
      }

      const expiresAtMs = Date.parse(params.modelSignedUrlExpiresAt || '')
      if (
        params.modelUrl &&
        Number.isFinite(expiresAtMs) &&
        expiresAtMs > Date.now() + HY3D_SIGNED_URL_REFRESH_BUFFER_MS
      ) {
        return params
      }

      const signed = await api().svcLLMProxy.signHy3DModel({
        key: params.modelStorageKey,
        bucket: params.modelStorageBucket,
        region: params.modelStorageRegion
      })

      const nextParams = {
        ...params,
        modelUrl: signed.url,
        modelSignedUrlExpiresAt: signed.expiresAt
      }

      saveHy3dParams(nextParams)
      window.dispatchEvent(
        new CustomEvent('hy3d:params-updated', { detail: { params: nextParams } })
      )
      return nextParams
    },
    []
  )
  const currentSession = useMemo(
    () => sessions.find((s) => s.id === currentSessionId),
    [sessions, currentSessionId]
  )
  const currentPendingConfirmation = currentSession
    ? (pendingExternalConfirmations[currentSession.id] ?? null)
    : null
  const handleResolvePendingConfirmation = useCallback(
    (requestId: string, confirmed: boolean) => {
      const targetSessionId = currentSessionIdRef.current
      if (!targetSessionId) return

      const pending = pendingExternalConfirmations[targetSessionId]
      if (!pending || pending.requestId !== requestId) return

      setPendingExternalConfirmations((prev) => {
        if (prev[targetSessionId]?.requestId !== requestId) return prev
        const next = { ...prev }
        delete next[targetSessionId]
        return next
      })

      const responseContent = confirmed
        ? pending.confirmedUserContent
        : pending.cancelledUserContent
      if (responseContent.trim()) {
        setSessions((prev) =>
          prev.map((session) =>
            session.id === targetSessionId
              ? {
                  ...session,
                  messages: [
                    ...session.messages,
                    {
                      role: 'user',
                      content: responseContent
                    }
                  ]
                }
              : session
          )
        )
      }

      window.dispatchEvent(
        new CustomEvent('chat:confirmation-response', {
          detail: {
            scope: storageScope,
            sessionId: targetSessionId,
            requestId,
            confirmed
          }
        })
      )
      window.dispatchEvent(new CustomEvent('chat:preview-refresh'))
    },
    [pendingExternalConfirmations, setSessions, storageScope]
  )
  useEffect(() => {
    const handleSessionTerminated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          scope?: string
          sessionId?: string
        }>
      ).detail

      if (detail?.scope) {
        if (detail.scope !== storageScope) return
      } else if (!active) {
        return
      }
      const sessionId = detail?.sessionId
      if (!sessionId) return

      const pending = pendingExternalConfirmations[sessionId]
      if (!pending) return

      setPendingExternalConfirmations((prev) => {
        if (prev[sessionId]?.requestId !== pending.requestId) return prev
        const next = { ...prev }
        delete next[sessionId]
        return next
      })

      window.dispatchEvent(
        new CustomEvent('chat:confirmation-response', {
          detail: {
            scope: storageScope,
            sessionId,
            requestId: pending.requestId,
            confirmed: false
          }
        })
      )
      emitPreviewRefresh()
    }

    window.addEventListener('chat:session-terminated', handleSessionTerminated)
    return () => window.removeEventListener('chat:session-terminated', handleSessionTerminated)
  }, [active, emitPreviewRefresh, pendingExternalConfirmations, storageScope])
  useEffect(() => {
    if (!sessionsLoaded) {
      return
    }

    applyDraftToComposerState(
      resolvePreferredSessionDraft(currentSessionId, currentSession?.draft, storageScope)
    )
  }, [
    applyDraftToComposerState,
    currentSession?.draft,
    currentSessionId,
    sessionsLoaded,
    storageScope
  ])
  useEffect(() => {
    if (
      !sessionsLoaded ||
      !currentSessionId ||
      pendingExternalSendToAgentRef.current.length === 0
    ) {
      return
    }

    const queuedInputs = [...pendingExternalSendToAgentRef.current]
    pendingExternalSendToAgentRef.current = []
    queuedInputs.forEach((detail) => applyExternalSendToAgentInput(detail))
  }, [applyExternalSendToAgentInput, currentSessionId, sessionsLoaded])
  const selectedCapabilityProfile = useMemo<ChatCapabilityProfile | null>(() => {
    if (isAgentSkillSelected) {
      return null
    }

    const baseProfileId = getBaseProfileId(selectedProfileId)
    return (
      availableProfiles.find((profile) => profile.id === selectedProfileId) ||
      availableProfiles.find((profile) => profile.id === baseProfileId) ||
      null
    )
  }, [availableProfiles, isAgentSkillSelected, selectedProfileId])
  const selectedProfileCapabilities = useMemo(
    () => resolveChatProfileCapabilities(selectedCapabilityProfile),
    [selectedCapabilityProfile]
  )
  const selectedReasoningProfileKey = useMemo(
    () => resolveReasoningPreferenceKey(selectedProfileId, selectedCapabilityProfile),
    [selectedCapabilityProfile, selectedProfileId]
  )
  const selectedReasoningEffort = useMemo(() => {
    const storedEffort = selectedReasoningProfileKey
      ? reasoningEffortByProfileId[selectedReasoningProfileKey]
      : undefined
    return (
      normalizeReasoningEffort(storedEffort, selectedProfileCapabilities.reasoningEfforts) ||
      selectedProfileCapabilities.defaultReasoningEffort
    )
  }, [
    reasoningEffortByProfileId,
    selectedProfileCapabilities.defaultReasoningEffort,
    selectedProfileCapabilities.reasoningEfforts,
    selectedReasoningProfileKey
  ])
  const isAutoContextCompressionAvailable =
    !isAgentSkillSelected && selectedProfileCapabilities.supportsAutoContextCompression
  const contextCompressionPreview = useMemo(
    () =>
      buildChatContextCompressionPlan({
        historyMessages: currentSession?.messages || [],
        requestMessage: {
          role: 'user',
          content: inputValue,
          attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
          hiddenContext: pendingHiddenContext || undefined
        },
        profile: selectedCapabilityProfile,
        enabled: isAutoContextCompressionAvailable,
        cachedSummary: currentSession?.contextCompression
      }),
    [
      currentSession?.contextCompression,
      currentSession?.messages,
      inputValue,
      isAutoContextCompressionAvailable,
      pendingAttachments,
      pendingHiddenContext,
      selectedCapabilityProfile
    ]
  )
  const contextCompressionStatusSlot = useMemo(() => {
    if (!isAutoContextCompressionAvailable) {
      return undefined
    }

    const contextWindowTokens =
      contextCompressionPreview.contextWindowTokens || contextCompressionPreview.contextBudgetTokens
    const compressionTriggerTokens = contextCompressionPreview.contextBudgetTokens
    if (!contextWindowTokens || !compressionTriggerTokens) {
      return undefined
    }

    const displayTokens = contextCompressionPreview.shouldCompress
      ? contextCompressionPreview.estimatedCompressedInputTokens
      : contextCompressionPreview.estimatedInputTokens
    const usagePercent = Math.max(
      0,
      Math.min(100, Math.round((displayTokens / contextWindowTokens) * 100))
    )
    const triggerPercent = Math.max(
      AUTO_CONTEXT_COMPRESSION_TRIGGER_PERCENT,
      Math.round((compressionTriggerTokens / contextWindowTokens) * 100)
    )
    const indicatorColor = contextCompressionPreview.shouldCompress
      ? 'primary.main'
      : usagePercent >= Math.max(70, triggerPercent - 10)
        ? 'warning.main'
        : 'text.secondary'
    const usageTitle = t('chat.context_window_used_ratio', {
      defaultValue: '\u80cc\u666f\u4fe1\u606f\u7a97\u53e3\uff1a{{value}}% \u5df2\u7528',
      value: usagePercent
    })
    const tokenUsageTitle = t('chat.context_window_token_usage', {
      defaultValue: '\u5df2\u7528 {{used}} \u6807\u8bb0\uff0c\u5171 {{total}}',
      used: formatCompactTokenCount(displayTokens),
      total: formatCompactTokenCount(contextWindowTokens)
    })
    const compressionHint = contextCompressionPreview.shouldCompress
      ? t('chat.context_compression_hint', {
          defaultValue:
            '\u81ea\u52a8\u538b\u7f29\u5df2\u751f\u6548\uff0c\u538b\u7f29\u524d\u7ea6 {{before}} \u6807\u8bb0',
          before: formatCompactTokenCount(contextCompressionPreview.estimatedInputTokens)
        })
      : t('chat.context_compression_idle', {
          defaultValue:
            '\u5f53\u524d\u65e0\u9700\u538b\u7f29\uff0c\u4fdd\u7559\u5b8c\u6574\u4e0a\u4e0b\u6587'
        })
    const triggerHint = t('chat.context_compression_trigger', {
      defaultValue:
        '\u8fbe\u5230 {{percent}}% \u65f6\u4f1a\u81ea\u52a8\u538b\u7f29\u66f4\u65e9\u4e0a\u4e0b\u6587',
      percent: triggerPercent
    })
    const tooltipContent = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, py: 0.25 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>
          {usageTitle}
        </Typography>
        <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.82)', lineHeight: 1.35 }}>
          {tokenUsageTitle}
        </Typography>
        <Typography
          sx={{
            fontSize: 12,
            color: contextCompressionPreview.shouldCompress ? '#9CC2FF' : 'rgba(255,255,255,0.72)',
            lineHeight: 1.35
          }}
        >
          {compressionHint}
        </Typography>
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.56)', lineHeight: 1.35 }}>
          {triggerHint}
        </Typography>
      </Box>
    )

    return (
      <Tooltip
        arrow
        placement="top"
        enterDelay={180}
        title={tooltipContent}
        slotProps={{
          tooltip: {
            sx: {
              bgcolor: 'rgba(28, 29, 33, 0.96)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 2,
              px: 1.25,
              py: 0.75,
              maxWidth: 240,
              boxShadow: '0 14px 34px rgba(0,0,0,0.35)'
            }
          },
          arrow: {
            sx: {
              color: 'rgba(28, 29, 33, 0.96)'
            }
          }
        }}
      >
        <Box
          role="img"
          aria-label={usageTitle}
          data-testid="chat-context-compression-indicator"
          sx={{
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            p: 0,
            border: 'none',
            borderRadius: '50%',
            bgcolor: 'transparent',
            cursor: 'default',
            transition: 'background-color 0.2s ease',
            '&:hover': {
              bgcolor: 'action.hover'
            }
          }}
        >
          <CircularProgress
            variant="determinate"
            value={Math.max(4, usagePercent)}
            size={18}
            thickness={5}
            sx={{
              color: indicatorColor
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              width: 5,
              height: 5,
              borderRadius: '50%',
              bgcolor: indicatorColor
            }}
          />
        </Box>
      </Tooltip>
    )
  }, [
    contextCompressionPreview.contextBudgetTokens,
    contextCompressionPreview.contextWindowTokens,
    contextCompressionPreview.estimatedCompressedInputTokens,
    contextCompressionPreview.estimatedInputTokens,
    contextCompressionPreview.shouldCompress,
    isAutoContextCompressionAvailable,
    t
  ])
  const aiImageList = useMemo(() => collectAssistantImageUrls(currentSession), [currentSession])

  const imagePreview = useImagePreview(aiImageList, active)
  const speechRecognition = useSpeechRecognition(setInputValue, t, active)

  useEffect(() => {
    const normalizedProfileId = resolveAvailableProfileId(selectedProfileId)
    if (normalizedProfileId !== selectedProfileId) {
      setSelectedProfileId(normalizedProfileId)
    }
  }, [resolveAvailableProfileId, selectedProfileId])

  useEffect(() => {
    const normalizedSkillId = resolveAvailableSkillId(selectedSkillId)
    if (normalizedSkillId !== selectedSkillId) {
      setSelectedSkillId(normalizedSkillId)
    }

    if (normalizedSkillId) {
      const category = getSkillCategoryForSkillId(customSkills, normalizedSkillId)
      if (category !== selectedSkillCategory) {
        setSelectedSkillCategory(category)
      }
      return
    }

    if (selectedSkillCategory && !skillCategories.includes(selectedSkillCategory)) {
      setSelectedSkillCategory(NO_SKILL_VALUE)
    }
  }, [
    customSkills,
    resolveAvailableSkillId,
    selectedSkillCategory,
    selectedSkillId,
    skillCategories
  ])

  // ==================== 图片右键菜单 ====================
  const [imageContextMenu, setImageContextMenu] = useState<{
    mouseX: number
    mouseY: number
    imageUrl: string
  } | null>(null)
  const handleImageContextMenu = useCallback((event: React.MouseEvent, imageUrl: string) => {
    event.preventDefault()
    setImageContextMenu((prev) =>
      prev === null ? { mouseX: event.clientX + 2, mouseY: event.clientY - 6, imageUrl } : null
    )
  }, [])

  // ==================== compact 模式历史弹窗 ====================
  const [historyOpen, setHistoryOpen] = useState(false)

  // ==================== 拖拽 ====================
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    if (active) return
    setHistoryOpen(false)
    setImageContextMenu(null)
    setIsSkillPickerOpen(false)
    setIsDragging(false)
  }, [active])

  const isLight = theme.palette.mode === 'light'

  const getDisplaySessionTitle = useCallback(
    (sessionTitle?: string | null) =>
      getLocalizedConversationTitle(sessionTitle, t('chat.new_conversation')),
    [t]
  )

  const visibleSessions = useMemo(
    () => filterVisibleSessions(sessions, searchKeyword),
    [sessions, searchKeyword]
  )

  // ==================== 外部事件：send-to-agent ====================
  // sendMessage 定义在后面，通过 ref 在 event handler 中引用
  const sendMessageRef = useRef<
    | ((overrides?: {
        content: string
        attachments?: ChatAttachment[]
        hiddenContext?: string
        targetSessionId?: string
        forcedSkillId?: string | null
        forcedProfileId?: string | null
      }) => Promise<void>)
    | null
  >(null)

  useEffect(() => {
    const handleSendToAgent = (e: Event) => {
      if (!acceptExternalInput) return
      const customEvent = e as CustomEvent<{
        image?: string
        text?: string
        hiddenText?: string
        attachment?: ChatAttachment
        attachments?: ChatAttachment[]
        scope?: string
        targetScope?: string
        autoSend?: boolean
      }>
      const detail = customEvent.detail
      const targetScope = detail.targetScope ?? detail.scope
      if (targetScope) {
        if (targetScope !== storageScope) return
      } else if (!active) {
        return
      }
      if (!sessionsLoaded) {
        pendingExternalSendToAgentRef.current.push(detail)
        return
      }

      applyExternalSendToAgentInput(detail)
    }

    window.addEventListener('send-to-agent', handleSendToAgent)
    return () => window.removeEventListener('send-to-agent', handleSendToAgent)
  }, [acceptExternalInput, active, applyExternalSendToAgentInput, sessionsLoaded, storageScope])

  useEffect(() => {
    const handleFocusComposer = (event: Event) => {
      if (!active) return
      const customEvent = event as CustomEvent<{ scope?: string }>
      if (customEvent.detail?.scope && customEvent.detail.scope !== storageScope) return
      composerInputRef.current?.focus()
    }
    window.addEventListener('chat:focus-composer', handleFocusComposer)
    return () => window.removeEventListener('chat:focus-composer', handleFocusComposer)
  }, [active, storageScope])

  // ==================== 自动保存 assistant 图片 ====================
  useEffect(() => {
    if (!sessionsLoaded || sessions.length === 0) return

    const scanCursorBySessionId = autoSaveScanCursorBySessionIdRef.current
    if (!autoSaveScanInitializedRef.current) {
      scanCursorBySessionId.clear()
      for (const session of sessions) {
        scanCursorBySessionId.set(session.id, session.messages.length)
      }
      autoSaveScanInitializedRef.current = true
      return
    }

    const autoSaveAssistantImages = async () => {
      for (const session of sessions) {
        const previousCursor = scanCursorBySessionId.get(session.id) ?? 0
        const startIndex = Math.max(0, previousCursor - 1)
        scanCursorBySessionId.set(session.id, session.messages.length)

        for (
          let messageIndex = startIndex;
          messageIndex < session.messages.length;
          messageIndex++
        ) {
          const message = session.messages[messageIndex]
          if (message.role === 'assistant' && message.attachments) {
            for (
              let attachmentIndex = 0;
              attachmentIndex < message.attachments.length;
              attachmentIndex++
            ) {
              const attachment = message.attachments[attachmentIndex]
              if (attachment.type === 'image' && attachment.url) {
                if (/^file:\/\//i.test(attachment.url)) continue
                const trackerKey = buildAutoSavedChatImageKey({
                  sessionId: session.id,
                  messageIndex,
                  attachmentIndex,
                  url: attachment.url
                })
                if (hasAutoSavedChatImageKey(trackerKey)) continue
                recordAutoSavedChatImageKey(trackerKey)

                try {
                  const targetDir = resolveProjectResourceDir({
                    config: { download_dir: config.download_dir },
                    projectId: resolveProjectIdFromStorageScope(storageScope),
                    segments: ['AutoSave', 'Agent']
                  })
                  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
                  const fileName = `agent_auto_${timestamp}.png`
                  const response = await fetch(attachment.url)
                  const blob = await response.blob()
                  const arrayBuffer = await blob.arrayBuffer()
                  const data = new Uint8Array(arrayBuffer)
                  const res = await api().svcHyper.saveImageToDir({
                    data,
                    fileName,
                    dir: targetDir
                  })
                  if (res.savedPath) {
                    persistAssistantAttachmentFileReference(
                      session.id,
                      messageIndex,
                      attachmentIndex,
                      res.savedPath
                    )
                  }
                  console.log(`[自动保存] Agent 图片已保存到 ${res.savedPath}`)
                } catch (error) {
                  console.error('[自动保存] Agent 图片保存失败:', error)
                }
              }
            }
          }
        }
      }
    }

    autoSaveAssistantImages()
  }, [
    sessions,
    sessionsLoaded,
    config.download_dir,
    persistAssistantAttachmentFileReference,
    storageScope
  ])

  // ==================== 持久化 sessions 到 IndexedDB ====================
  useEffect(() => {
    if (!sessionsLoaded) return
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    debouncedSaveAllSessions(sessions, 500, storageScope)
  }, [sessions, sessionsLoaded, storageScope])

  // ==================== 同步 currentSessionId 与 profile ====================
  useEffect(() => {
    if (!sessionsLoaded) return

    if (pendingSessionIdRef.current && sessions.some((s) => s.id === pendingSessionIdRef.current)) {
      pendingSessionIdRef.current = null
    }

    const syncSessionSelection = (session: ChatSession, sessionId: string) => {
      const skillSelection = normalizeRestoredSkillSelection(customSkills, session.skillId)
      const profileId = resolveProfileIdForSkill(skillSelection.skillId, session.profileId)
      const isPendingSkillCategorySelection =
        !session.skillId && !selectedSkillId && selectedSkillCategory !== NO_SKILL_VALUE

      if (selectedProfileId !== profileId) {
        setSelectedProfileId(profileId)
      }

      if (!isPendingSkillCategorySelection) {
        if (selectedSkillId !== skillSelection.skillId) {
          setSelectedSkillId(skillSelection.skillId)
        }
        if (selectedSkillCategory !== skillSelection.skillCategory) {
          setSelectedSkillCategory(skillSelection.skillCategory)
        }
      }

      if (
        !isPendingSkillCategorySelection &&
        ((session.profileId || null) !== profileId ||
          (session.skillId || null) !== skillSelection.skillId)
      ) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  profileId: profileId ?? undefined,
                  skillId: skillSelection.skillId ?? undefined
                }
              : s
          )
        )
      }
    }

    if (sessions.length > 0) {
      if (currentSessionId) {
        const session = sessions.find((s) => s.id === currentSessionId)
        if (session) {
          syncSessionSelection(session, currentSessionId)
        } else {
          if (pendingSessionIdRef.current === currentSessionId) return
          const latestSession = sessions[0]
          if (latestSession) {
            setActiveSessionId(latestSession.id)
            syncSessionSelection(latestSession, latestSession.id)
          }
        }
      } else {
        const latestSession = sessions[0]
        if (latestSession) {
          setActiveSessionId(latestSession.id)
          syncSessionSelection(latestSession, latestSession.id)
        }
      }
    } else {
      if (selectedSkillId !== null) {
        setSelectedSkillId(null)
      }
      if (selectedSkillCategory !== NO_SKILL_VALUE) {
        setSelectedSkillCategory(NO_SKILL_VALUE)
      }
    }

    if (availableProfiles.length > 0 && !selectedProfileId && !isAgentSkillSelected) {
      const nextProfileId = resolveProfileIdForSkill(
        selectedSkillId,
        resolveTaggingSkillBootstrapProfileId({
          skillId: selectedSkillId,
          configuredProfileId: resolveConfiguredProfileIdForSkill(selectedSkillId),
          fallbackProfileId: availableProfiles[0]?.id || null
        })
      )

      if (nextProfileId !== selectedProfileId) {
        setSelectedProfileId(nextProfileId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    customSkills,
    availableProfiles,
    currentSessionId,
    isAgentSkillSelected,
    resolveAvailableProfileId,
    resolveProfileIdForSkill,
    resolveConfiguredProfileIdForSkill,
    resolveAvailableSkillId,
    selectedProfileId,
    selectedSkillCategory,
    selectedSkillId,
    setSessions,
    sessions,
    sessionsLoaded
  ])

  // 自动创建初始 session
  useEffect(() => {
    if (!sessionsLoaded) return
    const canCreateSession =
      availableProfiles.length > 0 || config?.use_remote_llm || hasExternalAgentSkills
    if (sessions.length === 0 && canCreateSession) {
      try {
        setSessions((prev) => {
          if (prev.length > 0) return prev
          const initialProfileId =
            resolveAvailableProfileId(selectedProfileId) || availableProfiles[0]?.id || null
          const restoredSessionId = currentSessionIdRef.current
          const restoredDraft = resolvePreferredSessionDraft(
            restoredSessionId,
            undefined,
            storageScope
          )
          const newSession =
            restoredSessionId && restoredDraft
              ? createDraftRecoverySession({
                  sessionId: restoredSessionId,
                  title: t('chat.new_conversation'),
                  profileId: initialProfileId,
                  draft: restoredDraft
                })
              : createChatSession(t('chat.new_conversation'), initialProfileId)
          setActiveSessionId(newSession.id)
          setSelectedProfileId(newSession.profileId || null)
          setSelectedSkillId(newSession.skillId || null)
          setSelectedSkillCategory(NO_SKILL_VALUE)
          return [newSession]
        })
      } catch (error) {
        console.error('[ChatPage] Failed to create initial session:', error)
      }
    }
  }, [
    availableProfiles,
    config?.use_remote_llm,
    hasExternalAgentSkills,
    resolveAvailableProfileId,
    selectedProfileId,
    setSessions,
    sessions.length,
    sessionsLoaded,
    setActiveSessionId,
    storageScope,
    t
  ])

  // ==================== 滚动 ====================
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

  const isNearBottom = useCallback(() => {
    const container = chatContainerRef.current
    if (!container) return true
    return container.scrollHeight - container.scrollTop - container.clientHeight < 150
  }, [])

  const prevMessageCountRef = useRef(0)
  const prevIsLoadingRef = useRef(false)
  useEffect(() => {
    if (!active) return
    const currentMessages = sessions.find((s) => s.id === currentSessionId)?.messages || []
    const messageCount = currentMessages.length
    if (messageCount > prevMessageCountRef.current || messageCount === 0) {
      scrollToBottom()
      setTimeout(() => scrollToBottom(), 200)
    }
    prevMessageCountRef.current = messageCount
  }, [active, sessions, currentSessionId, scrollToBottom])

  useEffect(() => {
    if (!active) return
    if (prevIsLoadingRef.current && !isLoading) {
      setTimeout(() => scrollToBottom(), 100)
    }
    prevIsLoadingRef.current = isLoading
    if (isLoading && isNearBottom()) {
      scrollToBottom()
    }
  }, [active, isLoading, scrollToBottom, isNearBottom])

  // ==================== 粘贴处理 ====================
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (!active) return
      if (e.defaultPrevented) return

      const cs = sessions.find((s) => s.id === currentSessionId)
      if (!cs) return

      const quickAppPanels = document.querySelectorAll('[data-panel="quick-app"]')
      for (const panel of quickAppPanels) {
        if (panel.matches(':hover')) return
      }

      const items = e.clipboardData?.items
      if (!items) return

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type.indexOf('image') !== -1) {
          e.preventDefault()
          const blob = item.getAsFile()
          if (blob) {
            try {
              const file = new File([blob], 'pasted-image.png', { type: blob.type })
              const attachment = await buildImageChatAttachmentFromFile(file)
              setPendingAttachments((prev) => [...prev, attachment])
            } catch (error) {
              console.error('[ChatPage] Failed to process pasted image:', error)
            }
          }
          break
        }
      }
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [active, currentSessionId, sessions, setPendingAttachments])

  // ==================== 拖拽处理 ====================
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!active) return
      e.preventDefault()
      e.stopPropagation()
      if (!isDragging) setIsDragging(true)
    },
    [active, isDragging]
  )

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!active) return
      e.preventDefault()
      e.stopPropagation()
      const relatedTarget = e.relatedTarget as Node | null
      if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
        setIsDragging(false)
      }
    },
    [active]
  )

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!active) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)

      const cs = sessions.find((s) => s.id === currentSessionId)
      if (!cs) return

      const internalPayload = parseInternalImageDragPayload(e.dataTransfer)
      if (internalPayload) {
        try {
          const {
            attachments = [],
            objectUrl,
            previewImageUrl,
            promptId,
            textContent,
            hiddenTextContent,
            sourceWidth,
            sourceHeight
          } = internalPayload
          const nextAttachments: ChatAttachment[] = [...attachments]
          const hasImageAttachment = nextAttachments.some(
            (attachment) => attachment.type === 'image'
          )
          const droppedText = textContent?.trim()
          const droppedHiddenText = hiddenTextContent?.trim()
          if (!hasImageAttachment && previewImageUrl) {
            nextAttachments.push({
              type: 'image',
              url: previewImageUrl,
              mimeType: 'image/png',
              fileName: promptId ? `canvas-${promptId}.png` : 'canvas-selection.png',
              hiddenFromChatView: true,
              sourceWidth,
              sourceHeight
            })
          } else if (
            !hasImageAttachment &&
            objectUrl &&
            isImageOnlyInternalDragPayload(internalPayload)
          ) {
            nextAttachments.push({
              type: 'image',
              url: objectUrl,
              mimeType: 'image/png',
              fileName: promptId ? `canvas-${promptId}.png` : 'canvas-image.png',
              sourceWidth,
              sourceHeight
            })
          }

          if (nextAttachments.length > 0) {
            setPendingAttachments((prev) => {
              const seen = new Set(
                prev.map(
                  (attachment) =>
                    `${attachment.type}:${attachment.url}:${attachment.fileName || ''}`
                )
              )
              const merged = [...prev]

              for (const attachment of nextAttachments) {
                const key = `${attachment.type}:${attachment.url}:${attachment.fileName || ''}`
                if (seen.has(key)) continue
                seen.add(key)
                merged.push(attachment)
              }

              return merged
            })
          }

          if (droppedText) {
            setInputValue((prev) => {
              const base = prev.trim()
              return base ? `${base}\n\n${droppedText}` : droppedText
            })
          }

          if (droppedHiddenText) {
            setPendingHiddenContext((prev) => mergeHiddenContext(prev, droppedHiddenText))
          }

          if (nextAttachments.length > 0 || droppedText || droppedHiddenText) {
            return
          }
        } catch (err) {
          console.error('[ChatPage] 内部拖拽数据解析失败:', err)
        }
      }

      const dataTransferItems = e.dataTransfer.items
      if (hasDroppedDirectory(dataTransferItems)) {
        try {
          const droppedEntries = await collectDroppedDirectoryFiles(dataTransferItems)
          const droppedDirectoryFiles = resolveDroppedDirectoryImageFiles(droppedEntries)

          if (droppedDirectoryFiles.length === 0) {
            notifyWarning(
              t('chat.drop_folder_has_no_supported_images', {
                defaultValue: 'The dropped folder does not contain any supported images.'
              })
            )
            return
          }

          const nextAttachments: ChatAttachment[] = []
          for (const entry of droppedDirectoryFiles) {
            const attachmentType = getChatAttachmentTypeForFile(entry.file)
            const maxSizeMB = getChatAttachmentMaxSizeMB(attachmentType)

            if (!checkFileSize(entry.file, maxSizeMB)) {
              notifyError(
                t('chat.image_too_large', {
                  name: entry.file.name,
                  defaultValue: `${entry.file.name} is too large. Max ${maxSizeMB}MB.`
                })
              )
              continue
            }

            nextAttachments.push(
              await buildChatAttachmentFromDroppedFile(entry.file, {
                relativePath: entry.relativePath
              })
            )
          }

          if (nextAttachments.length > 0) {
            setPendingAttachments((prev) => [...prev, ...nextAttachments])
          }
          return
        } catch (error) {
          console.error('[ChatPage] Failed to process dropped directory:', error)
          notifyError(
            t('chat.drop_folder_process_failed', {
              defaultValue: 'Failed to process the dropped folder.'
            })
          )
          return
        }
      }

      const files = e.dataTransfer.files
      if (!files || files.length === 0) return

      const nextAttachments: ChatAttachment[] = []
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        try {
          const attachmentType = getChatAttachmentTypeForFile(file)
          const maxSizeMB = getChatAttachmentMaxSizeMB(attachmentType)

          if (!checkFileSize(file, maxSizeMB)) {
            const messageKey =
              attachmentType === 'image' ? 'chat.image_too_large' : 'chat.file_too_large'
            notifyError(
              t(messageKey, {
                name: file.name,
                defaultValue: `${file.name} is too large. Max ${maxSizeMB}MB.`
              })
            )
            continue
          }

          nextAttachments.push(await buildChatAttachmentFromDroppedFile(file))
        } catch (error) {
          console.error('[ChatPage] Failed to process dropped file:', error)
          const messageKey =
            getChatAttachmentTypeForFile(file) === 'image'
              ? 'chat.image_process_failed'
              : 'chat.file_process_failed'
          notifyError(
            t(messageKey, {
              name: file.name,
              defaultValue: `Failed to process ${file.name}.`
            })
          )
        }
      }

      if (nextAttachments.length > 0) {
        setPendingAttachments((prev) => [...prev, ...nextAttachments])
      }
    },
    [
      active,
      currentSessionId,
      mergeHiddenContext,
      notifyError,
      notifyWarning,
      sessions,
      setInputValue,
      setPendingAttachments,
      setPendingHiddenContext,
      t
    ]
  )

  // ==================== Session 操作 ====================
  const activateNewSession = useCallback(
    async (newSession: ChatSession) => {
      void flushSessionDraft(currentSessionIdRef.current)
      const skillSelection = normalizeRestoredSkillSelection(customSkills, newSession.skillId)

      setSelectedProfileId(newSession.profileId || null)
      setSelectedSkillId(skillSelection.skillId)
      setSelectedSkillCategory(skillSelection.skillCategory)
      inputValueRef.current = ''
      setInputValue('')
      pendingAttachmentsRef.current = []
      setPendingAttachments([])
      pendingHiddenContextRef.current = ''
      setPendingHiddenContext('')
      setEditingMessageIndex(null)
      setEditingContent('')
      setUploadProgress({})

      pendingSessionIdRef.current = newSession.id
      setSessions((prev) => [newSession, ...prev])
      if (loadingSessionIdsRef.current.has(newSession.id)) {
        const nextLoadingIds = new Set(loadingSessionIdsRef.current)
        nextLoadingIds.delete(newSession.id)
        loadingSessionIdsRef.current = nextLoadingIds
        setLoadingSessionIds(nextLoadingIds)
        try {
          localStorage.setItem(loadingIdsStorageKey, JSON.stringify([...nextLoadingIds]))
        } catch {
          /* ignore */
        }
      }
      setActiveSessionId(newSession.id)
      await saveSessionToDB(newSession, storageScope)
      emitPreviewRefresh()
    },
    [
      customSkills,
      emitPreviewRefresh,
      flushSessionDraft,
      loadingIdsStorageKey,
      setActiveSessionId,
      setInputValue,
      setPendingAttachments,
      setPendingHiddenContext,
      setSessions,
      storageScope
    ]
  )

  const createNewSession = useCallback(
    async (options?: {
      title?: string
      profileId?: string | null
      skillId?: string | null
      initialMessages?: ExternalInitialChatMessage[]
    }) => {
      const skillIdToUse = resolveAvailableSkillId(options?.skillId ?? selectedSkillId)
      const profileIdToUse = resolveProfileIdForSkill(
        skillIdToUse,
        options?.profileId ?? selectedProfileId,
        { preferConfiguredProfile: true }
      )
      const newSession = createChatSession(
        options?.title?.trim() || t('chat.new_conversation'),
        profileIdToUse,
        skillIdToUse
      )
      const initialMessages = (options?.initialMessages ?? []).filter(
        (message) =>
          message.content?.trim() ||
          (message.attachments && message.attachments.length > 0) ||
          message.ocrResult
      )
      if (initialMessages.length > 0) {
        newSession.messages = initialMessages.map((message) =>
          message.role === 'assistant'
            ? buildAssistantMessageFromResult(
                {
                  content: message.content,
                  attachments: message.attachments,
                  ocrResult: message.ocrResult
                },
                message.modelName,
                {
                  skillId: skillIdToUse
                }
              )
            : {
                role: message.role,
                content: message.content || '',
                attachments: message.attachments,
                ...(message.ocrResult ? { ocrResult: message.ocrResult } : {})
              }
        )
      }
      await activateNewSession(newSession)
      return newSession
    },
    [
      activateNewSession,
      resolveAvailableSkillId,
      resolveProfileIdForSkill,
      selectedProfileId,
      selectedSkillId,
      t
    ]
  )

  const deleteSessionRef = useRef<((id: string) => void) | null>(null)

  const updateCurrentSessionSkill = useCallback(
    (skillId: string | null) => {
      if (!currentSessionId) {
        return
      }

      setSessions((prev) =>
        prev.map((session) =>
          session.id === currentSessionId ? { ...session, skillId: skillId ?? undefined } : session
        )
      )
    },
    [currentSessionId, setSessions]
  )

  const selectSkillCategory = useCallback(
    (category: string) => {
      const nextCategory = category || NO_SKILL_VALUE
      const currentSkillCategory = selectedSkillId
        ? getSkillCategoryForSkillId(customSkills, selectedSkillId)
        : NO_SKILL_VALUE

      setSelectedSkillCategory(nextCategory)

      if (!nextCategory) {
        setSelectedSkillId(null)
        updateCurrentSessionSkill(null)
        return
      }

      if (currentSkillCategory !== nextCategory) {
        setSelectedSkillId(null)
        updateCurrentSessionSkill(null)
      }
    },
    [customSkills, selectedSkillId, updateCurrentSessionSkill]
  )

  const selectSkill = useCallback(
    async (skillId: string | null) => {
      const nextSkillId = resolveAvailableSkillId(skillId)
      const nextSkill = findCustomSkillById(customSkills, nextSkillId)
      const nextCategory = nextSkill
        ? getSkillCategoryForSkillId(customSkills, nextSkill.id)
        : selectedSkillCategory || NO_SKILL_VALUE

      setSelectedSkillId(nextSkillId)
      setSelectedSkillCategory(nextCategory)

      if (!nextSkill) {
        updateCurrentSessionSkill(null)
        return
      }

      if (nextSkill.type === 'agent') {
        const profileIdToUse = resolveProfileIdForSkill(nextSkill.id, selectedProfileId)
        const newSession = createChatSession(
          t('chat.new_conversation'),
          profileIdToUse,
          nextSkill.id
        )
        await activateNewSession(newSession)
        return
      }

      const profileIdToUse = resolveProfileIdForSkill(nextSkill.id, selectedProfileId, {
        preferConfiguredProfile: true
      })
      if (profileIdToUse !== selectedProfileId) {
        setSelectedProfileId(profileIdToUse)
      }
      if (currentSessionId) {
        setSessions((prev) =>
          prev.map((session) =>
            session.id === currentSessionId
              ? {
                  ...session,
                  profileId: profileIdToUse ?? undefined
                }
              : session
          )
        )
      }
      updateCurrentSessionSkill(nextSkill.id)
      setIsSkillPickerOpen(false)
    },
    [
      activateNewSession,
      currentSessionId,
      customSkills,
      resolveProfileIdForSkill,
      resolveAvailableSkillId,
      selectedProfileId,
      selectedSkillCategory,
      setSessions,
      t,
      updateCurrentSessionSkill
    ]
  )

  // compact 模式：监听 Layout 事件
  useEffect(() => {
    if (!compact) return
    const handleNewSession = (event: Event): void => {
      const customEvent = event as CustomEvent<{
        scope?: string
        title?: string
        profileId?: string | null
        skillId?: string | null
        requestId?: string
        initialMessages?: ExternalInitialChatMessage[]
        initialMessage?: string
        initialAttachments?: ChatAttachment[]
      }>
      if (customEvent.detail?.scope) {
        if (customEvent.detail.scope !== storageScope) return
      } else if (!active) {
        return
      }
      void createNewSession({
        title: customEvent.detail?.title,
        profileId: customEvent.detail?.profileId,
        skillId: customEvent.detail?.skillId,
        initialMessages: customEvent.detail?.initialMessages
      }).then((session) => {
        window.dispatchEvent(
          new CustomEvent('chat:session-created', {
            detail: {
              scope: storageScope,
              sessionId: session.id,
              requestId: customEvent.detail?.requestId
            }
          })
        )

        const initialMessage = customEvent.detail?.initialMessage?.trim()
        const initialAttachments = customEvent.detail?.initialAttachments
        if (!initialMessage && (!initialAttachments || initialAttachments.length === 0)) {
          return
        }

        void sendMessageRef.current?.({
          content: initialMessage || '',
          attachments: initialAttachments,
          targetSessionId: session.id,
          forcedSkillId: customEvent.detail?.skillId ?? session.skillId ?? null,
          forcedProfileId: customEvent.detail?.profileId ?? null
        })
      })
    }
    const handleToggleHistory = (event: Event): void => {
      const customEvent = event as CustomEvent<{ scope?: string }>
      if (customEvent.detail?.scope) {
        if (customEvent.detail.scope !== storageScope) return
      } else if (!active) {
        return
      }
      setHistoryOpen((prev) => !prev)
    }
    const handleSwitchSession = (event: Event): void => {
      const customEvent = event as CustomEvent<{ scope?: string; sessionId: string }>
      if (customEvent.detail?.scope) {
        if (customEvent.detail.scope !== storageScope) return
      } else if (!active) {
        return
      }
      selectSessionRef.current(customEvent.detail.sessionId)
    }
    const handleDeleteSession = (event: Event): void => {
      const customEvent = event as CustomEvent<{ scope?: string; sessionId: string }>
      if (customEvent.detail?.scope) {
        if (customEvent.detail.scope !== storageScope) return
      } else if (!active) {
        return
      }
      if (deleteSessionRef.current) {
        deleteSessionRef.current(customEvent.detail.sessionId)
      }
    }
    window.addEventListener('chat:newSession', handleNewSession)
    window.addEventListener('chat:toggleHistory', handleToggleHistory)
    window.addEventListener('chat:switchSession', handleSwitchSession)
    window.addEventListener('chat:deleteSession', handleDeleteSession)
    return () => {
      window.removeEventListener('chat:newSession', handleNewSession)
      window.removeEventListener('chat:toggleHistory', handleToggleHistory)
      window.removeEventListener('chat:switchSession', handleSwitchSession)
      window.removeEventListener('chat:deleteSession', handleDeleteSession)
    }
  }, [active, compact, createNewSession, storageScope])

  useEffect(() => {
    const handleTerminateScope = (event: Event): void => {
      const customEvent = event as CustomEvent<{ scope?: string }>
      if (customEvent.detail?.scope) {
        if (customEvent.detail.scope !== storageScope) return
      } else if (!active) {
        return
      }

      const sessionIds = new Set<string>([
        ...loadingSessionIdsRef.current,
        ...externalLoadingSessionIdsRef.current
      ])
      sessionIds.forEach((sessionId) => {
        terminateSession(sessionId)
      })
    }
    const handleTerminateSession = (event: Event): void => {
      const customEvent = event as CustomEvent<{ scope?: string; sessionId?: string }>
      if (customEvent.detail?.scope) {
        if (customEvent.detail.scope !== storageScope) return
      } else if (!active) {
        return
      }
      const sessionId = customEvent.detail?.sessionId
      if (!sessionId) return

      terminateSession(sessionId)
    }

    window.addEventListener('chat:terminate-scope', handleTerminateScope)
    window.addEventListener('chat:terminate-session', handleTerminateSession)
    return () => {
      window.removeEventListener('chat:terminate-scope', handleTerminateScope)
      window.removeEventListener('chat:terminate-session', handleTerminateSession)
    }
  }, [active, storageScope, terminateSession])

  useEffect(() => {
    const handleAppendMessage = (event: Event) => {
      const customEvent = event as CustomEvent<{
        scope?: string
        sessionId?: string
        role: ChatMessage['role']
        content?: string
        attachments?: ChatAttachment[]
        ocrResult?: ChatMessage['ocrResult']
        modelName?: string
      }>

      if (customEvent.detail?.scope) {
        if (customEvent.detail.scope !== storageScope) return
      } else if (!active) {
        return
      }

      const targetSessionId = customEvent.detail?.sessionId || currentSessionId
      if (!targetSessionId) return

      setSessions((prev) =>
        prev.map((session) =>
          session.id === targetSessionId
            ? {
                ...session,
                messages: [
                  ...session.messages,
                  customEvent.detail.role === 'assistant'
                    ? buildAssistantMessageFromResult(
                        {
                          content: customEvent.detail.content,
                          attachments: customEvent.detail.attachments,
                          ocrResult: customEvent.detail.ocrResult
                        },
                        customEvent.detail.modelName,
                        {
                          skillId: session.skillId
                        }
                      )
                    : {
                        role: customEvent.detail.role,
                        content: customEvent.detail.content || '',
                        attachments: customEvent.detail.attachments,
                        ...(customEvent.detail.ocrResult
                          ? { ocrResult: customEvent.detail.ocrResult }
                          : {})
                      }
                ]
              }
            : session
        )
      )
      emitPreviewRefresh()
    }

    window.addEventListener('chat:append-message', handleAppendMessage)
    return () => window.removeEventListener('chat:append-message', handleAppendMessage)
  }, [active, currentSessionId, emitPreviewRefresh, setSessions, storageScope])

  useEffect(() => {
    const handleConfirmationRequest = (event: Event) => {
      const customEvent = event as CustomEvent<{
        scope?: string
        sessionId?: string
        requestId?: string
        prompt?: string
        confirmLabel?: string
        cancelLabel?: string
        confirmedUserContent?: string
        cancelledUserContent?: string
      }>

      if (customEvent.detail?.scope) {
        if (customEvent.detail.scope !== storageScope) return
      } else if (!active) {
        return
      }

      const targetSessionId = customEvent.detail?.sessionId || currentSessionId
      const requestId = customEvent.detail?.requestId
      if (!targetSessionId || !requestId) return

      setPendingExternalConfirmations((prev) => ({
        ...prev,
        [targetSessionId]: {
          sessionId: targetSessionId,
          requestId,
          prompt:
            customEvent.detail?.prompt ||
            t('chat.external_confirmation_prompt', {
              defaultValue: '请确认是否继续执行。'
            }),
          confirmLabel:
            customEvent.detail?.confirmLabel ||
            t('chat.external_confirmation_confirm', {
              defaultValue: '确认执行'
            }),
          cancelLabel:
            customEvent.detail?.cancelLabel ||
            t('chat.external_confirmation_cancel', {
              defaultValue: '取消'
            }),
          confirmedUserContent:
            customEvent.detail?.confirmedUserContent ||
            t('chat.external_confirmation_confirmed_user_content', {
              defaultValue: '确认执行'
            }),
          cancelledUserContent:
            customEvent.detail?.cancelledUserContent ||
            t('chat.external_confirmation_cancelled_user_content', {
              defaultValue: '取消执行'
            })
        }
      }))
      emitPreviewRefresh()
    }

    window.addEventListener('chat:request-confirmation', handleConfirmationRequest)
    return () => {
      window.removeEventListener('chat:request-confirmation', handleConfirmationRequest)
    }
  }, [active, currentSessionId, emitPreviewRefresh, storageScope, t])

  useEffect(() => {
    if (!acceptExternalInput) return

    const emitScopeReady = (requestId?: string) => {
      window.dispatchEvent(
        new CustomEvent('chat:scope-ready', {
          detail: {
            scope: storageScope,
            requestId
          }
        })
      )
    }

    const handleScopeReadyPing = (event: Event) => {
      const customEvent = event as CustomEvent<{ scope?: string; requestId?: string }>
      if (customEvent.detail?.scope) {
        if (customEvent.detail.scope !== storageScope) return
      } else if (!active) {
        return
      }
      emitScopeReady(customEvent.detail?.requestId)
    }

    const timerId = window.setTimeout(() => {
      emitScopeReady()
    }, 0)

    window.addEventListener('chat:ping-scope-ready', handleScopeReadyPing)
    return () => {
      window.clearTimeout(timerId)
      window.removeEventListener('chat:ping-scope-ready', handleScopeReadyPing)
    }
  }, [acceptExternalInput, active, storageScope])

  const deleteSession = (sessionId: string) => {
    terminateSession(sessionId)
    deleteSessionDraftBackup(sessionId, storageScope)

    setSessions((prev) => {
      const newSessions = prev.filter((s) => s.id !== sessionId)
      if (currentSessionId === sessionId) {
        if (newSessions.length > 0) {
          setActiveSessionId(newSessions[0].id)
          const skillSelection = normalizeRestoredSkillSelection(
            customSkills,
            newSessions[0].skillId
          )
          const profileId = resolveProfileIdForSkill(
            skillSelection.skillId,
            newSessions[0].profileId
          )
          setSelectedProfileId(profileId)
          setSelectedSkillId(skillSelection.skillId)
          setSelectedSkillCategory(skillSelection.skillCategory)
        } else {
          const skillIdToUse = resolveAvailableSkillId(selectedSkillId)
          const profileIdToUse = resolveProfileIdForSkill(skillIdToUse, selectedProfileId, {
            preferConfiguredProfile: true
          })
          const newSession = createChatSession(
            t('chat.new_conversation'),
            profileIdToUse,
            skillIdToUse
          )
          setSelectedProfileId(newSession.profileId || null)
          const skillSelection = normalizeRestoredSkillSelection(customSkills, newSession.skillId)
          setSelectedSkillId(skillSelection.skillId)
          setSelectedSkillCategory(skillSelection.skillCategory)
          inputValueRef.current = ''
          setInputValue('')
          pendingAttachmentsRef.current = []
          setPendingAttachments([])
          pendingHiddenContextRef.current = ''
          setPendingHiddenContext('')
          setEditingMessageIndex(null)
          setEditingContent('')
          setUploadProgress({})
          setActiveSessionId(newSession.id)
          return [newSession]
        }
      }
      return newSessions
    })
    deleteSessionFromDB(sessionId).catch((e) =>
      console.error('[ChatPage] deleteSessionFromDB failed:', e)
    )
  }
  deleteSessionRef.current = deleteSession

  const selectSession = (sessionId: string) => {
    if (currentSessionIdRef.current && currentSessionIdRef.current !== sessionId) {
      void flushSessionDraft(currentSessionIdRef.current)
    }
    setActiveSessionId(sessionId)
    const session = sessions.find((s) => s.id === sessionId)
    const skillSelection = normalizeRestoredSkillSelection(customSkills, session?.skillId)
    const profileId = resolveProfileIdForSkill(skillSelection.skillId, session?.profileId)
    setSelectedProfileId(profileId)
    setSelectedSkillId(skillSelection.skillId)
    setSelectedSkillCategory(skillSelection.skillCategory)
    if (
      session &&
      ((session.profileId || null) !== profileId ||
        (session.skillId || null) !== skillSelection.skillId)
    ) {
      const updated = sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              profileId: profileId ?? undefined,
              skillId: skillSelection.skillId ?? undefined
            }
          : s
      )
      setSessions(updated)
    }
  }
  selectSessionRef.current = selectSession

  const selectProfile = (profileId: string | null) => {
    const nextProfileId = resolveAvailableProfileId(profileId)
    setSelectedProfileId(nextProfileId)
    if (currentSession) {
      const updated = sessions.map((s) =>
        s.id === currentSessionId ? { ...s, profileId: nextProfileId ?? undefined } : s
      )
      setSessions(updated)
    }
  }
  const selectReasoningEffort = useCallback(
    (effort: LLMReasoningEffort) => {
      if (!selectedReasoningProfileKey) {
        return
      }

      const next = normalizeReasoningPreferenceMap({
        ...reasoningEffortByProfileId,
        [selectedReasoningProfileKey]: effort
      })
      setReasoningEffortByProfileId(next)
      window.setTimeout(() => {
        dispatchReasoningEffortSync(next)
      }, 0)
    },
    [reasoningEffortByProfileId, selectedReasoningProfileKey]
  )

  // ==================== 发送消息 ====================
  const prepareOutgoingUserMessage = useCallback(
    async (content: string, attachments?: ChatAttachment[]): Promise<ChatMessage> => {
      const preparedMessage: ChatMessage = {
        role: 'user',
        content: content || '',
        attachments
      }

      const augmentedMessage = await augmentAttachmentsWithVideoBoundaryFrames(
        preparedMessage.attachments,
        preparedMessage.content
      )
      preparedMessage.content = augmentedMessage.content
      preparedMessage.attachments = augmentedMessage.attachments

      return preparedMessage
    },
    []
  )

  const sendMessage = useCallback(
    async (overrides?: {
      content: string
      attachments?: ChatAttachment[]
      hiddenContext?: string
      baseMessages?: ChatMessage[]
      targetSessionId?: string
      forcedSkillId?: string | null
      forcedProfileId?: string | null
      hy3dParams?: ReturnType<typeof getHy3dParams>
    }) => {
      const targetSessionId = overrides?.targetSessionId ?? currentSessionIdRef.current
      const cs = sessionsRef.current.find((s) => s.id === targetSessionId)

      const msgContent = overrides ? overrides.content : inputValueRef.current.trim()
      const msgAttachments = overrides
        ? overrides.attachments
        : pendingAttachmentsRef.current.length > 0
          ? [...pendingAttachmentsRef.current]
          : undefined
      const msgHiddenContext = (
        overrides ? overrides.hiddenContext : pendingHiddenContextRef.current
      )?.trim()

      if (!cs || !targetSessionId) return

      if (targetSessionId && loadingSessionIdsRef.current.has(targetSessionId)) {
        console.log('[ChatPage] Target session is still generating, skip duplicate send')
        return
      }

      const activeSkillId = resolveAvailableSkillId(
        overrides?.forcedSkillId ?? cs.skillId ?? selectedSkillId
      )
      const activeSkill = findCustomSkillById(customSkills, activeSkillId)
      const rawAttachments = mergeChatAttachmentsWithSkillReferenceAttachments(
        msgAttachments,
        activeSkill?.type === 'agent' ? undefined : activeSkill?.referenceAttachments
      )

      if (!msgContent && !rawAttachments?.length) return

      console.log(
        '[ChatPage] sendMessage: attachments:',
        summarizeChatAttachmentsForLog(rawAttachments)
      )

      let requestContent = msgContent || ''
      let userMessage: ChatMessage = {
        role: 'user',
        content: requestContent,
        attachments: rawAttachments,
        hiddenContext: msgHiddenContext || undefined
      }
      const activeSkillRuntime = activeSkill
        ? resolveSkillRuntimeSpec(activeSkill, config, availableRuntimeApps)
        : resolveSkillRuntimeSpec(null, config, availableRuntimeApps)
      if (activeSkillRuntime.unavailableBindings.length > 0) {
        notifyWarning(
          `Some bound app capabilities are unavailable for this skill: ${activeSkillRuntime.unavailableBindings
            .map((binding) => binding.appName || binding.appId)
            .join(', ')}`
        )
      }
      const serializedSkillRuntime = serializeSkillRuntimeSpec(activeSkillRuntime)
      const activeSystemPrompt = buildSystemPromptFromSkillRuntime(activeSkillRuntime)
      const activeUserPrompt = buildUserPromptFromSkillRuntime(activeSkillRuntime)
      const activeSkillCapabilityContext = buildSkillRuntimeCapabilityContext(activeSkillRuntime)
      const activeSkillResources = await resolveSkillRuntimeResourceEntries({
        runtime: activeSkillRuntime,
        config,
        runtimeApps: availableRuntimeApps,
        runtimeMcpStatus
      })
      const activeSkillResourceContext = buildSkillRuntimeResourceContext(activeSkillResources)
      const preScriptReport = resolveSkillRuntimePreScripts({
        runtime: activeSkillRuntime,
        content: requestContent
      })
      requestContent = preScriptReport.content
      const activeSkillPreScriptContext = buildSkillRuntimePreScriptContext(
        activeSkillRuntime,
        preScriptReport
      )
      const activeExternalAgentSkill = activeSkill?.type === 'agent' ? activeSkill : undefined
      const executionContext = resolveSkillExecutionContext({
        skillId: activeSkillId,
        skill: activeSkill,
        config,
        sessionMessages: cs.messages,
        overrideBaseMessages: overrides?.baseMessages,
        sessionUrl: cs?.sessionUrl
      })
      let profileId =
        overrides?.forcedProfileId ??
        (activeExternalAgentSkill
          ? null
          : resolveProfileIdForSkill(activeSkillId, cs.profileId || selectedProfileId, {
              preferConfiguredProfile: Boolean(overrides?.forcedSkillId)
            }))
      if (getBaseProfileId(profileId) === HUNYUAN_3D_PROFILE_ID) {
        const hp = overrides?.hy3dParams
          ? await refreshHy3dModelUrlIfNeeded(overrides.hy3dParams)
          : await refreshHy3dModelUrlIfNeeded(getHy3dParams())
        profileId = buildHy3dProfileId(hp)

        // For post-processing modes that need a model URL, inject it into message content
        if (HY3D_POST_PROCESS_ACTIONS.has(hp.apiAction) && hp.modelUrl) {
          // Prepend model URL to message content so backend can parse it
          const urlPrefix = hp.modelUrl.trim()
          if (urlPrefix && !requestContent.includes(urlPrefix)) {
            requestContent = `${urlPrefix}\n${requestContent}`.trim()
          }
        }
        // For texture mode, inject texturePrompt if user didn't type anything
        if (hp.apiAction === 'SubmitTextureTo3DJob' && !msgContent && hp.texturePrompt) {
          requestContent = `${hp.modelUrl || ''}\n${hp.texturePrompt}`.trim()
        }
      }

      const activeProfile =
        activeSkill && profileId
          ? availableProfiles.find((profile) => profile.id === profileId) ||
            availableProfiles.find((profile) => profile.id === getBaseProfileId(profileId)) ||
            null
          : null
      const skillAttachmentSupport =
        activeSkill && activeProfile
          ? inspectSkillAttachmentSupport(rawAttachments, activeProfile)
          : null
      if (
        skillAttachmentSupport &&
        (skillAttachmentSupport.unsupportedImages || skillAttachmentSupport.unsupportedDocuments)
      ) {
        notifyWarning(
          buildSkillAttachmentUnsupportedMessage({
            skillName: activeSkill?.skillName,
            profileName: activeProfile?.model_name || getBaseProfileId(profileId),
            supportsImages: skillAttachmentSupport.supportsImages,
            supportsDocuments: skillAttachmentSupport.supportsDocuments,
            unsupportedImages: skillAttachmentSupport.unsupportedImages,
            unsupportedDocuments: skillAttachmentSupport.unsupportedDocuments
          })
        )
        return
      }

      const explicitToolCommand = parseExplicitToolCommand(requestContent)
      userMessage = await prepareOutgoingUserMessage(requestContent, rawAttachments)
      const resolvedHiddenContext = explicitToolCommand
        ? msgHiddenContext || ''
        : mergeHiddenContext(
            msgHiddenContext || '',
            activeUserPrompt,
            activeSkillCapabilityContext,
            activeSkillResourceContext,
            activeSkillPreScriptContext
          )
      if (resolvedHiddenContext) {
        userMessage.hiddenContext = resolvedHiddenContext
      }
      const historyMessages = executionContext.historyMessages
      const currentSessionUrl = executionContext.sessionUrl
      const shouldPreserveMultiAttachmentRequest = isImageGenerationSelected
      const useAttachmentBatching =
        shouldBatchAttachments(rawAttachments) && !shouldPreserveMultiAttachmentRequest
      let latestContextCompressionSummary = cs.contextCompression
      const sessionAbortController = new AbortController()
      sessionAbortControllersRef.current.set(targetSessionId, sessionAbortController)

      const applyContextCompressionSummaryToSessions = (prev: ChatSession[]) =>
        prev.map((session) =>
          session.id === targetSessionId
            ? {
                ...session,
                contextCompression: latestContextCompressionSummary
              }
            : session
        )

      const withLatestContextCompression = (
        updater: (prev: ChatSession[]) => ChatSession[]
      ): ((prev: ChatSession[]) => ChatSession[]) => {
        return (prev) => applyContextCompressionSummaryToSessions(updater(prev))
      }
      const updateLoadingStatus = (
        label: string,
        detail: string,
        step: number,
        totalSteps = CHAT_LOADING_TOTAL_STEPS
      ) => {
        setSessionLoadingStatus(targetSessionId, {
          label,
          detail,
          step,
          totalSteps
        })
      }

      const userMsgUpdater = withLatestContextCompression((prev: ChatSession[]) =>
        applyUserMessageToSession(prev, {
          sessionId: targetSessionId,
          userMessage,
          baseMessages: overrides?.baseMessages,
          titleSource: userMessage.content || msgContent
        })
      )
      clearScheduledDraftPersistence()
      if (targetSessionId) {
        writeSessionDraftBackup(targetSessionId, Date.now(), undefined, storageScope)
      }
      setSessions(userMsgUpdater)
      if (!overrides) {
        inputValueRef.current = ''
        setInputValue('')
        pendingAttachmentsRef.current = []
        setPendingAttachments([])
        pendingHiddenContextRef.current = ''
        setPendingHiddenContext('')
      }
      if (targetSessionId) {
        loadingSessionIdsRef.current = new Set(loadingSessionIdsRef.current).add(targetSessionId)
        setLoadingSessionIds((prev) => new Set(prev).add(targetSessionId as string))
        try {
          const existing = JSON.parse(
            localStorage.getItem(loadingIdsStorageKey) || '[]'
          ) as string[]
          if (!existing.includes(targetSessionId)) {
            localStorage.setItem(
              loadingIdsStorageKey,
              JSON.stringify([...existing, targetSessionId])
            )
          }
        } catch (_e) {
          /* ignore */
        }
        emitPreviewRefresh()
      }

      const placeholderUpdater = withLatestContextCompression((prev: ChatSession[]) =>
        appendAssistantPlaceholderToSession(prev, targetSessionId)
      )
      setSessions(placeholderUpdater)
      updateLoadingStatus(
        t('chat.loading_prepare_request', {
          defaultValue: '准备请求'
        }),
        t('chat.loading_prepare_request_detail', {
          defaultValue: '正在整理消息、附件和技能上下文'
        }),
        1
      )

      // 同步保存到 IndexedDB
      skipSaveRef.current = true
      void persistCurrentSessionSnapshot(targetSessionId, 'request-placeholder')

      const persistSessionsToStorage = async (
        _updater: (prev: ChatSession[]) => ChatSession[],
        label = ''
      ): Promise<void> => {
        skipSaveRef.current = true
        await persistCurrentSessionSnapshot(targetSessionId, label)
      }

      const buildRequestMessageWithRuntimeContext = (requestMessage: ChatMessage): ChatMessage =>
        requestMessage.role === 'user'
          ? {
              ...requestMessage,
              hiddenContext: mergeHiddenContext(
                requestMessage.hiddenContext || '',
                activeUserPrompt,
                activeSkillCapabilityContext,
                activeSkillResourceContext,
                activeSkillPreScriptContext
              )
            }
          : requestMessage

      const buildRequestExecutionState = (requestMessage: ChatMessage) => {
        const requestMessageWithRuntimeContext =
          buildRequestMessageWithRuntimeContext(requestMessage)
        const compressionPlan = buildChatContextCompressionPlan({
          historyMessages,
          requestMessage: requestMessageWithRuntimeContext,
          profile: selectedCapabilityProfile,
          enabled: isAutoContextCompressionAvailable,
          cachedSummary: latestContextCompressionSummary
        })

        if (isAutoContextCompressionAvailable) {
          latestContextCompressionSummary = compressionPlan.compressionSummary
        }

        updateLoadingStatus(
          compressionPlan.shouldCompress
            ? t('chat.loading_compress_context', {
                defaultValue: '压缩上下文'
              })
            : t('chat.loading_send_request', {
                defaultValue: '发送请求'
              }),
          compressionPlan.shouldCompress
            ? t('chat.loading_compress_context_detail', {
                defaultValue: '已压缩较早对话，压缩前约 {{before}} 标记',
                before: formatCompactTokenCount(compressionPlan.estimatedInputTokens)
              })
            : t('chat.loading_send_request_detail', {
                defaultValue: '正在将当前消息发送给模型'
              }),
          2
        )

        const requestMessageWithCompressedContext =
          compressionPlan.shouldCompress && compressionPlan.compressionSummary
            ? {
                ...requestMessageWithRuntimeContext,
                hiddenContext: mergeHiddenContext(
                  compressionPlan.compressionSummary.summary,
                  requestMessageWithRuntimeContext.hiddenContext || ''
                )
              }
            : requestMessageWithRuntimeContext

        return {
          compressionPlan,
          requestMessages: [
            ...compressionPlan.requestHistoryMessages,
            requestMessageWithCompressedContext
          ]
        }
      }

      const shouldStreamStandardResponse = supportsStreamingChatCompletion({
        config,
        profileId,
        externalAgentSkill: activeExternalAgentSkill
      })
      let streamedResponse = ''
      let streamedAttachments: ChatAttachment[] = []
      let streamedSessionUrl = currentSessionUrl
      let streamedOcrResult: ChatMessage['ocrResult']
      const seenStreamAttachmentKeys = new Set<string>()

      const rememberStreamAttachment = (attachment: ChatAttachment): void => {
        const attachmentKey = `${attachment.type}:${attachment.url}:${attachment.fileName || ''}`
        if (seenStreamAttachmentKeys.has(attachmentKey)) {
          return
        }
        seenStreamAttachmentKeys.add(attachmentKey)
        streamedAttachments = [...streamedAttachments, attachment]
      }

      const requestCompletionForUserMessage = async (
        requestMessage: ChatMessage,
        sessionUrl?: string
      ) => {
        const requestState = buildRequestExecutionState(requestMessage)
        updateLoadingStatus(
          t('chat.loading_wait_response', {
            defaultValue: '等待模型响应'
          }),
          t('chat.loading_wait_response_detail', {
            defaultValue: '请求已发送，正在等待模型返回结果'
          }),
          3
        )
        const result = await requestChatCompletion({
          config,
          messages: requestState.requestMessages,
          storageScope,
          route,
          profileId,
          systemPrompt: activeSystemPrompt,
          reasoningEffort: selectedReasoningEffort,
          imageGenerationOptions,
          skillRuntime: serializedSkillRuntime,
          externalAgentSkill: activeExternalAgentSkill,
          sessionUrl,
          conversationId: targetSessionId ?? undefined,
          isEdit: !!overrides?.baseMessages,
          signal: sessionAbortController.signal
        })
        let response = result.content
        const hasStructuredResponse =
          Boolean(response?.trim()) ||
          Boolean(result.attachments?.length) ||
          Boolean(result.ocrResult)

        if (!hasStructuredResponse) {
          console.error('[ChatPage] Empty response returned from LLM')
          throw new Error('LLM returned an empty response. Please try again.')
        }

        response = response.replace(/file:\/\/\//g, 'local-media:///')
        updateLoadingStatus(
          t('chat.loading_finalize_response', {
            defaultValue: '整理结果'
          }),
          t('chat.loading_finalize_response_detail', {
            defaultValue: '正在整理回复内容和附件'
          }),
          4
        )

        return {
          result,
          response
        }
      }

      const requestStreamedCompletionForUserMessage = async (
        requestMessage: ChatMessage,
        sessionUrl?: string
      ) => {
        streamedResponse = ''
        streamedAttachments = []
        streamedSessionUrl = sessionUrl
        streamedOcrResult = undefined
        seenStreamAttachmentKeys.clear()

        const requestState = buildRequestExecutionState(requestMessage)
        updateLoadingStatus(
          t('chat.loading_wait_response', {
            defaultValue: '等待模型响应'
          }),
          t('chat.loading_wait_response_detail', {
            defaultValue: '请求已发送，正在等待模型返回首个结果'
          }),
          3
        )
        let hasMarkedStreamingOutput = false
        const streamedResult = await requestChatCompletionStream({
          config,
          messages: requestState.requestMessages,
          storageScope,
          route,
          profileId,
          systemPrompt: activeSystemPrompt,
          reasoningEffort: selectedReasoningEffort,
          imageGenerationOptions,
          skillRuntime: serializedSkillRuntime,
          externalAgentSkill: activeExternalAgentSkill,
          sessionUrl,
          conversationId: targetSessionId ?? undefined,
          isEdit: !!overrides?.baseMessages,
          signal: sessionAbortController.signal,
          onEvent: (event) => {
            if (targetSessionId && cancelledSessionsRef.current.has(targetSessionId)) {
              return
            }

            if (event.type === 'text-delta' && event.delta) {
              if (!hasMarkedStreamingOutput) {
                hasMarkedStreamingOutput = true
                updateLoadingStatus(
                  t('chat.loading_generate_answer', {
                    defaultValue: '生成回答'
                  }),
                  t('chat.loading_generate_answer_detail', {
                    defaultValue: '正在接收模型输出'
                  }),
                  4
                )
              }
              streamedResponse += event.delta
              setSessions((prev) =>
                appendAssistantDeltaToSession(prev, {
                  sessionId: targetSessionId,
                  delta: event.delta
                })
              )
              return
            }

            if (event.type === 'attachment') {
              updateLoadingStatus(
                t('chat.loading_collect_attachments', {
                  defaultValue: '整理结果'
                }),
                t('chat.loading_collect_attachments_detail', {
                  defaultValue: '正在接收生成的附件'
                }),
                4
              )
              rememberStreamAttachment(event.attachment)
              return
            }

            if (event.type === 'session') {
              streamedSessionUrl = event.sessionUrl
            }
          }
        })

        const response = streamedResult.response.replace(/file:\/\/\//g, 'local-media:///')
        streamedResponse = response
        streamedSessionUrl = streamedResult.result.sessionUrl || streamedSessionUrl
        streamedOcrResult = streamedResult.result.ocrResult
        for (const attachment of streamedResult.result.attachments || []) {
          rememberStreamAttachment(attachment)
        }

        const hasStructuredResponse =
          Boolean(response?.trim()) || streamedAttachments.length > 0 || Boolean(streamedOcrResult)

        if (!hasStructuredResponse) {
          console.error('[ChatPage] Empty streamed response returned from LLM')
          throw new Error('LLM returned an empty response. Please try again.')
        }

        updateLoadingStatus(
          t('chat.loading_finalize_response', {
            defaultValue: '整理结果'
          }),
          t('chat.loading_finalize_response_detail', {
            defaultValue: '正在整理回复内容和附件'
          }),
          4
        )

        return {
          result: {
            ...streamedResult.result,
            content: response,
            attachments: streamedAttachments.length > 0 ? streamedAttachments : undefined,
            sessionUrl: streamedSessionUrl,
            ocrResult: streamedOcrResult
          },
          response
        }
      }

      const completedAssistantMessages: ChatMessage[] = []
      const traceProjectId = resolveTraceProjectIdFromAgentRoute(route)
      const traceInputKinds = summarizeChatAttachmentKindsForTrace(rawAttachments)
      const traceLabel = activeSkill ? getCustomSkillName(activeSkill) : 'Agent'
      let traceOutputKinds: string[] = []
      let traceResponseCount = 0
      const emitAgentTraceEvent = (
        traceStatus: ProjectTraceEventStatus,
        safeSummary: string,
        options?: {
          outputKinds?: string[]
          responseCount?: number
          riskSignals?: string[]
        }
      ) => {
        emitProjectTraceRuntimeEvent({
          projectId: traceProjectId,
          scope: 'agent',
          action: activeExternalAgentSkill ? 'agent_skill_message' : 'agent_message',
          label: traceLabel,
          status: traceStatus,
          safeSummary,
          entityType: 'chat_message',
          entityCount: 1,
          inputKinds: traceInputKinds,
          outputKinds: options?.outputKinds,
          affectedItemCount: 1,
          createdItemCount: options?.responseCount,
          riskSignals: options?.riskSignals
        })
      }
      emitAgentTraceEvent(
        'info',
        `Agent request sent with ${rawAttachments?.length || 0} attachment(s).`
      )

      try {
        if (explicitToolCommand) {
          updateLoadingStatus(
            t('chat.loading_execute_tool', {
              defaultValue: '执行工具'
            }),
            t('chat.loading_execute_tool_detail', {
              defaultValue: '正在调用绑定工具并等待返回结果'
            }),
            3
          )
          const toolResult = await executeExplicitSkillToolCommand({
            commandText: requestContent,
            runtime: activeSkillRuntime,
            sessionId: targetSessionId,
            config,
            authSecret: config.chat_config?.webhook_secret
          })
          updateLoadingStatus(
            t('chat.loading_finalize_response', {
              defaultValue: '整理结果'
            }),
            t('chat.loading_finalize_response_detail', {
              defaultValue: '正在整理回复内容和附件'
            }),
            4
          )
          const responseUpdater = withLatestContextCompression((prev: ChatSession[]) =>
            replaceLastMessageInSession(prev, {
              sessionId: targetSessionId,
              message: buildAssistantMessageFromResult(
                {
                  content: runSkillRuntimePostScripts({
                    runtime: activeSkillRuntime,
                    content: toolResult.content || ''
                  })
                },
                undefined,
                {
                  skillId: activeSkillRuntime.skill?.id
                }
              ),
              sessionUrl: undefined
            })
          )

          setSessions(responseUpdater)
          await persistSessionsToStorage(responseUpdater, 'tool-response')
          traceOutputKinds = ['tool_response']
          traceResponseCount = 1
        } else if (useAttachmentBatching && rawAttachments) {
          const maxAttachmentsPerRequest = await resolveAttachmentBatchCapability({
            config,
            profileId,
            systemPrompt: activeSystemPrompt,
            externalAgentSkill: activeExternalAgentSkill
          })
          const attachmentBatchEntries = buildAttachmentBatchEntries(rawAttachments)
          const attachmentChunks = chunkAttachmentBatchEntries(
            attachmentBatchEntries,
            maxAttachmentsPerRequest
          )
          let returnedSessionUrl: string | undefined
          const executeSingleAttachmentEntry = async (
            entry: (typeof attachmentBatchEntries)[number]
          ) => {
            const singleUserMessage = await prepareOutgoingUserMessage(requestContent, [
              entry.attachment
            ])
            const singleResult = await requestCompletionForUserMessage(
              singleUserMessage,
              currentSessionUrl
            )
            returnedSessionUrl = singleResult.result.sessionUrl || returnedSessionUrl
            completedAssistantMessages.push({
              ...buildAssistantMessageFromResult(
                {
                  content: runSkillRuntimePostScripts({
                    runtime: activeSkillRuntime,
                    content: singleResult.response
                  }),
                  attachments: singleResult.result.attachments,
                  ocrResult: singleResult.result.ocrResult
                },
                undefined,
                {
                  skillId: activeSkillRuntime.skill?.id
                }
              ),
              preferredDownloadBaseName: entry.preferredDownloadBaseName
            })
          }
          const handleAttachmentChunk = async (
            chunk: (typeof attachmentChunks)[number]
          ): Promise<void> => {
            if (chunk.length === 1) {
              await executeSingleAttachmentEntry(chunk[0])
              return
            }

            const batchPrompt = buildAttachmentBatchPrompt(requestContent, chunk)
            const chunkUserMessage = await prepareOutgoingUserMessage(
              batchPrompt,
              chunk.map((entry) => entry.attachment)
            )
            const { result, response } = await requestCompletionForUserMessage(
              chunkUserMessage,
              currentSessionUrl
            )
            returnedSessionUrl = result.sessionUrl || returnedSessionUrl

            const parsedBatchResponses = parseAttachmentBatchResponse(response, chunk.length)
            if (parsedBatchResponses) {
              completedAssistantMessages.push(
                ...parsedBatchResponses.map((responseContent, index) => ({
                  ...buildAssistantMessageFromResult(
                    {
                      content: runSkillRuntimePostScripts({
                        runtime: activeSkillRuntime,
                        content: responseContent
                      })
                    },
                    undefined,
                    {
                      skillId: activeSkillRuntime.skill?.id
                    }
                  ),
                  preferredDownloadBaseName: chunk[index].preferredDownloadBaseName
                }))
              )
              return
            }

            const fallbackStrategy = activeSkillRuntime.execution.fallbackStrategy
            if (fallbackStrategy === 'smaller-batches' && chunk.length > 2) {
              const smallerChunkSize = Math.max(1, Math.floor(chunk.length / 2))
              for (let index = 0; index < chunk.length; index += smallerChunkSize) {
                await handleAttachmentChunk(chunk.slice(index, index + smallerChunkSize))
              }
              return
            }

            for (const entry of chunk) {
              await executeSingleAttachmentEntry(entry)
            }
          }

          for (const chunk of attachmentChunks) {
            await handleAttachmentChunk(chunk)
          }

          const responseUpdater = withLatestContextCompression((prev: ChatSession[]) =>
            replaceLastMessageWithMessagesInSession(prev, {
              sessionId: targetSessionId,
              messages: completedAssistantMessages,
              sessionUrl: executionContext.shouldPersistSessionUrl ? returnedSessionUrl : null
            })
          )

          setSessions(responseUpdater)
          await persistSessionsToStorage(responseUpdater, 'batched-response')
          traceOutputKinds = summarizeChatAttachmentKindsForTrace(
            completedAssistantMessages.flatMap((message) => message.attachments || [])
          )
          traceResponseCount = completedAssistantMessages.length
        } else {
          const { result, response } = shouldStreamStandardResponse
            ? await requestStreamedCompletionForUserMessage(userMessage, currentSessionUrl)
            : await requestCompletionForUserMessage(userMessage, currentSessionUrl)
          const responseUpdater = withLatestContextCompression((prev: ChatSession[]) =>
            replaceLastMessageInSession(prev, {
              sessionId: targetSessionId,
              message: buildAssistantMessageFromResult(
                {
                  content: runSkillRuntimePostScripts({
                    runtime: activeSkillRuntime,
                    content: response
                  }),
                  attachments: result.attachments,
                  ocrResult: result.ocrResult
                },
                undefined,
                {
                  skillId: activeSkillRuntime.skill?.id
                }
              ),
              sessionUrl: executionContext.shouldPersistSessionUrl ? result.sessionUrl : null
            })
          )

          setSessions(responseUpdater)
          await persistSessionsToStorage(responseUpdater, 'response')
          traceOutputKinds = summarizeChatAttachmentKindsForTrace(result.attachments)
          traceResponseCount = 1
        }
        emitAgentTraceEvent(
          'success',
          `Agent response completed with ${traceResponseCount || 1} assistant message(s).`,
          {
            outputKinds: traceOutputKinds,
            responseCount: traceResponseCount || 1
          }
        )
      } catch (error) {
        const wasCancelled = Boolean(
          targetSessionId && cancelledSessionsRef.current.has(targetSessionId)
        )
        if (wasCancelled) {
          const hasPartialStreamedResponse =
            Boolean(streamedResponse.trim()) ||
            streamedAttachments.length > 0 ||
            Boolean(streamedOcrResult)
          const cancelledUpdater = withLatestContextCompression((prev: ChatSession[]) => {
            if (completedAssistantMessages.length > 0) {
              return replaceLastMessageWithMessagesInSession(prev, {
                sessionId: targetSessionId,
                messages: completedAssistantMessages,
                sessionUrl: executionContext.shouldPersistSessionUrl ? streamedSessionUrl : null
              })
            }

            if (hasPartialStreamedResponse) {
              return replaceLastMessageInSession(prev, {
                sessionId: targetSessionId,
                message: {
                  role: 'assistant',
                  content: streamedResponse,
                  ...(streamedAttachments.length > 0 ? { attachments: streamedAttachments } : {}),
                  ...(streamedOcrResult ? { ocrResult: streamedOcrResult } : {})
                },
                sessionUrl: executionContext.shouldPersistSessionUrl ? streamedSessionUrl : null
              })
            }

            return removeTrailingEmptyAssistantMessage(prev, targetSessionId)
          })
          setSessions(cancelledUpdater)
          await persistSessionsToStorage(
            cancelledUpdater,
            hasPartialStreamedResponse ? 'cancelled-partial' : 'cancelled'
          )
          emitAgentTraceEvent(
            'warning',
            hasPartialStreamedResponse
              ? 'Agent request was cancelled after partial output.'
              : 'Agent request was cancelled before output.',
            {
              outputKinds: summarizeChatAttachmentKindsForTrace(streamedAttachments),
              responseCount: hasPartialStreamedResponse ? 1 : 0,
              riskSignals: ['cancelled']
            }
          )
        } else {
          console.error('[ChatPage] Send message error:', error)
          const runId = targetSessionId || null
          const rawErrorMessage = error instanceof Error ? error.message : String(error)
          const decoratedErrorMessage = formatChatFailureMessage(rawErrorMessage, runId)
          const errorMessage: ChatMessage = {
            role: 'assistant',
            content: t('chat.error_message', {
              error: decoratedErrorMessage
            })
          }
          const archivePayload = buildChatFailureArchivePayload({
            sessionId: runId,
            profileId,
            skillId: activeSkillRuntime.skill?.id ?? null,
            error: rawErrorMessage,
            userMessage,
            timestamp: Date.now()
          })
          void persistChatFailureArchive({
            baseDir: resolveChatFailureArchiveRootDir({
              configDownloadDir: config.download_dir,
              buildDataDir: buildEnv.pathMap.data
            }),
            runId,
            payload: archivePayload
          })
          const errorUpdater = withLatestContextCompression((prev: ChatSession[]) => {
            if (completedAssistantMessages.length > 0) {
              return replaceLastMessageWithMessagesInSession(prev, {
                sessionId: targetSessionId,
                messages: [...completedAssistantMessages, errorMessage]
              })
            }

            return replaceLastMessageInSession(prev, {
              sessionId: targetSessionId,
              message: errorMessage
            })
          })
          setSessions(errorUpdater)
          await persistSessionsToStorage(errorUpdater, 'error')
          emitAgentTraceEvent('error', 'Agent request failed before completion.', {
            riskSignals: ['runtime_error']
          })
        }
      } finally {
        if (targetSessionId) {
          const wasCancelled = cancelledSessionsRef.current.has(targetSessionId)
          if (sessionAbortControllersRef.current.get(targetSessionId) === sessionAbortController) {
            sessionAbortControllersRef.current.delete(targetSessionId)
          }
          clearLoadingSessionTracking(targetSessionId)
          emitPreviewRefresh()

          if (!wasCancelled) {
            try {
              const latestStored = await loadAllSessions(storageScope)
              skipSaveRef.current = true
              setSessions((prev) =>
                mergeLoadedSessionsWithLocal(sortSessionsByRecencyDesc(latestStored), prev, [
                  pendingSessionIdRef.current,
                  currentSessionIdRef.current
                ])
              )
            } catch (e) {
              console.warn('[ChatPage] finally: 从 IndexedDB 重新加载失败:', e)
            }
          }
          cancelledSessionsRef.current.delete(targetSessionId)
        }
      }
    },
    [
      availableProfiles,
      availableRuntimeApps,
      buildSkillAttachmentUnsupportedMessage,
      clearScheduledDraftPersistence,
      clearLoadingSessionTracking,
      config,
      customSkills,
      emitPreviewRefresh,
      loadingIdsStorageKey,
      mergeHiddenContext,
      prepareOutgoingUserMessage,
      resolveAvailableSkillId,
      resolveProfileIdForSkill,
      refreshHy3dModelUrlIfNeeded,
      runtimeMcpStatus,
      buildEnv.pathMap.data,
      selectedProfileId,
      selectedSkillId,
      imageGenerationOptions,
      setInputValue,
      setPendingAttachments,
      setPendingHiddenContext,
      setSessionLoadingStatus,
      setSessions,
      sessions,
      storageScope,
      t,
      notifyWarning,
      isAutoContextCompressionAvailable,
      selectedCapabilityProfile,
      selectedReasoningEffort
    ]
  )

  // 保持 sendMessageRef 与最新 sendMessage 同步，供 send-to-agent autoSend 使用
  sendMessageRef.current = sendMessage

  const handleSendCurrentMessage = useCallback(() => {
    void sendMessage()
  }, [sendMessage])

  const handleSendEditedMessage = useCallback(
    (
      content: string,
      attachments: ChatAttachment[] | undefined,
      hiddenContext: string | undefined,
      baseMessages: ChatMessage[]
    ) => {
      void sendMessage({ content, attachments, hiddenContext, baseMessages })
    },
    [sendMessage]
  )

  const handleSelectSkill = useCallback(
    (skillId: string | null) => {
      void selectSkill(skillId)
    },
    [selectSkill]
  )

  const skillPickerToolbarSlot = useMemo(
    () => (
      <ChatSkillPicker
        compact={compact}
        skillCategories={skillCategories}
        selectedSkillCategory={selectedSkillCategory}
        selectedSkillId={selectedSkillId}
        skillsForSelectedCategory={skillsForSelectedCategory}
        onSelectSkillCategory={selectSkillCategory}
        onSelectSkill={handleSelectSkill}
      />
    ),
    [
      compact,
      handleSelectSkill,
      selectSkillCategory,
      selectedSkillCategory,
      selectedSkillId,
      skillCategories,
      skillsForSelectedCategory
    ]
  )

  // ==================== Hunyuan 3D SidePanel generate event ====================
  useEffect(() => {
    const handleHy3dGenerate = (event: Event) => {
      if (!active) return
      void (async () => {
        try {
          const detail = (
            event as CustomEvent<{
              params?: ReturnType<typeof getHy3dParams>
              attachments?: ChatAttachment[]
            }>
          ).detail
          const hp = await refreshHy3dModelUrlIfNeeded(detail?.params || getHy3dParams())
          const hy3dAttachments = detail?.attachments || []
          const content = buildHy3dSubmissionContent(hp)

          if (!content && hy3dAttachments.length === 0) {
            console.warn('[ChatPage] hy3d:generate - no content or attachments to send')
            notifyWarning(getHy3dMissingInputMessage(hp))
            return
          }

          const submissionConflictMessage = getHy3dSubmissionConflictMessage(
            hp,
            content,
            hy3dAttachments.length
          )
          if (submissionConflictMessage) {
            notifyWarning(submissionConflictMessage)
            return
          }

          await sendMessage({
            content,
            attachments: hy3dAttachments.length > 0 ? [...hy3dAttachments] : undefined,
            forcedProfileId: HUNYUAN_3D_PROFILE_ID,
            hy3dParams: hp
          })
        } catch (error) {
          console.error('[ChatPage] hy3d:generate failed:', error)
          notifyWarning(getFriendlyHy3dRuntimeError(error))
        }
      })()
    }
    window.addEventListener('hy3d:generate', handleHy3dGenerate)
    return () => window.removeEventListener('hy3d:generate', handleHy3dGenerate)
  }, [active, notifyWarning, refreshHy3dModelUrlIfNeeded, sendMessage])

  // ==================== 文件上传 ====================
  const handleUploadFile = async () => {
    try {
      const file = await selectFile([
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.webp',
        '.mp4',
        '.webm',
        '.mov',
        '.avi',
        '.glb',
        '.gltf',
        '.obj',
        '.fbx',
        '.dae',
        '.3ds',
        '.ply',
        '.stl'
      ])
      if (!file) return

      const isImage = file.type.startsWith('image/')
      const isVideo = file.type.startsWith('video/')
      const model3dExtensions = ['.glb', '.gltf', '.obj', '.fbx', '.dae', '.3ds', '.ply', '.stl']
      const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'))
      const isModel3d = model3dExtensions.includes(fileExtension)

      if (!isImage && !isVideo && !isModel3d) return

      const maxSizeMB = isVideo ? 500 : isModel3d ? 200 : 50
      if (!checkFileSize(file, maxSizeMB)) {
        alert(`File is too large. Max ${maxSizeMB}MB, current size ${formatFileSize(file.size)}.`)
        return
      }

      let url: string
      const attachmentIndex = pendingAttachments.length
      const localFilePath = getLocalFilePath(file)

      if (isImage) {
        url = localFilePath ? `file://${localFilePath}` : fileToBlobUrl(file)
      } else if (localFilePath) {
        url = `file://${localFilePath}`
      } else if (isVideo || isModel3d) {
        url = fileToBlobUrl(file)
      } else {
        url = fileToBlobUrl(file)
      }

      setUploadProgress((prev) => ({ ...prev, [attachmentIndex]: 100 }))
      const attachment: ChatAttachment = isImage
        ? await buildImageChatAttachmentFromFile(file, url)
        : {
            type: isVideo ? 'video' : 'model3d',
            url,
            mimeType: normalizeFileMimeType(file.name, file.type),
            fileName: file.name,
            sizeBytes: file.size
          }
      setPendingAttachments((prev) => [...prev, attachment])
      setTimeout(() => {
        setUploadProgress((prev) => {
          const next = { ...prev }
          delete next[attachmentIndex]
          return next
        })
      }, 500)
    } catch (error) {
      console.error('[ChatPage] Upload file error:', error)
      alert(`上传文件失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const removeAttachment = (index: number) => {
    setPendingAttachments((prev) => {
      const attachment = prev[index]
      revokeBlobUrl(attachment?.url)
      return prev.filter((_, i) => i !== index)
    })
  }

  const promptForDccExportDir = useCallback(
    async (target: DccBridgeTarget): Promise<string | null> => {
      const title =
        target === 'unity'
          ? t('chat.pick_unity_bridge_dir', {
              defaultValue: 'Select a Unity Assets folder or a subfolder inside Assets'
            })
          : t('chat.pick_unreal_bridge_dir', {
              defaultValue: 'Select an Unreal watched source folder for Auto Reimport'
            })

      const dialogResult = await api().svcDialog.showOpenDialog({
        title,
        properties: ['openDirectory', 'createDirectory', 'promptToCreate']
      })

      const selectedPath = dialogResult.filePaths?.[0]
      if (dialogResult.canceled || !selectedPath) {
        return null
      }

      await api().svcState.saveConfig({
        config: {
          dcc_bridge_config:
            target === 'unity'
              ? { unity_export_dir: selectedPath }
              : { unreal_export_dir: selectedPath }
        }
      })

      return selectedPath
    },
    [t]
  )

  const sendModelToDcc = useCallback(
    async (attachment: ChatAttachment, target: DccBridgeTarget) => {
      if (attachment.type !== 'model3d') {
        return
      }

      const attachmentFileName =
        attachment.fileName || getDownloadFileNameFromUrl(attachment.url, 'model.glb')
      if (!isSupportedDccBridgeModelSourceFormat(attachmentFileName)) {
        notifyError(`Unsupported model format: ${attachmentFileName || 'model'}`)
        return
      }

      try {
        const configuredTargetDir =
          target === 'unity'
            ? config.dcc_bridge_config.unity_export_dir
            : config.dcc_bridge_config.unreal_export_dir

        const targetDir = configuredTargetDir.trim() || (await promptForDccExportDir(target))
        if (!targetDir) {
          return
        }

        let modelData: Uint8Array | undefined
        if (attachment.url.startsWith('blob:')) {
          const response = await fetch(attachment.url)
          modelData = new Uint8Array(await response.arrayBuffer())
        }

        const response = await api().svcDccBridge.exportModel({
          target,
          fileName: attachment.fileName,
          sourceUrl: modelData ? undefined : attachment.url,
          data: modelData,
          sourceLabel: currentSession?.title || currentSessionId || undefined
        })

        notifySuccess(
          [
            t('chat.model_sent_to_dcc_success', {
              defaultValue: `Sent ${attachment.fileName || 'model'} to ${
                target === 'unity' ? 'Unity' : 'Unreal'
              }`
            }),
            `Package: ${response.packageDir}`,
            `Manifest: ${response.manifestPath}`
          ].join('\n')
        )

        console.log('[ChatPage] DCC bridge export complete:', response)
      } catch (error) {
        console.error('[ChatPage] DCC bridge export failed:', error)
        notifyError(String(error))
        notifyWarning(
          t('chat.model_sent_to_dcc_failed', {
            defaultValue:
              error instanceof Error
                ? error.message
                : `Failed to send model to ${target === 'unity' ? 'Unity' : 'Unreal'}`
          })
        )
      }
    },
    [
      config.dcc_bridge_config.unity_export_dir,
      config.dcc_bridge_config.unreal_export_dir,
      currentSession?.title,
      currentSessionId,
      notifyError,
      notifySuccess,
      notifyWarning,
      promptForDccExportDir,
      t
    ]
  )

  const downloadAttachment = useCallback((attachment: ChatAttachment) => {
    const fallbackFileName =
      attachment.type === 'image'
        ? 'image.png'
        : attachment.type === 'video'
          ? 'video.mp4'
          : attachment.type === 'file'
            ? 'download'
            : 'model.glb'
    const resolvedFileName =
      attachment.fileName || getDownloadFileNameFromUrl(attachment.url, fallbackFileName)
    const link = document.createElement('a')
    link.href = normalizeLocalMediaUrl(attachment.url)
    link.download = resolvedFileName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [])

  const handleStopGenerating = () => {
    if (currentSessionId) {
      terminateSession(currentSessionId)
    }
  }

  const compactSkillPortal =
    compact && active && portalElement && hasCustomSkills
      ? createPortal(
          <Button
            size="small"
            variant="text"
            onClick={() => setIsSkillPickerOpen((prev) => !prev)}
            sx={{
              fontWeight: 700,
              fontSize: 12,
              borderRadius: 2,
              px: 1.5,
              py: 0.5,
              color: 'text.secondary',
              '&:hover': { bgcolor: 'action.hover', color: 'text.primary' }
            }}
          >
            {t('chat.skill', { defaultValue: '技能' })}
          </Button>,
          portalElement
        )
      : null
  const deprecatedSkillPortalDisabled = false

  // ==================== 渲染 ====================
  if (!isReady || !config) {
    return (
      <Box
        sx={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: isLight ? 'transparent' : theme.palette.background.default
        }}
      >
        <CircularProgress />
      </Box>
    )
  }

  if (
    shouldShowNoApiWarning({
      availableProfileCount: availableProfiles.length,
      useRemoteLlm: Boolean(config?.use_remote_llm),
      hasExternalAgentSkills,
      compact,
      isSkillPickerOpen,
      hasCustomSkills
    })
  ) {
    return (
      <>
        <Box
          sx={{
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: isLight ? 'transparent' : theme.palette.background.default
          }}
        >
          <Alert severity="warning" sx={{ maxWidth: 500 }}>
            <Typography variant="h6" gutterBottom>
              {t('chat.no_llm_config')}
            </Typography>
            <Typography variant="body2">{t('chat.go_to_settings')}</Typography>
          </Alert>
        </Box>
        {compactSkillPortal}
      </>
    )
  }

  return (
    <>
      <Box
        data-chat-page-root={storageScope}
        sx={{
          height: '100%',
          display: 'flex',
          overflow: 'hidden',
          bgcolor: isLight ? 'transparent' : theme.palette.background.default,
          position: 'relative'
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* 拖拽覆盖层 */}
        {isDragging && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              bgcolor: 'rgba(99, 102, 241, 0.15)',
              border: '3px dashed',
              borderColor: 'primary.main',
              borderRadius: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 9999,
              pointerEvents: 'none'
            }}
          >
            <Box sx={{ bgcolor: 'background.paper', px: 4, py: 2, borderRadius: 2, boxShadow: 3 }}>
              <Typography variant="h6" color="primary">
                {t('chat.drop_to_add_file', '松开添加附件')}
              </Typography>
            </Box>
          </Box>
        )}

        {/* 左侧会话列表（非 compact 模式） */}
        {!compact && (
          <SessionSidebar
            sessions={sessions}
            visibleSessions={visibleSessions}
            currentSessionId={currentSessionId}
            searchKeyword={searchKeyword}
            onSearchChange={setSearchKeyword}
            onCreateSession={createNewSession}
            onSelectSession={selectSession}
            onDeleteSession={deleteSession}
            getDisplaySessionTitle={getDisplaySessionTitle}
          />
        )}

        {/* 主聊天区域 */}
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minWidth: 0
          }}
        >
          {/* compact 模式历史弹窗 */}
          {compact && (
            <SessionHistoryDialog
              open={active && historyOpen}
              onClose={() => setHistoryOpen(false)}
              visibleSessions={visibleSessions}
              currentSessionId={currentSessionId}
              searchKeyword={searchKeyword}
              onSearchChange={setSearchKeyword}
              onCreateSession={createNewSession}
              onSelectSession={selectSession}
              onDeleteSession={deleteSession}
              getDisplaySessionTitle={getDisplaySessionTitle}
            />
          )}

          {/* 消息列表 */}
          {!isSkillPickerOpen ? (
            <>
              <ChatMessageList
                active={active}
                currentSession={currentSession}
                isLoading={isLoading}
                loadingStatus={currentLoadingStatus}
                pendingConfirmation={currentPendingConfirmation}
                editingMessageIndex={editingMessageIndex}
                editingContent={editingContent}
                onSetEditingIndex={setEditingMessageIndex}
                onSetEditingContent={setEditingContent}
                onSendEditedMessage={handleSendEditedMessage}
                onPreviewImage={imagePreview.setPreviewImage}
                onImageContextMenu={handleImageContextMenu}
                onDownloadAttachment={downloadAttachment}
                onSendModelToDcc={sendModelToDcc}
                onResolvePendingConfirmation={handleResolvePendingConfirmation}
                chatContainerRef={chatContainerRef}
                messagesEndRef={messagesEndRef}
              />

              {/* 底部输入框 */}
              <ChatComposer
                active={active}
                inputValue={inputValue}
                onInputChange={setInputValue}
                onSend={handleSendCurrentMessage}
                onUploadFile={handleUploadFile}
                pendingAttachments={composerPendingAttachments}
                uploadProgress={uploadProgress}
                onRemoveAttachment={removeAttachment}
                isLoading={isLoading}
                onStopGenerating={handleStopGenerating}
                disabled={!currentSession}
                composerInputRef={composerInputRef}
                onPreviewImage={imagePreview.setPreviewImage}
                selectedSkillName={
                  selectedCustomSkill ? getCustomSkillName(selectedCustomSkill) : undefined
                }
                addMenuSlot={
                  !isAgentSkillSelected
                    ? (closeMenu) => (
                        <ChatImageGenerationSettings
                          active={active}
                          value={imageGenerationOptions}
                          onChange={setImageGenerationOptions}
                          onCloseParentMenu={closeMenu}
                          referenceImageSize={imageGenerationReferenceSize}
                          variant="menuItem"
                        />
                      )
                    : undefined
                }
                toolHelpItems={selectedSkillToolHelpItems}
                onClearSkill={() => handleSelectSkill(null)}
                statusSlot={contextCompressionStatusSlot}
                modelSelectorSlot={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                    {!isAgentSkillSelected && isImageGenerationSelected ? (
                      <ChatImageGenerationSettings
                        active={active}
                        value={imageGenerationOptions}
                        onChange={setImageGenerationOptions}
                        referenceImageSize={imageGenerationReferenceSize}
                        variant="activeChip"
                      />
                    ) : null}
                    <ChatPrimarySelection
                      active={active}
                      compact={true}
                      isAgentSkillSelected={isAgentSkillSelected}
                      selectedProfileId={selectedProfileId}
                      availableProfiles={availableProfiles}
                      selectedReasoningEffort={selectedReasoningEffort}
                      availableReasoningEfforts={selectedProfileCapabilities.reasoningEfforts}
                      selectedSkillLabel={
                        selectedCustomSkill
                          ? getCustomSkillName(selectedCustomSkill)
                          : t('chat.skill_none')
                      }
                      onSelectProfile={selectProfile}
                      onSelectReasoningEffort={selectReasoningEffort}
                    />
                  </Box>
                }
              />
            </>
          ) : (
            <Box sx={{ flex: 1, overflowY: 'auto', p: 0, bgcolor: 'background.default' }}>
              <ChatSkillPicker
                compact={false}
                customSkills={customSkills}
                skillCategories={skillCategories}
                selectedSkillCategory={selectedSkillCategory}
                selectedSkillId={selectedSkillId}
                skillsForSelectedCategory={skillsForSelectedCategory}
                onSelectSkillCategory={selectSkillCategory}
                onSelectSkill={selectSkill}
              />
            </Box>
          )}
        </Box>

        {/* 图片右键菜单 */}
        <ImageContextMenu
          imageContextMenu={active ? imageContextMenu : null}
          onClose={() => setImageContextMenu(null)}
          config={config}
        />

        {/* 图片全屏预览 */}
        {active && imagePreview.previewImage && (
          <ImagePreviewOverlay
            previewImage={imagePreview.previewImage}
            imageScale={imagePreview.imageScale}
            imagePosition={imagePreview.imagePosition}
            isPreviewDragging={imagePreview.isPreviewDragging}
            currentImageIndex={imagePreview.currentImageIndex}
            aiImageListLength={aiImageList.length}
            closePreview={imagePreview.closePreview}
            handlePreviewClick={imagePreview.handlePreviewClick}
            handlePreviewWheel={imagePreview.handlePreviewWheel}
            handlePreviewMouseMove={imagePreview.handlePreviewMouseMove}
            handlePreviewMouseUp={imagePreview.handlePreviewMouseUp}
            handlePreviewMouseDown={imagePreview.handlePreviewMouseDown}
            handleImageContextMenu={handleImageContextMenu}
          />
        )}

        {/* React Portal to inject Skill Selectors into the AgentWorkspace header */}
        {deprecatedSkillPortalDisabled && portalElement
          ? createPortal(
              <Button
                size="small"
                variant="text"
                onClick={() => setIsSkillPickerOpen((prev) => !prev)}
                sx={{
                  fontWeight: 700,
                  fontSize: 12,
                  borderRadius: 2,
                  px: 1.5,
                  py: 0.5,
                  color: 'text.secondary',
                  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' }
                }}
              >
                {t('chat.skill', { defaultValue: '技能' })}
              </Button>,
              portalElement!
            )
          : null}
      </Box>
      {compactSkillPortal}
    </>
  )
}

export default ChatPage
