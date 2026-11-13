import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Switch, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { AGENT_APP_LIMITS, parseAgentAppDocument, parseAgentAppValues, type AgentAppDocument, type AgentAppValues } from '@shared/api/agentThreadApp'
import type { AgentThreadInteractionAnswer } from '@shared/api/agentThreadInteraction'

/** Fixed components only. Never use innerHTML, markdown, model props/styles or external resource URLs. */
function DisplayBlocks({ document }: { document: AgentAppDocument }) {
  return <Box sx={{ display: 'grid', gap: 2 }}>
    {document.description ? <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{document.description}</Typography> : null}
    {document.blocks.map((block, index) => {
      if (block.kind === 'text') return <Typography key={index} sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{block.text}</Typography>
      if (block.kind === 'table') return <Box key={index} sx={{ overflow: 'auto', maxHeight: 300, '& th, & td': { border: '1px solid', borderColor: 'divider', padding: 1, maxWidth: 240, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }}>
        <table><caption>{block.title}</caption><thead><tr>{block.columns.map((column, i) => <th key={i} scope="col">{column}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </Box>
      const maximum = Math.max(1, ...block.items.map((item) => item.value))
      return <Box key={index} component="figure" sx={{ margin: 0 }}>
        <Typography component="figcaption">{block.title}</Typography>
        <Box component="ul" sx={{ listStyle: 'none', padding: 0 }}>
          {block.items.map((item, i) => <Box component="li" key={i} sx={{ mb: 1 }}>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{item.label}: {item.value}</Typography>
            <Box aria-hidden="true" sx={{ height: 12, width: `${item.value / maximum * 100}%`, bgcolor: 'primary.main', borderRadius: 1 }} />
          </Box>)}
        </Box>
      </Box>
    })}
  </Box>
}

export default function AgentThreadAppDisplay({ document: raw, expiresAt, onResolve }: {
  document: AgentAppDocument
  expiresAt: number
  onResolve(answer: AgentThreadInteractionAnswer): Promise<void>
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const document = useMemo(() => { try { return parseAgentAppDocument(raw) } catch { return undefined } }, [raw])
  const [open, setOpen] = useState(false)
  const [expired, setExpired] = useState(Date.now() >= expiresAt)
  const [draft, setDraft] = useState<Record<string, string | boolean>>({})
  const [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const sending = useRef(false), mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const timer = setTimeout(() => { setExpired(true); setOpen(false); setDraft({}) }, Math.max(0, expiresAt - Date.now()))
    return () => { mounted.current = false; clearTimeout(timer) }
  }, [expiresAt])
  let values: AgentAppValues | undefined
  if (document) {
    try {
      const candidate = Object.fromEntries((document.fields ?? []).map((field) => [field.id,
        field.kind === 'toggle' ? draft[field.id] === true : field.kind === 'number'
          ? typeof draft[field.id] === 'string' && String(draft[field.id]).trim() ? Number(draft[field.id]) : NaN
          : draft[field.id] ?? ''
      ]))
      values = parseAgentAppValues(document, candidate)
    } catch { /* Invalid drafts cannot be submitted. */ }
  }
  const resolve = async (answer: AgentThreadInteractionAnswer) => {
    if (sending.current || Date.now() >= expiresAt) return
    sending.current = true; setBusy(true); setError(false)
    try { await onResolve(answer) }
    catch { if (mounted.current) setError(true) }
    finally { sending.current = false; if (mounted.current) setBusy(false) }
  }
  if (expired) return null
  if (!document) return <Alert severity="error">{t('chat.agent_app.invalid')}</Alert>
  const disabled = busy || expired
  return <Box role="region" aria-label={t('chat.agent_app.title')} sx={{ mx: 2, mb: 1, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2, flexShrink: 0 }}>
    <Typography variant="caption">{t('chat.agent_app.notice')}</Typography>
    <Typography sx={{ overflowWrap: 'anywhere' }}>{document.title}</Typography>
    <Button disabled={disabled} onClick={() => setOpen(true)}>{t('chat.agent_app.open')}</Button>
    <Button disabled={disabled} onClick={() => void resolve({ status: 'dismissed' })}>{t('chat.agent_interaction.dismiss')}</Button>
    {error && !open ? <Alert severity="error">{t('chat.agent_interaction.failed')}</Alert> : null}
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>{t('chat.agent_app.title')}</DialogTitle>
      <DialogContent sx={{ maxHeight: '70vh' }}>
        <Alert severity="info" sx={{ mb: 2 }}>{t('chat.agent_app.notice')}</Alert>
        <Typography variant="h6" sx={{ overflowWrap: 'anywhere' }}>{document.title}</Typography>
        <DisplayBlocks document={document} />
        <Box sx={{ display: 'grid', gap: 2, mt: 2 }}>
          {(document.fields ?? []).map((field) => field.kind === 'toggle'
            ? <FormControlLabel key={field.id} label={field.label} control={<Switch disabled={disabled} checked={draft[field.id] === true} onChange={(_, checked) => setDraft((prior) => ({ ...prior, [field.id]: checked }))} />} />
            : field.kind === 'select' ? <Box key={field.id} component="label" sx={{ display: 'grid', gap: 0.5, overflowWrap: 'anywhere' }}>{field.label}
              <select disabled={disabled} value={String(draft[field.id] ?? '')} onChange={(event) => setDraft((prior) => ({ ...prior, [field.id]: event.target.value }))}>
                <option value="">{t('chat.agent_app.choose')}</option>
                {field.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </Box> : <TextField key={field.id} label={field.label} disabled={disabled} value={draft[field.id] ?? ''} fullWidth size="small"
              type={field.kind === 'number' ? 'number' : 'text'} autoComplete="off"
              inputProps={field.kind === 'number' ? { min: field.min, max: field.max, step: 'any' } : { maxLength: AGENT_APP_LIMITS.answerCharacters }}
              onChange={(event) => setDraft((prior) => ({ ...prior, [field.id]: event.target.value }))} />)}
        </Box>
        {error ? <Alert severity="error" sx={{ mt: 2 }}>{t('chat.agent_interaction.failed')}</Alert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setOpen(false)}>{t('chat.agent_app.close')}</Button>
        <Button disabled={disabled} onClick={() => void resolve({ status: 'dismissed' })}>{t('chat.agent_interaction.dismiss')}</Button>
        <Button disabled={disabled || !values} variant="contained" onClick={() => { if (values) void resolve({ status: 'answered', values }) }}>{t('chat.agent_app.submit')}</Button>
      </DialogActions>
    </Dialog>
  </Box>
}
