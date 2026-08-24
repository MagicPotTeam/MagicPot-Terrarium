import { Add, Delete, Science, Save } from '@mui/icons-material'
import { Button, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import type { ComfyBatchProfile, ComfyBatchProbeResult } from '@shared/api/svcComfyBatch'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const newProfile = (): ComfyBatchProfile => ({
  id: globalThis.crypto?.randomUUID?.() || `comfy-${Date.now()}`,
  name: 'ComfyUI',
  baseUrl: 'http://127.0.0.1:8188',
  enabled: true,
  maxConcurrency: 1
})

type ComfyBatchProfileEditorProps = {
  profiles: ComfyBatchProfile[]
  onProfilesChange: (profiles: ComfyBatchProfile[]) => void
  onSaved?: (profiles: ComfyBatchProfile[]) => void
  onEditingChange?: (editing: boolean) => void
  showSaveButton?: boolean
}

export default function ComfyBatchProfileEditor({
  profiles,
  onProfilesChange,
  onSaved,
  onEditingChange,
  showSaveButton = true
}: ComfyBatchProfileEditorProps) {
  const { t } = useTranslation()
  const { notifyError, notifySuccess } = useMessage()
  const [probeResults, setProbeResults] = useState<Record<string, ComfyBatchProbeResult>>({})
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const setEditingState = useCallback(
    (value: boolean) => {
      setEditing(value)
      onEditingChange?.(value)
    },
    [onEditingChange]
  )

  const updateProfile = useCallback(
    (id: string, patch: Partial<ComfyBatchProfile>) => {
      setEditingState(true)
      onProfilesChange(
        profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile))
      )
    },
    [onProfilesChange, profiles, setEditingState]
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

  const saveProfiles = useCallback(async () => {
    try {
      setSaving(true)
      const result = await api().svcComfyBatch.replaceProfiles({ profiles })
      onProfilesChange(result.profiles)
      setEditingState(false)
      onSaved?.(result.profiles)
      notifySuccess(t('qapp.batch.saved'))
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [notifyError, notifySuccess, onProfilesChange, onSaved, profiles, setEditingState, t])

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
                label={t('qapp.batch.enabled')}
              />
              <TextField
                size="small"
                label={t('qapp.batch.name')}
                value={profile.name}
                onChange={(event) => updateProfile(profile.id, { name: event.target.value })}
                sx={{ minWidth: 130 }}
              />
              <TextField
                size="small"
                label={t('qapp.batch.url')}
                value={profile.baseUrl}
                onChange={(event) => updateProfile(profile.id, { baseUrl: event.target.value })}
                sx={{ flex: 1, minWidth: 240 }}
              />
              <TextField
                size="small"
                type="number"
                label={t('qapp.batch.concurrency')}
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
                {t('qapp.batch.test')}
              </Button>
              <Button
                color="error"
                aria-label={t('qapp.batch.delete_instance')}
                onClick={() => {
                  setEditingState(true)
                  onProfilesChange(profiles.filter((candidate) => candidate.id !== profile.id))
                }}
              >
                <Delete />
              </Button>
            </Stack>
            {probe && (
              <Typography variant="caption" color={probe.ok ? 'success.main' : 'error.main'}>
                {probe.ok ? `${probe.latencyMs} ms` : probe.error}
              </Typography>
            )}
          </Stack>
        )
      })}
      <Stack direction="row" spacing={1}>
        <Button
          startIcon={<Add />}
          onClick={() => {
            setEditingState(true)
            onProfilesChange([...profiles, newProfile()])
          }}
        >
          {t('qapp.batch.add_instance')}
        </Button>
        {showSaveButton && (
          <Button
            variant="outlined"
            startIcon={<Save />}
            disabled={saving || !editing}
            onClick={() => void saveProfiles()}
          >
            {t('qapp.batch.save_instances')}
          </Button>
        )}
      </Stack>
    </Stack>
  )
}
