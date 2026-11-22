// Fixture-control unit tests only. No browser or IndexedDB is started here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createScopedReadGate, wrapScopedRead } from './chatPageReadGate.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  const violations = []
  const gate = createScopedReadGate((path) => { violations.push(path); throw Error(path) })
  return { gate, violations }
}

test('holds the next matching scope after the real read, while unrelated reads proceed', async () => {
  const { gate, violations } = fixture()
  const old = deferred(), captured = deferred()
  const calls = []
  const read = wrapScopedRead((...args) => {
    calls.push(args)
    if (calls.length === 1) return old.promise
    if (args[0] === 'scope-b') return [{ id: 'other', title: 'B' }]
    return captured.promise
  }, gate)
  const preexisting = read('scope-a', 'first-options')
  gate.control.arm('scope-a', 'one-shot')
  assert.deepEqual(await read('scope-b', 'other-options'), [{ id: 'other', title: 'B' }])
  let acknowledged = false
  const result = read('scope-a', 'matching-options').then((value) => { acknowledged = true; return value })
  await assert.rejects(read('scope-a'), /read:overlap/)
  old.resolve([{ id: 'old' }])
  assert.deepEqual(await preexisting, [{ id: 'old' }])
  assert.equal(acknowledged, false)
  const original = [{ id: 'shared', title: 'old snapshot', nested: { value: 1 } }]
  captured.resolve(original)
  await captured.promise
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed', 'matched-read', 'read-resolved-held'])
  const snapshot = gate.control.snapshot('one-shot')
  assert.deepEqual(snapshot, original)
  snapshot[0].nested.value = 9
  assert.equal(original[0].nested.value, 1)
  assert.equal(acknowledged, false)
  gate.control.release('one-shot')
  assert.strictEqual(await result, original)
  assert.deepEqual(calls[2], ['scope-a', 'matching-options'])
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed', 'matched-read', 'read-resolved-held', 'read-released'])
  assert.deepEqual(violations, ['read:overlap'])
})

test('read rejection is propagated unchanged, never held, and token cannot be reused', async () => {
  const { gate, violations } = fixture()
  const failure = new Error('real read failure')
  const read = wrapScopedRead(async () => { throw failure }, gate)
  gate.control.arm('scope-a', 'failed')
  await assert.rejects(read('scope-a'), (error) => error === failure)
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed', 'matched-read', 'read-rejected'])
  assert.throws(() => gate.control.release('failed'), /read:invalid-release/)
  assert.throws(() => gate.control.arm('scope-a', 'failed'), /read:invalid-arm/)
  gate.control.arm('scope-a', 'fresh')
  assert.deepEqual(violations, ['read:invalid-release', 'read:invalid-arm'])
})

test('invalid control calls are sticky; trace and snapshot are defensive copies', async () => {
  const { gate, violations } = fixture()
  assert.throws(() => gate.control.arm('', 'token'), /read:invalid-arm/)
  gate.control.arm('scope-a', 'token')
  assert.throws(() => gate.control.arm('scope-b', 'other'), /read:invalid-arm/)
  assert.throws(() => gate.control.release('token'), /read:invalid-release/)
  assert.throws(() => gate.control.snapshot('token'), /read:invalid-snapshot/)
  const trace = gate.control.trace()
  trace[0].stage = 'modified'
  trace.push({ stage: 'injected' })
  const read = wrapScopedRead(async () => [{ id: 'target' }], gate)
  const pending = read('scope-a')
  await Promise.resolve()
  assert.throws(() => gate.control.snapshot('wrong'), /read:invalid-snapshot/)
  const snapshot = gate.control.snapshot('token')
  snapshot[0].id = 'changed'
  assert.deepEqual(gate.control.snapshot('token'), [{ id: 'target' }])
  gate.control.release('token')
  assert.deepEqual(await pending, [{ id: 'target' }])
  assert.deepEqual(gate.control.trace().map((event) => event.stage), ['armed', 'matched-read', 'read-resolved-held', 'read-released'])
  assert.deepEqual(violations, ['read:invalid-arm', 'read:invalid-arm', 'read:invalid-release', 'read:invalid-snapshot', 'read:invalid-snapshot'])
})

test('an invalid read result or broken deny still cannot be accepted as a snapshot', async () => {
  const { gate, violations } = fixture()
  gate.control.arm('scope-a', 'bad-result')
  const read = wrapScopedRead(async () => ({ not: 'an array' }), gate)
  await assert.rejects(read('scope-a'), /read:invalid-result/)
  assert.deepEqual(violations, ['read:invalid-result'])
  const broken = createScopedReadGate(() => {})
  assert.throws(() => broken.control.release('anything'), /deny unexpectedly returned/)
})
