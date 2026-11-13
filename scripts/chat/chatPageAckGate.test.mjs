// Offline unit tests: fake promises only, no browser or IndexedDB is started.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAcknowledgementGate, wrapAcknowledgedSave } from './chatPageAckGate.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const violations = []
  const gate = createAcknowledgementGate((path) => { violations.push(path); throw Error(path) })
  return { gate, violations }
}

test('holds only the exact matched invocation after its save settles, forwarding all options', async () => {
  const { gate, violations } = fixture()
  const realCompletion = deferred()
  const called = []
  const options = { expectedSession: { id: 'target' }, shouldUpdate: () => true }
  const save = wrapAcknowledgedSave((...args) => {
    called.push(args)
    if (args[1] === 'scope-a' && args[0].id === 'target') return realCompletion.promise
    return 'other-result'
  }, gate)
  gate.control.arm('scope-a', 'target', 'nonce-1')
  assert.equal(await save({ id: 'target' }, 'scope-b', options), 'other-result')
  assert.equal(await save({ id: 'other' }, 'scope-a', options), 'other-result')
  let acknowledged = false
  const result = save({ id: 'target' }, 'scope-a', options).then((value) => { acknowledged = true; return value })
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed', 'matched-save'])
  assert.equal(acknowledged, false)
  assert.throws(() => gate.control.release('nonce-1'), /invalid-release/)
  realCompletion.resolve('committed')
  await realCompletion.promise
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed', 'matched-save', 'storage-committed-ack-held'])
  assert.equal(acknowledged, false)
  assert.throws(() => gate.control.release('wrong'), /invalid-release/)
  gate.control.release('nonce-1')
  assert.equal(await result, 'committed')
  assert.equal(acknowledged, true)
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed', 'matched-save', 'storage-committed-ack-held', 'ack-released'])
  assert.equal(called[2][2], options)
  assert.equal(called[2][2].shouldUpdate, options.shouldUpdate)
  assert.deepEqual(violations, ['gate:invalid-release', 'gate:invalid-release'])
})

test('does not capture an already running save or steal the next simultaneous matching save', async () => {
  const { gate, violations } = fixture()
  const first = deferred(), second = deferred(), third = deferred()
  let index = 0
  const save = wrapAcknowledgedSave(() => [first, second, third][index++].promise, gate)
  const preexisting = save({ id: 'target' }, 'scope')
  gate.control.arm('scope', 'target', 'one-shot')
  const matched = save({ id: 'target' }, 'scope')
  const concurrent = save({ id: 'target' }, 'scope')
  first.resolve('old')
  third.resolve('other')
  assert.equal(await preexisting, 'old')
  assert.equal(await concurrent, 'other')
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed', 'matched-save'])
  second.resolve('matched')
  await second.promise
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed', 'matched-save', 'storage-committed-ack-held'])
  gate.control.release('one-shot')
  assert.equal(await matched, 'matched')
  assert.deepEqual(violations, [])
})

test('propagates the identical save error, does not hold, and makes its token one-use', async () => {
  const { gate, violations } = fixture()
  const failure = new Error('original save error')
  const save = wrapAcknowledgedSave(async () => { throw failure }, gate)
  gate.control.arm('scope', 'target', 'failed-token')
  await assert.rejects(save({ id: 'target' }, 'scope'), (error) => error === failure)
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed', 'matched-save', 'save-rejected'])
  assert.throws(() => gate.control.release('failed-token'), /invalid-release/)
  assert.throws(() => gate.control.arm('scope', 'target', 'failed-token'), /invalid-arm/)
  gate.control.arm('scope', 'target', 'fresh-token')
  assert.deepEqual(violations, ['gate:invalid-release', 'gate:invalid-arm'])
})

test('rejects malformed/duplicate controls and returns defensive event copies', async () => {
  const { gate, violations } = fixture()
  assert.throws(() => gate.control.arm('', 'id', 'token'), /invalid-arm/)
  gate.control.arm('scope', 'id', 'token')
  assert.throws(() => gate.control.arm('scope', 'other', 'token-2'), /invalid-arm/)
  const snapshot = gate.control.trace()
  snapshot[0].stage = 'falsified'
  snapshot.push({ stage: 'injected' })
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed'])
  const reservation = gate.capture('scope', 'id')
  const held = gate.hold(reservation)
  gate.control.release('token')
  assert.throws(() => gate.control.release('token'), /invalid-release/)
  await held
  assert.throws(() => gate.control.arm('scope', 'id', 'token'), /invalid-arm/)
  assert.deepEqual(violations, ['gate:invalid-arm', 'gate:invalid-arm', 'gate:invalid-release', 'gate:invalid-arm'])
})

test('a broken deny function still cannot allow invalid operations', () => {
  const gate = createAcknowledgementGate(() => {})
  assert.throws(() => gate.control.release('unknown'), /deny unexpectedly returned/)
})
