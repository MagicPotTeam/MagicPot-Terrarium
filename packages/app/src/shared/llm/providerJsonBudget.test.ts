import { describe, expect, it, vi } from 'vitest'
import { modelCapacityReason } from './modelCapacityRetry'
import { DEFAULT_PROVIDER_JSON_MAX_BYTES, ProviderJsonBudgetError, isTrustedProviderJsonBudgetError, providerJsonUtf8Bytes, serializeProviderJsonWithBudget } from './providerJsonBudget'

describe('provider JSON budget', () => {
  it.each(['ascii', '中文', '😀', '\ud800', '\udc00', '"\\\n\u0000'])('counts UTF-8 exactly for %j', value => {
    const json = JSON.stringify({ value })
    const size = new TextEncoder().encode(json).length
    expect(providerJsonUtf8Bytes(json)).toBe(size)
    expect(serializeProviderJsonWithBudget({ value }, size)).toBe(json)
    expect(() => serializeProviderJsonWithBudget({ value }, size - 1)).toThrow(ProviderJsonBudgetError)
  })

  it('works without Buffer and TextEncoder and serializes once', () => {
    const toJSON = vi.fn(() => ({ text: '中文😀' }))
    vi.stubGlobal('Buffer', undefined)
    vi.stubGlobal('TextEncoder', undefined)
    try {
      expect(serializeProviderJsonWithBudget({ toJSON })).toBe('{"text":"中文😀"}')
      expect(toJSON).toHaveBeenCalledOnce()
      expect(providerJsonUtf8Bytes('\ud800')).toBe(3)
    } finally { vi.unstubAllGlobals() }
  })

  it('permits only nonnegative safe integer limits that do not loosen the default', () => {
    expect(DEFAULT_PROVIDER_JSON_MAX_BYTES).toBe(28 * 1024 * 1024)
    expect(() => serializeProviderJsonWithBudget({}, 0)).toThrow(ProviderJsonBudgetError)
    for (const limit of [-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER, DEFAULT_PROVIDER_JSON_MAX_BYTES + 1]) {
      expect(() => serializeProviderJsonWithBudget({}, limit)).toThrow('Invalid provider JSON size limit.')
    }
    expect(serializeProviderJsonWithBudget({}, 2)).toBe('{}')
  })

  it('does not expose serialization exceptions', () => {
    const value = { toJSON() { throw new Error('secret-url') } }
    try { serializeProviderJsonWithBudget(value); throw new Error('expected rejection') }
    catch (error) {
      expect((error as Error).message).toBe('Unable to serialize provider JSON request.')
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
    }
  })

  it.each([429, 503])('does not retry a budget error even with status %s', status => {
    const error = Object.assign(new ProviderJsonBudgetError(), { status })
    expect(error.retryBlocked).toBe(true)
    expect(error.code).toBe('PROVIDER_JSON_BUDGET_EXCEEDED')
    expect(error.message).toBe('Provider request exceeds the size limit. Remove some attachments or send fewer images per message.')
    expect(modelCapacityReason(error)).toBeUndefined()
  })

  it('trusts only helper-created oversize identity without inspecting properties or proxies', () => {
    let genuine: unknown
    try { serializeProviderJsonWithBudget({}, 0) } catch (error) { genuine = error }
    expect(isTrustedProviderJsonBudgetError(genuine)).toBe(true)
    expect(isTrustedProviderJsonBudgetError(new ProviderJsonBudgetError())).toBe(false)
    expect(isTrustedProviderJsonBudgetError(Object.setPrototypeOf({}, ProviderJsonBudgetError.prototype))).toBe(false)
    const getter = vi.fn(() => { throw new Error('must not inspect') })
    const fake = Object.defineProperty({}, 'code', { get: getter })
    expect(isTrustedProviderJsonBudgetError(fake)).toBe(false)
    const trap = vi.fn(() => { throw new Error('must not inspect proxy') })
    const proxy = new Proxy(genuine as object, { get: trap, getPrototypeOf: trap })
    expect(isTrustedProviderJsonBudgetError(proxy)).toBe(false)
    const revocable = Proxy.revocable({}, {})
    revocable.revoke()
    expect(isTrustedProviderJsonBudgetError(revocable.proxy)).toBe(false)
    for (const value of [null, undefined, 1, 'error', Symbol('error')]) expect(isTrustedProviderJsonBudgetError(value)).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    expect(trap).not.toHaveBeenCalled()
  })

  it('oversize errors expose no body, URL or cause', () => {
    const secret = 'https://secret.invalid/private'
    let result: unknown
    try { serializeProviderJsonWithBudget({ secret }, 1) } catch (error) { result = error }
    expect(result).toBeInstanceOf(ProviderJsonBudgetError)
    expect((result as ProviderJsonBudgetError).code).toBe('PROVIDER_JSON_BUDGET_EXCEEDED')
    expect(String((result as Error).stack)).not.toContain(secret)
    expect((result as Error & { cause?: unknown }).cause).toBeUndefined()
  })
})
