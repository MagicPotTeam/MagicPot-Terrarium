import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { runSyntheticSummaryAcceptance } from './isolatedTeamLeadSummaryAcceptance.mjs'

function fixture() {
  const events = [], records = []; let disk
  return { events, records, get disk() { return disk }, record: async state => { records.push(state); events.push('record:' + state.stage) }, prepare: async () => events.push('prepare'), seed: async () => events.push('seed'), verify: async () => events.push('verify'), send: async () => events.push('send'), observe: async () => events.push('observe'), cleanup: async () => events.push('cleanup'), writeResult: async text => { disk = text } }
}
test('stages and result remain observation-only with matching receipt hash', async () => {
  const f = fixture(), result = await runSyntheticSummaryAcceptance({}, f)
  assert(f.events.indexOf('record:send') < f.events.indexOf('send'))
  assert.equal(f.records.find(r => r.stage === 'send').attempted, true)
  assert.equal(result.sha256, createHash('sha256').update(f.disk).digest('hex'))
  assert.equal(JSON.parse(f.disk).status, 'observation-only')
  assert.equal(result.cleanupOutcome, 'ok')
})
test('unknown pending send cannot replay, cleanup runs and timed-out work may remain', async () => {
  const f = fixture(), id = {}; let release
  f.send = () => { f.events.push('send'); return new Promise(resolve => { release = resolve }) }
  try {
    const result = await runSyntheticSummaryAcceptance(id, f, 20)
    assert.match(result.businessError, /send: unknown/); assert(f.events.includes('cleanup'))
    assert.equal(f.events.filter(x => x === 'send').length, 1)
    await assert.rejects(runSyntheticSummaryAcceptance(id, f), /no replay/)
  } finally { release?.() }
})
test('failed attempted record prevents send and preserves observation-only outcome', async () => {
  const f = fixture(); f.record = async state => { if (state.attempted) throw Error('fail') }
  const result = await runSyntheticSummaryAcceptance({}, f)
  assert.match(result.businessError, /record: error/); assert(!f.events.includes('send')); assert(f.events.includes('cleanup'))
})
test('late result writer cannot yield a receipt on timeout', async () => {
  const f = fixture(); let release
  f.writeResult = () => new Promise(resolve => { release = resolve })
  try { await assert.rejects(runSyntheticSummaryAcceptance({}, f, 20), /no receipt/) } finally { release?.() }
})
