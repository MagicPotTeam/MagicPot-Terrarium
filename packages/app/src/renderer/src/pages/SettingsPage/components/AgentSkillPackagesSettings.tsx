/* eslint-disable no-control-regex -- Refuse control bytes before a path can be registered. */
import React, { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { ProceduralSkillPackage } from '@shared/api/agentThreadSkill'
import type { PanelProps } from '../PanelProps'
import InputPath from '@renderer/components/inputs/InputPath'

const validDirectory = (value: string) => value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value) && !/^[\\/]{2}/.test(value) && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/'))
/** Registry edits only. No scan, download, copy or script execution on Save. */
export default function AgentSkillPackagesSettings({ settingsValue, saveSettings }: PanelProps) {
  const { t } = useTranslation(), configured = settingsValue.llm_config.proceduralSkillPackages
  const [draft, setDraft] = useState<ProceduralSkillPackage[]>(() => structuredClone(configured ?? [])), [saved, setSaved] = useState(false)
  const live = useRef(true), lock = useRef(false), generation = useRef(0)
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++ } }, [])
  useEffect(() => { setDraft(structuredClone(configured ?? [])); setSaved(false) }, [configured])
  const save = async () => {
    if (!valid || lock.current) return
    const owned = ++generation.current
    lock.current = true; setBusy(true); setFailed(false); setSaved(false)
    try {
      await saveSettings({ llm_config: { proceduralSkillPackages: structuredClone(draft) } })
      if (live.current && owned === generation.current) setSaved(true)
    } catch { if (live.current && owned === generation.current) setFailed(true) }
    finally { lock.current = false; if (live.current && owned === generation.current) setBusy(false) }
  }
  const update = (id: string, patch: Partial<ProceduralSkillPackage>) => { setSaved(false); setDraft(old => old.map(item => item.id === id ? { ...item, ...patch } : item)) }
  const valid = draft.length <= 16 && draft.every(item => item.directory.length <= 1024 && (!item.enabled || validDirectory(item.directory)) && (!item.projectId || /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.projectId)) && (item.source === undefined || ['directory', 'manifest'].includes(item.source)))
  return <Stack spacing={1.5} component="fieldset" disabled={busy} sx={{ border: 0, p: 0, m: 0 }}>
    <Alert severity="warning">{t('environment.agent_skill_packages.notice')}</Alert>
    {draft.map(item => <Box key={item.id} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
      <Typography variant="caption">{item.id}</Typography>
      <FormControlLabel label={t('environment.agent_skill_packages.manifest')} control={<Switch checked={item.source === 'manifest'} onChange={(_, manifest) => update(item.id, { source: manifest ? 'manifest' : 'directory', enabled: false })} />} />
      {item.source === 'manifest' && <Alert severity="info">{t('environment.agent_skill_packages.manifest_help')}</Alert>}
      <FormControlLabel label={t('environment.agent_skill_packages.enable')} control={<Switch checked={item.enabled} onChange={(_, enabled) => update(item.id, { enabled })} />} />
      <InputPath label={t('environment.agent_skill_packages.directory')} pathType="directory" placeholder={t('environment.agent_skill_packages.directory_help')} value={item.directory} onChange={directory => update(item.id, { directory })} errorText={item.enabled && !validDirectory(item.directory) ? t('environment.agent_skill_packages.invalid') : undefined} />
      <TextField size="small" fullWidth label={t('environment.agent_skill_packages.project')} helperText={t('environment.agent_skill_packages.project_help')} value={item.projectId ?? ''} inputProps={{ maxLength: 128 }} onChange={event => update(item.id, { projectId: event.target.value })} />
      <Button size="small" onClick={() => { setSaved(false); setDraft(old => old.filter(other => other.id !== item.id)) }}>{t('environment.agent_skill_packages.remove')}</Button>
    </Box>)}
    {!valid && <Alert severity="error">{t('environment.agent_skill_packages.invalid')}</Alert>}
    <Stack direction="row" spacing={1}>
      <Button disabled={draft.length >= 16} onClick={() => { setSaved(false); setDraft(old => [...old, { id: crypto.randomUUID(), directory: '', enabled: false }]) }}>{t('environment.agent_skill_packages.add')}</Button>
      <Button disabled={!valid || busy} onClick={() => void save()}>{t('environment.agent_skill_packages.save')}</Button>
    </Stack>
    {failed && <Alert severity="error">{t('environment.agent_skill_packages.failed')}</Alert>}
    {saved && <Alert severity="info">{t('environment.agent_skill_packages.submitted')}</Alert>}
  </Stack>
}
