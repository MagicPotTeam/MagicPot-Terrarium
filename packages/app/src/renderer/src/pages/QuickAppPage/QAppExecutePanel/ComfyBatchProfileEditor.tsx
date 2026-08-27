import { Add, Delete, Science } from '@mui/icons-material'
import { Button, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import type { ComfyBatchProfile, ComfyBatchProbeResult } from '@shared/api/svcComfyBatch'
import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { getComfyProfileStatusLabel } from './comfyBatchProfileDisplay'
import {
  type ComfyBatchProfileProbeState,
  useComfyBatchProfileProbe
} from './comfyBatchProfileProbe'

const profileText = {
  url: 'URL',
  concurrency: 'Concurrency',
  test: 'Test',
  add: 'Add instance',
  delete: 'Delete instance'
} as const

const newProfile = (): ComfyBatchProfile => ({
  id: globalThis.crypto?.randomUUID?.() || `comfy-${Date.now()}`,
  baseUrl: 'http://127.0.0.1:8188',
  enabled: true,
  maxConcurrency: 1
})

type ComfyBatchProfileEditorProps = {
  profiles: ComfyBatchProfile[]
  onProfilesChange: (profiles: ComfyBatchProfile[]) => void
  probeResults?: Record<string, ComfyBatchProbeResult>
  isProbingAll?: boolean
  onProbeAll?: () => void | Promise<void>
  showTestButton?: boolean
}

export function ComfyBatchProfileTestButton({
  isProbingAll,
  onTest
}: Pick<ComfyBatchProfileProbeState, 'isProbingAll'> & {
  onTest: () => void | Promise<void>
}) {
  const { t } = useTranslation()

  return (
    <Button startIcon={<Science />} onClick={() => void onTest()} disabled={isProbingAll}>
      {t('qapp.batch.test', profileText.test)}
    </Button>
  )
}

export default function ComfyBatchProfileEditor({
  profiles,
  onProfilesChange,
  probeResults,
  isProbingAll,
  onProbeAll,
  showTestButton
}: ComfyBatchProfileEditorProps) {
  const { t } = useTranslation()
  const { notifyError } = useMessage()
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRevisionRef = useRef(0)
  const internalProbeState = useComfyBatchProfileProbe(profiles)
  const displayedProbeResults = probeResults ?? internalProbeState.probeResults
  const displayedIsProbingAll = isProbingAll ?? internalProbeState.isProbingAll
  const probeAll = onProbeAll ?? internalProbeState.probeAllProfiles

  const autoSaveProfiles = useCallback(
    (nextProfiles: ComfyBatchProfile[]) => {
      onProfilesChange(nextProfiles)
      saveRevisionRef.current += 1
      const revision = saveRevisionRef.current
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        void api()
          .svcComfyBatch.replaceProfiles({ profiles: nextProfiles })
          .then(({ profiles: savedProfiles }) => {
            if (revision === saveRevisionRef.current) onProfilesChange(savedProfiles)
          })
          .catch((error) => {
            if (revision === saveRevisionRef.current) {
              notifyError(error instanceof Error ? error.message : String(error))
            }
          })
      }, 250)
    },
    [notifyError, onProfilesChange]
  )

  const updateProfile = useCallback(
    (id: string, patch: Partial<ComfyBatchProfile>) => {
      autoSaveProfiles(
        profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile))
      )
    },
    [autoSaveProfiles, profiles]
  )

  return (
    <Stack spacing={1.5}>
      {showTestButton !== false ? (
        <Stack direction="row" justifyContent="flex-end">
          <ComfyBatchProfileTestButton isProbingAll={displayedIsProbingAll} onTest={probeAll} />
        </Stack>
      ) : null}
      {profiles.map((profile) => {
        const probe = displayedProbeResults[profile.id]
        return (
          <Stack key={profile.id} spacing={0.5}>
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1}
              alignItems={{ md: 'center' }}
            >
              <FormControlLabel
                control={
                  <Switch
                    checked={profile.enabled}
                    onChange={(_, enabled) => updateProfile(profile.id, { enabled })}
                  />
                }
                label={
                  <Typography
                    variant="body2"
                    color={
                      probe?.ok
                        ? 'success.main'
                        : probe?.ok === false
                          ? 'error.main'
                          : 'text.secondary'
                    }
                  >
                    {getComfyProfileStatusLabel(probe)}
                  </Typography>
                }
              />
              <Stack spacing={0.25} sx={{ flex: 1, minWidth: 240 }}>
                <TextField
                  size="small"
                  label={t('qapp.batch.url', profileText.url)}
                  value={profile.baseUrl}
                  onChange={(event) => updateProfile(profile.id, { baseUrl: event.target.value })}
                  sx={{ width: '100%' }}
                />
                {probe && !probe.ok && probe.error ? (
                  <Typography
                    role="alert"
                    variant="caption"
                    color="error.main"
                    sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                  >
                    {probe.error}
                  </Typography>
                ) : null}
              </Stack>
              <TextField
                size="small"
                type="number"
                label={t('qapp.batch.concurrency', profileText.concurrency)}
                value={profile.maxConcurrency}
                slotProps={{ htmlInput: { min: 1, max: 32 } }}
                onChange={(event) =>
                  updateProfile(profile.id, {
                    maxConcurrency: Math.max(1, Number(event.target.value) || 1)
                  })
                }
                sx={{ width: 90 }}
              />
              <Button
                color="error"
                aria-label={t('qapp.batch.delete_instance', profileText.delete)}
                onClick={() => {
                  autoSaveProfiles(profiles.filter((candidate) => candidate.id !== profile.id))
                }}
              >
                <Delete />
              </Button>
            </Stack>
          </Stack>
        )
      })}
      <Stack direction="row" spacing={1}>
        <Button
          startIcon={<Add />}
          onClick={() => {
            autoSaveProfiles([...profiles, newProfile()])
          }}
        >
          {t('qapp.batch.add_instance', profileText.add)}
        </Button>
      </Stack>
    </Stack>
  )
}
