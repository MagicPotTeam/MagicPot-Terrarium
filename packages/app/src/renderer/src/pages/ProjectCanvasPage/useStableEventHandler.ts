import { useCallback, useLayoutEffect, useRef } from 'react'

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

  useLayoutEffect(() => {
    handlerRef.current = handler
  })

  return useCallback((...args: Args) => handlerRef.current?.(...args), [])
}
