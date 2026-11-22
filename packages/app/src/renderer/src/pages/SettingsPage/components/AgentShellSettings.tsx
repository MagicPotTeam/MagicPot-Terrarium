import React from 'react'
import { Alert, FormControlLabel, Stack, Switch, TextField } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { PanelProps } from '../PanelProps'

export default function AgentShellSettings({ settingsValue, saveSettings }: PanelProps) {
  const { t } = useTranslation()
  const current = settingsValue.project_trace_config
  const update = (patch: Partial<typeof current>) => saveSettings({ project_trace_config: { ...current, ...patch } })
  return <Stack spacing={1.5}>
    <Alert severity="info">{t('environment.agent_html.warning')}</Alert>
    <FormControlLabel label={t('environment.agent_html.enable')} control={<Switch checked={current.enable_agent_html_apps === true} onChange={(_, enabled) => update({ enable_agent_html_apps: enabled })} />} />
    <FormControlLabel label={t('environment.agent_html.save_enable')} control={<Switch checked={current.enable_agent_html_save === true} onChange={(_, enabled) => update({ enable_agent_html_save: enabled })} />} />
    <Alert severity="info">{t('environment.agent_html.save_warning')}</Alert>
    <Alert severity="warning">{t('environment.agent_shell.warning')}</Alert>
    <FormControlLabel label={t('environment.agent_shell.enable')} control={<Switch checked={current.enable_agent_shell === true} onChange={(_, enabled) => update({ enable_agent_shell: enabled })} />} />
    <TextField select label={t('environment.agent_shell.kind')} value={current.agent_shell_kind ?? 'powershell'} SelectProps={{ native: true }} onChange={(event) => { const kind = event.target.value; if (kind === 'bash' || kind === 'powershell') update({ agent_shell_kind: kind }) }}>
      <option value="powershell">PowerShell</option><option value="bash">Bash</option>
    </TextField>
    <TextField label={t('environment.agent_shell.executable')} value={current.agent_shell_executable ?? ''} helperText={t('environment.agent_shell.path_help')} inputProps={{ maxLength: 1024 }} onChange={(event) => update({ agent_shell_executable: event.target.value })} />
  </Stack>
}
