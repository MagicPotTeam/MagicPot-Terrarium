import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coordinateSyntheticLeadSummary } from './isolatedTeamLeadSummaryDesktop.mjs'

const fixture = () => {
  const calls = []
  return { calls, record: async state => { calls.push(`record:${state.stage}:${state.attempted}`) }, prepare: async () => {}, seed: async () => {}, verify: async () => {}, send: async () => { calls.push('send') }, observe: async () => {}, cleanup: async () => { calls.push('cleanup') } }
}
test('attempt record precedes one send and result is not a pass', async () => {
  const s = fixture(), result = await coordinateSyntheticLeadSummary({}, s)
  assert(s.calls.indexOf('record:send:true') < s.calls.indexOf('send'))
  assert.equal(s.calls.filter(value => value === 'send').length, 1)
  assert.equal(result.status, 'observation-only'); assert.equal(result.finalConfirmation, 'not-confirmed')
})
test('synchronous reservation rejects reuse before and after settlement', async () => {
  const s = fixture(), run = {}; let release
  s.record = () => new Promise(resolve => { release = resolve })
  const first = coordinateSyntheticLeadSummary(run, s)
  await assert.rejects(coordinateSyntheticLeadSummary(run, s), /do not replay/)
  s.record = async () => {}; release(); await first
  await assert.rejects(coordinateSyntheticLeadSummary(run, s), /do not replay/)
})
test('failed attempt record prevents send and both errors survive cleanup', async () => {
  const s = fixture()
  s.record = async state => { if (state.attempted) throw Error('record-failed') }
  s.cleanup = async () => { throw Error('cleanup-failed') }
  await assert.rejects(coordinateSyntheticLeadSummary({}, s), error => {
    assert(error instanceof AggregateError)
    assert.deepEqual(error.errors.map(item => item.message), ['record-failed', 'cleanup-failed'])
    return true
  })
  assert(!s.calls.includes('send'))
})
for (const stage of ['prepare', 'seed', 'verify']) test(`${stage} failure forbids send and consumes reservation`, async () => {
  const s = fixture(), run = {}
  s[stage] = async () => { throw Error(`${stage}-failed`) }
  await assert.rejects(coordinateSyntheticLeadSummary(run, s), new RegExp(`${stage}-failed`))
  assert(!s.calls.includes('send')); assert(s.calls.includes('cleanup'))
  await assert.rejects(coordinateSyntheticLeadSummary(run, s), /do not replay/)
})
test('pending send consumes reservation and failure never replays', async () => {
  const s = fixture(), run = {}; let release, entered
  const started = new Promise(resolve => { entered = resolve })
  s.send = () => { s.calls.push('send'); entered(); return new Promise((_, reject) => { release = () => reject(Error('unknown')) }) }
  const first = coordinateSyntheticLeadSummary(run, s)
  try {
    await started
    await assert.rejects(coordinateSyntheticLeadSummary(run, s), /do not replay/)
    release(); await assert.rejects(first, /unknown/)
    assert.equal(s.calls.filter(value => value === 'send').length, 1)
    assert(!s.calls.includes('record:observe:true')); assert(s.calls.includes('cleanup'))
    await assert.rejects(coordinateSyntheticLeadSummary(run, s), /do not replay/)
  } finally { release?.() }
})
test('even falsy thrown values remain failures and do not mask cleanup', async () => {
  const s = fixture(); s.verify = async () => { throw undefined }; s.cleanup = async () => { throw Error('cleanup-failed') }
  await assert.rejects(coordinateSyntheticLeadSummary({}, s), error => {
    assert(error instanceof AggregateError); assert.equal(error.errors[0], undefined); assert.equal(error.errors[1].message, 'cleanup-failed'); return true
  })
  assert(!s.calls.includes('send'))
})
