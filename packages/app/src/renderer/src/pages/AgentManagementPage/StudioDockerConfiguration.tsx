import { dockerBashConfigSchema } from '@shared/dockerBashConfig'
import { useState } from 'react'
import { Alert, Button, Checkbox, FormControlLabel, Stack, TextField } from '@mui/material'
import type { Config } from '@shared/config/config'

export default function StudioDockerConfiguration({ config, onSave }: { config: Config; onSave: (value: { project_trace_config: Config['project_trace_config'] }) => Promise<void> }) {
  const [text, setText] = useState(() => JSON.stringify(config.project_trace_config.agent_docker_config ?? { image: 'python:3.13-slim', working_dir: '/workspace', volumes: ['{cwd}:/workspace'], env: {}, network_mode: 'bridge', auto_remove: true, name_prefix: 'kt-bash-', max_result_size_chars: 200000 }, null, 2))
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  return <Stack spacing={1}>
    <Alert severity="info">Docker 配置</Alert>
    <TextField multiline minRows={5} label="Docker backend JSON" value={text} inputProps={{ maxLength: 16384 }} disabled={busy} onChange={event => { setText(event.target.value); setConsent(false) }} />
    <FormControlLabel label="Use Docker for approved shell.execute calls" control={<Checkbox disabled={busy} checked={consent} onChange={event => setConsent(event.target.checked)} />} />
    <Button disabled={!consent || busy} onClick={() => {
      try {
        const parsed = dockerBashConfigSchema.parse(JSON.parse(text))
        setBusy(true)
        void onSave({ project_trace_config: { ...config.project_trace_config, enable_agent_shell: true, agent_shell_backend: 'docker', agent_docker_config: parsed } }).then(() => setStatus('Docker backend saved.')).catch(() => setStatus('Could not save Docker configuration.')).finally(() => { setBusy(false); setConsent(false) })
      } catch { setStatus('Invalid Docker backend JSON.') }
    }}>Save Docker execution configuration</Button>
    {status && <Alert severity="info">{status}</Alert>}
  </Stack>
}
