import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import {
  FIGPLUGIN_BRIDGE_ERRORS,
  FigPluginBridgeError,
  figPluginBridgeDesktopStateSchema,
  figPluginDesktopApprovalSchema,
  figPluginDesktopPairRequestSchema,
  figPluginDesktopPairTicketSchema,
  parseFigPluginBridgeValue,
  type FigPluginBridgeDesktopState,
  type FigPluginBridgePreview,
  type FigPluginDesktopPairTicket
} from '@shared/figplugin/bridge'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import {
  figPluginManagedPathResultSchema,
  type FigPluginManagedSummary
} from '@shared/figplugin/management'
import {
  figPluginDesktopExecutionApprovalSchema,
  figPluginDesktopExecutionSchema,
  figPluginDesktopVisualBaselineAcceptanceSchema,
  figPluginDesktopVisualCorrectionAuthorizationRequestSchema,
  figPluginDesktopVisualCorrectionAuthorizationSchema,
  figPluginExecutionDesktopStateSchema,
  figPluginVisualBaselineSchema,
  figPluginVisualCorrectionAuthorizationSchema,
  type FigPluginDesktopExecution,
  type FigPluginExecutionDesktopState,
  type FigPluginExecutionPreview,
  type FigPluginExecutionStatus,
  type FigPluginVisualBaselineComparison,
  type FigPluginVisualCorrectionAuthorization,
  type FigPluginVisualEvidence
} from '@shared/figplugin/execution'
import { getProjectById, listProjects, PROJECTS_CHANGED_EVENT } from '../MainPage/projectStore'

type Live = () => boolean
type ProjectChoice = { id: string; name: string }
type BridgeErrorCode = keyof typeof FIGPLUGIN_BRIDGE_ERRORS | 'UNKNOWN'
type BridgeErrorKey = `figplugin.bridge.errors.${BridgeErrorCode}`
type BridgeNoticeKey =
  | 'figplugin.bridge.monitorStopped'
  | 'figplugin.bridge.declined'
  | 'figplugin.bridge.revoked'
  | 'figplugin.bridge.approvalAccepted'
  | 'figplugin.bridge.denied'
  | 'figplugin.bridge.planApprovalAccepted'
  | 'figplugin.bridge.planDenied'
  | 'figplugin.bridge.planCancelled'
  | 'figplugin.bridge.visualBaselineAccepted'
  | 'figplugin.bridge.visualBaselineDeclined'
  | 'figplugin.bridge.visualCorrectionAuthorized'
  | 'figplugin.bridge.visualCorrectionDeclined'
  | 'figplugin.bridge.visualCorrectionCancelled'

const emptyState = (): FigPluginBridgeDesktopState => ({ sessions: [], previews: [] })
const emptyExecutionState = (): FigPluginExecutionDesktopState => ({
  previews: [],
  statuses: [],
  baselines: [],
  correctionAuthorizations: []
})
const eligible = (item: FigPluginManagedSummary) =>
  !!item.bridgeOrigin &&
  item.materialization === 'verified-package' &&
  item.configured &&
  !!item.settings.analysisProfileId &&
  !item.cleanupPending &&
  item.capabilities.includes('dialogue')

// Consent covers every displayed field, not just a server-supplied hash. Main verifies the
// payload digest and runtime binding; the desktop preview does not contain the whole binding.
const reviewKey = (call: FigPluginBridgePreview): string => canonicalFigPluginJson(call)
const executionReviewKey = (preview: FigPluginExecutionPreview): string =>
  canonicalFigPluginJson(preview)
const correctionReviewKey = (status: FigPluginExecutionStatus): string =>
  status.visualEvidenceSha256 && status.visualBaselineComparison
    ? canonicalFigPluginJson({
        executionId: status.executionId,
        visualEvidenceSha256: status.visualEvidenceSha256,
        comparison: status.visualBaselineComparison
      })
    : ''
const shortHash = (value: string): string => value.slice(0, 12)
const renderVisualEvidence = (items: FigPluginVisualEvidence[]): string =>
  items
    .map(
      (item) =>
        `${item.targetId}: ${shortHash(item.before.sha256)} -> ${shortHash(item.after.sha256)} ${
          item.changed ? 'changed' : 'unchanged'
        }`
    )
    .join('\n')
const renderVisualBaselineComparison = (comparison: FigPluginVisualBaselineComparison): string =>
  comparison.targets
    .map(
      (item) =>
        `${item.targetId}: ${shortHash(item.baseline.sha256)} ${item.baseline.width}x${
          item.baseline.height
        } -> ${shortHash(item.current.sha256)} ${item.current.width}x${item.current.height} ${
          item.changed ? 'changed' : 'exact'
        }`
    )
    .join('\n')
const isBridgeErrorCode = (value: string): value is keyof typeof FIGPLUGIN_BRIDGE_ERRORS =>
  Object.hasOwn(FIGPLUGIN_BRIDGE_ERRORS, value)
const bridgeErrorKey = (code: BridgeErrorCode): BridgeErrorKey => `figplugin.bridge.errors.${code}`
const safeError = (error: unknown): BridgeErrorCode => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    isBridgeErrorCode(error.code)
  )
    return error.code
  if (error instanceof Error) {
    for (const [code, message] of Object.entries(FIGPLUGIN_BRIDGE_ERRORS)) {
      if (
        isBridgeErrorCode(code) &&
        (error.message === message || error.message.endsWith(`: ${message}`))
      )
        return code
    }
  }
  return 'UNKNOWN'
}

const revokeQuietly = (pluginId: string): Promise<void> => {
  return Promise.resolve()
    .then(() => api().svcFigPluginCenter.revokeBridge({ pluginId }))
    .catch(() => {})
}

const projectChoices = (): ProjectChoice[] => {
  const seen = new Set<string>()
  return listProjects()
    .slice(0, 256)
    .filter(({ id }) => {
      if (!/^[A-Za-z0-9_-]{1,160}$(?![\s\S])/.test(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
    .map(({ id, name }) => ({ id, name: name.slice(0, 120) }))
}

const PluginBridgePanel = ({ items }: { items: FigPluginManagedSummary[] }) => {
  const { t } = useTranslation()
  const id = useId()
  const [pluginId, setPluginId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects] = useState<ProjectChoice[]>([])
  const [pairedIds, setPairedIds] = useState<string[]>([])
  const [models, setModels] = useState<Record<string, string>>({})
  const [ticket, setTicket] = useState<FigPluginDesktopPairTicket | null>(null)
  const [state, setState] = useState(emptyState)
  const [executions, setExecutions] = useState(emptyExecutionState)
  const [reviewed, setReviewed] = useState<Record<string, string>>({})
  const [reviewedExecutions, setReviewedExecutions] = useState<Record<string, string>>({})
  const [reviewedBaselines, setReviewedBaselines] = useState<Record<string, string>>({})
  const [reviewedCorrections, setReviewedCorrections] = useState<Record<string, string>>({})
  const [monitorUntil, setMonitorUntil] = useState(0)
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const locked = busy || revoking
  const [error, setError] = useState<BridgeErrorKey | ''>('')
  const [notice, setNotice] = useState<BridgeNoticeKey | ''>('')
  const mounted = useRef(false)
  const epoch = useRef(0)
  const pending = useRef<symbol | null>(null)
  const revokePending = useRef<symbol | null>(null)
  const paired = useRef(new Set<string>())
  const monitorDeadline = useRef(0)
  const revocations = useRef<Promise<void> | null>(null)
  const queueRevocation = useCallback((targetId: string) => {
    const previous = revocations.current ?? Promise.resolve()
    revocations.current = previous.then(() => revokeQuietly(targetId))
  }, [])
  const candidates = items.filter(eligible)
  const selected = candidates.find((item) => item.pluginId === pluginId)
  const project = projects.find((item) => item.id === projectId)
  const scopeKey = JSON.stringify([
    selected?.pluginId,
    project?.id,
    candidates.map((item) => [
      item.pluginId,
      item.generation,
      item.host,
      item.bridgeOrigin,
      item.artifactSha256,
      item.signerFingerprint,
      item.settings.analysisProfileId
    ]),
    projects.map((item) => item.id)
  ])
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey

  const clearView = useCallback(() => {
    setTicket(null)
    setState(emptyState())
    setExecutions(emptyExecutionState())
    setReviewed({})
    setReviewedExecutions({})
    setReviewedBaselines({})
    setReviewedCorrections({})
    setModels({})
  }, [])

  const stopMonitoring = useCallback(() => {
    epoch.current += 1
    monitorDeadline.current = 0
    setMonitorUntil(0)
    clearView()
    setNotice('figplugin.bridge.monitorStopped')
  }, [clearView])

  const startMonitoring = () => {
    const until = Date.now() + 600_000
    monitorDeadline.current = until
    setMonitorUntil(until)
  }

  const run = useCallback(
    async (work: (live: Live) => Promise<void>, feedback = true) => {
      if (!mounted.current || pending.current || revokePending.current) return
      const operation = Symbol()
      pending.current = operation
      setBusy(true)
      if (feedback) {
        setError('')
        setNotice('')
      }
      const started = epoch.current
      const scope = currentScope.current
      const deadline = monitorDeadline.current
      const live = () =>
        mounted.current &&
        started === epoch.current &&
        scope === currentScope.current &&
        (!deadline || Date.now() < deadline)
      try {
        await work(live)
      } catch (failure) {
        if (live()) {
          stopMonitoring()
          setNotice('')
          setError(bridgeErrorKey(safeError(failure)))
        }
      } finally {
        // Keep serialization even after invalidation: a late revoke must not revoke a new ticket.
        if (mounted.current && pending.current === operation) {
          pending.current = null
          setBusy(false)
        }
      }
    },
    [stopMonitoring]
  )

  const refresh = useCallback(async (live: Live) => {
    const [value, executionValue] = await Promise.all([
      api().svcFigPluginCenter.bridgeState({}),
      api().svcFigPluginCenter.planState({})
    ])
    if (!live()) return
    const next = parseFigPluginBridgeValue(figPluginBridgeDesktopStateSchema, value)
    const nextExecutions = parseFigPluginBridgeValue(
      figPluginExecutionDesktopStateSchema,
      executionValue
    )
    if (
      new Set(next.previews.map((call) => call.callId)).size !== next.previews.length ||
      new Set(next.sessions.map((session) => session.sessionId)).size !== next.sessions.length ||
      next.previews.some((call, index) => call.prompt !== value.previews[index].prompt)
    )
      throw new FigPluginBridgeError('INVALID_REQUEST')
    const now = Date.now()
    next.previews = next.previews.filter((call) => call.expiresAt > now)
    next.sessions = next.sessions.filter((session) => session.expiresAt > now)
    for (const entry of [...next.sessions, ...next.previews]) paired.current.add(entry.pluginId)
    setPairedIds([...paired.current])
    setTicket((previous) =>
      previous && !next.sessions.some((session) => session.pluginId === previous.pluginId)
        ? previous
        : null
    )
    setState(next)
    const activeExecutionPreviews = nextExecutions.previews.filter(
      (preview) => preview.expiresAt > now
    )
    const activeBaselines = nextExecutions.baselines.filter((baseline) => baseline.expiresAt > now)
    const activeCorrectionAuthorizations = nextExecutions.correctionAuthorizations.filter(
      (authorization) => authorization.expiresAt > now
    )
    setExecutions({
      previews: activeExecutionPreviews,
      statuses: nextExecutions.statuses,
      baselines: activeBaselines,
      correctionAuthorizations: activeCorrectionAuthorizations
    })
    setReviewed((previous) =>
      Object.fromEntries(
        next.previews
          .filter((call) => previous[call.callId] === reviewKey(call))
          .map((call) => [call.callId, reviewKey(call)])
      )
    )
    setReviewedExecutions((previous) =>
      Object.fromEntries(
        activeExecutionPreviews
          .filter((previewEx) => previous[previewEx.executionId] === executionReviewKey(previewEx))
          .map((previewEx) => [previewEx.executionId, executionReviewKey(previewEx)])
      )
    )
    setReviewedBaselines((previous) =>
      Object.fromEntries(
        nextExecutions.statuses
          .filter(
            (status) =>
              status.visualEvidenceSha256 !== undefined &&
              previous[status.executionId] === status.visualEvidenceSha256 &&
              !activeBaselines.some((baseline) => baseline.sourceExecutionId === status.executionId)
          )
          .map((status) => [status.executionId, status.visualEvidenceSha256!])
      )
    )
    setReviewedCorrections((previous) =>
      Object.fromEntries(
        nextExecutions.statuses
          .filter(
            (status) =>
              status.visualBaselineComparison?.exactMatch === false &&
              previous[status.executionId] === correctionReviewKey(status) &&
              !activeCorrectionAuthorizations.some(
                (authorization) =>
                  authorization.baselineId === status.visualBaselineComparison?.baselineId
              )
          )
          .map((status) => [status.executionId, correctionReviewKey(status)])
      )
    )
    setError('')
  }, [])

  const loadModels = async (live: Live) => {
    try {
      const result = await api().svcLLMProxy.listProfiles({})
      const metadata = Object.fromEntries(
        result.profiles
          .slice(0, 256)
          .filter(
            (profile) =>
              typeof profile.id === 'string' &&
              profile.id.length > 0 &&
              profile.id.length <= 512 &&
              typeof profile.model_name === 'string'
          )
          .map((profile) => [profile.id, profile.model_name.slice(0, 256)])
      )
      if (live()) setModels(metadata)
    } catch {
      if (live()) setModels({})
    }
  }

  useEffect(() => {
    mounted.current = true
    const update = () => setProjects(projectChoices())
    update()
    window.addEventListener(PROJECTS_CHANGED_EVENT, update)
    window.addEventListener('storage', update)
    const grants = paired.current
    return () => {
      mounted.current = false
      epoch.current += 1
      pending.current = null
      window.removeEventListener(PROJECTS_CHANGED_EVENT, update)
      window.removeEventListener('storage', update)
      for (const pairedId of grants) queueRevocation(pairedId)
      grants.clear()
    }
  }, [queueRevocation])

  useEffect(() => {
    // Also covers package refreshes and project deletion while IPC/native consent is pending.
    stopMonitoring()
    setError('')
    setNotice('')
    for (const pairedId of paired.current) queueRevocation(pairedId)
  }, [scopeKey, stopMonitoring, queueRevocation])

  useEffect(() => {
    if (!monitorUntil) return
    const interval = setInterval(() => {
      if (Date.now() < monitorUntil) void run(refresh, false)
    }, 2000)
    const timeout = setTimeout(stopMonitoring, Math.max(0, monitorUntil - Date.now()))
    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [monitorUntil, refresh, run, stopMonitoring])

  useEffect(() => {
    const expiries = [
      ...(ticket ? [ticket.expiresAt] : []),
      ...state.previews.map((call) => call.expiresAt),
      ...state.sessions.map((session) => session.expiresAt),
      ...executions.previews.map((previewEx) => previewEx.expiresAt),
      ...executions.baselines.map((baseline) => baseline.expiresAt),
      ...executions.correctionAuthorizations.map((authorization) => authorization.expiresAt)
    ]
    if (!expiries.length) return
    const timer = setTimeout(
      () => {
        const now = Date.now()
        setTicket((value) => (value && value.expiresAt > now ? value : null))
        setState((value) => ({
          sessions: value.sessions.filter((session) => session.expiresAt > now),
          previews: value.previews.filter((call) => call.expiresAt > now)
        }))
        setExecutions((value) => ({
          previews: value.previews.filter((previewEx) => previewEx.expiresAt > now),
          statuses: value.statuses,
          baselines: value.baselines.filter((baseline) => baseline.expiresAt > now),
          correctionAuthorizations: value.correctionAuthorizations.filter(
            (authorization) => authorization.expiresAt > now
          )
        }))
        setReviewed({})
        setReviewedExecutions({})
        setReviewedBaselines({})
        setReviewedCorrections({})
      },
      Math.min(2_147_483_647, Math.max(0, Math.min(...expiries) - Date.now()))
    )
    return () => clearTimeout(timer)
  }, [ticket, state, executions])

  const create = () => {
    if (pending.current || revokePending.current || !selected || !project) return
    if (!getProjectById(project.id)) {
      setProjects(projectChoices())
      setProjectId('')
      setError('figplugin.bridge.errors.CONFIGURATION_CHANGED')
      return
    }
    const target = selected
    stopMonitoring()
    void run(async (live) => {
      // A delayed cleanup from an older scope must finish before minting a new capability.
      if (revocations.current) {
        await revocations.current
        if (!live()) return
      }
      if (paired.current.has(target.pluginId)) {
        await api().svcFigPluginCenter.revokeBridge({ pluginId: target.pluginId })
        paired.current.delete(target.pluginId)
        if (!live()) return
        setPairedIds([...paired.current])
      }
      // Include an outstanding native pairing request in navigation cleanup, not only its reply.
      paired.current.add(target.pluginId)
      // The cleanup fence may have yielded since the busy render. Publish this pending
      // capability before awaiting native consent so its revoke control is reachable.
      setPairedIds([...paired.current])
      let value: FigPluginDesktopPairTicket | null
      try {
        value = await api().svcFigPluginCenter.createPairing(
          figPluginDesktopPairRequestSchema.parse({
            pluginId: target.pluginId,
            expectedGeneration: target.generation,
            projectId: project.id
          })
        )
      } catch (failure) {
        queueRevocation(target.pluginId)
        throw failure
      }
      if (!live() || !getProjectById(project.id)) {
        queueRevocation(target.pluginId)
        return
      }
      if (value === null) {
        paired.current.delete(target.pluginId)
        setPairedIds([...paired.current])
        setNotice('figplugin.bridge.declined')
        return
      }
      const parsed = figPluginDesktopPairTicketSchema.safeParse(value)
      if (
        !parsed.success ||
        parsed.data.pluginId !== target.pluginId ||
        parsed.data.bridgeOrigin !== target.bridgeOrigin ||
        parsed.data.artifactSha256 !== target.artifactSha256 ||
        parsed.data.host !== target.host ||
        parsed.data.expiresAt <= Date.now() ||
        parsed.data.expiresAt > Date.now() + 120_000
      ) {
        queueRevocation(target.pluginId)
        throw new FigPluginBridgeError('INVALID_REQUEST')
      }
      setTicket(parsed.data)
      startMonitoring()
      await loadModels(live)
      if (live()) await refresh(live)
    })
  }

  const revoke = (targetId: string) => {
    // Cancellation has its own single-flight lane: metadata, status and native grant work
    // must never block it. Invalidate their replies now, but retain their grant lock.
    if (!mounted.current || revokePending.current) return
    const operation = Symbol()
    revokePending.current = operation
    setRevoking(true)
    stopMonitoring()
    setError('')
    setNotice('')
    const started = epoch.current
    const scope = currentScope.current
    const live = () =>
      mounted.current && started === epoch.current && scope === currentScope.current
    const cancellation = Promise.resolve()
      .then(() => api().svcFigPluginCenter.revokeBridge({ pluginId: targetId }))
      .then(() => {
        paired.current.delete(targetId)
        if (mounted.current) setPairedIds([...paired.current])
        if (live()) setNotice('figplugin.bridge.revoked')
      })
      .catch((failure: unknown) => {
        if (live()) setError(bridgeErrorKey(safeError(failure)))
      })
      .finally(() => {
        if (revokePending.current === operation) {
          revokePending.current = null
          if (mounted.current) setRevoking(false)
        }
      })
    // New grants wait for all earlier cleanup, including cancellation that outlives
    // the old request. Never release pending.current just to make the revoke clickable.
    revocations.current = Promise.all([revocations.current, cancellation]).then(() => undefined)
  }

  const canApprove = (call: FigPluginBridgePreview) =>
    call.expiresAt > Date.now() &&
    projects.some((value) => value.id === call.projectId) &&
    candidates.some(
      (item) =>
        item.pluginId === call.pluginId &&
        item.host === call.host &&
        item.settings.analysisProfileId === call.profileId
    )

  const decide = (call: FigPluginBridgePreview, approve: boolean) => {
    if (pending.current || revokePending.current || call.expiresAt <= Date.now()) return
    if (approve && (reviewed[call.callId] !== reviewKey(call) || !canApprove(call))) return
    if (approve && !getProjectById(call.projectId)) {
      stopMonitoring()
      queueRevocation(call.pluginId)
      setError('figplugin.bridge.errors.CONFIGURATION_CHANGED')
      return
    }
    setReviewed((previous) => {
      const next = { ...previous }
      delete next[call.callId]
      return next
    })
    void run(async (live) => {
      if (approve) {
        const result = parseFigPluginBridgeValue(
          figPluginManagedPathResultSchema,
          await api().svcFigPluginCenter.approveBridge(
            figPluginDesktopApprovalSchema.parse({
              callId: call.callId,
              payloadSha256: call.payloadSha256
            })
          )
        )
        if (live())
          setNotice(
            result.completed ? 'figplugin.bridge.approvalAccepted' : 'figplugin.bridge.declined'
          )
      } else {
        await api().svcFigPluginCenter.denyBridge({ callId: call.callId })
        if (live()) setNotice('figplugin.bridge.denied')
      }
      if (live()) await refresh(live)
    })
  }

  const canApproveExecution = (preview: FigPluginExecutionPreview) =>
    preview.expiresAt > Date.now() &&
    preview.state === 'awaiting-approval' &&
    projects.some((value) => value.id === preview.projectId) &&
    candidates.some((item) => item.pluginId === preview.pluginId && item.host === preview.host)

  const decideExecution = (previewEx: FigPluginExecutionPreview, approve: boolean) => {
    if (pending.current || revokePending.current || previewEx.expiresAt <= Date.now()) return
    if (
      approve &&
      (reviewedExecutions[previewEx.executionId] !== executionReviewKey(previewEx) ||
        !canApproveExecution(previewEx))
    )
      return
    if (approve && !getProjectById(previewEx.projectId)) {
      stopMonitoring()
      setError('figplugin.bridge.errors.CONFIGURATION_CHANGED')
      return
    }
    setReviewedExecutions((previous) => {
      const next = { ...previous }
      delete next[previewEx.executionId]
      return next
    })
    void run(async (live) => {
      if (approve) {
        const result = parseFigPluginBridgeValue(
          figPluginManagedPathResultSchema,
          await api().svcFigPluginCenter.approvePlanExecution(
            figPluginDesktopExecutionApprovalSchema.parse({
              executionId: previewEx.executionId,
              planSha256: previewEx.planSha256
            })
          )
        )
        if (live())
          setNotice(
            result.completed
              ? 'figplugin.bridge.planApprovalAccepted'
              : 'figplugin.bridge.planDenied'
          )
      } else {
        await api().svcFigPluginCenter.denyPlanExecution(
          figPluginDesktopExecutionSchema.parse({ executionId: previewEx.executionId })
        )
        if (live()) setNotice('figplugin.bridge.planDenied')
      }
      if (live()) await refresh(live)
    })
  }

  const cancelExecution = (executionId: string) => {
    if (pending.current || revokePending.current) return
    void run(async (live) => {
      await api().svcFigPluginCenter.cancelPlanExecution(
        figPluginDesktopExecutionSchema.parse({ executionId })
      )
      if (live()) setNotice('figplugin.bridge.planCancelled')
      if (live()) await refresh(live)
    })
  }

  const canAcceptVisualBaseline = (status: FigPluginExecutionStatus) => {
    const preview = executions.previews.find((item) => item.executionId === status.executionId)
    return (
      status.state === 'completed' &&
      status.effect === 'applied' &&
      status.visualEvidence !== undefined &&
      status.visualEvidenceSha256 !== undefined &&
      preview?.visualAudit === 'hash-only' &&
      preview.expiresAt > Date.now() &&
      projects.some((value) => value.id === preview.projectId) &&
      candidates.some((item) => item.pluginId === preview.pluginId && item.host === preview.host) &&
      !executions.baselines.some((baseline) => baseline.sourceExecutionId === status.executionId)
    )
  }

  const acceptVisualBaseline = (status: FigPluginExecutionStatus) => {
    const hash = status.visualEvidenceSha256
    const preview = executions.previews.find((item) => item.executionId === status.executionId)
    if (
      pending.current ||
      revokePending.current ||
      !hash ||
      !preview ||
      reviewedBaselines[status.executionId] !== hash ||
      !canAcceptVisualBaseline(status)
    )
      return
    if (!getProjectById(preview.projectId)) {
      stopMonitoring()
      setError('figplugin.bridge.errors.CONFIGURATION_CHANGED')
      return
    }
    setReviewedBaselines((previous) => {
      const next = { ...previous }
      delete next[status.executionId]
      return next
    })
    void run(async (live) => {
      const value = await api().svcFigPluginCenter.acceptVisualBaseline(
        figPluginDesktopVisualBaselineAcceptanceSchema.parse({
          executionId: status.executionId,
          visualEvidenceSha256: hash
        })
      )
      if (!live()) return
      if (value === null) {
        setNotice('figplugin.bridge.visualBaselineDeclined')
      } else {
        const baseline = parseFigPluginBridgeValue(figPluginVisualBaselineSchema, value)
        if (
          baseline.sourceExecutionId !== status.executionId ||
          baseline.visualEvidenceSha256 !== hash ||
          baseline.expiresAt <= Date.now()
        )
          throw new FigPluginBridgeError('INVALID_REQUEST')
        setNotice('figplugin.bridge.visualBaselineAccepted')
      }
      if (live()) await refresh(live)
    })
  }

  const canAuthorizeVisualCorrection = (status: FigPluginExecutionStatus) => {
    const comparison = status.visualBaselineComparison
    const preview = executions.previews.find((item) => item.executionId === status.executionId)
    const baseline = executions.baselines.find(
      (item) => item.baselineId === comparison?.baselineId && item.expiresAt > Date.now()
    )
    return (
      status.state === 'completed' &&
      status.effect === 'applied' &&
      status.visualEvidenceSha256 !== undefined &&
      comparison?.exactMatch === false &&
      comparison.changedCount > 0 &&
      baseline !== undefined &&
      baseline.visualEvidenceSha256 === comparison.baselineEvidenceSha256 &&
      baseline.adapterVersion === preview?.adapterVersion &&
      baseline.correctionRoundsUsed < baseline.maxCorrectionRounds &&
      preview?.visualAudit === 'hash-only' &&
      preview.expiresAt > Date.now() &&
      projects.some((value) => value.id === preview.projectId) &&
      candidates.some((item) => item.pluginId === preview.pluginId && item.host === preview.host) &&
      !executions.correctionAuthorizations.some(
        (authorization) => authorization.baselineId === baseline.baselineId
      )
    )
  }

  const authorizeVisualCorrection = (status: FigPluginExecutionStatus) => {
    const comparison = status.visualBaselineComparison
    const evidenceHash = status.visualEvidenceSha256
    const preview = executions.previews.find((item) => item.executionId === status.executionId)
    const baseline = executions.baselines.find((item) => item.baselineId === comparison?.baselineId)
    const review = correctionReviewKey(status)
    if (
      pending.current ||
      revokePending.current ||
      !comparison ||
      !evidenceHash ||
      !preview ||
      !baseline ||
      reviewedCorrections[status.executionId] !== review ||
      !canAuthorizeVisualCorrection(status)
    )
      return
    if (!getProjectById(preview.projectId)) {
      stopMonitoring()
      setError('figplugin.bridge.errors.CONFIGURATION_CHANGED')
      return
    }
    setReviewedCorrections((previous) => {
      const next = { ...previous }
      delete next[status.executionId]
      return next
    })
    void run(async (live) => {
      const value = await api().svcFigPluginCenter.authorizeVisualCorrection(
        figPluginDesktopVisualCorrectionAuthorizationRequestSchema.parse({
          executionId: status.executionId,
          baselineId: baseline.baselineId,
          visualEvidenceSha256: evidenceHash
        })
      )
      if (!live()) return
      if (value === null) {
        setNotice('figplugin.bridge.visualCorrectionDeclined')
      } else {
        const authorization = parseFigPluginBridgeValue(
          figPluginVisualCorrectionAuthorizationSchema,
          value
        )
        const expectedTargets = comparison.targets
          .filter((target) => target.changed)
          .map((target) => target.targetId)
          .sort()
        if (
          authorization.sourceExecutionId !== status.executionId ||
          authorization.baselineId !== baseline.baselineId ||
          authorization.visualEvidenceSha256 !== evidenceHash ||
          authorization.expiresAt <= Date.now() ||
          canonicalFigPluginJson(authorization.authorizedTargetIds) !==
            canonicalFigPluginJson(expectedTargets)
        )
          throw new FigPluginBridgeError('INVALID_REQUEST')
        setNotice('figplugin.bridge.visualCorrectionAuthorized')
      }
      if (live()) await refresh(live)
    })
  }

  const cancelVisualCorrectionAuthorization = (
    authorization: FigPluginVisualCorrectionAuthorization
  ) => {
    if (pending.current || revokePending.current) return
    void run(async (live) => {
      await api().svcFigPluginCenter.cancelVisualCorrectionAuthorization(
        figPluginDesktopVisualCorrectionAuthorizationSchema.parse({
          authorizationId: authorization.authorizationId
        })
      )
      if (live()) setNotice('figplugin.bridge.visualCorrectionCancelled')
      if (live()) await refresh(live)
    })
  }

  return (
    <Paper component="section" variant="outlined" aria-labelledby={`${id}-title`} sx={{ p: 2 }}>
      <Stack spacing={2} sx={{ overflowWrap: 'anywhere' }} aria-busy={locked}>
        <Typography id={`${id}-title`} variant="h6" component="h2">
          {t('figplugin.bridge.title')}
        </Typography>
        <Typography>{t('figplugin.bridge.description')}</Typography>
        <Alert severity="warning">{t('figplugin.bridge.secretWarning')}</Alert>
        <Typography>{t('figplugin.bridge.limits')}</Typography>
        <Typography>{t('figplugin.bridge.charges')}</Typography>
        <TextField
          id={`${id}-plugin`}
          select
          SelectProps={{ native: true }}
          label={t('figplugin.bridge.plugin')}
          value={selected ? pluginId : ''}
          disabled={locked}
          onChange={(event) => {
            if (!pending.current && !revokePending.current) setPluginId(event.target.value)
          }}
        >
          <option value="">{t('figplugin.bridge.selectPlugin')}</option>
          {candidates.map((item) => (
            <option key={item.pluginId} value={item.pluginId}>
              {t('figplugin.bridge.pluginOption', { name: item.name, id: item.pluginId })}
            </option>
          ))}
        </TextField>
        {!candidates.length && <Typography>{t('figplugin.bridge.noEligible')}</Typography>}
        <TextField
          id={`${id}-project`}
          select
          SelectProps={{ native: true }}
          label={t('figplugin.bridge.project')}
          value={project ? projectId : ''}
          disabled={locked}
          onChange={(event) => {
            if (!pending.current && !revokePending.current) setProjectId(event.target.value)
          }}
          helperText={t('figplugin.bridge.projectHelp')}
        >
          <option value="">{t('figplugin.bridge.selectProject')}</option>
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {t('figplugin.bridge.projectOption', { name: item.name, id: item.id })}
            </option>
          ))}
        </TextField>
        {selected && (
          <Box>
            <Typography>
              {t('figplugin.bridge.origin', { origin: selected.bridgeOrigin })}
            </Typography>
            <Typography>
              {t('figplugin.bridge.signer', { hash: selected.signerFingerprint })}
            </Typography>
            <Typography>
              {t('figplugin.bridge.artifact', { hash: selected.artifactSha256 })}
            </Typography>
            <Typography>
              {t('figplugin.bridge.profile', { id: selected.settings.analysisProfileId })}
            </Typography>
          </Box>
        )}
        <Stack direction="row" gap={1} flexWrap="wrap">
          <Button variant="contained" disabled={locked || !selected || !project} onClick={create}>
            {t('figplugin.bridge.createTicket')}
          </Button>
          <Button
            disabled={locked && !monitorUntil}
            onClick={() => {
              if (monitorUntil) {
                stopMonitoring()
              } else if (!pending.current && !revokePending.current) {
                startMonitoring()
                void run(async (live) => {
                  await loadModels(live)
                  if (live()) await refresh(live)
                })
              }
            }}
          >
            {t(monitorUntil ? 'figplugin.bridge.stopMonitor' : 'figplugin.bridge.enableMonitor')}
          </Button>
          <Button
            disabled={locked}
            onClick={() => {
              if (pending.current || revokePending.current) return
              setProjects(projectChoices())
              void run(async (live) => {
                await loadModels(live)
                if (live()) await refresh(live)
              })
            }}
          >
            {t('figplugin.bridge.refresh')}
          </Button>
          {selected && pairedIds.includes(selected.pluginId) && !ticket && (
            <Button disabled={revoking} onClick={() => revoke(selected.pluginId)}>
              {t('figplugin.bridge.revokeSelected')}
            </Button>
          )}
          {pairedIds
            .filter(
              (targetId) =>
                targetId !== selected?.pluginId &&
                targetId !== ticket?.pluginId &&
                !state.sessions.some((session) => session.pluginId === targetId)
            )
            .map((targetId) => (
              <Box key={targetId}>
                <Typography>{targetId}</Typography>
                <Button disabled={revoking} onClick={() => revoke(targetId)}>
                  {t('figplugin.bridge.revoke')}
                </Button>
              </Box>
            ))}
        </Stack>
        {error && <Alert severity="error">{t(error)}</Alert>}
        {notice && (
          <Alert severity="info" role="status">
            {t(notice)}
          </Alert>
        )}
        {ticket && (
          <Stack spacing={1}>
            <TextField
              id={`${id}-ticket`}
              label={t('figplugin.bridge.ticket')}
              value={JSON.stringify(ticket, null, 2)}
              multiline
              fullWidth
              minRows={4}
              maxRows={12}
              InputProps={{ readOnly: true }}
              inputProps={{ spellCheck: false, autoComplete: 'off' }}
              helperText={t('figplugin.bridge.copyHelp')}
            />
            <Button disabled={revoking} onClick={() => revoke(ticket.pluginId)}>
              {t('figplugin.bridge.revokeTicket')}
            </Button>
          </Stack>
        )}
        <Typography component="h3" variant="subtitle1">
          {t('figplugin.bridge.sessions')}
        </Typography>
        {!state.sessions.length && <Typography>{t('figplugin.bridge.noSessions')}</Typography>}
        {state.sessions.map((session) => (
          <Paper key={session.sessionId} variant="outlined" sx={{ p: 2 }}>
            <Typography>
              {t('figplugin.bridge.session', {
                plugin: session.pluginId,
                project: session.projectId,
                count: session.activeCalls
              })}
            </Typography>
            <Button disabled={revoking} onClick={() => revoke(session.pluginId)}>
              {t('figplugin.bridge.revoke')}
            </Button>
          </Paper>
        ))}
        <Typography component="h3" variant="subtitle1">
          {t('figplugin.bridge.previews')}
        </Typography>
        {!state.previews.length && <Typography>{t('figplugin.bridge.noPreviews')}</Typography>}
        {state.previews.map((call) => (
          <Paper
            key={call.callId}
            component="article"
            aria-label={t('figplugin.bridge.call', { id: call.callId })}
            variant="outlined"
            sx={{ p: 2 }}
          >
            <Stack spacing={1}>
              <Typography>
                {t('figplugin.bridge.callSource', {
                  plugin: call.pluginId,
                  host: call.host,
                  project: call.projectId
                })}
              </Typography>
              <Typography>{t('figplugin.bridge.profile', { id: call.profileId })}</Typography>
              <Typography>
                {t('figplugin.bridge.model', {
                  name: Object.hasOwn(models, call.profileId)
                    ? models[call.profileId]
                    : t('figplugin.bridge.modelUnavailable')
                })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.profileRevision', { hash: call.profileRevision })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.payloadHash', { hash: call.payloadSha256 })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.tokens', { count: call.estimatedInputTokens })}
              </Typography>
              <Typography>{t('figplugin.bridge.prompt')}</Typography>
              <Box
                component="pre"
                tabIndex={0}
                aria-label={t('figplugin.bridge.prompt')}
                sx={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', m: 0 }}
              >
                {call.prompt}
              </Box>
              <Typography>{t('figplugin.bridge.context')}</Typography>
              <Box
                component="pre"
                tabIndex={0}
                aria-label={t('figplugin.bridge.context')}
                sx={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', m: 0 }}
              >
                {JSON.stringify(call.context, null, 2)}
              </Box>
              <FormControlLabel
                label={t('figplugin.bridge.review')}
                control={
                  <Checkbox
                    disabled={locked || !canApprove(call)}
                    checked={reviewed[call.callId] === reviewKey(call)}
                    onChange={(event) => {
                      if (!pending.current && !revokePending.current)
                        setReviewed((previous) => ({
                          ...previous,
                          [call.callId]: event.target.checked ? reviewKey(call) : ''
                        }))
                    }}
                  />
                }
              />
              <Stack direction="row" gap={1}>
                <Button
                  variant="contained"
                  disabled={
                    locked || !canApprove(call) || reviewed[call.callId] !== reviewKey(call)
                  }
                  onClick={() => decide(call, true)}
                >
                  {t('figplugin.bridge.approveOnce')}
                </Button>
                <Button disabled={locked} onClick={() => decide(call, false)}>
                  {t('figplugin.bridge.deny')}
                </Button>
              </Stack>
            </Stack>
          </Paper>
        ))}
        <Typography component="h3" variant="subtitle1">
          {t('figplugin.bridge.nativePreviews')}
        </Typography>
        <Typography>{t('figplugin.bridge.nativePreviewsHelp')}</Typography>
        {!executions.previews.length && (
          <Typography>{t('figplugin.bridge.noNativePreviews')}</Typography>
        )}
        {executions.previews.map((previewEx) => (
          <Paper
            key={previewEx.executionId}
            component="article"
            aria-label={t('figplugin.bridge.nativeWrite', {
              id: previewEx.executionId
            })}
            variant="outlined"
            sx={{ p: 2 }}
          >
            <Stack spacing={1}>
              <Typography>
                {t('figplugin.bridge.callSource', {
                  plugin: previewEx.pluginId,
                  host: previewEx.host,
                  project: previewEx.projectId
                })}
              </Typography>
              <Typography>{t('figplugin.bridge.risk', { risk: previewEx.risk })}</Typography>
              <Typography>
                {t('figplugin.bridge.planHash', { hash: previewEx.planSha256 })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.contextHash', { hash: previewEx.contextSha256 })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.rollback', { mode: previewEx.rollback })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.visualAudit', { mode: previewEx.visualAudit })}
              </Typography>
              <Typography>{t('figplugin.bridge.differences')}</Typography>
              <Box
                component="pre"
                tabIndex={0}
                aria-label={t('figplugin.bridge.differences')}
                sx={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', m: 0 }}
              >
                {JSON.stringify(previewEx.differences, null, 2)}
              </Box>
              <FormControlLabel
                label={t('figplugin.bridge.reviewWrite')}
                control={
                  <Checkbox
                    disabled={locked || !canApproveExecution(previewEx)}
                    checked={
                      reviewedExecutions[previewEx.executionId] === executionReviewKey(previewEx)
                    }
                    onChange={(event) => {
                      if (!pending.current && !revokePending.current)
                        setReviewedExecutions((previous) => ({
                          ...previous,
                          [previewEx.executionId]: event.target.checked
                            ? executionReviewKey(previewEx)
                            : ''
                        }))
                    }}
                  />
                }
              />
              <Stack direction="row" gap={1}>
                <Button
                  variant="contained"
                  disabled={
                    locked ||
                    !canApproveExecution(previewEx) ||
                    reviewedExecutions[previewEx.executionId] !== executionReviewKey(previewEx)
                  }
                  onClick={() => decideExecution(previewEx, true)}
                >
                  {t('figplugin.bridge.approveWriteOnce')}
                </Button>
                <Button disabled={locked} onClick={() => decideExecution(previewEx, false)}>
                  {t('figplugin.bridge.deny')}
                </Button>
              </Stack>
            </Stack>
          </Paper>
        ))}
        <Typography component="h3" variant="subtitle1">
          {t('figplugin.bridge.executionStatuses')}
        </Typography>
        {!executions.statuses.length && (
          <Typography>{t('figplugin.bridge.noExecutionStatuses')}</Typography>
        )}
        {executions.statuses.map((executionStatus) => {
          const acceptedBaseline = executions.baselines.find(
            (baseline) => baseline.sourceExecutionId === executionStatus.executionId
          )
          const canAccept = canAcceptVisualBaseline(executionStatus)
          const evidenceHash = executionStatus.visualEvidenceSha256
          const comparison = executionStatus.visualBaselineComparison
          const activeCorrectionAuthorization = executions.correctionAuthorizations.find(
            (authorization) => authorization.baselineId === comparison?.baselineId
          )
          const canAuthorizeCorrection = canAuthorizeVisualCorrection(executionStatus)
          const correctionReview = correctionReviewKey(executionStatus)
          return (
            <Paper key={executionStatus.executionId} variant="outlined" sx={{ p: 2 }}>
              <Stack spacing={1}>
                <Typography>
                  {t('figplugin.bridge.executionStatus', {
                    state: executionStatus.state,
                    completed: executionStatus.completed,
                    total: executionStatus.total,
                    effect: executionStatus.effect
                  })}
                </Typography>
                {executionStatus.visualEvidence && (
                  <>
                    <Typography>
                      {t('figplugin.bridge.visualEvidenceSummary', {
                        count: executionStatus.visualEvidence.length,
                        changed: executionStatus.visualEvidence.filter((item) => item.changed)
                          .length
                      })}
                    </Typography>
                    {evidenceHash && (
                      <Typography>
                        {t('figplugin.bridge.visualEvidenceHash', { hash: evidenceHash })}
                      </Typography>
                    )}
                    <Box
                      component="pre"
                      tabIndex={0}
                      aria-label={t('figplugin.bridge.visualEvidenceDetails')}
                      sx={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', m: 0 }}
                    >
                      {renderVisualEvidence(executionStatus.visualEvidence)}
                    </Box>
                    <Alert severity="info">{t('figplugin.bridge.visualEvidenceBoundary')}</Alert>
                    {comparison && (
                      <>
                        <Alert severity={comparison.exactMatch ? 'success' : 'warning'}>
                          {t(
                            comparison.exactMatch
                              ? 'figplugin.bridge.visualComparisonExact'
                              : 'figplugin.bridge.visualComparisonChanged',
                            {
                              id: shortHash(comparison.baselineId),
                              changed: comparison.changedCount,
                              count: comparison.targets.length
                            }
                          )}
                        </Alert>
                        <Typography>
                          {t('figplugin.bridge.visualComparisonEvidenceHashes', {
                            baseline: comparison.baselineEvidenceSha256,
                            current: comparison.visualEvidenceSha256
                          })}
                        </Typography>
                        <Box
                          component="pre"
                          tabIndex={0}
                          aria-label={t('figplugin.bridge.visualComparisonDetails')}
                          sx={{
                            whiteSpace: 'pre-wrap',
                            maxHeight: 240,
                            overflow: 'auto',
                            m: 0
                          }}
                        >
                          {renderVisualBaselineComparison(comparison)}
                        </Box>
                        <Alert severity="info">
                          {t('figplugin.bridge.visualComparisonBoundary')}
                        </Alert>
                        {activeCorrectionAuthorization && (
                          <Alert severity="success">
                            {t('figplugin.bridge.visualCorrectionCurrent', {
                              id: shortHash(activeCorrectionAuthorization.authorizationId),
                              round: activeCorrectionAuthorization.round,
                              max: activeCorrectionAuthorization.maxCorrectionRounds
                            })}
                          </Alert>
                        )}
                        {canAuthorizeCorrection && evidenceHash && (
                          <>
                            <FormControlLabel
                              label={t('figplugin.bridge.reviewVisualCorrection')}
                              control={
                                <Checkbox
                                  disabled={locked}
                                  checked={
                                    reviewedCorrections[executionStatus.executionId] ===
                                    correctionReview
                                  }
                                  onChange={(event) => {
                                    if (!pending.current && !revokePending.current)
                                      setReviewedCorrections((previous) => ({
                                        ...previous,
                                        [executionStatus.executionId]: event.target.checked
                                          ? correctionReview
                                          : ''
                                      }))
                                  }}
                                />
                              }
                            />
                            <Button
                              variant="contained"
                              disabled={
                                locked ||
                                reviewedCorrections[executionStatus.executionId] !==
                                  correctionReview
                              }
                              onClick={() => authorizeVisualCorrection(executionStatus)}
                            >
                              {t('figplugin.bridge.authorizeVisualCorrection')}
                            </Button>
                          </>
                        )}
                      </>
                    )}
                    {canAccept && evidenceHash && (
                      <>
                        <FormControlLabel
                          label={t('figplugin.bridge.reviewVisualBaseline')}
                          control={
                            <Checkbox
                              disabled={locked}
                              checked={
                                reviewedBaselines[executionStatus.executionId] === evidenceHash
                              }
                              onChange={(event) => {
                                if (!pending.current && !revokePending.current)
                                  setReviewedBaselines((previous) => ({
                                    ...previous,
                                    [executionStatus.executionId]: event.target.checked
                                      ? evidenceHash
                                      : ''
                                  }))
                              }}
                            />
                          }
                        />
                        <Button
                          variant="contained"
                          disabled={
                            locked ||
                            reviewedBaselines[executionStatus.executionId] !== evidenceHash
                          }
                          onClick={() => acceptVisualBaseline(executionStatus)}
                        >
                          {t('figplugin.bridge.acceptVisualBaseline')}
                        </Button>
                      </>
                    )}
                    {acceptedBaseline && (
                      <Alert severity="success">
                        {t('figplugin.bridge.visualBaselineCurrent', {
                          id: shortHash(acceptedBaseline.baselineId)
                        })}
                      </Alert>
                    )}
                  </>
                )}
                {!['completed', 'cancelled', 'denied', 'failed', 'expired'].includes(
                  executionStatus.state
                ) && (
                  <Button
                    disabled={locked}
                    onClick={() => cancelExecution(executionStatus.executionId)}
                  >
                    {t('figplugin.bridge.cancelWrite')}
                  </Button>
                )}
              </Stack>
            </Paper>
          )
        })}
        <Typography component="h3" variant="subtitle1">
          {t('figplugin.bridge.visualBaselines')}
        </Typography>
        {!executions.baselines.length && (
          <Typography>{t('figplugin.bridge.noVisualBaselines')}</Typography>
        )}
        {executions.baselines.map((baseline) => (
          <Paper key={baseline.baselineId} variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={1}>
              <Typography>
                {t('figplugin.bridge.visualBaselineSummary', {
                  plugin: baseline.pluginId,
                  host: baseline.host,
                  project: baseline.projectId,
                  count: baseline.targets.length
                })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.visualBaselineHash', {
                  hash: baseline.visualEvidenceSha256
                })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.visualBaselineRounds', {
                  used: baseline.correctionRoundsUsed,
                  max: baseline.maxCorrectionRounds
                })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.visualBaselineExpires', {
                  expiry: new Date(baseline.expiresAt).toLocaleString()
                })}
              </Typography>
              <Alert severity="info">{t('figplugin.bridge.visualBaselineBoundary')}</Alert>
            </Stack>
          </Paper>
        ))}
        <Typography component="h3" variant="subtitle1">
          {t('figplugin.bridge.visualCorrectionAuthorizations')}
        </Typography>
        {!executions.correctionAuthorizations.length && (
          <Typography>{t('figplugin.bridge.noVisualCorrectionAuthorizations')}</Typography>
        )}
        {executions.correctionAuthorizations.map((authorization) => (
          <Paper key={authorization.authorizationId} variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={1}>
              <Typography>
                {t('figplugin.bridge.visualCorrectionSummary', {
                  plugin: authorization.pluginId,
                  host: authorization.host,
                  project: authorization.projectId,
                  count: authorization.authorizedTargetIds.length
                })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.visualCorrectionRound', {
                  round: authorization.round,
                  max: authorization.maxCorrectionRounds
                })}
              </Typography>
              <Typography>
                {t('figplugin.bridge.visualCorrectionHashes', {
                  baseline: authorization.baselineEvidenceSha256,
                  current: authorization.visualEvidenceSha256,
                  comparison: authorization.comparisonSha256
                })}
              </Typography>
              <Box
                component="pre"
                tabIndex={0}
                aria-label={t('figplugin.bridge.visualCorrectionTargets')}
                sx={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', m: 0 }}
              >
                {authorization.authorizedTargetIds.join('\n')}
              </Box>
              <Typography>
                {t('figplugin.bridge.visualCorrectionExpires', {
                  expiry: new Date(authorization.expiresAt).toLocaleString()
                })}
              </Typography>
              <Alert severity="info">{t('figplugin.bridge.visualCorrectionBoundary')}</Alert>
              <Button
                disabled={locked}
                onClick={() => cancelVisualCorrectionAuthorization(authorization)}
              >
                {t('figplugin.bridge.cancelVisualCorrectionAuthorization')}
              </Button>
            </Stack>
          </Paper>
        ))}
      </Stack>
    </Paper>
  )
}

export default PluginBridgePanel
