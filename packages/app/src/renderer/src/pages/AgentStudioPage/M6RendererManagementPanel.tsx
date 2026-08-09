import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  CardContent,
  Divider,
  MenuItem,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { api } from '@renderer/utils/windowUtils'
import type {
  MagicAgentPlatformAgentInstanceResource,
  MagicAgentPlatformTeamResource
} from '@shared/api/svcMagicAgentPlatform'

const route = (instanceId: string) => ({
  channel: 'agent-studio',
  scopeType: 'dm' as const,
  scopeId: instanceId
})
const key = (operation: string, id: string, revision?: number) =>
  `studio-${operation}:${id}${revision === undefined ? '' : `:${revision}`}`
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const M6RendererManagementPanel = () => {
  const service = api().svcMagicAgentPlatform
  const [agents, setAgents] = useState<readonly MagicAgentPlatformAgentInstanceResource[]>([])
  const [teams, setTeams] = useState<readonly MagicAgentPlatformTeamResource[]>([])
  const [agentId, setAgentId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [newAgentId, setNewAgentId] = useState('agent-new')
  const [agentName, setAgentName] = useState('New Agent')
  const [definitionId, setDefinitionId] = useState('definition')
  const [configVersion, setConfigVersion] = useState('v1')
  const [startText, setStartText] = useState('Start agent')
  const [newTeamId, setNewTeamId] = useState('team-new')
  const [teamName, setTeamName] = useState('New Team')
  const [memberId, setMemberId] = useState('member-1')
  const [memberAgentId, setMemberAgentId] = useState('')
  const [removeMemberId, setRemoveMemberId] = useState('')
  const [newConfigVersion, setNewConfigVersion] = useState('v2')
  const [configDefinitionId, setConfigDefinitionId] = useState('definition')
  const [modelProfileId, setModelProfileId] = useState('model')
  const [systemPrompt, setSystemPrompt] = useState('safe')

  const selectedAgent = useMemo(() => agents.find((item) => item.id === agentId), [agents, agentId])
  const selectedTeam = useMemo(() => teams.find((item) => item.id === teamId), [teams, teamId])

  const refresh = useCallback(async () => {
    const [agentResp, teamResp] = await Promise.all([
      service.listAgentInstances({}),
      service.listTeams()
    ])
    setAgents(agentResp.instances)
    setTeams(teamResp)
    setAgentId((current) =>
      agentResp.instances.some((item) => item.id === current)
        ? current
        : agentResp.instances[0]?.id || ''
    )
    setMemberAgentId((current) =>
      agentResp.instances.some((item) => item.id === current)
        ? current
        : agentResp.instances[0]?.id || ''
    )
    setTeamId((current) =>
      teamResp.some((item) => item.id === current) ? current : teamResp[0]?.id || ''
    )
  }, [service])

  useEffect(() => {
    refresh().catch((cause) => setError(message(cause)))
  }, [refresh])

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await operation()
      await refresh()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  const now = () => Date.now()
  const revision = selectedAgent?.revision ?? 0
  const teamRevision = selectedTeam?.revision ?? 0

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6">M6 Agent, Team, and Config Management</Typography>
          {error && <Alert severity="error">{error}</Alert>}
          <Button onClick={() => void run(refresh)} disabled={busy}>
            Refresh management resources
          </Button>

          <Divider />
          <Typography variant="subtitle1">Agents</Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <TextField
              label="New Agent ID"
              value={newAgentId}
              onChange={(e) => setNewAgentId(e.target.value)}
            />
            <TextField
              label="Agent name"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            />
            <TextField
              label="Agent definition ID"
              value={definitionId}
              onChange={(e) => setDefinitionId(e.target.value)}
            />
            <TextField
              label="Agent config version"
              value={configVersion}
              onChange={(e) => setConfigVersion(e.target.value)}
            />
            <Button
              disabled={
                busy ||
                !newAgentId.trim() ||
                !agentName.trim() ||
                !definitionId.trim() ||
                !configVersion.trim()
              }
              onClick={() =>
                void run(() =>
                  service.createRootAgentInstance({
                    instance: {
                      id: newAgentId.trim(),
                      name: agentName.trim(),
                      definitionId: definitionId.trim(),
                      depth: 0,
                      configVersion: configVersion.trim(),
                      status: 'created',
                      limits: {
                        maxChildren: 0,
                        maxDepth: 0,
                        maxConcurrency: 1,
                        maxRuntimeMs: 60_000,
                        allowedToolNames: [],
                        workspaceRoots: []
                      }
                    },
                    createdAt: now(),
                    idempotencyKey: key('agent-create', newAgentId.trim())
                  })
                )
              }
            >
              Create root Agent
            </Button>
          </Stack>
          <TextField
            select
            label="Managed Agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {agents.map((agent) => (
              <MenuItem key={agent.id} value={agent.id}>
                {agent.state.name} · r{agent.revision}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Start request"
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
          />
          <Stack direction="row" spacing={1} flexWrap="wrap">
            <Button
              disabled={busy || !selectedAgent || !startText.trim()}
              onClick={() =>
                void run(() =>
                  service.startAgentInstance({
                    instanceId: agentId,
                    expectedRevision: revision,
                    request: { text: startText.trim(), route: route(agentId) },
                    idempotencyKey: key('agent-start', agentId, revision)
                  })
                )
              }
            >
              Start Agent
            </Button>
            <Button
              disabled={
                busy ||
                !selectedAgent ||
                !definitionId.trim() ||
                !agentName.trim() ||
                !configVersion.trim()
              }
              onClick={() =>
                void run(() =>
                  service.replaceAgentInstance({
                    instanceId: agentId,
                    expectedRevision: revision,
                    definitionId: definitionId.trim(),
                    name: agentName.trim(),
                    configVersion: configVersion.trim(),
                    replacedAt: now(),
                    idempotencyKey: key('agent-replace', agentId, revision)
                  })
                )
              }
            >
              Replace Agent
            </Button>
            <Button
              color="error"
              disabled={busy || !selectedAgent}
              onClick={() =>
                void run(() =>
                  service.removeAgentInstance({
                    instanceId: agentId,
                    expectedRevision: revision,
                    removedAt: now(),
                    idempotencyKey: key('agent-remove', agentId, revision)
                  })
                )
              }
            >
              Remove Agent
            </Button>
          </Stack>

          <Divider />
          <Typography variant="subtitle1">Teams</Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <TextField
              label="New Team ID"
              value={newTeamId}
              onChange={(e) => setNewTeamId(e.target.value)}
            />
            <TextField
              label="Team name"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
            />
            <Button
              disabled={busy || !newTeamId.trim() || !teamName.trim()}
              onClick={() =>
                void run(() =>
                  service.createTeam({
                    team: { id: newTeamId.trim(), name: teamName.trim(), createdAt: now() },
                    idempotencyKey: key('team-create', newTeamId.trim())
                  })
                )
              }
            >
              Create Team
            </Button>
          </Stack>
          <TextField
            select
            label="Managed Team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          >
            {teams.map((team) => (
              <MenuItem key={team.id} value={team.id}>
                {team.state.name} · r{team.revision}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <TextField
              label="Member ID"
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
            />
            <TextField
              select
              label="Member Agent"
              value={memberAgentId}
              onChange={(e) => setMemberAgentId(e.target.value)}
            >
              {agents.map((agent) => (
                <MenuItem key={agent.id} value={agent.id}>
                  {agent.state.name}
                </MenuItem>
              ))}
            </TextField>
            <Button
              disabled={busy || !selectedTeam || !memberId.trim() || !memberAgentId}
              onClick={() =>
                void run(() =>
                  service.addTeamMember({
                    teamId,
                    expectedRevision: teamRevision,
                    member: {
                      memberId: memberId.trim(),
                      agentInstanceId: memberAgentId,
                      role: 'member',
                      joinedAt: now()
                    },
                    idempotencyKey: key('team-member-add', teamId, teamRevision)
                  })
                )
              }
            >
              Add Team member
            </Button>
          </Stack>
          <TextField
            label="Remove member ID"
            value={removeMemberId}
            onChange={(e) => setRemoveMemberId(e.target.value)}
          />
          <Stack direction="row" spacing={1}>
            <Button
              disabled={busy || !selectedTeam || !removeMemberId.trim()}
              onClick={() =>
                void run(() =>
                  service.removeTeamMember({
                    teamId,
                    expectedRevision: teamRevision,
                    memberId: removeMemberId.trim(),
                    removedAt: now(),
                    idempotencyKey: key('team-member-remove', teamId, teamRevision)
                  })
                )
              }
            >
              Remove Team member
            </Button>
            <Button
              color="error"
              disabled={busy || !selectedTeam || selectedTeam.state.members.length !== 0}
              onClick={() =>
                void run(() =>
                  service.removeTeam({
                    teamId,
                    expectedRevision: teamRevision,
                    removedAt: now(),
                    idempotencyKey: key('team-remove', teamId, teamRevision)
                  })
                )
              }
            >
              Remove empty Team
            </Button>
          </Stack>

          <Divider />
          <Typography variant="subtitle1">Immutable Agent config</Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <TextField
              label="Config version"
              value={newConfigVersion}
              onChange={(e) => setNewConfigVersion(e.target.value)}
            />
            <TextField
              label="Config definition ID"
              value={configDefinitionId}
              onChange={(e) => setConfigDefinitionId(e.target.value)}
            />
            <TextField
              label="Model profile ID"
              value={modelProfileId}
              onChange={(e) => setModelProfileId(e.target.value)}
            />
          </Stack>
          <TextField
            label="System prompt"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
          <Stack direction="row" spacing={1} flexWrap="wrap">
            <Button
              disabled={
                busy ||
                !newConfigVersion.trim() ||
                !configDefinitionId.trim() ||
                !modelProfileId.trim() ||
                !systemPrompt.trim()
              }
              onClick={() =>
                void run(() =>
                  service.createAgentConfigVersion({
                    config: {
                      version: newConfigVersion.trim(),
                      definitionId: configDefinitionId.trim(),
                      model: { profileId: modelProfileId.trim() },
                      systemPrompt: systemPrompt.trim(),
                      inference: {},
                      tools: { allowedToolNames: [] },
                      memory: { allowHistory: false, contextMessageLimit: 1, scope: 'session' },
                      policy: { policyIds: [], workspaceRoots: [] },
                      channels: { channelIds: [] },
                      budgets: { maxRuntimeMs: 100 },
                      createdAt: now()
                    },
                    idempotencyKey: key(
                      'config-create',
                      `${configDefinitionId.trim()}:${newConfigVersion.trim()}`
                    )
                  })
                )
              }
            >
              Create config version
            </Button>
            <Button
              disabled={busy || !selectedAgent || !newConfigVersion.trim()}
              onClick={() =>
                void run(() =>
                  service.stageAgentConfig({
                    instanceId: agentId,
                    expectedRevision: revision,
                    configVersion: newConfigVersion.trim(),
                    stagedAt: now(),
                    idempotencyKey: key('config-stage', agentId, revision)
                  })
                )
              }
            >
              Stage config
            </Button>
            <Button
              disabled={busy || !selectedAgent}
              onClick={() =>
                void run(() =>
                  service.activateAgentConfig({
                    instanceId: agentId,
                    expectedRevision: revision,
                    activatedAt: now(),
                    idempotencyKey: key('config-activate', agentId, revision)
                  })
                )
              }
            >
              Activate config
            </Button>
            <Button
              disabled={busy || !selectedAgent}
              onClick={() =>
                void run(() =>
                  service.rollbackAgentConfig({
                    instanceId: agentId,
                    expectedRevision: revision,
                    rolledBackAt: now(),
                    idempotencyKey: key('config-rollback', agentId, revision)
                  })
                )
              }
            >
              Rollback config
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}
