import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExternalAgentEventDecoder } from './externalAgentStream'

afterEach(() => vi.restoreAllMocks())
const header = { status: 200, statusText: 'OK', contentType: 'text/event-stream' }
const frame = (value: unknown, id?: string) =>
  Buffer.from(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(value)}\n\n`)

describe('external Agent actual wire decoder', () => {
  it('emits a complete SSE text frame while the response is still open', () => {
    const emit = vi.fn()
    const parser = createExternalAgentEventDecoder({ runId: 'owned-run', emit })
    parser.headers(header)
    expect(parser.chunk(frame({ type: 'text-delta', delta: 'first' }))).toBe(true)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text-delta', delta: 'first', runId: 'owned-run' })
    )
    expect(parser.completed).toBe(false)
    expect(parser.chunk(frame({ type: 'done' }))).toBe(false)
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'done', content: 'first' })
  })
  it('decodes split UTF-8 and frame separators without loss', () => {
    const emit = vi.fn()
    const parser = createExternalAgentEventDecoder({ runId: 'owned', emit })
    parser.headers(header)
    const bytes = frame({ type: 'text-delta', delta: '你好' })
    for (const byte of bytes) parser.chunk(Buffer.from([byte]))
    parser.chunk(frame({ type: 'done' }))
    expect(
      emit.mock.calls
        .filter(([e]) => e.type === 'text-delta')
        .map(([e]) => e.delta)
        .join('')
    ).toBe('你好')
  })
  it('deduplicates identical event IDs, rejects a conflicting replay, and never reconnects', () => {
    const emit = vi.fn()
    const parser = createExternalAgentEventDecoder({ runId: 'owned', emit })
    parser.headers(header)
    const bytes = frame({ type: 'text-delta', delta: 'once' }, 'e1')
    parser.chunk(bytes)
    parser.chunk(bytes)
    expect(emit).toHaveBeenCalledOnce()
    expect(() => parser.chunk(frame({ type: 'text-delta', delta: 'changed' }, 'e1'))).toThrow(
      /conflicting/
    )
  })
  it('rejects premature EOF with partial text preserved', () => {
    const parser = createExternalAgentEventDecoder({ runId: 'owned', emit: vi.fn() })
    parser.headers(header)
    parser.chunk(frame({ type: 'text-delta', delta: 'partial' }))
    expect(() => parser.end()).toThrow(/incomplete-stream/)
    expect(parser.partialContent).toBe('partial')
  })
  it('does not invent text deltas for JSON-only services', () => {
    const emit = vi.fn()
    const parser = createExternalAgentEventDecoder({ runId: 'owned', emit })
    parser.headers({ ...header, contentType: 'application/json' })
    parser.chunk(Buffer.from('{"content":"one response"}'))
    expect(emit).not.toHaveBeenCalled()
    parser.end()
    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0][0]).toMatchObject({
      type: 'done',
      content: 'one response',
      metadata: { streaming: false }
    })
  })
  it('parses NDJSON and has one error terminal without later deltas', () => {
    const emit = vi.fn()
    const parser = createExternalAgentEventDecoder({ runId: 'owned', emit })
    parser.headers({ ...header, contentType: 'application/x-ndjson' })
    parser.chunk(
      Buffer.from(
        '{"type":"error","error":"fixture failed"}\n{"type":"text-delta","delta":"late"}\n'
      )
    )
    expect(emit.mock.calls.map(([e]) => e.type)).toEqual(['error', 'done'])
    expect(emit.mock.calls.at(-1)?.[0].finishReason).toBe('error')
  })
  it('cancels between callbacks without emitting additional events', () => {
    const controller = new AbortController()
    const emit = vi.fn(() => controller.abort())
    const parser = createExternalAgentEventDecoder({
      runId: 'owned',
      emit,
      signal: controller.signal
    })
    parser.headers(header)
    expect(() =>
      parser.chunk(
        Buffer.concat([frame({ type: 'text-delta', delta: 'first' }), frame({ type: 'done' })])
      )
    ).toThrow()
    expect(emit).toHaveBeenCalledOnce()
  })
  it('rejects invalid JSON and oversized unframed events before emitting', () => {
    const emit = vi.fn()
    const parser = createExternalAgentEventDecoder({ runId: 'owned', emit })
    parser.headers(header)
    expect(() => parser.chunk(Buffer.from('data: not-json\n\n'))).toThrow()
    expect(emit).not.toHaveBeenCalled()
    expect(() => parser.chunk(Buffer.from('x'.repeat(600_000)))).toThrow(/large/)
  })
})
