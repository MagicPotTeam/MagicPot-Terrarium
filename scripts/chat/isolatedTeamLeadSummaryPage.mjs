// Synthetic, add-only page adapter for an already isolated caller-owned profile.
// This module does not create a profile, launch Electron, authorize a page, or
// bound/cancel IPC. Call only after verifying the complete isolated environment.
import { waitForIsolatedTeamPane } from './isolatedTeamDesktopFixture.mjs'
import { buildLeadSummarySeed, coordinateLeadSummarySeed } from './isolatedTeamLeadSummarySeed.mjs'

const attempts = new WeakSet()
const attemptedIdentities = new WeakSet()

// Exported so an in-memory fake IndexedDB can exercise the exact callback.
// Production callers should invoke it only via Page.evaluate in the controlled
// renderer. Never use it with a personal profile or any unknown session.
export async function addOnlySyntheticSummaryRows({ identity, records }) {
  const expectedNames = ['设计师', '文案']
  const expectedContent = ['fixture-design-result-vt34qf-1', 'fixture-writer-result-vt34qf-1']
  if (!identity || identity.profileId !== 'isolated-image-responses' || typeof identity.scope !== 'string' || typeof identity.sessionId !== 'string' || !Array.isArray(records) || records.length !== 2) throw Error('Invalid synthetic rows')
  const identitySnapshot = { scope: identity.scope, sessionId: identity.sessionId, profileId: identity.profileId }
  if (identitySnapshot.profileId !== 'isolated-image-responses' || typeof identitySnapshot.scope !== 'string' || typeof identitySnapshot.sessionId !== 'string') throw Error('Invalid synthetic rows')
  const validId = value => typeof value === 'string' && /^isolated-summary-member-[0-9a-f-]{36}$/.test(value)
  const items = [records[0], records[1]]
  const ids = [items[0]?.id, items[1]?.id]
  if (new Set(ids).size !== 2 || items.some((record, index) => {
    const expected = { id: ids[index], storageKey: `${identitySnapshot.scope}\u0000${ids[index]}`, storageScope: identitySnapshot.scope, title: expectedNames[index], teamLeadId: identitySnapshot.sessionId, teamMemberName: expectedNames[index], teamRole: expectedNames[index], profileId: identitySnapshot.profileId, createdAt: 2 - index, messages: [{ role: 'assistant', content: expectedContent[index] }] }
    return !validId(ids[index]) || JSON.stringify(record) !== JSON.stringify(expected)
  })) throw Error('Invalid synthetic rows')
  // Construct the actual values locally after validation; do not retain caller
  // objects across the await before the transaction queues its add requests.
  const cleanRecords = ids.map((id, index) => ({ id, storageKey: `${identitySnapshot.scope}\u0000${id}`, storageScope: identitySnapshot.scope, title: expectedNames[index], teamLeadId: identitySnapshot.sessionId, teamMemberName: expectedNames[index], teamRole: expectedNames[index], profileId: identitySnapshot.profileId, createdAt: 2 - index, messages: [{ role: 'assistant', content: expectedContent[index] }] }))
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('magicpot-chat', 2)
    let settled = false
    request.onupgradeneeded = () => request.transaction.abort()
    request.onerror = () => { if (!settled) { settled = true; reject(request.error || Error('Synthetic database unavailable')) } }
    request.onblocked = () => { if (!settled) { settled = true; reject(Error('Synthetic database blocked')) } }
    request.onsuccess = () => { if (settled) request.result.close(); else { settled = true; resolve(request.result) } }
  })
  try {
    if (!db.objectStoreNames.contains('sessions-v2')) throw Error('Synthetic store unavailable')
    await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions-v2', 'readwrite')
      const store = tx.objectStore('sessions-v2')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error || Error('Synthetic seed transaction aborted'))
      // Request errors bubble through the transaction before its terminal abort.
      // Wait for complete/abort instead of treating an error event as settlement.
      if (store.keyPath !== 'storageKey') { tx.abort(); return }
      const leadRequest = store.get(`${identitySnapshot.scope}\u0000${identitySnapshot.sessionId}`)
      leadRequest.onsuccess = () => {
        try {
          const lead = leadRequest.result
          if (!lead || lead.id !== identitySnapshot.sessionId || lead.storageScope !== identitySnapshot.scope || lead.profileId !== identitySnapshot.profileId || lead.teamLeadId || lead.archived || lead.teamEnded || !Array.isArray(lead.messages) || lead.messages.length !== 0) { tx.abort(); return }
          for (const record of cleanRecords) store.add(record)
        } catch { tx.abort() }
      }
    })
  } finally { db.close() }
}

export async function readSyntheticSummaryRows({ keys }) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('magicpot-chat', 2)
    let settled = false
    request.onupgradeneeded = () => request.transaction.abort()
    request.onerror = () => { if (!settled) { settled = true; reject(request.error || Error('Synthetic database unavailable')) } }
    request.onblocked = () => { if (!settled) { settled = true; reject(Error('Synthetic database blocked')) } }
    request.onsuccess = () => { if (settled) request.result.close(); else { settled = true; resolve(request.result) } }
  })
  try {
    if (!db.objectStoreNames.contains('sessions-v2')) throw Error('Synthetic store unavailable')
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions-v2', 'readonly')
      const store = tx.objectStore('sessions-v2')
      const rows = new Array(keys.length)
      tx.oncomplete = () => resolve(rows)
      tx.onabort = () => reject(tx.error || Error('Synthetic read transaction aborted'))
      tx.onerror = () => reject(tx.error || Error('Synthetic read transaction failed'))
      if (store.keyPath !== 'storageKey') { tx.abort(); return }
      keys.forEach((key, index) => { const request = store.get(key); request.onsuccess = () => { rows[index] = request.result } })
    })
  } finally { db.close() }
}

/**
 * The seed builder and coordinator validate synthetic data and reserve the
 * attempt synchronously. This adapter reserves both page and identity
 * before the first await as an additional same-module, same-object safeguard.
 * The existing fixture's opaque identity is checked by waitForIsolatedTeamPane;
 * neither that identity nor this check proves profile/network isolation.
 */
export async function seedSummaryOnIsolatedPage(page, identity, memberIds, { signal } = {}) {
  if (!page || (typeof page !== 'object' && typeof page !== 'function')) throw TypeError('Page required')
  // Reserve both page and identity before any awaited operation. Neither is an
  // authorization token or a durable, cross-process reservation.
  if (!identity || (typeof identity !== 'object' && typeof identity !== 'function') || !Array.isArray(memberIds)) throw TypeError('Synthetic seed inputs required')
  if (attempts.has(page) || attemptedIdentities.has(identity)) throw Error('Page or lead seed already attempted; outcome may be unknown')
  attempts.add(page)
  attemptedIdentities.add(identity)
  const assertActive = () => { if (signal?.aborted) throw Error('Synthetic member seed aborted; outcome may be unknown') }
  assertActive()
  await waitForIsolatedTeamPane(page, identity)
  assertActive()
  const seedIdentity = { scope: identity.scope, leadId: identity.sessionId, profileId: identity.profileId, memberIds }
  const expected = buildLeadSummarySeed(seedIdentity)
  return coordinateLeadSummarySeed(page, seedIdentity, {
    addOnlyAndCommit: records => {
      if (JSON.stringify(records) !== JSON.stringify(expected)) throw Error('Unexpected synthetic rows')
      return page.evaluate(addOnlySyntheticSummaryRows, { identity, records })
    },
    read: keys => page.evaluate(readSyntheticSummaryRows, { keys }),
    reload: async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
      assertActive()
      await waitForIsolatedTeamPane(page, identity)
    }
  }, signal)
}
