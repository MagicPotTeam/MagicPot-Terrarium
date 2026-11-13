import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentGoalView } from '@shared/api/agentThreadGoal'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ revision: vi.fn(), bind: vi.fn(), list: vi.fn(), mutate: vi.fn() }))
vi.mock('../../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: { agentGoalScopeRevision: h.revision, setAgentGoalScope: h.bind, listAgentGoals: h.list, mutateAgentGoal: h.mutate } }) }))
import Host from './AgentThreadGoalRecordsHost'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'synthetic-project', threadId: 'synthetic-pane' } as const
const props = { route, active: true, remote: false }
const empty = { revision: 0, goals: [], untrustedData: true as const, grantsPermission: false as const }
type Request = { route: typeof route; conversationId: string; active: boolean; lifecycleRevision: number }
type Event = { phase: string; key: string; active: boolean; revision: number }
const gates = new Set<() => void>()
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); gates.add(release); return { promise, release } }
const releaseAll = () => { for (const release of gates) release(); gates.clear() }
// Preserve the original assertion failure alongside every cleanup failure.
async function guarded(body: () => Promise<void>, steps: (() => void | Promise<void>)[]) {
  const errors: unknown[] = []
  try { await body() } catch (error) { errors.push(error) }
  try { releaseAll() } catch (error) { errors.push(error) }
  for (const step of steps) { try { await step() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Test or cleanup failed; queue drain is not guaranteed')
}

// Single sender, fixed normalized synthetic route. Authorization and actual Electron leases are not modeled.
class SenderModel {
  binding: { revision: number; key: string; token: string; live: boolean } | undefined
  sequence = 0
  events: Event[] = []
  io: { phase: string; key: string }[] = []
  revision() { return { revision: this.binding?.revision ?? 0 } }
  commit(req: Request) {
    const { active, lifecycleRevision: revision, conversationId: key } = req
    if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER || typeof active !== 'boolean' || Object.keys(req).some(k => !['route', 'conversationId', 'active', 'lifecycleRevision'].includes(k))) throw Error('Invalid lifecycle')
    if (this.binding && revision < this.binding.revision) throw Error('Stale lifecycle')
    const binding = this.binding ?? (this.binding = { revision: 0, key: '', token: '', live: false })
    if (!active) {
      if (revision === binding.revision && binding.key !== key) throw Error('Lifecycle conflict')
      Object.assign(binding, { revision, key, token: '', live: false })
      return {}
    }
    if (revision === binding.revision) {
      if (binding.key !== key || !binding.token || !binding.live) throw Error('Retired lifecycle')
      return { documentToken: binding.token }
    }
    const token = `synthetic-token-${++this.sequence}`
    Object.assign(binding, { revision, key, token, live: true })
    return { documentToken: token }
  }
  assertLive(key: string, token: string) {
    if (!this.binding?.live || this.binding.key !== key || this.binding.token !== token) throw Error('Lease invalid')
  }
}

type Controls = { matches: (req: Request) => boolean; commit: ReturnType<typeof gate>; response: ReturnType<typeof gate>; reject: boolean }
function install(model: SenderModel, controls?: Controls) {
  h.revision.mockImplementation(async () => model.revision())
  h.bind.mockImplementation(async (req: Request) => {
    const event = (phase: string) => model.events.push({ phase, key: req.conversationId, active: req.active, revision: req.lifecycleRevision })
    event('call')
    const controlled = controls && controls.matches(req) ? controls : undefined
    if (controlled) await controlled.commit.promise
    const result = model.commit(req)
    event('commit')
    if (controlled) await controlled.response.promise
    if (controlled?.reject) { event('reject'); throw Error('Synthetic response lost after commit') }
    event('resolve')
    return result
  })
  h.list.mockImplementation(async (req: { conversationId: string; documentToken: string }) => {
    model.io.push({ phase: 'list-call', key: req.conversationId })
    model.assertLive(req.conversationId, req.documentToken)
    await Promise.resolve()
    model.assertLive(req.conversationId, req.documentToken)
    model.io.push({ phase: 'list-response', key: req.conversationId })
    return empty
  })
  h.mutate.mockImplementation(() => { throw Error('Unexpected mutation') })
}
const has = (model: SenderModel, phase: string, key: string, active: boolean) => model.events.some(e => e.phase === phase && e.key === key && e.active === active)
async function ready() { await waitFor(() => expect(screen.getByLabelText('Goal title')).not.toBeDisabled()) }
// A fresh Host acts as a barrier behind all previously enqueued cleanup work.
async function barrier(model: SenderModel, key: string) {
  const page = render(<Host {...props} conversationId={key} />)
  await guarded(async () => { await ready() }, [
    () => page.unmount(),
    () => waitFor(() => expect(has(model, 'resolve', key, false)).toBe(true)),
  ])
}

beforeEach(() => { vi.clearAllMocks(); h.revision.mockReset(); h.bind.mockReset(); h.list.mockReset(); h.mutate.mockReset(); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('Unexpected network'))) })
afterEach(() => { releaseAll(); vi.unstubAllGlobals() })

describe('synthetic single-sender goal scope protocol', () => {
  it('retires a different key on newer false and rejects stale and equal-revision conflicts', () => {
    const model = new SenderModel()
    const req = (conversationId: string, active: boolean, lifecycleRevision: number) => ({ route, conversationId, active, lifecycleRevision })
    const token = model.commit(req('C', true, 3)).documentToken!
    expect(() => model.commit(req('A', false, 2))).toThrow('Stale')
    expect(() => model.commit(req('A', false, 3))).toThrow('conflict')
    expect(model.binding).toMatchObject({ key: 'C', revision: 3, token, live: true })
    model.commit(req('A', false, 4))
    expect(model.binding).toEqual({ key: 'A', revision: 4, token: '', live: false })
    expect(() => model.assertLive('C', token)).toThrow('Lease invalid')
    expect(() => model.commit(req('A', true, 4))).toThrow('Retired')
  })

  it('keeps C queued through A false commit and lost response, then binds C with the new revision', async () => {
    const model = new SenderModel()
    const controls = { matches: (r: Request) => !r.active && r.conversationId === 'A', commit: gate(), response: gate(), reject: true }
    install(model, controls)
    const page = render(<Host {...props} conversationId="A" />)
    await guarded(async () => {
      await ready()
      page.rerender(<Host {...props} conversationId="C" />)
      await waitFor(() => expect(has(model, 'call', 'A', false)).toBe(true))
      expect(has(model, 'commit', 'A', false)).toBe(false)
      expect(has(model, 'call', 'C', true)).toBe(false)
      await act(async () => { controls.commit.release(); await controls.commit.promise })
      await waitFor(() => expect(has(model, 'commit', 'A', false)).toBe(true))
      expect(model.binding).toMatchObject({ revision: 2, key: 'A', token: '', live: false })
      expect(has(model, 'reject', 'A', false)).toBe(false)
      expect(has(model, 'call', 'C', true)).toBe(false)
      await act(async () => { controls.response.release(); await controls.response.promise })
      await waitFor(() => expect(has(model, 'resolve', 'C', true)).toBe(true))
      await ready()
      expect(model.events.filter(e => e.key === 'C' && e.active && e.phase === 'commit')[0].revision).toBe(3)
      expect(model.events.findIndex(e => e.key === 'A' && e.phase === 'reject')).toBeLessThan(model.events.findIndex(e => e.key === 'C' && e.phase === 'call'))
      expect(model.binding).toMatchObject({ key: 'C', revision: 3, live: true })
      expect(h.mutate).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    }, [() => page.unmount(), () => barrier(model, 'barrier-false')])
  })

  it('records the bounded A to B to A to C pending-mutation queue behavior', async () => {
    const model = new SenderModel()
    const mutation = gate()
    const a = 'pending-model-a', b = 'pending-model-b', c = 'pending-model-c'
    const view: AgentGoalView = { ...empty, goals: [{ id: 'synthetic-goal', title: 'Synthetic goal', generation: 1, status: 'active', spec: { objective: 'Synthetic objective', successCriteria: [], constraints: [], autonomy: 'manual', completionPolicy: 'user_confirm', budgets: { maxTurns: 1, maxToolCalls: 1, maxWalltimeSeconds: 60 } }, createdAt: 1, updatedAt: 1, reason: '' }] }
    install(model)
    h.list.mockImplementation(async (req: { conversationId: string; documentToken: string }) => {
      model.io.push({ phase: 'list-call', key: req.conversationId })
      model.assertLive(req.conversationId, req.documentToken)
      await Promise.resolve()
      model.assertLive(req.conversationId, req.documentToken)
      model.io.push({ phase: 'list-response', key: req.conversationId })
      return view
    })
    // This fake checks the lease at call, then returns a synthetic unknown outcome after release;
    // it does not claim a real MAIN mutation can commit after its lease was retired.
    h.mutate.mockImplementation(async (req: { conversationId: string; documentToken: string }) => {
      model.io.push({ phase: 'mutate-call', key: req.conversationId })
      model.assertLive(req.conversationId, req.documentToken)
      await mutation.promise
      model.io.push({ phase: 'mutate-response', key: req.conversationId })
      return { status: 'synthetic-unknown' }
    })
    const count = (phase: string, key: string) => model.io.filter(e => e.phase === phase && e.key === key).length
    const binds = (key: string) => model.events.filter(e => e.phase === 'resolve' && e.active && e.key === key).length
    const page = render(<Host {...props} conversationId={a} />)
    let current = a
    let previous = 0
    await guarded(async () => {
      await screen.findByLabelText('Progress for Synthetic goal')
      fireEvent.change(screen.getByLabelText('Progress for Synthetic goal'), { target: { value: 'Synthetic progress' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save progress for Synthetic goal' }))
      expect(count('mutate-call', a)).toBe(1)
      page.rerender(<Host {...props} conversationId={b} />); current = b
      await waitFor(() => expect(count('list-response', b)).toBe(1))
      page.rerender(<Host {...props} conversationId={a} />); current = a
      await waitFor(() => expect(binds(a)).toBe(2))
      expect(count('list-call', a)).toBe(1)
      expect(screen.queryByRole('button', { name: 'I reviewed the goals' })).not.toBeInTheDocument()
      page.rerender(<Host {...props} conversationId={c} />); current = c
      // Bounded observation after the second A bind, not a claim of permanent deadlock.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      expect(model.events.some(e => e.key === c && e.active && e.phase === 'call')).toBe(false)
      expect(count('list-call', c)).toBe(0)
      await act(async () => { mutation.release(); await mutation.promise })
      await waitFor(() => expect(count('list-response', c)).toBe(1))
      expect(count('mutate-response', a)).toBe(1)
      expect(count('mutate-call', a)).toBe(1)
      page.rerender(<Host {...props} conversationId={a} />); current = a
      await waitFor(() => expect(count('list-response', a)).toBe(2))
      expect(await screen.findByRole('button', { name: 'I reviewed the goals' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save progress for Synthetic goal' })).toBeDisabled()
      expect(count('mutate-call', a)).toBe(1)
      expect(h.mutate).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
    }, [
      () => { previous = model.events.filter(e => e.key === current && !e.active && e.phase === 'resolve').length; page.unmount() },
      () => waitFor(() => expect(model.events.filter(e => e.key === current && !e.active && e.phase === 'resolve').length).toBeGreaterThan(previous)),
      () => barrier(model, 'barrier-pending-model'),
    ])
  })

  it('cleans up a true that committed before its response rejects after unmount', async () => {
    const model = new SenderModel()
    const controls = { matches: (r: Request) => r.active && r.conversationId === 'old', commit: gate(), response: gate(), reject: true }
    install(model, controls)
    const page = render(<Host {...props} conversationId="old" />)
    await guarded(async () => {
      await waitFor(() => expect(has(model, 'call', 'old', true)).toBe(true))
      await act(async () => { controls.commit.release(); await controls.commit.promise })
      await waitFor(() => expect(has(model, 'commit', 'old', true)).toBe(true))
      expect(model.binding).toMatchObject({ key: 'old', revision: 1, live: true })
      page.unmount()
      expect(has(model, 'call', 'old', false)).toBe(false)
      await act(async () => { controls.response.release(); await controls.response.promise })
      await waitFor(() => expect(has(model, 'resolve', 'old', false)).toBe(true))
      expect(model.events.findIndex(e => e.key === 'old' && e.phase === 'reject')).toBeLessThan(model.events.findIndex(e => e.key === 'old' && !e.active && e.phase === 'call'))
      await barrier(model, 'new')
      expect(has(model, 'resolve', 'new', true)).toBe(true)
      expect(h.mutate).not.toHaveBeenCalled()
    }, [() => page.unmount(), () => barrier(model, 'barrier-true')])
  })
})
