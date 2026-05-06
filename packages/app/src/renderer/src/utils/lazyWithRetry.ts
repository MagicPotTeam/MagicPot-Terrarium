import { lazy, type ComponentType } from 'react'

type LazyModule<T extends ComponentType<any>> = Promise<{ default: T }>

const RETRYABLE_LAZY_IMPORT_ERROR_PATTERNS = [
  'failed to fetch dynamically imported module',
  'importing a module script failed',
  'error loading dynamically imported module'
]

const wait = (delayMs: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs)
  })

const shouldRetryLazyImport = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false
  }

  const normalizedMessage = error.message.toLowerCase()
  return RETRYABLE_LAZY_IMPORT_ERROR_PATTERNS.some((pattern) => normalizedMessage.includes(pattern))
}

export function lazyWithRetry<T extends ComponentType<any>>(
  importer: () => LazyModule<T>,
  retryCount: number = 4,
  retryDelayMs: number = 250
) {
  return lazy(async () => {
    let lastError: unknown

    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        return await importer()
      } catch (error) {
        lastError = error
        const canRetry = attempt < retryCount && shouldRetryLazyImport(error)
        if (!canRetry) {
          throw error
        }

        const nextDelayMs = retryDelayMs * 2 ** attempt

        console.warn('[lazyWithRetry] Retrying lazy import after transient failure', {
          attempt: attempt + 1,
          retryCount,
          nextDelayMs,
          message: error instanceof Error ? error.message : String(error)
        })
        await wait(nextDelayMs)
      }
    }

    throw lastError
  })
}
