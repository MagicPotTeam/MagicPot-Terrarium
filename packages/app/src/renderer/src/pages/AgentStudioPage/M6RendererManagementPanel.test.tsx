import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { M6RendererManagementPanel } from './M6RendererManagementPanel'

const service = vi.hoisted(() => ({
  listAgentInstances: vi.fn(),
  listTeams: vi.fn(),
  createRootAgentInstance: vi.fn(),
  startAgentInstance: vi.fn(),
  replaceAgentInstance: vi.fn(),
  removeAgentInstance: vi.fn(),
  createTeam: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  removeTeam: vi.fn(),
  createAgentConfigVersion: vi.fn(),
  stageAgentConfig: vi.fn(),
  activateAgentConfig: vi.fn(),
  rollbackAgentConfig: vi.fn()
}))
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcMagicAgentPlatform: service }) }))

const agent = {
  id: 'agent',
  revision: 3,
  state: {
    id: 'agent',
    name: 'Agent',
    definitionId: 'definition',
    depth: 0,
    configVersion: 'v1',
    status: 'created',
    limits: {
      maxChildren: 0,
      maxDepth: 0,
      maxConcurrency: 1,
      maxRuntimeMs: 100,
      allowedToolNames: [],
      workspaceRoots: []
    }
  },
  createdAt: 1,
  updatedAt: 1
}
const team = {
  id: 'team',
  revision: 4,
  state: { id: 'team', name: 'Team', status: 'created', members: [] },
  createdAt: 1,
  updatedAt: 1
}

describe('M6RendererManagementPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    service.listAgentInstances.mockResolvedValue({ instances: [agent] })
    service.listTeams.mockResolvedValue([team])
    Object.values(service).forEach((mock) => {
      if (mock !== service.listAgentInstances && mock !== service.listTeams)
        mock.mockResolvedValue({})
    })
  })

  it('routes root create, start, replace, and remove with revisions and idempotency', async () => {
    render(<M6RendererManagementPanel />)
    await screen.findByText('Agent · r3')
    fireEvent.click(screen.getByRole('button', { name: 'Create root Agent' }))
    await waitFor(() =>
      expect(service.createRootAgentInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          instance: expect.objectContaining({
            id: 'agent-new',
            definitionId: 'definition',
            status: 'created',
            depth: 0
          }),
          createdAt: expect.any(Number),
          idempotencyKey: 'studio-agent-create:agent-new'
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start Agent' }))
    await waitFor(() =>
      expect(service.startAgentInstance).toHaveBeenCalledWith({
        instanceId: 'agent',
        expectedRevision: 3,
        request: {
          text: 'Start agent',
          route: { channel: 'agent-studio', scopeType: 'dm', scopeId: 'agent' }
        },
        idempotencyKey: 'studio-agent-start:agent:3'
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Replace Agent' }))
    await waitFor(() =>
      expect(service.replaceAgentInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'agent',
          expectedRevision: 3,
          idempotencyKey: 'studio-agent-replace:agent:3'
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Agent' }))
    await waitFor(() =>
      expect(service.removeAgentInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'agent',
          expectedRevision: 3,
          idempotencyKey: 'studio-agent-remove:agent:3'
        })
      )
    )
  }, 15_000)

  it('routes Team create, member add/remove, and empty remove with revisions', async () => {
    render(<M6RendererManagementPanel />)
    await screen.findByText('Team · r4')
    fireEvent.click(screen.getByRole('button', { name: 'Create Team' }))
    await waitFor(() =>
      expect(service.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          team: expect.objectContaining({ id: 'team-new', name: 'New Team' }),
          idempotencyKey: 'studio-team-create:team-new'
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add Team member' }))
    await waitFor(() =>
      expect(service.addTeamMember).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'team',
          expectedRevision: 4,
          member: expect.objectContaining({
            memberId: 'member-1',
            agentInstanceId: 'agent',
            role: 'member'
          }),
          idempotencyKey: 'studio-team-member-add:team:4'
        })
      )
    )
    fireEvent.change(screen.getByLabelText('Remove member ID'), { target: { value: 'member-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Team member' }))
    await waitFor(() =>
      expect(service.removeTeamMember).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'team',
          expectedRevision: 4,
          memberId: 'member-1',
          idempotencyKey: 'studio-team-member-remove:team:4'
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove empty Team' }))
    await waitFor(() =>
      expect(service.removeTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'team',
          expectedRevision: 4,
          idempotencyKey: 'studio-team-remove:team:4'
        })
      )
    )
  })

  it('routes valid immutable config create, stage, activate, and rollback DTOs', async () => {
    render(<M6RendererManagementPanel />)
    await screen.findByText('Agent · r3')
    fireEvent.click(screen.getByRole('button', { name: 'Create config version' }))
    await waitFor(() =>
      expect(service.createAgentConfigVersion).toHaveBeenCalledWith({
        config: {
          version: 'v2',
          definitionId: 'definition',
          model: { profileId: 'model' },
          systemPrompt: 'safe',
          inference: {},
          tools: { allowedToolNames: [] },
          memory: { allowHistory: false, contextMessageLimit: 1, scope: 'session' },
          policy: { policyIds: [], workspaceRoots: [] },
          channels: { channelIds: [] },
          budgets: { maxRuntimeMs: 100 },
          createdAt: expect.any(Number)
        },
        idempotencyKey: 'studio-config-create:definition:v2'
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stage config' }))
    await waitFor(() =>
      expect(service.stageAgentConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'agent',
          expectedRevision: 3,
          configVersion: 'v2',
          idempotencyKey: 'studio-config-stage:agent:3'
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Activate config' }))
    await waitFor(() =>
      expect(service.activateAgentConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'agent',
          expectedRevision: 3,
          idempotencyKey: 'studio-config-activate:agent:3'
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rollback config' }))
    await waitFor(() =>
      expect(service.rollbackAgentConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'agent',
          expectedRevision: 3,
          idempotencyKey: 'studio-config-rollback:agent:3'
        })
      )
    )
  })
})
