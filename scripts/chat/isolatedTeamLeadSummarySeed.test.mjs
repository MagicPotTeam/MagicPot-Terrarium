import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { buildLeadSummarySeed, coordinateLeadSummarySeed } from './isolatedTeamLeadSummarySeed.mjs'

const identity = () => ({ scope: 'synthetic.scope', leadId: 'lead', profileId: 'synthetic-profile', memberIds: ['a', 'b'] })
function fakeCoordinator(initial = []) {
  const rows = new Map(initial.map(row => [row.storageKey, structuredClone(row)])), calls = []
  return { rows, calls, async addOnlyAndCommit(records) {
    calls.push('commit')
    if (records.some(record => rows.has(record.storageKey))) throw Error('ConstraintError')
    for (const record of records) rows.set(record.storageKey, structuredClone(record))
  }, async read(keys) { calls.push('read'); return keys.map(key => structuredClone(rows.get(key))) }, async reload() { calls.push('reload') } }
}

test('constructs only two exact synthetic scoped records without mutating input', () => {
  const source = identity(), before = structuredClone(source), result = buildLeadSummarySeed(source)
  assert.deepEqual(source, before)
  assert.deepEqual(result, ['设计师', '文案'].map((name, index) => ({ id: ['a', 'b'][index], storageKey: `synthetic.scope\u0000${['a', 'b'][index]}`, storageScope: 'synthetic.scope', title: name, teamLeadId: 'lead', teamMemberName: name, teamRole: name, profileId: 'synthetic-profile', createdAt: [2, 1][index], messages: [{ role: 'assistant', content: ['fixture-design-result-vt34qf-1', 'fixture-writer-result-vt34qf-1'][index] }] })))
  assert.throws(() => buildLeadSummarySeed({ ...source, memberIds: ['a', 'a'] }))
})

test('fake commit, exact readback and reload are ordered and other scopes remain unchanged', async () => {
  const other = [{ storageKey: 'other\u0000a', messages: ['other'] }, { storageKey: 'synthetic.scope\u0000unrelated', messages: ['unrelated'] }]
  const fake = fakeCoordinator(other), snapshot = structuredClone(other)
  await coordinateLeadSummarySeed({}, identity(), fake)
  assert.deepEqual(fake.calls, ['commit', 'read', 'reload'])
  for (const row of snapshot) assert.deepEqual(fake.rows.get(row.storageKey), row)
})

test('existing target rejects without overwriting and consumes reservation', async () => {
  const existing = { storageKey: 'synthetic.scope\u0000a', messages: ['old'] }, fake = fakeCoordinator([existing]), handle = {}
  await assert.rejects(coordinateLeadSummarySeed(handle, identity(), fake), /ConstraintError/)
  assert.deepEqual(fake.rows.get(existing.storageKey), existing)
  assert.equal(fake.rows.has('synthetic.scope\u0000b'), false)
  await assert.rejects(coordinateLeadSummarySeed(handle, identity(), fake), /already attempted/)
  assert.deepEqual(fake.calls, ['commit'])
})

test('pending or timed-out attempt cannot be retried and deferred work is released', async () => {
  const fake = fakeCoordinator(), handle = {}; let release
  const gate = new Promise(resolve => { release = resolve }), original = fake.addOnlyAndCommit
  fake.addOnlyAndCommit = async records => { await gate; return original(records) }
  const first = coordinateLeadSummarySeed(handle, identity(), fake)
  try {
    const timeout = await Promise.race([first.then(() => 'finished'), new Promise(resolve => setTimeout(() => resolve('timeout'), 10))])
    assert.equal(timeout, 'timeout')
    await assert.rejects(coordinateLeadSummarySeed(handle, identity(), fake), /already attempted/)
  } finally { release(); await first }
})

test('abort after a pending commit prevents later read and reload', async () => {
  const controller = new AbortController(), fake = fakeCoordinator(), events = []
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const commit = fake.addOnlyAndCommit
  fake.addOnlyAndCommit = async records => { events.push('commit-started'); entered(); await gate; await commit(records); events.push('commit-finished') }
  const run = coordinateLeadSummarySeed({}, identity(), fake, controller.signal)
  void run.catch(() => undefined)
  try {
    await Promise.race([started, run.then(() => { throw Error('seed settled before expected gate') }), delay(1000).then(() => { throw Error('seed gate not reached') })])
    controller.abort()
    release()
    await assert.rejects(run, /aborted/i)
    assert.deepEqual(events, ['commit-started', 'commit-finished'])
    assert.deepEqual(fake.calls, ['commit'])
  } finally { controller.abort(); release(); await run.catch(() => undefined) }
})

test('abort after a pending read prevents later reload', async () => {
  const controller = new AbortController(), fake = fakeCoordinator()
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const read = fake.read
  fake.read = async keys => { entered(); await gate; return read(keys) }
  const run = coordinateLeadSummarySeed({}, identity(), fake, controller.signal)
  void run.catch(() => undefined)
  try {
    await Promise.race([started, run.then(() => { throw Error('seed settled before expected gate') }), delay(1000).then(() => { throw Error('seed gate not reached') })])
    controller.abort()
    release()
    await assert.rejects(run, /aborted/i)
    assert.deepEqual(fake.calls, ['commit', 'read'])
  } finally { controller.abort(); release(); await run.catch(() => undefined) }
})

test('failed read or reload cannot be retried', async () => {
  for (const failure of ['read', 'reload']) {
    const fake = fakeCoordinator(), handle = {}
    fake[failure] = async () => { throw Error(failure) }
    await assert.rejects(coordinateLeadSummarySeed(handle, identity(), fake), new RegExp(failure))
    await assert.rejects(coordinateLeadSummarySeed(handle, identity(), fake), /already attempted/)
  }
})
