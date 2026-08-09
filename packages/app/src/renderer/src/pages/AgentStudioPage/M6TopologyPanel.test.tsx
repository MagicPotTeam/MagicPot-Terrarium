import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { M6TopologyPanel } from './M6TopologyPanel'

const listAgentInstances = vi.fn()
const listTeams = vi.fn()
const listRuntimeChannels = vi.fn()
const listRuntimeChannelWires = vi.fn()
const pauseAgentInstance = vi.fn()
const resumeAgentInstance = vi.fn()
const stopAgentInstance = vi.fn()
const startTeam = vi.fn()
const pauseTeam = vi.fn()
const resumeTeam = vi.fn()
const stopTeam = vi.fn()
const createRuntimeChannel = vi.fn()
const unwireRuntimeChannel = vi.fn()
const publishRuntimeChannelMessage = vi.fn()
const leaveRuntimeChannel = vi.fn()
const joinRuntimeChannel = vi.fn()
const wireRuntimeChannel = vi.fn()
const claimRuntimeChannelMessage = vi.fn()
const acknowledgeRuntimeChannelMessage = vi.fn()
const replaceTeam = vi.fn()
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcMagicAgentPlatform: {
      listAgentInstances,
      listTeams,
      listRuntimeChannels,
      listRuntimeChannelWires,
      pauseAgentInstance,
      resumeAgentInstance,
      stopAgentInstance,
      startTeam,
      pauseTeam,
      resumeTeam,
      stopTeam,
      createRuntimeChannel,
      unwireRuntimeChannel,
      publishRuntimeChannelMessage,
      leaveRuntimeChannel,
      joinRuntimeChannel,
      wireRuntimeChannel,
      claimRuntimeChannelMessage,
      acknowledgeRuntimeChannelMessage,
      replaceTeam
    }
  })
}))

describe('M6TopologyPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listAgentInstances.mockResolvedValue({
      instances: [{ id: 'agent', revision: 3, state: { name: 'Agent', status: 'running' } }]
    })
    listTeams.mockResolvedValue([
      {
        id: 'team',
        revision: 4,
        state: { name: 'Team', status: 'active', members: [{ memberId: 'm' }] }
      }
    ])
    listRuntimeChannels.mockResolvedValue({
      channels: [
        {
          id: 'channel',
          revision: 2,
          state: {
            name: 'Channel',
            mode: 'queue',
            members: [{ memberId: 'publisher', role: 'producer', agentInstanceId: 'agent' }]
          }
        },
        { id: 'channel-2', revision: 1, state: { name: 'Target', mode: 'broadcast', members: [] } }
      ]
    })
    listRuntimeChannelWires.mockResolvedValue({
      wires: [{ id: 'wire', state: { sourceChannelId: 'a', targetChannelId: 'b' } }]
    })
    pauseAgentInstance.mockResolvedValue({})
    resumeAgentInstance.mockResolvedValue({})
    stopAgentInstance.mockResolvedValue({})
    startTeam.mockResolvedValue({
      action: 'start',
      status: 'partial',
      outcomes: [
        { memberId: 'm', agentInstanceId: 'agent', status: 'completed' },
        { memberId: 'n', agentInstanceId: 'agent-2', status: 'failed', error: 'denied' }
      ]
    })
    pauseTeam.mockResolvedValue({ status: 'completed' })
    resumeTeam.mockResolvedValue({ status: 'completed' })
    stopTeam.mockResolvedValue({ status: 'completed' })
    createRuntimeChannel.mockResolvedValue({})
    unwireRuntimeChannel.mockResolvedValue({})
    publishRuntimeChannelMessage.mockResolvedValue({})
    leaveRuntimeChannel.mockResolvedValue({})
    joinRuntimeChannel.mockResolvedValue({})
    wireRuntimeChannel.mockResolvedValue({})
    claimRuntimeChannelMessage.mockResolvedValue({ revision: 6, claimToken: 'server-token' })
    acknowledgeRuntimeChannelMessage.mockResolvedValue({})
    replaceTeam.mockResolvedValue({ action: 'replace', status: 'completed', outcomes: [] })
  })

  it('renders production topology counts and summaries', async () => {
    render(<M6TopologyPanel />)
    expect(screen.getByLabelText('Loading M6 topology')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Agents 1')).toBeInTheDocument())
    expect(screen.getByText('Teams 1')).toBeInTheDocument()
    expect(screen.getByText('Channels 2')).toBeInTheDocument()
    expect(screen.getByText('Wires 1')).toBeInTheDocument()
    expect(screen.getByText(/Team Team · active/)).toBeInTheDocument()
    expect(screen.getByText('Wire a → b')).toBeInTheDocument()
  })

  it('submits structured replacements for every Team member', async () => {
    render(<M6TopologyPanel />)
    await waitFor(() => expect(screen.getByLabelText('Replace Team')).toBeInTheDocument())
    fireEvent.mouseDown(screen.getByLabelText('Replace Team'))
    fireEvent.click(screen.getAllByText('Team').at(-1)!)
    fireEvent.change(screen.getByLabelText('definitionId'), { target: { value: 'definition-new' } })
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'Replacement' } })
    fireEvent.change(screen.getByLabelText('configVersion'), { target: { value: 'v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replace Team' }))
    await waitFor(() =>
      expect(replaceTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'team',
          expectedRevision: 4,
          replacements: [
            expect.objectContaining({
              memberId: 'm',
              definitionId: 'definition-new',
              name: 'Replacement',
              configVersion: 'v2'
            })
          ]
        })
      )
    )
  })

  it('claims and acknowledges a message with the server claim token', async () => {
    render(<M6TopologyPanel />)
    await waitFor(() => expect(screen.getByLabelText('Message ID')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Message ID'), { target: { value: 'message' } })
    fireEvent.change(screen.getByLabelText('Message revision'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Consumer member'), { target: { value: 'consumer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Claim' }))
    await waitFor(() =>
      expect(claimRuntimeChannelMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'message',
          expectedRevision: 5,
          consumerMemberId: 'consumer',
          leaseMs: 30000
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() =>
      expect(acknowledgeRuntimeChannelMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'message',
          expectedRevision: 6,
          consumerMemberId: 'consumer',
          token: 'server-token'
        })
      )
    )
  })

  it('joins an Agent and creates a Wire through production services', async () => {
    render(<M6TopologyPanel />)
    await waitFor(() => expect(screen.getByLabelText('Join channel')).toBeInTheDocument())
    fireEvent.mouseDown(screen.getByLabelText('Join channel'))
    fireEvent.click(screen.getAllByText('Channel').at(-1)!)
    fireEvent.mouseDown(screen.getByLabelText('Join Agent'))
    fireEvent.click(screen.getAllByText('Agent').at(-1)!)
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    await waitFor(() =>
      expect(joinRuntimeChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: 'channel',
          expectedRevision: 2,
          member: expect.objectContaining({ agentInstanceId: 'agent', role: 'consumer' })
        })
      )
    )
    fireEvent.mouseDown(screen.getByLabelText('Wire source'))
    fireEvent.click(screen.getAllByText('Channel').at(-1)!)
    fireEvent.mouseDown(screen.getByLabelText('Wire target'))
    fireEvent.click(screen.getAllByText('Target').at(-1)!)
    fireEvent.change(screen.getByLabelText('Target publisher member'), {
      target: { value: 'publisher' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Wire' }))
    await waitFor(() =>
      expect(wireRuntimeChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          wire: expect.objectContaining({
            sourceChannelId: 'channel',
            targetChannelId: 'channel-2',
            targetPublisherMemberId: 'publisher',
            enabled: true
          })
        })
      )
    )
  })

  it('publishes and leaves Channel membership through production services', async () => {
    render(<M6TopologyPanel />)
    await waitFor(() => expect(screen.getByLabelText('Publish channel')).toBeInTheDocument())
    fireEvent.mouseDown(screen.getByLabelText('Publish channel'))
    fireEvent.click(screen.getByText('Channel'))
    fireEvent.mouseDown(screen.getByLabelText('Publisher member'))
    fireEvent.click(screen.getByText('publisher'))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() =>
      expect(publishRuntimeChannelMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            channelId: 'channel',
            publisherMemberId: 'publisher',
            payload: { text: 'hello' }
          })
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    await waitFor(() =>
      expect(leaveRuntimeChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: 'channel',
          expectedRevision: 2,
          memberId: 'publisher'
        })
      )
    )
  })

  it('creates Channels and removes Wires through production services', async () => {
    render(<M6TopologyPanel />)
    await waitFor(() => expect(screen.getByLabelText('Channel name')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Channel name'), { target: { value: 'Work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Channel' }))
    await waitFor(() =>
      expect(createRuntimeChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: expect.objectContaining({ name: 'Work', mode: 'queue', capacity: 100 })
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Unwire' }))
    await waitFor(() =>
      expect(unwireRuntimeChannel).toHaveBeenCalledWith(expect.objectContaining({ wireId: 'wire' }))
    )
  })

  it('routes Team lifecycle controls through the production service', async () => {
    render(<M6TopologyPanel />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start Team' })).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start Team' }))
    await waitFor(() =>
      expect(startTeam).toHaveBeenCalledWith({
        teamId: 'team',
        expectedRevision: 4,
        idempotencyKey: 'studio-team-start:team:4',
        request: {
          text: 'Start Team Team',
          route: { channel: 'agent-studio', scopeType: 'team', scopeId: 'team' }
        }
      })
    )
    expect(
      await screen.findByText('Team start: partial · 1/2 members completed')
    ).toBeInTheDocument()
    expect(screen.getByText('agent-2: denied')).toBeInTheDocument()
  })

  it('routes lifecycle controls through the production service and refreshes', async () => {
    render(<M6TopologyPanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() =>
      expect(pauseAgentInstance).toHaveBeenCalledWith({
        instanceId: 'agent',
        expectedRevision: 3,
        idempotencyKey: 'studio-pause:agent:3'
      })
    )
    expect(listAgentInstances).toHaveBeenCalledTimes(2)
  })

  it('shows errors and refreshes all resources', async () => {
    listTeams.mockRejectedValueOnce(new Error('team load failed'))
    render(<M6TopologyPanel />)
    await waitFor(() => expect(screen.getByText('team load failed')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(listAgentInstances).toHaveBeenCalledTimes(2))
  })
})
