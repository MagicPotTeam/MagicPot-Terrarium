import { Add, Delete, Science } from '@mui/icons-material'
import { Button, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import type { ComfyBatchProfile, ComfyBatchProbeResult } from '@shared/api/svcComfyBatch'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getComfyProfileStatusLabel } from './comfyBatchProfileDisplay'

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
}

export default function ComfyBatchProfileEditor({
  profiles,
  onProfilesChange
}: ComfyBatchProfileEditorProps) {
  const { t } = useTranslation()
  const { notifyError } = useMessage()
  const [probeResults, setProbeResults] = useState<Record<string, ComfyBatchProbeResult>>({})
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRevisionRef = useRef(0)

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

  const probeProfile = useCallback(async (profile: ComfyBatchProfile) => {
    try {
      const result = await api().svcComfyBatch.probeProfile({ baseUrl: profile.baseUrl })
      setProbeResults((current) => ({ ...current, [profile.id]: result.result }))
    } catch (error) {
      setProbeResults((current) => ({
        ...current,
        [profile.id]: {
          ok: false,
          baseUrl: profile.baseUrl,
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error)
        }
      }))
    }
  }, [])

  useEffect(() => {
    setProbeResults((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => profiles.some((p) => p.id === id))
      )
    )
  }, [profiles])

  return (
    <Stack spacing={1.5}>
      {profiles.map((profile) => {
        const probe = probeResults[profile.id]
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
                  <Typography variant="body2" color={probe?.ok ? 'success.main' : 'error.main'}>
                    {getComfyProfileStatusLabel(probe)}
                  </Typography>
                }
              />
              <TextField
                size="small"
                label={t('qapp.batch.url', profileText.url)}
                value={profile.baseUrl}
                onChange={(event) => updateProfile(profile.id, { baseUrl: event.target.value })}
                sx={{ flex: 1, minWidth: 240 }}
              />
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
              <Button startIcon={<Science />} onClick={() => void probeProfile(profile)}>
                {t('qapp.batch.test', profileText.test)}
              </Button>
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
