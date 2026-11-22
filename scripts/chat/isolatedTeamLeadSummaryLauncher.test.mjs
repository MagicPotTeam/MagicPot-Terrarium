import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { cleanupOwnedSummaryResources, providerSettledExactlyOnce, sendOnceWithDurableAttempt } from './isolatedTeamLeadSummaryLauncher.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('failed durable write prevents click and consumes this owner', async () => {
  const owner = {}, calls = []
  await assert.rejects(sendOnceWithDurableAttempt(owner, async () => { calls.push('persist'); throw Error('synthetic write failure') }, async () => calls.push('click')), /write failure/)
  assert.deepEqual(calls, ['persist'])
  await assert.rejects(sendOnceWithDurableAttempt(owner, async () => {}, async () => calls.push('click')), /no replay/)
  assert.deepEqual(calls, ['persist'])
})

test('reservation is synchronous during pending durable write; successful click occurs only once after acknowledgement', async () => {
  const owner = {}, gate = deferred(), calls = []
  const first = sendOnceWithDurableAttempt(owner, () => { calls.push('persist'); return gate.promise }, async () => { calls.push('click') })
  try {
    await assert.rejects(sendOnceWithDurableAttempt(owner, async () => {}, async () => calls.push('second')), /no replay/)
    assert.deepEqual(calls, ['persist'])
    gate.resolve(); await first
    assert.deepEqual(calls, ['persist', 'click'])
    await assert.rejects(sendOnceWithDurableAttempt(owner, async () => {}, async () => {}), /no replay/)
  } finally { gate.resolve() }
})

test('failed or pending click is never retried with same owner', async () => {
  const owner = {}, gate = deferred(); let calls = 0
  const first = sendOnceWithDurableAttempt(owner, async () => {}, () => { calls++; return gate.promise })
  try {
    await Promise.resolve()
    await assert.rejects(sendOnceWithDurableAttempt(owner, async () => {}, async () => { calls++ }), /no replay/)
    gate.reject(Error('synthetic unknown')); await assert.rejects(first, /unknown/)
    await assert.rejects(sendOnceWithDurableAttempt(owner, async () => {}, async () => { calls++ }), /no replay/)
    assert.equal(calls, 1)
  } finally { gate.resolve() }
})

test('provider settled check rejects active incomplete extra requests and incomplete counters', () => {
  const exact = { received: 1, success: 1, rejected: 0, incomplete: 0, active: 0 }
  assert.equal(providerSettledExactlyOnce(exact), true)
  for (const patch of [{ active: 1 }, { incomplete: 1 }, { received: 2 }, { rejected: 1 }, { success: 0 }, { active: undefined }]) assert.equal(providerSettledExactlyOnce({ ...exact, ...patch }), false)
  assert.equal(providerSettledExactlyOnce(undefined), false)
})

test('cleanup touches only supplied fake handles and leaves process tree unknown', async () => {
  const calls = [], child = Object.assign(new EventEmitter(), { pid: 100, exitCode: 0, signalCode: null, kill: () => { calls.push('kill'); return true } })
  const app = { process: () => child, close: async () => { calls.push('app.close') } }
  const mock = { close: async () => { calls.push('mock.close') }, observations: () => ({ received: 1, success: 1, rejected: 0, incomplete: 0, active: 0 }), destroyOwnedSockets: () => calls.push('destroy') }
  const result = await cleanupOwnedSummaryResources(app, mock)
  assert.deepEqual(calls, ['app.close', 'mock.close'])
  assert.equal(result.processTree, 'unknown'); assert.equal(result.child, 'observed'); assert.equal(result.mock, 'ok')
  assert.equal(providerSettledExactlyOnce(result.provider), true)
  assert.deepEqual(await cleanupOwnedSummaryResources(undefined, undefined), { processTree: 'unknown', app: 'not-created', child: 'unknown', mock: 'not-created' })
})

test('synchronous app close failure does not skip closing the supplied mock', async () => {
  const calls = [], child = Object.assign(new EventEmitter(), { pid: 101, exitCode: 0, signalCode: null })
  const app = { process: () => child, close: () => { calls.push('app.close'); throw Error('synthetic failure') } }
  const stats = { received: 1, success: 1, rejected: 0, incomplete: 0, active: 0 }
  const mock = { close: async () => { calls.push('mock.close') }, observations: () => { calls.push('observations'); return stats } }
  const result = await cleanupOwnedSummaryResources(app, mock)
  assert.deepEqual(calls, ['app.close', 'mock.close', 'observations'])
  assert.equal(result.app, 'error'); assert.equal(result.mock, 'ok'); assert.equal(result.processTree, 'unknown')
  assert.deepEqual(result.provider, stats)
})

test('synchronous mock close and socket destroy failures are reported without throwing', async () => {
  const calls = []
  const mock = {
    close: () => { calls.push('close'); throw Error('synthetic close failure') },
    destroyOwnedSockets: () => { calls.push('destroy'); throw Error('synthetic destroy failure') },
    observations: () => { calls.push('observations'); throw Error('synthetic observation failure') }
  }
  const result = await cleanupOwnedSummaryResources(undefined, mock)
  // Returning normally allows the caller's report writer to run; this is not a writer integration test.
  assert.deepEqual(calls, ['close', 'destroy', 'close', 'observations'])
  assert.equal(result.mock, 'error'); assert.equal(result.destroyOwnedSockets, 'error')
  assert.equal(result.mockAfterDestroy, 'error'); assert.equal(result.provider, 'unknown')
  assert.equal(result.processTree, 'unknown')
})
