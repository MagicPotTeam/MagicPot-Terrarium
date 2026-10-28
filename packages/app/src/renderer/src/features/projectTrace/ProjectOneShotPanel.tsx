import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Typography
} from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { LLMChatReq, LLMListProfilesResp } from '@shared/api/svcLLMProxy'
import { api } from '../../utils/windowUtils'
import { useConfig } from '../../hooks/useConfig'
import { requestProjectComparison } from './projectComparisonRequest'
import ProjectDetailsDialog from '../../pages/MainPage/ProjectDetailsDialog'
import ProjectHistoryRangeControls from './ProjectHistoryRangeControls'
import {
  ALL_PROJECT_HISTORY,
  selectProjectHistoryRange,
  type ProjectHistoryRange
} from './projectHistoryRange'
import {
  getProjectById,
  PROJECTS_CHANGED_EVENT,
  updateProjectAnalysisDetails
} from '../../pages/MainPage/projectStore'
import {
  PROJECT_TRACE_RUNTIME_EVENT,
  readRecentProjectTraceEvents,
  clearRecentProjectTraceEvents
} from './projectTraceRuntime'
import {
  buildProjectComparison,
  clearProjectComparisons,
  readProjectComparisons,
  readProjectComparisonsState,
  sanitizeProjectHistory,
  saveProjectComparison
} from './projectOneShotTrace'

const CHAT_USES = new Set(['default', 'chat', 'agent', 'multimodal', 'reasoning', 'coding'])
const TIMEOUT_MS = 120_000
const ADVICE_BYTES = 16 * 1024
const textStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const

type Comparison = ReturnType<typeof readProjectComparisons>[number]
type Profile = { id: string; name: string; budget?: number; revision?: string }
type Draft = Readonly<{
  context: string
  requestJson: string
  preview: string
  eventCount: number
  estimatedInputTokens: number
  payloadBytes: number
}>
type Attempt = { controller: AbortController; context: string }
type Notice =
  'input' | 'request' | 'response' | 'cancelled' | 'timeout' | 'save' | 'clear' | 'configuration'

function boundAdvice(value: string): string {
  let bytes = 0
  let text = ''
  const encoder = new TextEncoder()
  for (const character of value.slice(0, ADVICE_BYTES)) {
    const size = encoder.encode(character).length
    if (bytes + size > ADVICE_BYTES) break
    bytes += size
    text += character
  }
  return text
}

export default function ProjectOneShotPanel({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage || i18n.language || 'en'
  const { config } = useConfig()
  const configGeneration = useRef({ config, value: 0 })
  if (configGeneration.current.config !== config) {
    configGeneration.current = { config, value: configGeneration.current.value + 1 }
  }
  const [profileRefresh, setProfileRefresh] = useState(0)
  const [projectState, setProjectState] = useState(() => ({
    projectId,
    value: getProjectById(projectId)
  }))
  const project =
    projectState.projectId === projectId ? projectState.value : getProjectById(projectId)
  const introduction = project?.introduction || ''
  const profileId = project?.analysisProfileId || ''
  const active = useRef<Attempt | null>(null)
  const [history, setHistory] = useState(() => {
    const comparisonRead = readProjectComparisonsState(projectId)
    return {
      projectId,
      events: sanitizeProjectHistory(readRecentProjectTraceEvents(projectId)),
      results: comparisonRead.results,
      resultsUnavailable: comparisonRead.unavailable
    }
  })
  const [profiles, setProfiles] = useState<{
    scope: string
    items: Profile[]
    failed: boolean
    destination?: LLMListProfilesResp['comparisonDestination']
  }>()
  const profileScope = JSON.stringify([
    projectId,
    profileId,
    configGeneration.current.value,
    profileRefresh
  ])
  const [editing, setEditing] = useState(false)
  const [clearing, setClearing] = useState<'results' | 'events' | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [consent, setConsent] = useState(false)
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [latest, setLatest] = useState<Comparison | null>(null)
  const [pendingSave, setPendingSave] = useState<Comparison | null>(null)
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const events = history.projectId === projectId ? history.events : []
  const [rangeState, setRangeState] = useState<ProjectHistoryRange & { projectId: string }>(() => ({
    projectId,
    ...ALL_PROJECT_HISTORY
  }))
  const historyRange = rangeState.projectId === projectId ? rangeState : ALL_PROJECT_HISTORY
  const selectedHistory = selectProjectHistoryRange(events, historyRange)
  const results = history.projectId === projectId ? history.results : []
  const boundProfile =
    profiles?.scope === profileScope
      ? profiles.items.find((item) => item.id === profileId)
      : undefined
  const projectContext = JSON.stringify([
    projectId,
    Boolean(project),
    introduction,
    profileId,
    language,
    configGeneration.current.value,
    boundProfile?.revision,
    profiles?.scope === profileScope ? profiles.destination : undefined
  ])
  const context = JSON.stringify([
    projectContext,
    historyRange.startId,
    historyRange.endId,
    selectedHistory.valid
  ])
  const currentContext = useRef(context)
  currentContext.current = context
  const comparisonDestination = profiles?.scope === profileScope ? profiles.destination : undefined
  const destinationMatches = config.use_remote_llm
    ? comparisonDestination?.kind === 'remote' && Boolean(comparisonDestination.origin)
    : comparisonDestination?.kind === 'local'
  const ready = Boolean(
    project &&
    introduction.trim() &&
    boundProfile?.revision &&
    destinationMatches &&
    selectedHistory.valid
  )

  useEffect(() => {
    const refreshHistory = () => {
      const comparisonRead = readProjectComparisonsState(projectId)
      setHistory({
        projectId,
        events: sanitizeProjectHistory(readRecentProjectTraceEvents(projectId)),
        results: comparisonRead.results,
        resultsUnavailable: comparisonRead.unavailable
      })
    }
    const refreshProject = () => setProjectState({ projectId, value: getProjectById(projectId) })
    const refreshStorage = () => {
      refreshProject()
      refreshHistory()
    }
    refreshProject()
    refreshHistory()
    window.addEventListener(PROJECTS_CHANGED_EVENT, refreshProject)
    window.addEventListener(PROJECT_TRACE_RUNTIME_EVENT, refreshHistory)
    window.addEventListener('storage', refreshStorage)
    return () => {
      window.removeEventListener(PROJECTS_CHANGED_EVENT, refreshProject)
      window.removeEventListener(PROJECT_TRACE_RUNTIME_EVENT, refreshHistory)
      window.removeEventListener('storage', refreshStorage)
    }
  }, [projectId, historyRefresh])

  // Metadata lookup is not model inference. Never choose another profile implicitly.
  useEffect(() => {
    let stale = false
    setProfiles(undefined)
    const load = async () => {
      try {
        const response = await api().svcLLMProxy.listProfiles({
          includeConfigurationRevision: true,
          comparisonRouting: 'configured'
        })
        const items = response.profiles
          .filter(
            (item) =>
              item &&
              typeof item.id === 'string' &&
              item.id.trim() &&
              (!item.model_use || CHAT_USES.has(item.model_use))
          )
          .map((item) => ({
            id: item.id,
            name: typeof item.model_name === 'string' ? item.model_name.slice(0, 160) : '',
            budget: item.context_budget_tokens || item.context_window_tokens,
            revision:
              typeof item.configurationRevision === 'string' &&
              /^[a-f0-9]{64}$/.test(item.configurationRevision)
                ? item.configurationRevision
                : undefined
          }))
        if (!stale)
          setProfiles({
            scope: profileScope,
            items,
            failed: false,
            destination: response.comparisonDestination
          })
      } catch {
        if (!stale) setProfiles({ scope: profileScope, items: [], failed: true })
      }
    }
    void load()
    return () => {
      stale = true
    }
  }, [profileScope, editing])

  useLayoutEffect(() => {
    setDraft(null)
    setConsent(false)
    setRunning(false)
    setClearing(null)
    return () => {
      const attempt = active.current
      active.current = null
      attempt?.controller.abort()
    }
  }, [context])

  // Selecting the next history range invalidates consent, not advice awaiting a local save.
  useLayoutEffect(() => {
    setNotice(null)
    setLatest(null)
    setPendingSave(null)
  }, [projectContext])

  useEffect(() => {
    setEditing(false)
    setRangeState({ projectId, ...ALL_PROJECT_HISTORY })
  }, [projectId])

  const review = () => {
    if (!ready || !project || !boundProfile || active.current) return
    setConsent(false)
    setDraft(null)
    setNotice(null)
    try {
      const built = buildProjectComparison(project, selectedHistory.events, profileId, language)
      if (
        built.request.profileId !== profileId ||
        !Number.isFinite(built.estimatedInputTokens) ||
        built.estimatedInputTokens <= 0 ||
        (boundProfile.budget &&
          built.estimatedInputTokens + (built.request.maxOutputTokens || 0) > boundProfile.budget)
      ) {
        setNotice('input')
        return
      }
      const request = { ...built.request, expectedProfileRevision: boundProfile.revision }
      const payloadBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength
      const estimatedInputTokens = Math.ceil(payloadBytes / 3)
      if (
        payloadBytes > 48 * 1024 ||
        (boundProfile.budget &&
          estimatedInputTokens + (request.maxOutputTokens || 0) > boundProfile.budget)
      ) {
        setNotice('input')
        return
      }
      // Serialized primitives detach the reviewed payload from live events and helper objects.
      setDraft(
        Object.freeze({
          context,
          requestJson: JSON.stringify(request),
          preview: built.preview,
          eventCount: built.eventCount,
          estimatedInputTokens,
          payloadBytes
        })
      )
    } catch {
      setNotice('input')
    }
  }

  const cancel = () => {
    const attempt = active.current
    active.current = null
    attempt?.controller.abort()
    setRunning(false)
    setConsent(false)
    setDraft(null)
    setNotice('cancelled')
  }

  const run = async () => {
    if (active.current || !ready || !consent || !draft || draft.context !== context) return
    const matchesProject = (value: ReturnType<typeof getProjectById>) =>
      Boolean(
        value &&
        value.introduction === project?.introduction &&
        value.analysisProfileId === profileId
      )
    const currentProject = getProjectById(projectId)
    if (!matchesProject(currentProject)) {
      setProjectState({ projectId, value: currentProject })
      setConsent(false)
      setDraft(null)
      return
    }
    const attempt: Attempt = { controller: new AbortController(), context }
    active.current = attempt
    setRunning(true)
    setConsent(false)
    setDraft(null)
    setNotice(null)
    setLatest(null)
    setPendingSave(null)
    let timedOut = false
    const timer = window.setTimeout(() => {
      timedOut = true
      attempt.controller.abort()
    }, TIMEOUT_MS)
    let onAbort: () => void = () => undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('ABORTED'))
      attempt.controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const isCurrent = () => active.current === attempt && currentContext.current === attempt.context
    try {
      const request = JSON.parse(draft.requestJson) as LLMChatReq
      const response = await Promise.race([
        requestProjectComparison(request, attempt.controller.signal, api().svcLLMProxy),
        aborted
      ])
      if (!isCurrent() || attempt.controller.signal.aborted) return
      // A store event and a reply can land before React commits the refreshed context.
      const replyProject = getProjectById(projectId)
      if (!matchesProject(replyProject)) {
        attempt.controller.abort()
        setProjectState({ projectId, value: replyProject })
        return
      }
      if (
        typeof response.content !== 'string' ||
        !response.content.trim() ||
        response.finishReason === 'error' ||
        response.finishReason === 'cancelled' ||
        response.finishReason === 'tool_call'
      ) {
        setNotice('response')
        return
      }
      const actualTotalTokens = response.usage?.totalTokens
      const result: Comparison = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        profileId,
        eventCount: draft.eventCount,
        advice: boundAdvice(response.content),
        estimatedInputTokens: draft.estimatedInputTokens,
        ...(typeof actualTotalTokens === 'number' &&
        Number.isSafeInteger(actualTotalTokens) &&
        actualTotalTokens >= 0
          ? { actualTotalTokens }
          : {})
      }
      try {
        const saved: unknown = saveProjectComparison(projectId, result)
        if (saved === false) throw new Error('SAVE_FAILED')
        const savedResults = readProjectComparisonsState(projectId)
        const persisted = savedResults.results.find((item) => item.id === result.id)
        if (savedResults.unavailable || !persisted) throw new Error('SAVE_NOT_VERIFIED')
        setHistory((previous) => ({
          ...previous,
          results: savedResults.results,
          resultsUnavailable: savedResults.unavailable
        }))
        setLatest(persisted)
        setPendingSave(null)
      } catch {
        setLatest(result)
        setPendingSave(result)
        setNotice('save')
      }
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : ''
        const changed = message.endsWith('Model configuration changed; review and confirm again.')
        setNotice(timedOut ? 'timeout' : changed ? 'configuration' : 'request')
      }
    } finally {
      window.clearTimeout(timer)
      attempt.controller.signal.removeEventListener('abort', onAbort)
      if (isCurrent()) {
        active.current = null
        setRunning(false)
      }
    }
  }

  const retrySave = () => {
    const result = pendingSave
    if (!result || running || active.current) return
    try {
      const saved: unknown = saveProjectComparison(projectId, result)
      if (saved === false) throw new Error('SAVE_FAILED')
      const savedResults = readProjectComparisonsState(projectId)
      const persisted = savedResults.results.find((item) => item.id === result.id)
      if (savedResults.unavailable || !persisted) throw new Error('SAVE_NOT_VERIFIED')
      setHistory((previous) => ({
        ...previous,
        results: savedResults.results,
        resultsUnavailable: savedResults.unavailable
      }))
      setLatest(persisted)
      setPendingSave(null)
      setNotice(null)
    } catch {
      setNotice('save')
    }
  }

  const retryHistoryRead = () => {
    if (running) return
    setHistoryRefresh((value) => value + 1)
  }

  const clearResults = () => {
    if (active.current) return
    try {
      if (clearing === 'events') {
        clearRecentProjectTraceEvents(projectId)
        setHistory((previous) => ({ ...previous, events: readRecentProjectTraceEvents(projectId) }))
        setDraft(null)
        setConsent(false)
      } else {
        const cleared: unknown = clearProjectComparisons(projectId)
        if (cleared === false) throw new Error('CLEAR_FAILED')
        setHistory((previous) => {
          const comparisonRead = readProjectComparisonsState(projectId)
          return {
            ...previous,
            results: comparisonRead.results,
            resultsUnavailable: comparisonRead.unavailable
          }
        })
        setLatest(null)
      }
      setNotice(null)
      setClearing(null)
    } catch {
      setNotice('clear')
      setClearing(null)
    }
  }

  const notices: Record<Notice, string> = {
    configuration: t('project.once.configurationChanged', {
      defaultValue:
        'Model configuration changed. Refresh model metadata, then review and confirm again. Nothing was sent using the changed configuration.'
    }),
    input: t('project.once.inputError', {
      defaultValue:
        'INPUT_INVALID: Unable to build a safe preview within the input budget. Nothing was sent.'
    }),
    request: t('project.once.requestError', {
      defaultValue:
        'REQUEST_FAILED: The request failed. No automatic retry or model substitution was made.'
    }),
    response: t('project.once.responseError', {
      defaultValue:
        'INVALID_RESPONSE: No usable text advice was returned. No automatic retry was made.'
    }),
    cancelled: t('project.once.cancelled', {
      defaultValue:
        'CANCELLED: Late replies are ignored. The remote service may still run and charge tokens.'
    }),
    timeout: t('project.once.timeout', {
      defaultValue:
        'TIMEOUT: Stopped waiting after 120 seconds. The remote service may still run and charge tokens.'
    }),
    save: t('project.once.saveError', {
      defaultValue:
        'SAVE_FAILED: Advice is shown only in this session; local history could not be saved. Check storage space.'
    }),
    clear: t('project.once.clearError', {
      defaultValue: 'CLEAR_FAILED: Local comparison history could not be cleared.'
    })
  }

  const resultView = (result: Comparison) => (
    <Box key={result.id} sx={{ overflowWrap: 'anywhere' }}>
      <Typography variant="caption">
        {t('project.once.resultMeta', {
          defaultValue:
            '{{at}} · Model: {{profileId}} · Events: {{count}} · Estimated input tokens: {{estimate}}',
          at: result.at,
          profileId: result.profileId,
          count: result.eventCount,
          estimate: result.estimatedInputTokens
        })}
      </Typography>
      {result.actualTotalTokens !== undefined && (
        <Typography variant="caption" component="div">
          {t('project.once.actualTokens', {
            defaultValue: 'Reported total tokens: {{count}}',
            count: result.actualTotalTokens
          })}
        </Typography>
      )}
      <Typography sx={textStyle}>{result.advice}</Typography>
    </Box>
  )

  return (
    <Stack spacing={2}>
      <Typography variant="h6">
        {t('project.once.title', { defaultValue: 'Once trace' })}
      </Typography>
      <ProjectHistoryRangeControls
        events={events}
        value={historyRange}
        selectedCount={selectedHistory.events.length}
        valid={selectedHistory.valid}
        disabled={running}
        onChange={(value) => setRangeState({ projectId, ...value })}
      />
      <Typography sx={textStyle}>
        {introduction ||
          t('project.once.missingIntroduction', {
            defaultValue: 'Add a project introduction before requesting advice.'
          })}
      </Typography>
      <Typography sx={{ overflowWrap: 'anywhere' }}>
        {t('project.once.boundModel', {
          defaultValue: 'Bound model: {{model}}',
          model: boundProfile?.name ? `${boundProfile.name} (${profileId})` : profileId || '—'
        })}
      </Typography>
      <Button onClick={() => setEditing(true)} disabled={!project || running}>
        {t('project.once.editDetails', { defaultValue: 'Edit introduction and model binding' })}
      </Button>
      <Typography variant="caption">
        {t('project.once.detailsOnly', {
          defaultValue:
            'Only the introduction and model binding are saved here; the project name is unchanged.'
        })}
      </Typography>
      {!project && (
        <Alert severity="warning">
          {t('project.once.missingProject', { defaultValue: 'This project is unavailable.' })}
        </Alert>
      )}
      {profiles?.scope !== profileScope ? (
        <Typography role="status">
          {t('project.once.loadingModels', { defaultValue: 'Loading model metadata…' })}
        </Typography>
      ) : !boundProfile ? (
        <Alert severity="warning">
          {profiles.failed
            ? t('project.once.modelsError', {
                defaultValue:
                  'MODEL_METADATA_FAILED: Unable to verify the bound model. Nothing will be sent.'
              })
            : t('project.once.missingModel', {
                defaultValue:
                  'Bind an available chat-capable model. Missing or unsupported bindings cannot run; no fallback is used.'
              })}
        </Alert>
      ) : null}
      {boundProfile && (!boundProfile.revision || !destinationMatches) ? (
        <Alert severity="warning">
          {t('project.once.noRevision', {
            defaultValue:
              'The model service cannot pin the reviewed configuration. Analysis is unavailable until it supplies a valid revision.'
          })}
        </Alert>
      ) : null}
      {comparisonDestination?.kind === 'remote' ? (
        <Alert severity="info">
          {t('project.once.remoteDestination', {
            defaultValue:
              'Remote comparison server: {{origin}}. The approved snapshot is sent to this server, which may forward it to the selected model provider. Both client and server configurations must still match the reviewed versions.',
            origin: comparisonDestination.origin
          })}
        </Alert>
      ) : null}
      <Button
        disabled={running}
        onClick={() => {
          setDraft(null)
          setConsent(false)
          setProfileRefresh((value) => value + 1)
        }}
      >
        {t('project.once.refreshModels', { defaultValue: 'Refresh model metadata' })}
      </Button>
      <Typography variant="body2">
        {t('project.once.limitations', {
          defaultValue:
            'Local history covers only the last 120 events within 30 days, including canvas, agent, QApp and target operations. It is incomplete metadata, not full prompts, files or an audit log.'
        })}
      </Typography>
      <Typography variant="subtitle2">
        {t('project.once.eventCount', {
          defaultValue: 'Recent local events: {{count}}',
          count: events.length
        })}
      </Typography>
      <Box sx={{ maxHeight: 240, overflow: 'auto' }}>
        <Typography component="pre" variant="body2" sx={{ ...textStyle, m: 0 }}>
          {JSON.stringify(events, null, 2)}
        </Typography>
      </Box>
      <Button onClick={review} disabled={!ready || running}>
        {t('project.once.review', { defaultValue: 'Review payload' })}
      </Button>
      {draft && draft.context === context && (
        <Stack spacing={1}>
          <Typography variant="subtitle2">
            {t('project.once.preview', { defaultValue: 'Fixed payload preview' })}
          </Typography>
          <Typography variant="body2">
            {t('project.once.estimate', {
              defaultValue:
                '{{count}} events · Estimated input: {{tokens}} tokens · {{bytes}} bytes. Estimates are not billing totals; output tokens may also be charged.',
              count: draft.eventCount,
              tokens: draft.estimatedInputTokens,
              bytes: draft.payloadBytes
            })}
          </Typography>
          <Typography
            component="pre"
            variant="body2"
            sx={{ ...textStyle, maxHeight: 320, overflow: 'auto' }}
          >
            {draft.preview}
          </Typography>
          <FormControlLabel
            control={
              <Checkbox checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            }
            label={t('project.once.consent', {
              defaultValue:
                'I reviewed this fixed snapshot and agree to send the introduction and redacted event metadata to {{model}}. This uses tokens and may incur charges. New events are not included unless I review again.',
              model: profileId
            })}
          />
        </Stack>
      )}
      <Stack direction="row" spacing={1}>
        <Button
          variant="contained"
          onClick={() => void run()}
          disabled={!ready || !draft || !consent || running}
        >
          {t('project.once.run', { defaultValue: 'Once trace' })}
        </Button>
        {running && (
          <Button onClick={cancel}>
            {t('project.once.cancel', { defaultValue: 'Cancel request' })}
          </Button>
        )}
      </Stack>
      <Typography variant="caption">
        {t('project.once.costNotice', {
          defaultValue:
            'One manual request only; no automatic retry, substitution or tool execution. Cancelling, leaving, or changing project details stops waiting, but remote processing and charges may continue.'
        })}
      </Typography>
      {notice && <Alert severity="warning">{notices[notice]}</Alert>}
      {pendingSave && (
        <Button onClick={retrySave} disabled={running}>
          {t('project.once.retrySave', { defaultValue: 'Retry saving this advice' })}
        </Button>
      )}
      {latest && (
        <Box>
          <Typography variant="subtitle2">
            {t('project.once.latest', { defaultValue: 'Latest advice' })}
          </Typography>
          {resultView(latest)}
        </Box>
      )}
      <Typography variant="subtitle2">
        {history.resultsUnavailable
          ? t('project.once.historyUnavailableTitle', {
              defaultValue: 'Saved comparison history unavailable'
            })
          : t('project.once.history', {
              defaultValue: 'Saved comparison history ({{count}})',
              count: results.length
            })}
      </Typography>
      {history.resultsUnavailable && (
        <Alert severity="warning">
          {t('project.once.historyUnavailable', {
            defaultValue:
              'HISTORY_UNAVAILABLE: Saved comparison history could not be read. It is not being treated as empty, and no existing records were overwritten.'
          })}
          <Box sx={{ mt: 1 }}>
            <Button onClick={retryHistoryRead} disabled={running}>
              {t('project.once.retryHistoryRead', { defaultValue: 'Retry reading history' })}
            </Button>
          </Box>
        </Alert>
      )}
      {results.map(resultView)}
      <Button onClick={() => setClearing('events')} disabled={running || events.length === 0}>
        {t('project.once.clearEvents', { defaultValue: 'Clear recent operation events' })}
      </Button>
      <Button
        onClick={() => setClearing('results')}
        disabled={running || history.resultsUnavailable || results.length === 0}
      >
        {t('project.once.clearResults', { defaultValue: 'Clear comparison results' })}
      </Button>
      <Dialog
        open={clearing !== null}
        onClose={() => setClearing(null)}
        aria-labelledby="clear-comparisons-title"
      >
        <DialogTitle id="clear-comparisons-title">
          {clearing === 'events'
            ? t('project.once.clearEventsTitle', {
                defaultValue: 'Clear recent local operation events?'
              })
            : t('project.once.clearTitle', { defaultValue: 'Clear local comparison history?' })}
        </DialogTitle>
        <DialogContent>
          {clearing === 'events'
            ? t('project.once.clearEventsNotice', {
                defaultValue:
                  'Delete only recent operation summaries for this project. Saved comparisons, trace documents and project details are kept. New operations will still be recorded locally.'
              })
            : t('project.once.clearNotice', {
                defaultValue:
                  'This deletes saved comparison advice for this project only. Recent operation events and project details are not deleted.'
              })}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClearing(null)}>
            {t('project.once.keepResults', { defaultValue: 'Keep results' })}
          </Button>
          <Button color="error" onClick={clearResults} disabled={running}>
            {clearing === 'events'
              ? t('project.once.confirmClearEvents', { defaultValue: 'Delete recent events' })
              : t('project.once.confirmClear', { defaultValue: 'Delete comparison history' })}
          </Button>
        </DialogActions>
      </Dialog>
      {project && editing && (
        <ProjectDetailsDialog
          open
          initialValues={{ name: project.name, introduction, analysisProfileId: profileId }}
          onClose={() => setEditing(false)}
          onSubmit={(values) => {
            updateProjectAnalysisDetails(projectId, {
              introduction: values.introduction,
              analysisProfileId: values.analysisProfileId
            })
            setProjectState({ projectId, value: getProjectById(projectId) })
          }}
        />
      )}
    </Stack>
  )
}
