import React, { useState } from 'react'
import { Alert, Button, Card, CardContent, Stack, TextField, Typography } from '@mui/material'
import { api } from '@renderer/utils/windowUtils'
import type { AgentRouteLike } from '@shared/agent'
import type { MagicAgentPlatformSessionForkResp } from '@shared/api/svcMagicAgentPlatform'

const parseRoute = (value: string): AgentRouteLike => {
  const [channel, scopeType, ...scopeId] = value.trim().split(':')
  if (!channel || !scopeType || !scopeId.length)
    throw new Error('Route must be channel:scopeType:scopeId.')
  return {
    channel,
    scopeType: scopeType as AgentRouteLike['scopeType'],
    scopeId: scopeId.join(':')
  }
}

export const SessionForkPanel: React.FC = () => {
  const [sourceRoute, setSourceRoute] = useState('generic:dm:agent-studio')
  const [sourceEventId, setSourceEventId] = useState('')
  const [targetRoute, setTargetRoute] = useState('generic:dm:agent-studio-fork')
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [result, setResult] = useState<MagicAgentPlatformSessionForkResp>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try {
      setResult(
        await api().svcMagicAgentPlatform.forkSessionAtEvent({
          sourceRoute: parseRoute(sourceRoute),
          sourceEventId,
          targetRoute: parseRoute(targetRoute),
          idempotencyKey
        })
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6">Session Fork</Typography>
          <Alert severity="warning">
            External side effects performed before the selected event are not rolled back.
          </Alert>
          <TextField
            label="Source route"
            value={sourceRoute}
            onChange={(event) => setSourceRoute(event.target.value)}
          />
          <TextField
            label="Source event ID"
            value={sourceEventId}
            onChange={(event) => setSourceEventId(event.target.value)}
          />
          <TextField
            label="Target route"
            value={targetRoute}
            onChange={(event) => setTargetRoute(event.target.value)}
          />
          <TextField
            label="Idempotency key"
            value={idempotencyKey}
            onChange={(event) => setIdempotencyKey(event.target.value)}
          />
          <Button
            variant="contained"
            disabled={busy || !sourceEventId.trim() || !idempotencyKey.trim()}
            onClick={() => void submit()}
          >
            Fork session
          </Button>
          {error && <Alert severity="error">{error}</Alert>}
          {result && (
            <Alert severity="success">
              Target session: {result.targetSessionKey}. Messages: {result.counts.messages}; runs:{' '}
              {result.counts.runs}; events: {result.counts.events}; artifacts:{' '}
              {result.counts.artifacts}.
            </Alert>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}
