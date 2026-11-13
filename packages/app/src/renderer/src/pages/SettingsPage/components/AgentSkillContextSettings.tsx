import React, { useEffect, useRef, useState } from 'react'
import { Alert, Button, FormControlLabel, Stack, Switch } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { PanelProps } from '../PanelProps'

/** Independent disclosure opt-ins. A registry enable alone never turns these on. */
export default function AgentSkillContextSettings({ settingsValue, saveSettings }: PanelProps) {
  const { t } = useTranslation(), configured = settingsValue.llm_config.proceduralSkillContext
  const [index, setIndex] = useState(configured?.index === true), [paths, setPaths] = useState(configured?.paths === true)
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [saved, setSaved] = useState(false)
  const lock = useRef(false), live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => { setIndex(configured?.index === true); setPaths(configured?.paths === true); setSaved(false) }, [configured?.index, configured?.paths])
  const save = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true); setFailed(false); setSaved(false)
    try {
      await saveSettings({ llm_config: { proceduralSkillContext: { index, paths } } })
      if (live.current) setSaved(true)
    } catch { if (live.current) setFailed(true) }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  return <Stack component="fieldset" disabled={busy} spacing={1} sx={{ border: 0, p: 0, m: 0 }}>
    <Alert severity="warning">{t('environment.agent_skill_context.notice')}</Alert>
    <FormControlLabel label={t('environment.agent_skill_context.index')} control={<Switch checked={index} onChange={(_, value) => { setIndex(value); setSaved(false) }} />} />
    <FormControlLabel label={t('environment.agent_skill_context.paths')} control={<Switch checked={paths} onChange={(_, value) => { setPaths(value); setSaved(false) }} />} />
    <Button disabled={busy} onClick={() => void save()}>{t('environment.agent_skill_context.save')}</Button>
    {failed && <Alert severity="error">{t('environment.agent_skill_context.failed')}</Alert>}
    {saved && <Alert severity="info">{t('environment.agent_skill_context.saved')}</Alert>}
  </Stack>
}
