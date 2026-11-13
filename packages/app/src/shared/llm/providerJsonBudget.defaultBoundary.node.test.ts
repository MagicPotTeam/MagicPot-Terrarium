import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROVIDER_JSON_MAX_BYTES, ProviderJsonBudgetError, providerJsonUtf8Bytes, serializeProviderJsonWithBudget } from './providerJsonBudget'

describe('default provider JSON wire budget', () => {
  it('accepts exactly 28 MiB and rejects one byte more before a fake provider POST', async () => {
    const fakeProviderPost = vi.fn(async (_body: string) => undefined)
    const send = async (text: string) => {
      const body = serializeProviderJsonWithBudget({ text })
      await fakeProviderPost(body)
      return body
    }
    // ASCII payload makes the UTF-8 boundary exact, including JSON syntax.
    const overhead = providerJsonUtf8Bytes(JSON.stringify({ text: '' }))
    const text = 'x'.repeat(DEFAULT_PROVIDER_JSON_MAX_BYTES - overhead)
    const exact = await send(text)
    expect(providerJsonUtf8Bytes(exact)).toBe(DEFAULT_PROVIDER_JSON_MAX_BYTES)
    expect(fakeProviderPost).toHaveBeenCalledOnce()
    fakeProviderPost.mockClear()
    await expect(send(text + 'x')).rejects.toBeInstanceOf(ProviderJsonBudgetError)
    expect(fakeProviderPost).not.toHaveBeenCalled()
  })
})
