const PERFORMANCE_MEASURE_GUARD_FLAG = '__magicpotPerformanceMeasureGuardInstalled__'

type GlobalWithPerformanceGuard = typeof globalThis & {
  [PERFORMANCE_MEASURE_GUARD_FLAG]?: boolean
}

const isPerformanceMeasureOptions = (
  value: string | PerformanceMeasureOptions | undefined
): value is PerformanceMeasureOptions => typeof value === 'object' && value !== null

const isCloneFailure = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.name === 'DataCloneError' ||
    error.message.includes('Data cannot be cloned') ||
    error.message.includes('out of memory')
  )
}

const stripMeasureDetail = (
  options: PerformanceMeasureOptions
): PerformanceMeasureOptions | null => {
  if (!('detail' in options)) {
    return null
  }

  const { detail: _detail, ...safeOptions } = options
  return safeOptions
}

const replacePerformanceMeasure = (
  performanceObject: Performance,
  measure: typeof performance.measure
): boolean => {
  try {
    Object.defineProperty(performanceObject, 'measure', {
      configurable: true,
      value: measure
    })
    return true
  } catch {
    const prototype = Object.getPrototypeOf(performanceObject)
    if (!prototype) {
      return false
    }

    try {
      Object.defineProperty(prototype, 'measure', {
        configurable: true,
        writable: true,
        value: measure
      })
      return true
    } catch {
      return false
    }
  }
}

export function installPerformanceMeasureGuard(): void {
  if (!import.meta.env.DEV) {
    return
  }

  const globalObject = globalThis as GlobalWithPerformanceGuard
  if (globalObject[PERFORMANCE_MEASURE_GUARD_FLAG]) {
    return
  }

  const performanceObject = globalObject.performance
  if (!performanceObject || typeof performanceObject.measure !== 'function') {
    return
  }

  const originalMeasure = performanceObject.measure.bind(performanceObject)

  const guardedMeasure = ((
    name: string,
    startOrMeasureOptions?: string | PerformanceMeasureOptions,
    endMark?: string
  ) => {
    const sanitizedStartOrMeasureOptions = isPerformanceMeasureOptions(startOrMeasureOptions)
      ? (stripMeasureDetail(startOrMeasureOptions) ?? startOrMeasureOptions)
      : startOrMeasureOptions

    try {
      return (originalMeasure as (...args: unknown[]) => unknown)(
        name,
        sanitizedStartOrMeasureOptions,
        endMark
      )
    } catch (error) {
      if (!isCloneFailure(error) || sanitizedStartOrMeasureOptions === startOrMeasureOptions) {
        throw error
      }

      return undefined
    }
  }) as typeof performance.measure

  if (!replacePerformanceMeasure(performanceObject, guardedMeasure)) {
    return
  }

  globalObject[PERFORMANCE_MEASURE_GUARD_FLAG] = true
}
