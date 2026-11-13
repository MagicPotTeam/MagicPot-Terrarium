import { describe, expect, it } from 'vitest'
import { rankBm25 } from './agentBm25'
describe('bounded Okapi BM25 arithmetic', () => {
  it('uses all corpus documents for positive IDF and length-normalized term frequency', () => {
    const scores = rankBm25([{ length: 4, frequencies: [2, 1] }, { length: 2, frequencies: [1, 0] }, { length: 6, frequencies: [0, 0] }], 2)
    expect(scores[0]).toBeCloseTo(1.6270842432246129, 12)
    expect(scores[1]).toBeCloseTo(0.5908617053374963, 12)
    expect(scores[2]).toBe(0)
    expect(rankBm25([], 1)).toEqual([])
    expect(rankBm25([{ length: 0, frequencies: [0] }], 1)).toEqual([0])
  })
  it('refuses unbounded or malformed statistics rather than fabricating scores', () => {
    for (const documents of [[{ length: -1, frequencies: [0] }], [{ length: 8193, frequencies: [1] }], [{ length: 1, frequencies: [2] }], [{ length: 1, frequencies: [1, 1] }]]) expect(() => rankBm25(documents, documents[0].frequencies.length)).toThrow('Invalid')
    expect(() => rankBm25([], 17)).toThrow('Invalid')
  })
})
