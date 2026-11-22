import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import type { AgentArchiveSearch, AgentArchiveSearchResult } from '@shared/api/agentThreadMemory'
import { searchAgentSessionArchive } from './agentArchiveSearch'
const cursor = (result: AgentArchiveSearchResult) => ({ beforeMessage: result.nextBeforeMessage, beforeEvent: result.nextBeforeEvent, beforeCharacter: result.nextBeforeCharacter })
const toolMessage = (content: string, error?: string): ChatMessage => ({ role: 'assistant', content: 'assistant prose', toolHistory: [{ runId: 'r', toolCallId: 'call', toolName: 'files.read', status: 'completed', args: { path: 'SECRET_ARGS' }, content, error, metadata: { token: 'SECRET_METADATA' } }] })
describe('current-session tool event and lexical search', () => {
  it('searches only explicit saved result/error fields with original provenance and no args/metadata/hidden/system data', async () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'SECRET_SYSTEM' }, { ...toolMessage('result blue receipt', 'failed blue request'), hiddenContext: 'SECRET_HIDDEN', attachments: [{ type: 'file', url: 'SECRET_ATTACHMENT' }] }]
    expect((await searchAgentSessionArchive(messages, { query: 'blue' })).matches).toEqual([])
    const result = await searchAgentSessionArchive(messages, { query: 'blue', source: 'tools' })
    expect(result.matches).toEqual([
      expect.objectContaining({ messageIndex: 1, eventIndex: 2, toolIndex: 0, toolName: 'files.read', kind: 'tool_error', toolStatus: 'completed', excerpt: 'failed blue request' }),
      expect.objectContaining({ messageIndex: 1, eventIndex: 1, kind: 'tool_result', excerpt: 'result blue receipt' })
    ])
    expect((await searchAgentSessionArchive(messages, { query: 'SECRET', source: 'all' })).matches).toEqual([])
    expect((await searchAgentSessionArchive(messages, { query: 'blue', source: 'tools', toolName: 'files.write' })).matches).toEqual([])
  })
  it('keeps unknown historical running status distinct from success and leaves source messages default', async () => {
    const message = toolMessage('output fragment'); message.toolHistory![0].status = 'running'
    expect((await searchAgentSessionArchive([message], { query: 'output', source: 'tools' })).matches[0].toolStatus).toBe('unknown')
    expect((await searchAgentSessionArchive([message], { query: 'assistant' })).matches[0]).not.toHaveProperty('kind')
  })
  it('continues through result/error/message events without duplicates or skipped events', async () => {
    const messages = [toolMessage('receipt 1', 'receipt 2'), toolMessage('receipt 3', 'receipt 4')]
    messages[0].content = 'receipt prose 0'; messages[1].content = 'receipt prose 1'
    let search: AgentArchiveSearch = { query: 'receipt', source: 'all', limit: 1 }
    const hits: string[] = []
    for (let i = 0; i < 8; i++) {
      const result = await searchAgentSessionArchive(messages, search)
      hits.push(...result.matches.map((match) => `${match.messageIndex}:${match.eventIndex}`))
      if (!result.truncated) break
      search = { ...search, ...cursor(result) }
    }
    expect(hits).toEqual(['1:2', '1:1', '1:0', '0:2', '0:1', '0:0'])
  })
  it('paginates oversized tool bodies and matches across chunk boundaries', async () => {
    const messages = [toolMessage('HEAD_MARKER ' + 'x'.repeat(9 * 1024 * 1024) + ' TAIL_MARKER')]
    const first = await searchAgentSessionArchive(messages, { query: 'HEAD_MARKER', source: 'tools' })
    expect(first.matches).toEqual([]); expect(first.nextBeforeEvent).toBe(2); expect(first.nextBeforeCharacter).toBeGreaterThan(0)
    expect((await searchAgentSessionArchive(messages, { query: 'HEAD_MARKER', source: 'tools', ...cursor(first) })).matches[0].excerpt).toContain('HEAD_MARKER')
    const crossing = [toolMessage('x'.repeat(500) + 'BOUNDARY_TOKEN' + 'x'.repeat(262140))]
    const crossingResult = await searchAgentSessionArchive(crossing, { query: 'BOUNDARY_TOKEN', source: 'tools' })
    expect(crossingResult.matches[0]).toMatchObject({ toolName: 'files.read' })
  })
  it('lexical ranks only its bounded recent match page, uses full tokens not substrings and never claims embeddings', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Blue red' }, { role: 'assistant', content: 'blue' }, { role: 'user', content: 'blueberry' }]
    const result = await searchAgentSessionArchive(messages, { query: 'red blue', mode: 'lexical', limit: 2 })
    expect(result).toMatchObject({ mode: 'lexical', engine: 'unicode-token-scan', ranking: 'page-local-token-coverage' })
    expect(result.matches.map((match) => [match.messageIndex, match.score])).toEqual([[0, 1], [1, 0.5]])
    const page = await searchAgentSessionArchive(messages, { query: 'red blue', mode: 'lexical', limit: 1 })
    expect(page.matches[0].messageIndex).toBe(1); expect(page.truncated).toBe(true)
    expect((await searchAgentSessionArchive(messages, { query: 'red blue', mode: 'lexical', limit: 1, ...cursor(page) })).matches[0].messageIndex).toBe(0)
  })
  it.each(['ΟΣ', '𐐀', '中文'])('preserves Unicode matching and provenance for %s', async (word) => {
    const result = await searchAgentSessionArchive([toolMessage(`before ${word} after`)], { query: word === 'ΟΣ' ? 'οσ' : word.toLowerCase(), mode: 'lexical', source: 'tools' })
    expect(result.matches).toHaveLength(1); expect(result.matches[0].excerpt).toContain(word)
  })
  it('does not create token boundaries at scan chunks or split supplementary code points', async () => {
    const texts = [
      { text: 'blueberry' + 'x'.repeat(262140), query: 'blue', expected: false },
      { text: ' blue ' + 'x'.repeat(262142), query: 'blue', expected: true },
      { text: ' 𐐀 ' + 'x'.repeat(262142), query: '𐐨', expected: true },
      { text: '𐐀blue ' + 'x'.repeat(262142), query: 'blue', expected: false }
    ]
    for (const item of texts) {
      const output = await searchAgentSessionArchive([toolMessage(item.text)], { query: item.query, source: 'tools', mode: 'lexical' })
      expect(output.matches.length > 0).toBe(item.expected)
    }
  })
  it('redacts known credential patterns in returned tool excerpts but leaves stored bodies/cursors untouched', async () => {
    const source = 'Authorization: Bearer PRIVATE_BEARER\nCookie: session=PRIVATE_COOKIE\nhttps://user:PRIVATE_PASS@example.com?token=PRIVATE_TOKEN\npublic receipt'
    const message = toolMessage(source)
    const result = await searchAgentSessionArchive([message], { query: 'Authorization', source: 'tools' })
    expect(result.matches[0].excerpt).toContain('[redacted]')
    expect(result.matches[0].excerpt).not.toContain('PRIVATE_')
    expect(message.toolHistory![0].content).toBe(source)
    expect(result.matches[0].eventIndex).toBe(1)
  })
  it('uses remaining absolute query lifetime after delayed renderer delivery', async () => {
    const message = toolMessage(''); message.toolHistory = Array.from({ length: 30000 }, (_, i) => ({ runId: 'r', toolCallId: String(i), toolName: 'files.read', args: {}, status: 'completed', content: '' }))
    let clock = 9400
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { clock += 4; queueMicrotask(callback); return 1 }) as typeof setTimeout)
    try {
      const result = await searchAgentSessionArchive([message], { query: 'missing', source: 'tools' }, undefined, 10000)
      expect(result.truncated).toBe(true); expect(result.scannedEvents).toBeGreaterThan(0); expect(result.scannedEvents).toBeLessThan(50000)
      expect(clock).toBeLessThan(9800); expect(result.nextBeforeEvent).toBeGreaterThan(0)
      await expect(searchAgentSessionArchive([message], { query: 'missing', source: 'tools' }, undefined, clock + 200)).rejects.toThrow('lifetime')
    } finally { now.mockRestore(); timer.mockRestore() }
  })
  it('yields for cancellation even when traversing many nonmatching events', async () => {
    const message = toolMessage(''); message.toolHistory = Array.from({ length: 10000 }, (_, i) => ({ runId: 'r', toolCallId: String(i), toolName: 'files.read', args: {}, status: 'completed', content: '' }))
    const controller = new AbortController(), pending = searchAgentSessionArchive([message], { query: 'missing', source: 'tools' }, controller.signal)
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('returns an advancing cursor for large empty event histories under browser-like nested timer clamping', async () => {
    const message = toolMessage(''); message.toolHistory = Array.from({ length: 30000 }, (_, i) => ({ runId: 'r', toolCallId: String(i), toolName: 'files.read', args: {}, status: 'completed', content: '' }))
    let clock = 0, yields = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { yields++; clock += 4; queueMicrotask(callback); return 1 }) as typeof setTimeout)
    try {
      const first = await searchAgentSessionArchive([message], { query: 'missing', source: 'tools' })
      expect(first.scannedEvents).toBe(50000); expect(first.truncated).toBe(true)
      expect(yields).toBeLessThan(500); expect(clock).toBeLessThan(8000)
      expect(first.nextBeforeEvent).toBeGreaterThan(0)
      const second = await searchAgentSessionArchive([message], { query: 'missing', source: 'tools', ...cursor(first) })
      expect(second.truncated).toBe(false)
      expect(first.scannedEvents! + second.scannedEvents!).toBe(60001)
    } finally { now.mockRestore(); timer.mockRestore() }
  })
  it('returns partial progress before the query deadline instead of losing its continuation cursor', async () => {
    const message = toolMessage(''); message.toolHistory = Array.from({ length: 2000 }, (_, i) => ({ runId: 'r', toolCallId: String(i), toolName: 'files.read', args: {}, status: 'completed', content: '' }))
    let clock = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { clock += 1000; queueMicrotask(callback); return 1 }) as typeof setTimeout)
    try {
      const first = await searchAgentSessionArchive([message], { query: 'missing', source: 'tools' })
      expect(first.truncated).toBe(true); expect(first.scannedEvents).toBeGreaterThan(0)
      expect(first.nextBeforeEvent).toBeGreaterThan(0); expect(clock).toBeLessThan(10000)
    } finally { now.mockRestore(); timer.mockRestore() }
  })
  it.each([
    { query: 'x', mode: 'semantic' }, { query: 'x', mode: 'hybrid' }, { query: '.*', mode: 'lexical' },
    { query: 'x', source: 'tools', beforeCharacter: 2, beforeMessage: 1 }, { query: 'x', beforeEvent: 1, beforeMessage: 1 },
    { query: 'x', toolName: 'files.read' }, { query: 'x', source: 'other' }, { query: 'x', source: 'tools', toolName: '../bad' }
  ])('rejects invalid or unsupported query %j', async (query) => await expect(searchAgentSessionArchive([], query as AgentArchiveSearch)).rejects.toThrow())
})
