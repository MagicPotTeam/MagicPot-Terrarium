import { useState } from 'react'
import { Alert, Button, Checkbox, FormControlLabel, Stack, TextField } from '@mui/material'
import { sshBashConfigSchema } from '@shared/sshBashConfig'
import type { Config } from '@shared/config/config'
export default function StudioSshConfiguration({ config, onSave }: { config: Config; onSave: (value: { project_trace_config: Config['project_trace_config'] }) => Promise<void> }) {
  const [text,setText] = useState(() => JSON.stringify({ ...config.project_trace_config.agent_ssh_config, password: undefined },null,2))
  const [password,setPassword] = useState(''), [consent,setConsent] = useState(false), [busy,setBusy] = useState(false), [status,setStatus] = useState('')
  return <Stack spacing={1}>
    <Alert severity="info">SSH 配置</Alert>
    <TextField label="SSH backend JSON (host, user, optional port/key_filename/known_hosts_policy)" multiline minRows={4} value={text ?? '{}'} disabled={busy} onChange={event=>{setText(event.target.value);setConsent(false)}} />
    <TextField label="SSH password (optional; blank preserves existing)" type="password" value={password} disabled={busy} onChange={event=>{setPassword(event.target.value);setConsent(false)}} />
    <FormControlLabel label="Use SSH for approved shell.execute calls" control={<Checkbox checked={consent} disabled={busy} onChange={event=>setConsent(event.target.checked)}/>} />
    <Button disabled={!consent||busy} onClick={()=>{
      try {
        const parsed = sshBashConfigSchema.parse({ ...JSON.parse(text ?? '{}'), ...(password ? {password} : config.project_trace_config.agent_ssh_config?.password ? {password: config.project_trace_config.agent_ssh_config.password} : {}) })
        setBusy(true)
        void onSave({ project_trace_config:{ ...config.project_trace_config, enable_agent_shell:true, agent_shell_backend:'ssh', agent_ssh_config:parsed } }).then(()=>{setStatus('SSH configuration saved.');setPassword('')}).catch(()=>setStatus('Could not save SSH configuration.')).finally(()=>{setBusy(false);setConsent(false)})
      } catch { setStatus('Invalid SSH configuration.') }
    }}>Save SSH execution configuration</Button>
    {status&&<Alert severity="info">{status}</Alert>}
  </Stack>
}
