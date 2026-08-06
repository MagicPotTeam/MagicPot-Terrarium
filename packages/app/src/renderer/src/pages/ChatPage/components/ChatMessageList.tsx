/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-refresh/only-export-components */
import React from 'react'
import {
  Box,
  TextField,
  Typography,
  Button,
  Menu,
  MenuItem,
  Divider,
  IconButton,
  Tooltip,
  CircularProgress,
  useTheme
} from '@mui/material'
import {
  Edit as EditIcon,
  Download as DownloadIcon,
  PlayArrow as PlayArrowIcon,
  DragIndicator as DragIndicatorIcon,
  ArticleOutlined as TextFileIcon,
  DescriptionOutlined as WordFileIcon,
  FolderZipOutlined as ArchiveFileIcon,
  PictureAsPdfOutlined as PdfFileIcon,
  ViewInAr as Model3DIcon,
  InsertDriveFile as FileIcon,
  SlideshowOutlined as PowerPointFileIcon,
  KeyboardArrowDown as CollapseIcon,
  KeyboardArrowRight as ExpandIcon,
  Close as CloseIcon,
  Image as ImageIcon
} from '@mui/icons-material'
import {
  CheckCircleOutline as CopyDoneIcon,
  ContentCopy as ContentCopyIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism } from 'react-syntax-highlighter'
import { prism, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import {
  ChatMessage,
  ChatAttachment
} from '../../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { type ChatSession } from '../chatStorage'
import { normalizeLocalMediaUrl, getDownloadFileNameFromUrl } from '../chatPageShared'
import {
  buildAssistantReplyDownloadBaseName,
  extractAssistantReplyTextContent,
  type AssistantSidecarExportEntry,
  type AssistantReplyDownloadMode,
  resolveAssistantReplyDownloadMode,
  resolveAssistantSidecarExportEntries
} from '../chatReplyDownloadUtils'
import { getVisibleChatAttachments } from '../chatAttachmentVisibility'
import {
  setAgentAttachmentDragPayload,
  setAgentImageDragPayload,
  setAgentModel3DDragPayload,
  setAgentVideoDragPayload
} from '../chatDragData'
import { formatChatLoadingStatusProgress, type ChatLoadingStatus } from '../chatLoadingStatus'
import {
  buildFileMetaLabel,
  detectDisplayFileKind,
  getFileBadgeText
} from '@renderer/utils/fileDisplay'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import { DccBridgeTarget, isSupportedDccBridgeModelSourceFormat } from '@shared/api/svcDccBridge'
import type { ManagedMediaDerivativeMaxEdge, ManagedMediaSvc } from '@shared/api/svcManagedMedia'
import { normalizeMediaReference, type MediaReference } from '@shared/mediaReference'
import type { SxProps, Theme } from '@mui/material/styles'
import {
  ensureCachedChatImageDerivative,
  getChatImageDerivativeCacheKey
} from '../chatImageDerivativeScheduler'

export {
  ensureCachedChatImageDerivative,
  getChatImageDerivativeCacheSizeForTests,
  resetChatImageDerivativeCacheForTests
} from '../chatImageDerivativeScheduler'

interface ChatMessageListProps {
  active?: boolean
  currentSession: ChatSession | undefined
  isLoading: boolean
  loadingStatus?: ChatLoadingStatus
  pendingConfirmation?: ChatPendingConfirmation | null
  editingMessageIndex: number | null
  editingContent: string
  onSetEditingIndex: (index: number | null) => void
  onSetEditingContent: (content: string) => void
  onSendEditedMessage: (
    content: string,
    attachments: ChatAttachment[] | undefined,
    hiddenContext: string | undefined,
    baseMessages: ChatMessage[]
  ) => void
  onPreviewImage: (url: string) => void
  onImageContextMenu: (event: React.MouseEvent, imageUrl: string) => void
  onDownloadAttachment: (attachment: ChatAttachment) => void
  onSendModelToDcc: (attachment: ChatAttachment, target: DccBridgeTarget) => void
  onResolvePendingConfirmation?: (requestId: string, confirmed: boolean) => void
  chatContainerRef: React.RefObject<HTMLDivElement | null>
  messagesEndRef: React.RefObject<HTMLDivElement | null>
}

export type ChatPendingConfirmation = {
  requestId: string
  prompt: string
  confirmLabel: string
  cancelLabel: string
}

const COPIED_FEEDBACK_DURATION_MS = 1800
const CHAT_VIRTUALIZATION_THRESHOLD = 40
const CHAT_VIRTUALIZATION_OVERSCAN_PX = 900
const CHAT_ESTIMATED_MESSAGE_HEIGHT = 112
const CHAT_STICK_TO_BOTTOM_THRESHOLD_PX = 48
const CHAT_SESSION_SCROLL_POSITION_LIMIT = 100
const chatSessionScrollPositions = new Map<string, number>()

const CHAT_IMAGE_FALLBACK_WIDTH = 320
const CHAT_IMAGE_FALLBACK_HEIGHT = 240
const CHAT_IMAGE_DERIVATIVE_ROOT_MARGIN = '800px 0px'
const CHAT_IMAGE_DERIVATIVE_BUCKETS = [256, 512, 1024, 2048] as const

export const getChatImageDerivativeMaxEdge = (
  cssMaxDimension: number,
  devicePixelRatio: number,
  sourceMaxDimension?: number
): ManagedMediaDerivativeMaxEdge => {
  const dimension = Number.isFinite(cssMaxDimension) ? Math.max(0, cssMaxDimension) : 0
  const dpr = Number.isFinite(devicePixelRatio) ? Math.min(3, Math.max(1, devicePixelRatio)) : 1
  const validSourceEdge =
    Number.isFinite(sourceMaxDimension) && (sourceMaxDimension ?? 0) > 0
      ? (sourceMaxDimension as number)
      : undefined
  const requiredEdge = Math.min(dimension * dpr, validSourceEdge ?? Number.POSITIVE_INFINITY)
  return (
    CHAT_IMAGE_DERIVATIVE_BUCKETS.find((bucket) => requiredEdge <= bucket) ??
    CHAT_IMAGE_DERIVATIVE_BUCKETS[CHAT_IMAGE_DERIVATIVE_BUCKETS.length - 1]
  )
}

const ChatImage: React.FC<{
  src: string
  media?: MediaReference
  alt: string
  sourceWidth?: number
  sourceHeight?: number
  maxHeight: number
  margin?: string
  onPreview: () => void
  onContextMenu: (event: React.MouseEvent<HTMLImageElement>) => void
}> = ({
  src: originalSrc,
  media,
  alt,
  sourceWidth,
  sourceHeight,
  maxHeight,
  margin,
  onPreview,
  onContextMenu
}) => {
  const { t } = useTranslation()
  const frameRef = React.useRef<HTMLDivElement | null>(null)
  const generationRef = React.useRef(0)
  const abortControllerRef = React.useRef<AbortController | null>(null)
  const [displaySrc, setDisplaySrc] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)
  const [nearViewport, setNearViewport] = React.useState(false)
  const [maxEdge, setMaxEdge] = React.useState<ManagedMediaDerivativeMaxEdge | null>(null)
  const [brokenDerivativeKey, setBrokenDerivativeKey] = React.useState<string | null>(null)
  const managedMedia = React.useMemo(() => {
    const normalized = normalizeMediaReference(media)
    return normalized?.kind === 'managed' && normalized.sha256
      ? (normalized as MediaReference & { kind: 'managed'; sha256: string })
      : undefined
  }, [media])
  const mediaKey = managedMedia
    ? `${managedMedia.version}:${managedMedia.relativePath}:${managedMedia.sha256}`
    : ''

  const hasValidSourceDimensions =
    Number.isFinite(sourceWidth) &&
    Number.isFinite(sourceHeight) &&
    (sourceWidth ?? 0) > 0 &&
    (sourceHeight ?? 0) > 0
  const width = hasValidSourceDimensions ? (sourceWidth as number) : CHAT_IMAGE_FALLBACK_WIDTH
  const height = hasValidSourceDimensions ? (sourceHeight as number) : CHAT_IMAGE_FALLBACK_HEIGHT
  const displayScale = Math.min(1, 900 / width, maxHeight / height)
  const boundedWidth = width * displayScale
  const boundedHeight = height * displayScale

  React.useEffect(() => {
    generationRef.current += 1
    setDisplaySrc(null)
    setFailed(false)
    setNearViewport(false)
    setMaxEdge(null)
    setBrokenDerivativeKey(null)
  }, [managedMedia, originalSrc, mediaKey])

  React.useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    if (typeof IntersectionObserver === 'undefined') {
      // Preserve legacy image behavior in runtimes that cannot report visibility.
      if (!managedMedia) setNearViewport(true)
      return
    }
    const root = frame.closest('[data-chat-scroll-root]')
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((candidate) => candidate.target === frame) ?? entries[0]
        if (!entry) return
        generationRef.current += 1
        setNearViewport(entry.isIntersecting)
        if (!entry.isIntersecting) {
          abortControllerRef.current?.abort()
          abortControllerRef.current = null
          setDisplaySrc(null)
          setFailed(false)
        }
      },
      { root, rootMargin: CHAT_IMAGE_DERIVATIVE_ROOT_MARGIN }
    )
    observer.observe(frame)
    return () => observer.disconnect()
  }, [mediaKey, originalSrc])

  const measureRequiredEdge = React.useCallback(() => {
    const rect = frameRef.current?.getBoundingClientRect()
    const cssMaxDimension = Math.max(rect?.width || boundedWidth, rect?.height || boundedHeight)
    const sourceMaxDimension = hasValidSourceDimensions ? Math.max(width, height) : undefined
    setMaxEdge(
      getChatImageDerivativeMaxEdge(cssMaxDimension, window.devicePixelRatio, sourceMaxDimension)
    )
  }, [boundedHeight, boundedWidth, hasValidSourceDimensions, height, width])

  React.useEffect(() => {
    if (!nearViewport) return
    measureRequiredEdge()
    window.addEventListener('resize', measureRequiredEdge)
    const frame = frameRef.current
    const observer =
      frame && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(measureRequiredEdge)
        : undefined
    if (frame) observer?.observe(frame)
    return () => {
      window.removeEventListener('resize', measureRequiredEdge)
      observer?.disconnect()
    }
  }, [measureRequiredEdge, nearViewport])

  React.useEffect(() => {
    if (!nearViewport) return
    if (!managedMedia || !maxEdge) {
      setDisplaySrc(originalSrc)
      return
    }

    const cacheKey = getChatImageDerivativeCacheKey(managedMedia, maxEdge)
    if (cacheKey === brokenDerivativeKey) {
      setDisplaySrc(originalSrc)
      return
    }

    const service = (api() as unknown as { svcManagedMedia?: ManagedMediaSvc })?.svcManagedMedia
    if (typeof service?.ensureDerivative !== 'function') {
      setDisplaySrc(originalSrc)
      return
    }

    const generation = ++generationRef.current
    abortControllerRef.current?.abort()
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    void ensureCachedChatImageDerivative(service, managedMedia, maxEdge, {
      priority: -maxEdge,
      signal: abortController.signal
    }).then(
      (result) => {
        if (generation !== generationRef.current || !nearViewport) return
        setFailed(false)
        setDisplaySrc(
          result.status === 'ready' ? result.descriptor.localMediaUrl : result.localMediaUrl
        )
      },
      () => {
        if (generation !== generationRef.current || !nearViewport) return
        setFailed(false)
        setDisplaySrc(originalSrc)
      }
    )
    return () => {
      abortController.abort()
      if (abortControllerRef.current === abortController) abortControllerRef.current = null
    }
  }, [brokenDerivativeKey, managedMedia, maxEdge, nearViewport, originalSrc])

  React.useEffect(
    () => () => {
      generationRef.current += 1
    },
    []
  )

  const failureLabel = t('chat.image_load_failed_label', {
    name: alt,
    defaultValue: '{{name}} failed to load'
  })

  return (
    <Box
      ref={frameRef}
      data-testid="chat-image-frame"
      sx={{
        width: `min(100%, ${boundedWidth}px)`,
        height: boundedHeight,
        maxHeight,
        borderRadius: '12px',
        overflow: 'hidden',
        ...(margin ? { my: margin } : {})
      }}
    >
      {failed ? (
        <Box
          role="img"
          aria-label={failureLabel}
          sx={{
            width: '100%',
            height: '100%',
            borderRadius: '12px',
            border: 1,
            borderColor: 'divider',
            bgcolor: 'action.hover',
            color: 'text.secondary',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            px: 2,
            textAlign: 'center'
          }}
        >
          <Typography variant="body2">{failureLabel}</Typography>
        </Box>
      ) : displaySrc ? (
        <img
          src={displaySrc}
          alt={alt}
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          style={{
            width: '100%',
            height: '100%',
            maxWidth: '100%',
            maxHeight: `${maxHeight}px`,
            borderRadius: '12px',
            objectFit: 'contain',
            display: 'block',
            cursor: 'pointer'
          }}
          draggable
          onLoad={measureRequiredEdge}
          onError={() => {
            if (displaySrc !== originalSrc) {
              if (managedMedia && maxEdge) {
                setBrokenDerivativeKey(getChatImageDerivativeCacheKey(managedMedia, maxEdge))
              }
              generationRef.current += 1
              setFailed(false)
              setDisplaySrc(originalSrc)
              return
            }
            setFailed(true)
          }}
          onDragStart={(event) => {
            event.stopPropagation()
            event.dataTransfer.effectAllowed = 'copy'
            setAgentImageDragPayload(event.dataTransfer, originalSrc)
          }}
          onClick={onPreview}
          onContextMenu={onContextMenu}
        />
      ) : null}
    </Box>
  )
}
const CopiableIconButton: React.FC<{
  copyLabel: string
  copiedLabel: string
  iconSize?: number | string
  buttonSx?: SxProps<Theme>
  onCopy: () => void
}> = ({ copyLabel, copiedLabel, iconSize = 14, buttonSx, onCopy }) => {
  const [copied, setCopied] = React.useState(false)
  const [tooltipOpen, setTooltipOpen] = React.useState(false)
  const timerRef = React.useRef<number | null>(null)

  React.useEffect(
    () => () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
      }
    },
    []
  )

  const handleClick = React.useCallback(() => {
    onCopy()
    setCopied(true)
    setTooltipOpen(true)
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
    }
    timerRef.current = window.setTimeout(() => {
      setCopied(false)
      setTooltipOpen(false)
      timerRef.current = null
    }, COPIED_FEEDBACK_DURATION_MS)
  }, [onCopy])

  return (
    <Tooltip
      title={copied ? copiedLabel : copyLabel}
      placement="top"
      open={tooltipOpen}
      onOpen={() => setTooltipOpen(true)}
      onClose={() => {
        if (!copied) {
          setTooltipOpen(false)
        }
      }}
    >
      <IconButton
        size="small"
        aria-label={copied ? copiedLabel : copyLabel}
        onClick={handleClick}
        color={copied ? 'success' : 'default'}
        sx={buttonSx}
      >
        {copied ? (
          <CopyDoneIcon data-testid="copy-done-icon" sx={{ fontSize: iconSize }} />
        ) : (
          <ContentCopyIcon data-testid="copy-icon" sx={{ fontSize: iconSize }} />
        )}
      </IconButton>
    </Tooltip>
  )
}

const MeasuredChatRow: React.FC<{
  identity: string
  index: number
  enabled: boolean
  bottomSpacing: number
  onHeight: (identity: string, index: number, height: number) => void
  children: React.ReactNode
}> = ({ identity, index, enabled, bottomSpacing, onHeight, children }) => {
  const rowRef = React.useRef<HTMLDivElement | null>(null)

  React.useLayoutEffect(() => {
    if (!enabled || !rowRef.current) return

    const row = rowRef.current
    const initialHeight = row.getBoundingClientRect().height
    if (initialHeight > 0) onHeight(identity, index, initialHeight)
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      onHeight(identity, index, entry.contentRect.height + bottomSpacing)
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [bottomSpacing, enabled, identity, index, onHeight])

  return (
    <div
      ref={rowRef}
      data-chat-message-index={index}
      data-chat-message-identity={identity}
      style={{ width: '100%', boxSizing: 'border-box', paddingBottom: bottomSpacing }}
    >
      {children}
    </div>
  )
}

const ChatMessageList: React.FC<ChatMessageListProps> = ({
  active = true,
  currentSession,
  isLoading,
  loadingStatus,
  pendingConfirmation,
  editingMessageIndex,
  editingContent,
  onSetEditingIndex,
  onSetEditingContent,
  onSendEditedMessage,
  onPreviewImage,
  onImageContextMenu,
  onDownloadAttachment,
  onSendModelToDcc,
  onResolvePendingConfirmation,
  chatContainerRef,
  messagesEndRef
}) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const { notifySuccess } = useMessage()
  const messages = React.useMemo(() => currentSession?.messages ?? [], [currentSession?.messages])
  const contextCompressionSummary = currentSession?.contextCompression
  const sidecarExportEntries = React.useMemo(
    () => resolveAssistantSidecarExportEntries(messages, currentSession?.skillId),
    [messages, currentSession?.skillId]
  )
  const batchSidecarExportAnchorIndex =
    sidecarExportEntries.length > 1
      ? (sidecarExportEntries[sidecarExportEntries.length - 1]?.assistantMessageIndex ?? null)
      : null
  const editScrollPositionRef = React.useRef<{
    bottomOffset: number
    scrollLeft: number
  } | null>(null)

  const messageIdentityMap = React.useRef(new WeakMap<object, string>())
  const nextMessageIdentityRef = React.useRef(0)
  const restoredSessionIdRef = React.useRef<string | null>(null)
  const messageIdentities = React.useMemo(() => {
    const seen = new Map<string, number>()
    return messages.map((message) => {
      const candidate = message as ChatMessage & { id?: string; messageId?: string }
      const suppliedId = candidate.id || candidate.messageId
      let base: string
      if (suppliedId) {
        base = `message-id:${suppliedId}`
      } else {
        const messageObject = message as object
        base =
          messageIdentityMap.current.get(messageObject) ??
          `message-object:${nextMessageIdentityRef.current++}`
        messageIdentityMap.current.set(messageObject, base)
      }
      const occurrence = seen.get(base) ?? 0
      seen.set(base, occurrence + 1)
      return `${base}:${occurrence}`
    })
  }, [messages])
  const measuredHeights = React.useRef(new Map<string, number>())
  const [scroll, setScroll] = React.useState({ top: 0, viewport: 0 })
  const [heightRevision, setHeightRevision] = React.useState(0)
  const visibleStartRef = React.useRef(0)
  const pendingScrollAdjustmentRef = React.useRef(0)
  const pendingStickToBottomRef = React.useRef(false)
  const wasNearBottomRef = React.useRef(false)
  const measuredSessionIdRef = React.useRef(currentSession?.id)
  if (measuredSessionIdRef.current !== currentSession?.id) {
    measuredSessionIdRef.current = currentSession?.id
    measuredHeights.current.clear()
    pendingScrollAdjustmentRef.current = 0
    pendingStickToBottomRef.current = false
    wasNearBottomRef.current = false
    visibleStartRef.current = 0
  }
  React.useEffect(() => {
    const valid = new Set(messageIdentities)
    for (const identity of measuredHeights.current.keys()) {
      if (!valid.has(identity)) measuredHeights.current.delete(identity)
    }
  }, [messageIdentities])
  const virtualized = messages.length > CHAT_VIRTUALIZATION_THRESHOLD
  const itemHeight = React.useCallback(
    (index: number) =>
      measuredHeights.current.get(messageIdentities[index] ?? '') ?? CHAT_ESTIMATED_MESSAGE_HEIGHT,
    [messageIdentities]
  )
  const measureRow = React.useCallback(
    (identity: string, index: number, height: number) => {
      if (height <= 0) return
      const previousHeight = measuredHeights.current.get(identity) ?? CHAT_ESTIMATED_MESSAGE_HEIGHT
      if (previousHeight === height) return

      const container = chatContainerRef.current
      if (container) {
        const wasNearBottom = wasNearBottomRef.current
        pendingStickToBottomRef.current = pendingStickToBottomRef.current || wasNearBottom
        if (!wasNearBottom && index < visibleStartRef.current) {
          pendingScrollAdjustmentRef.current += height - previousHeight
        }
      }
      measuredHeights.current.set(identity, height)
      setHeightRevision((revision) => revision + 1)
    },
    [chatContainerRef]
  )
  React.useEffect(() => {
    const container = chatContainerRef.current
    if (!container) return
    const update = () => {
      const top = container.scrollTop
      wasNearBottomRef.current =
        container.scrollHeight - container.clientHeight - top <= CHAT_STICK_TO_BOTTOM_THRESHOLD_PX
      setScroll({ top, viewport: container.clientHeight })
    }
    update()
    container.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      container.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [chatContainerRef, messages.length])
  const loadingIndex = isLoading && messages.length > 0 ? messages.length - 1 : null
  const virtualWindow = React.useMemo(() => {
    void heightRevision
    if (!virtualized) {
      return {
        start: 0,
        end: messages.length,
        top: 0,
        bottom: 0,
        loadingGap: 0,
        forcedLoadingIndex: null,
        anchorStart: 0
      }
    }
    const from = Math.max(0, scroll.top - CHAT_VIRTUALIZATION_OVERSCAN_PX)
    const to = scroll.top + (scroll.viewport || 800) + CHAT_VIRTUALIZATION_OVERSCAN_PX
    const offsets = [0]
    for (let i = 0; i < messages.length; i += 1) {
      offsets.push(offsets[i] + itemHeight(i))
    }
    let start = 0
    while (start < messages.length - 1 && offsets[start + 1] < from) start += 1
    let anchorStart = 0
    while (anchorStart < messages.length - 1 && offsets[anchorStart + 1] < scroll.top) {
      anchorStart += 1
    }
    let end = start
    while (end < messages.length && offsets[end] < to) end += 1
    end = Math.max(start + 1, end)
    const forcedLoadingIndex =
      loadingIndex !== null && (loadingIndex < start || loadingIndex >= end) ? loadingIndex : null
    return {
      start,
      end,
      top: offsets[start],
      bottom:
        forcedLoadingIndex === null
          ? offsets[messages.length] - offsets[end]
          : offsets[messages.length] - offsets[forcedLoadingIndex + 1],
      loadingGap:
        forcedLoadingIndex === null ? 0 : Math.max(0, offsets[forcedLoadingIndex] - offsets[end]),
      forcedLoadingIndex,
      anchorStart
    }
  }, [
    heightRevision,
    itemHeight,
    loadingIndex,
    messages.length,
    messageIdentities,
    scroll,
    virtualized
  ])
  visibleStartRef.current = virtualWindow.anchorStart

  React.useLayoutEffect(() => {
    const sessionId = currentSession?.id
    const container = chatContainerRef.current
    if (!sessionId || !container) return

    if (restoredSessionIdRef.current === null) {
      restoredSessionIdRef.current = sessionId
    } else if (restoredSessionIdRef.current !== sessionId) {
      restoredSessionIdRef.current = sessionId
      const savedScrollTop = chatSessionScrollPositions.get(sessionId)
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      container.scrollTop =
        maxScrollTop > 0
          ? Math.min(savedScrollTop ?? maxScrollTop, maxScrollTop)
          : (savedScrollTop ?? 0)
      wasNearBottomRef.current = maxScrollTop - container.scrollTop <= 80
    }

    setScroll({ top: container.scrollTop, viewport: container.clientHeight })

    const saveScrollPosition = () => {
      chatSessionScrollPositions.delete(sessionId)
      chatSessionScrollPositions.set(sessionId, container.scrollTop)
      if (chatSessionScrollPositions.size > CHAT_SESSION_SCROLL_POSITION_LIMIT) {
        const oldestSessionId = chatSessionScrollPositions.keys().next().value
        if (oldestSessionId) chatSessionScrollPositions.delete(oldestSessionId)
      }
    }

    container.addEventListener('scroll', saveScrollPosition, { passive: true })
    return () => {
      saveScrollPosition()
      container.removeEventListener('scroll', saveScrollPosition)
    }
  }, [chatContainerRef, currentSession?.id])

  React.useLayoutEffect(() => {
    const container = chatContainerRef.current
    if (!container) return

    if (pendingStickToBottomRef.current) {
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    } else if (pendingScrollAdjustmentRef.current) {
      container.scrollTop += pendingScrollAdjustmentRef.current
    }
    pendingStickToBottomRef.current = false
    pendingScrollAdjustmentRef.current = 0
    setScroll({ top: container.scrollTop, viewport: container.clientHeight })
  }, [chatContainerRef, heightRevision])

  const handleStartEditing = React.useCallback(
    (index: number, content: string) => {
      const scrollContainer = chatContainerRef.current
      editScrollPositionRef.current = scrollContainer
        ? {
            bottomOffset:
              scrollContainer.scrollHeight -
              scrollContainer.clientHeight -
              scrollContainer.scrollTop,
            scrollLeft: scrollContainer.scrollLeft
          }
        : null
      onSetEditingIndex(index)
      onSetEditingContent(content)
    },
    [chatContainerRef, onSetEditingContent, onSetEditingIndex]
  )

  React.useLayoutEffect(() => {
    if (editingMessageIndex === null) return

    const scrollContainer = chatContainerRef.current
    const savedPosition = editScrollPositionRef.current
    if (!scrollContainer || !savedPosition) return

    scrollContainer.scrollTop =
      scrollContainer.scrollHeight - scrollContainer.clientHeight - savedPosition.bottomOffset
    scrollContainer.scrollLeft = savedPosition.scrollLeft
  }, [chatContainerRef, editingMessageIndex])

  return (
    <Box
      ref={chatContainerRef}
      data-chat-scroll-container="true"
      data-chat-scroll-root
      data-testid="chat-message-list"
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        overflowX: 'hidden',
        overflowAnchor: 'none',
        display: 'flex',
        flexDirection: 'column',
        maxWidth: '900px',
        mx: 'auto',
        width: '100%'
      }}
    >
      {contextCompressionSummary ? (
        <ContextCompressionSummaryCard
          summary={contextCompressionSummary.summary}
          coveredMessageCount={contextCompressionSummary.coveredMessageCount}
          updatedAt={contextCompressionSummary.updatedAt}
          manual={contextCompressionSummary.manual}
          t={t}
          theme={theme}
        />
      ) : null}
      {messages.length === 0 && !contextCompressionSummary && (
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.secondary',
            gap: 2
          }}
        >
          <Typography variant="h6">{t('chat.welcome_message')}</Typography>
        </Box>
      )}
      {virtualized && virtualWindow.top > 0 ? (
        <div
          data-testid="chat-virtual-top-spacer"
          style={{ height: virtualWindow.top, flexShrink: 0 }}
        />
      ) : null}
      {[
        ...Array.from(
          { length: virtualWindow.end - virtualWindow.start },
          (_, offsetIndex) => offsetIndex + virtualWindow.start
        ),
        ...(virtualWindow.forcedLoadingIndex === null ? [] : [virtualWindow.forcedLoadingIndex])
      ].map((index) => {
        const message = messages[index]
        return (
          <React.Fragment key={messageIdentities[index]}>
            {index === virtualWindow.forcedLoadingIndex && virtualWindow.loadingGap > 0 ? (
              <div
                data-testid="chat-virtual-loading-gap"
                style={{ height: virtualWindow.loadingGap, flexShrink: 0 }}
              />
            ) : null}
            <MeasuredChatRow
              key={messageIdentities[index]}
              identity={messageIdentities[index]}
              index={index}
              enabled={virtualized}
              bottomSpacing={message.role === 'user' ? 0 : 16}
              onHeight={measureRow}
            >
              {message.role === 'user' ? (
                editingMessageIndex === index ? (
                  <UserMessageEditForm
                    key={messageIdentities[index]}
                    message={message}
                    index={index}
                    editingContent={editingContent}
                    onSetEditingContent={onSetEditingContent}
                    onCancel={() => {
                      onSetEditingIndex(null)
                      onSetEditingContent('')
                    }}
                    onSubmit={(content, attachments) => {
                      const truncatedMessages = currentSession?.messages.slice(0, index) || []
                      onSetEditingIndex(null)
                      onSetEditingContent('')
                      onSendEditedMessage(
                        content,
                        attachments,
                        message.hiddenContext,
                        truncatedMessages
                      )
                    }}
                    savedChatScrollPositionRef={editScrollPositionRef}
                    isLight={isLight}
                  />
                ) : (
                  <UserMessageBubble
                    message={message}
                    index={index}
                    isLight={isLight}
                    onEdit={() => {
                      handleStartEditing(index, message.content || '')
                    }}
                    onPreviewImage={onPreviewImage}
                    onImageContextMenu={onImageContextMenu}
                    onDownloadAttachment={onDownloadAttachment}
                    onSendModelToDcc={onSendModelToDcc}
                    notifySuccess={notifySuccess}
                    t={t}
                    theme={theme}
                  />
                )
              ) : (
                <AssistantMessageBubble
                  message={message}
                  replyDownloadBaseName={buildAssistantReplyDownloadBaseName(messages, index)}
                  replyDownloadMode={resolveAssistantReplyDownloadMode(
                    messages,
                    index,
                    currentSession?.skillId
                  )}
                  batchSidecarExportEntries={
                    batchSidecarExportAnchorIndex === index ? sidecarExportEntries : undefined
                  }
                  active={active}
                  isLight={isLight}
                  isLoading={isLoading && index === messages.length - 1}
                  loadingStatus={
                    isLoading && index === messages.length - 1 ? loadingStatus : undefined
                  }
                  onPreviewImage={onPreviewImage}
                  onImageContextMenu={onImageContextMenu}
                  onDownloadAttachment={onDownloadAttachment}
                  onSendModelToDcc={onSendModelToDcc}
                  notifySuccess={notifySuccess}
                  t={t}
                  theme={theme}
                />
              )}
            </MeasuredChatRow>
          </React.Fragment>
        )
      })}
      {virtualized && virtualWindow.bottom > 0 ? (
        <div
          data-testid="chat-virtual-bottom-spacer"
          style={{
            height: virtualWindow.bottom,
            flexShrink: 0
          }}
        />
      ) : null}
      {pendingConfirmation ? (
        <PendingConfirmationPanel
          confirmation={pendingConfirmation}
          active={active}
          onResolve={onResolvePendingConfirmation}
        />
      ) : null}
      <div ref={messagesEndRef} />
    </Box>
  )
}

const ContextCompressionSummaryCard: React.FC<{
  summary: string
  coveredMessageCount: number
  updatedAt?: number
  manual?: boolean
  t: (key: string, options?: any) => string
  theme: any
}> = ({ summary, coveredMessageCount, updatedAt, manual, t, theme }) => {
  const [expanded, setExpanded] = React.useState(false)
  const timeLabel = updatedAt
    ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''
  const triggerLabel = manual
    ? t('chat.context_summary_manual', { defaultValue: 'Manual' })
    : t('chat.context_summary_auto', { defaultValue: 'Automatic' })
  const title = t('chat.context_summary_title', { defaultValue: 'Context compressed' })
  const messageCountLabel = t('chat.context_summary_message_count', {
    defaultValue: '{{count}} messages',
    count: coveredMessageCount
  })
  const summaryLabel = t('chat.context_summary_expand_label', {
    defaultValue: 'Compressed context'
  })

  return (
    <Box sx={{ px: 2, mb: 1.5, display: 'flex', justifyContent: 'flex-start' }}>
      <Box
        data-testid="chat-context-summary-card"
        sx={{
          maxWidth: '85%',
          minWidth: expanded ? 'min(680px, 100%)' : 'min(420px, 100%)',
          borderRadius: '9px',
          border: '1px solid',
          borderColor:
            theme.palette.mode === 'light' ? 'rgba(124, 58, 237, 0.18)' : 'rgba(255,255,255,0.08)',
          bgcolor:
            theme.palette.mode === 'light' ? 'rgba(247, 244, 255, 0.92)' : 'rgba(48, 40, 53, 0.92)',
          boxShadow:
            theme.palette.mode === 'light'
              ? '0 8px 20px rgba(88, 28, 135, 0.08)'
              : '0 10px 24px rgba(0,0,0,0.18)',
          overflow: 'hidden'
        }}
      >
        <Box
          component="button"
          type="button"
          data-testid="chat-context-summary-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          sx={{
            width: '100%',
            border: 0,
            bgcolor: 'transparent',
            color: 'text.primary',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1,
            py: 0.65,
            font: 'inherit',
            textAlign: 'left',
            '&:hover': {
              bgcolor:
                theme.palette.mode === 'light'
                  ? 'rgba(124, 58, 237, 0.06)'
                  : 'rgba(255,255,255,0.04)'
            }
          }}
        >
          <Typography component="span" sx={{ color: '#f59e0b', fontSize: 12, lineHeight: 1 }}>
            ◉
          </Typography>
          <Typography
            component="span"
            sx={{
              fontWeight: 800,
              fontSize: 12.5,
              color: theme.palette.mode === 'light' ? '#5b21b6' : '#f5d0fe',
              whiteSpace: 'nowrap'
            }}
          >
            {title}
          </Typography>
          <Typography
            component="span"
            sx={{
              minWidth: 0,
              flex: 1,
              color: 'text.secondary',
              fontSize: 11.5,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {triggerLabel} · {messageCountLabel}
            {timeLabel ? ` · ${timeLabel}` : ''}
          </Typography>
          {expanded ? (
            <CollapseIcon sx={{ fontSize: 17, color: 'text.secondary' }} />
          ) : (
            <ExpandIcon sx={{ fontSize: 17, color: 'text.secondary' }} />
          )}
        </Box>
        {expanded ? (
          <Box
            data-testid="chat-context-summary-content"
            sx={{
              px: 1.1,
              pb: 1,
              pt: 0.35,
              borderTop: '1px solid',
              borderColor:
                theme.palette.mode === 'light'
                  ? 'rgba(124, 58, 237, 0.14)'
                  : 'rgba(255,255,255,0.08)'
            }}
          >
            <Typography
              variant="caption"
              sx={{ display: 'block', mb: 0.65, color: 'text.secondary', fontWeight: 600 }}
            >
              ✓ {summaryLabel}
            </Typography>
            <Box
              sx={{
                maxHeight: 320,
                overflow: 'auto',
                borderRadius: '8px',
                bgcolor:
                  theme.palette.mode === 'light' ? 'rgba(255,255,255,0.76)' : 'rgba(0,0,0,0.18)',
                px: 1,
                py: 0.85,
                fontSize: 13,
                '& p': { my: 0.4 },
                '& ul, & ol': { my: 0.5, pl: 2.2 },
                '& h1, & h2, & h3': { mt: 1, mb: 0.55, fontSize: '0.92rem' },
                '& code': {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: '0.84em'
                }
              }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

const PendingConfirmationPanel: React.FC<{
  confirmation: ChatPendingConfirmation
  active: boolean
  onResolve?: (requestId: string, confirmed: boolean) => void
}> = ({ confirmation, active, onResolve }) => (
  <Box sx={{ px: 2, mb: 2 }}>
    <Box
      data-testid="chat-pending-confirmation"
      sx={{
        maxWidth: '85%',
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        p: 1.5,
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25
      }}
    >
      <Typography variant="body2" sx={{ color: 'text.primary', lineHeight: 1.6 }}>
        {confirmation.prompt}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          size="small"
          disabled={!active}
          onClick={() => onResolve?.(confirmation.requestId, true)}
          sx={{ borderRadius: '18px', textTransform: 'none' }}
        >
          {confirmation.confirmLabel}
        </Button>
        <Button
          variant="outlined"
          size="small"
          disabled={!active}
          onClick={() => onResolve?.(confirmation.requestId, false)}
          sx={{ borderRadius: '18px', textTransform: 'none' }}
        >
          {confirmation.cancelLabel}
        </Button>
      </Box>
    </Box>
  </Box>
)

const ModelAttachmentCard: React.FC<{
  attachment: ChatAttachment
  onDownloadAttachment: (attachment: ChatAttachment) => void
  onSendModelToDcc: (attachment: ChatAttachment, target: DccBridgeTarget) => void
  t: (key: string, options?: any) => string
  theme: any
}> = ({ attachment, onDownloadAttachment, onSendModelToDcc, t, theme }) => {
  const sourceUrl = attachment.url || ''
  const isBridgeable = !!sourceUrl
  const attachmentFileName =
    attachment.fileName || getDownloadFileNameFromUrl(sourceUrl, 'model.glb')
  const isSupportedFormat = isSupportedDccBridgeModelSourceFormat(attachmentFileName)

  return (
    <Box
      draggable={isBridgeable}
      onDragStart={(event) => {
        if (!sourceUrl) return
        event.stopPropagation()
        event.dataTransfer.effectAllowed = 'copy'
        setAgentModel3DDragPayload(event.dataTransfer, sourceUrl)
      }}
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: '12px',
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        bgcolor: theme.palette.background.paper
      }}
    >
      <Model3DIcon sx={{ fontSize: 48, color: 'text.secondary' }} />
      <Typography variant="body2" color="text.secondary">
        {attachment.fileName || t('chat.model3d_file')}
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 1 }}>
        <Tooltip title={t('chat.download_attachment')}>
          <span>
            <IconButton size="small" onClick={() => onDownloadAttachment(attachment)}>
              <DownloadIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Button
          size="small"
          variant="outlined"
          disabled={!isBridgeable || !isSupportedFormat}
          title={
            isBridgeable && !isSupportedFormat
              ? `Unsupported model format: ${attachmentFileName || 'model'}`
              : undefined
          }
          onClick={() => onSendModelToDcc(attachment, 'unity')}
        >
          {t('chat.send_to_unity', { defaultValue: 'Unity' })}
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={!isBridgeable || !isSupportedFormat}
          title={
            isBridgeable && !isSupportedFormat
              ? `Unsupported model format: ${attachmentFileName || 'model'}`
              : undefined
          }
          onClick={() => onSendModelToDcc(attachment, 'unreal')}
        >
          {t('chat.send_to_unreal', { defaultValue: 'Unreal' })}
        </Button>
      </Box>
    </Box>
  )
}

const renderFileAttachmentIcon = (attachment: ChatAttachment) => {
  const kind = detectDisplayFileKind(attachment.fileName, attachment.mimeType)

  switch (kind) {
    case 'markdown':
    case 'text':
      return <TextFileIcon sx={{ fontSize: 36, color: '#38bdf8' }} />
    case 'word':
      return <WordFileIcon sx={{ fontSize: 36, color: '#60a5fa' }} />
    case 'powerpoint':
      return <PowerPointFileIcon sx={{ fontSize: 36, color: '#fb923c' }} />
    case 'pdf':
      return <PdfFileIcon sx={{ fontSize: 36, color: '#f87171' }} />
    case 'archive':
      return <ArchiveFileIcon sx={{ fontSize: 36, color: '#c084fc' }} />
    default:
      return <FileIcon sx={{ fontSize: 36, color: 'text.secondary' }} />
  }
}

const FileAttachmentCard: React.FC<{
  attachment: ChatAttachment
  ocrResult?: ChatAttachment['ocrResult']
  onDownloadAttachment: (attachment: ChatAttachment) => void
  t: (key: string, options?: any) => string
  theme: any
}> = ({ attachment, ocrResult, onDownloadAttachment, t, theme }) => {
  const folderBodyColor = theme.palette.mode === 'light' ? '#f8fafc' : '#1f2937'
  const folderTabColor = theme.palette.mode === 'light' ? '#eef2ff' : '#111827'

  return (
    <Box
      draggable={Boolean(attachment.url)}
      onDragStart={(event) => {
        if (!attachment.url) return
        event.stopPropagation()
        event.dataTransfer.effectAllowed = 'copy'
        setAgentAttachmentDragPayload(event.dataTransfer, attachment, { ocrResult })
      }}
      sx={{
        position: 'relative',
        mt: 1.25,
        border: 1,
        borderColor: 'divider',
        borderRadius: '16px',
        p: 2,
        pt: 2.5,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        bgcolor: folderBodyColor,
        boxShadow: '0 10px 24px rgba(15,23,42,0.14)',
        cursor: 'default',
        overflow: 'visible',
        '&::before': {
          content: '""',
          position: 'absolute',
          left: 18,
          top: -11,
          width: 76,
          height: 16,
          border: '1px solid',
          borderBottom: 'none',
          borderColor: 'divider',
          borderRadius: '12px 12px 0 0',
          bgcolor: folderTabColor
        },
        '&:active': {
          cursor: 'default'
        }
      }}
    >
      {renderFileAttachmentIcon(attachment)}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, mb: 0.25 }}>
          <Typography variant="caption" color="primary" sx={{ fontWeight: 700 }}>
            {getFileBadgeText(attachment.fileName, attachment.mimeType)}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {buildFileMetaLabel({
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes
            })}
          </Typography>
        </Box>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {attachment.fileName || t('chat.file')}
        </Typography>
      </Box>
      <IconButton
        size="small"
        onClick={() => onDownloadAttachment(attachment)}
        title={t('chat.download_attachment')}
      >
        <DownloadIcon />
      </IconButton>
    </Box>
  )
}

const sortReportBundleAttachmentsForDisplay = (
  attachments: ChatAttachment[] | undefined
): ChatAttachment[] => {
  const visibleAttachments = getVisibleChatAttachments(attachments)
  if (!visibleAttachments.length) {
    return []
  }

  return [...visibleAttachments].sort((left, right) => {
    const leftRank =
      left.reportBundleRole === 'primary-report'
        ? 0
        : left.reportBundleRole === 'report-image'
          ? 1
          : left.reportBundleRole === 'report-ocr'
            ? 2
            : 3
    const rightRank =
      right.reportBundleRole === 'primary-report'
        ? 0
        : right.reportBundleRole === 'report-image'
          ? 1
          : right.reportBundleRole === 'report-ocr'
            ? 2
            : 3
    return leftRank - rightRank
  })
}

const TextDragHandle: React.FC<{
  content: string
  title: string
}> = ({ content, title }) => (
  <Tooltip title={title} placement="top">
    <IconButton
      size="small"
      draggable
      aria-label={title}
      onDragStart={(event) => {
        event.stopPropagation()
        event.dataTransfer.setData('text/plain', content || '')
        event.dataTransfer.effectAllowed = 'copy'
      }}
      sx={{
        color: 'text.disabled',
        width: 28,
        height: 28,
        cursor: 'default',
        '&:hover': { color: 'text.secondary' },
        '&:active': { cursor: 'default' }
      }}
    >
      <DragIndicatorIcon sx={{ fontSize: 16 }} />
    </IconButton>
  </Tooltip>
)

const downloadTextContentFile = (
  content: string,
  fileName: string,
  mimeType: 'text/markdown;charset=utf-8' | 'text/plain;charset=utf-8'
) => {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

const getAttachmentDownloadFileName = (attachment: ChatAttachment): string => {
  const explicitFileName = attachment.fileName?.trim()
  if (explicitFileName) {
    return explicitFileName
  }

  const fallback =
    attachment.type === 'image'
      ? 'image.png'
      : attachment.type === 'video'
        ? 'video.mp4'
        : attachment.type === 'model3d'
          ? 'model.glb'
          : 'download'

  return getDownloadFileNameFromUrl(attachment.url, fallback)
}

const buildAttachmentDownloadMenuLabel = (
  attachment: ChatAttachment,
  t: (key: string, options?: any) => string
): string => {
  const fileName = getAttachmentDownloadFileName(attachment)

  switch (attachment.type) {
    case 'image':
      return t('chat.download_image_option', {
        defaultValue: `Image: ${fileName}`
      })
    case 'video':
      return t('chat.download_video_option', {
        defaultValue: `Video: ${fileName}`
      })
    case 'model3d':
      return t('chat.download_model_option', {
        defaultValue: `3D model: ${fileName}`
      })
    case 'file':
    default:
      return t('chat.download_file_option', {
        defaultValue: `File: ${fileName}`
      })
  }
}

// --- 用户消息编辑表单 ---
const UserMessageEditForm: React.FC<{
  message: ChatMessage
  index: number
  editingContent: string
  onSetEditingContent: (content: string) => void
  onCancel: () => void
  onSubmit: (content: string, attachments?: ChatAttachment[]) => void
  savedChatScrollPositionRef: React.MutableRefObject<{
    bottomOffset: number
    scrollLeft: number
  } | null>
  isLight: boolean
}> = ({
  message,
  editingContent,
  onSetEditingContent,
  onCancel,
  onSubmit,
  savedChatScrollPositionRef,
  isLight
}) => {
  const { t } = useTranslation()
  const [editingAttachments, setEditingAttachments] = React.useState<ChatAttachment[]>(
    () => message.attachments ?? []
  )
  const visibleAttachments = getVisibleChatAttachments(editingAttachments)
  const removeAttachment = (attachment: ChatAttachment): void => {
    setEditingAttachments((current) => current.filter((item) => item !== attachment))
  }
  const editorRef = React.useRef<HTMLTextAreaElement | null>(null)
  const initialCaretPositionRef = React.useRef(editingContent.length)
  const hasPositionedInitialCaretRef = React.useRef(false)
  const pendingSelectionRef = React.useRef<{
    start: number
    end: number
    scrollTop: number
    scrollLeft: number
    chatScrollTop: number | null
    chatScrollLeft: number | null
    value: string
  } | null>(null)
  const userBubbleBg = isLight ? '#eee7ff' : '#6f5bd6'
  const userBubbleText = isLight ? '#2f235f' : '#ffffff'

  React.useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const chatScrollContainer = editor.closest(
      '[data-chat-scroll-container="true"]'
    ) as HTMLElement | null
    const savedChatScrollPosition = savedChatScrollPositionRef.current
    const restoreSavedChatScrollPosition = () => {
      if (!chatScrollContainer || !savedChatScrollPosition) return
      chatScrollContainer.scrollTop =
        chatScrollContainer.scrollHeight -
        chatScrollContainer.clientHeight -
        savedChatScrollPosition.bottomOffset
      chatScrollContainer.scrollLeft = savedChatScrollPosition.scrollLeft
    }
    const pendingSelection = pendingSelectionRef.current
    if (pendingSelection) {
      pendingSelectionRef.current = null
      editor.setSelectionRange(pendingSelection.start, pendingSelection.end)
      editor.scrollTop = pendingSelection.scrollTop
      editor.scrollLeft = pendingSelection.scrollLeft
      if (
        chatScrollContainer &&
        pendingSelection.chatScrollTop !== null &&
        pendingSelection.chatScrollLeft !== null
      ) {
        chatScrollContainer.scrollTop = pendingSelection.chatScrollTop
        chatScrollContainer.scrollLeft = pendingSelection.chatScrollLeft
      }
      return
    }

    if (!hasPositionedInitialCaretRef.current) {
      hasPositionedInitialCaretRef.current = true
      const caretPosition = initialCaretPositionRef.current
      restoreSavedChatScrollPosition()
      editor.focus({ preventScroll: true })
      editor.setSelectionRange(caretPosition, caretPosition)
      editor.scrollTop = editor.scrollHeight
      restoreSavedChatScrollPosition()
      const frame = window.requestAnimationFrame(restoreSavedChatScrollPosition)
      return () => window.cancelAnimationFrame(frame)
    }

    return undefined
  }, [editingContent, savedChatScrollPositionRef])

  const handleEditorChange = React.useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const editor = event.currentTarget
      const chatScrollContainer = editor.closest(
        '[data-chat-scroll-container="true"]'
      ) as HTMLElement | null
      pendingSelectionRef.current = {
        start: editor.selectionStart,
        end: editor.selectionEnd,
        scrollTop: editor.scrollTop,
        scrollLeft: editor.scrollLeft,
        chatScrollTop: chatScrollContainer?.scrollTop ?? null,
        chatScrollLeft: chatScrollContainer?.scrollLeft ?? null,
        value: editor.value
      }
      onSetEditingContent(editor.value)
    },
    [onSetEditingContent]
  )

  return (
    <Box sx={{ px: 2, mb: 2, display: 'flex', justifyContent: 'flex-end' }}>
      <Box sx={{ maxWidth: '85%', width: '100%' }}>
        {visibleAttachments.length > 0 && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
            {visibleAttachments.map((attachment, attachmentIndex) => (
              <Box
                key={`${attachment.fileName || attachment.url || 'attachment'}-${attachmentIndex}`}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.75,
                  maxWidth: 300,
                  pl: 1.25,
                  pr: 0.25,
                  py: 0.25,
                  borderRadius: 1,
                  bgcolor: 'action.selected'
                }}
              >
                <ImageIcon sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }} />
                <Typography
                  variant="body2"
                  sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {attachment.fileName || 'Image'}
                </Typography>
                <IconButton
                  size="small"
                  aria-label={`Remove ${attachment.fileName || 'image'}`}
                  onClick={() => removeAttachment(attachment)}
                  sx={{ flexShrink: 0 }}
                >
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Box>
            ))}
          </Box>
        )}
        <TextField
          fullWidth
          multiline
          inputRef={editorRef}
          value={editingContent}
          onChange={handleEditorChange}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
          }}
          variant="outlined"
          sx={{
            '& .MuiOutlinedInput-root': {
              borderRadius: '18px',
              bgcolor: userBubbleBg
            },
            '& .MuiInputBase-input': {
              color: userBubbleText
            }
          }}
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
          <Button
            variant="text"
            size="small"
            onClick={onCancel}
            sx={{ borderRadius: '18px', textTransform: 'none' }}
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="contained"
            size="small"
            disabled={!editingContent.trim()}
            onClick={() => {
              const newContent = editingContent.trim()
              if (!newContent) return
              onSubmit(newContent, editingAttachments.length > 0 ? editingAttachments : undefined)
            }}
            sx={{ borderRadius: '18px', textTransform: 'none' }}
          >
            {t('chat.save_and_rerun', { defaultValue: 'Save & Rerun' })}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}

// --- 用户消息气泡 ---
const UserMessageBubble: React.FC<{
  message: ChatMessage
  index: number
  isLight: boolean
  onEdit: () => void
  onPreviewImage: (url: string) => void
  onImageContextMenu: (event: React.MouseEvent, imageUrl: string) => void
  onDownloadAttachment: (attachment: ChatAttachment) => void
  onSendModelToDcc: (attachment: ChatAttachment, target: DccBridgeTarget) => void
  notifySuccess: (msg: string) => void
  t: (key: string, options?: any) => string
  theme: any
}> = ({
  message,
  isLight,
  onEdit,
  onPreviewImage,
  onImageContextMenu,
  onDownloadAttachment,
  onSendModelToDcc,
  notifySuccess,
  t,
  theme
}) => {
  const visibleAttachments = sortReportBundleAttachmentsForDisplay(message.attachments)
  const userBubbleBg = isLight ? '#eee7ff' : '#6f5bd6'
  const userBubbleText = isLight ? '#2f235f' : '#ffffff'

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'flex-end',
        mb: 2,
        px: 2,
        '&:hover .user-msg-actions': {
          opacity: 1
        }
      }}
    >
      {/* 操作按钮 */}
      <Box
        className="user-msg-actions"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          mr: 0.5,
          opacity: 0,
          transition: 'opacity 0.15s ease'
        }}
      >
        <CopiableIconButton
          copyLabel={t('chat.copy_prompt')}
          copiedLabel={t('chat.prompt_copied')}
          onCopy={() => {
            if (message.content) {
              navigator.clipboard.writeText(message.content)
              notifySuccess(t('chat.prompt_copied'))
            }
          }}
          buttonSx={{
            color: 'text.disabled',
            width: 28,
            height: 28,
            '&:hover': { color: 'text.secondary' },
            '&.MuiButtonBase-root.MuiIconButton-colorSuccess': {
              color: 'success.main'
            }
          }}
        />
        <Tooltip title={t('chat.edit_message')} placement="top">
          <IconButton
            size="small"
            onClick={onEdit}
            sx={{
              color: 'text.disabled',
              width: 28,
              height: 28,
              '&:hover': { color: 'text.secondary' }
            }}
          >
            <EditIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        {message.content ? (
          <TextDragHandle
            content={message.content}
            title={t('chat.drag_prompt_to_canvas', { defaultValue: 'Drag prompt to canvas' })}
          />
        ) : null}
      </Box>
      <Box
        sx={{
          position: 'relative',
          maxWidth: '85%',
          bgcolor: userBubbleBg,
          borderRadius: '18px',
          px: 3,
          py: 2,
          wordWrap: 'break-word',
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
          userSelect: 'text',
          WebkitUserSelect: 'text',
          cursor: 'text'
        }}
      >
        {visibleAttachments.length > 0 && (
          <Box sx={{ mb: message.content ? 1.5 : 0 }}>
            {visibleAttachments.map((attachment, attIdx) => (
              <Box key={attIdx} sx={{ mb: 1 }}>
                {attachment.type === 'image' ? (
                  <ChatImage
                    src={normalizeLocalMediaUrl(attachment.url)}
                    media={attachment.media}
                    alt={t('chat.attachment_image_alt', {
                      index: attIdx + 1,
                      defaultValue: 'Attachment image {{index}}'
                    })}
                    sourceWidth={attachment.sourceWidth}
                    sourceHeight={attachment.sourceHeight}
                    maxHeight={200}
                    onPreview={() => onPreviewImage(attachment.url)}
                    onContextMenu={(event) => onImageContextMenu(event, attachment.url)}
                  />
                ) : attachment.type === 'video' ? (
                  <video
                    src={normalizeLocalMediaUrl(attachment.url)}
                    controls
                    preload="metadata"
                    style={{
                      maxWidth: '100%',
                      maxHeight: '400px',
                      borderRadius: '12px',
                      display: 'block'
                    }}
                  />
                ) : attachment.type === 'model3d' ? (
                  <ModelAttachmentCard
                    attachment={attachment}
                    onDownloadAttachment={onDownloadAttachment}
                    onSendModelToDcc={onSendModelToDcc}
                    t={t}
                    theme={theme}
                  />
                ) : attachment.type === 'file' ? (
                  <FileAttachmentCard
                    attachment={attachment}
                    ocrResult={attachment.ocrResult ?? message.ocrResult}
                    onDownloadAttachment={onDownloadAttachment}
                    t={t}
                    theme={theme}
                  />
                ) : null}
              </Box>
            ))}
          </Box>
        )}
        {/* 用户文本 */}
        {message.content && (
          <Typography
            variant="body1"
            sx={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'break-word',
              color: userBubbleText,
              lineHeight: 1.6
            }}
          >
            {message.content}
          </Typography>
        )}
      </Box>
    </Box>
  )
}

// --- AI 消息气泡 ---
const AssistantMessageBubble: React.FC<{
  message: ChatMessage
  replyDownloadBaseName: string
  replyDownloadMode: AssistantReplyDownloadMode
  batchSidecarExportEntries?: AssistantSidecarExportEntry[]
  active: boolean
  isLight: boolean
  isLoading: boolean
  loadingStatus?: ChatLoadingStatus
  onPreviewImage: (url: string) => void
  onImageContextMenu: (event: React.MouseEvent, imageUrl: string) => void
  onDownloadAttachment: (attachment: ChatAttachment) => void
  onSendModelToDcc: (attachment: ChatAttachment, target: DccBridgeTarget) => void
  notifySuccess: (msg: string) => void
  t: (key: string, options?: any) => string
  theme: any
}> = ({
  message,
  replyDownloadBaseName,
  replyDownloadMode,
  batchSidecarExportEntries,
  active,
  isLight,
  isLoading,
  loadingStatus,
  onPreviewImage,
  onImageContextMenu,
  onDownloadAttachment,
  onSendModelToDcc,
  notifySuccess,
  t,
  theme
}) => {
  const visibleAttachments = sortReportBundleAttachmentsForDisplay(message.attachments)
  const loadingProgress = formatChatLoadingStatusProgress(loadingStatus)
  const showLoadingStatus = isLoading && Boolean(loadingStatus?.label)

  return (
    <Box sx={{ px: 2 }}>
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          wordBreak: 'break-word',
          overflowWrap: 'break-word'
        }}
      >
        {/* AI 附件 */}
        {visibleAttachments.length > 0 && (
          <Box sx={{ mb: message.content ? 1.5 : 0 }}>
            {visibleAttachments.map((attachment, attIdx) => (
              <Box key={attIdx} sx={{ mb: 1 }}>
                {attachment.type === 'image' ? (
                  <ChatImage
                    src={normalizeLocalMediaUrl(attachment.url)}
                    media={attachment.media}
                    alt={t('chat.attachment_image_alt', {
                      index: attIdx + 1,
                      defaultValue: 'Attachment image {{index}}'
                    })}
                    sourceWidth={attachment.sourceWidth}
                    sourceHeight={attachment.sourceHeight}
                    maxHeight={600}
                    onPreview={() => onPreviewImage(attachment.url)}
                    onContextMenu={(event) => onImageContextMenu(event, attachment.url)}
                  />
                ) : attachment.type === 'video' ? (
                  <AssistantVideoPlayer url={attachment.url} fileName={attachment.fileName} />
                ) : attachment.type === 'model3d' ? (
                  <ModelAttachmentCard
                    attachment={attachment}
                    onDownloadAttachment={onDownloadAttachment}
                    onSendModelToDcc={onSendModelToDcc}
                    t={t}
                    theme={theme}
                  />
                ) : attachment.type === 'file' ? (
                  <FileAttachmentCard
                    attachment={attachment}
                    ocrResult={attachment.ocrResult ?? message.ocrResult}
                    onDownloadAttachment={onDownloadAttachment}
                    t={t}
                    theme={theme}
                  />
                ) : null}
              </Box>
            ))}
          </Box>
        )}
        {/* AI 文本回复（Markdown 渲染） */}
        {message.content ? (
          <>
            <AssistantMarkdownContent
              content={message.content}
              replyDownloadBaseName={replyDownloadBaseName}
              downloadMode={replyDownloadMode}
              batchSidecarExportEntries={batchSidecarExportEntries}
              attachments={visibleAttachments}
              active={active}
              isLight={isLight}
              onPreviewImage={onPreviewImage}
              onImageContextMenu={onImageContextMenu}
              onDownloadAttachment={onDownloadAttachment}
              notifySuccess={notifySuccess}
              t={t}
            />
            {showLoadingStatus ? (
              <AssistantLoadingStatus
                label={loadingStatus?.label || ''}
                progress={loadingProgress}
                detail={loadingStatus?.detail}
                theme={theme}
              />
            ) : null}
          </>
        ) : visibleAttachments.length > 0 ? (
          showLoadingStatus ? (
            <AssistantLoadingStatus
              label={loadingStatus?.label || ''}
              progress={loadingProgress}
              detail={loadingStatus?.detail}
              theme={theme}
            />
          ) : (
            <AssistantMarkdownContent
              content=""
              replyDownloadBaseName={replyDownloadBaseName}
              downloadMode={replyDownloadMode}
              batchSidecarExportEntries={batchSidecarExportEntries}
              attachments={visibleAttachments}
              active={active}
              isLight={isLight}
              onPreviewImage={onPreviewImage}
              onImageContextMenu={onImageContextMenu}
              onDownloadAttachment={onDownloadAttachment}
              notifySuccess={notifySuccess}
              t={t}
            />
          )
        ) : isLoading ? (
          <AssistantLoadingStatus
            label={
              loadingStatus?.label || t('chat.loading_status_default', { defaultValue: '正在处理' })
            }
            progress={loadingProgress}
            detail={loadingStatus?.detail}
            theme={theme}
          />
        ) : message.content !== undefined && message.content !== '' ? null : (
          <Typography variant="body2" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>
            {t('chat.response_interrupted')}
          </Typography>
        )}
      </Box>
    </Box>
  )
}

const AssistantLoadingStatus: React.FC<{
  label: string
  progress?: string | null
  detail?: string
  theme: any
}> = ({ label, progress, detail, theme }) => (
  <Box
    data-testid="assistant-loading-status"
    sx={{
      mt: 0.75,
      display: 'inline-flex',
      alignItems: 'flex-start',
      gap: 1,
      px: 1.25,
      py: 0.9,
      borderRadius: '14px',
      bgcolor: theme.palette.mode === 'light' ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)',
      border: '1px solid',
      borderColor: theme.palette.mode === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)'
    }}
  >
    <CircularProgress size={16} sx={{ mt: '2px', flexShrink: 0 }} />
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600, lineHeight: 1.4 }}>
        {progress ? `${label} ${progress}` : label}
      </Typography>
      {detail ? (
        <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.35 }}>
          {detail}
        </Typography>
      ) : null}
    </Box>
  </Box>
)

// --- AI 视频播放器 ---
const AssistantVideoPlayer: React.FC<{ url: string; fileName?: string }> = ({ url, fileName }) => {
  return (
    <Box
      draggable
      onDragStart={(event) => {
        event.stopPropagation()
        event.dataTransfer.effectAllowed = 'copy'
        setAgentVideoDragPayload(event.dataTransfer, url, fileName)
      }}
      sx={{
        position: 'relative',
        maxWidth: '100%',
        width: 'fit-content',
        borderRadius: '16px',
        overflow: 'hidden',
        bgcolor: '#000',
        cursor: 'pointer',
        '&:hover .video-play-overlay': {
          opacity: 1
        }
      }}
      onClick={(e) => {
        const videoEl = (e.currentTarget as HTMLElement).querySelector('video')
        const overlayEl = (e.currentTarget as HTMLElement).querySelector(
          '.video-play-overlay'
        ) as HTMLElement
        if (videoEl) {
          if (videoEl.paused) {
            videoEl.play()
            if (overlayEl) overlayEl.style.display = 'none'
          } else {
            videoEl.pause()
            if (overlayEl) {
              overlayEl.style.display = 'flex'
              overlayEl.style.opacity = '1'
            }
          }
        }
      }}
    >
      <video
        src={normalizeLocalMediaUrl(url)}
        controls
        preload="metadata"
        style={{
          maxWidth: '100%',
          maxHeight: '480px',
          minWidth: '320px',
          borderRadius: '16px',
          display: 'block'
        }}
        onPlay={(e) => {
          const overlay = (e.currentTarget as HTMLVideoElement).parentElement?.querySelector(
            '.video-play-overlay'
          ) as HTMLElement
          if (overlay) overlay.style.display = 'none'
        }}
        onPause={(e) => {
          const overlay = (e.currentTarget as HTMLVideoElement).parentElement?.querySelector(
            '.video-play-overlay'
          ) as HTMLElement
          if (overlay) {
            overlay.style.display = 'flex'
            overlay.style.opacity = '1'
          }
        }}
      />
      <Box
        className="video-play-overlay"
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          transition: 'opacity 0.2s ease'
        }}
      >
        <Box
          sx={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            bgcolor: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(4px)',
            border: '2px solid rgba(255, 255, 255, 0.3)'
          }}
        >
          <PlayArrowIcon sx={{ fontSize: 36, color: '#fff', ml: '3px' }} />
        </Box>
      </Box>
    </Box>
  )
}

// --- AI Markdown 文本内容 ---
const AssistantMarkdownContent: React.FC<{
  content: string
  replyDownloadBaseName: string
  downloadMode: AssistantReplyDownloadMode
  batchSidecarExportEntries?: AssistantSidecarExportEntry[]
  attachments: ChatAttachment[]
  active: boolean
  isLight: boolean
  onPreviewImage: (url: string) => void
  onImageContextMenu: (event: React.MouseEvent, imageUrl: string) => void
  onDownloadAttachment: (attachment: ChatAttachment) => void
  notifySuccess: (msg: string) => void
  t: (key: string, options?: any) => string
}> = ({
  content,
  replyDownloadBaseName,
  downloadMode,
  batchSidecarExportEntries,
  attachments,
  active,
  isLight,
  onPreviewImage,
  onImageContextMenu,
  onDownloadAttachment,
  notifySuccess,
  t
}) => {
  const videoRegex = /\[Generated Video\]\(([^)]+)\)/g
  const [downloadMenuAnchorEl, setDownloadMenuAnchorEl] = React.useState<HTMLElement | null>(null)
  const videos: string[] = []
  let match
  while ((match = videoRegex.exec(content)) !== null) {
    videos.push(match[1])
  }
  const textContent = extractAssistantReplyTextContent(content)
  const isDownloadMenuOpen = Boolean(downloadMenuAnchorEl)
  React.useEffect(() => {
    if (!active) {
      setDownloadMenuAnchorEl(null)
    }
  }, [active])
  const isSidecarDownload = downloadMode === 'sidecar'
  const hasTextContent = Boolean(textContent)
  const hasImageAttachments = attachments.some((attachment) => attachment.type === 'image')
  const canBatchExportSidecars =
    hasTextContent && isSidecarDownload && (batchSidecarExportEntries?.length ?? 0) > 1
  const textDownloadOptions = !hasTextContent
    ? []
    : isSidecarDownload
      ? [
          {
            extension: '.txt' as const,
            label: t('chat.export_sidecar_text_option', { defaultValue: 'Sidecar (.txt)' })
          },
          {
            extension: '.md' as const,
            label: t('chat.export_sidecar_markdown_option', {
              defaultValue: 'Markdown record (.md)'
            })
          }
        ]
      : [
          {
            extension: '.md' as const,
            label: t('chat.download_reply_markdown_option', { defaultValue: 'Markdown (.md)' })
          },
          {
            extension: '.txt' as const,
            label: t('chat.download_reply_text_option', { defaultValue: 'Text (.txt)' })
          }
        ]
  const attachmentDownloadOptions = attachments.map((attachment, index) => ({
    key: `${attachment.type}:${attachment.url}:${index}`,
    attachment,
    label: buildAttachmentDownloadMenuLabel(attachment, t),
    onClick: () => {
      onDownloadAttachment(attachment)
      notifySuccess(
        t('chat.attachment_downloaded', {
          defaultValue: `${getAttachmentDownloadFileName(attachment)} downloaded`
        })
      )
      setDownloadMenuAnchorEl(null)
    }
  }))
  const actionBarAttachmentOptions = hasTextContent
    ? attachmentDownloadOptions
    : attachmentDownloadOptions.filter(({ attachment }) => attachment.type === 'image')
  const showReplyActions = hasTextContent || hasImageAttachments
  const handleDownloadReply = (extension: '.md' | '.txt') => {
    const fileName = `${replyDownloadBaseName}${extension}`
    downloadTextContentFile(
      textContent,
      fileName,
      extension === '.md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
    )
    notifySuccess(
      isSidecarDownload && extension === '.txt'
        ? t('chat.sidecar_exported', {
            defaultValue: `${fileName} exported as sidecar`
          })
        : t('chat.reply_downloaded', {
            defaultValue: `${fileName} downloaded`
          })
    )
    setDownloadMenuAnchorEl(null)
  }
  const handleDownloadBatchSidecars = (extension: '.md' | '.txt') => {
    for (const entry of batchSidecarExportEntries || []) {
      downloadTextContentFile(
        entry.textContent,
        `${entry.baseName}${extension}`,
        extension === '.md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
      )
    }
    notifySuccess(
      extension === '.txt'
        ? t('chat.sidecar_batch_exported', {
            defaultValue: `${batchSidecarExportEntries?.length || 0} sidecar files exported`
          })
        : t('chat.sidecar_markdown_batch_exported', {
            defaultValue: `${batchSidecarExportEntries?.length || 0} markdown records exported`
          })
    )
    setDownloadMenuAnchorEl(null)
  }
  const downloadButtonLabel =
    hasTextContent && isSidecarDownload
      ? t('chat.export_sidecar', { defaultValue: '导出 sidecar' })
      : hasTextContent
        ? t('chat.download_reply', { defaultValue: '下载回答' })
        : t('chat.download_attachment', { defaultValue: '下载附件' })
  const handleOpenDownloadMenu = (event: React.MouseEvent<HTMLElement>) => {
    if (!active) {
      event.preventDefault()
      return
    }

    setDownloadMenuAnchorEl(event.currentTarget)
  }

  return (
    <Box
      data-testid="assistant-markdown-content"
      sx={{
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
        color: 'text.primary',
        lineHeight: 1.8,
        fontSize: '0.95rem',
        userSelect: 'text',
        WebkitUserSelect: 'text',
        cursor: 'text',
        '& p': { my: 1.2 },
        '& p:first-of-type': { mt: 0 },
        '& p:last-child': { mb: 0 },
        '& ul, & ol': {
          pl: 3,
          my: 1.5,
          '& li': {
            my: 0.6,
            '&::marker': {
              color: 'text.secondary'
            }
          }
        },
        '& li': {
          my: 0.6,
          '& p': { my: 0.3 }
        },
        '& code': {
          bgcolor: isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.1)',
          px: 0.5,
          py: 0.25,
          borderRadius: 0.5,
          fontFamily: 'monospace',
          fontSize: '0.9em'
        },
        '& pre': {
          bgcolor: isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.1)',
          p: 1.5,
          borderRadius: 1,
          overflow: 'auto',
          my: 1.5,
          '& code': {
            bgcolor: 'transparent',
            p: 0
          }
        },
        '& blockquote': {
          borderLeft: 'none',
          pl: 3,
          ml: 2,
          mr: 0,
          my: 1,
          color: 'text.primary',
          '& p': {
            my: 0.5
          }
        },
        '& hr': {
          border: 'none',
          borderTop: '1px solid',
          borderColor: isLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)',
          my: 3
        },
        '& a': {
          color: 'primary.main',
          textDecoration: 'none',
          '&:hover': {
            textDecoration: 'underline'
          }
        },
        '& strong': {
          fontWeight: 600
        },
        '& h1, & h2, & h3, & h4, & h5, & h6': {
          fontWeight: 600,
          mt: 2.5,
          mb: 1.5,
          lineHeight: 1.4
        }
      }}
    >
      {/*
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 0.5 }}>
          <TextDragHandle
            content={content}
            title={t('chat.drag_reply_to_canvas', { defaultValue: '拖拽回复到画板' })}
          />
        </Box>
      */}
      {textContent && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) => {
            if (url.startsWith('local-media://') || url.startsWith('file://')) {
              return url
            }
            if (url.startsWith('http://') || url.startsWith('https://')) {
              return url
            }
            return url
          }}
          components={{
            p: ({ children }) => <div style={{ margin: '0.8em 0' }}>{children}</div>,
            img: ({ src, alt }) =>
              src ? (
                <ChatImage
                  src={src}
                  alt={alt || t('chat.image_alt', { defaultValue: 'Image' })}
                  maxHeight={600}
                  margin="8px 0"
                  onPreview={() => onPreviewImage(src)}
                  onContextMenu={(event) => onImageContextMenu(event, src)}
                />
              ) : null,
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault()
                  if (href) {
                    window.open(href, '_blank')
                  }
                }}
              >
                {children}
              </a>
            ),
            code({ node, inline, className, children, ...props }: any) {
              const codeMatch = /language-(\w+)/.exec(className || '')
              return !inline && codeMatch ? (
                <div style={{ position: 'relative' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      backgroundColor: isLight ? '#f6f8fa' : '#1e1e1e',
                      padding: '4px 12px',
                      borderTopLeftRadius: '8px',
                      borderTopRightRadius: '8px',
                      borderBottom: isLight ? '1px solid #e1e4e8' : '1px solid #333',
                      fontSize: '12px',
                      color: isLight ? '#24292e' : '#e1e4e8',
                      fontFamily: 'monospace'
                    }}
                  >
                    <span>{codeMatch[1]}</span>
                    <CopiableIconButton
                      copyLabel={t('chat.copy_code', { defaultValue: 'Copy code' })}
                      copiedLabel={t('chat.code_copied')}
                      iconSize="14px"
                      onCopy={() => {
                        navigator.clipboard.writeText(String(children).replace(/\n$/, ''))
                        notifySuccess(t('chat.code_copied'))
                      }}
                      buttonSx={{
                        color: 'inherit',
                        padding: '2px',
                        '&.MuiButtonBase-root.MuiIconButton-colorSuccess': {
                          color: 'success.main'
                        }
                      }}
                    />
                  </div>
                  <Prism
                    style={isLight ? prism : vscDarkPlus}
                    language={codeMatch[1]}
                    PreTag="div"
                    customStyle={{
                      margin: 0,
                      borderTopLeftRadius: 0,
                      borderTopRightRadius: 0,
                      borderBottomLeftRadius: '8px',
                      borderBottomRightRadius: '8px',
                      backgroundColor: isLight ? '#ffffff' : '#1e1e1e',
                      fontSize: '14px',
                      lineHeight: 1.5,
                      padding: '16px'
                    }}
                    {...props}
                  >
                    {String(children).replace(/\n$/, '')}
                  </Prism>
                </div>
              ) : (
                <code className={className} {...props}>
                  {children}
                </code>
              )
            }
          }}
        >
          {textContent}
        </ReactMarkdown>
      )}
      {videos.map((url) => (
        <div
          key={url}
          draggable
          onDragStart={(event) => {
            event.stopPropagation()
            event.dataTransfer.effectAllowed = 'copy'
            setAgentVideoDragPayload(event.dataTransfer, url)
          }}
          style={{
            position: 'relative',
            display: 'inline-block',
            margin: '8px 0'
          }}
          className="video-container"
        >
          <video
            src={normalizeLocalMediaUrl(url)}
            controls
            preload="metadata"
            style={{
              maxWidth: '100%',
              maxHeight: '480px',
              minWidth: '320px',
              borderRadius: '16px',
              display: 'block',
              backgroundColor: '#000'
            }}
          />
          <IconButton
            size="small"
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              bgcolor: 'rgba(0, 0, 0, 0.6)',
              color: '#fff',
              '&:hover': {
                bgcolor: 'rgba(0, 0, 0, 0.8)'
              }
            }}
            onClick={() => {
              onDownloadAttachment({
                type: 'video',
                url,
                fileName: getDownloadFileNameFromUrl(url, 'video.mp4')
              })
            }}
            title="Download or reveal the file"
          >
            <DownloadIcon fontSize="small" />
          </IconButton>
        </div>
      ))}
      {showReplyActions ? (
        <Box
          data-testid="assistant-reply-actions"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            mt: 1
          }}
        >
          {hasTextContent ? (
            <CopiableIconButton
              copyLabel={t('chat.copy_reply', { defaultValue: 'Copy reply' })}
              copiedLabel={t('chat.reply_copied', { defaultValue: 'Reply copied' })}
              onCopy={() => {
                navigator.clipboard.writeText(textContent)
                notifySuccess(t('chat.reply_copied', { defaultValue: 'Reply copied' }))
              }}
              buttonSx={{
                color: 'text.disabled',
                width: 28,
                height: 28,
                '&:hover': { color: 'text.secondary' },
                '&.MuiButtonBase-root.MuiIconButton-colorSuccess': {
                  color: 'success.main'
                }
              }}
            />
          ) : null}
          <Tooltip title={downloadButtonLabel} placement="top">
            <IconButton
              size="small"
              aria-label={downloadButtonLabel}
              onClick={handleOpenDownloadMenu}
              sx={{
                color: 'text.disabled',
                width: 28,
                height: 28,
                '&:hover': { color: 'text.secondary' }
              }}
            >
              <DownloadIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={downloadMenuAnchorEl}
            open={active && isDownloadMenuOpen}
            onClose={() => setDownloadMenuAnchorEl(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          >
            {actionBarAttachmentOptions.map((option) => (
              <MenuItem key={option.key} onClick={option.onClick} aria-label={option.label}>
                {option.label}
              </MenuItem>
            ))}
            {actionBarAttachmentOptions.length > 0 && textDownloadOptions.length > 0 ? (
              <Divider />
            ) : null}
            {textDownloadOptions.map((option) => (
              <MenuItem
                key={option.extension}
                onClick={() => handleDownloadReply(option.extension)}
                aria-label={option.label}
              >
                {option.label}
              </MenuItem>
            ))}
            {canBatchExportSidecars
              ? [
                  <Divider key="batch-divider" />,
                  <MenuItem
                    key="batch-txt"
                    onClick={() => handleDownloadBatchSidecars('.txt')}
                    aria-label={t('chat.export_all_sidecar_text_option', {
                      defaultValue: 'All sidecars (.txt)'
                    })}
                  >
                    {t('chat.export_all_sidecar_text_option', {
                      defaultValue: 'All sidecars (.txt)'
                    })}
                  </MenuItem>,
                  <MenuItem
                    key="batch-md"
                    onClick={() => handleDownloadBatchSidecars('.md')}
                    aria-label={t('chat.export_all_sidecar_markdown_option', {
                      defaultValue: 'All markdown records (.md)'
                    })}
                  >
                    {t('chat.export_all_sidecar_markdown_option', {
                      defaultValue: 'All markdown records (.md)'
                    })}
                  </MenuItem>
                ]
              : null}
          </Menu>
          {hasTextContent ? (
            <TextDragHandle
              content={textContent}
              title={t('chat.drag_reply_to_canvas', {
                defaultValue: '\u62d6\u62fd\u56de\u7b54\u5230\u753b\u677f'
              })}
            />
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}

const MemoizedChatMessageList = React.memo(ChatMessageList)

MemoizedChatMessageList.displayName = 'ChatMessageList'

export default MemoizedChatMessageList
