import type { TeamDispatchEntry } from './teamMessageDispatcher'

export type TeamActivityState = Readonly<{
  owner: number
  key: string
  entries: readonly TeamDispatchEntry[]
  activeKey: string
  live: boolean
  closedFor: string | null
}>

type TeamActivityAction =
  | Readonly<{ type: 'begin'; owner: number; key: string }>
  | Readonly<{ type: 'observe'; owner: number; key: string; entries: readonly TeamDispatchEntry[] }>
  | Readonly<{ type: 'end'; owner: number; key: string }>
  | Readonly<{ type: 'close'; owner: number; key: string }>

const unknownIfUnfinished = (entry: TeamDispatchEntry): TeamDispatchEntry =>
  entry.status === 'queued' || entry.status === 'request_started' ? { ...entry, status: 'unknown' } : entry

const entryKey = (entry: TeamDispatchEntry): string => JSON.stringify([entry.intent.id, entry.recipient ?? null])

const observeAfterClose = (previous: readonly TeamDispatchEntry[], incoming: readonly TeamDispatchEntry[]): readonly TeamDispatchEntry[] => {
  const unknown = new Set(previous.filter(entry => entry.status === 'unknown').map(entryKey))
  return incoming.map(entry => {
    if (entry.status === 'unavailable' && unknown.has(entryKey(entry))) return { ...entry, status: 'unknown' }
    return unknownIfUnfinished(entry)
  })
}

export function reduceTeamActivity(state: TeamActivityState, action: TeamActivityAction): TeamActivityState {
  if (action.type === 'begin') {
    return action.owner > state.owner ? { ...state, owner: action.owner, activeKey: action.key, live: true, closedFor: null } : state
  }
  if (state.owner !== action.owner || state.activeKey !== action.key || !state.live) return state
  if (action.type === 'close') return { ...state, closedFor: action.key, entries: state.key === action.key ? state.entries.map(unknownIfUnfinished) : state.entries }
  if (action.type === 'observe') return { ...state, key: action.key, entries: state.closedFor === action.key ? observeAfterClose(state.key === action.key ? state.entries : [], action.entries) : action.entries }
  const entries = state.key === action.key ? state.entries.map(unknownIfUnfinished) : state.entries
  return { ...state, live: false, entries }
}

export function selectTeamActivity(state: TeamActivityState, key: string, hostGateClosed = false): readonly TeamDispatchEntry[] {
  if (state.key !== key) return []
  return hostGateClosed || state.closedFor === key ? state.entries.map(unknownIfUnfinished) : state.entries
}
