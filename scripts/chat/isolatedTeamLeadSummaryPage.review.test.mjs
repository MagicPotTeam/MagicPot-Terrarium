// Regression tests for the synthetic-only page adapter. No Electron, real page,
// profile, filesystem writes, network, or native IndexedDB are used here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { seedIsolatedTeamLead } from './isolatedTeamDesktopFixture.mjs'
import { addOnlySyntheticSummaryRows, seedSummaryOnIsolatedPage } from './isolatedTeamLeadSummaryPage.mjs'
import { buildLeadSummarySeed } from './isolatedTeamLeadSummarySeed.mjs'

const members = () => [randomUUID(), randomUUID()].map(id => `isolated-summary-member-${id}`)

function fixturePage() {
  let pageWrites = 0
  return {
    get pageWrites() { return pageWrites },
    async waitForFunction() { return undefined },
    async evaluate(fn) { if (fn === addOnlySyntheticSummaryRows) pageWrites++ },
    async reload() { return undefined },
    locator: () => ({})
  }
}

test('same synthetic lead cannot be seeded from a second page after an unknown attempt', async () => {
  const first = fixturePage(), second = fixturePage()
  // Fixture identity is issued by the real coordinator; fake page does no IO.
  const identity = await seedIsolatedTeamLead(first, { profileId: 'isolated-image-responses', freshSyntheticProfile: true })
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  first.evaluate = async fn => { if (fn === addOnlySyntheticSummaryRows) { entered(); await gate; throw Error('synthetic unknown') } }
  const attempt = seedSummaryOnIsolatedPage(first, identity, members())
  try {
    await started
    await assert.rejects(seedSummaryOnIsolatedPage(second, identity, members()), /already attempted/)
    assert.equal(second.pageWrites, 0)
  } finally {
    release()
    await assert.rejects(attempt, /synthetic unknown/)
  }
})

test('seed builder validates indexed member IDs even when array methods are forged', () => {
  const memberIds = [null, '']
  memberIds.some = () => false
  memberIds[Symbol.iterator] = function* () { yield 'forged-a'; yield 'forged-b' }
  assert.throws(() => buildLeadSummarySeed({ scope: 'synthetic.scope', leadId: 'lead', profileId: 'synthetic-profile', memberIds }), /Invalid synthetic identity/)
})

test('exported page callback rejects malformed rows even when array methods are forged', async () => {
  const identity = { scope: 'synthetic.scope', sessionId: 'synthetic-lead', profileId: 'isolated-image-responses' }
  const records = buildLeadSummarySeed({ scope: identity.scope, leadId: identity.sessionId, profileId: identity.profileId, memberIds: members() })
  records[0].storageScope = 'other'
  records.some = () => false
  let opens = 0
  const previous = globalThis.indexedDB
  globalThis.indexedDB = { open() { opens++; throw Error('unexpected database open') } }
  try {
    await assert.rejects(addOnlySyntheticSummaryRows({ identity, records }), /Invalid synthetic rows/)
    assert.equal(opens, 0)
  } finally {
    if (previous === undefined) delete globalThis.indexedDB
    else globalThis.indexedDB = previous
  }
})

test('mutating supplied identity and rows after open cannot redirect the writes', async () => {
  const identity = { scope: 'synthetic.scope', sessionId: 'synthetic-lead', profileId: 'isolated-image-responses' }
  const records = buildLeadSummarySeed({ scope: identity.scope, leadId: identity.sessionId, profileId: identity.profileId, memberIds: members() })
  const expected = structuredClone(records)
  const lead = { id: identity.sessionId, storageScope: identity.scope, profileId: identity.profileId, messages: [] }
  const added = []; let openRequest, readKey, closed = 0
  const previous = globalThis.indexedDB
  globalThis.indexedDB = { open() { openRequest = {}; return openRequest } }
  try {
    const write = addOnlySyntheticSummaryRows({ identity, records })
    identity.scope = 'other.scope'; identity.sessionId = 'other-lead'; identity.profileId = 'other-profile'
    records[0].storageKey = 'other.scope\u0000target'; records[0].messages[0].content = 'wrong'
    openRequest.result = {
      objectStoreNames: { contains: name => name === 'sessions-v2' },
      close() { closed++ },
      transaction() {
        const tx = {}
        tx.objectStore = () => ({
          keyPath: 'storageKey',
          get(key) {
            readKey = key
            const request = {}
            queueMicrotask(() => { request.result = lead; request.onsuccess(); tx.oncomplete() })
            return request
          },
          add(row) { added.push(structuredClone(row)) }
        })
        return tx
      }
    }
    openRequest.onsuccess()
    await write
    assert.equal(readKey, 'synthetic.scope\u0000synthetic-lead')
    assert.deepEqual(added, expected)
    assert.equal(closed, 1)
  } finally {
    if (previous === undefined) delete globalThis.indexedDB
    else globalThis.indexedDB = previous
  }
})

test('request error does not settle write until the fake transaction aborts', async () => {
  const identity = { scope: 'synthetic.scope', sessionId: 'synthetic-lead', profileId: 'isolated-image-responses' }
  const records = buildLeadSummarySeed({ scope: identity.scope, leadId: identity.sessionId, profileId: identity.profileId, memberIds: members() })
  const lead = { id: identity.sessionId, storageScope: identity.scope, profileId: identity.profileId, messages: [] }
  let abortTransaction, closed = 0, observed = 'pending'
  const fake = {
    open() {
      const request = {}
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: name => name === 'sessions-v2' },
          close() { closed++ },
          transaction() {
            const tx = { error: Error('ConstraintError') }
            const store = {
              keyPath: 'storageKey',
              get() { const req = {}; queueMicrotask(() => { req.result = lead; req.onsuccess() }); return req },
              add() {
                queueMicrotask(() => { tx.onerror?.({ type: 'error' }) })
                return {}
              }
            }
            tx.objectStore = () => store
            tx.abort = () => { abortTransaction() }
            abortTransaction = () => tx.onabort?.()
            return tx
          }
        }
        request.onsuccess()
      })
      return request
    }
  }
  const previous = globalThis.indexedDB
  globalThis.indexedDB = fake
  try {
    const write = addOnlySyntheticSummaryRows({ identity, records }).then(() => { observed = 'complete' }, () => { observed = 'rejected' })
    await new Promise(resolve => setImmediate(resolve))
    try {
      assert.equal(observed, 'pending')
      assert.equal(closed, 0)
    } finally { abortTransaction() }
    await write
    assert.equal(observed, 'rejected')
    assert.equal(closed, 1)
  } finally {
    if (previous === undefined) delete globalThis.indexedDB
    else globalThis.indexedDB = previous
  }
})
