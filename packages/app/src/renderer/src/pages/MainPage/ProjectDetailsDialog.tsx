import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useTranslation } from 'react-i18next'
import { api } from '../../utils/windowUtils'
import {
  PROJECT_ANALYSIS_PROFILE_ID_MAX_LENGTH,
  PROJECT_INTRODUCTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH
} from './projectStore'

export interface ProjectDetailsValues {
  name: string
  introduction: string
  analysisProfileId: string
}

export interface ProjectDetailsDialogProps {
  open: boolean
  initialValues: ProjectDetailsValues
  onClose: () => void
  onSubmit: (values: ProjectDetailsValues) => void | Promise<void>
}

type ProfileSummary = { id: string; name: string }
const CHAT_MODEL_USES = new Set(['default', 'chat', 'agent', 'multimodal', 'reasoning', 'coding'])

export default function ProjectDetailsDialog({
  open,
  initialValues,
  onClose,
  onSubmit
}: ProjectDetailsDialogProps) {
  const { t } = useTranslation()
  const [values, setValues] = useState(initialValues)
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [profileError, setProfileError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  const initialValuesRef = useRef(initialValues)
  initialValuesRef.current = initialValues

  useEffect(() => {
    const currentGeneration = ++generation.current
    if (!open) return
    setValues(initialValuesRef.current)
    setProfiles([])
    setProfileError(false)
    setSaveError(false)
    setSaving(false)
    setLoading(true)

    const load = async () => {
      try {
        const result = await api().svcLLMProxy.listProfiles({ comparisonRouting: 'configured' })
        const summaries: ProfileSummary[] = []
        const seen = new Set<string>()
        for (const profile of result.profiles) {
          if (
            !profile ||
            typeof profile.id !== 'string' ||
            !profile.id.trim() ||
            profile.id.length > PROJECT_ANALYSIS_PROFILE_ID_MAX_LENGTH ||
            seen.has(profile.id) ||
            (profile.model_use && !CHAT_MODEL_USES.has(profile.model_use))
          )
            continue
          seen.add(profile.id)
          summaries.push({
            id: profile.id,
            name: typeof profile.model_name === 'string' ? profile.model_name.slice(0, 160) : ''
          })
        }
        if (generation.current === currentGeneration) setProfiles(summaries)
      } catch {
        if (generation.current === currentGeneration) setProfileError(true)
      } finally {
        if (generation.current === currentGeneration) setLoading(false)
      }
    }
    void load()
    return () => {
      generation.current = currentGeneration + 1
    }
  }, [open])

  const nameInvalid = !values.name.trim() || values.name.length > PROJECT_NAME_MAX_LENGTH
  const introductionInvalid = values.introduction.length > PROJECT_INTRODUCTION_MAX_LENGTH
  const profileInvalid = values.analysisProfileId.length > PROJECT_ANALYSIS_PROFILE_ID_MAX_LENGTH
  const missingBinding =
    Boolean(values.analysisProfileId) &&
    !profiles.some((profile) => profile.id === values.analysisProfileId)

  const submit = async () => {
    if (saving || nameInvalid || introductionInvalid || profileInvalid) return
    const currentGeneration = generation.current
    setSaving(true)
    setSaveError(false)
    try {
      await onSubmit({ ...values, name: values.name.trim() })
      if (generation.current === currentGeneration) onClose()
    } catch {
      if (generation.current === currentGeneration) setSaveError(true)
    } finally {
      if (generation.current === currentGeneration) setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="project-details-title"
    >
      <DialogTitle id="project-details-title">
        {t('project.details.title', { defaultValue: 'Project details' })}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            autoFocus
            required
            label={t('project.details.name', { defaultValue: 'Project name' })}
            value={values.name}
            onChange={(event) => setValues({ ...values, name: event.target.value })}
            slotProps={{ htmlInput: { maxLength: PROJECT_NAME_MAX_LENGTH } }}
            error={nameInvalid}
            helperText={
              nameInvalid
                ? t('project.details.nameError', {
                    defaultValue: 'Enter a project name of 1–120 characters.'
                  })
                : undefined
            }
            disabled={saving}
          />
          <TextField
            label={t('project.details.introduction', { defaultValue: 'Introduction' })}
            value={values.introduction}
            onChange={(event) => setValues({ ...values, introduction: event.target.value })}
            multiline
            minRows={3}
            maxRows={8}
            slotProps={{ htmlInput: { maxLength: PROJECT_INTRODUCTION_MAX_LENGTH } }}
            error={introductionInvalid}
            helperText={t('project.details.introductionHint', {
              defaultValue:
                'Optional project context, up to 4,000 characters. Line breaks are preserved.'
            })}
            disabled={saving}
          />
          <TextField
            select
            label={t('project.details.model', { defaultValue: 'Analysis model' })}
            value={values.analysisProfileId}
            onChange={(event) => setValues({ ...values, analysisProfileId: event.target.value })}
            slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
            disabled={saving}
            error={profileInvalid}
            helperText={
              profileInvalid
                ? t('project.details.profileError', {
                    defaultValue: 'Choose a model reference of at most 512 characters.'
                  })
                : undefined
            }
          >
            <option value="">
              {t('project.details.noModel', { defaultValue: 'No model — configure later' })}
            </option>
            {missingBinding && (
              <option value={values.analysisProfileId}>
                {t('project.details.unavailableModel', {
                  defaultValue: 'Unavailable model: {{id}}',
                  id: values.analysisProfileId.slice(0, PROJECT_ANALYSIS_PROFILE_ID_MAX_LENGTH)
                })}
              </option>
            )}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name ? `${profile.name} (${profile.id})` : profile.id}
              </option>
            ))}
          </TextField>
          {loading && (
            <Typography role="status" variant="body2">
              {t('project.details.loadingModels', { defaultValue: 'Loading configured models…' })}
            </Typography>
          )}
          {profileError && (
            <Alert severity="warning">
              {t('project.details.modelsError', {
                defaultValue:
                  'Unable to load configured models. Close and reopen this dialog to retry.'
              })}
            </Alert>
          )}
          {!loading && missingBinding && (
            <Alert severity="warning">
              {t('project.details.missingModelNotice', {
                defaultValue:
                  'The saved model is unavailable. Its reference will be kept unless you change it. Once trace is blocked until you bind a valid model.'
              })}
            </Alert>
          )}
          {!values.analysisProfileId && (
            <Alert severity="info">
              {t('project.details.configureLater', {
                defaultValue:
                  'You can capture offline without a model. Configure one in Settings and bind it here later. Once trace is blocked until a valid model is bound.'
              })}
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary">
            {t('project.details.usageNotice', {
              defaultValue:
                'Creating or reopening a project does not run a model. Analysis is manual. When you request analysis, project content may be sent to the selected external service and use tokens or incur charges. Only the model reference is saved, never credentials.'
            })}
          </Typography>
          {saveError && (
            <Alert severity="error">
              {t('project.details.saveError', {
                defaultValue:
                  'Unable to save project details. Check local storage availability and try again.'
              })}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} color="inherit">
          {t('project.details.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={saving || nameInvalid || introductionInvalid || profileInvalid}
        >
          {t('project.details.save', { defaultValue: 'Save project' })}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
