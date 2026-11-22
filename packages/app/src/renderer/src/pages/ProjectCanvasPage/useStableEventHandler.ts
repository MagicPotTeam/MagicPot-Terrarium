import { useCallback, useInsertionEffect, useRef } from 'react'

/**
 * Returns a function whose identity never changes and that always calls the handler of the latest
 * committed render.
 *
 * Memoised canvas children (hit proxies, the multi-selection overlay) skip renders on purpose, so
 * a callback passed to them can outlive the render that created it. A handler that closes over
 * React state (the selection, the tool) must therefore reach them through this wrapper, never
 * directly: then a skipped render cannot leave a child acting on an old selection or tool.
 *
 * Call the returned function from event handlers and effects only, not during render.
 */
export function useStableEventHandler<Args extends unknown[], Result>(
  handler: ((...args: Args) => Result) | null | undefined
): (...args: Args) => Result | undefined {
  const handlerRef = useRef(handler)

  // Insertion effects run before any layout effect of the commit, so even a child's layout
  // effect sees the handler of the render being committed.
  useInsertionEffect(() => {
    handlerRef.current = handler
  })

  return useCallback((...args: Args) => handlerRef.current?.(...args), [])
}

const DEFAULT_STABLE_CALLBACK_KEY_PATTERN = /^(on|handle)[A-Z]/

export function isDefaultStableCallbackKey(key: string): boolean {
  return DEFAULT_STABLE_CALLBACK_KEY_PATTERN.test(key)
}

function areShallowEqualProps(
  previous: Record<string, unknown>,
  next: Record<string, unknown>
): boolean {
  const previousKeys = Object.keys(previous)
  if (previousKeys.length !== Object.keys(next).length) {
    return false
  }
  for (const key of previousKeys) {
    if (!Object.prototype.hasOwnProperty.call(next, key) || !Object.is(previous[key], next[key])) {
      return false
    }
  }
  return true
}

/**
 * Returns a props bag for a memoised child whose identity only changes when a value the child
 * renders changes.
 *
 * Every function under a callback key (on* / handle* by default, or the keys `isCallbackKey`
 * accepts) is replaced by a stable forwarder that calls the function of the latest committed render,
 * so an inline arrow or a callback that closes over fresh state no longer breaks the child's memo,
 * and the child can never call an old one. A key whose value is not a function (for example
 * undefined) is passed through as it is, so a child that checks whether a callback exists still
 * re-renders when that changes. All other values are compared with Object.is.
 *
 * Only use it for callbacks the child calls from event handlers or effects, never during render:
 * a forwarder called during render would see the previous commit's function.
 */
export function useStableCallbackProps<T extends object>(
  props: T,
  isCallbackKey: (key: string) => boolean = isDefaultStableCallbackKey
): T {
  const latestPropsRef = useRef(props)
  const forwardersRef = useRef(new Map<string, (...args: unknown[]) => unknown>())
  const previousBagRef = useRef<Record<string, unknown> | null>(null)

  useInsertionEffect(() => {
    latestPropsRef.current = props
  })

  const source = props as Record<string, unknown>
  const nextBag: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (typeof value !== 'function' || !isCallbackKey(key)) {
      nextBag[key] = value
      continue
    }

    let forwarder = forwardersRef.current.get(key)
    if (!forwarder) {
      forwarder = (...args: unknown[]) => {
        const latest = (latestPropsRef.current as Record<string, unknown>)[key]
        return typeof latest === 'function' ? latest(...args) : undefined
      }
      forwardersRef.current.set(key, forwarder)
    }
    nextBag[key] = forwarder
  }

  const previousBag = previousBagRef.current
  if (previousBag && areShallowEqualProps(previousBag, nextBag)) {
    return previousBag as T
  }
  previousBagRef.current = nextBag
  return nextBag as T
}
