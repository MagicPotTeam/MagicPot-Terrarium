import { describe, expect, it, vi } from 'vitest'
import { retryModelCapacity } from './modelCapacityRetry'
import { isTrustedProviderJsonBudgetError, serializeProviderJsonWithBudget } from './providerJsonBudget'

describe('provider budget and model capacity retry', () => {
  it.each([503, 429])('does not retry a real budget error with status %i', async (status) => {
    let thrown: unknown
    const onDelta = vi.fn()
    const operation = vi.fn(async () => {
      try {
        serializeProviderJsonWithBudget({}, 0)
      } catch (error) {
        thrown = error
        Object.assign(error as object, { status })
        throw error
      }
    })
    let caught: unknown
    try {
      await retryModelCapacity({ onDelta }, operation)
    } catch (error) {
      caught = error
    }
    expect(operation).toHaveBeenCalledTimes(1)
    expect(onDelta).not.toHaveBeenCalled()
    expect(caught).toBe(thrown)
    expect(isTrustedProviderJsonBudgetError(caught)).toBe(true)
  })
})
