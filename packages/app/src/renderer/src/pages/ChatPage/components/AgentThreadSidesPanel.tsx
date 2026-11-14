import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Alert, Box, Button, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentRouteLike } from '@shared/agent'
import type { ChatMessage } from '@shared/llm/types'
import { AGENT_SIDE_LIMITS as LIMITS, type AgentSideSummary, type AgentSideOpen, type AgentSideStartReq, type AgentSideContinueReq } from '@shared/api/agentThreadSide'
import { api } from '../../../utils/windowUtils'
import { sideSnapshot } from '../sideSnapshot'
import type { AgentSideCommand, AgentSideCommandHandle } from '../agentSideCommand'
import AgentThreadSubRow from '../../../components/AgentThreadSubRow'

type PendingSideRequest = AgentSideStartReq | AgentSideContinueReq
function SidePanel({ scope, profileId, getMessages, commandRef, commandEnabled, onViewChange, pendingByScope, subRowsHost, onOpenSubRowChange }: { scope: string; profileId?: string; getMessages(): readonly ChatMessage[]; commandRef: React.ForwardedRef<AgentSideCommandHandle>; commandEnabled: boolean; onViewChange?(showingSide: boolean): void; subRowsHost?: HTMLElement | null; onOpenSubRowChange?(title: string | null): void; pendingByScope: React.MutableRefObject<Map<string, PendingSideRequest>> }) {
  const { t } = useTranslation()
  // Keep uncertain requests across trusted conversation switches, but never publish old replies.
  const pending = useRef<PendingSideRequest | undefined>(pendingByScope.current.get(scope))
  const restored = pending.current
  const [open, setOpen] = useState(!!restored), [branches, setBranches] = useState<AgentSideSummary[]>([]), [selected, setSelected] = useState(restored && 'expectedRevision' in restored ? restored.branchId : ''), [detail, setDetail] = useState<AgentSideOpen>(), [text, setText] = useState(restored?.question || ''), [error, setError] = useState(false), [busy, setBusy] = useState(false), [confirmDelete, setConfirmDelete] = useState(false), [revisionConflict, setRevisionConflict] = useState(false), [confirmNewAttempt, setConfirmNewAttempt] = useState(false)
  useLayoutEffect(() => { onViewChange?.(open); return () => onViewChange?.(false) }, [open, onViewChange])
  const alive = useRef(true), locked = useRef(false), generation = useRef(0), selectedRef = useRef(selected)
  useLayoutEffect(() => () => {
    // Only the owning mounted thread keeps uncertain requests; nothing is persisted as authority.
    if (pending.current) pendingByScope.current.set(scope, pending.current)
    else pendingByScope.current.delete(scope)
  }, [scope, pendingByScope])
  const commandAvailable = useRef(commandEnabled); commandAvailable.current = commandEnabled
  useLayoutEffect(() => { generation.current++ }, [commandEnabled])
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  const acceptDetail = (next: AgentSideOpen) => setDetail((previous) => previous?.branch.id === next.branch.id && (previous.branch.revision > next.branch.revision || previous.branch.revision === next.branch.revision && !previous.branch.busy && next.branch.busy) ? previous : next)
  const select = (id: string) => { setConfirmNewAttempt(false); setRevisionConflict(false); generation.current++; selectedRef.current = id; setSelected(id); setDetail(undefined); setText(''); pending.current = undefined; setConfirmDelete(false) }
  // The branch list is read only while something shows it: the open side view, or the rows this
  // conversation contributes to the thread list while that list is open.
  const listVisible = Boolean(subRowsHost)
  useEffect(() => {
    if (!open && !listVisible) return
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const token = generation.current, id = selectedRef.current
      try {
        const service = api().svcLLMProxy
        const result = await service.listAgentSides(JSON.parse(scope))
        if (!closed && alive.current && token === generation.current) setBranches(Array.isArray(result?.branches) ? result.branches : [])
        if (open && id && !closed && alive.current && token === generation.current) {
          const opened = await service.openAgentSide({ ...JSON.parse(scope), branchId: id })
          if (!closed && alive.current && generation.current === token && selectedRef.current === id) acceptDetail(opened)
        }
      } catch { if (!closed && alive.current) setError(true) }
      finally { if (!closed) timer = setTimeout(() => void poll(), 1500) }
    }
    void poll()
    return () => { closed = true; clearTimeout(timer) }
  }, [scope, open, listVisible, selected])
  const send = async () => {
    if (locked.current || !text.trim()) return
    locked.current = true; setBusy(true); setError(false); setConfirmNewAttempt(false)
    const token = ++generation.current
    try {
      const service = api().svcLLMProxy
      if (!pending.current && selected && !detail) throw new Error('Reopen side first')
      pending.current ??= selected ? { ...JSON.parse(scope), branchId: selected, operationId: crypto.randomUUID(), expectedRevision: detail!.branch.revision, question: text.trim() } : { ...JSON.parse(scope), branchId: crypto.randomUUID(), operationId: crypto.randomUUID(), profileId: profileId || '', question: text.trim(), snapshot: sideSnapshot(getMessages()) }
      const request = pending.current
      if (!request) throw new Error('Side request was not prepared.')
      const result = 'expectedRevision' in request ? await service.continueAgentSide(request) : await service.startAgentSide(request)
      if (!alive.current || generation.current !== token) return
      pending.current = undefined; select(result.branch.id); setBranches((rows) => [result.branch, ...rows.filter((row) => row.id !== result.branch.id)])
    } catch (error) { if (alive.current && generation.current === token) {
      setError(true)
      // Only a definite main-owned pre-dispatch CAS rejection may abandon a pending identity.
      if (error instanceof Error && error.message.includes('Side revision conflict;')) setRevisionConflict(true)
    } }
    finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  const runCommand = async (command: Exclude<AgentSideCommand, { action: 'help' }>) => {
    locked.current = true; setBusy(true); setError(false); setConfirmNewAttempt(false); setOpen(true)
    select(command.action === 'start' ? '' : command.branchId)
    if (command.action === 'start' || command.action === 'continue') setText(command.question)
    const token = ++generation.current, current = () => alive.current && commandAvailable.current && generation.current === token
    try {
      const service = api().svcLLMProxy
      let result: { branch: AgentSideSummary }
      if (command.action === 'start') {
        const request: AgentSideStartReq = { ...JSON.parse(scope), branchId: crypto.randomUUID(), operationId: crypto.randomUUID(), profileId: profileId!, question: command.question, snapshot: sideSnapshot(getMessages()) }
        pending.current = request
        result = await service.startAgentSide(request)
      } else {
        const opened = await service.openAgentSide({ ...JSON.parse(scope), branchId: command.branchId })
        if (!current()) return
        acceptDetail(opened)
        if (command.action === 'open') return
        if (command.action === 'stop') result = await service.stopAgentSide({ ...JSON.parse(scope), branchId: command.branchId, expectedRevision: opened.branch.revision })
        else {
          if (!opened.branch.canContinue || opened.branch.busy) throw new Error('Side is not ready to continue.')
          const request: AgentSideContinueReq = { ...JSON.parse(scope), branchId: command.branchId, expectedRevision: opened.branch.revision, operationId: crypto.randomUUID(), question: command.question }
          pending.current = request
          result = await service.continueAgentSide(request)
        }
      }
      if (!current()) return
      pending.current = undefined; select(result.branch.id); setBranches(rows => [result.branch, ...rows.filter(row => row.id !== result.branch.id)])
    } catch (error) {
      if (current()) { setError(true); if (error instanceof Error && error.message.includes('Side revision conflict;')) setRevisionConflict(true) }
    } finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  useImperativeHandle(commandRef, () => ({ execute(command, expectedScope) {
    if (!alive.current || !commandAvailable.current || locked.current || expectedScope !== undefined && expectedScope !== scope) return false
    setOpen(true)
    if (command.action === 'help') return true
    // An uncertain request is retried only through its existing pending identity.
    if (pending.current || command.action === 'start' && !profileId) { setError(true); return false }
    void runCommand(command); return true
  } }))
  const mutate = async (remove = false) => {
    if (locked.current || pending.current || !detail) return
    locked.current = true; setBusy(true); setError(false); setConfirmNewAttempt(false)
    const token = ++generation.current, req = { ...JSON.parse(scope), branchId: detail.branch.id, expectedRevision: detail.branch.revision }
    try {
      if (remove) await api().svcLLMProxy.deleteAgentSide(req)
      else await api().svcLLMProxy.stopAgentSide(req)
      if (alive.current && token === generation.current) { if (remove) { setBranches((rows) => rows.filter((row) => row.id !== req.branchId)); select('') } else { const opened = await api().svcLLMProxy.openAgentSide(req); if (alive.current && token === generation.current) acceptDetail(opened) } }
    } catch { if (alive.current && token === generation.current) setError(true) }
    finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  const close = () => { setOpen(false); setConfirmNewAttempt(false); generation.current++ }
  const navigate = async (id: string) => {
    if (locked.current || pending.current) return
    select(id); setOpen(true)
    if (!id) return
    const token = generation.current
    try { const value = await api().svcLLMProxy.openAgentSide({ ...JSON.parse(scope), branchId: id }); if (alive.current && token === generation.current && selectedRef.current === id) acceptDetail(value) }
    catch { if (alive.current && token === generation.current) setError(true) }
  }
  // The toolbar summary of the column names the side conversation that is open.
  const openSideTitle = open && selected ? (detail?.branch.id === selected ? detail.branch.title : branches.find(branch => branch.id === selected)?.title) ?? null : null
  useLayoutEffect(() => { onOpenSubRowChange?.(openSideTitle) }, [openSideTitle, onOpenSubRowChange])
  useLayoutEffect(() => () => onOpenSubRowChange?.(null), [onOpenSubRowChange])
  return <Box data-testid="agent-side-navigation" sx={{ flex: open ? 1 : undefined, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    {/* A conversation with side conversations lists itself and its sides under its thread row; "/btw" creates sides. */}
    {subRowsHost && branches.length > 0 && createPortal(<>
      <AgentThreadSubRow label={t('chat.agent_side.main')} selected={!open} onSelect={close} />
      {branches.map(branch => <AgentThreadSubRow key={branch.id} label={branch.title} selected={open && selected === branch.id} disabled={busy || !!pending.current} onSelect={() => void navigate(branch.id)} />)}
    </>, subRowsHost)}
    {open && <Box role="region" aria-label={t('chat.agent_side.title')} sx={{ px: 2, py: 1, flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}><Typography noWrap variant="subtitle2" sx={{ flex: 1 }}>{detail?.branch.title || t('chat.agent_side.new')}</Typography><Button size="small" onClick={close}>{t('chat.agent_side.close')}</Button></Box>
      {!selected && <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>{t('chat.agent_side.notice')}</Typography>}
        {error && <Alert severity="error">{t('chat.agent_side.error')}</Alert>}
        {revisionConflict && <Button disabled={busy} onClick={() => { if (locked.current) return; pending.current = undefined; setRevisionConflict(false); setError(false) }}>{t('chat.agent_side.retry_conflict')}</Button>}
        {pending.current && !revisionConflict ? <Alert severity="warning">
          {t('chat.agent_side.pending_notice')}
          <Button disabled={busy} onClick={() => { if (!locked.current) setConfirmNewAttempt(true) }}>{t('chat.agent_side.new_attempt')}</Button>
          {confirmNewAttempt ? <>
            <Typography variant="body2">{t('chat.agent_side.new_attempt_notice')}</Typography>
            <Button disabled={busy} color="warning" onClick={() => { if (locked.current || !confirmNewAttempt) return; pending.current = undefined; setConfirmNewAttempt(false); setError(false) }}>{t('chat.agent_side.confirm_new_attempt')}</Button>
            <Button disabled={busy} onClick={() => setConfirmNewAttempt(false)}>{t('chat.agent_side.keep_pending')}</Button>
          </> : null}
        </Alert> : null}
        {detail && <>
          <Typography variant="caption" display="block">{t('chat.agent_side.command_id', { id: detail.branch.id })}</Typography>
          <Typography variant="caption">{detail.branch.modelLabel} · {t(`chat.agent_side.status_${detail.branch.status}`)}</Typography>
          <Box sx={{ maxHeight: 340, overflow: 'auto', my: 1 }}>
            {detail.messages.map((message, index) => <Box key={index} sx={{ mb: 1, p: 1, bgcolor: 'action.hover', borderRadius: 1 }}><Typography variant="caption">{message.role}</Typography><Typography component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' }}>{message.content}</Typography></Box>)}
          </Box>
          <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
            {detail.branch.busy && <Button disabled={busy || !!pending.current} onClick={() => void mutate()}>{t('chat.agent_side.stop')}</Button>}
            {!detail.branch.busy && <Button color="warning" disabled={busy || !!pending.current} onClick={() => setConfirmDelete(true)}>{t('chat.agent_side.delete')}</Button>}
            {confirmDelete && <Button color="error" disabled={busy || !!pending.current} onClick={() => void mutate(true)}>{t('chat.agent_side.confirm_delete')}</Button>}
          </Box>
        </>}
        <TextField multiline fullWidth minRows={2} maxRows={6} label={t('chat.agent_side.question')} value={text} disabled={busy || !!pending.current} inputProps={{ maxLength: LIMITS.questionCharacters }} onChange={(e) => { if (!pending.current) setText(e.target.value) }} />
        <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
          <Button disabled={busy || revisionConflict || !text.trim() || (pending.current ? false : selected ? !detail?.branch.canContinue : !profileId)} onClick={() => void send()}>{t(selected ? 'chat.agent_side.continue' : 'chat.agent_side.start')}</Button>
          <Button onClick={close}>{t('chat.agent_side.back_main')}</Button>
        </Box>
    </Box>}
  </Box>
}
type SidePanelProps = {
  route?: AgentRouteLike; conversationId?: string; active: boolean; profileId?: string; getMessages(): readonly ChatMessage[]; commandEnabled?: boolean; onViewChange?(showingSide: boolean): void
  /** Host under this thread's row of the column's thread list; present only while that list is open. */
  subRowsHost?: HTMLElement | null
  /** Title of the side conversation that is open, or null while the main conversation shows. */
  onOpenSubRowChange?(title: string | null): void
}
const AgentThreadSidesPanel = forwardRef<AgentSideCommandHandle, SidePanelProps>(function AgentThreadSidesPanel({ route, conversationId, active, profileId, getMessages, commandEnabled = true, onViewChange, subRowsHost, onOpenSubRowChange }, ref) {
  const pendingByScope = useRef(new Map<string, PendingSideRequest>())
  if (!active || !conversationId || route?.channel !== 'canvas' || route.scopeType !== 'thread') return null
  const scope = JSON.stringify({ route, conversationId })
  return <SidePanel key={scope} scope={scope} pendingByScope={pendingByScope} profileId={profileId} getMessages={getMessages} commandRef={ref} commandEnabled={commandEnabled} onViewChange={onViewChange} subRowsHost={subRowsHost} onOpenSubRowChange={onOpenSubRowChange} />
})
export default AgentThreadSidesPanel
