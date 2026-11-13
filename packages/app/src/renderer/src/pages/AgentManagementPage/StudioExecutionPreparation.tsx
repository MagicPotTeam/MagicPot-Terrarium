import { planPreparedShellInvocation } from '@shared/preparedShellInvocation'
import { createExecutionPreparation } from '@shared/executionPreparation'
import { useState } from 'react'
import { Alert, Button, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material'

/** User-entered preparation notes only; no command generation, discovery or connections. */
export default function StudioExecutionPreparation() {
  const [kind, setKind] = useState('ssh')
  const [target, setTarget] = useState('')
  const [details, setDetails] = useState({ host: '', port: '22', user: '', hostKeySha256: '', context: '', container: '', relativePath: '' })
  const [prepared, setPrepared] = useState('')
  const setDetail = (key: keyof typeof details, value: string) => { setDetails(previous => ({ ...previous, [key]: value })); setPrepared('') }
  const [reviewCode, setReviewCode] = useState('')
  const [reviewed, setReviewed] = useState(false)
  return <Paper variant="outlined" sx={{ p: 2 }}>
    <Stack spacing={1}>
      <Typography variant="subtitle1">SSH / Docker / database preparation</Typography>
      <Alert severity="info">请勿填写密钥或密码</Alert>
      <TextField select label="Preparation backend" value={kind} onChange={event => { setKind(event.target.value); setTarget(''); setReviewed(false); setPrepared('') }}>
        <MenuItem value="ssh">SSH remote shell</MenuItem><MenuItem value="docker">Docker container shell</MenuItem><MenuItem value="database">SQLite database</MenuItem>
      </TextField>
      <TextField label="Non-secret target label" value={target} inputProps={{ maxLength: 128 }} onChange={event => { setTarget(event.target.value); setReviewed(false); setPrepared('') }} />
      {kind === 'ssh' && <>
        <TextField label="SSH hostname" value={details.host} onChange={e => setDetail('host', e.target.value)} />
        <TextField label="SSH port" value={details.port} onChange={e => setDetail('port', e.target.value)} />
        <TextField label="SSH user" value={details.user} onChange={e => setDetail('user', e.target.value)} />
        <TextField label="Pinned host key SHA256" value={details.hostKeySha256} onChange={e => setDetail('hostKeySha256', e.target.value)} />
      </>}
      {kind === 'docker' && <>
        <TextField label="Docker context name" value={details.context} onChange={e => setDetail('context', e.target.value)} />
        <TextField label="Existing container name" value={details.container} onChange={e => setDetail('container', e.target.value)} />
      </>}
      {kind === 'database' && <TextField label="Workspace-relative SQLite path" value={details.relativePath} onChange={e => setDetail('relativePath', e.target.value)} />}
      {kind !== 'database' && <TextField multiline label="Optional reviewed shell text (preview only)" value={reviewCode} inputProps={{ maxLength: 6000 }} onChange={event => { setReviewCode(event.target.value); setPrepared('') }} />}
      <Button disabled={!target.trim()} onClick={() => {
        try {
          const input = kind === 'ssh' ? { backend: kind, label: target, host: details.host, port: Number(details.port), user: details.user, hostKeySha256: details.hostKeySha256 }
            : kind === 'docker' ? { backend: kind, label: target, context: details.context, container: details.container }
              : { backend: kind, label: target, relativePath: details.relativePath, mode: 'read-only' }
          setPrepared(JSON.stringify(reviewCode.trim() && kind !== 'database' ? planPreparedShellInvocation(input, reviewCode) : createExecutionPreparation(input), null, 2))
        } catch { setPrepared('Invalid preparation fields.') }
      }}>Validate offline preparation</Button>
      {prepared && <Typography component="pre" sx={{ whiteSpace: 'pre-wrap' }}>{prepared}</Typography>}
      <Button disabled={!target.trim()} onClick={() => setReviewed(true)}>Show preparation checklist</Button>
      {reviewed && <>
        <Typography>{target.trim()}</Typography>
        <Typography>{kind === 'ssh' ? '核对主机与密钥' : kind === 'docker' ? '核对容器与挂载' : '核对数据库路径'}</Typography>
      </>}
    </Stack>
  </Paper>
}
