import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildLeadSummarySeed } from './isolatedTeamLeadSummarySeed.mjs'
import { seedIsolatedTeamLead } from './isolatedTeamDesktopFixture.mjs'
import { addOnlySyntheticSummaryRows, readSyntheticSummaryRows, seedSummaryOnIsolatedPage } from './isolatedTeamLeadSummaryPage.mjs'

// This is a small staged transaction fake, NOT a native IDB or Electron test.
function fakeIndexedDB(initial, { keyPath = 'storageKey', missingStore = false } = {}) {
  const committed = new Map(initial.map(row => [row.storageKey, structuredClone(row)]))
  let openCount = 0, closed = 0
  return { committed, get openCount() { return openCount }, get closed() { return closed },
    open(name, version) {
      assert.equal(name, 'magicpot-chat'); assert.equal(version, 2); openCount++
      const request = {}
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: name => name === 'sessions-v2' && !missingStore },
          close() { closed++ },
          transaction(name, mode) {
            assert.equal(name, 'sessions-v2')
            const staged = new Map([...committed].map(([key, value]) => [key, structuredClone(value)]))
            const queue = []; let aborted = false, scheduled = false
            const tx = { error: null, abort() { aborted = true; if (!scheduled) { scheduled = true; queueMicrotask(drain) } }, objectStore() { return store } }
            const drain = () => {
              scheduled = false
              while (queue.length && !aborted) queue.shift()()
              if (aborted) { tx.onabort?.(); return }
              if (mode === 'readwrite') { committed.clear(); for (const [key, value] of staged) committed.set(key, value) }
              tx.oncomplete?.()
            }
            const schedule = fn => { queue.push(fn); if (!scheduled) { scheduled = true; queueMicrotask(drain) } }
            const store = {
              keyPath,
              get(key) { const req = {}; schedule(() => { req.result = structuredClone(staged.get(key)); req.onsuccess?.() }); return req },
              add(row) { schedule(() => { if (staged.has(row.storageKey)) { tx.error = Error('ConstraintError'); aborted = true } else staged.set(row.storageKey, structuredClone(row)) }); return {} }
            }
            return tx
          }
        }
        request.onsuccess?.()
      })
      return request
    }
  }
}
const identity = { scope: 'synthetic.scope', sessionId: 'synthetic-lead', profileId: 'isolated-image-responses' }
const memberIds = ['isolated-summary-member-11111111-1111-4111-8111-111111111111', 'isolated-summary-member-22222222-2222-4222-8222-222222222222']
const lead = () => ({ id: identity.sessionId, storageKey: `${identity.scope}\u0000${identity.sessionId}`, storageScope: identity.scope, profileId: identity.profileId, messages: [] })
const rows = () => buildLeadSummarySeed({ scope: identity.scope, leadId: identity.sessionId, profileId: identity.profileId, memberIds })
async function withFake(fake, run) {
  const saved = globalThis.indexedDB
  globalThis.indexedDB = fake
  try { await run() } finally { if (saved === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = saved }
}

test('fake page identity and scoped seed coordinate once with commit, read and reload', async () => {
  const fake = fakeIndexedDB([]), events = []
  const page = {
    waitForFunction: async () => { events.push('pane') },
    evaluate: async (fn, arg) => {
      if (fn === addOnlySyntheticSummaryRows || fn === readSyntheticSummaryRows) { events.push(fn === addOnlySyntheticSummaryRows ? 'commit' : 'read'); return fn(arg) }
      events.push('fake-lead-fixture')
    },
    reload: async () => { events.push('reload') }, locator: () => ({})
  }
  await withFake(fake, async () => {
    const owner = await seedIsolatedTeamLead(page, { profileId: 'isolated-image-responses', freshSyntheticProfile: true })
    const scopedLead = { id: owner.sessionId, storageKey: `${owner.scope}\u0000${owner.sessionId}`, storageScope: owner.scope, profileId: owner.profileId, messages: [] }
    fake.committed.set(scopedLead.storageKey, scopedLead)
    events.length = 0
    const members = await seedSummaryOnIsolatedPage(page, owner, [randomUUID(), randomUUID()].map(id => `isolated-summary-member-${id}`))
    assert.deepEqual(events, ['pane', 'commit', 'read', 'reload', 'pane'])
    assert.deepEqual(members.map(({ teamMemberName, createdAt, messages }) => [teamMemberName, createdAt, messages[0].content]), [
      ['设计师', 2, 'fixture-design-result-vt34qf-1'],
      ['文案', 1, 'fixture-writer-result-vt34qf-1']
    ])
    assert(members.every(member => member.teamLeadId === owner.sessionId && member.storageScope === owner.scope))
    await assert.rejects(seedSummaryOnIsolatedPage(page, owner, memberIds), /already attempted/)
    assert.deepEqual(events, ['pane', 'commit', 'read', 'reload', 'pane'])
  })
})

test('commits two rows and reads them in requested order without changing other scopes', async () => {
  const outside = { storageKey: 'other\u0000member', content: 'untouched' }
  const fake = fakeIndexedDB([lead(), outside]), records = rows()
  await withFake(fake, async () => {
    await addOnlySyntheticSummaryRows({ identity, records })
    assert.deepEqual(await readSyntheticSummaryRows({ keys: records.map(record => record.storageKey) }), records)
  })
  assert.deepEqual(fake.committed.get(outside.storageKey), outside)
  assert.deepEqual(fake.committed.get(lead().storageKey), lead())
  assert.equal(fake.closed, 2)
})

test('a pre-existing second row aborts the entire staged transaction', async () => {
  const [first, second] = rows(), existing = { ...second, messages: [{ role: 'assistant', content: 'existing' }] }
  const fake = fakeIndexedDB([lead(), existing])
  await withFake(fake, async () => assert.rejects(addOnlySyntheticSummaryRows({ identity, records: [first, second] }), /ConstraintError/))
  assert.equal(fake.committed.has(first.storageKey), false)
  assert.deepEqual(fake.committed.get(existing.storageKey), existing)
  assert.equal(fake.closed, 1)
})

test('rejects changed content, mismatched scope and arbitrary row before opening IDB', async () => {
  const variants = []
  const changed = rows(); changed[0].messages[0].content = 'not-the-fixture'; variants.push(changed)
  const wrongScope = rows(); wrongScope[1].storageScope = 'other'; variants.push(wrongScope)
  const extra = rows(); extra.push({ storageKey: 'unrelated' }); variants.push(extra)
  const fake = fakeIndexedDB([lead()])
  await withFake(fake, async () => { for (const records of variants) await assert.rejects(addOnlySyntheticSummaryRows({ identity, records }), /Invalid synthetic rows/) })
  assert.equal(fake.openCount, 0)
  assert.equal(fake.committed.size, 1)
})

test('blocked opens reject immediately and close a late connection without transaction', async () => {
  for (const call of [() => addOnlySyntheticSummaryRows({ identity, records: rows() }), () => readSyntheticSummaryRows({ keys: [] })]) {
    let closes = 0, transactions = 0
    const fake = { open() {
      const request = {}
      queueMicrotask(() => {
        request.onblocked()
        queueMicrotask(() => {
          request.result = { close() { closes++ }, transaction() { transactions++ } }
          request.onsuccess()
        })
      })
      return request
    } }
    await withFake(fake, async () => { await assert.rejects(call(), /blocked/); await Promise.resolve() })
    assert.equal(closes, 1)
    assert.equal(transactions, 0)
  }
})

test('wrong or nonempty lead and wrong store key abort without adding rows', async () => {
  for (const bad of [{ ...lead(), profileId: 'other' }, { ...lead(), messages: [{ role: 'user', content: 'already used' }] }]) {
    const fake = fakeIndexedDB([bad])
    await withFake(fake, async () => assert.rejects(addOnlySyntheticSummaryRows({ identity, records: rows() }), /aborted/))
    assert.equal(fake.committed.size, 1)
  }
  const fake = fakeIndexedDB([lead()], { keyPath: 'wrong' })
  await withFake(fake, async () => assert.rejects(addOnlySyntheticSummaryRows({ identity, records: rows() }), /aborted/))
  assert.equal(fake.committed.size, 1)
})
