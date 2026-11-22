import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { searchAgentSessionArchive } from './agentArchiveSearch'

describe('archive text search over saved raw messages', () => {
  it('finds a message absent from the compacted request without exposing hidden fields', async () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'SECRET_SYSTEM' }, { role: 'user', content: 'Old BLUE specification', hiddenContext: 'SECRET_HIDDEN', attachments: [{ type: 'file', url: 'SECRET_ATTACHMENT' }] }, { role: 'assistant', content: 'Later answer', toolHistory: [{ runId: 'r', toolCallId: 'c', toolName: 'read', args: {}, status: 'completed', content: 'SECRET_TOOL' }] }]
    expect(await searchAgentSessionArchive(messages, { query: 'blue' })).toMatchObject({ source: 'session_archive', mode: 'literal', matches: [{ messageIndex: 1, role: 'user', excerpt: 'Old BLUE specification' }], truncated: false })
    expect((await searchAgentSessionArchive(messages, { query: 'SECRET' })).matches).toEqual([])
    expect(messages[1].hiddenContext).toBe('SECRET_HIDDEN')
  })
  it('pages from recent to older message indexes without regex semantics', async () => {
    const messages: ChatMessage[] = Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: `Literal .* marker-${index}` }))
    const first = await searchAgentSessionArchive(messages, { query: '.*', limit: 2 })
    expect(first.matches.map((match) => match.messageIndex)).toEqual([4, 3])
    expect(first.nextBeforeMessage).toBe(3)
    const second = await searchAgentSessionArchive(messages, { query: '.*', limit: 2, beforeMessage: first.nextBeforeMessage })
    expect(second.matches.map((match) => match.messageIndex)).toEqual([2, 1])
    const third = await searchAgentSessionArchive(messages, { query: '.*', limit: 2, beforeMessage: second.nextBeforeMessage })
    expect(third.matches.map((match) => match.messageIndex)).toEqual([0])
    expect(third.nextBeforeMessage).toBeUndefined()
    expect(third.truncated).toBe(false)
  })
  it('bounds excerpts and scanning and truthfully reports skipped long tails', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(300000) + 'TAIL_ONLY' }, { role: 'assistant', content: 'keyword ' + 'x'.repeat(2000) }]
    const result = await searchAgentSessionArchive(messages, { query: 'keyword' })
    expect(result.matches[0].excerpt.length).toBeLessThanOrEqual(500)
    expect(result.truncated).toBe(false)
    expect((await searchAgentSessionArchive(messages, { query: 'TAIL_ONLY' })).matches[0].excerpt).toContain('TAIL_ONLY')
  })
  it('continues within a long message when a scan budget is reached and covers chunk-boundary matches', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'OLD_HEAD_TOKEN' + 'x'.repeat(9 * 1024 * 1024) + 'NEW_TAIL_TOKEN' }]
    const first = await searchAgentSessionArchive(messages, { query: 'OLD_HEAD_TOKEN' })
    expect(first.matches).toEqual([])
    expect(first.nextBeforeMessage).toBe(1)
    expect(first.nextBeforeCharacter).toBeGreaterThan(0)
    const second = await searchAgentSessionArchive(messages, { query: 'OLD_HEAD_TOKEN', beforeMessage: first.nextBeforeMessage, beforeCharacter: first.nextBeforeCharacter })
    expect(second.matches[0].excerpt).toContain('OLD_HEAD_TOKEN')
    expect(second.truncated).toBe(false)
    const boundary: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(500) + 'BOUNDARY_TOKEN' + 'x'.repeat(262140) }]
    expect((await searchAgentSessionArchive(boundary, { query: 'BOUNDARY_TOKEN' })).matches[0].excerpt).toContain('BOUNDARY_TOKEN')
  })
  it.each(['İx', 'İ'.repeat(600) + 'TARGET' + 'İ'.repeat(500), '𐐀 text'])('preserves original excerpt offsets for Unicode lowercase in %s', async (text) => {
    const query = text.includes('TARGET') ? 'target' : text.startsWith('İ') ? 'x' : '𐐨'
    const result = await searchAgentSessionArchive([{ role: 'user', content: text }], { query })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].excerpt).toContain(text.includes('TARGET') ? 'TARGET' : text.startsWith('İ') ? 'x' : '𐐀')
  })
  it('finds Greek sigma independently of chunk casing context', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'ΟΣ' + 'x'.repeat(262144) }]
    expect((await searchAgentSessionArchive(messages, { query: 'σ' })).matches[0].excerpt).toContain('ΟΣ')
    expect((await searchAgentSessionArchive([{ role: 'user', content: 'ος' }], { query: 'Σ' })).matches[0].excerpt).toContain('ος')
  })
  it('honors cancellation while yielding on long histories', async () => {
    const controller = new AbortController()
    const messages: ChatMessage[] = Array.from({ length: 1000 }, () => ({ role: 'user', content: 'note' }))
    const search = searchAgentSessionArchive(messages, { query: 'missing' }, controller.signal)
    controller.abort()
    await expect(search).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('rejects blank, invalid cursor and unsupported mode-like inputs at the tool boundary', async () => {
    await expect(searchAgentSessionArchive([], { query: ' ' })).rejects.toThrow('Invalid')
    await expect(searchAgentSessionArchive([], { query: 'x', beforeMessage: -1 })).rejects.toThrow('Invalid')
    await expect(searchAgentSessionArchive([], { query: 'x', limit: 21 })).rejects.toThrow('Invalid')
  })
})
