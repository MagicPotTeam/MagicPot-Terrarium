import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentTeamRosterFromLegacy } from '@shared/api/agentTeam'
import type { ChatSession } from './chatStorage'
import { legacyTeamSnapshot, useAgentTeamRosterImport } from './agentTeamRoster'

// Synthetic data only.
const session = (fields: Partial<ChatSession> & { id: string }): ChatSession =>
  ({ title: fields.id, messages: [], ...fields }) as ChatSession
const lead = session({ id: 'lead-1', teamGeneration: 1 })
const sessions = [
  lead,
  session({
    id: 'm-2',
    title: 'B',
    teamLeadId: 'lead-1',
    teamMemberName: 'b',
    teamMemberGeneration: 1,
    createdAt: 20
  }),
  session({
    id: 'm-1',
    title: 'A',
    teamLeadId: 'lead-1',
    teamMemberName: 'a',
    teamRole: 'writes',
    teamMemberGeneration: 1,
    memberModelChoice: { version: 1, profileId: 'p-1' },
    createdAt: 10
  }),
  session({ id: 'other', teamLeadId: 'lead-2', teamMemberName: 'x' })
]

describe('legacy team snapshot (S6-1)', () => {
  it('reads exactly the stored team fields and changes no session', () => {
    const before = structuredClone(sessions)
    expect(legacyTeamSnapshot(lead, sessions)).toEqual({
      lead: { id: 'lead-1', teamGeneration: 1 },
      members: [
        {
          id: 'm-2',
          teamLeadId: 'lead-1',
          title: 'B',
          teamMemberName: 'b',
          teamMemberGeneration: 1,
          createdAt: 20
        },
        {
          id: 'm-1',
          teamLeadId: 'lead-1',
          title: 'A',
          teamMemberName: 'a',
          teamRole: 'writes',
          teamMemberGeneration: 1,
          memberModelChoice: { version: 1, profileId: 'p-1' },
          createdAt: 10
        }
      ]
    })
    expect(sessions).toEqual(before)
    expect(legacyTeamSnapshot(session({ id: 'alone' }), sessions)).toBeUndefined()
  })
})

describe('stored team import hook (S6-1)', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  afterEach(() => {
    if (original) Object.defineProperty(window, 'api', original)
    else Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })
  const route = {
    channel: 'canvas' as const,
    scopeType: 'thread' as const,
    scopeId: 'p-1',
    threadId: 'thread-1'
  }
  const install = (importAgentTeam: ReturnType<typeof vi.fn>) =>
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { svcLLMProxy: { importAgentTeam } }
    })

  it('hands the stored team to MAIN once, with the pane scope and the exact snapshot', async () => {
    const importAgentTeam = vi.fn(async () => ({}))
    install(importAgentTeam)
    const props = { enabled: true, storageScope: 'scope-once', route, lead, sessions }
    const { rerender } = renderHook((input) => useAgentTeamRosterImport(input), {
      initialProps: props
    })
    await waitFor(() => expect(importAgentTeam).toHaveBeenCalledTimes(1))
    expect(importAgentTeam).toHaveBeenCalledWith({
      route,
      conversationId: 'lead-1',
      team: { scope: 'scope-once', thread: 'thread-1', lead: 'lead-1' },
      snapshot: legacyTeamSnapshot(lead, sessions)
    })
    rerender({ ...props, sessions: [...sessions] })
    // A second page (same team, same members) does not send it again either.
    renderHook(() => useAgentTeamRosterImport(props))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(importAgentTeam).toHaveBeenCalledTimes(1)
  })

  it('sends nothing without a stored team, for a member pane, off a thread or when disabled', async () => {
    const importAgentTeam = vi.fn(async () => ({}))
    install(importAgentTeam)
    const base = { enabled: true, storageScope: 'scope-none', route, lead, sessions }
    renderHook(() => useAgentTeamRosterImport({ ...base, sessions: [lead] }))
    renderHook(() => useAgentTeamRosterImport({ ...base, lead: sessions[1] }))
    renderHook(() =>
      useAgentTeamRosterImport({ ...base, route: { ...route, scopeType: 'project' as never } })
    )
    renderHook(() => useAgentTeamRosterImport({ ...base, enabled: false }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(importAgentTeam).not.toHaveBeenCalled()
  })

  it('a failure (or a missing service method) changes nothing and is not thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(window, 'api', { configurable: true, value: { svcLLMProxy: {} } })
    expect(() =>
      renderHook(() =>
        useAgentTeamRosterImport({
          enabled: true,
          storageScope: 'scope-fail',
          route,
          lead,
          sessions
        })
      )
    ).not.toThrow()
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(sessions[1].teamLeadId).toBe('lead-1')
  })
})
