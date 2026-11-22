import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuarantineState, reduceQuarantineState, canCloseSyntheticEndpoint } from './syntheticQuarantineState.mjs'

// All identifiers and events are synthetic. trusted-tree-empty is an explicit
// assumed premise supplied by the caller, not nonce verification or OS evidence.
const run = 'fake-run-a'
const endpoint = 'fake-endpoint-a'
const create = (r = run, e = endpoint) => createQuarantineState({ runId: r, endpointId: e })
const step = (state, type, extra = {}) => reduceQuarantineState(state, { type, ...extra })
const evidence = (state, r = run) => step(state, 'trusted-tree-empty', { runId: r })
const blocked = state => assert.equal(canCloseSyntheticEndpoint(state), false)
const closable = state => assert.equal(canCloseSyntheticEndpoint(state), true)

test('only explicit matching trusted-tree-empty premise permits closing', () => {
  const initial = create()
  blocked(initial)
  for (const type of ['launch-started', 'launch-succeeded', 'launch-failed', 'launch-timeout', 'root-exited', 'untrusted-empty-receipt']) {
    blocked(step(initial, type, { runId: run }))
  }
  blocked(evidence(initial, 'fake-old-run'))
  closable(evidence(initial))
})

test('after trusted empty any contradictory or indeterminate event revokes permission', () => {
  const ready = evidence(create())
  for (const type of ['launch-started', 'launch-succeeded', 'launch-failed', 'launch-timeout', 'cancelled', 'owner-lost', 'mock-active', 'mock-incomplete']) {
    const invalidated = step(ready, type, { runId: run })
    blocked(invalidated)
    blocked(evidence(invalidated))
  }
})

test('close-start atomically consumes permission; failure, timeout and late events cannot authorize retry', () => {
  for (const outcome of ['close-failed', 'close-timeout']) {
    const ready = evidence(create())
    const closing = step(ready, 'close-start', { runId: run, endpointId: endpoint })
    blocked(closing)
    const unknown = step(closing, outcome, { runId: run, endpointId: endpoint })
    blocked(unknown)
    assert.deepEqual(step(unknown, 'close-start', { runId: run, endpointId: endpoint }), unknown)
    blocked(evidence(unknown))
    blocked(step(unknown, 'close-succeeded', { runId: run, endpointId: endpoint }))
  }
})

test('closed endpoint cannot be resent or closed a second time', () => {
  const closing = step(evidence(create()), 'close-start', { runId: run, endpointId: endpoint })
  const closed = step(closing, 'close-succeeded', { runId: run, endpointId: endpoint })
  blocked(closed)
  assert.deepEqual(step(closed, 'close-start', { runId: run, endpointId: endpoint }), closed)
  blocked(evidence(closed))
})

test('separate fake identities and event ordering cannot borrow close authority', () => {
  const a = create(), b = create('fake-run-b', 'fake-endpoint-b')
  const aReady = evidence(a)
  blocked(evidence(b, run))
  blocked(step(aReady, 'close-start', { runId: run, endpointId: 'fake-endpoint-b' }))
  closable(aReady)
  blocked(step(a, 'close-succeeded', { runId: run, endpointId: endpoint }))
  const bReady = evidence(b, 'fake-run-b')
  closable(bReady)
  const bClosing = step(bReady, 'close-start', { runId: 'fake-run-b', endpointId: 'fake-endpoint-b' })
  blocked(bClosing)
  closable(aReady)
})

test('errors and cancellation preserve unknown despite late success or trusted-empty events', () => {
  for (const type of ['launch-failed', 'launch-timeout', 'cancelled']) {
    const unknown = step(create(), type, { runId: run })
    blocked(unknown)
    blocked(step(unknown, 'launch-succeeded', { runId: run }))
    blocked(step(unknown, 'root-exited', { runId: run }))
    blocked(evidence(unknown))
  }
})
