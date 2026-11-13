import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, FormControlLabel, Stack, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentLocalFileScope, AgentLocalFilesSvc } from '@shared/api/svcAgentLocalFiles'

/** Explicit user-only native chooser. Does not attach results to model context. */
export default function SqlitePreviewPanel({ scope, service, disabled }: {
  scope: AgentLocalFileScope; service: AgentLocalFilesSvc; disabled?: boolean
}) {
  const { t } = useTranslation()
  const [table, setTable] = useState(''), [columns, setColumns] = useState('')
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ kind: 'data'; text: string } | { kind: 'cancelled' | 'failed' } | null>(null)
  const generation = useRef(0)
  const key = JSON.stringify(scope)
  const request = useRef<{ scope: AgentLocalFileScope; requestId: string } | null>(null)
  useEffect(() => { generation.current++; setResult(null); setConsent(false); setBusy(false); return () => {
    generation.current++
    const owned = request.current; request.current = null
    if (owned) { try { void service.cancel(owned).catch(()=>{}) } catch { /* disconnected cleanup */ } }
  } }, [key, service])
  return <Stack spacing={1}>
    <Typography variant="subtitle2">{t('chat.sqlite_preview.title', { defaultValue: 'Standalone SQLite preview (basic)' })}</Typography>
    <Alert severity="warning">{t('chat.sqlite_preview.warning', { defaultValue: 'Select an owned standalone SQLite file only (up to 8 MiB). Preview makes a temporary sensitive copy. No WAL/journal files are read: this is not a live database snapshot or backup. No writes to the source are authorized. Preview does not send rows to a model. Worker assets must be installed; unavailable workers fail closed.' })}</Alert>
    <TextField disabled={busy} label={t('chat.sqlite_preview.table', { defaultValue: 'SQLite table' })} value={table} inputProps={{ maxLength: 64 }} onChange={event => { setTable(event.target.value); setResult(null); setConsent(false) }} />
    <TextField disabled={busy} label={t('chat.sqlite_preview.columns', { defaultValue: 'SQLite columns (comma separated)' })} value={columns} inputProps={{ maxLength: 1040 }} onChange={event => { setColumns(event.target.value); setResult(null); setConsent(false) }} />
    <FormControlLabel label={t('chat.sqlite_preview.consent', { defaultValue: 'I approve a temporary sensitive snapshot for this preview' })} control={<Checkbox disabled={busy} checked={consent} onChange={event => setConsent(event.target.checked)} />} />
    <Button disabled={disabled || busy || !consent || !table.trim() || !columns.trim()} onClick={() => {
      if (request.current) return
      setBusy(true); setResult(null)
      const version = ++generation.current
      const owned = {scope,requestId:`sqlite-${Date.now()}-${version}`}
      request.current = owned
      let preview: ReturnType<AgentLocalFilesSvc['chooseSqlitePreview']>
      try {
        preview = service.chooseSqlitePreview({ ...owned, table: table.trim(), columns: columns.split(',').map(value => value.trim()), limit: 100, consentTemporarySnapshot: true })
      } catch (error) {
        preview = Promise.reject(error)
      }
      void preview.then(value => {
        if (generation.current === version && request.current === owned) setResult(value ? { kind: 'data', text: JSON.stringify(value, null, 2) } : { kind: 'cancelled' })
      }).catch(() => { if (generation.current === version && request.current === owned) setResult({ kind: 'failed' }) })
        .finally(() => { if (request.current === owned) { request.current = null; if (generation.current === version) { setBusy(false); setConsent(false) } } })
    }}>{t('chat.sqlite_preview.choose', { defaultValue: 'Choose SQLite file and preview' })}</Button>
    {result && <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.kind === 'data' ? result.text : result.kind === 'cancelled' ? t('chat.sqlite_preview.cancelled', { defaultValue: 'Selection cancelled.' }) : t('chat.sqlite_preview.failed', { defaultValue: 'SQLite preview unavailable or failed. Please try again with fresh consent.' })}</Typography>}
  </Stack>
}
