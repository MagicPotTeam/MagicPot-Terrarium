// Offline model only. A 'trusted-tree-empty' event is an ASSUMPTION by the
// caller, not proof of process identity, authentication, or OS-level quarantine.
// This module does not own or close processes, sockets, endpoints, or files.

const same = (state, event) => event.runId === state.runId
const sameEndpoint = (state, event) => same(state, event) && event.endpointId === state.endpointId

export function createQuarantineState({ runId, endpointId }) {
  if (typeof runId !== 'string' || !runId || typeof endpointId !== 'string' || !endpointId) {
    throw TypeError('Synthetic run and endpoint identities required')
  }
  return Object.freeze({ runId, endpointId, phase: 'unknown' })
}

export function canCloseSyntheticEndpoint(state) {
  return state.phase === 'ready'
}

export function reduceQuarantineState(state, event) {
  if (!event || typeof event !== 'object' || !same(state, event)) return state
  if (['unknown', 'ready'].includes(state.phase) && ['launch-failed', 'launch-timeout', 'cancelled', 'owner-lost', 'mock-active', 'mock-incomplete'].includes(event.type)) {
    return Object.freeze({ ...state, phase: 'indeterminate' })
  }
  if (state.phase === 'ready' && ['launch-started', 'launch-succeeded'].includes(event.type)) {
    return Object.freeze({ ...state, phase: 'indeterminate' })
  }
  if (event.type === 'close-start' && state.phase === 'ready' && !sameEndpoint(state, event)) {
    return Object.freeze({ ...state, phase: 'indeterminate' })
  }
  if (event.type === 'trusted-tree-empty' && state.phase === 'unknown') {
    return Object.freeze({ ...state, phase: 'ready' })
  }
  if (event.type === 'close-start' && sameEndpoint(state, event) && state.phase === 'ready') {
    return Object.freeze({ ...state, phase: 'closing' })
  }
  if (sameEndpoint(state, event) && state.phase === 'closing') {
    if (event.type === 'close-succeeded') return Object.freeze({ ...state, phase: 'closed' })
    if (event.type === 'close-failed' || event.type === 'close-timeout') return Object.freeze({ ...state, phase: 'close-unknown' })
  }
  return state
}
