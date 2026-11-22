// Synthetic data and coordination contract only. This module does not establish isolation.
const reservations = new WeakSet()
const entries = Object.freeze([
  Object.freeze({ name: '设计师', content: 'fixture-design-result-vt34qf-1' }),
  Object.freeze({ name: '文案', content: 'fixture-writer-result-vt34qf-1' })
])

export function buildLeadSummarySeed(identity) {
  if (!identity || typeof identity !== 'object' || typeof identity.scope !== 'string' || !identity.scope || typeof identity.leadId !== 'string' || !identity.leadId || typeof identity.profileId !== 'string' || !identity.profileId || !Array.isArray(identity.memberIds) || identity.memberIds.length !== 2) throw new TypeError('Invalid synthetic identity')
  // Copy only the two indexed primitives; do not trust caller-supplied array
  // methods or iterators for either validation or construction.
  const ids = [identity.memberIds[0], identity.memberIds[1]]
  if (ids.some(id => typeof id !== 'string' || !id) || new Set([identity.leadId, ...ids]).size !== 3) throw new TypeError('Invalid synthetic identity')
  return entries.map(({ name, content }, index) => ({
    id: ids[index], storageKey: `${identity.scope}\u0000${ids[index]}`, storageScope: identity.scope,
    title: name, teamLeadId: identity.leadId, teamMemberName: name, teamRole: name, profileId: identity.profileId, createdAt: 2 - index,
    messages: [{ role: 'assistant', content }]
  }))
}

// An opaque object is an attempt key, not proof of authorization or isolation.
// Coordinator methods are injected; this contract itself never accesses a page or IDB.
export async function coordinateLeadSummarySeed(handle, identity, coordinator, signal) {
  if (!handle || (typeof handle !== 'object' && typeof handle !== 'function')) throw new TypeError('Opaque handle required')
  if (reservations.has(handle)) throw new Error('Seed already attempted; outcome may be unknown')
  reservations.add(handle)
  const records = buildLeadSummarySeed(identity)
  if (!coordinator || typeof coordinator.addOnlyAndCommit !== 'function' || typeof coordinator.read !== 'function' || typeof coordinator.reload !== 'function') throw new TypeError('Coordinator required')
  if (signal?.aborted) throw Error('Synthetic seed aborted; outcome may be unknown')
  await coordinator.addOnlyAndCommit(records)
  if (signal?.aborted) throw Error('Synthetic seed aborted; outcome may be unknown')
  const observed = await coordinator.read(records.map(record => record.storageKey))
  if (signal?.aborted) throw Error('Synthetic seed aborted; outcome may be unknown')
  if (JSON.stringify(observed) !== JSON.stringify(records)) throw new Error('Synthetic seed readback mismatch')
  await coordinator.reload()
  if (signal?.aborted) throw Error('Synthetic seed aborted; outcome may be unknown')
  return records
}
