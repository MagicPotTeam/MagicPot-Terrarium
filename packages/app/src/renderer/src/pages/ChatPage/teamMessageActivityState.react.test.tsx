import { act, render, screen } from '@testing-library/react'
import { StrictMode, useEffect, useReducer, useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TeamMessageDispatcher, type TeamDispatchStage, type TeamMessageSource } from './teamMessageDispatcher'
import type { TeamMessageDelivery } from './teamMessageService'
import { reduceTeamActivity, selectTeamActivity, type TeamActivityState } from './teamMessageActivityState'

// This is a synthetic host, not ChatPage, the real IPC transport or a delivery receipt.
const INITIAL: TeamActivityState = { owner: 0, key: '', entries: [], activeKey: '', live: false, closedFor: null }
const team = { scope: 'fixture-scope', thread: 'fixture-thread', lead: 'fixture-lead' }
const memberSource = { ...team, kind: 'member' as const, member: 'alice' }
const intent = (id: string, recipient: string) => ({ id, source: memberSource, kind: 'message' as const, hop: 1 as const, recipient, text: `synthetic ${id}` })

type HarnessProps = {
  active: boolean
  identity: { scope: string; thread: string; lead: string; generation: number }
  host: {
    deliver: ReturnType<typeof vi.fn<(delivery: TeamMessageDelivery, source: TeamMessageSource, stage: (stage: TeamDispatchStage) => void, hop: 1 | 2) => Promise<void>>>
    current: TeamMessageDispatcher | null
  }
  gateClosed?: boolean
}

function Harness({ active, identity, host, gateClosed }: HarnessProps) {
  const [activity, dispatch] = useReducer(reduceTeamActivity, INITIAL)
  const counter = useRef(0)
  const key = JSON.stringify([identity.scope, 'canvas', 'thread', 'fixture-project', identity.thread, identity.lead, identity.generation])
  useEffect(() => {
    if (!active) return
    const owner = ++counter.current
    dispatch({ type: 'begin', owner, key })
    const dispatcher = new TeamMessageDispatcher(identity, () => true, id => ['alice', 'bob', 'carol', 'dan', 'erin'].includes(id), [], host.deliver,
      entries => dispatch({ type: 'observe', owner, key, entries }), 100, id => id === 'bob')
    host.current = dispatcher
    return () => {
      dispatch({ type: 'end', owner, key })
      dispatcher.end()
      if (host.current === dispatcher) host.current = null
    }
  }, [active, host, key, identity.scope, identity.thread, identity.lead])
  useEffect(() => {
    if (gateClosed && host.current) dispatch({ type: 'close', owner: counter.current, key })
  }, [gateClosed, host, key])
  const visible = active ? selectTeamActivity(activity, key, gateClosed) : []
  return <ul aria-label="synthetic activity">{visible.map(entry => <li key={`${entry.intent.id}:${entry.recipient}`}>
    {entry.intent.id}:{entry.status}
  </li>)}</ul>
}

describe('team activity host reducer with React lifecycle', () => {
  it('shows the host-gated state as unknown without stopping or replacing the dispatcher', async () => {
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const deliver = vi.fn(async (_delivery: TeamMessageDelivery, _source: TeamMessageSource, stage: (stage: TeamDispatchStage) => void, _hop: 1 | 2) => { stage('request_started'); await gate })
    const host = { deliver, current: null as TeamMessageDispatcher | null }
    const identity = { ...team, generation: 1 }
    const view = render(<Harness active identity={identity} host={host} />)
    let held: Promise<void> | undefined
    try {
      const dispatcher = host.current!
      await act(async () => {
        dispatcher.enqueue(intent('gate-waiting', 'bob'))
        dispatcher.enqueue(intent('gate-started', 'carol'))
        held = dispatcher.pump('carol')
      })
      expect(screen.getByText('gate-waiting:queued')).toBeVisible()
      expect(screen.getByText('gate-started:request_started')).toBeVisible()
      view.rerender(<Harness active identity={identity} host={host} gateClosed />)
      expect(screen.getByText('gate-waiting:unknown')).toBeVisible()
      expect(screen.getByText('gate-started:unknown')).toBeVisible()
      expect(host.current).toBe(dispatcher)
      expect(dispatcher.entries().map(item => item.status)).toEqual(['queued', 'request_started'])
      expect(deliver).toHaveBeenCalledTimes(1)
      view.rerender(<Harness active identity={identity} host={host} />)
      expect(screen.getByText('gate-waiting:unknown')).toBeVisible()
      expect(screen.getByText('gate-started:unknown')).toBeVisible()
      expect(host.current).toBe(dispatcher)
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => { release(); await held })
      view.unmount()
    }
  })

  it('keeps completed evidence across a StrictMode effect replay and a quiet other identity', async () => {
    const deliver = vi.fn(async (_delivery: TeamMessageDelivery, _source: TeamMessageSource, stage: (stage: TeamDispatchStage) => void, _hop: 1 | 2) => {
      stage('request_started')
      stage('response_received')
    })
    const host = { deliver, current: null as TeamMessageDispatcher | null }
    const identity = { ...team, generation: 1 }
    const root = (props: HarnessProps) => <StrictMode><Harness {...props} /></StrictMode>
    const view = render(root({ active: true, identity, host }))
    try {
      const dispatcher = host.current!
      await act(async () => {
        dispatcher.enqueue(intent('strict-completed', 'dan'))
        await dispatcher.pump('dan')
      })
      expect(screen.getByText('strict-completed:response_received')).toBeVisible()
      expect(deliver).toHaveBeenCalledTimes(1)
      view.rerender(root({ active: true, identity: { ...identity, scope: 'other-scope' }, host }))
      expect(screen.queryByText(/strict-completed:/)).not.toBeInTheDocument()
      view.rerender(root({ active: true, identity, host }))
      expect(screen.getByText('strict-completed:response_received')).toBeVisible()
      expect(host.current?.entries()).toEqual([])
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })

  it('marks interrupted observations unknown, retains terminal evidence, and refuses stale owners without replay', async () => {
    let release = () => {}
    let lateStage: ((stage: TeamDispatchStage) => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const deliver = vi.fn(async (item: TeamMessageDelivery, _source: TeamMessageSource, stage: (stage: TeamDispatchStage) => void, _hop: 1 | 2) => {
      if (item.recipient === 'carol') { lateStage = stage; stage('request_started'); await gate; return }
      if (item.recipient === 'dan') { stage('request_started'); stage('response_received') }
    })
    const host = { deliver, current: null as TeamMessageDispatcher | null }
    const identity = { ...team, generation: 1 }
    const view = render(<Harness active identity={identity} host={host} />)
    let held: Promise<void> | undefined
    try {
      const old = host.current!
      let completed: Promise<void> | undefined
      await act(async () => {
        old.enqueue(intent('waiting', 'bob'))
        old.enqueue(intent('started', 'carol'))
        old.enqueue(intent('completed', 'dan'))
        held = old.pump('carol')
        completed = old.pump('dan')
        await completed
      })
      expect(held).toBeInstanceOf(Promise)
      expect(completed).toBeInstanceOf(Promise)
      expect(screen.getByText('waiting:queued')).toBeVisible()
      expect(screen.getByText('started:request_started')).toBeVisible()
      expect(screen.getByText('completed:response_received')).toBeVisible()
      view.rerender(<Harness active={false} identity={identity} host={host} />)
      expect(screen.queryByText(/waiting:/)).not.toBeInTheDocument()
      view.rerender(<Harness active identity={identity} host={host} />)
      expect(screen.getByText('waiting:unknown')).toBeVisible()
      expect(screen.getByText('started:unknown')).toBeVisible()
      expect(screen.getByText('completed:response_received')).toBeVisible()
      expect(host.current).not.toBe(old)
      expect(host.current?.entries()).toEqual([])
      expect(deliver).toHaveBeenCalledTimes(2)
      await act(async () => { lateStage?.('response_received'); release(); await held })
      expect(screen.getByText('started:unknown')).toBeVisible()
      expect(screen.getByText('completed:response_received')).toBeVisible()
      expect(deliver).toHaveBeenCalledTimes(2)
      const replacement = host.current!
      await act(async () => {
        replacement.enqueue(intent('fresh', 'erin'))
      })
      expect(screen.getByText('fresh:queued')).toBeVisible()
      expect(screen.queryByText(/waiting:/)).not.toBeInTheDocument()
      expect(deliver).toHaveBeenCalledTimes(2)
      view.rerender(<Harness active identity={{ ...identity, thread: 'other-thread' }} host={host} />)
      expect(screen.queryByText(/fresh:/)).not.toBeInTheDocument()
      view.rerender(<Harness active identity={{ ...identity, generation: 2 }} host={host} />)
      expect(screen.queryByText(/fresh:/)).not.toBeInTheDocument()
    } finally {
      await act(async () => { release(); await held })
      view.unmount()
    }
  })
})
