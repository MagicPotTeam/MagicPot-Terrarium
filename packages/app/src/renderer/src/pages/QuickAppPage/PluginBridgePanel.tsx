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
import { getProjectById, listProjects, PROJECTS_CHANGED_EVENT } from '../MainPage/projectStore'

type Live = () => boolean
type ProjectChoice = { id: string; name: string }
const emptyState = (): FigPluginBridgeDesktopState => ({ sessions: [], previews: [] })
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
const safeError = (error: unknown): string => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    Object.hasOwn(FIGPLUGIN_BRIDGE_ERRORS, error.code)
  )
    return error.code
  if (error instanceof Error) {
    for (const [code, message] of Object.entries(FIGPLUGIN_BRIDGE_ERRORS)) {
      if (error.message === message || error.message.endsWith(`: ${message}`)) return code
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
  const [reviewed, setReviewed] = useState<Record<string, string>>({})
  const [monitorUntil, setMonitorUntil] = useState(0)
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const locked = busy || revoking
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
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
    setReviewed({})
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
          setError(`figplugin.bridge.errors.${safeError(failure)}`)
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
    const value = await api().svcFigPluginCenter.bridgeState({})
    if (!live()) return
    const next = parseFigPluginBridgeValue(figPluginBridgeDesktopStateSchema, value)
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
    setReviewed((previous) =>
      Object.fromEntries(
        next.previews
          .filter((call) => previous[call.callId] === reviewKey(call))
          .map((call) => [call.callId, reviewKey(call)])
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
      ...state.sessions.map((session) => session.expiresAt)
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
        setReviewed({})
      },
      Math.min(2_147_483_647, Math.max(0, Math.min(...expiries) - Date.now()))
    )
    return () => clearTimeout(timer)
  }, [ticket, state])

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
        if (live()) setError(`figplugin.bridge.errors.${safeError(failure)}`)
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
      </Stack>
    </Paper>
  )
}

export default PluginBridgePanel
