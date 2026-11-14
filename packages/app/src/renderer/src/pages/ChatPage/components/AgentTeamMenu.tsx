import { createPortal } from 'react-dom'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Box, Button, Checkbox, FormControlLabel, MenuItem, TextField, Typography } from '@mui/material'
import type { ChatSession } from '../chatStorage'
import { resolveTeamRequestSettings } from '../agentTeam'
import { canSetTeamTaskStatus, setTeamTaskDependencies, setTeamTaskStatus, teamTaskBlockers, validateTeamTasks } from '../agentTeamTasks'

const taskStatusLabel = { pending: '待处理', running: '进行中', done: '已完成' } as const
const broadcastUnknownNotice = '广播结果未确认，请先核对相关会话，避免重复发送。'
const normalizeAccessibleName = (value: string) => value.replace(/\s+/g, ' ').trim()
const normalizePerceivedName = (value: string) => normalizeAccessibleName(value.replace(/[\u200b\u2060]/gu, ''))

export default function AgentTeamMenu({
  lead, members, models, buttonHost, hideTriggerWithoutHost, onSave, onEnd, onDispatch, subscriptions, onSubscriptionChange, onBroadcast, onAddMember, openRequest, onReturnFocus
}: {
  buttonHost?: HTMLElement | null
  hideTriggerWithoutHost?: boolean
  openRequest?: number
  /** The dialog closed while it held the focus and there is no trigger to hand the focus back to. */
  onReturnFocus?(): void
  models: { id: string; name: string }[]
  onBroadcast?(input: Readonly<{ id: string; text: string }>): { queued: number } | Promise<{ queued: number }>
  onEnd(): void
  onAddMember?(): void
  onDispatch?(taskId: string): void
  subscriptions?: readonly string[]
  onSubscriptionChange?(memberId: string, subscribed: boolean): void
  lead: ChatSession
  members: ChatSession[]
  onSave(value: ChatSession): Promise<boolean>
}) {
  const dependencyDescriptionId = useId()
  const endDraftDescriptionId = useId()
  const channelLimitDescriptionId = useId()
  const subscriptionGroupLabelId = useId()
  const [open, setOpen] = useState(false)
  const initialOpenRequest = useRef(openRequest)
  const focusOpenRequestRef = useRef(false)
  const dialogCloseButtonRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const keyboardOriginRef = useRef<HTMLButtonElement | null>(null)
  const pendingTriggerFocusRef = useRef(false)
  useLayoutEffect(() => {
    if (!open || !pendingTriggerFocusRef.current) return
    pendingTriggerFocusRef.current = false
    const origin = keyboardOriginRef.current
    if (origin?.isConnected && document.activeElement === origin) dialogCloseButtonRef.current?.focus()
  }, [open])
  useEffect(() => {
    if (openRequest !== undefined && initialOpenRequest.current !== openRequest) {
      initialOpenRequest.current = openRequest
      keyboardOriginRef.current = null
      pendingTriggerFocusRef.current = false
      focusOpenRequestRef.current = true
      setOpen(true)
    }
  }, [openRequest])
  useEffect(() => {
    if (!open || !focusOpenRequestRef.current) return
    const timer = window.setTimeout(() => {
      focusOpenRequestRef.current = false
      dialogCloseButtonRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, openRequest])
  const [task, setTask] = useState('')
  const [owner, setOwner] = useState('')
  const [ownerNeedsReselection, setOwnerNeedsReselection] = useState(false)
  const ownerMissing = owner !== '' && !members.some(member => member.id === owner)
  useEffect(() => {
    if (ownerMissing) setOwnerNeedsReselection(true)
  }, [ownerMissing])
  const invalidOwner = ownerMissing || ownerNeedsReselection
  const invalidOwnerOption = '\u0000former-owner'
  const [dependencies, setDependencies] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [broadcastPending, setBroadcastPending] = useState(false)
  const broadcastPendingRef = useRef(false)
  const [broadcastNotice, setBroadcastNotice] = useState('')
  const [broadcastUnknown, setBroadcastUnknown] = useState(false)
  const broadcastUnknownRef = useRef(false)
  const broadcastUnknownDescriptionId = useId()
  const [pendingDraft, setPendingDraft] = useState(false)
  const draftPendingRef = useRef(false)
  const [pendingOther, setPendingOther] = useState(false)
  const otherPendingRef = useRef(false)
  const draftGenerationRef = useRef(0)
  const unresolvedDraftRef = useRef(false)
  const [draftUnconfirmed, setDraftUnconfirmed] = useState(false)
  const [unconfirmedEntry, setUnconfirmedEntry] = useState<{ kind: 'task' | 'channel'; id: string } | null>(null)
  useEffect(() => () => { draftGenerationRef.current += 1 }, [])
  const submitDraft = async (value: ChatSession, entry: { kind: 'task' | 'channel'; id: string }, clear: () => void) => {
    if (draftPendingRef.current || otherPendingRef.current || unresolvedDraftRef.current) return
    draftPendingRef.current = true
    setUnconfirmedEntry(entry)
    setPendingDraft(true)
    const generation = draftGenerationRef.current
    try {
      const saved = await onSave(value)
      if (draftGenerationRef.current !== generation) return
      if (saved === true) { setUnconfirmedEntry(null); clear() }
      else { unresolvedDraftRef.current = true; setUnconfirmedEntry(entry); setDraftUnconfirmed(true) }
    } catch {
      if (draftGenerationRef.current === generation) { unresolvedDraftRef.current = true; setUnconfirmedEntry(entry); setDraftUnconfirmed(true) }
    } finally {
      draftPendingRef.current = false
      if (draftGenerationRef.current === generation) setPendingDraft(false)
    }
  }
  const saveOther = async (value: ChatSession) => {
    if (draftPendingRef.current || otherPendingRef.current || unresolvedDraftRef.current) return
    otherPendingRef.current = true
    setPendingOther(true)
    const generation = draftGenerationRef.current
    try {
      const saved = await onSave(value)
      if (draftGenerationRef.current === generation && saved !== true) {
        unresolvedDraftRef.current = true
        setDraftUnconfirmed(true)
      }
    } catch {
      if (draftGenerationRef.current === generation) {
        unresolvedDraftRef.current = true
        setDraftUnconfirmed(true)
      }
    } finally {
      otherPendingRef.current = false
      if (draftGenerationRef.current === generation) setPendingOther(false)
    }
  }
  const endTeam = () => {
    if (draftPendingRef.current || otherPendingRef.current || unresolvedDraftRef.current || broadcastPendingRef.current) return
    draftGenerationRef.current += 1
    onEnd()
  }
  const draftLocked = pendingDraft || pendingOther || draftUnconfirmed || broadcastPending
  const trigger = <Button ref={triggerRef} size="small" aria-label="团队管理" aria-expanded={open} aria-haspopup="dialog" onClick={event => {
    focusOpenRequestRef.current = false
    pendingTriggerFocusRef.current = !open && event.detail === 0 && document.activeElement === event.currentTarget
    keyboardOriginRef.current = pendingTriggerFocusRef.current ? event.currentTarget : null
    setOpen(value => !value)
  }} sx={{ minWidth: 28, px: 0.5, fontWeight: 700, color: open ? 'primary.main' : 'text.secondary' }}>⋯</Button>
  const tasks = lead.teamTasks ?? []
  let validTasks = true
  try { validateTeamTasks(tasks) } catch { validTasks = false }
  const titleCounts = new Map<string, number>()
  if (validTasks) for (const item of tasks) {
    const title = normalizeAccessibleName(item.title)
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
  }
  const dispatchNames = validTasks ? tasks.map((item, index) => (titleCounts.get(normalizeAccessibleName(item.title)) ?? 0) > 1
    ? `执行 ${item.title}（当前列表第 ${index + 1} 项，位置随列表变化）`
    : `执行 ${item.title}`) : []
  const originalDispatchNames = validTasks ? tasks.map(item => `执行 ${item.title}`) : []
  // Treat these invisible characters as a potential title collision, without changing displayed or saved titles.
  const seenPerceivedTitles = new Map<string, string>()
  let invisibleTitleCollision = false
  if (validTasks) for (const item of tasks) {
    const original = normalizeAccessibleName(item.title)
    const perceived = normalizePerceivedName(item.title)
    const previous = seenPerceivedTitles.get(perceived)
    if (previous !== undefined && previous !== original) { invisibleTitleCollision = true; break }
    seenPerceivedTitles.set(perceived, original)
  }
  const conflictsWithOtherTitle = dispatchNames.some((name, index) => (titleCounts.get(normalizeAccessibleName(tasks[index].title)) ?? 0) > 1 && originalDispatchNames.some((original, otherIndex) => otherIndex !== index && normalizePerceivedName(name) === normalizePerceivedName(original)))
  const useDispatchPositionPrefix = !validTasks || invisibleTitleCollision || conflictsWithOtherTitle || new Set(dispatchNames.map(normalizePerceivedName)).size !== dispatchNames.length || tasks.some(item => /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(item.title))
  const dependencyNames = new Set<string>()
  let useDependencyPositionPrefix = useDispatchPositionPrefix
  if (validTasks && open && !useDependencyPositionPrefix) {
    for (const item of tasks) {
      const name = normalizePerceivedName(item.title)
      if (dependencyNames.has(name)) { useDependencyPositionPrefix = true; break }
      dependencyNames.add(name)
    }
    if (!useDependencyPositionPrefix) for (const item of tasks) {
      for (const candidate of tasks) {
        if (candidate.id === item.id) continue
        const name = normalizePerceivedName(`${item.title} 依赖 ${candidate.title}`)
        if (dependencyNames.has(name)) { useDependencyPositionPrefix = true; break }
        dependencyNames.add(name)
      }
      if (useDependencyPositionPrefix) break
    }
  }
  const taskPositions = validTasks ? new Map(tasks.map((item, index) => [item.id, index + 1])) : new Map<string, number>()
  const unavailableSelection = Boolean(lead.teamSettings && Object.hasOwn(lead.teamSettings, 'memberModelSelection'))
  const currentModel = lead.teamSettings?.defaultModel ?? ''
  const missingModel = currentModel !== '' && !models.some(model => model.id === currentModel)
  const currentIds = new Set(tasks.map(item => item.id))
  const durablePendingReceipts = (lead.teamMessageReceipts ?? []).filter(receipt => receipt.state === 'queued' || receipt.state === 'unknown').length
  const selected = dependencies.filter(id => currentIds.has(id))
  const closeDialog = (restoreFocus: boolean) => {
    const origin = keyboardOriginRef.current
    const visible = origin?.isConnected && origin === triggerRef.current && !origin.disabled && !origin.closest('[hidden], [inert], [aria-hidden="true"]') && (() => {
      for (let node: HTMLElement | null = origin; node; node = node.parentElement) {
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || (style.opacity !== '' && Number(style.opacity) === 0)) return false
      }
      return true
    })()
    if (visible && restoreFocus) origin.focus()
    else if (restoreFocus) onReturnFocus?.()
    keyboardOriginRef.current = null
    pendingTriggerFocusRef.current = false
    focusOpenRequestRef.current = false
    setOpen(false)
  }
  return <Box>
    {buttonHost ? createPortal(trigger, buttonHost) : !hideTriggerWithoutHost && trigger}
    {open && <Box role="dialog" aria-label="团队管理" onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !event.currentTarget.contains(event.target as Node)) return
      event.stopPropagation()
      closeDialog(event.currentTarget.contains(document.activeElement))
    }} sx={{ p: 1, maxHeight: 300, maxWidth: 'min(480px, 95%)', overflow: 'auto', position: 'absolute', top: 8, right: 8, zIndex: 1200, bgcolor: 'background.paper', boxShadow: 3, borderRadius: 1 }}>
      <Button ref={dialogCloseButtonRef} size="small" onClick={() => closeDialog(document.activeElement === dialogCloseButtonRef.current)}>关闭团队管理</Button>
      {onAddMember && <Button disabled={Boolean(lead.teamEnded) || draftLocked} onClick={() => { setOpen(false); onAddMember() }}>组建团队 / 添加成员</Button>}
      <Typography variant="subtitle2">共享任务</Typography>
      {validTasks && tasks.length === 0 && <Typography variant="caption" component="div">暂无共享任务</Typography>}
      <Typography variant="caption" component="div">{onDispatch ? '依赖完成后可手动执行' : '任务执行尚未接入'}</Typography>
      <Typography variant="caption" component="div">“完成”与“重开”只修改状态，不会运行或停止任务。</Typography>
      {validTasks && tasks.some(item => item.status === 'running') && <Typography variant="caption" component="div">任务状态不等于执行结果，请查看对应会话确认。</Typography>}
      {onDispatch && validTasks && tasks.some(item => !item.ownerId) && <Typography variant="caption" component="div">组长任务暂不支持执行</Typography>}
      {!validTasks && <Typography color="error">任务依赖无效</Typography>}
      {validTasks && tasks.map((item, taskIndex) => {
        const blockers = teamTaskBlockers(tasks, item)
        const nextStatus = item.status === 'done' ? 'pending' : 'done'
        const reopenBlockedBySuccessor = item.status === 'done' && tasks.some(candidate => candidate.dependsOn.includes(item.id) && (candidate.status === 'running' || candidate.status === 'done'))
        const reopenDescriptionId = `${dependencyDescriptionId}-reopen-${taskIndex}`
        const ownerMatches = members.filter(member => member.id === item.ownerId && item.ownerId !== '')
        let validOwner = false
        if (ownerMatches.length === 1) {
          try { resolveTeamRequestSettings(ownerMatches[0], lead); validOwner = true } catch { /* Stale member. */ }
        }
        const canDispatch = !draftLocked && !!onDispatch && !lead.teamEnded && validOwner && item.status === 'pending' && canSetTeamTaskStatus(tasks, item.id, 'running')
        return <Box key={item.id}>
          <Typography variant="caption">{item.title} · {unconfirmedEntry?.kind === 'task' && unconfirmedEntry.id === item.id ? '未确认 · ' : ''}{item.ownerId ? (members.find(member => member.id === item.ownerId)?.teamMemberName ?? '原成员') : '组长'} · {taskStatusLabel[item.status]} · 依赖 {item.dependsOn.map(id => tasks.find(taskItem => taskItem.id === id)?.title ?? id).join(', ') || '无'}{blockers.length > 0 ? ` · 等待 ${blockers.map(blocker => blocker.title).join(', ')}` : ''}</Typography>
          <Button size="small" aria-label={useDispatchPositionPrefix ? `当前列表第 ${taskIndex + 1} 项（位置随列表变化），执行：${item.title}` : dispatchNames[taskIndex]} disabled={!canDispatch} onClick={() => { if (canDispatch) onDispatch?.(item.id) }}>执行</Button>
          <Button size="small" aria-label={`当前列表第 ${taskIndex + 1} 项（位置随列表变化），${item.status === 'done' ? '重开' : '完成'}：${item.title}`} aria-describedby={reopenBlockedBySuccessor ? reopenDescriptionId : undefined} disabled={draftLocked || !canSetTeamTaskStatus(tasks, item.id, nextStatus)} onClick={() => saveOther({ ...lead, teamTasks: setTeamTaskStatus(tasks, item.id, nextStatus) })}>{item.status === 'done' ? '重开' : '完成'}</Button>
          {reopenBlockedBySuccessor && <Typography id={reopenDescriptionId} variant="caption" component="span">有进行中或已完成的后续任务，无法重开。</Typography>}
          <details><summary aria-label={useDispatchPositionPrefix || (titleCounts.get(normalizeAccessibleName(item.title)) ?? 0) > 1 ? `当前列表第 ${taskIndex + 1} 项（位置随列表变化），编辑依赖 · ${item.title}` : undefined}>编辑依赖 · {item.title}</summary>{tasks.filter(candidate => candidate.id !== item.id).map((candidate, candidateIndex) => {
            const selectedDependency = item.dependsOn.includes(candidate.id)
            const nextDependencies = selectedDependency ? item.dependsOn.filter(id => id !== candidate.id) : [...item.dependsOn, candidate.id]
            let updated: typeof tasks | undefined
            try { updated = setTeamTaskDependencies(tasks, item.id, nextDependencies) } catch { /* Invalid transitions remain disabled. */ }
            const descriptionId = `${dependencyDescriptionId}-${taskIndex}-${candidateIndex}`
            const candidatePosition = taskPositions.get(candidate.id)
            const distinguish = useDependencyPositionPrefix
            return <Box key={candidate.id}><FormControlLabel label={`${item.title} 依赖 ${candidate.title}`} control={<Checkbox checked={selectedDependency} disabled={draftLocked || !updated} inputProps={{ ...(distinguish ? { 'aria-label': `第 ${taskIndex + 1} 项任务依赖第 ${candidatePosition} 项（位置随列表变化）：${item.title} 依赖 ${candidate.title}` } : {}), ...(!updated ? { 'aria-describedby': descriptionId } : {}) }} onChange={() => { if (updated) saveOther({ ...lead, teamTasks: updated }) }} />} />{!updated && <Typography id={descriptionId} variant="caption" component="span">不可选择：任务依赖或状态不允许</Typography>}</Box>
          })}</details>
        </Box>
      })}
      <TextField size="small" label="任务" value={task} onChange={event => { if (!draftLocked) setTask(event.target.value) }} inputProps={{ maxLength: 256, readOnly: draftLocked }} />
      <TextField disabled={draftLocked} select size="small" label="负责人" value={invalidOwner ? invalidOwnerOption : owner} onChange={event => { setOwner(event.target.value); setOwnerNeedsReselection(false) }}>
        {invalidOwner && <MenuItem value={invalidOwnerOption} disabled>原成员（请选择）</MenuItem>}
        <MenuItem value="">组长</MenuItem>{members.map(member => <MenuItem key={member.id} value={member.id}>{member.teamMemberName}</MenuItem>)}
      </TextField>
      {validTasks && tasks.length > 0 && <Box>
        <Typography variant="caption">任务依赖</Typography>
        {tasks.map((item, index) => <FormControlLabel key={item.id} label={item.title} control={<Checkbox disabled={draftLocked} checked={selected.includes(item.id)} inputProps={useDependencyPositionPrefix ? { 'aria-label': `新任务的前置：当前列表第 ${index + 1} 项（位置随列表变化），${item.title}` } : undefined} onChange={event => setDependencies(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />} />)}
      </Box>}
      {draftUnconfirmed && <Typography color="error" variant="caption">保存未确认，请保留草稿并检查会话状态；切换团队前请复制草稿</Typography>}
      <Button disabled={draftLocked || !validTasks || invalidOwner || !task.trim() || tasks.length >= 128} onClick={() => {
        if (invalidOwner) return
        const entry = { id: crypto.randomUUID(), title: task.trim(), ownerId: owner, status: 'pending' as const, dependsOn: selected }
        const updated = [...tasks, entry]
        try { validateTeamTasks(updated); void submitDraft({ ...lead, teamTasks: updated }, { kind: 'task', id: entry.id }, () => { setTask(''); setDependencies([]) }) } catch { /* Invalid graph is not saved. */ }
      }}>添加任务</Button>
      <Typography variant="subtitle2">频道消息</Typography>
      {!(lead.teamChannel?.length) && <Typography variant="caption" component="div">暂无频道记录</Typography>}
      {onSubscriptionChange && <Box role="group" aria-labelledby={subscriptionGroupLabelId}><Typography id={subscriptionGroupLabelId} variant="caption" component="div">成员频道订阅（本次会话）</Typography>{members.map(member => <FormControlLabel key={member.id} label={member.teamMemberName || member.title} control={<Checkbox size="small" disabled={draftLocked || Boolean(lead.teamEnded)} checked={subscriptions?.includes(member.id) ?? false} onChange={event => onSubscriptionChange(member.id, event.target.checked)} />} />)}</Box>}
      <Typography variant="caption" component="div">记录与广播分开；广播会调用模型</Typography>
      {durablePendingReceipts > 0 && <Typography variant="caption" component="div">有 {durablePendingReceipts} 条广播记录待核对；重启后不会自动重发。</Typography>}
      {(lead.teamChannel?.length ?? 0) > 50 && <Typography variant="caption" component="div">此处仅显示最近 50 条频道记录。</Typography>}
      {(lead.teamChannel ?? []).slice(-50).map(item => <Typography key={item.id} variant="caption" component="div" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{unconfirmedEntry?.kind === 'channel' && unconfirmedEntry.id === item.id ? '未确认 · ' : ''}{item.senderId === 'user' ? '用户' : (members.find(member => member.id === item.senderId)?.teamMemberName ?? '原成员')} · {item.text}</Typography>)}
      <TextField size="small" label="频道消息" value={message} onChange={event => { if (!draftLocked) setMessage(event.target.value) }} inputProps={{ maxLength: 2000, readOnly: draftLocked }} />
      {onBroadcast && <><Button aria-describedby={broadcastUnknown ? broadcastUnknownDescriptionId : undefined} disabled={draftLocked || broadcastUnknown || Boolean(lead.teamEnded) || !message.trim()} onClick={() => {
        if (broadcastUnknownRef.current || broadcastPendingRef.current || draftPendingRef.current || otherPendingRef.current || unresolvedDraftRef.current) return
        const text = message.trim(), generation = draftGenerationRef.current
        const input = Object.freeze({ id: crypto.randomUUID(), text })
        broadcastPendingRef.current = true; setBroadcastPending(true); setBroadcastNotice('')
        void Promise.resolve().then(() => {
          if (draftGenerationRef.current !== generation) throw Error('Broadcast context changed.')
          return onBroadcast(input)
        }).then(result => {
          if (draftGenerationRef.current !== generation) return
          const queued = result?.queued
          if (Number.isSafeInteger(queued) && queued > 0) {
            setMessage(current => current.trim() === text ? '' : current)
            setBroadcastNotice('已排队，非送达')
          } else if (queued === 0) setBroadcastNotice('未送出，请检查订阅')
          else { broadcastUnknownRef.current = true; setBroadcastUnknown(true); setBroadcastNotice(broadcastUnknownNotice) }
        }).catch(() => { if (draftGenerationRef.current === generation) { broadcastUnknownRef.current = true; setBroadcastUnknown(true); setBroadcastNotice(broadcastUnknownNotice) } }).finally(() => {
          broadcastPendingRef.current = false
          if (draftGenerationRef.current === generation) setBroadcastPending(false)
        })
      }}>广播给订阅成员</Button>{broadcastNotice && <Typography component="div" variant="caption">{broadcastNotice}</Typography>}{broadcastUnknown && <><Typography id={broadcastUnknownDescriptionId} component="div" variant="caption">可能已排队；没有记录不代表未发送。再次广播可能重复，确认仅允许下次手动广播，不会自动发送。</Typography><Button size="small" aria-describedby={broadcastUnknownDescriptionId} onClick={() => { broadcastUnknownRef.current = false; setBroadcastUnknown(false); setBroadcastNotice('') }}>我已了解风险，允许再次广播</Button></>}</>}
      {(lead.teamChannel?.length ?? 0) >= 200 && <Typography id={channelLimitDescriptionId} variant="caption" component="div">根据当前记录，添加新记录时只提交最后 199 条旧记录和新记录，较早记录不会包含在此次保存内容中；请先另存重要记录。</Typography>}
      <Button aria-describedby={(lead.teamChannel?.length ?? 0) >= 200 ? channelLimitDescriptionId : undefined} disabled={draftLocked || !message.trim()} onClick={() => {
        const entry = { id: crypto.randomUUID(), senderId: 'user', text: message.trim(), createdAt: Date.now() }
        void submitDraft({ ...lead, teamChannel: [...(lead.teamChannel ?? []).slice(-199), entry] }, { kind: 'channel', id: entry.id }, () => setMessage(''))
      }}>添加到频道记录</Button>
      <Typography variant="subtitle2">团队设置</Typography>
      <Typography variant="caption" component="div">成员总数 {members.length} · 上限 {lead.teamSettings?.maxMembers === undefined ? 6 : Number.isInteger(lead.teamSettings.maxMembers) && lead.teamSettings.maxMembers >= 1 && lead.teamSettings.maxMembers <= 6 ? lead.teamSettings.maxMembers : '设置无效'}{pendingOther || draftUnconfirmed ? '（待确认）' : ''}</Typography>
      <TextField type="number" disabled={draftLocked} size="small" label="最大成员数" value={lead.teamSettings?.maxMembers ?? 6} inputProps={{ min: 1, max: 6 }} onChange={event => { const count = Number(event.target.value); if (Number.isInteger(count) && count >= 1 && count <= 6) saveOther({ ...lead, teamSettings: { ...lead.teamSettings, maxMembers: count, defaultModel: lead.teamSettings?.defaultModel ?? null, autoCleanup: lead.teamSettings?.autoCleanup ?? false } }) }} />
      <Typography variant="caption" component="div">{unavailableSelection ? '成员模型设置暂不可用' : '成员未单独选模型时继承组长'}</Typography>
      {unavailableSelection ? <TextField disabled size="small" label="成员默认模型" value="设置暂不可用" /> : <TextField select disabled={draftLocked} size="small" label="成员默认模型" value={currentModel} onChange={event => { const selected = event.target.value; if (selected && (selected !== lead.profileId || !models.some(model => model.id === selected))) return; saveOther({ ...lead, teamSettings: { ...lead.teamSettings, maxMembers: lead.teamSettings?.maxMembers ?? 6, defaultModel: selected || null, autoCleanup: lead.teamSettings?.autoCleanup ?? false } }) }}>
        {missingModel && <MenuItem value={currentModel} disabled>原模型不可用</MenuItem>}
        <MenuItem value="">继承组长</MenuItem>{models.map(model => <MenuItem key={model.id} value={model.id} disabled={model.id !== lead.profileId}>{model.name}</MenuItem>)}
      </TextField>}
      <FormControlLabel label="结束后归档成员" control={<Checkbox disabled={draftLocked} checked={lead.teamSettings?.autoCleanup ?? false} onChange={event => saveOther({ ...lead, teamSettings: { ...lead.teamSettings, maxMembers: lead.teamSettings?.maxMembers ?? 6, defaultModel: lead.teamSettings?.defaultModel ?? null, autoCleanup: event.target.checked } })} />} />
      {message && !lead.teamEnded && <Typography id={endDraftDescriptionId} variant="caption" component="div">结束团队前请复制未发送的频道草稿，结束后不保证保留。</Typography>}
      <Button aria-describedby={message && !lead.teamEnded ? endDraftDescriptionId : undefined} disabled={draftLocked || Boolean(lead.teamEnded)} onClick={endTeam}>{lead.teamEnded ? '团队已结束' : '结束团队'}</Button>
      <Typography variant="caption">嵌套深度 1</Typography>
    </Box>}
  </Box>
}
