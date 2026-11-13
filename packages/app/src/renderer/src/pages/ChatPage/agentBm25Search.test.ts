import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { searchAgentSessionArchive } from './agentArchiveSearch'
const message = (text: string): ChatMessage => ({ role: 'user', content: text })
const search = (messages: ChatMessage[], query = 'blue red', extra: Record<string, unknown> = {}) => searchAgentSessionArchive(messages, { query, mode: 'bm25', limit: 1, ...extra })
describe('query-local bounded scan-window BM25', () => {
  it('ranks older relevant text beyond the first matching page and reports omitted hits rather than a fake scan cursor', async () => {
    const result = await search([message('blue red'), ...Array.from({ length: 25 }, () => message('blue ordinary filler'))])
    expect(result).toMatchObject({ mode: 'bm25', ranking: 'scan-window-bm25', engine: 'unicode-bm25-scan', truncated: false, corpus: { documents: 26, matchingDocuments: 26, omittedMatches: 25, scanComplete: true, k1: 1.2, b: 0.75 } })
    expect(result.matches).toHaveLength(1); expect(result.matches[0]).toMatchObject({ messageIndex: 0, excerpt: 'blue red', chunkStart: 0 })
    expect(result).not.toHaveProperty('nextBeforeMessage')
    const lexical = await searchAgentSessionArchive([message('blue red'), message('blue ordinary filler')], { query: 'blue red', mode: 'lexical', limit: 1 })
    expect(lexical.matches[0].messageIndex).toBe(1)
  })
  it('counts nonmatching corpus documents and normalizes frequency by length, not only term coverage', async () => {
    const result = await search([message('blue blue blue red'), message('blue ' + 'filler '.repeat(80)), message('unrelated tokens'), message('')], 'blue red', { limit: 5 })
    expect(result.corpus).toMatchObject({ documents: 3, tokens: 87, matchingDocuments: 2, omittedMatches: 0 })
    expect(result.matches.map(match => match.messageIndex)).toEqual([0, 1])
    expect(result.matches[0].score).toBeGreaterThan(result.matches[1].score!)
  })
  it.each(['ΟΣ', '𐐀', '中文'])('preserves Unicode token starts and original provenance for %s', async word => {
    const result = await search([message(`before ${word} after`)], word === 'ΟΣ' ? 'οσ' : word.toLowerCase())
    expect(result.matches).toHaveLength(1); expect(result.matches[0].excerpt).toContain(word)
    const duplicate = await search([message(`before ${word} after`)], `${word} ${word.toLowerCase()}`)
    expect(duplicate.matches[0].score).toBe(result.matches[0].score)
  })
  it('does not invent token boundaries or duplicate term frequency across 8192-character chunks', async () => {
    const suffix = 'x'.repeat(8180)
    const result = await search([message(' blue ' + suffix)], 'blue')
    expect(result.matches).toHaveLength(1)
    const falseBoundary = await search([message('blueberry' + 'x'.repeat(8190))], 'blue')
    expect(falseBoundary.matches).toEqual([])
    expect(result.matches[0].score).toBeGreaterThan(0)
    const absent = await search([message('blueberry' + 'x'.repeat(8190))], 'blueberry')
    expect(absent.matches).toEqual([])
    expect(absent.corpus!.tokens).toBe(1)
    const crossing = await search([message(' '.repeat(8189) + '𐐀 blue red ' + ' '.repeat(8190))], '𐐨 blue', { limit: 20 })
    expect(crossing.matches.length).toBeGreaterThan(0)
    expect(crossing.corpus!.tokens).toBe(3)
  })
  it('reuses explicit message/tool allowlists and redacts tool excerpts without modifying saved text', async () => {
    const receipt = 'Authorization: Bearer PRIVATE_TOKEN\nblue public receipt'
    const messages: ChatMessage[] = [{ role: 'system', content: 'SECRET_SYSTEM' }, { role: 'assistant', content: 'visible blue', hiddenContext: 'SECRET_HIDDEN', attachments: [{ type: 'file', url: 'SECRET_ATTACHMENT' }], toolHistory: [{ runId: 'r', toolCallId: 'c', toolName: 'files.read', status: 'running', args: { password: 'SECRET_ARGS' }, content: receipt, error: 'blue historical error', metadata: { token: 'SECRET_METADATA' } }] }]
    const result = await search(messages, 'blue', { source: 'tools', limit: 20 })
    expect(result.matches).toHaveLength(2)
    expect(result.matches.every(match => match.toolStatus === 'unknown' && match.toolName === 'files.read')).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TOKEN|SECRET_/)
    expect(messages[1].toolHistory![0].content).toBe(receipt)
    expect((await search(messages, 'SECRET', { source: 'all' })).matches).toEqual([])
  })
  it('reports document/token caps as partial with an advancing source cursor, not as the entire archive ranking', async () => {
    const docs = Array.from({ length: 4100 }, (_, index) => message(`blue ${index}`))
    const first = await search(docs, 'blue')
    expect(first.corpus).toMatchObject({ documents: 4096, scanComplete: false }); expect(first.truncated).toBe(true)
    expect(first.nextBeforeMessage).toBe(4)
    const rest = await search(docs, 'blue', { beforeMessage: first.nextBeforeMessage, beforeCharacter: first.nextBeforeCharacter })
    expect(rest.corpus).toMatchObject({ documents: 4, scanComplete: true }); expect(rest.truncated).toBe(false)
    const tokens = await search([message('blue '.repeat(600000))], 'blue')
    expect(tokens.corpus!.tokens).toBeLessThanOrEqual(500000); expect(tokens.truncated).toBe(true)
  })
  it('does not carry a stale character bound onto a different clamped event or message', async () => {
    const text = ' '.repeat(100) + 'blue'
    const result = await search([message(text)], 'blue', { source: 'all', beforeMessage: 1, beforeEvent: 2, beforeCharacter: 50 })
    expect(result.matches[0]).toMatchObject({ messageIndex: 0, eventIndex: 0 }); expect(result.corpus!.scanComplete).toBe(true)
    const actualBound = await search([message(text)], 'blue', { beforeMessage: 1, beforeCharacter: 50 })
    expect(actualBound.matches).toEqual([])
    const staleMessage = await search([message(text)], 'blue', { beforeMessage: 10, beforeCharacter: 50 })
    expect(staleMessage.matches).toHaveLength(1)
  })
  it('returns elapsed-time partial ranking with a valid advancing cursor and respects a delayed original expiry', async () => {
    let now = 1700000000000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { now += 400; queueMicrotask(callback); return 1 }) as typeof setTimeout)
    try {
      const docs = Array.from({ length: 4096 }, () => message('blue old receipt'))
      const first = await searchAgentSessionArchive(docs, { query: 'blue', mode: 'bm25' })
      expect(first.truncated).toBe(true); expect(first.corpus!.scanComplete).toBe(false); expect(first.corpus!.documents).toBeGreaterThan(0); expect(first.corpus!.documents).toBeLessThan(4096)
      expect(first.nextBeforeMessage).toBeLessThan(docs.length)
      // Only 800ms remains; one 400ms scan yield is permitted, but no fresh8s.
      const expiresAt = now + 800
      const second = await searchAgentSessionArchive(docs, { query: 'blue', mode: 'bm25' }, undefined, expiresAt).catch(error => error)
      expect(now).toBeLessThanOrEqual(expiresAt)
      if (second instanceof Error) expect(second.message).toContain('expired')
      else { expect(second.truncated).toBe(true); expect(second.corpus!.documents).toBeLessThan(first.corpus!.documents) }
    } finally { timer.mockRestore(); clock.mockRestore() }
  })
  it('rejects raw oversized query whitespace before context slicing and preserves a bounded trimmed query', async () => {
    await expect(search([message('blue')], 'blue' + ' '.repeat(100000))).rejects.toThrow('Invalid')
    expect((await search([message('blue')], ' blue ')).matches).toHaveLength(1)
    const { validateAgentArchiveSearch } = await import('@shared/api/agentThreadMemorySearch')
    expect(() => validateAgentArchiveSearch({ query: ' '.repeat(256) + 'blue', mode: 'bm25' })).toThrow('Invalid')
  })
  it('observes a queued cancellation before ranking even for a single completed document', async () => {
    const controller = new AbortController()
    const pending = searchAgentSessionArchive([message('blue')], { query: 'blue', mode: 'bm25' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  })
  it('checks cooperative cancellation and original expiry rather than resetting a delayed query lifetime', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(searchAgentSessionArchive([message('blue')], { query: 'blue', mode: 'bm25' }, controller.signal)).rejects.toThrow()
    await expect(searchAgentSessionArchive([message('blue')], { query: 'blue', mode: 'bm25' }, undefined, Date.now() + 100)).rejects.toThrow('lifetime')
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const current = new AbortController()
    timer.mockImplementation(((callback: () => void) => { current.abort(); queueMicrotask(callback); return 1 }) as typeof setTimeout)
    try { await expect(searchAgentSessionArchive(Array.from({ length: 200 }, () => message('blue')), { query: 'blue', mode: 'bm25' }, current.signal)).rejects.toThrow() }
    finally { timer.mockRestore() }
  })
})
