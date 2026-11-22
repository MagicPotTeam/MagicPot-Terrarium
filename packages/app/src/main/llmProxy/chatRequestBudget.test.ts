import { describe, expect, it } from 'vitest'
import { assertChatRequestBodyBudget, ChatRequestBudgetError, DEFAULT_CHAT_REQUEST_BODY_LIMIT } from './chatRequestBudget'

function code(fn: () => unknown, expected: string) {
  try { fn(); throw Error('expected rejection') } catch (error) {
    expect(error).toBeInstanceOf(ChatRequestBudgetError)
    expect((error as ChatRequestBudgetError).code).toBe(expected)
  }
}
describe('chat request byte budget', () => {
  it('counts exact UTF-8 JSON bytes and permits the boundary', () => {
    const body = JSON.stringify({ text: '中文😀' }), bytes = Buffer.byteLength(body, 'utf8')
    expect(bytes).toBeGreaterThan(body.length)
    expect(assertChatRequestBodyBudget(body, bytes)).toBe(bytes)
    code(() => assertChatRequestBodyBudget(body, bytes - 1), 'BODY_TOO_LARGE')
    expect(assertChatRequestBodyBudget('', 0)).toBe(0)
  })
  it('uses view lengths and enforces default and stricter limits', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]), view = bytes.subarray(1, 3)
    expect(assertChatRequestBodyBudget(view, 2)).toBe(2)
    expect(assertChatRequestBodyBudget(Buffer.from(bytes), 4)).toBe(4)
    expect(assertChatRequestBodyBudget(bytes.buffer, 4)).toBe(4)
    code(() => assertChatRequestBodyBudget(bytes.buffer, 3), 'BODY_TOO_LARGE')
    expect(assertChatRequestBodyBudget(new Uint8Array(DEFAULT_CHAT_REQUEST_BODY_LIMIT))).toBe(DEFAULT_CHAT_REQUEST_BODY_LIMIT)
    code(() => assertChatRequestBodyBudget(new Uint8Array(DEFAULT_CHAT_REQUEST_BODY_LIMIT + 1)), 'BODY_TOO_LARGE')
  })
  it('rejects invalid limits and unknown bodies without consuming them', () => {
    for (const limit of [-1, 0.5, NaN, Infinity, DEFAULT_CHAT_REQUEST_BODY_LIMIT + 1]) code(() => assertChatRequestBodyBudget('', limit), 'INVALID_LIMIT')
    for (const body of [null, undefined, {}, new DataView(new ArrayBuffer(2)), new FormData(), new ReadableStream()]) code(() => assertChatRequestBodyBudget(body), 'UNSUPPORTED_BODY')
  })
})
