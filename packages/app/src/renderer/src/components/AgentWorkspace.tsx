import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Box,
  Button,
  ButtonBase,
  Dialog,
  DialogContent,
  IconButton,
  Tooltip,
  Typography
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import {
  Add as AddIcon,
  Close as CloseIcon,
  ExpandMore as ExpandMoreIcon,
  StopCircleOutlined as StopIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import ChatPage from '@renderer/pages/ChatPage/ChatPage'
import { loadAllSessions, type ChatSession } from '@renderer/pages/ChatPage/chatStorage'
import { getLocalizedConversationTitle } from '@renderer/pages/ChatPage/chatLocaleUtils'
import {
  CHAT_SESSION_LOADING_STATE_EVENT,
  CHAT_SESSION_RUN_STATE_EVENT,
  markScopedChatRunRead,
  readScopedChatRun,
  readScopedChatRuns,
  readScopedActiveLoadingSessionIds,
  readScopedExternalLoadingSessionIds,
  scopedStorageKey,
  STORAGE_KEY_CURRENT_SESSION_ID,
  type ChatSessionLoadingStateEvent,
  type ChatSessionRunState,
  type ChatSessionRunStateEvent
} from '@renderer/pages/ChatPage/chatPageShared'
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

import { getAgentColumnTokens, type AgentColumnTokens } from './agentColumnTokens'
import {
  readExistingWorkspacePanes,
  useExistingConversationWorkspacePane,
  useExistingConversationWorkspaceProtection,
  type ExistingConversationWorkspaceAdapter
} from './existingConversationWorkspace'

type AgentPane = {
  id: string
  enabled: boolean
}

type PanePreviewStatus = 'idle' | ChatSessionRunState['status']

type PanePreview = {
  title: string
  status: PanePreviewStatus
  unread: boolean
  runState?: ChatSessionRunState
}

type AgentWorkspaceStrings = {
  newConversation: string
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

type AgentWorkspaceTranslator = TFunction<'translation'>

const createAgentWorkspaceStrings = (t: AgentWorkspaceTranslator): AgentWorkspaceStrings => ({
  newConversation: t('chat.new_conversation'),
  paneLabel: (index: number) => t('agent_workspace.chat_label', { index })
})

const compactText = (value: string, fallback: string): string => {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized || fallback
}

/**
 * The conversation a thread is named after: the root (non-member) conversation
 * that is open in the pane. A team member's conversation resolves to its lead,
 * so opening a member or receiving a reply never renames the thread.
 */
const resolvePaneRootSession = (
  sessions: ChatSession[],
  currentSessionId: string | null
): ChatSession | undefined => {
  const current = currentSessionId
    ? sessions.find((session) => session.id === currentSessionId)
    : undefined
  const currentRoot = current?.teamLeadId
    ? sessions.find((session) => session.id === current.teamLeadId)
    : current
  if (currentRoot && !currentRoot.teamLeadId) return currentRoot

  // Sessions arrive oldest first; fall back to the newest root conversation.
  const roots = sessions.filter((session) => !session.teamLeadId)
  const openRoots = roots.filter((session) => !session.archived)
  return openRoots[openRoots.length - 1] ?? roots[roots.length - 1]
}

const readPaneCurrentSessionId = (scope: string): string | null =>
  readLocalStorage(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope))

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
      leftPreview.status === rightPreview.status &&
      leftPreview.unread === rightPreview.unread &&
      leftPreview.runState?.runId === rightPreview.runState?.runId &&
      leftPreview.runState?.sessionId === rightPreview.runState?.sessionId
    )
  })
}

const isPaneRunning = (scope: string): boolean => {
  return (
    readScopedActiveLoadingSessionIds(scope).length > 0 ||
    readScopedExternalLoadingSessionIds(scope).length > 0
  )
}

const readLatestPaneRunState = (scope: string): ChatSessionRunState | undefined => {
  let latest: ChatSessionRunState | undefined

  for (const state of readScopedChatRuns(scope)) {
    if (!state.runId || state.status === 'idle') continue
    if (!latest || state.updatedAt >= latest.updatedAt) {
      latest = state
    }
  }

  return latest
}

const buildPanePreview = (
  paneId: string,
  index: number,
  sessions: ChatSession[],
  running: boolean,
  strings: AgentWorkspaceStrings,
  runState?: ChatSessionRunState,
  currentSessionId: string | null = null
): PanePreview => {
  const rootSession = resolvePaneRootSession(sessions, currentSessionId)
  const paneLabel = getPaneLabel(paneId, index, strings.paneLabel)
  const status: PanePreviewStatus = runState?.status || (running ? 'running' : 'idle')
  const unread = runState?.unread === true

  return {
    title: compactText(
      getLocalizedConversationTitle(rootSession?.title, strings.newConversation),
      paneLabel
    ),
    status,
    unread,
    ...(runState ? { runState } : {})
  }
}

const loadPanePreview = async (
  pane: AgentPane,
  index: number,
  projectId: string,
  strings: AgentWorkspaceStrings
): Promise<readonly [string, PanePreview]> => {
  const scope = buildAgentPaneScope(projectId, pane.id)
  const sessions = await loadAllSessions(scope)
  const runState = readLatestPaneRunState(scope)
  return [
    pane.id,
    buildPanePreview(
      pane.id,
      index,
      sessions,
      isPaneRunning(scope),
      strings,
      runState,
      readPaneCurrentSessionId(scope)
    )
  ] as const
}

const loadPanePreviewWithFallback = async (
  pane: AgentPane,
  index: number,
  projectId: string,
  strings: AgentWorkspaceStrings,
  previousPreviews: Record<string, PanePreview>
): Promise<readonly [string, PanePreview]> => {
  try {
    return await loadPanePreview(pane, index, projectId, strings)
  } catch (error) {
    console.error('[AgentWorkspace] Failed to load pane preview', pane.id, error)
    return [
      pane.id,
      previousPreviews[pane.id] ||
        buildPanePreview(
          pane.id,
          index,
          [],
          isPaneRunning(buildAgentPaneScope(projectId, pane.id)),
          strings
        )
    ] as const
  }
}

const loadPreviewMap = async (
  panes: AgentPane[],
  projectId: string,
  strings: AgentWorkspaceStrings,
  previousPreviews: Record<string, PanePreview>
): Promise<Record<string, PanePreview>> => {
  const entries = await Promise.all(
    panes.map((pane, index) =>
      loadPanePreviewWithFallback(pane, index, projectId, strings, previousPreviews)
    )
  )

  return Object.fromEntries(entries) as Record<string, PanePreview>
}

type ThreadStatusTone = 'live' | 'attention' | 'danger' | 'muted'

type ThreadStatusLabelKey =
  'running' | 'queued' | 'waitingTool' | 'unread' | 'failed' | 'cancelled' | 'interrupted' | 'idle'

type ThreadStatusPresentation = {
  /** Stable value of data-status; tests and automation read it. */
  dataStatus: string
  tone: ThreadStatusTone
  label: ThreadStatusLabelKey
  /** Still working: announced as an indeterminate progress indicator. */
  busy: boolean
}

const resolveThreadStatus = (
  status: PanePreviewStatus,
  unread: boolean
): ThreadStatusPresentation => {
  if (status === 'running') {
    return { dataStatus: 'running', tone: 'live', label: 'running', busy: true }
  }
  if (status === 'queued') {
    return { dataStatus: 'queued', tone: 'attention', label: 'queued', busy: true }
  }
  if (status === 'waiting-tool') {
    return { dataStatus: 'waiting-tool', tone: 'attention', label: 'waitingTool', busy: false }
  }
  if (unread) {
    return { dataStatus: 'unread', tone: 'muted', label: 'unread', busy: false }
  }
  if (status === 'failed') {
    return { dataStatus: 'failed', tone: 'danger', label: 'failed', busy: false }
  }
  if (status === 'cancelled' || status === 'interrupted') {
    return { dataStatus: status, tone: 'muted', label: status, busy: false }
  }
  return { dataStatus: 'read', tone: 'muted', label: 'idle', busy: false }
}

const THREAD_STATUS_DOT_SIZE = 7

const ThreadStatusDot: React.FC<{
  status?: PanePreviewStatus
  unread?: boolean
  labels: Record<ThreadStatusLabelKey, string>
  tokens: AgentColumnTokens
}> = ({ status = 'idle', unread = false, labels, tokens }) => {
  const presentation = resolveThreadStatus(status, unread)
  const color =
    presentation.tone === 'live'
      ? tokens.live
      : presentation.tone === 'attention'
        ? tokens.attention
        : presentation.tone === 'danger'
          ? tokens.danger
          : tokens.muted
  const label = labels[presentation.label]

  return (
    <Box
      component="span"
      role={presentation.busy ? 'progressbar' : 'img'}
      aria-label={label}
      title={label}
      data-testid="agent-thread-status"
      data-status={presentation.dataStatus}
      data-run-status={status}
      sx={{
        width: THREAD_STATUS_DOT_SIZE,
        height: THREAD_STATUS_DOT_SIZE,
        flex: 'none',
        borderRadius: '50%',
        backgroundColor: color
      }}
    />
  )
}

/** Flat list rows and toolbar controls: square, no shadow, inset focus ring. */
const flatControlSx = (tokens: AgentColumnTokens) =>
  ({
    borderRadius: 0,
    boxShadow: 'none',
    fontFamily: 'inherit',
    fontSize: tokens.fontSize.base,
    lineHeight: '16px',
    textAlign: 'left',
    '&.Mui-focusVisible': tokens.focusRing
  }) as const

type ThreadListRowProps = {
  pane: AgentPane
  paneScope: string
  title: string
  status?: PanePreviewStatus
  selected: boolean
  unread: boolean
  dragging: boolean
  dragOver: boolean
  statusLabels: Record<ThreadStatusLabelKey, string>
  tokens: AgentColumnTokens
  onSelect: (paneId: string) => void
  onDragStart: (paneId: string) => void
  onDragEnd: () => void
  onDragOver: (event: React.DragEvent<HTMLElement>, paneId: string) => void
  onDrop: (event: React.DragEvent<HTMLElement>, paneId: string) => void
}

const AGENT_THREAD_REORDER_DRAG_MIME = 'application/x-magicpot-agent-thread-reorder'

const ThreadListRow: React.FC<ThreadListRowProps> = ({
  pane,
  paneScope,
  title,
  status,
  selected,
  unread,
  dragging,
  dragOver,
  statusLabels,
  tokens,
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop
}) => (
  <ButtonBase
    component="div"
    role="button"
    tabIndex={0}
    disableRipple
    aria-current={selected ? 'true' : undefined}
    data-agent-thread-row={pane.id}
    data-agent-workspace-scope={paneScope}
    draggable
    onClick={() => {
      onSelect(pane.id)
    }}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onSelect(pane.id)
      }
    }}
    onDragStart={(event) => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(AGENT_THREAD_REORDER_DRAG_MIME, pane.id)
      onDragStart(pane.id)
    }}
    onDragEnd={onDragEnd}
    onDragOver={(event) => {
      onDragOver(event, pane.id)
    }}
    onDrop={(event) => {
      onDrop(event, pane.id)
    }}
    sx={{
      ...flatControlSx(tokens),
      width: '100%',
      minWidth: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: '7px',
      padding: '7px 10px',
      borderBottom: `1px solid ${tokens.border}`,
      color: tokens.text,
      backgroundColor: selected ? tokens.selected : 'transparent',
      opacity: dragging ? tokens.disabledOpacity : 1,
      outline: dragOver ? `1px solid ${tokens.accent}` : 'none',
      outlineOffset: '-1px',
      '&:hover': {
        backgroundColor: selected ? tokens.selected : tokens.hover
      }
    }}
  >
    <ThreadStatusDot status={status} unread={unread} labels={statusLabels} tokens={tokens} />
    <Box
      component="span"
      data-testid="agent-thread-title"
      title={title}
      sx={{
        minWidth: 0,
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: unread ? 600 : 400
      }}
    >
      {title}
    </Box>
  </ButtonBase>
)

interface AgentWorkspaceProps {
  projectId: string
  projectName?: string
  existingConversationOpen?: ExistingConversationWorkspaceAdapter
}

const AgentWorkspace: React.FC<AgentWorkspaceProps> = ({ projectId, projectName, existingConversationOpen }) => {
  const { t } = useTranslation()
  const { notifyError, notifyInfo } = useMessage()
  const storageKey = buildWorkspaceStorageKey(projectId)
  const activeStorageKey = buildActivePaneStorageKey(projectId)
  const collapsedStorageKey = buildThreadsCollapsedStorageKey(projectId)
  const { isProtected: isVisitGuarded, isBlocked: isVisitBlocked, hasPolicy } = useExistingConversationWorkspaceProtection(projectId, existingConversationOpen)
  const guardedVisit = isVisitGuarded()
  const readPanesForVisit = () => isVisitBlocked() ? [] : guardedVisit
    ? readExistingWorkspacePanes(projectId, existingConversationOpen?.request?.handle.target)?.panes ?? []
    : readStoredPanes(storageKey)
  const [panes, setPanes] = useState<AgentPane[]>(readPanesForVisit)
  const [activePaneId, setActivePaneId] = useState<string | null>(() => {
    const enabled = getOpenPanes(readPanesForVisit())
    const requested = existingConversationOpen?.request?.handle.target
    if (guardedVisit && requested) return enabled.some(pane => pane.id === requested.paneId) ? requested.paneId : null
    const remembered = readStoredActivePaneId(activeStorageKey, enabled)
    return !guardedVisit || enabled.some(pane => pane.id === remembered) ? remembered : null
  })
  const explicitPaneMutationRef = useRef(false)
  // The thread list starts collapsed; the stored value keeps the person's last choice.
  const [threadsCollapsed, setThreadsCollapsed] = useState<boolean>(
    () => readLocalStorage(collapsedStorageKey) !== '0'
  )
  const [panePreviews, setPanePreviews] = useState<Record<string, PanePreview>>({})
  const panePreviewsRef = useRef<Record<string, PanePreview>>({})
  const [unreadPaneIds, setUnreadPaneIds] = useState<Set<string>>(new Set())
  const clearPaneUnread = useCallback(
    (paneId: string) => {
      setUnreadPaneIds((prev) => {
        if (!prev.has(paneId)) return prev
        const next = new Set(prev)
        next.delete(paneId)
        return next
      })

      const scope = buildAgentPaneScope(projectId, paneId)
      const runState = readLatestPaneRunState(scope)
      if (runState?.unread && runState.runId !== null) {
        markScopedChatRunRead(scope, runState.sessionId, runState.runId)
      }
    },
    [projectId]
  )
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
  const previewsInitializedRef = useRef(false)
  const panesObservedRunningRef = useRef<Set<string>>(new Set())
  const visitBlocked = isVisitBlocked()
  const openPanes = useMemo(() => visitBlocked ? [] : getOpenPanes(panes), [panes, visitBlocked])
  const workspaceStrings = useMemo(() => createAgentWorkspaceStrings(t), [t])
  const activePane = openPanes.find((pane) => pane.id === activePaneId) ?? (guardedVisit ? null : openPanes[0]) ?? null
  const theme = useTheme()
  const columnTokens = useMemo(() => getAgentColumnTokens(theme), [theme])
  const threadStatusLabels = useMemo<Record<ThreadStatusLabelKey, string>>(
    () => ({
      running: t('agent_workspace.status_running'),
      queued: t('agent_workspace.status_queued'),
      waitingTool: t('agent_workspace.status_waiting_tool'),
      unread: t('agent_workspace.status_unread'),
      failed: t('agent_workspace.status_failed'),
      cancelled: t('agent_workspace.status_cancelled'),
      interrupted: t('agent_workspace.status_interrupted'),
      idle: t('agent_workspace.status_idle')
    }),
    [t]
  )
  const activePaneIndex = activePane ? openPanes.findIndex((pane) => pane.id === activePane.id) : -1
  const threadSummary = activePane
    ? panePreviews[activePane.id]?.title ||
      getPaneLabel(activePane.id, activePaneIndex, workspaceStrings.paneLabel)
    : openPanes.length > 0
      ? t('agent_workspace.threads_none_selected', { count: openPanes.length })
      : t('agent_workspace.no_threads')
  const threadListOpen = !threadsCollapsed && openPanes.length > 0
  const headerSubtitle = projectName?.trim() || ''
  const threadListId = `agent-thread-list-${useId()}`
  const threadToggleRef = useRef<HTMLButtonElement | null>(null)
  const threadListRef = useRef<HTMLDivElement | null>(null)
  const openChatInput = useExistingConversationWorkspacePane({
    adapter: existingConversationOpen,
    projectId,
    activePaneId,
    panes,
    tracePanelOpen
  })
  const childProtections = useMemo(() => {
    if (!hasPolicy) return undefined
    return new Map(openPanes.map(pane => {
      const scope = buildAgentPaneScope(projectId, pane.id)
      return [pane.id, Object.freeze({ storageScope: scope, isProtected: isVisitGuarded })]
    }))
  }, [hasPolicy, openPanes, projectId, isVisitGuarded])
  useEffect(() => {
    const coordinator = existingConversationOpen?.coordinator
    const request = existingConversationOpen?.request
    if (!coordinator || !request) return
    const { target } = request.handle
    const existing = readExistingWorkspacePanes(projectId, target)
    if (!existing) {
      coordinator.cancel(request.handle, 'membership-unavailable')
      return
    }
    // Do not reconstruct persisted metadata from an enabled-only DTO, create or enable.
    // A mounted ordinary workspace may still contain its lossy normalized array.
    setPanes(previous => JSON.stringify(previous) === JSON.stringify(existing.panes) ? previous : existing.panes)
    setActivePaneId(target.paneId)
  }, [existingConversationOpen?.coordinator, existingConversationOpen?.request?.handle, projectId])

  useLayoutEffect(() => {
    if (!previewsInitializedRef.current) {
      if (Object.keys(panePreviews).length === 0) return
      previewsInitializedRef.current = true
      for (const [paneId, preview] of Object.entries(panePreviews)) {
        if (
          preview.status === 'queued' ||
          preview.status === 'running' ||
          preview.status === 'waiting-tool'
        ) {
          panesObservedRunningRef.current.add(paneId)
        }
      }
      return
    }

    for (const [paneId, preview] of Object.entries(panePreviews)) {
      if (
        preview.status === 'queued' ||
        preview.status === 'running' ||
        preview.status === 'waiting-tool'
      ) {
        panesObservedRunningRef.current.add(paneId)
      }
    }
  }, [panePreviews])

  useEffect(() => {
    previewsInitializedRef.current = false
    panesObservedRunningRef.current.clear()
    setUnreadPaneIds(new Set())
  }, [projectId])

  useEffect(() => {
    const paneIdByScope = new Map(
      openPanes.map((pane) => [buildAgentPaneScope(projectId, pane.id), pane.id])
    )
    const updatePaneFromRunState = (detail: ChatSessionRunStateEvent) => {
      const paneId = paneIdByScope.get(detail.scope)
      if (!paneId || !detail.sessionId || detail.runId === null) return

      const eventState = readScopedChatRun(detail.scope, detail.sessionId)
      if (eventState.runId !== detail.runId) return
      const next = readLatestPaneRunState(detail.scope)
      if (!next) return

      setPanePreviews((prev) => {
        const current = prev[paneId]
        const nextStatus = next.status
        const nextUnread = next.unread
        if (
          current?.status === nextStatus &&
          current.unread === nextUnread &&
          current.runState?.runId === next.runId &&
          current.runState?.sessionId === next.sessionId
        ) {
          return prev
        }

        const paneIndex = openPanes.findIndex((pane) => pane.id === paneId)
        return {
          ...prev,
          [paneId]: {
            title: current?.title || getPaneLabel(paneId, paneIndex, workspaceStrings.paneLabel),
            status: nextStatus,
            unread: nextUnread,
            runState: next
          }
        }
      })
      if (next.status === 'queued' || next.status === 'running' || next.status === 'waiting-tool') {
        panesObservedRunningRef.current.add(paneId)
      } else {
        panesObservedRunningRef.current.delete(paneId)
      }
      setUnreadPaneIds((prev) => {
        const shouldHaveUnread = next.unread
        if (prev.has(paneId) === shouldHaveUnread) return prev
        const updated = new Set(prev)
        if (shouldHaveUnread) updated.add(paneId)
        else updated.delete(paneId)
        return updated
      })
    }

    const handleRunState = (event: Event) => {
      const detail = (event as CustomEvent<ChatSessionRunStateEvent>).detail
      if (!detail || typeof detail.scope !== 'string' || typeof detail.sessionId !== 'string')
        return
      updatePaneFromRunState(detail)
    }

    window.addEventListener(CHAT_SESSION_RUN_STATE_EVENT, handleRunState)
    return () => window.removeEventListener(CHAT_SESSION_RUN_STATE_EVENT, handleRunState)
  }, [openPanes, projectId, workspaceStrings])

  useEffect(() => {
    const paneIdByScope = new Map(
      openPanes.map((pane) => [buildAgentPaneScope(projectId, pane.id), pane.id])
    )
    const handleLoadingState = (event: Event) => {
      const detail = (event as CustomEvent<Partial<ChatSessionLoadingStateEvent>>).detail
      const scope = detail?.scope
      const paneId = scope ? paneIdByScope.get(scope) : undefined
      if (!scope || !paneId) return
      if (readScopedChatRuns(scope).some((state) => state.runId !== null)) return

      setPanePreviews((prev) => {
        const current = prev[paneId]
        const status: PanePreviewStatus = detail.running
          ? 'running'
          : detail.completed === true
            ? 'completed'
            : 'idle'
        if (current?.status === status && current.unread === (detail.completed === true))
          return prev

        const paneIndex = openPanes.findIndex((pane) => pane.id === paneId)
        return {
          ...prev,
          [paneId]: {
            title: current?.title || getPaneLabel(paneId, paneIndex, workspaceStrings.paneLabel),
            status,
            unread: detail.completed === true
          }
        }
      })

      if (detail.running) {
        panesObservedRunningRef.current.add(paneId)
        setUnreadPaneIds((prev) => {
          if (!prev.has(paneId)) return prev
          const next = new Set(prev)
          next.delete(paneId)
          return next
        })
        return
      }

      const wasRunning = panesObservedRunningRef.current.delete(paneId)
      if (!wasRunning || detail.completed !== true) return
      setUnreadPaneIds((prev) => new Set(prev).add(paneId))
    }

    window.addEventListener(CHAT_SESSION_LOADING_STATE_EVENT, handleLoadingState)
    return () => window.removeEventListener(CHAT_SESSION_LOADING_STATE_EVENT, handleLoadingState)
  }, [openPanes, projectId, workspaceStrings])

  useEffect(() => {
    if (isVisitBlocked()) {
      setPanes(previous => previous.length ? [] : previous)
      setActivePaneId(null)
      return
    }
    if (isVisitGuarded()) {
      const existing = readExistingWorkspacePanes(projectId, existingConversationOpen?.request?.handle.target)
      const next = existing?.panes ?? []
      setPanes(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
      const requested = existingConversationOpen?.request?.handle.target.paneId
      const remembered = readLocalStorage(activeStorageKey)
      setActivePaneId(requested && next.some(pane => pane.id === requested && pane.enabled) ? requested :
        remembered && next.some(pane => pane.id === remembered && pane.enabled) ? remembered : null)
      return
    }
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
    setThreadsCollapsed(readLocalStorage(collapsedStorageKey) !== '0')
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
    // A guarded mount, refresh, or failed Open must not persist repaired/fallback metadata.
    if (isVisitBlocked() || (isVisitGuarded() && !explicitPaneMutationRef.current)) return
    explicitPaneMutationRef.current = false
    writeLocalStorage(storageKey, JSON.stringify(panes))
  }, [panes, storageKey, isVisitGuarded])

  useEffect(() => {
    if (isVisitGuarded()) return
    if (activePaneId && !openPanes.some((pane) => pane.id === activePaneId)) {
      setActivePaneId(openPanes[0]?.id || null)
    }
  }, [activePaneId, openPanes, isVisitGuarded])

  useEffect(() => {
    if (isVisitGuarded() && (!activePaneId || !openPanes.some(pane => pane.id === activePaneId))) return
    if (activePaneId) {
      writeLocalStorage(activeStorageKey, activePaneId)
      return
    }

    removeLocalStorage(activeStorageKey)
  }, [activePaneId, activeStorageKey, openPanes, isVisitGuarded])

  useEffect(() => {
    writeLocalStorage(collapsedStorageKey, threadsCollapsed ? '1' : '0')
  }, [collapsedStorageKey, threadsCollapsed])

  const selectedPaneId = activePane?.id ?? null
  useLayoutEffect(() => {
    // Keep the selected row inside the list's own scroll box when the list opens or the
    // selection changes. Scrolling is done by hand so no ancestor is ever scrolled.
    const list = threadListRef.current
    if (!threadListOpen || !list || !selectedPaneId) return
    const row = list.querySelector<HTMLElement>('[aria-current="true"]')
    if (!row) return
    const rowTop = row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    if (rowTop < list.scrollTop) {
      list.scrollTop = rowTop
    } else if (rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowBottom - list.clientHeight
    }
  }, [selectedPaneId, threadListOpen])

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

          const [paneId, preview] = await loadPanePreviewWithFallback(
            targetPane.pane,
            targetPane.index,
            projectId,
            workspaceStrings,
            panePreviewsRef.current
          )
          if (cancelled || sequence !== previewRefreshSequenceRef.current) return

          setPanePreviews((prev) => {
            const nextPreviews = { ...prev, [paneId]: preview }
            panePreviewsRef.current = nextPreviews
            return arePanePreviewsEqual(prev, nextPreviews) ? prev : nextPreviews
          })
          return
        }

        const nextPreviews = await loadPreviewMap(
          openPanes,
          projectId,
          workspaceStrings,
          panePreviewsRef.current
        )
        if (cancelled || sequence !== previewRefreshSequenceRef.current) return

        setPanePreviews((prev) => {
          const next = arePanePreviewsEqual(prev, nextPreviews) ? prev : nextPreviews
          panePreviewsRef.current = next
          return next
        })
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

  const handleRemovePane = (paneId: string) => {
    explicitPaneMutationRef.current = true
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
    explicitPaneMutationRef.current = true
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

      explicitPaneMutationRef.current = true
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

    explicitPaneMutationRef.current = true
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
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Typography
            variant="caption"
            sx={{
              fontSize: columnTokens.fontSize.base,
              fontWeight: 600,
              lineHeight: 1.3,
              color: 'text.primary',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {t('agent_workspace.title')}
          </Typography>
          {headerSubtitle && (
            <Typography
              variant="caption"
              data-testid="agent-workspace-subtitle"
              sx={{
                fontSize: columnTokens.fontSize.caption,
                lineHeight: 1.3,
                color: 'text.secondary',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {headerSubtitle}
            </Typography>
          )}
        </Box>

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
          {t('agent_workspace.canvas_target', { defaultValue: 'Canvas target' })}
        </Button>
      </Box>

      <Box
        component="section"
        aria-label={t('agent_workspace.thread_list')}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !threadListOpen) return
          event.stopPropagation()
          setThreadsCollapsed(true)
          threadToggleRef.current?.focus()
        }}
        sx={{ flexShrink: 0, minWidth: 0, WebkitAppRegion: 'no-drag' }}
      >
        <Box
          data-testid="agent-thread-toolbar"
          sx={{
            display: 'flex',
            alignItems: 'center',
            minWidth: 0,
            minHeight: 34,
            padding: '2px 6px',
            borderBottom: `1px solid ${columnTokens.border}`,
            borderRadius: 0,
            boxShadow: 'none'
          }}
        >
          <ButtonBase
            ref={threadToggleRef}
            type="button"
            disableRipple
            disabled={openPanes.length === 0}
            aria-expanded={threadListOpen}
            aria-controls={threadListOpen ? threadListId : undefined}
            data-testid="agent-thread-toggle"
            title={threadSummary}
            onClick={() => setThreadsCollapsed((prev) => !prev)}
            sx={{
              ...flatControlSx(columnTokens),
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: '5px',
              padding: '5px 2px',
              color: activePane ? columnTokens.text : columnTokens.muted
            }}
          >
            <ExpandMoreIcon
              aria-hidden
              sx={{
                fontSize: 16,
                flex: 'none',
                transition: 'transform 120ms ease',
                transform: threadListOpen ? 'rotate(180deg)' : 'none'
              }}
            />
            <Box
              component="span"
              data-testid="agent-thread-summary"
              sx={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {threadSummary}
            </Box>
          </ButtonBase>

          <Tooltip title={t('agent_workspace.new_chat')} arrow>
            <IconButton
              aria-label={t('agent_workspace.new_chat')}
              onClick={handleAddPane}
              sx={{
                width: 26,
                height: 26,
                padding: 0,
                flex: 'none',
                borderRadius: `${columnTokens.radius.control}px`,
                color: columnTokens.text,
                '&:hover': { backgroundColor: columnTokens.hover },
                '&.Mui-focusVisible': columnTokens.focusRing
              }}
            >
              <AddIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>

        {threadListOpen && (
          <Box
            id={threadListId}
            ref={threadListRef}
            data-testid="agent-thread-list"
            sx={{
              position: 'relative',
              maxHeight: 'min(38vh, 280px)',
              overflowX: 'hidden',
              overflowY: 'auto'
            }}
          >
            {openPanes.map((pane, index) => (
              <ThreadListRow
                key={pane.id}
                pane={pane}
                paneScope={buildAgentPaneScope(projectId, pane.id)}
                title={
                  panePreviews[pane.id]?.title ||
                  getPaneLabel(pane.id, index, workspaceStrings.paneLabel)
                }
                status={panePreviews[pane.id]?.status}
                selected={pane.id === activePane?.id}
                unread={unreadPaneIds.has(pane.id) || Boolean(panePreviews[pane.id]?.unread)}
                dragging={pane.id === draggingPaneId}
                dragOver={pane.id === dragOverPaneId && pane.id !== draggingPaneId}
                statusLabels={threadStatusLabels}
                tokens={columnTokens}
                onSelect={setActivePaneId}
                onDragStart={(paneId) => {
                  setDraggingPaneId(paneId)
                  setDragOverPaneId(null)
                }}
                onDragEnd={() => {
                  setDraggingPaneId(null)
                  setDragOverPaneId(null)
                }}
                onDragOver={(event, paneId) => {
                  const dragTypes = Array.from(event.dataTransfer.types ?? [])
                  const isThreadReorderDrag = dragTypes.includes(AGENT_THREAD_REORDER_DRAG_MIME)
                  if (!isThreadReorderDrag) {
                    return
                  }

                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (draggingPaneId) {
                    setDragOverPaneId(paneId)
                  }
                }}
                onDrop={(event, paneId) => {
                  const dragTypes = Array.from(event.dataTransfer.types ?? [])
                  const isThreadReorderDrag = dragTypes.includes(AGENT_THREAD_REORDER_DRAG_MIME)
                  if (!isThreadReorderDrag) {
                    return
                  }

                  event.preventDefault()
                  if (draggingPaneId) {
                    handleReorderPane(paneId)
                    setDraggingPaneId(null)
                  }
                }}
              />
            ))}
            {activePane && (
              <ButtonBase
                type="button"
                disableRipple
                data-testid="agent-thread-close-current"
                onClick={() => handleRemovePane(activePane.id)}
                sx={{
                  ...flatControlSx(columnTokens),
                  width: '100%',
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  gap: '6px',
                  padding: '7px 10px',
                  borderBottom: `1px solid ${columnTokens.border}`,
                  color: columnTokens.danger,
                  '&:hover': { backgroundColor: columnTokens.hover }
                }}
              >
                <CloseIcon aria-hidden sx={{ fontSize: 16, flex: 'none' }} />
                <Box
                  component="span"
                  sx={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {t('agent_workspace.close_thread')}
                </Box>
              </ButtonBase>
            )}
          </Box>
        )}
      </Box>

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
              onPointerDownCapture={(event) => {
                const target = event.target as Element
                if (!target.closest('[data-chat-scroll-container="true"]')) return
                clearPaneUnread(pane.id)
              }}
              onScrollCapture={(event) => {
                const target = event.target as Element
                if (!target.matches('[data-chat-scroll-container="true"]')) return
                clearPaneUnread(pane.id)
              }}
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
                existingConversationProtection={childProtections?.get(pane.id)}
                existingConversationOpen={isActivePane && openChatInput?.handle.target.paneId === pane.id ? openChatInput : undefined}
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
