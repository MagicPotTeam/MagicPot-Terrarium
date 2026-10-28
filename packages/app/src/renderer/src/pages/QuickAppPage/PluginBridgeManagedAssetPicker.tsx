import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography
} from '@mui/material'
import { useTranslation } from 'react-i18next'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import type { FigPluginBridgeDesktopState } from '@shared/figplugin/bridge'
import { FIGPLUGIN_ASSET_MAX_EDGE, FIGPLUGIN_ASSET_MAX_PIXELS } from '@shared/figplugin/hostAssets'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import {
  managedOutputChoices,
  type ManagedOutputChoice,
  type ManagedOutputSelection
} from './pluginBridgeManagedAssets'

type Choice = ManagedOutputChoice & { key: string }
type Selection = { choice: Choice; target: string }
type Props = {
  session: FigPluginBridgeDesktopState['sessions'][number]
  available: boolean
  disabled: boolean
  onShare: (selection: ManagedOutputSelection) => void
  onClose: () => void
}

export default function PluginBridgeManagedAssetPicker({
  session,
  available,
  disabled,
  onShare,
  onClose
}: Props) {
  const { t } = useTranslation()
  const id = useId()
  const {
    state: { results }
  } = useComfyStatus()
  const recordIds = useRef(new WeakMap<object, number>())
  const nextRecordId = useRef(0)
  const choices = useMemo(
    () =>
      managedOutputChoices(results, session.projectId).map((choice) => {
        let recordId = recordIds.current.get(choice.result)
        if (recordId === undefined) {
          recordId = ++nextRecordId.current
          recordIds.current.set(choice.result, recordId)
        }
        return { ...choice, key: `${recordId}:${choice.identity}` }
      }),
    [results, session.projectId]
  )
  const [selected, setSelected] = useState<Selection | null>(null)
  const [loads, setLoads] = useState<Record<string, 'ready' | 'failed'>>({})
  const loadState = useRef(loads)
  loadState.current = loads
  const lifetime = useRef<object | null>(null)
  const currentTarget = useRef('')
  currentTarget.current = canonicalFigPluginJson({
    sessionId: session.sessionId,
    pluginId: session.pluginId,
    projectId: session.projectId,
    host: session.host,
    expiresAt: session.expiresAt
  })
  const currentChoices = useRef(choices)
  currentChoices.current = choices
  const allowed = useRef(available)
  allowed.current = available
  const selection =
    available &&
    selected &&
    selected.target === currentTarget.current &&
    choices.some(
      (choice) => choice.key === selected.choice.key && choice.result === selected.choice.result
    )
      ? selected
      : null
  const currentSelection = useRef(selection)
  currentSelection.current = selection

  useLayoutEffect(() => {
    const token = {}
    lifetime.current = token
    return () => {
      if (lifetime.current === token) lifetime.current = null
    }
  }, [])
  useLayoutEffect(() => {
    if (selected && !selection) setSelected(null)
  }, [selected, selection])
  useLayoutEffect(() => {
    const active = new Set(choices.map((choice) => choice.key))
    setLoads((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => active.has(key)))
    )
  }, [choices])

  const recordLoad = (choice: Choice, ready: boolean) => {
    if (
      !currentChoices.current.some(
        (item) => item.key === choice.key && item.result === choice.result
      )
    )
      return
    const next = {
      ...loadState.current,
      [choice.key]: ready ? ('ready' as const) : ('failed' as const)
    }
    loadState.current = next
    setLoads(next)
    if (!ready && currentSelection.current?.choice.key === choice.key) {
      currentSelection.current = null
      setSelected(null)
    }
  }
  const share = () => {
    const chosen = currentSelection.current
    const life = lifetime.current
    const target = currentTarget.current
    if (disabled || !chosen || !life) return
    const isCurrent = () =>
      lifetime.current === life &&
      allowed.current &&
      currentTarget.current === target &&
      Date.now() < session.expiresAt &&
      currentSelection.current === chosen &&
      loadState.current[chosen.choice.key] === 'ready' &&
      currentChoices.current.some(
        (choice) => choice.key === chosen.choice.key && choice.result === chosen.choice.result
      )
    if (isCurrent()) onShare({ reference: chosen.choice.reference, isCurrent })
  }
  const close = () => {
    currentSelection.current = null
    setSelected(null)
    onClose()
  }

  return (
    <Paper
      component="section"
      aria-label={t('figplugin.bridge.managedPickerTitle')}
      variant="outlined"
      sx={{ p: 2 }}
    >
      <Stack spacing={1.5}>
        <Typography component="h4" variant="subtitle1">
          {t('figplugin.bridge.managedPickerTitle')}
        </Typography>
        <Alert severity="info">{t('figplugin.bridge.managedPickerHelp')}</Alert>
        <Typography>
          {t('figplugin.bridge.managedPickerTarget', {
            plugin: session.pluginId,
            host: session.host,
            project: session.projectId,
            session: session.sessionId
          })}
        </Typography>
        {!choices.length && <Typography>{t('figplugin.bridge.managedPickerEmpty')}</Typography>}
        <RadioGroup
          name={id}
          value={selection?.choice.key ?? ''}
          aria-label={t('figplugin.bridge.managedPickerChoices')}
          onChange={(_event, key) => {
            if (disabled || !available) return
            const choice = currentChoices.current.find((item) => item.key === key)
            if (choice && loadState.current[key] !== 'failed')
              setSelected({ choice, target: currentTarget.current })
          }}
        >
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
              gap: 1
            }}
          >
            {choices.map((choice) => (
              <Paper
                key={choice.key}
                component="article"
                aria-label={t('figplugin.bridge.managedOutput', { result: choice.result.id })}
                variant="outlined"
                sx={{ p: 1.5, overflowWrap: 'anywhere' }}
              >
                <Stack spacing={1}>
                  <Box
                    component="img"
                    src={choice.localMediaUrl}
                    alt={t('figplugin.bridge.managedThumbnail', { result: choice.result.id })}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    sx={{ width: '100%', height: 160, objectFit: 'contain' }}
                    onLoad={(event) => {
                      const { naturalWidth: width, naturalHeight: height } = event.currentTarget
                      recordLoad(
                        choice,
                        width > 0 &&
                          height > 0 &&
                          width <= FIGPLUGIN_ASSET_MAX_EDGE &&
                          height <= FIGPLUGIN_ASSET_MAX_EDGE &&
                          width * height <= FIGPLUGIN_ASSET_MAX_PIXELS
                      )
                    }}
                    onError={() => recordLoad(choice, false)}
                  />
                  <FormControlLabel
                    value={choice.key}
                    control={
                      <Radio disabled={disabled || !available || loads[choice.key] === 'failed'} />
                    }
                    label={t('figplugin.bridge.managedOutputIdentity', {
                      result: choice.result.id,
                      task: choice.result.promptId
                    })}
                  />
                  <Typography>
                    {t('figplugin.bridge.managedOutputMetadata', {
                      mime: choice.reference.mimeType,
                      bytes: choice.reference.sizeBytes
                    })}
                  </Typography>
                  <Typography>
                    {t('figplugin.bridge.assetHash', { hash: choice.reference.sha256 })}
                  </Typography>
                  {loads[choice.key] === 'failed' && (
                    <Alert severity="warning">{t('figplugin.bridge.managedThumbnailFailed')}</Alert>
                  )}
                </Stack>
              </Paper>
            ))}
          </Box>
        </RadioGroup>
        <Stack direction="row" gap={1} flexWrap="wrap">
          <Button
            variant="contained"
            disabled={disabled || !selection || loads[selection.choice.key] !== 'ready'}
            onClick={share}
          >
            {t('figplugin.bridge.shareManagedPreview')}
          </Button>
          <Button onClick={close}>{t('figplugin.bridge.closeManagedPicker')}</Button>
        </Stack>
      </Stack>
    </Paper>
  )
}
