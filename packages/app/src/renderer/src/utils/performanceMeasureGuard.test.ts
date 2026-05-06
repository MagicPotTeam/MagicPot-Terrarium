import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPerformanceMeasureGuard } from './performanceMeasureGuard'

const PERFORMANCE_MEASURE_GUARD_FLAG = '__magicpotPerformanceMeasureGuardInstalled__'

describe('installPerformanceMeasureGuard', () => {
  const originalPerformance = globalThis.performance

  afterEach(() => {
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: originalPerformance
    })
    delete (globalThis as typeof globalThis & Record<string, unknown>)[
      PERFORMANCE_MEASURE_GUARD_FLAG
    ]
  })

  it('strips detail before invoking performance.measure', () => {
    const measure = vi.fn()

    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: { measure }
    })

    installPerformanceMeasureGuard()

    globalThis.performance.measure('QAppInputPrompt-正面提示词', {
      start: 'render:start',
      end: 'render:end',
      detail: { huge: true }
    })

    expect(measure).toHaveBeenCalledTimes(1)
    expect(measure).toHaveBeenCalledWith(
      'QAppInputPrompt-正面提示词',
      {
        start: 'render:start',
        end: 'render:end'
      },
      undefined
    )
  })

  it('keeps measure calls without detail unchanged', () => {
    const measure = vi.fn()

    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: { measure }
    })

    installPerformanceMeasureGuard()

    globalThis.performance.measure('QApp', 'render:start', 'render:end')

    expect(measure).toHaveBeenCalledTimes(1)
    expect(measure).toHaveBeenCalledWith('QApp', 'render:start', 'render:end')
  })
})
