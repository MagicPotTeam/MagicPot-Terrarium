import { describe, expect, it } from 'vitest'
import { changeSkillPreference, readSkillPreferenceRecords, skillPreferenceSnapshot } from './sessionPreferences'
const scope = { route: { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' }, conversationId: 'c' }
const request = { ...scope, documentToken: 'test-token', id: 'pkg-one', enabled: false, expectedRevision: 0, operationId: 'disable-1' }
describe('bounded user skill session deny preferences', () => {
  it('normalizes owner, isolates conversations and retains disabled ids independently of content changes', () => {
    const next = changeSkillPreference(undefined, request)
    expect(skillPreferenceSnapshot(next.records, scope)).toEqual({ revision: 1, disabledIds: ['pkg-one'] })
    expect(skillPreferenceSnapshot(next.records, { ...scope, conversationId: 'other' })).toEqual({ revision: 0, disabledIds: [] })
    expect(skillPreferenceSnapshot(next.records, { ...scope, route: { ...scope.route, scopeId: 'other' } }).revision).toBe(0)
    expect(JSON.stringify(next)).not.toMatch(/"p"|"c"/)
    const detached = readSkillPreferenceRecords(next.records); detached[0].disabledIds.length = 0
    expect(next.records[0].disabledIds).toEqual(['pkg-one'])
  })
  it('keeps revision/hash receipts after enabling and never reapplies an identical old disable', () => {
    const one = changeSkillPreference(undefined, request)
    const two = changeSkillPreference(one.records, { ...request, enabled: true, expectedRevision: 1, operationId: 'enable-2' })
    expect(skillPreferenceSnapshot(two.records, scope)).toEqual({ revision: 2, disabledIds: [] })
    expect(changeSkillPreference(two.records, request)).toMatchObject({ replay: true, revision: 2 })
    expect(() => changeSkillPreference(two.records, { ...request, enabled: true })).toThrow('replay conflict')
    expect(() => changeSkillPreference(two.records, { ...request, operationId: 'different' })).toThrow('revision conflict')
  })
  it('retains owner fences and rejects old changes after bounded receipt eviction', () => {
    let records = changeSkillPreference(undefined, request).records
    for (let revision = 1; revision <= 17; revision++) records = changeSkillPreference(records, { ...request, expectedRevision: revision, enabled: revision % 2 === 1, operationId: `operation-${revision}` }).records
    expect(records[0].receipts).toHaveLength(16)
    expect(() => changeSkillPreference(records, request)).toThrow('revision conflict')
    expect(skillPreferenceSnapshot(records, scope).revision).toBe(18)
  })
  it('refuses malformed records, wider selectors, unsafe revisions and capacity rather than evicting owners', () => {
    for (const value of [null, {}, [{ owner: 'not-hash' }], Array(129).fill(null)]) expect(() => readSkillPreferenceRecords(value)).toThrow('invalid')
    for (const req of [{ ...request, id: '__proto__' }, { ...request, enabled: 'true' }, { ...request, all: true }, { ...request, expectedRevision: Number.MAX_SAFE_INTEGER }]) expect(() => changeSkillPreference(undefined, req as typeof request)).toThrow('Invalid')
    let records = changeSkillPreference(undefined, request).records
    for (let i = 1; i < 128; i++) records = changeSkillPreference(records, { ...request, conversationId: `c${i}` }).records
    expect(() => changeSkillPreference(records, { ...request, conversationId: 'overflow' })).toThrow('capacity')
    expect(records).toHaveLength(128)
  })
})
