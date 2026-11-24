import { describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  get: vi.fn(),
  importLegacy: vi.fn(),
  markEnded: vi.fn(),
  end: vi.fn(() => ({ ended: true as const }))
}))
vi.mock('electron', () => ({ net: {} }))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => {
    throw new Error('Unexpected production path')
  }
}))
vi.mock('../config/config', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  onConfigCommitted: vi.fn()
}))
vi.mock('./teamEndStore', () => ({
  getTeamEndStore: () => ({ end: h.end, assertActive: vi.fn() }),
  assertTeamRequestActive: vi.fn()
}))
// The pane check itself is authorizeAgentThreadScope's (tested with it); here: that it runs, with the method name.
vi.mock('./agentThreadScope', () => ({ authorizeAgentThreadScope: h.authorize }))
vi.mock(import('./agentTeamStore'), async (original) => ({
  ...(await original()),
  getAgentTeamStore: () =>
    ({ get: h.get, importLegacy: h.importLegacy, markEnded: h.markEnded }) as never
}))
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

// Synthetic data only.
const route = {
  channel: 'canvas' as const,
  scopeType: 'thread' as const,
  scopeId: 'project-1',
  threadId: 'thread-1'
}
const team = { scope: 'canvas:synthetic', thread: 'thread-1', lead: 'lead-1' }
const invocation = { senderId: 1, methodName: 'svcLLMProxy.getAgentTeam' } as never

describe('team roster service (S6-1, data only)', () => {
  it('authorizes the pane before reading, and reads only a team of that same thread', async () => {
    const service = new LLMProxySvcImpl()
    h.get.mockReturnValue(undefined)
    expect(
      await service.getAgentTeam({ route, conversationId: 'lead-1', team }, invocation)
    ).toEqual({})
    expect(h.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ route }),
      invocation,
      'getAgentTeam'
    )
    expect(h.get).toHaveBeenCalledWith(team)
    h.get.mockClear()
    await expect(
      service.getAgentTeam(
        { route, conversationId: 'lead-1', team: { ...team, thread: 'thread-2' } },
        invocation
      )
    ).rejects.toThrow('Agent interaction access denied.')
    // Only the lead's own conversation asks for its team.
    await expect(
      service.getAgentTeam({ route, conversationId: 'member-1', team }, invocation)
    ).rejects.toThrow('Agent interaction access denied.')
    await expect(
      service.getAgentTeam(
        { route, conversationId: 'lead-1', team: { ...team, extra: 1 } as never },
        invocation
      )
    ).rejects.toThrow('Invalid team identity.')
    expect(h.get).not.toHaveBeenCalled()
  })

  it('a refused pane reads and imports nothing', async () => {
    const service = new LLMProxySvcImpl()
    h.authorize.mockImplementationOnce(() => {
      throw new Error('Agent interaction access denied.')
    })
    await expect(
      service.importAgentTeam(
        { route, conversationId: 'lead-1', team, snapshot: {} as never },
        invocation
      )
    ).rejects.toThrow('denied')
    expect(h.importLegacy).not.toHaveBeenCalled()
  })

  it('hands the snapshot to the idempotent store import with the exact team identity', async () => {
    const service = new LLMProxySvcImpl()
    const snapshot = { lead: { id: 'lead-1' }, members: [] }
    h.importLegacy.mockReturnValue({ roster: {}, revision: 0, imported: false })
    await service.importAgentTeam({ route, conversationId: 'lead-1', team, snapshot }, invocation)
    expect(h.authorize).toHaveBeenLastCalledWith(expect.anything(), invocation, 'importAgentTeam')
    expect(h.importLegacy).toHaveBeenCalledWith(team, snapshot)
  })

  it('End marks the roster after the End marker; a roster failure does not fail End', async () => {
    const service = new LLMProxySvcImpl()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await service.endTeam(team)).toEqual({ ended: true })
    expect(h.end).toHaveBeenCalledWith(team)
    expect(h.markEnded).toHaveBeenCalledWith(team)
    expect(h.end.mock.invocationCallOrder[0]).toBeLessThan(h.markEnded.mock.invocationCallOrder[0])
    // A request with more than the identity still marks exactly the identity.
    await service.endTeam({ ...team, extra: 'ignored' } as never)
    expect(h.markEnded).toHaveBeenLastCalledWith(team)
    h.markEnded.mockImplementationOnce(() => {
      throw new Error('Invalid team roster state.')
    })
    expect(await service.endTeam(team)).toEqual({ ended: true })
    warn.mockRestore()
  })
})
