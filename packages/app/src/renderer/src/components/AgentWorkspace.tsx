import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  ButtonBase,
  Collapse,
  CircularProgress,
  Dialog,
  DialogContent,
  IconButton,
  Tooltip,
  Typography
} from '@mui/material'
import {
  Add as AddIcon,
  Close as CloseIcon,
  ExpandLess as ExpandLessIcon,
  ExpandMore as ExpandMoreIcon,
  StopCircleOutlined as StopIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import ChatPage from '@renderer/pages/ChatPage/ChatPage'
import { loadAllSessions, type ChatSession } from '@renderer/pages/ChatPage/chatStorage'
import { getLocalizedConversationTitle } from '@renderer/pages/ChatPage/chatLocaleUtils'
import { readScopedLoadingSessionIds } from '@renderer/pages/ChatPage/chatPageShared'
import {
  buildAgentPaneScope,
  buildCanvasAgentRoute
} from '@renderer/pages/ProjectCanvasPage/canvasPageLocalStateUtils'
import ProjectTraceManagerPanel from '@renderer/features/projectTrace/ProjectTraceManagerPanel'
import { useMessage } from '@renderer/hooks/useMessage'
import { finalizeActiveProjectTraceCapture } from '@renderer/features/projectTrace/projectTraceCapture'
import {
  PROJECT_TRACE_CAPTURE_STATE_EVENT,
  clearActiveProjectTraceRealtime,
  readActiveProjectTraceCapture,
  readActiveProjectTraceRealtime,
  type ProjectTraceCaptureStateEvent
} from '@renderer/features/projectTrace/projectTraceRuntime'
import type { ChatAttachment, ChatMessage } from '@shared/api/svcLLMProxy'

type AgentPane = {
  id: string
  enabled: boolean
}

type PanePreviewStatus = 'idle' | 'running' | 'done'

type PanePreview = {
  title: string
  subtitle: string
  thumbnailUrl?: string
  status: PanePreviewStatus
}

type AgentWorkspaceStrings = {
  newConversation: string
  imageReply: string
  latestReply: string
  latestPrompt: string
  conversationCreated: string
  emptyConversation: string
  paneLabel: (index: number) => string
}

const PREVIEW_POLL_INTERVAL_MS = 4000
const PREVIEW_REFRESH_EVENTS = [
  'chat:newSession',
  'chat:switchSession',
  'chat:deleteSession',
  'send-to-agent',
  'chat:preview-refresh'
] as const

const DEFAULT_PANES: AgentPane[] = [{ id: 'agent-1', enabled: true }]

const buildWorkspaceStorageKey = (projectId: string): string => `agent.workspace.${projectId}`
const buildActivePaneStorageKey = (projectId: string): string =>
  `agent.workspace.active.${projectId}`
const buildThreadsCollapsedStorageKey = (projectId: string): string =>
  `agent.workspace.threadsCollapsed.${projectId}`

const readLocalStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeLocalStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore storage failures */
  }
}

const removeLocalStorage = (key: string): void => {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore storage failures */
  }
}

const normalizePanes = (value: unknown): AgentPane[] => {
  if (!Array.isArray(value)) return DEFAULT_PANES

  const normalized = value
    .filter((item): item is Partial<AgentPane> => !!item && typeof item === 'object')
    .map((pane, index) => ({
      id:
        typeof pane.id === 'string' && pane.id
          ? pane.id
          : (DEFAULT_PANES[index]?.id ?? `agent-${index + 1}`),
      enabled: pane.enabled !== false
    }))

  return normalized.length > 0 ? normalized : DEFAULT_PANES
}

const readStoredPanes = (storageKey: string): AgentPane[] => {
  const saved = readLocalStorage(storageKey)
  if (!saved) return DEFAULT_PANES

  try {
    return normalizePanes(JSON.parse(saved))
  } catch {
    return DEFAULT_PANES
  }
}

const readStoredActivePaneId = (storageKey: string, panes: AgentPane[]): string | null =>
  readLocalStorage(storageKey) || panes[0]?.id || null

const getOpenPanes = (panes: AgentPane[]): AgentPane[] =>
  panes.filter((pane) => pane.enabled !== false)

const getNextPaneId = (panes: AgentPane[]): string => {
  const usedIds = new Set(panes.map((pane) => pane.id))
  let nextIndex = 1
  while (usedIds.has(`agent-${nextIndex}`)) {
    nextIndex += 1
  }
  return `agent-${nextIndex}`
}

const getPaneNumber = (paneId: string, index: number): number => {
  const match = paneId.match(/agent-(\d+)/)
  return match ? Number(match[1]) : index + 1
}

const getPaneLabel = (
  paneId: string,
  index: number,
  getLabel: AgentWorkspaceStrings['paneLabel']
): string => getLabel(getPaneNumber(paneId, index))

const createAgentWorkspaceStrings = (
  t: ReturnType<typeof useTranslation>['t']
): AgentWorkspaceStrings => ({
  newConversation: t('chat.new_conversation'),
  imageReply: t('agent_workspace.image_reply'),
  latestReply: t('agent_workspace.latest_reply'),
  latestPrompt: t('agent_workspace.latest_prompt'),
  conversationCreated: t('agent_workspace.conversation_created'),
  emptyConversation: t('agent_workspace.empty_conversation'),
  paneLabel: (index: number) => t('agent_workspace.chat_label', { index })
})

const compactText = (value: string, fallback: string): string => {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized || fallback
}

const getLatestRenderableMessage = (messages: ChatMessage[]): ChatMessage | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'system') continue
    if (message.content?.trim() || message.attachments?.length) return message
  }

  return null
}

const getImageAttachment = (attachments?: ChatAttachment[]): ChatAttachment | undefined =>
  attachments?.find((attachment) => attachment.type === 'image' && attachment.url)

const arePanePreviewsEqual = (
  left: Record<string, PanePreview>,
  right: Record<string, PanePreview>
): boolean => {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)

  if (leftKeys.length !== rightKeys.length) return false

  return leftKeys.every((key) => {
    const leftPreview = left[key]
    const rightPreview = right[key]

    return (
      rightPreview !== undefined &&
      leftPreview.title === rightPreview.title &&
      leftPreview.subtitle === rightPreview.subtitle &&
      leftPreview.thumbnailUrl === rightPreview.thumbnailUrl &&
      leftPreview.status === rightPreview.status
    )
  })
}

const isPaneRunning = (scope: string): boolean => {
  return readScopedLoadingSessionIds(scope).length > 0
}

const buildPanePreview = (
  paneId: string,
  index: number,
  sessions: ChatSession[],
  running: boolean,
  strings: AgentWorkspaceStrings
): PanePreview => {
  const latestSession = sessions[sessions.length - 1]
  const latestMessage = latestSession ? getLatestRenderableMessage(latestSession.messages) : null
  const imageAttachment = getImageAttachment(latestMessage?.attachments)
  const paneLabel = getPaneLabel(paneId, index, strings.paneLabel)
  const status: PanePreviewStatus = running
    ? 'running'
    : latestMessage || latestSession
      ? 'done'
      : 'idle'

  if (imageAttachment) {
    return {
      title: compactText(latestMessage?.content || '', paneLabel),
      subtitle: strings.imageReply,
      thumbnailUrl: imageAttachment.url,
      status
    }
  }

  if (latestMessage?.content) {
    const assistantModelName =
      latestMessage.role === 'assistant' ? latestMessage.modelName?.trim() : ''
    return {
      title: compactText(latestMessage.content, paneLabel),
      subtitle:
        latestMessage.role === 'assistant'
          ? assistantModelName || strings.latestReply
          : strings.latestPrompt,
      status
    }
  }

  return {
    title: compactText(
      getLocalizedConversationTitle(latestSession?.title, strings.newConversation),
      paneLabel
    ),
    subtitle: latestSession ? strings.conversationCreated : strings.emptyConversation,
    status
  }
}

const loadPreviewMap = async (
  panes: AgentPane[],
  projectId: string,
  strings: AgentWorkspaceStrings
): Promise<Record<string, PanePreview>> => {
  const entries = await Promise.all(
    panes.map(async (pane, index) => {
      return loadPanePreview(pane, index, projectId, strings)
    })
  )

  return Object.fromEntries(entries) as Record<string, PanePreview>
}

const loadPanePreview = async (
  pane: AgentPane,
  index: number,
  projectId: string,
  strings: AgentWorkspaceStrings
): Promise<readonly [string, PanePreview]> => {
  const scope = buildAgentPaneScope(projectId, pane.id)
  const sessions = await loadAllSessions(scope)
  return [
    pane.id,
    buildPanePreview(pane.id, index, sessions, isPaneRunning(scope), strings)
  ] as const
}

const PaneStatusIndicator: React.FC<{ status?: PanePreviewStatus }> = ({ status = 'idle' }) => {
  if (status === 'running') {
    return (
      <CircularProgress size={12} thickness={6} sx={{ color: 'primary.main', flexShrink: 0 }} />
    )
  }

  if (status === 'done') {
    return (
      <Box
        sx={(theme) => ({
          width: 9,
          height: 9,
          borderRadius: '50%',
          flexShrink: 0,
          backgroundColor: theme.palette.primary.main,
          boxShadow: `0 0 0 2px ${
            theme.palette.mode === 'dark' ? 'rgba(96,165,250,0.18)' : 'rgba(59,130,246,0.12)'
          }`
        })}
      />
    )
  }

  return (
    <Box
      sx={(theme) => ({
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        backgroundColor:
          theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.22)'
      })}
    />
  )
}

type PaneListItemProps = {
  index: number
  pane: AgentPane
  paneScope: string
  preview?: PanePreview
  defaultTitle: string
  defaultSubtitle: string
  selected: boolean
  dragging: boolean
  dragOver: boolean
  onRemove: (paneId: string) => void
  onSelect: (paneId: string) => void
  onDragStart: (paneId: string) => void
  onDragEnd: () => void
  onDragOver: (paneId: string) => void
  onDrop: (paneId: string) => void
}

const PaneListItem: React.FC<PaneListItemProps> = ({
  index,
  pane,
  paneScope,
  preview,
  defaultTitle,
  defaultSubtitle,
  selected,
  dragging,
  dragOver,
  onRemove,
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop
}) => (
  <ButtonBase
    data-agent-workspace-scope={paneScope}
    draggable
    onClick={() => onSelect(pane.id)}
    onDragStart={(event) => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', pane.id)
      onDragStart(pane.id)
    }}
    onDragEnd={onDragEnd}
    onDragOver={(event) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      onDragOver(pane.id)
    }}
    onDrop={(event) => {
      event.preventDefault()
      onDrop(pane.id)
    }}
    sx={(theme) => ({
      width: '100%',
      minHeight: 40,
      px: 1.2,
      py: 0.65,
      borderRadius: 1.5,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 1,
      textAlign: 'left',
      color: selected ? theme.palette.text.primary : theme.palette.text.secondary,
      backgroundColor: selected
        ? theme.palette.mode === 'dark'
          ? 'rgba(255,255,255,0.08)'
          : 'rgba(0,0,0,0.06)'
        : 'transparent',
      opacity: dragging ? 0.55 : 1,
      transform: dragging ? 'scale(0.985)' : 'none',
      border: dragOver ? `1px solid ${theme.palette.primary.main}` : '1px solid transparent',
      '&:hover': {
        backgroundColor:
          theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'
      }
    })}
  >
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flex: 1 }}>
      <PaneStatusIndicator status={preview?.status} />

      {preview?.thumbnailUrl ? (
        <Box
          component="img"
          src={preview.thumbnailUrl}
          alt={preview.title}
          sx={{
            width: 28,
            height: 28,
            borderRadius: 1,
            objectFit: 'cover',
            flexShrink: 0,
            border: '1px solid rgba(255,255,255,0.08)'
          }}
        />
      ) : null}

      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          variant="body2"
          sx={{
            fontSize: 13,
            fontWeight: selected ? 700 : 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {preview?.title || defaultTitle}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            mt: 0.15,
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {preview?.subtitle || defaultSubtitle}
        </Typography>
      </Box>
    </Box>

    <Box
      component="span"
      onClick={(event) => {
        event.stopPropagation()
        onRemove(pane.id)
      }}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: '50%',
        color: 'text.secondary',
        opacity: 0.8,
        '&:hover': {
          opacity: 1,
          backgroundColor: 'rgba(255,255,255,0.1)'
        }
      }}
    >
      <CloseIcon sx={{ fontSize: 18 }} />
    </Box>
  </ButtonBase>
)

interface AgentWorkspaceProps {
  projectId: string
  projectName?: string
}

const AgentWorkspace: React.FC<AgentWorkspaceProps> = ({ projectId, projectName }) => {
  const { t } = useTranslation()
  const { notifyError, notifyInfo } = useMessage()
  const storageKey = buildWorkspaceStorageKey(projectId)
  const activeStorageKey = buildActivePaneStorageKey(projectId)
  const collapsedStorageKey = buildThreadsCollapsedStorageKey(projectId)

  const [panes, setPanes] = useState<AgentPane[]>(() => readStoredPanes(storageKey))
  const [activePaneId, setActivePaneId] = useState<string | null>(() =>
    readStoredActivePaneId(activeStorageKey, getOpenPanes(readStoredPanes(storageKey)))
  )
  const [threadsCollapsed, setThreadsCollapsed] = useState<boolean>(
    () => readLocalStorage(collapsedStorageKey) === '1'
  )
  const [panePreviews, setPanePreviews] = useState<Record<string, PanePreview>>({})
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null)
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null)
  const [tracePanelOpen, setTracePanelOpen] = useState(false)
  const [activeTraceState, setActiveTraceState] = useState<{
    id: string
    mode: 'capture' | 'realtime' | null
  }>(() => {
    const activeCapture = readActiveProjectTraceCapture(projectId)
    if (activeCapture?.traceId) return { id: activeCapture.traceId, mode: 'capture' }
    const activeRealtime = readActiveProjectTraceRealtime(projectId)
    if (activeRealtime?.referenceTraceIds.length) {
      return { id: activeRealtime.referenceTraceIds[0], mode: 'realtime' }
    }
    return { id: '', mode: null }
  })
  const pendingExternalPaneRequestsRef = useRef<Array<{ requestId?: string; paneId: string }>>([])
  const previewRefreshSequenceRef = useRef(0)
  const openPanes = useMemo(() => getOpenPanes(panes), [panes])
  const workspaceStrings = useMemo(() => createAgentWorkspaceStrings(t), [t])

  useEffect(() => {
    const nextPanes = readStoredPanes(storageKey)
    setPanes(nextPanes)

    const nextActivePaneId = readStoredActivePaneId(activeStorageKey, getOpenPanes(nextPanes))
    setActivePaneId(
      nextActivePaneId && getOpenPanes(nextPanes).some((pane) => pane.id === nextActivePaneId)
        ? nextActivePaneId
        : getOpenPanes(nextPanes)[0]?.id || null
    )
  }, [activeStorageKey, storageKey])

  useEffect(() => {
    setThreadsCollapsed(readLocalStorage(collapsedStorageKey) === '1')
  }, [collapsedStorageKey])

  useEffect(() => {
    setTracePanelOpen(false)
    const activeCapture = readActiveProjectTraceCapture(projectId)
    if (activeCapture?.traceId) {
      setActiveTraceState({ id: activeCapture.traceId, mode: 'capture' })
      return
    }
    const activeRealtime = readActiveProjectTraceRealtime(projectId)
    setActiveTraceState(
      activeRealtime?.referenceTraceIds.length
        ? { id: activeRealtime.referenceTraceIds[0], mode: 'realtime' }
        : { id: '', mode: null }
    )
  }, [projectId])

  useEffect(() => {
    const handleCaptureState = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        const activeCapture = readActiveProjectTraceCapture(projectId)
        const activeRealtime = readActiveProjectTraceRealtime(projectId)
        setActiveTraceState(
          activeCapture?.traceId
            ? { id: activeCapture.traceId, mode: 'capture' }
            : activeRealtime?.referenceTraceIds.length
              ? { id: activeRealtime.referenceTraceIds[0], mode: 'realtime' }
              : { id: '', mode: null }
        )
        return
      }
      const detail = (event as CustomEvent<ProjectTraceCaptureStateEvent>).detail
      if (detail?.projectId !== projectId) return
      if (detail.active && detail.traceId) {
        setActiveTraceState({ id: detail.traceId, mode: detail.mode || 'capture' })
        return
      }
      setActiveTraceState({ id: '', mode: null })
    }
    window.addEventListener(PROJECT_TRACE_CAPTURE_STATE_EVENT, handleCaptureState)
    window.addEventListener('storage', handleCaptureState)
    return () => {
      window.removeEventListener(PROJECT_TRACE_CAPTURE_STATE_EVENT, handleCaptureState)
      window.removeEventListener('storage', handleCaptureState)
    }
  }, [projectId])

  useEffect(() => {
    writeLocalStorage(storageKey, JSON.stringify(panes))
  }, [panes, storageKey])

  useEffect(() => {
    if (activePaneId && !openPanes.some((pane) => pane.id === activePaneId)) {
      setActivePaneId(openPanes[0]?.id || null)
    }
  }, [activePaneId, openPanes])

  useEffect(() => {
    if (activePaneId) {
      writeLocalStorage(activeStorageKey, activePaneId)
      return
    }

    removeLocalStorage(activeStorageKey)
  }, [activePaneId, activeStorageKey])

  useEffect(() => {
    writeLocalStorage(collapsedStorageKey, threadsCollapsed ? '1' : '0')
  }, [collapsedStorageKey, threadsCollapsed])

  useEffect(() => {
    const pendingRequests = pendingExternalPaneRequestsRef.current
    if (pendingRequests.length === 0) return

    const openPaneIds = new Set(openPanes.map((pane) => pane.id))
    pendingExternalPaneRequestsRef.current = pendingRequests.filter((request) => {
      if (!openPaneIds.has(request.paneId) || activePaneId !== request.paneId) {
        return true
      }

      window.dispatchEvent(
        new CustomEvent('agent-workspace:pane-created', {
          detail: {
            projectId,
            paneId: request.paneId,
            scope: buildAgentPaneScope(projectId, request.paneId),
            requestId: request.requestId
          }
        })
      )
      return false
    })
  }, [activePaneId, openPanes, projectId])

  useEffect(() => {
    let cancelled = false
    const paneEntriesByScope = new Map(
      openPanes.map((pane, index) => [buildAgentPaneScope(projectId, pane.id), { pane, index }])
    )

    const refreshPreviews = async (targetScope?: string) => {
      const sequence = ++previewRefreshSequenceRef.current
      try {
        if (targetScope) {
          const targetPane = paneEntriesByScope.get(targetScope)
          if (!targetPane) return

          const [paneId, preview] = await loadPanePreview(
            targetPane.pane,
            targetPane.index,
            projectId,
            workspaceStrings
          )
          if (cancelled || sequence !== previewRefreshSequenceRef.current) return

          setPanePreviews((prev) => {
            const nextPreviews = { ...prev, [paneId]: preview }
            return arePanePreviewsEqual(prev, nextPreviews) ? prev : nextPreviews
          })
          return
        }

        const nextPreviews = await loadPreviewMap(openPanes, projectId, workspaceStrings)
        if (cancelled || sequence !== previewRefreshSequenceRef.current) return

        setPanePreviews((prev) => (arePanePreviewsEqual(prev, nextPreviews) ? prev : nextPreviews))
      } catch (error) {
        console.error('[AgentWorkspace] Failed to refresh pane previews', error)
      }
    }

    const triggerRefresh = (event?: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null
      const targetScope =
        typeof detail?.scope === 'string'
          ? detail.scope
          : typeof detail?.targetScope === 'string'
            ? detail.targetScope
            : undefined

      if (targetScope && !paneEntriesByScope.has(targetScope)) {
        return
      }

      void refreshPreviews(targetScope)
    }

    triggerRefresh()

    const timer = window.setInterval(triggerRefresh, PREVIEW_POLL_INTERVAL_MS)
    window.addEventListener('storage', triggerRefresh)
    for (const eventName of PREVIEW_REFRESH_EVENTS) {
      window.addEventListener(eventName, triggerRefresh as EventListener)
    }

    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('storage', triggerRefresh)
      for (const eventName of PREVIEW_REFRESH_EVENTS) {
        window.removeEventListener(eventName, triggerRefresh as EventListener)
      }
    }
  }, [openPanes, projectId, workspaceStrings])

  const activePane = openPanes.find((pane) => pane.id === activePaneId) ?? openPanes[0] ?? null

  const handleRemovePane = (paneId: string) => {
    const remainingOpenPanes = openPanes.filter((pane) => pane.id !== paneId)
    const scope = buildAgentPaneScope(projectId, paneId)

    window.dispatchEvent(
      new CustomEvent('chat:terminate-scope', {
        detail: {
          scope
        }
      })
    )

    setPanes((prev) =>
      prev.map((pane) => (pane.id === paneId ? { ...pane, enabled: false } : pane))
    )

    if (activePaneId === paneId) {
      setActivePaneId(remainingOpenPanes[0]?.id || null)
    }
  }

  const handleAddPane = () => {
    setPanes((prev) => {
      const nextPaneId = getNextPaneId(prev)
      setActivePaneId(nextPaneId)
      return [...prev, { id: nextPaneId, enabled: true }]
    })
  }

  useEffect(() => {
    const handleCreatePane = (event: Event) => {
      const customEvent = event as CustomEvent<{ projectId?: string; requestId?: string }>
      if (customEvent.detail?.projectId !== projectId) {
        return
      }

      const nextPaneId = getNextPaneId(panes)
      pendingExternalPaneRequestsRef.current.push({
        requestId: customEvent.detail?.requestId,
        paneId: nextPaneId
      })
      setPanes((prev) => [...prev, { id: nextPaneId, enabled: true }])
      setActivePaneId(nextPaneId)
    }

    window.addEventListener('agent-workspace:create-pane', handleCreatePane as EventListener)
    return () => {
      window.removeEventListener('agent-workspace:create-pane', handleCreatePane as EventListener)
    }
  }, [panes, projectId])

  const handleReorderPane = (targetPaneId: string) => {
    if (!draggingPaneId || draggingPaneId === targetPaneId) {
      setDragOverPaneId(null)
      return
    }

    setPanes((prev) => {
      const sourceIndex = prev.findIndex((pane) => pane.id === draggingPaneId)
      const targetIndex = prev.findIndex((pane) => pane.id === targetPaneId)
      if (sourceIndex === -1 || targetIndex === -1) {
        return prev
      }

      const next = [...prev]
      const [movedPane] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, movedPane)
      return next
    })

    setDragOverPaneId(null)
  }

  const handleStopTraceCapture = async () => {
    try {
      if (activeTraceState.mode === 'realtime') {
        clearActiveProjectTraceRealtime(projectId)
        setActiveTraceState({ id: '', mode: null })
        notifyInfo('实时追踪已停止。', 6000)
        return
      }
      const finalized = await finalizeActiveProjectTraceCapture(projectId)
      setActiveTraceState({ id: '', mode: null })
      setTracePanelOpen(Boolean(finalized))
      notifyInfo(
        finalized
          ? `追踪草稿已生成：${finalized.trace.manifest.name}，请保存或删除后再创建新的追踪。`
          : '当前没有正在进行的追踪。',
        6000
      )
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '停止追踪失败。')
    }
  }

  return (
    <Box
      data-agent-workspace-root={projectId}
      sx={(theme) => ({
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: theme.palette.mode === 'dark' ? '#1b1b1d' : '#f2f3f5',
        position: 'relative',
        overflow: 'visible',
        zIndex: 1
      })}
    >
      <Box
        sx={(theme) => ({
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 0.75,
          minHeight: 49.9,
          borderBottom: `1px solid ${theme.palette.divider}`,
          backgroundColor: theme.palette.mode === 'dark' ? '#1a1a1a' : '#eaecf5',
          flexShrink: 0,
          position: 'relative',
          zIndex: 3,
          overflow: 'visible',
          WebkitAppRegion: 'no-drag'
        })}
      >
        <Typography
          variant="caption"
          sx={{ fontSize: 12, fontWeight: 700, color: 'text.secondary', flex: 1 }}
        >
          {t('agent_workspace.title')}
        </Typography>

        <Box id="agent-workspace-skill-portal" sx={{ display: 'flex', alignItems: 'center' }} />

        <Button
          size="small"
          color={activeTraceState.id ? 'error' : 'primary'}
          variant={activeTraceState.id || tracePanelOpen ? 'contained' : 'text'}
          startIcon={activeTraceState.id ? <StopIcon sx={{ fontSize: 15 }} /> : undefined}
          data-testid="agent-workspace-trace-button"
          onClick={() => {
            if (activeTraceState.id) {
              void handleStopTraceCapture()
              return
            }
            setTracePanelOpen((prev) => !prev)
          }}
          sx={{
            fontWeight: 700,
            fontSize: 12,
            borderRadius: 2,
            px: 1.2,
            py: 0.5,
            minWidth: 'auto',
            color: activeTraceState.id || tracePanelOpen ? 'common.white' : 'text.secondary',
            '& .MuiButton-startIcon': { mr: 0.5 },
            '&:hover': {
              bgcolor: activeTraceState.id
                ? 'error.dark'
                : tracePanelOpen
                  ? 'primary.dark'
                  : 'action.hover'
            }
          }}
        >
          {activeTraceState.id ? '停止追踪' : t('menu.trace', { defaultValue: '追踪' })}
        </Button>

        <Button
          size="small"
          variant="text"
          onClick={() => {
            setTracePanelOpen(false)
            window.dispatchEvent(
              new CustomEvent('canvas:run-target-request', {
                detail: { canvasId: projectId }
              })
            )
          }}
          sx={{
            fontWeight: 700,
            fontSize: 12,
            borderRadius: 2,
            px: 1.5,
            py: 0.5,
            minWidth: 'auto',
            color: 'text.secondary',
            '&:hover': { bgcolor: 'action.hover', color: 'text.primary' }
          }}
        >
          {t('agent_workspace.check', { defaultValue: '目标' })}
        </Button>

        <Tooltip
          title={
            threadsCollapsed
              ? t('agent_workspace.expand_threads')
              : t('agent_workspace.collapse_threads')
          }
          arrow
        >
          <IconButton
            size="small"
            onClick={() => setThreadsCollapsed((prev) => !prev)}
            sx={{ color: 'text.secondary' }}
          >
            {threadsCollapsed ? (
              <ExpandMoreIcon sx={{ fontSize: 18 }} />
            ) : (
              <ExpandLessIcon sx={{ fontSize: 18 }} />
            )}
          </IconButton>
        </Tooltip>

        <Tooltip title={t('agent_workspace.new_chat')} arrow>
          <IconButton size="small" onClick={handleAddPane} sx={{ color: 'text.secondary' }}>
            <AddIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <Collapse in={!threadsCollapsed && openPanes.length > 0} timeout={180} unmountOnExit>
        <Box
          sx={(theme) => ({
            px: 1,
            py: 0.75,
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
            backgroundColor: theme.palette.mode === 'dark' ? '#1a1a1a' : '#eaecf5',
            flexShrink: 0
          })}
        >
          {openPanes.map((pane, index) => (
            <PaneListItem
              key={pane.id}
              index={index}
              pane={pane}
              paneScope={buildAgentPaneScope(projectId, pane.id)}
              preview={panePreviews[pane.id]}
              defaultTitle={getPaneLabel(pane.id, index, workspaceStrings.paneLabel)}
              defaultSubtitle={workspaceStrings.emptyConversation}
              selected={pane.id === activePaneId}
              dragging={pane.id === draggingPaneId}
              dragOver={pane.id === dragOverPaneId && pane.id !== draggingPaneId}
              onRemove={handleRemovePane}
              onSelect={setActivePaneId}
              onDragStart={(paneId) => {
                setDraggingPaneId(paneId)
                setDragOverPaneId(null)
              }}
              onDragEnd={() => {
                setDraggingPaneId(null)
                setDragOverPaneId(null)
              }}
              onDragOver={setDragOverPaneId}
              onDrop={(paneId) => {
                handleReorderPane(paneId)
                setDraggingPaneId(null)
              }}
            />
          ))}
        </Box>
      </Collapse>

      <Box
        sx={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}
        data-agent-workspace-scope={
          activePane ? buildAgentPaneScope(projectId, activePane.id) : undefined
        }
      >
        {openPanes.map((pane) => {
          const scope = buildAgentPaneScope(projectId, pane.id)
          const isActivePane = activePane?.id === pane.id

          return (
            <Box
              key={scope}
              aria-hidden={!isActivePane}
              data-agent-workspace-pane={pane.id}
              data-agent-workspace-scope={scope}
              sx={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                display: isActivePane ? 'block' : 'none',
                pointerEvents: isActivePane ? 'auto' : 'none'
              }}
            >
              <ChatPage
                compact
                storageScope={scope}
                route={buildCanvasAgentRoute(projectId, pane.id)}
                acceptExternalInput={isActivePane}
                active={isActivePane}
              />
            </Box>
          )
        })}
        {!activePane && (
          <Box
            sx={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              px: 3,
              textAlign: 'center'
            }}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600, mb: 0.75 }}>
                {t('agent_workspace.no_active_conversation')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('agent_workspace.start_new_chat_with_plus')}
              </Typography>
            </Box>
          </Box>
        )}
      </Box>

      <Dialog
        open={tracePanelOpen}
        onClose={() => setTracePanelOpen(false)}
        maxWidth="lg"
        fullWidth
        slotProps={{
          paper: {
            sx: {
              height: '82vh',
              maxHeight: 760,
              minHeight: 520,
              overflow: 'hidden'
            }
          }
        }}
      >
        <DialogContent sx={{ p: 0, height: '100%', overflow: 'hidden' }}>
          <ProjectTraceManagerPanel
            compact
            projectId={projectId}
            projectName={projectName}
            onClose={() => setTracePanelOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </Box>
  )
}

export default AgentWorkspace
