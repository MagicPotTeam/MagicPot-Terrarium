import { Refresh } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@renderer/utils/windowUtils'

export const M6TopologyPanel = () => {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [teamOperation, setTeamOperation] = useState<any>()
  const [channelDraft, setChannelDraft] = useState({ name: '', mode: 'queue', capacity: 100 })
  const [publishDraft, setPublishDraft] = useState({ channelId: '', memberId: '', text: '' })
  const [joinDraft, setJoinDraft] = useState({
    channelId: '',
    agentInstanceId: '',
    role: 'consumer'
  })
  const [wireDraft, setWireDraft] = useState({
    sourceChannelId: '',
    targetChannelId: '',
    targetPublisherMemberId: '',
    maxHops: 8
  })
  const [deliveryDraft, setDeliveryDraft] = useState({
    messageId: '',
    revision: 0,
    consumerMemberId: '',
    token: ''
  })
  const [replaceTeamId, setReplaceTeamId] = useState('')
  const [replacementDrafts, setReplacementDrafts] = useState<any[]>([])
  const [data, setData] = useState<{ agents: any[]; teams: any[]; channels: any[]; wires: any[] }>({
    agents: [],
    teams: [],
    channels: [],
    wires: []
  })
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const svc = api().svcMagicAgentPlatform
      const [agents, teams, channels, wires] = await Promise.all([
        svc.listAgentInstances({}),
        svc.listTeams(),
        svc.listRuntimeChannels({}),
        svc.listRuntimeChannelWires({})
      ])
      setData({
        agents: (agents as { instances: any[] }).instances,
        teams: teams as any[],
        channels: (channels as { channels: any[] }).channels,
        wires: (wires as { wires: any[] }).wires
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])
  const mutateAgent = useCallback(
    async (agent: any, action: 'pause' | 'resume' | 'stop') => {
      setError(undefined)
      try {
        const svc = api().svcMagicAgentPlatform
        const request = {
          instanceId: agent.id,
          expectedRevision: agent.revision,
          idempotencyKey: `studio-${action}:${agent.id}:${agent.revision}`
        }
        if (action === 'pause') await svc.pauseAgentInstance(request)
        else if (action === 'resume') await svc.resumeAgentInstance(request)
        else await svc.stopAgentInstance(request)
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [refresh]
  )
  const replaceTeam = useCallback(async () => {
    const team = data.teams.find((item) => item.id === replaceTeamId)
    if (!team || replacementDrafts.length !== team.state.members.length) return
    setError(undefined)
    try {
      const result = await api().svcMagicAgentPlatform.replaceTeam({
        teamId: team.id,
        expectedRevision: team.revision,
        replacements: replacementDrafts.map((item) => ({ ...item, replacedAt: Date.now() })),
        idempotencyKey: `studio-team-replace:${team.id}:${team.revision}`
      })
      setTeamOperation(result)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [data.teams, replaceTeamId, replacementDrafts, refresh])
  const mutateTeam = useCallback(
    async (team: any, action: 'start' | 'pause' | 'resume' | 'stop') => {
      setError(undefined)
      try {
        const svc = api().svcMagicAgentPlatform
        const common = {
          teamId: team.id,
          expectedRevision: team.revision,
          idempotencyKey: `studio-team-${action}:${team.id}:${team.revision}`
        }
        let result
        if (action === 'start')
          result = await svc.startTeam({
            ...common,
            request: {
              text: `Start Team ${team.state.name}`,
              route: { channel: 'agent-studio', scopeType: 'team', scopeId: team.id }
            }
          })
        else if (action === 'pause') result = await svc.pauseTeam(common)
        else if (action === 'resume') result = await svc.resumeTeam(common)
        else result = await svc.stopTeam(common)
        setTeamOperation(result)
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [refresh]
  )
  const createChannel = useCallback(async () => {
    setError(undefined)
    try {
      const id = `channel-${Date.now().toString(36)}`
      await api().svcMagicAgentPlatform.createRuntimeChannel({
        channel: {
          id,
          name: channelDraft.name,
          mode: channelDraft.mode as 'point-to-point' | 'queue' | 'broadcast',
          capacity: channelDraft.capacity
        },
        createdAt: Date.now(),
        idempotencyKey: `studio-channel-create:${id}`
      })
      setChannelDraft({ name: '', mode: 'queue', capacity: 100 })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [channelDraft, refresh])
  const join = useCallback(async () => {
    const channel = data.channels.find((item) => item.id === joinDraft.channelId)
    if (!channel) return
    setError(undefined)
    try {
      const memberId = `member-${joinDraft.agentInstanceId}`
      await api().svcMagicAgentPlatform.joinRuntimeChannel({
        channelId: channel.id,
        expectedRevision: channel.revision,
        member: {
          memberId,
          agentInstanceId: joinDraft.agentInstanceId,
          role: joinDraft.role as 'producer' | 'consumer' | 'member',
          joinedAt: Date.now()
        },
        joinedAt: Date.now(),
        idempotencyKey: `studio-join:${channel.id}:${memberId}:${channel.revision}`
      })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [data.channels, joinDraft, refresh])
  const createWire = useCallback(async () => {
    const source = data.channels.find((item) => item.id === wireDraft.sourceChannelId)
    const target = data.channels.find((item) => item.id === wireDraft.targetChannelId)
    if (!source || !target) return
    setError(undefined)
    try {
      const id = `wire-${Date.now().toString(36)}`
      await api().svcMagicAgentPlatform.wireRuntimeChannel({
        wire: {
          id,
          sourceChannelId: source.id,
          targetChannelId: target.id,
          targetPublisherMemberId: wireDraft.targetPublisherMemberId,
          maxHops: wireDraft.maxHops,
          enabled: true,
          createdAt: Date.now()
        },
        idempotencyKey: `studio-wire:${id}`
      })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [data.channels, wireDraft, refresh])
  const claim = useCallback(async () => {
    setError(undefined)
    try {
      const result = await api().svcMagicAgentPlatform.claimRuntimeChannelMessage({
        messageId: deliveryDraft.messageId,
        expectedRevision: deliveryDraft.revision,
        consumerMemberId: deliveryDraft.consumerMemberId,
        claimedAt: Date.now(),
        leaseMs: 30_000,
        idempotencyKey: `studio-claim:${deliveryDraft.messageId}:${deliveryDraft.revision}`
      })
      setDeliveryDraft({
        ...deliveryDraft,
        revision: result.revision,
        token: result.claimToken ?? ''
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [deliveryDraft])
  const acknowledge = useCallback(async () => {
    setError(undefined)
    try {
      await api().svcMagicAgentPlatform.acknowledgeRuntimeChannelMessage({
        messageId: deliveryDraft.messageId,
        expectedRevision: deliveryDraft.revision,
        consumerMemberId: deliveryDraft.consumerMemberId,
        token: deliveryDraft.token,
        acknowledgedAt: Date.now(),
        idempotencyKey: `studio-ack:${deliveryDraft.messageId}:${deliveryDraft.revision}`
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [deliveryDraft])
  const publish = useCallback(async () => {
    const channel = data.channels.find((item) => item.id === publishDraft.channelId)
    const member = channel?.state.members.find(
      (item: any) => item.memberId === publishDraft.memberId
    )
    if (!channel || !member) return
    setError(undefined)
    try {
      const id = `message-${Date.now().toString(36)}`
      await api().svcMagicAgentPlatform.publishRuntimeChannelMessage({
        message: {
          id,
          channelId: channel.id,
          publisherMemberId: member.memberId,
          payload: { text: publishDraft.text },
          priority: 0,
          publishedAt: Date.now()
        },
        expectedChannelRevision: channel.revision,
        idempotencyKey: `studio-publish:${id}`
      })
      setPublishDraft({ ...publishDraft, text: '' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [data.channels, publishDraft])
  const leave = useCallback(
    async (channel: any, member: any) => {
      setError(undefined)
      try {
        await api().svcMagicAgentPlatform.leaveRuntimeChannel({
          channelId: channel.id,
          expectedRevision: channel.revision,
          memberId: member.memberId,
          leftAt: Date.now(),
          idempotencyKey: `studio-leave:${channel.id}:${member.memberId}:${channel.revision}`
        })
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [refresh]
  )
  const unwire = useCallback(
    async (wire: any) => {
      setError(undefined)
      try {
        await api().svcMagicAgentPlatform.unwireRuntimeChannel({
          wireId: wire.id,
          expectedRevision: wire.revision,
          removedAt: Date.now(),
          idempotencyKey: `studio-unwire:${wire.id}:${wire.revision}`
        })
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [refresh]
  )
  useEffect(() => {
    void refresh()
  }, [refresh])
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="h6">M6 Runtime Topology</Typography>
            <Typography variant="body2" color="text.secondary">
              Production Agent, Team, Channel and Wire resources.
            </Typography>
          </Box>
          <Button startIcon={<Refresh />} onClick={() => void refresh()}>
            Refresh
          </Button>
        </Stack>
        {loading && <CircularProgress size={20} aria-label="Loading M6 topology" />}
        {error && <Alert severity="error">{error}</Alert>}
        {teamOperation && (
          <Alert severity={teamOperation.status === 'completed' ? 'success' : 'warning'}>
            Team {teamOperation.action}: {teamOperation.status} ·{' '}
            {teamOperation.outcomes.filter((item: any) => item.status === 'completed').length}/
            {teamOperation.outcomes.length} members completed
            {teamOperation.outcomes
              .filter((item: any) => item.status === 'failed')
              .map((item: any) => (
                <Typography key={item.memberId} variant="body2">
                  {item.agentInstanceId}: {item.error}
                </Typography>
              ))}
          </Alert>
        )}
        <Stack direction="row" spacing={1} sx={{ my: 2 }}>
          <Chip label={`Agents ${data.agents.length}`} />
          <Chip label={`Teams ${data.teams.length}`} />
          <Chip label={`Channels ${data.channels.length}`} />
          <Chip label={`Wires ${data.wires.length}`} />
        </Stack>
        <Stack spacing={1} sx={{ mb: 2 }}>
          <TextField
            size="small"
            select
            label="Replace Team"
            value={replaceTeamId}
            onChange={(event) => {
              const team = data.teams.find((item) => item.id === event.target.value)
              setReplaceTeamId(event.target.value)
              setReplacementDrafts(
                (team?.state.members ?? []).map((member: any) => {
                  const agent = data.agents.find((item) => item.id === member.agentInstanceId)
                  return {
                    memberId: member.memberId,
                    definitionId: agent?.state.definitionId ?? '',
                    name: agent?.state.name ?? '',
                    configVersion: agent?.state.configVersion ?? ''
                  }
                })
              )
            }}
          >
            {data.teams
              .filter((team) => team.state.members.length > 0)
              .map((team) => (
                <MenuItem key={team.id} value={team.id}>
                  {team.state.name}
                </MenuItem>
              ))}
          </TextField>
          {replacementDrafts.map((item, index) => (
            <Stack key={item.memberId} direction="row" spacing={1}>
              <Typography variant="caption">{item.memberId}</Typography>
              {(['definitionId', 'name', 'configVersion'] as const).map((field) => (
                <TextField
                  key={field}
                  size="small"
                  label={field}
                  value={item[field]}
                  onChange={(event) =>
                    setReplacementDrafts(
                      replacementDrafts.map((draft, draftIndex) =>
                        draftIndex === index ? { ...draft, [field]: event.target.value } : draft
                      )
                    )
                  }
                />
              ))}
            </Stack>
          ))}
          <Button
            variant="outlined"
            disabled={
              !replaceTeamId ||
              replacementDrafts.some(
                (item) => !item.definitionId || !item.name || !item.configVersion
              )
            }
            onClick={() => void replaceTeam()}
          >
            Replace Team
          </Button>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <TextField
            size="small"
            label="Channel name"
            value={channelDraft.name}
            onChange={(event) => setChannelDraft({ ...channelDraft, name: event.target.value })}
          />
          <TextField
            size="small"
            select
            label="Mode"
            value={channelDraft.mode}
            onChange={(event) => setChannelDraft({ ...channelDraft, mode: event.target.value })}
          >
            {['point-to-point', 'queue', 'broadcast'].map((mode) => (
              <MenuItem key={mode} value={mode}>
                {mode}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            type="number"
            label="Capacity"
            value={channelDraft.capacity}
            onChange={(event) =>
              setChannelDraft({ ...channelDraft, capacity: Number(event.target.value) })
            }
          />
          <Button
            variant="outlined"
            disabled={!channelDraft.name.trim() || channelDraft.capacity < 1}
            onClick={() => void createChannel()}
          >
            Create Channel
          </Button>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <TextField
            size="small"
            select
            label="Join channel"
            value={joinDraft.channelId}
            onChange={(event) => setJoinDraft({ ...joinDraft, channelId: event.target.value })}
          >
            {data.channels.map((channel) => (
              <MenuItem key={channel.id} value={channel.id}>
                {channel.state.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="Join Agent"
            value={joinDraft.agentInstanceId}
            onChange={(event) =>
              setJoinDraft({ ...joinDraft, agentInstanceId: event.target.value })
            }
          >
            {data.agents.map((agent) => (
              <MenuItem key={agent.id} value={agent.id}>
                {agent.state.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="Member role"
            value={joinDraft.role}
            onChange={(event) => setJoinDraft({ ...joinDraft, role: event.target.value })}
          >
            {['producer', 'consumer', 'member'].map((role) => (
              <MenuItem key={role} value={role}>
                {role}
              </MenuItem>
            ))}
          </TextField>
          <Button
            variant="outlined"
            disabled={!joinDraft.channelId || !joinDraft.agentInstanceId}
            onClick={() => void join()}
          >
            Join
          </Button>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <TextField
            size="small"
            select
            label="Wire source"
            value={wireDraft.sourceChannelId}
            onChange={(event) =>
              setWireDraft({ ...wireDraft, sourceChannelId: event.target.value })
            }
          >
            {data.channels.map((channel) => (
              <MenuItem key={channel.id} value={channel.id}>
                {channel.state.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="Wire target"
            value={wireDraft.targetChannelId}
            onChange={(event) =>
              setWireDraft({ ...wireDraft, targetChannelId: event.target.value })
            }
          >
            {data.channels.map((channel) => (
              <MenuItem key={channel.id} value={channel.id}>
                {channel.state.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Target publisher member"
            value={wireDraft.targetPublisherMemberId}
            onChange={(event) =>
              setWireDraft({ ...wireDraft, targetPublisherMemberId: event.target.value })
            }
          />
          <Button
            variant="outlined"
            disabled={
              !wireDraft.sourceChannelId ||
              !wireDraft.targetChannelId ||
              !wireDraft.targetPublisherMemberId
            }
            onClick={() => void createWire()}
          >
            Create Wire
          </Button>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <TextField
            size="small"
            select
            label="Publish channel"
            value={publishDraft.channelId}
            onChange={(event) =>
              setPublishDraft({ ...publishDraft, channelId: event.target.value, memberId: '' })
            }
          >
            {data.channels.map((channel) => (
              <MenuItem key={channel.id} value={channel.id}>
                {channel.state.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            select
            label="Publisher member"
            value={publishDraft.memberId}
            onChange={(event) => setPublishDraft({ ...publishDraft, memberId: event.target.value })}
          >
            {(
              data.channels.find((item) => item.id === publishDraft.channelId)?.state.members ?? []
            ).map((member: any) => (
              <MenuItem key={member.memberId} value={member.memberId}>
                {member.memberId}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Message"
            value={publishDraft.text}
            onChange={(event) => setPublishDraft({ ...publishDraft, text: event.target.value })}
          />
          <Button
            variant="outlined"
            disabled={
              !publishDraft.channelId || !publishDraft.memberId || !publishDraft.text.trim()
            }
            onClick={() => void publish()}
          >
            Publish
          </Button>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <TextField
            size="small"
            label="Message ID"
            value={deliveryDraft.messageId}
            onChange={(event) =>
              setDeliveryDraft({ ...deliveryDraft, messageId: event.target.value })
            }
          />
          <TextField
            size="small"
            type="number"
            label="Message revision"
            value={deliveryDraft.revision}
            onChange={(event) =>
              setDeliveryDraft({ ...deliveryDraft, revision: Number(event.target.value) })
            }
          />
          <TextField
            size="small"
            label="Consumer member"
            value={deliveryDraft.consumerMemberId}
            onChange={(event) =>
              setDeliveryDraft({ ...deliveryDraft, consumerMemberId: event.target.value })
            }
          />
          <Button
            variant="outlined"
            disabled={!deliveryDraft.messageId || !deliveryDraft.consumerMemberId}
            onClick={() => void claim()}
          >
            Claim
          </Button>
          <Button
            variant="outlined"
            disabled={
              !deliveryDraft.messageId || !deliveryDraft.consumerMemberId || !deliveryDraft.token
            }
            onClick={() => void acknowledge()}
          >
            Acknowledge
          </Button>
        </Stack>
        <Stack spacing={1}>
          {data.teams.map((team) => (
            <Stack key={team.id} direction="row" spacing={1} alignItems="center">
              <Typography variant="body2">
                Team {team.state.name} · {team.state.status} · {team.state.members.length} members
              </Typography>
              {team.state.status === 'active' && team.state.members.length > 0 && (
                <>
                  <Button size="small" onClick={() => void mutateTeam(team, 'start')}>
                    Start Team
                  </Button>
                  <Button size="small" onClick={() => void mutateTeam(team, 'pause')}>
                    Pause Team
                  </Button>
                  <Button size="small" onClick={() => void mutateTeam(team, 'resume')}>
                    Resume Team
                  </Button>
                  <Button
                    size="small"
                    color="warning"
                    onClick={() => void mutateTeam(team, 'stop')}
                  >
                    Stop Team
                  </Button>
                </>
              )}
            </Stack>
          ))}
          {data.agents.map((agent) => (
            <Stack key={agent.id} direction="row" spacing={1} alignItems="center">
              <Typography variant="body2">
                Agent {agent.state.name} · {agent.state.status}
              </Typography>
              {agent.state.status === 'running' && (
                <Button size="small" onClick={() => void mutateAgent(agent, 'pause')}>
                  Pause
                </Button>
              )}
              {agent.state.status === 'paused' && (
                <Button size="small" onClick={() => void mutateAgent(agent, 'resume')}>
                  Resume
                </Button>
              )}
              {(agent.state.status === 'running' || agent.state.status === 'paused') && (
                <Button
                  size="small"
                  color="warning"
                  onClick={() => void mutateAgent(agent, 'stop')}
                >
                  Stop
                </Button>
              )}
            </Stack>
          ))}
          {data.channels.map((channel) => (
            <Stack key={channel.id} spacing={0.5}>
              <Typography variant="body2">
                Channel {channel.state.name} · {channel.state.mode} ·{' '}
                {channel.state.members?.length ?? 0} members
              </Typography>
              {channel.state.members?.map((member: any) => (
                <Stack key={member.memberId} direction="row" spacing={1} alignItems="center">
                  <Typography variant="caption">
                    {member.memberId} · {member.role}
                  </Typography>
                  <Button size="small" color="warning" onClick={() => void leave(channel, member)}>
                    Leave
                  </Button>
                </Stack>
              ))}
            </Stack>
          ))}
          {data.wires.map((wire) => (
            <Stack key={wire.id} direction="row" spacing={1} alignItems="center">
              <Typography variant="body2">
                Wire {wire.state.sourceChannelId} → {wire.state.targetChannelId}
              </Typography>
              <Button size="small" color="warning" onClick={() => void unwire(wire)}>
                Unwire
              </Button>
            </Stack>
          ))}
        </Stack>
      </CardContent>
    </Card>
  )
}
