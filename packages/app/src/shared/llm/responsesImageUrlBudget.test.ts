import { describe, expect, it } from 'vitest'
import { assertResponsesImageUrlByteLowerBound } from './responsesImageUrlBudget'
import { ProviderJsonBudgetError, isTrustedProviderJsonBudgetError } from './providerJsonBudget'
import type { OpenAIResponsesInputMessage } from './openaiResponses'

const image = (image_url: string): OpenAIResponsesInputMessage['content'][number] => ({ type: 'input_image', image_url })

describe('Responses projected image URL lower bound', () => {
  it('only rejects when image URL lengths strictly exceed the limit', () => {
    const input: OpenAIResponsesInputMessage[] = [
      { role: 'user', content: [{ type: 'input_text', text: 'not counted' }, image('1234'), image('567')] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'also not counted' }] }
    ]
    expect(() => assertResponsesImageUrlByteLowerBound(input, 8)).not.toThrow()
    expect(() => assertResponsesImageUrlByteLowerBound(input, 7)).not.toThrow()
    let failure: unknown
    try { assertResponsesImageUrlByteLowerBound(input, 6) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(ProviderJsonBudgetError)
    expect(isTrustedProviderJsonBudgetError(failure)).toBe(true)
    expect((failure as ProviderJsonBudgetError).retryBlocked).toBe(true)
  })

  it('underestimates rather than overestimates JSON UTF-8 for escaping and non-ASCII', () => {
    const urls = ['a"\\\n', '中文', '😀', '\ud800']
    const input: OpenAIResponsesInputMessage[] = [{ role: 'user', content: urls.map(image) }]
    const lowerBound = urls.reduce((total, url) => total + url.length, 0)
    expect(Buffer.byteLength(JSON.stringify({ input }), 'utf8')).toBeGreaterThan(lowerBound)
    expect(() => assertResponsesImageUrlByteLowerBound(input, lowerBound)).not.toThrow()
    expect(() => assertResponsesImageUrlByteLowerBound(input, lowerBound - 1)).toThrow(ProviderJsonBudgetError)
  })

  it('rejects invalid limits rather than silently widening the provider budget', () => {
    for (const limit of [-1, NaN, Infinity, 0.5, 28 * 1024 * 1024 + 1]) {
      expect(() => assertResponsesImageUrlByteLowerBound([], limit)).toThrow('Invalid provider JSON size limit.')
    }
  })
})
