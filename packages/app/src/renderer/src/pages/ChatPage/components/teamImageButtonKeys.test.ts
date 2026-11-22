import { describe, expect, it } from 'vitest'
import { reconcileTeamImageButtonKeys, type TeamImageButtonKeyState } from './teamImageButtonKeys'

describe('member image button key state', () => {
  it('matches the old index-and-url reuse rule without putting URL data in current keys', () => {
    const urls = Array.from({ length: 8 }, (_, index) => `data:image/png;base64,${String.fromCharCode(65 + index).repeat(4096)}`)
    let state: TeamImageButtonKeyState = { nextId: 0, entries: [] }
    const before = urls.map((url, index) => `${index}:${url}`)
    for (let pass = 0; pass < 25; pass++) state = reconcileTeamImageButtonKeys(state, [...urls])
    const after = state.entries.map(entry => entry.key)
    expect(new Set(after).size).toBe(8)
    expect(after.every(key => key.length < 32)).toBe(true)
    expect(after.reduce((sum, key) => sum + key.length, 0)).toBeLessThan(before.reduce((sum, key) => sum + key.length, 0) / 100)
    expect(state.entries.map(entry => entry.url)).toEqual(urls)
    expect(reconcileTeamImageButtonKeys(state, urls)).toBe(state)
  })
  it('removes absent sources and keeps old identity only at the same index', () => {
    const first = reconcileTeamImageButtonKeys({ nextId: 0, entries: [] }, ['a', 'a', 'b'])
    const reordered = reconcileTeamImageButtonKeys(first, ['a', 'b', 'a'])
    expect(reordered.entries[0]).toBe(first.entries[0])
    expect(reordered.entries[1].key).not.toBe(first.entries[1].key)
    expect(reordered.entries[2].key).not.toBe(first.entries[2].key)
    const removed = reconcileTeamImageButtonKeys(reordered, ['a'])
    expect(removed.entries.map(entry => entry.url)).toEqual(['a'])
    const readded = reconcileTeamImageButtonKeys(removed, ['a', 'b', 'a'])
    expect(readded.entries[1].key).not.toBe(reordered.entries[1].key)
    expect(readded.entries[2].key).not.toBe(reordered.entries[2].key)
    expect(first.entries.map(entry => entry.url)).toEqual(['a', 'a', 'b'])
  })
})
