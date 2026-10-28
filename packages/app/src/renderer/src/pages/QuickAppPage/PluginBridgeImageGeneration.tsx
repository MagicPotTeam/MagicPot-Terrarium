import { useLayoutEffect, useRef, useState } from 'react'
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
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { api } from '@renderer/utils/windowUtils'
import { validateImportManagedMediaResp } from '@shared/api/svcManagedMedia'
import type { FigPluginBridgeDesktopState } from '@shared/figplugin/bridge'
import {
  FIGPLUGIN_IMAGE_GENERATION_MAX_MS,
  FIGPLUGIN_IMAGE_GENERATION_OPTIONS,
  figPluginImageGenerationOutputSchema,
  figPluginImageGenerationRequestSchema,
  figPluginImageGenerationStateSchema,
  type FigPluginImageGenerationKey,
  type FigPluginImageGenerationOutput,
  type FigPluginImageGenerationState
} from '@shared/figplugin/imageGeneration'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import type {
  FigPluginNativeImageGenerationDesktopProposal,
  FigPluginNativeImageGenerationDesktopKey
} from '@shared/figplugin/nativeImageGeneration'
import { figPluginManagedPathResultSchema } from '@shared/figplugin/management'
import { getProjectById } from '../MainPage/projectStore'

type Phase = FigPluginImageGenerationState['phase']
type Props = {
  session: FigPluginBridgeDesktopState['sessions'][number]
  profileId: string
  profileName?: string
  available: boolean
  disabled: boolean
  proposal?: FigPluginNativeImageGenerationDesktopProposal
  onBusyChange: (busy: boolean) => void
  onClose: () => void
}
type Operation = {
  key: FigPluginImageGenerationKey
  scope: string
  deadline: number
  alive: boolean
  accepted: boolean
  accepting: boolean
  cancelSent: boolean
  polling: boolean
  proposal?: FigPluginNativeImageGenerationDesktopKey
  jobId?: string
  interval?: ReturnType<typeof setInterval>
  timeout?: ReturnType<typeof setTimeout>
}
const sameKey = (left: FigPluginImageGenerationKey, right: FigPluginImageGenerationKey) =>
  left.sessionId === right.sessionId &&
  left.pluginId === right.pluginId &&
  left.projectId === right.projectId &&
  left.requestId === right.requestId
const clearTimers = (operation: Operation) => {
  clearInterval(operation.interval)
  clearTimeout(operation.timeout)
}
const cancelQuietly = (operation: Operation) => {
  if (operation.accepted || operation.cancelSent) return
  operation.cancelSent = true
  void Promise.resolve()
    .then(() =>
      operation.proposal
        ? api().svcFigPluginCenter.cancelNativeImageGeneration(operation.proposal)
        : api().svcFigPluginCenter.cancelSessionImageGeneration(operation.key)
    )
    .catch(() => {})
}

export default function PluginBridgeImageGeneration({
  session,
  profileId,
  profileName,
  available,
  disabled,
  proposal,
  onBusyChange,
  onClose
}: Props) {
  const { t } = useTranslation()
  const {
    state: { results },
    appendResults
  } = useComfyStatus()
  const [prompt, setPrompt] = useState('')
  const [reviewed, setReviewed] = useState('')
  const [phase, setPhase] = useState<Phase | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(false)
  const [output, setOutput] = useState<FigPluginImageGenerationOutput | null>(null)
  const [proposalConsumed, setProposalConsumed] = useState(false)
  const proposalCancelSent = useRef(false)
  const mounted = useRef(false)
  const operation = useRef<Operation | null>(null)
  const scope = canonicalFigPluginJson({
    sessionId: session.sessionId,
    pluginId: session.pluginId,
    projectId: session.projectId,
    host: session.host,
    expiresAt: session.expiresAt,
    profileId,
    profileName: profileName ?? null,
    proposal: proposal ?? null
  })
  const current = useRef({ scope, available, results, onBusyChange })
  current.current = { scope, available, results, onBusyChange }
  const trimmedPrompt = proposal?.prompt ?? prompt.trim()
  const review = canonicalFigPluginJson({
    scope,
    prompt: trimmedPrompt,
    options: FIGPLUGIN_IMAGE_GENERATION_OPTIONS
  })
  const validPrompt =
    figPluginImageGenerationRequestSchema.shape.prompt.safeParse(trimmedPrompt).success

  const finish = (item: Operation) => {
    item.alive = false
    clearTimers(item)
    if (operation.current !== item) return
    operation.current = null
    if (mounted.current) {
      setBusy(false)
      current.current.onBusyChange(false)
    }
  }
  const stop = () => {
    const item = operation.current
    if (!item) return
    cancelQuietly(item)
    finish(item)
    if (mounted.current) {
      setReviewed('')
      setPhase('cancelled')
    }
  }
  const cancelUnstartedProposal = () => {
    if (!proposal || proposalConsumed || proposalCancelSent.current) return
    proposalCancelSent.current = true
    setProposalConsumed(true)
    setReviewed('')
    setPhase('cancelled')
    void api()
      .svcFigPluginCenter.cancelNativeImageGeneration({
        proposalId: proposal.proposalId,
        payloadSha256: proposal.payloadSha256
      })
      .catch(() => {})
  }

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const item = operation.current
      if (item) {
        item.alive = false
        clearTimers(item)
        cancelQuietly(item)
        operation.current = null
      }
      current.current.onBusyChange(false)
    }
  }, [])
  useLayoutEffect(() => {
    const item = operation.current
    if (item && (!available || item.scope !== scope)) {
      item.alive = false
      clearTimers(item)
      cancelQuietly(item)
      operation.current = null
      setBusy(false)
      current.current.onBusyChange(false)
      setPhase('cancelled')
    }
    setReviewed('')
    setOutput(null)
  }, [scope, available])

  const generate = () => {
    if (
      disabled ||
      !available ||
      !getProjectById(session.projectId) ||
      !validPrompt ||
      (proposal && (proposalConsumed || proposal.expiresAt <= Date.now())) ||
      reviewed !== review ||
      operation.current ||
      Date.now() >= session.expiresAt
    )
      return
    const request = figPluginImageGenerationRequestSchema.parse({
      sessionId: session.sessionId,
      pluginId: session.pluginId,
      projectId: session.projectId,
      requestId: proposal?.generationRequestId ?? crypto.randomUUID().replaceAll('-', ''),
      prompt: trimmedPrompt
    })
    const key: FigPluginImageGenerationKey = {
      sessionId: request.sessionId,
      pluginId: request.pluginId,
      projectId: request.projectId,
      requestId: request.requestId
    }
    const item: Operation = {
      key,
      scope,
      deadline: Math.min(
        Date.now() + FIGPLUGIN_IMAGE_GENERATION_MAX_MS,
        session.expiresAt,
        proposal?.expiresAt ?? session.expiresAt
      ),
      alive: true,
      accepted: false,
      accepting: false,
      cancelSent: false,
      polling: false,
      ...(proposal
        ? {
            proposal: {
              proposalId: proposal.proposalId,
              payloadSha256: proposal.payloadSha256
            }
          }
        : {})
    }
    operation.current = item
    const live = () =>
      mounted.current &&
      item.alive &&
      operation.current === item &&
      current.current.available &&
      current.current.scope === item.scope &&
      !!getProjectById(key.projectId) &&
      Date.now() < item.deadline
    const invalid = () => {
      cancelQuietly(item)
      if (live()) {
        setFailure(true)
        setPhase('failed')
      }
      finish(item)
    }
    setBusy(true)
    if (proposal) setProposalConsumed(true)
    onBusyChange(true)
    setFailure(false)
    setOutput(null)
    setReviewed('')
    setPhase('preparing')
    item.timeout = setTimeout(
      () => {
        cancelQuietly(item)
        if (mounted.current && operation.current === item) {
          setFailure(true)
          setPhase('failed')
        }
        finish(item)
      },
      Math.max(0, item.deadline - Date.now())
    )
    item.interval = setInterval(() => {
      if (!live() || item.polling) return
      item.polling = true
      void Promise.resolve()
        .then(() => (live() ? api().svcFigPluginCenter.sessionImageGenerationState(key) : null))
        .then((value) => {
          if (!live() || value === null) return
          const status = figPluginImageGenerationStateSchema.parse(value)
          if (
            !sameKey(status, key) ||
            (item.jobId && item.jobId !== status.jobId) ||
            status.createdAt > Date.now() ||
            status.updatedAt > Date.now() ||
            status.expiresAt > session.expiresAt ||
            (proposal && status.expiresAt > proposal.expiresAt) ||
            status.expiresAt <= Date.now() ||
            (status.phase === 'accepted' && !item.accepting)
          )
            throw new Error('Invalid generation state')
          item.jobId = status.jobId
          if (status.phase !== 'accepted') setPhase(status.phase)
          if (['failed', 'declined', 'cancelled'].includes(status.phase)) {
            setFailure(status.phase === 'failed')
            cancelQuietly(item)
            finish(item)
          }
        })
        .catch(invalid)
        .finally(() => {
          item.polling = false
        })
    }, 1000)
    void (async () => {
      try {
        const value = await (item.proposal
          ? api().svcFigPluginCenter.approveNativeImageGeneration(item.proposal)
          : api().svcFigPluginCenter.generateSessionImage(request))
        if (!live()) {
          cancelQuietly(item)
          return
        }
        if (value === null) {
          setPhase('declined')
          return
        }
        const generated = figPluginImageGenerationOutputSchema.parse(value)
        validateImportManagedMediaResp({
          reference: generated.reference,
          localMediaUrl: generated.localMediaUrl
        })
        if (
          !sameKey(generated, key) ||
          generated.profileId !== profileId ||
          (item.jobId && item.jobId !== generated.jobId) ||
          generated.createdAt > Date.now() ||
          generated.expiresAt > session.expiresAt ||
          (proposal && generated.expiresAt > proposal.expiresAt) ||
          generated.expiresAt <= Date.now() ||
          current.current.results.some((result) => result.id === generated.resultId)
        )
          throw new Error('Invalid generated output')
        item.jobId = generated.jobId
        item.accepting = true
        setPhase('awaiting-acceptance')
        const accepted = figPluginManagedPathResultSchema.parse(
          await api().svcFigPluginCenter.acceptSessionImageGeneration({
            ...key,
            jobId: generated.jobId,
            resultId: generated.resultId,
            sha256: generated.reference.sha256
          })
        )
        // Acceptance makes this source independent of subsequent session cancellation.
        item.accepted = accepted.completed
        if (!live() || generated.expiresAt <= Date.now()) {
          cancelQuietly(item)
          if (live()) {
            setFailure(true)
            setPhase('failed')
          }
          return
        }
        if (
          !accepted.completed ||
          current.current.results.some((result) => result.id === generated.resultId)
        )
          throw new Error('Generation was not accepted')
        appendResults([
          {
            id: generated.resultId,
            promptId: generated.jobId,
            projectId: generated.projectId,
            type: 'image',
            fileItem: {},
            objectUrl: generated.localMediaUrl,
            media: generated.reference,
            mimeType: generated.reference.mimeType,
            sizeBytes: generated.reference.sizeBytes,
            sourceWidth: generated.width,
            sourceHeight: generated.height
          }
        ])
        setOutput(generated)
        setPhase('accepted')
      } catch {
        invalid()
      } finally {
        finish(item)
      }
    })()
  }

  return (
    <Paper
      component="section"
      aria-label={t('figplugin.bridge.generationTitle')}
      variant="outlined"
      sx={{ p: 2 }}
    >
      <Stack spacing={1.5}>
        <Typography component="h4" variant="subtitle1">
          {t('figplugin.bridge.generationTitle')}
        </Typography>
        <Alert severity="info">{t('figplugin.bridge.generationHelp')}</Alert>
        <Typography variant="body2">{t('figplugin.bridge.generationStorageHelp')}</Typography>
        <Typography>
          {t('figplugin.bridge.managedPickerTarget', {
            plugin: session.pluginId,
            host: session.host,
            project: session.projectId,
            session: session.sessionId
          })}
        </Typography>
        <Typography>
          {t('figplugin.bridge.generationProfile', {
            id: profileId,
            name: profileName ?? t('figplugin.bridge.modelUnavailable')
          })}
        </Typography>
        <Typography>{t('figplugin.bridge.generationFixedOptions')}</Typography>
        {proposal && (
          <>
            <Alert severity="info">{t('figplugin.bridge.generationProposalHelp')}</Alert>
            <Typography sx={{ overflowWrap: 'anywhere' }}>
              {t('figplugin.bridge.generationProposalIdentity', {
                id: proposal.proposalId,
                hash: proposal.payloadSha256
              })}
            </Typography>
          </>
        )}
        <Box component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {JSON.stringify(FIGPLUGIN_IMAGE_GENERATION_OPTIONS, null, 2)}
        </Box>
        <TextField
          label={t('figplugin.bridge.generationPrompt')}
          value={proposal?.prompt ?? prompt}
          multiline
          minRows={3}
          fullWidth
          disabled={busy || disabled || !available}
          inputProps={{ maxLength: 8192, readOnly: !!proposal }}
          onChange={(event) => {
            setPrompt(event.target.value)
            setReviewed('')
          }}
        />
        <Box
          component="pre"
          aria-label={t('figplugin.bridge.generationPromptPreview')}
          sx={{
            m: 0,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            maxHeight: 240,
            overflow: 'auto'
          }}
        >
          {trimmedPrompt}
        </Box>
        <FormControlLabel
          label={t('figplugin.bridge.generationReview')}
          control={
            <Checkbox
              disabled={busy || disabled || !available || !validPrompt || proposalConsumed}
              checked={reviewed === review}
              onChange={(event) => setReviewed(event.target.checked ? review : '')}
            />
          }
        />
        {!available && (
          <Alert severity="warning">{t('figplugin.bridge.generationUnavailable')}</Alert>
        )}
        {phase && (
          <Typography role="status">{t(`figplugin.bridge.generationPhases.${phase}`)}</Typography>
        )}
        {failure && <Alert severity="error">{t('figplugin.bridge.generationFailed')}</Alert>}
        {output && (
          <Stack spacing={1}>
            <Box
              component="img"
              src={output.localMediaUrl}
              alt={t('figplugin.bridge.generationOutput', { id: output.resultId })}
              referrerPolicy="no-referrer"
              sx={{ maxWidth: '100%', height: 200, objectFit: 'contain' }}
            />
            <Typography sx={{ overflowWrap: 'anywhere' }}>
              {t('figplugin.bridge.generationOutputDetails', {
                id: output.resultId,
                width: output.width,
                height: output.height,
                hash: output.reference.sha256
              })}
            </Typography>
            <Alert severity="info">{t('figplugin.bridge.generationAcceptedHelp')}</Alert>
          </Stack>
        )}
        <Stack direction="row" gap={1} flexWrap="wrap">
          <Button
            variant="contained"
            disabled={
              busy ||
              disabled ||
              !available ||
              !validPrompt ||
              reviewed !== review ||
              proposalConsumed
            }
            onClick={generate}
          >
            {t('figplugin.bridge.generationSubmit')}
          </Button>
          <Button disabled={!busy} onClick={stop}>
            {t('figplugin.bridge.generationStop')}
          </Button>
          {proposal && !proposalConsumed && (
            <Button onClick={cancelUnstartedProposal}>
              {t('figplugin.bridge.generationProposalDecline')}
            </Button>
          )}
          <Button
            onClick={() => {
              stop()
              cancelUnstartedProposal()
              onClose()
            }}
          >
            {t('figplugin.bridge.generationClose')}
          </Button>
        </Stack>
      </Stack>
    </Paper>
  )
}
