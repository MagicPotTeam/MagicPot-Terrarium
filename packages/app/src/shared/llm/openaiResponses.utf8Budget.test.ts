import { describe, expect, it, vi } from 'vitest'
import { assertOpenAIResponsesRequestBodySize, DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY } from './openaiResponses'

describe('Responses UTF-8 budget counting', () => {
  it('matches browser TextEncoder at exact bounds without invoking it in the guard', () => {
    const inputs = ['', 'ASCII\0\u007f\u0080\u07ff\u0800\uffff', '中文😀', '\ud800', '\udc00', '\udc00\ud800', '\ud800\ud800\udc00', JSON.stringify({ text: '中文😀\ud800' })]
    let seed = 123456789
    for (let i = 0; i < 200; i++) {
      let value = ''
      for (let j = 0; j < i % 47; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; value += String.fromCharCode(seed >>> 16) }
      inputs.push(value, JSON.stringify({ value }))
    }
    const lengths = inputs.map(value => new TextEncoder().encode(value).byteLength)
    const spy = vi.spyOn(TextEncoder.prototype, 'encode')
    try {
      inputs.forEach((value, i) => {
        const bytes = lengths[i], policy = { ...DEFAULT_OPENAI_RESPONSES_IMAGE_POLICY, maxRequestBodyBytes: bytes }
        expect(() => assertOpenAIResponsesRequestBodySize(value, policy)).not.toThrow()
        expect(() => assertOpenAIResponsesRequestBodySize(value, { ...policy, maxRequestBodyBytes: bytes - 1 })).toThrow(`OpenAI Responses request body exceeds the ${bytes - 1}-byte limit.`)
      })
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})
