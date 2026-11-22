export type ConfigObservationSnapshot = Readonly<{ ready: boolean; generation: number }>
/** Display-freshness observation only, not configuration values or MAIN authorization. */
export type ConfigObservationSource = Readonly<{
  getSnapshot(): ConfigObservationSnapshot
  subscribe(listener: () => void): () => void
}>
export type ConfigObservationController = Readonly<{
  source: ConfigObservationSource
  advance(ready: boolean): ConfigObservationSnapshot
}>
const missingSnapshot: ConfigObservationSnapshot = Object.freeze({ ready: false, generation: 0 })
export const unavailableConfigObservation: ConfigObservationSource = Object.freeze({ getSnapshot: () => missingSnapshot, subscribe: () => () => {} })
/** Pure provider-owned memory. Advancing never reads config, starts a watch, or grants a read. */
export function createConfigObservationController(): ConfigObservationController {
  let snapshot: ConfigObservationSnapshot = Object.freeze({ ready: false, generation: 0 })
  const listeners = new Set<{ notify: () => void }>()
  const source: ConfigObservationSource = Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: (notify: () => void) => {
      const slot = { notify }; listeners.add(slot)
      return () => { listeners.delete(slot) }
    }
  })
  return Object.freeze({
    source,
    advance: (ready: boolean): ConfigObservationSnapshot => {
      const published: ConfigObservationSnapshot = Object.freeze({ ready, generation: snapshot.generation + 1 })
      snapshot = published // Publish BEFORE notifying, including batched/same-reference updates.
      for (const slot of [...listeners]) {
        if (!listeners.has(slot)) continue
        try { slot.notify() } catch { /* One display observer cannot block the provider or another observer. */ }
      }
      return published // A nested notification may already have replaced the current snapshot.
    }
  })
}
