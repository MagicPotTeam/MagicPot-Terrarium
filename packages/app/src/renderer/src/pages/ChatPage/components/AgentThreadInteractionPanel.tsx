import React, { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentRouteLike } from '@shared/agent'
import {
  AGENT_THREAD_INTERACTION_LIMITS as LIMITS,
  type AgentThreadInteraction,
  type AgentThreadInteractionAnswer
} from '@shared/api/agentThreadInteraction'
import { formatToolCallValue, formatToolCardField, getToolCardAccent, getToolCardActionStyle, getToolCardIcon } from '../chatToolCallDisplay'
import AgentThreadAppDisplay from './AgentThreadAppDisplay'
import AgentThreadCardBody from './AgentThreadCardBody'
import { api } from '../../../utils/windowUtils'

function InteractionForm({ item, onResolve }: {
  item: AgentThreadInteraction
  onResolve(answer: AgentThreadInteractionAnswer): Promise<void>
}) {
  const { t } = useTranslation()
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [expired, setExpired] = useState(Date.now() >= item.expiresAt)
  const sending = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const timer = setTimeout(() => setExpired(true), Math.max(0, item.expiresAt - Date.now()))
    return () => { mounted.current = false; clearTimeout(timer) }
  }, [item.expiresAt])
  const resolve = async (value: AgentThreadInteractionAnswer) => {
    if (sending.current || Date.now() >= item.expiresAt) return
    sending.current = true
    setBusy(true)
    setError(false)
    try {
      await onResolve(value)
    } catch {
      if (mounted.current) setError(true)
    } finally {
      sending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const prompt = item.prompt
  if (prompt.kind === 'show_app') return <AgentThreadAppDisplay document={prompt.document} expiresAt={item.expiresAt} onResolve={onResolve} />
  const disabled = busy || expired
  const cardAccent = prompt.kind === 'show_card' ? getToolCardAccent(prompt.accent) : undefined
  const cardIcon = prompt.kind === 'show_card' && Object.hasOwn(prompt, 'icon') ? getToolCardIcon(prompt.icon) : undefined
  return (
    <Box role="region" aria-label={t('chat.agent_interaction.title')} sx={{ mx: 2, mb: 1, p: 1.5, border: '1px solid', borderColor: cardAccent?.borderColor ?? 'divider', borderRadius: 2, maxHeight: 360, overflow: 'auto', flexShrink: 0 }}>
      <Typography variant="caption" color="text.secondary">{t('chat.agent_interaction.notice')}</Typography>
      <Typography sx={{ mt: 0.5, color: cardAccent?.headerColor, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {cardIcon !== undefined ? <Box component="span" aria-hidden="true" sx={{ mr: 0.5 }}>{cardIcon}</Box> : null}
        {prompt.kind === 'ask_user' ? prompt.question : prompt.title}
      </Typography>
      {prompt.kind === 'show_card' && prompt.subtitle !== undefined ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{formatToolCallValue(prompt.subtitle).text}</Typography> : null}
      {prompt.kind === 'show_card' && prompt.body ? <AgentThreadCardBody body={prompt.body} /> : null}
      {prompt.kind === 'show_card' && prompt.fields ? <Box sx={{ display: 'grid', gridTemplateColumns: prompt.fields.some(field => field.inline) ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)', gap: 0.5, my: 1 }}>
        {prompt.fields.map((field, index) => <Typography key={index} variant="body2" sx={{ minWidth: 0, gridColumn: field.inline ? undefined : '1 / -1', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {formatToolCardField(field.label, field.value)}
        </Typography>)}
      </Box> : null}
      {prompt.kind === 'show_card' && prompt.footer !== undefined ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{formatToolCallValue(prompt.footer).text}</Typography> : null}
      {prompt.kind === 'ask_user' ? <TextField
        fullWidth size="small" sx={{ my: 1 }} value={answer} disabled={disabled}
        label={t('chat.agent_interaction.answer')} placeholder={prompt.placeholder}
        multiline={prompt.multiline} maxRows={4}
        inputProps={{ maxLength: LIMITS.answer }}
        onChange={(event) => setAnswer(event.target.value)}
      /> : null}
      {error ? <Alert severity="error" sx={{ my: 1 }}>{t('chat.agent_interaction.failed')}</Alert> : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
        {prompt.kind === 'ask_user' ? <Button disabled={disabled || !answer.trim()} variant="contained" onClick={() => void resolve({ status: 'answered', text: answer })}>{t('chat.agent_interaction.submit')}</Button>
          : prompt.actions.map((action) => {
            const actionStyle = getToolCardActionStyle(Object.hasOwn(action, 'style') ? action.style : undefined)
            return <Button key={action.id} disabled={disabled} variant={actionStyle?.variant ?? 'outlined'} color={actionStyle?.color} onClick={() => void resolve({ status: 'answered', actionId: action.id })}>{action.label}</Button>
          })}
        <Button disabled={disabled} onClick={() => void resolve({ status: 'dismissed' })}>{t('chat.agent_interaction.dismiss')}</Button>
      </Box>
    </Box>
  )
}

function ActiveThreadInteractions({ scope }: { scope: string }) {
  const [pending, setPending] = useState<{ scope: string; item: AgentThreadInteraction }>()
  const settled = useRef(new Set<string>())
  const live = useRef(false)
  const item = pending?.scope === scope ? pending.item : undefined

  useEffect(() => {
    live.current = true
    const service = api().svcLLMProxy
    // Older hosts and test adapters may not implement this UI surface yet.
    if (typeof service?.listAgentInteractions !== 'function') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const request = JSON.parse(scope)
    const poll = async () => {
      try {
        const result = await service.listAgentInteractions(request)
        if (stopped) return
        const next = result.interactions.find((entry) => !settled.current.has(entry.id) && entry.expiresAt > Date.now())
        setPending((previous) => next
          ? previous?.scope === scope && previous.item.id === next.id ? previous : { scope, item: next }
          : undefined)
      } catch {
        // A transport hiccup is not proof that the prompt was revoked. Keep its
        // keyed draft; successful empty polls, expiry and scope changes remove it.
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 500)
      }
    }
    void poll()
    return () => { stopped = true; live.current = false; clearTimeout(timer) }
  }, [scope])

  if (!item) return null
  const selected = item
  const resolve = async (answer: AgentThreadInteractionAnswer) => {
    await api().svcLLMProxy.resolveAgentInteraction({ ...JSON.parse(scope), interactionId: selected.id, answer })
    if (!live.current) return
    settled.current.add(selected.id)
    if (settled.current.size > 128) settled.current.delete(settled.current.values().next().value!)
    setPending((previous) => previous?.scope === scope && previous.item.id === selected.id ? undefined : previous)
  }
  return <InteractionForm key={`${scope}:${selected.id}`} item={selected} onResolve={resolve} />
}

/** Mount a fresh channel for every scope/activation. Late replies never reach its successor. */
export default function AgentThreadInteractionPanel({ route, conversationId, active }: {
  route?: AgentRouteLike
  conversationId?: string
  active: boolean
}) {
  if (!active || route?.channel !== 'canvas' || route.scopeType !== 'thread' || !conversationId) return null
  const scope = JSON.stringify({ route, conversationId })
  return <ActiveThreadInteractions key={scope} scope={scope} />
}
