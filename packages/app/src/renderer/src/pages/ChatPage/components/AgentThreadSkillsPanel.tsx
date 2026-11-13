import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { AgentRouteLike } from '@shared/agent'
import type { AgentSkillSessionList, AgentSkillUserDetail, AgentSkillPreferenceResult } from '@shared/api/agentThreadSkillSession'
import { api } from '../../../utils/windowUtils'
import type { AgentSkillCommand, AgentSkillCommandHandle } from '../agentSkillCommand'
import { acknowledgeSkillPreference, beginSkillPreference, pendingSkillPreference } from '../skillPreferenceOperations'
let lifecycleRevision = 0
function Skills({ scope, commandRef, commandEnabled, visible, onClose }: { scope: string; commandRef: React.ForwardedRef<AgentSkillCommandHandle>; commandEnabled: boolean; visible: boolean; onClose?(): void }) {
  const { t } = useTranslation(), [detail, setDetail] = useState<AgentSkillUserDetail>(), [confirmSeparate, setConfirmSeparate] = useState(false), [bindingAttempt, setBindingAttempt] = useState(0), [bindingBusy, setBindingBusy] = useState(false), [rejected, setRejected] = useState(false), [bound, setBound] = useState<string>(), [catalog, setCatalog] = useState<AgentSkillSessionList>(), [busy, setBusy] = useState(false), [error, setError] = useState(false), [pending, setPending] = useState(() => pendingSkillPreference(scope))
  const live = useRef(false), lock = useRef(false), generation = useRef(0)
  const commandAvailable = useRef(commandEnabled), commandGeneration = useRef(0); commandAvailable.current = commandEnabled
  useLayoutEffect(() => { commandGeneration.current++; setDetail(undefined) }, [commandEnabled])
  const acceptChange = (result: AgentSkillPreferenceResult, attempt: NonNullable<typeof pending>) => {
    if ('status' in result) {
      if (result.status !== 'not-applied' || result.operationId !== attempt.operationId || result.reason !== 'revision-conflict' || !Number.isSafeInteger(result.currentRevision) || result.currentRevision <= attempt.expectedRevision) throw new Error('Skill preference result is invalid.')
      acknowledgeSkillPreference(scope, attempt.operationId); setPending(undefined); setCatalog(undefined); setRejected(true)
    } else { acknowledgeSkillPreference(scope, attempt.operationId); setPending(undefined); setCatalog(result) }
  }
  useLayoutEffect(() => {
    live.current = true; const token = ++generation.current, service = api().svcLLMProxy
    let revision: number | undefined
    setBound(undefined); setDetail(undefined); setBindingBusy(true); setError(false)
    void (async () => {
      if (typeof service.setAgentSkillScope !== 'function' || typeof service.agentSkillScopeRevision !== 'function') throw new Error('Skill lifecycle API unavailable.')
      const status = await service.agentSkillScopeRevision(JSON.parse(scope))
      if (!live.current || token !== generation.current) return
      if (!Number.isSafeInteger(status.revision) || status.revision < 0 || status.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Skill lifecycle unavailable.')
      revision = lifecycleRevision = Math.max(lifecycleRevision, status.revision) + 1
      const result = await service.setAgentSkillScope({ ...JSON.parse(scope), active: true, lifecycleRevision: revision })
      if (live.current && token === generation.current) {
        if (!result.documentToken) throw new Error('Skill lifecycle token unavailable.')
        setBound(JSON.stringify({ ...JSON.parse(scope), documentToken: result.documentToken }))
      }
    })().catch(() => { if (live.current && token === generation.current) setError(true) }).finally(() => { if (live.current && token === generation.current) setBindingBusy(false) })
    return () => { live.current = false; generation.current++; if (revision !== undefined) { try { void service.setAgentSkillScope({ ...JSON.parse(scope), active: false, lifecycleRevision: revision }).catch(() => undefined) } catch { /* Already unavailable. */ } } }
  }, [scope, bindingAttempt])
  const read = async () => {
    if (!bound || lock.current) return
    lock.current = true; setBusy(true); setDetail(undefined); setError(false); setRejected(false); setConfirmSeparate(false); const token = generation.current
    try { const result = await api().svcLLMProxy.listAgentSessionSkills(JSON.parse(bound)); if (live.current && token === generation.current) setCatalog(result) }
    catch { if (live.current && token === generation.current) setError(true) }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  const change = async (id?: string, enabled?: boolean) => {
    if (!bound || lock.current || !catalog && !pending) return
    lock.current = true; setBusy(true); setDetail(undefined); setError(false); setRejected(false); setConfirmSeparate(false); const token = generation.current
    try {
      const attempt = pending ?? beginSkillPreference(scope, id!, enabled!, catalog!.revision)
      setPending(attempt)
      const result = await api().svcLLMProxy.setAgentSkillPreference({ ...JSON.parse(bound), ...attempt })
      // A receipt is scoped and body-free; retain uncertainty if the caller retired.
      if (live.current && token === generation.current) {
        acceptChange(result, attempt)
      }
    } catch { if (live.current && token === generation.current) setError(true) }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  const runCommand = async (command: AgentSkillCommand) => {
    lock.current = true; setBusy(true); setError(false); setDetail(undefined); setConfirmSeparate(false); setRejected(false)
    const token = generation.current, commandToken = commandGeneration.current, current = () => live.current && commandAvailable.current && generation.current === token && commandGeneration.current === commandToken
    try {
      const service = api().svcLLMProxy
      if (command.action === 'show') {
        const result = await service.showAgentSessionSkill({ ...JSON.parse(bound!), name: command.name })
        if (current()) setDetail(result)
        return
      }
      const latest = await service.listAgentSessionSkills(JSON.parse(bound!))
      if (!current()) return
      setCatalog(latest)
      if (command.action === 'list') return
      const matches = latest.skills.filter(skill => skill.id === command.name || skill.name === command.name)
      if (matches.length !== 1) throw new Error('User skill name is unavailable or ambiguous.')
      const skill = matches[0], enabled = command.action === 'toggle' ? !skill.enabled : command.action === 'enable'
      const attempt = beginSkillPreference(scope, skill.id, enabled, latest.revision)
      setPending(attempt)
      const result = await service.setAgentSkillPreference({ ...JSON.parse(bound!), ...attempt })
      if (current()) acceptChange(result, attempt)
    } catch { if (current()) setError(true) }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  useImperativeHandle(commandRef, () => ({ execute(command, expectedScope) {
    if (!live.current || !bound || lock.current || !commandAvailable.current || expectedScope !== scope || pending || pendingSkillPreference(scope)) return false
    void runCommand(command); return true
  } }))
  if (!visible) return null
  return <Box sx={{ mx: 2, mb: 1 }}>
    {onClose && <Button size="small" onClick={onClose}>{t('general.close')}</Button>}
    {detail && <Box sx={{ p: 1, maxHeight: 280, overflow: 'auto', border: '1px solid', borderColor: 'divider' }}>
      <Alert severity="warning">{t('chat.agent_skill_session.body_notice')}</Alert>
      <Typography variant="body2">{detail.name} · {t(detail.enabled ? 'chat.agent_skill_session.enabled' : 'chat.agent_skill_session.disabled')}</Typography>
      <Typography variant="caption" display="block">{detail.baseDirectory}</Typography>
      <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' }}>{detail.instructions}</Typography>
      <Button size="small" onClick={() => setDetail(undefined)}>{t('chat.agent_skill_session.close_body')}</Button>
    </Box>}
    <Button size="small" disabled={busy || !bound} onClick={() => void read()}>{t('chat.agent_skill_session.open')}</Button>
    {(!bound || error) && <Button size="small" disabled={busy || bindingBusy} onClick={() => { if (!lock.current && !bindingBusy) setBindingAttempt(value => value + 1) }}>{t('chat.agent_skill_session.rebind')}</Button>}
    {rejected && <Alert severity="warning">{t('chat.agent_skill_session.not_applied')}</Alert>}
    {error && <Alert severity="error">{t('chat.agent_skill_session.failed')}</Alert>}
    {pending && <Alert severity="warning">{t('chat.agent_skill_session.pending')}<Button disabled={busy || !bound} onClick={() => void change()}>{t('chat.agent_skill_session.retry')}</Button></Alert>}
    {pending && !busy && <>
      <Button size="small" onClick={() => { if (!lock.current) setConfirmSeparate(true) }}>{t('chat.agent_skill_session.separate')}</Button>
      {confirmSeparate && <Alert severity="warning"><Typography variant="body2">{t('chat.agent_skill_session.separate_notice')}</Typography>
        <Button size="small" disabled={busy} onClick={() => { if (lock.current || !confirmSeparate) return; acknowledgeSkillPreference(scope, pending.operationId); setPending(undefined); setCatalog(undefined); setConfirmSeparate(false) }}>{t('chat.agent_skill_session.confirm_separate')}</Button>
        <Button size="small" onClick={() => setConfirmSeparate(false)}>{t('chat.agent_skill_session.keep_pending')}</Button>
      </Alert>}
    </>}
    {catalog && <Box sx={{ p: 1, border: '1px solid', borderColor: 'divider', maxHeight: 280, overflow: 'auto' }}>
      <Alert severity="info">{t('chat.agent_skill_session.notice')}</Alert>
      {(catalog.truncated || catalog.staleDisabledIds.length > 0) && <Alert severity="warning">{t('chat.agent_skill_session.partial')}</Alert>}
      {catalog.staleDisabledIds.map(id => <Box key={id}><Typography variant="caption">{id}</Typography><Button size="small" disabled={busy || !!pending || !bound} onClick={() => void change(id, true)}>{t('chat.agent_skill_session.forget_stale')}</Button></Box>)}
      {!catalog.skills.length && <Typography variant="caption">{t('chat.agent_skill_session.empty')}</Typography>}
      {catalog.skills.map(skill => <Box key={skill.id} sx={{ my: 1 }}>
        <Typography variant="body2">{skill.name} · {t(skill.enabled ? 'chat.agent_skill_session.enabled' : 'chat.agent_skill_session.disabled')}</Typography>
        <Typography variant="caption" display="block">{skill.description}</Typography>
        {skill.hidden && <Typography variant="caption" display="block">{t('chat.agent_skill_session.hidden')}</Typography>}
        <Button size="small" disabled={busy || !!pending || !bound} onClick={() => void change(skill.id, !skill.enabled)}>{t(skill.enabled ? 'chat.agent_skill_session.disable' : 'chat.agent_skill_session.enable')}</Button>
      </Box>)}
    </Box>}
  </Box>
}
type SkillsPanelProps = { route?: AgentRouteLike; conversationId?: string; active: boolean; commandEnabled?: boolean; visible?: boolean; onClose?(): void }
const AgentThreadSkillsPanel = forwardRef<AgentSkillCommandHandle, SkillsPanelProps>(function AgentThreadSkillsPanel({ route, conversationId, active, commandEnabled = true, visible = true, onClose }, ref) {
  if (!active || !conversationId || route?.channel !== 'canvas' || route.scopeType !== 'thread') return null
  const scope = JSON.stringify({ route, conversationId })
  return <Skills key={scope} scope={scope} commandRef={ref} commandEnabled={commandEnabled} visible={visible} onClose={onClose} />
})
export default AgentThreadSkillsPanel
