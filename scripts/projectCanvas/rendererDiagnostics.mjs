const DEFAULT_EVENT_LIMIT = 128
const DEFAULT_TEXT_LIMIT = 4096

// Keep the first failure even when a later cascade fills the tail. This collector
// records evidence only; it must never change renderer readiness or acceptance.
export function createRendererDiagnosticCollector({
  eventLimit = DEFAULT_EVENT_LIMIT,
  textLimit = DEFAULT_TEXT_LIMIT,
  now = () => new Date().toISOString()
} = {}) {
  const capacity = Number.isFinite(eventLimit)
    ? Math.max(2, Math.floor(eventLimit))
    : DEFAULT_EVENT_LIMIT
  const maxText = Number.isFinite(textLimit)
    ? Math.max(1, Math.floor(textLimit))
    : DEFAULT_TEXT_LIMIT
  const headLimit = Math.ceil(capacity / 2)
  const tailLimit = capacity - headLimit
  const firstEvents = []
  const latestEvents = []
  let firstFailureEvent = null
  let totalEventCount = 0

  return {
    record({ type, text, location } = {}) {
      if (type !== 'warning' && type !== 'error' && type !== 'pageerror') return
      const event = {
        sequence: ++totalEventCount,
        capturedAt: now(),
        type,
        text: String(text ?? '').slice(0, maxText),
        ...(location
          ? {
              location: {
                url: String(location.url ?? '').slice(0, maxText),
                lineNumber: location.lineNumber ?? null,
                columnNumber: location.columnNumber ?? null
              }
            }
          : {})
      }
      if ((type === 'error' || type === 'pageerror') && !firstFailureEvent) {
        firstFailureEvent = event
      }
      if (firstEvents.length < headLimit) {
        firstEvents.push(event)
      } else {
        latestEvents.push(event)
        if (latestEvents.length > tailLimit) latestEvents.shift()
      }
    },
    getReport() {
      const retainedEvents = [...firstEvents, ...latestEvents]
      const hasRetainedFirstFailure = retainedEvents.some(
        (event) => event.sequence === firstFailureEvent?.sequence
      )
      if (firstFailureEvent && !hasRetainedFirstFailure) {
        // Keep the first renderer failure even if a later cascade displaced it
        // from the bounded tail. Drop the oldest tail event so the newest tail
        // remains useful for understanding the state after the failure.
        if (latestEvents.length > 0) {
          const displaced = latestEvents[0]
          const displacedIndex = retainedEvents.findIndex(
            (event) => event.sequence === displaced.sequence
          )
          if (displacedIndex >= 0) retainedEvents.splice(displacedIndex, 1)
        } else {
          retainedEvents.pop()
        }
        retainedEvents.push(firstFailureEvent)
        retainedEvents.sort((left, right) => left.sequence - right.sequence)
      }
      const events = retainedEvents.map((event) => ({
        ...event,
        ...(event.location ? { location: { ...event.location } } : {})
      }))
      return {
        totalEventCount,
        droppedEventCount: totalEventCount - events.length,
        eventLimit: capacity,
        textLimit: maxText,
        events
      }
    }
  }
}
