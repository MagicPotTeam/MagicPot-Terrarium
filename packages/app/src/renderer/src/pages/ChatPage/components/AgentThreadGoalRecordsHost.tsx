import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRouteLike } from '@shared/agent'
import { AGENT_GOAL_LIMITS } from '@shared/api/agentThreadGoal'
import type { AgentGoalView } from '@shared/api/agentThreadGoal'
import { api } from '../../../utils/windowUtils'
import AgentThreadGoalRecordsPanel, { type AgentThreadGoalCreateIntent, type AgentThreadGoalControlIntent, type AgentThreadGoalReportIntent, type AgentThreadGoalReportAck, type AgentThreadGoalDecisionIntent } from './AgentThreadGoalRecordsPanel'

type Scope = { route: AgentRouteLike; conversationId: string }
type Bound = Scope & { documentToken: string }
// One renderer document corresponds to one Electron sender. Only one mounted
// host owns the binding; another host fails closed rather than stealing it.
let owner: symbol | undefined
let serial: Promise<void> = Promise.resolve()
const uncertainScopes = new Set<string>()
const pendingMutations = new Map<string, Promise<void>>()
function enqueue(task: () => Promise<void>): void { serial = serial.then(task, task).catch(() => {}) }
const validReportSummary = (value: string) => Boolean(value.trim()) && value.length <= AGENT_GOAL_LIMITS.summary && !value.includes('\0')
const service = () => api().svcLLMProxy

export default function AgentThreadGoalRecordsHost({ route, conversationId, active, remote }: { route?: AgentRouteLike; conversationId?: string; active: boolean; remote: boolean }) {
  const key = active && !remote && route?.channel === 'canvas' && route.scopeType === 'thread' && conversationId ? JSON.stringify({ route, conversationId }) : ''
  const scope = useMemo(() => key ? JSON.parse(key) as Scope : undefined, [key])
  return scope ? <GoalBinding key={key} scope={scope} /> : null
}
function GoalBinding({ scope }: { scope: Scope }) {
  const identity = useRef(Symbol('goal-owner')).current
  const [view, setView] = useState<AgentGoalView | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<string | null>(() => uncertainScopes.has(JSON.stringify(scope)) ? 'Result unknown. Review the refreshed goals before continuing.' : null)
  const scopeKey = JSON.stringify(scope)
  const [unknown, setUnknown] = useState(() => uncertainScopes.has(scopeKey))
  const [formVersion, setFormVersion] = useState(0)
  const [reportAck, setReportAck] = useState<AgentThreadGoalReportAck>()
  const reportSequence = useRef(0)
  const [loadVersion, setLoadVersion] = useState(0)
  const generation = useRef(0)
  const state = useRef<{ live: boolean; bound?: Bound; view: AgentGoalView | null; lock: boolean; uncertain: boolean }>({ live: false, view: null, lock: false, uncertain: uncertainScopes.has(scopeKey) })
  useEffect(() => {
    const s = state.current, epoch = ++generation.current
    const isCurrent = () => s.live && generation.current === epoch && owner === identity
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelDelay: (() => void) | undefined
    const delay = () => new Promise<void>(resolve => {
      cancelDelay = resolve
      timer = setTimeout(() => { timer = undefined; cancelDelay = undefined; resolve() }, 1000)
    })
    s.live = true
    if (owner && owner !== identity) { setPending(false); setError('Another goal panel is active.'); return () => { s.live = false } }
    owner = identity
    enqueue(async () => {
      if (!isCurrent()) return
      try {
        const { revision } = await service().agentGoalScopeRevision(scope)
        if (!isCurrent()) return
        const result = await service().setAgentGoalScope({ ...scope, active: true, lifecycleRevision: revision + 1 })
        if (!result.documentToken) throw Error('Missing scope token')
        const bound = { ...scope, documentToken: result.documentToken }
        if (!isCurrent()) return
        s.bound = bound
        await pendingMutations.get(scopeKey)
        if (!isCurrent()) return
        let data: AgentGoalView | undefined
        for (let attempt = 0; attempt < 13; attempt++) {
          if (!isCurrent()) return
          try { data = await service().listAgentGoals(bound); break }
          catch (error) { if (!isCurrent()) return; if (attempt === 12) throw error; await delay() }
        }
        if (!isCurrent() || !data) return
        s.view = data; setView(data); setPending(false)
      } catch { if (isCurrent()) { setPending(false); setError('Goals unavailable.') } }
    })
    return () => {
      generation.current++; s.live = false; s.bound = undefined; s.view = null
      if (timer !== undefined) clearTimeout(timer)
      cancelDelay?.()
      if (owner !== identity) return
      owner = undefined
      enqueue(async () => {
        try {
          const { revision } = await service().agentGoalScopeRevision(scope)
          await service().setAgentGoalScope({ ...scope, active: false, lifecycleRevision: revision + 1 })
        } catch { /* document may have closed */ }
      })
    }
  }, [identity, scope, loadVersion])
  const acknowledge = () => { uncertainScopes.delete(scopeKey); state.current.uncertain = false; setUnknown(false); setError(null) }
  const mutate = (intent: AgentThreadGoalCreateIntent | AgentThreadGoalControlIntent | AgentThreadGoalReportIntent | AgentThreadGoalDecisionIntent, kind: 'create' | 'control' | 'report' | 'decision') => {
    const s = state.current, bound = s.bound, current = s.view, epoch = generation.current
    const isCurrent = () => s.live && generation.current === epoch && owner === identity
    if (!s.live || owner !== identity || s.lock || s.uncertain || !bound || !current) return
    const selected = kind !== 'create' && 'goalId' in intent ? current.goals.find(goal => goal.id === intent.goalId) : undefined
    if (kind === 'control' && (!selected || !('status' in intent) || !(intent.status === 'active' ? ['draft', 'paused'].includes(selected.status) : ['active', 'waiting', 'blocked'].includes(selected.status)))) return
    if (kind === 'report' && (!selected || !['active', 'waiting', 'blocked'].includes(selected.status) || !('summary' in intent) || !validReportSummary(intent.summary))) return
    if (kind === 'decision') {
      if (!('action' in intent) || !['confirm', 'reject-proposal'].includes(intent.action) || !selected || !selected.proposal || !['active', 'waiting', 'blocked', 'paused'].includes(selected.status) ||
        current.revision !== intent.revision || selected.generation !== intent.generation ||
        JSON.stringify(selected.proposal) !== JSON.stringify(intent.proposal)) return
    }
    const operationId = crypto.randomUUID(), goalId = kind === 'create' ? crypto.randomUUID() : selected!.id
    const command = kind === 'create' && 'spec' in intent ? { action: 'create' as const, goalId, title: intent.title, spec: intent.spec }
      : kind === 'report' && 'summary' in intent ? { action: 'report' as const, goalId, expectedGeneration: selected!.generation, summary: intent.summary, evidence: [] as string[] }
      : kind === 'decision' && 'action' in intent ? intent.action === 'confirm'
        ? { action: 'confirm' as const, goalId, expectedGeneration: intent.generation, outcome: intent.proposal.outcome }
        : { action: 'reject-proposal' as const, goalId, expectedGeneration: intent.generation }
      : { action: 'control' as const, goalId, expectedGeneration: selected!.generation, status: (intent as AgentThreadGoalControlIntent).status, reason: 'User changed goal status' }
    s.lock = true; uncertainScopes.add(scopeKey); setPending(true); setError(null)
    let settle!: () => void
    const pendingMutation = new Promise<void>(resolve => { settle = resolve })
    pendingMutations.set(scopeKey, pendingMutation)
    void (async () => {
      try {
        const result = await service().mutateAgentGoal({ ...bound, ...command, expectedRevision: current.revision, operationId })
        if (!isCurrent()) return
        if (result.status !== 'applied' || result.operationId !== operationId) throw Error('Outcome unknown')
        uncertainScopes.delete(scopeKey); s.view = result; setView(result)
        if (kind === 'create') setFormVersion(version => version + 1)
        if (kind === 'report' && 'summary' in intent) setReportAck({ sequence: ++reportSequence.current, goalId, summary: intent.summary })
      } catch {
        if (!isCurrent()) return
        s.uncertain = true; setUnknown(true); setError('Result unknown. Review the refreshed goals before continuing.')
        try { const refreshed = await service().listAgentGoals(bound); if (isCurrent()) { s.view = refreshed; setView(refreshed) } } catch { if (isCurrent()) { s.view = null; setView(null); setError('Result unknown. Refresh unavailable; reopen to review.') } }
      } finally { if (pendingMutations.get(scopeKey) === pendingMutation) pendingMutations.delete(scopeKey); settle(); if (isCurrent()) { s.lock = false; setPending(false) } }
    })()
  }
  return <><AgentThreadGoalRecordsPanel createResetVersion={formVersion} reportAck={reportAck} view={view} pending={pending || unknown} error={error} onCreate={intent => mutate(intent, 'create')} onControl={intent => mutate(intent, 'control')} onReport={intent => mutate(intent, 'report')} onDecision={intent => mutate(intent, 'decision')} />{!view && !pending && error ? <button type="button" onClick={() => { setPending(true); setError(unknown ? 'Result unknown. Review the refreshed goals before continuing.' : null); setLoadVersion(version => version + 1) }}>Retry loading goals</button> : null}{unknown && !pending && view ? <button type="button" onClick={acknowledge}>I reviewed the goals</button> : null}</>
}
