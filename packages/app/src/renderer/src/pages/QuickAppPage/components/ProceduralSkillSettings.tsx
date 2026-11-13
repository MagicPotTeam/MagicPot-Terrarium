import React, { useEffect, useState } from 'react'
import { Alert, FormControlLabel, Stack, Switch, TextField } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { isThreadSkillPattern, THREAD_SKILL_LIMITS, type ProceduralSkillOptions } from '@shared/api/agentThreadSkill'

export function ProceduralSkillSettings({ value, onChange }: { value?: ProceduralSkillOptions; onChange(value: ProceduralSkillOptions): void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState((value?.paths ?? []).join('\n'))
  useEffect(() => setDraft((value?.paths ?? []).join('\n')), [value?.paths])
  const paths = draft.split('\n').map((line) => line.trim()).filter(Boolean)
  const valid = paths.length <= THREAD_SKILL_LIMITS.patterns && paths.every(isThreadSkillPattern)
  return <Stack spacing={1}>
    <FormControlLabel label={t('custom_workshop.procedural_enable')} control={<Switch checked={value?.enabled === true} onChange={(_, enabled) => onChange({ enabled, paths: value?.paths ?? [] })} />} />
    <Alert severity="info">{t('custom_workshop.procedural_notice')}</Alert>
    <TextField label={t('custom_workshop.procedural_paths')} value={draft} multiline minRows={2} disabled={value?.enabled !== true}
      inputProps={{ maxLength: 2064 }} error={!valid} helperText={t(valid ? 'custom_workshop.procedural_paths_help' : 'custom_workshop.procedural_paths_error')}
      onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (valid) onChange({ enabled: value?.enabled === true, paths }) }} />
  </Stack>
}
