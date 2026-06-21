import React, { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { api } from '@renderer/utils/windowUtils'
import type {
  MagicAgentPlatformAgentDefinition,
  MagicAgentPlatformGraphListResp,
  MagicAgentPlatformListToolsResp,
  MagicAgentPlatformPackageListResp,
  MagicAgentPlatformStatusResp
} from '@shared/api/svcMagicAgentPlatform'

const MAGIC_AGENT_FLAG_HELP = 'Set MAGICPOT_MAGICAGENT_PLATFORM=1 to enable Agent Studio actions.'

type StudioState = {
  status?: MagicAgentPlatformStatusResp
  agents: MagicAgentPlatformAgentDefinition[]
  tools: MagicAgentPlatformListToolsResp['tools']
  graphs: MagicAgentPlatformGraphListResp['graphs']
  packages: MagicAgentPlatformPackageListResp['packages']
}

const emptyState: StudioState = {
  agents: [],
  tools: [],
  graphs: [],
  packages: []
}

const AgentStudioPage: React.FC = () => {
  const [state, setState] = useState<StudioState>(emptyState)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [prompt, setPrompt] = useState('List the available MagicPot creative capabilities.')
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loadStudio = async () => {
    setLoading(true)
    setError(null)
    try {
      const status = await api().svcMagicAgentPlatform.getStatus({})
      if (!status.enabled) {
        setState({ ...emptyState, status })
        setResult(MAGIC_AGENT_FLAG_HELP)
        return
      }

      const [agents, tools, graphs, packages] = await Promise.all([
        api().svcMagicAgentPlatform.listAgents({}),
        api().svcMagicAgentPlatform.listTools({}),
        api().svcMagicAgentPlatform.listGraphs({}),
        api().svcMagicAgentPlatform.listPackages({})
      ])
      setState({
        status,
        agents: agents.agents,
        tools: tools.tools,
        graphs: graphs.graphs,
        packages: packages.packages
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadStudio()
  }, [])

  const runDefaultAgent = async () => {
    setRunning(true)
    setError(null)
    try {
      const response = await api().svcMagicAgentPlatform.runAgent({
        agentId: 'magicpot.default.chat',
        text: prompt,
        route: { channel: 'generic', scopeType: 'dm', scopeId: 'agent-studio' },
        maxToolIterations: 2
      })
      setResult(response.error || response.content || JSON.stringify(response.events, null, 2))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 3, bgcolor: 'background.default' }}>
      <Stack spacing={3}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
          <Box>
            <Typography variant="h4" fontWeight={700}>
              Agent Studio
            </Typography>
            <Typography variant="body2" color="text.secondary">
              MagicAgent Platform v1: agents, creative tools, graph teams, and package inventory.
            </Typography>
          </Box>
          <Button variant="outlined" onClick={() => void loadStudio()} disabled={loading}>
            Refresh
          </Button>
        </Stack>

        {error ? <Alert severity="error">{error}</Alert> : null}
        {state.status && !state.status.enabled ? (
          <Alert severity="info">{MAGIC_AGENT_FLAG_HELP}</Alert>
        ) : null}

        {loading ? (
          <Stack alignItems="center" sx={{ py: 6 }}>
            <CircularProgress size={28} />
          </Stack>
        ) : (
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 3 }}>
              <Card>
                <CardContent>
                  <Typography color="text.secondary" variant="body2">
                    Agents
                  </Typography>
                  <Typography variant="h4">
                    {state.status?.agentCount ?? state.agents.length}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid size={{ xs: 12, md: 3 }}>
              <Card>
                <CardContent>
                  <Typography color="text.secondary" variant="body2">
                    Tools
                  </Typography>
                  <Typography variant="h4">
                    {state.status?.toolCount ?? state.tools.length}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid size={{ xs: 12, md: 3 }}>
              <Card>
                <CardContent>
                  <Typography color="text.secondary" variant="body2">
                    Graphs
                  </Typography>
                  <Typography variant="h4">
                    {state.status?.graphCount ?? state.graphs.length}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
            <Grid size={{ xs: 12, md: 3 }}>
              <Card>
                <CardContent>
                  <Typography color="text.secondary" variant="body2">
                    Packages
                  </Typography>
                  <Typography variant="h4">
                    {state.status?.packageCount ?? state.packages.length}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        )}

        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="h6">Default Agent Smoke Run</Typography>
              <TextField
                label="Prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                multiline
                minRows={3}
                fullWidth
              />
              <Stack direction="row" spacing={2} alignItems="center">
                <Button
                  variant="contained"
                  onClick={() => void runDefaultAgent()}
                  disabled={running || loading || !state.status?.enabled}
                >
                  Run magicpot.default.chat
                </Button>
                {running ? <CircularProgress size={22} /> : null}
              </Stack>
              {result ? (
                <Box
                  component="pre"
                  sx={{ whiteSpace: 'pre-wrap', m: 0, p: 2, bgcolor: 'action.hover' }}
                >
                  {result}
                </Box>
              ) : null}
            </Stack>
          </CardContent>
        </Card>

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Typography variant="h6">Agents</Typography>
                <Divider sx={{ my: 1 }} />
                <Stack spacing={1}>
                  {state.agents.map((agent) => (
                    <Box key={agent.id}>
                      <Typography fontWeight={600}>{agent.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {agent.id}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Typography variant="h6">Creative + Assistant Tools</Typography>
                <Divider sx={{ my: 1 }} />
                <Stack direction="row" gap={1} flexWrap="wrap">
                  {state.tools.slice(0, 80).map((tool) => (
                    <Chip
                      key={`${tool.source}:${tool.name}`}
                      label={`${tool.source}:${tool.name}`}
                      color={tool.status === 'unavailable' ? 'default' : 'primary'}
                      variant={tool.status === 'unavailable' ? 'outlined' : 'filled'}
                      size="small"
                    />
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Typography variant="h6">Graphs</Typography>
                <Divider sx={{ my: 1 }} />
                <Stack spacing={1}>
                  {state.graphs.map((graph) => (
                    <Box key={graph.graphId}>
                      <Typography fontWeight={600}>{graph.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {graph.graphId} · {graph.nodeCount} nodes · {graph.channelCount} channels
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Card>
              <CardContent>
                <Typography variant="h6">Packages</Typography>
                <Divider sx={{ my: 1 }} />
                <Stack spacing={1}>
                  {state.packages.length ? (
                    state.packages.map((pkg) => (
                      <Box key={pkg.id}>
                        <Typography fontWeight={600}>{pkg.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {pkg.id}@{pkg.version}
                        </Typography>
                      </Box>
                    ))
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      No MagicPot packages installed.
                    </Typography>
                  )}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Stack>
    </Box>
  )
}

export default AgentStudioPage
