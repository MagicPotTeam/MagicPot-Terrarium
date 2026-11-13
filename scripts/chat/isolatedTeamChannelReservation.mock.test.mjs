import test from 'node:test'
import assert from 'node:assert/strict'
import { seedIsolatedTeamLead, broadcastIsolatedTeamChannel } from './isolatedTeamDesktopFixture.mjs'

// No real browser, disk, IPC, network, or Electron.
async function setup() {
  const events = []
  let action = async () => {}
  const button = { click: async () => { events.push('click'); await action() } }
  const dialog = { getByRole: (role, options) => { assert.equal(role, 'button'); assert.equal(options.name, '广播给订阅成员'); return button } }
  const page = {
    waitForFunction: async () => { events.push('await-pane') },
    evaluate: async () => {}, reload: async () => {}, locator: () => ({}),
    getByRole: (role, options) => { assert.equal(role, 'dialog'); assert.equal(options.name, '团队管理'); return dialog }
  }
  const identity = await seedIsolatedTeamLead(page, { profileId: 'fake', freshSyntheticProfile: true })
  events.length = 0
  return { page, identity, events, setAction: next => { action = next } }
}
const zero = f => broadcastIsolatedTeamChannel(f.page, f.identity, 'zero-subscribers', async () => true)
const one = f => broadcastIsolatedTeamChannel(f.page, f.identity, 'one-subscriber')

test('same stage concurrent calls reserve before first await and click at most once', async () => {
  const f = await setup()
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.setAction(() => gate)
  try {
    const first = zero(f)
    const second = zero(f)
    await assert.rejects(second, /already attempted/)
    assert.deepEqual(f.events, ['await-pane', 'click'])
    release()
    await first
  } finally { release() }
  assert.equal(f.events.filter(event => event === 'click').length, 1)
})

test('rejected or unknown click cannot be repeated', async () => {
  for (const mode of ['reject', 'pending']) {
    const f = await setup()
    let release
    const gate = new Promise(resolve => { release = resolve })
    f.setAction(mode === 'reject' ? async () => { throw Error('unknown') } : () => gate)
    try {
      const first = zero(f)
      if (mode === 'reject') await assert.rejects(first, /unknown/)
      else {
        await Promise.resolve(); await Promise.resolve()
        await assert.rejects(zero(f), /already attempted/)
        release(); await first
      }
      await assert.rejects(zero(f), /already attempted/)
      assert.equal(f.events.filter(event => event === 'click').length, 1)
    } finally { release() }
  }
})

test('failed zero-stage verification blocks both retries and the next stage', async () => {
  const f = await setup()
  await assert.rejects(broadcastIsolatedTeamChannel(f.page, f.identity, 'zero-subscribers', async () => false), /not verified/)
  await assert.rejects(zero(f), /already attempted/)
  await assert.rejects(one(f), /not verified/)
  assert.equal(f.events.filter(event => event === 'click').length, 1)
})

const observe = promise => Promise.resolve(promise).then(
  value => ({ state: 'fulfilled', value }),
  error => ({ state: 'rejected', error })
)
async function withDeadline(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), 1000) })
    ])
  } finally { clearTimeout(timer) }
}
async function waitForEntered(started, settled) {
  const outcome = await withDeadline(Promise.race([
    started.then(() => ({ state: 'entered' })),
    settled.then(result => ({ state: 'finished', result }))
  ]), 'waiting for callback')
  assert.equal(outcome.state, 'entered', 'operation settled before the callback was entered')
}
async function settleAfterRelease(release, settled, value) {
  release(value)
  await withDeadline(settled, 'cleanup')
}
async function assertRejectedBounded(promise, pattern) {
  const outcome = await withDeadline(observe(promise), 'operation')
  assert.equal(outcome.state, 'rejected', 'operation should reject')
  assert.match(String(outcome.error?.message ?? outcome.error), pattern)
}

test('zero verification rejection cannot unlock or retry either stage', async () => {
  const f = await setup()
  await assertRejectedBounded(broadcastIsolatedTeamChannel(f.page, f.identity, 'zero-subscribers', async () => { throw Error('verification unavailable') }), /verification unavailable/)
  await assertRejectedBounded(zero(f), /already attempted/)
  await assertRejectedBounded(one(f), /not verified/)
  await assertRejectedBounded(one(f), /already attempted/)
  assert.equal(f.events.filter(event => event === 'click').length, 1)
})

test('pending zero verification is not success and a premature one attempt stays consumed', async () => {
  const f = await setup()
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const pending = broadcastIsolatedTeamChannel(f.page, f.identity, 'zero-subscribers', async () => { entered(); return gate })
  const settled = observe(pending)
  let failure
  try {
    await waitForEntered(started, settled)
    await assertRejectedBounded(zero(f), /already attempted/)
    await assertRejectedBounded(one(f), /not verified/)
    assert.equal(f.events.filter(event => event === 'click').length, 1)
    release(true)
    const outcome = await withDeadline(settled, 'zero verification')
    assert.equal(outcome.state, 'fulfilled')
    await assertRejectedBounded(one(f), /already attempted/)
    assert.equal(f.events.filter(event => event === 'click').length, 1)
  } catch (error) { failure = error } finally {
    try { await settleAfterRelease(release, settled, true) } catch (error) { failure ??= error }
  }
  if (failure) throw failure
})

test('one-stage rejected or pending click is reserved and cannot be retried', async () => {
  for (const mode of ['reject', 'pending']) {
    const f = await setup()
    const zeroOutcome = await withDeadline(observe(zero(f)), 'zero stage')
    assert.equal(zeroOutcome.state, 'fulfilled')
    let release, entered
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { entered = resolve })
    f.setAction(async () => { entered(); if (mode === 'reject') throw Error('one outcome unknown'); await gate })
    const settled = observe(one(f))
    let failure
    try {
      await waitForEntered(started, settled)
      if (mode === 'reject') {
        const outcome = await withDeadline(settled, 'one stage')
        assert.equal(outcome.state, 'rejected')
        assert.match(String(outcome.error?.message ?? outcome.error), /one outcome unknown/)
      } else await assertRejectedBounded(one(f), /already attempted/)
      release()
      if (mode === 'pending') assert.equal((await withDeadline(settled, 'one stage')).state, 'fulfilled')
      await assertRejectedBounded(one(f), /already attempted/)
      assert.equal(f.events.filter(event => event === 'click').length, 2)
    } catch (error) { failure = error } finally {
      try { await settleAfterRelease(release, settled) } catch (error) { failure ??= error }
    }
    if (failure) throw failure
  }
})

test('verified zero permits one second-stage attempt even concurrently', async () => {
  const f = await setup()
  await zero(f)
  const results = await Promise.allSettled([one(f), one(f)])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter(item => item.status === 'rejected').length, 1)
  assert.equal(f.events.filter(event => event === 'click').length, 2)
})

test('identities are isolated and forged identities are rejected before UI', async () => {
  const a = await setup(), b = await setup()
  await zero(a); await zero(b)
  assert.equal(a.events.filter(event => event === 'click').length, 1)
  assert.equal(b.events.filter(event => event === 'click').length, 1)
  const before = a.events.length
  await assert.rejects(broadcastIsolatedTeamChannel(a.page, { ...a.identity }, 'zero-subscribers', async () => true), /identity returned/)
  assert.equal(a.events.length, before)
})

test('premature one-stage attempt is consumed while zero remains pending', async () => {
  const f = await setup()
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  f.setAction(async () => { entered(); await gate })
  try {
    const pending = zero(f)
    await started
    await assert.rejects(one(f), /not verified/)
    assert.equal(f.events.filter(event => event === 'click').length, 1)
    release()
    await pending
    await assert.rejects(one(f), /already attempted/)
    assert.equal(f.events.filter(event => event === 'click').length, 1)
  } finally { release() }
})

test('rejected zero click blocks one; fresh identity still succeeds', async () => {
  const failed = await setup()
  failed.setAction(async () => { throw Error('zero outcome unknown') })
  await assert.rejects(zero(failed), /unknown/)
  await assert.rejects(one(failed), /not verified/)
  await assert.rejects(one(failed), /already attempted/)
  assert.equal(failed.events.filter(event => event === 'click').length, 1)
  const fresh = await setup()
  await zero(fresh)
  await one(fresh)
  assert.equal(fresh.events.filter(event => event === 'click').length, 2)
})
