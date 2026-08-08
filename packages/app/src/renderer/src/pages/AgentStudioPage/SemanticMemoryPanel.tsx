import React, { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  FormControlLabel,
  Grid,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { api } from '@renderer/utils/windowUtils'
import type { AgentRouteLike } from '@shared/agent'
import type {
  SemanticMemoryPublicRecord,
  SemanticMemoryPublicSearchResult,
  SemanticMemorySearchMode,
  SemanticMemoryVisibility
} from '@shared/magicAgentPlatform2/memory'

const modes: SemanticMemorySearchMode[] = ['lexical', 'semantic', 'hybrid']
const visibilities: SemanticMemoryVisibility[] = ['private', 'workspace', 'shared']

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason)

export const SemanticMemoryPanel: React.FC = () => {
  const [channel, setChannel] = useState('generic')
  const [scopeType, setScopeType] = useState('dm')
  const [scopeId, setScopeId] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SemanticMemorySearchMode>('hybrid')
  const [providerId, setProviderId] = useState('')
  const [targetKind, setTargetKind] = useState<'session' | 'agent' | 'workspace' | 'drive'>(
    'session'
  )
  const [targetId, setTargetId] = useState('')
  const [memoryId, setMemoryId] = useState('')
  const [visibility, setVisibility] = useState<SemanticMemoryVisibility>('private')
  const [searchResult, setSearchResult] = useState<SemanticMemoryPublicSearchResult>()
  const [inspected, setInspected] = useState<SemanticMemoryPublicRecord>()
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmRebuild, setConfirmRebuild] = useState(false)

  const route = (): AgentRouteLike => {
    const normalizedChannel = channel.trim()
    const normalizedScopeType = scopeType.trim()
    const normalizedScopeId = scopeId.trim()
    const normalizedOwnerId = ownerId.trim()
    if (!normalizedChannel || !normalizedScopeType || !normalizedScopeId || !normalizedOwnerId)
      throw new Error('Channel, scope type, scope ID, and owner user ID are required.')
    return {
      channel: normalizedChannel,
      scopeType: normalizedScopeType,
      scopeId: normalizedScopeId,
      senderId: normalizedOwnerId
    }
  }

  const run = async (name: string, operation: () => Promise<void>) => {
    setBusy(name)
    setError(undefined)
    setNotice(undefined)
    try {
      await operation()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const requireMemoryId = (): string => {
    const id = memoryId.trim()
    if (!id) throw new Error('Memory / provenance ID is required.')
    return id
  }

  const selectedScope = () => {
    if (targetKind === 'session') return { kind: 'session' as const, route: route() }
    const id = targetId.trim()
    if (!id) throw new Error(`${targetKind} ID is required.`)
    return { kind: targetKind, id, sourceRoute: route() }
  }

  const ingest = () =>
    run('ingest', async () => {
      const result = await api().svcMagicAgentPlatform.ingestMemoryScope({
        scope: selectedScope(),
        ...(providerId.trim() ? { providerId: providerId.trim() } : {})
      })
      setNotice(
        `Ingested ${targetKind}: ${result.discovered} discovered, ${result.upserted} upserted.`
      )
    })

  const search = () =>
    run('search', async () => {
      if (!query.trim()) throw new Error('Query is required.')
      const result = await api().svcMagicAgentPlatform.searchMemory({
        query: query.trim(),
        scopes: [selectedScope()],
        mode,
        limit: 25,
        ...(providerId.trim() ? { providerId: providerId.trim() } : {})
      })
      setSearchResult(result)
    })

  const inspect = () =>
    run('inspect', async () => {
      const result = await api().svcMagicAgentPlatform.inspectMemory({
        id: requireMemoryId(),
        sourceRoute: route()
      })
      setInspected(result.memory)
      if (!result.memory) setNotice('No owned memory record found for that ID.')
    })

  const mutate = (
    name: string,
    operation: (request: {
      id: string
      sourceRoute: AgentRouteLike
    }) => Promise<{ affected: number }>
  ) =>
    run(name, async () => {
      const result = await operation({ id: requireMemoryId(), sourceRoute: route() })
      setNotice(`${name}: ${result.affected} record(s) affected.`)
    })

  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6">Semantic Memory</Typography>
            <Typography variant="body2" color="text.secondary">
              Operate only on a session route owned by the authenticated user. Results expose safe
              metadata and IDs only; memory content, summaries, provenance details, and vectors are
              never displayed.
            </Typography>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          {notice && <Alert severity="info">{notice}</Alert>}

          <Typography variant="subtitle1">Owned session route</Typography>
          <Grid container spacing={1.5}>
            <Grid size={{ xs: 12, sm: 3 }}>
              <TextField
                label="Channel"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 3 }}>
              <TextField
                label="Scope type"
                value={scopeType}
                onChange={(e) => setScopeType(e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 3 }}>
              <TextField
                label="Scope ID"
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
                fullWidth
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 3 }}>
              <TextField
                label="Owner user ID"
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
                fullWidth
              />
            </Grid>
          </Grid>

          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 6 }}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle1">Ingest and query</Typography>
                <label htmlFor="semantic-memory-target-kind">Memory scope</label>
                <select
                  id="semantic-memory-target-kind"
                  value={targetKind}
                  onChange={(e) => setTargetKind(e.target.value as typeof targetKind)}
                >
                  {(['session', 'agent', 'workspace', 'drive'] as const).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                {targetKind !== 'session' && (
                  <TextField
                    label={`${targetKind} ID`}
                    value={targetId}
                    onChange={(e) => setTargetId(e.target.value)}
                  />
                )}
                {targetKind === 'agent' && (
                  <Stack direction="row" spacing={1}>
                    <Button
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run('link agent session', async () => {
                          const links = await api().svcMagicAgentPlatform.linkMemoryAgentSession({
                            agentId: targetId.trim(),
                            sourceRoute: route()
                          })
                          setNotice(`Agent has ${links.length} linked session(s).`)
                        })
                      }
                    >
                      Link session
                    </Button>
                    <Button
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run('unlink agent session', async () => {
                          const links = await api().svcMagicAgentPlatform.unlinkMemoryAgentSession({
                            agentId: targetId.trim(),
                            sourceRoute: route()
                          })
                          setNotice(`Agent has ${links.length} linked session(s).`)
                        })
                      }
                    >
                      Unlink session
                    </Button>
                    <Button
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run('list agent sessions', async () => {
                          const links = await api().svcMagicAgentPlatform.listMemoryAgentSessions({
                            agentId: targetId.trim()
                          })
                          setNotice(`Agent has ${links.length} linked session(s).`)
                        })
                      }
                    >
                      List links
                    </Button>
                  </Stack>
                )}
                <TextField
                  label="Embedding provider ID (optional)"
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                />
                <Button variant="outlined" disabled={Boolean(busy)} onClick={() => void ingest()}>
                  Ingest scope
                </Button>
                <TextField
                  label="Memory query"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <label htmlFor="semantic-memory-mode">Query mode</label>
                <select
                  id="semantic-memory-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as SemanticMemorySearchMode)}
                >
                  {modes.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <Button variant="contained" disabled={Boolean(busy)} onClick={() => void search()}>
                  Query memory
                </Button>
                {searchResult && (
                  <Stack spacing={1} aria-label="Memory search results">
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      <Chip label={`requested: ${searchResult.requestedMode}`} size="small" />
                      <Chip label={`effective: ${searchResult.effectiveMode}`} size="small" />
                      <Chip
                        label={`degraded: ${searchResult.degraded ? 'yes' : 'no'}`}
                        color={searchResult.degraded ? 'warning' : 'success'}
                        size="small"
                      />
                    </Stack>
                    {searchResult.degraded && (
                      <Alert severity="warning">
                        {searchResult.degradationReason || 'Semantic memory query degraded.'}
                      </Alert>
                    )}
                    {searchResult.hits.map(({ memory, score, lexicalScore, semanticScore }) => (
                      <Box
                        key={memory.id}
                        data-testid={`memory-hit-${memory.id}`}
                        sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}
                      >
                        <Typography variant="subtitle2">ID: {memory.id}</Typography>
                        <Typography variant="body2">
                          Scope: {memory.scope.kind} · {memory.scope.id}
                        </Typography>
                        <Typography variant="body2">
                          Score: {score} · lexical: {lexicalScore}
                          {semanticScore === undefined ? '' : ` · semantic: ${semanticScore}`}
                        </Typography>
                        <Typography variant="body2">
                          Visibility: {memory.visibility} ·{' '}
                          {memory.disabled ? 'disabled' : 'enabled'} · lifetime: {memory.lifetime}
                        </Typography>
                        <Typography variant="body2">
                          Importance: {memory.importance} · sensitive:{' '}
                          {memory.sensitive ? 'yes' : 'no'} · redacted:{' '}
                          {memory.redacted ? 'yes' : 'no'}
                        </Typography>
                        <Typography variant="body2">{memory.preview}</Typography>
                        <Typography variant="caption" display="block">
                          Source: {memory.provenance.sourceKind} · {memory.provenance.sourceId}
                          {memory.provenance.sourceSessionKey
                            ? ` · session ${memory.provenance.sourceSessionKey}`
                            : ''}
                          {memory.provenance.sourceEventId
                            ? ` · event ${memory.provenance.sourceEventId}`
                            : ''}
                          {memory.provenance.sourceRunId
                            ? ` · run ${memory.provenance.sourceRunId}`
                            : ''}
                          {memory.provenance.sourceArtifactId
                            ? ` · artifact ${memory.provenance.sourceArtifactId}`
                            : ''}
                        </Typography>
                        <Button
                          size="small"
                          onClick={() => {
                            setMemoryId(memory.id)
                            setInspected(memory)
                          }}
                        >
                          Select ID
                        </Button>
                      </Box>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Grid>

            <Grid size={{ xs: 12, md: 6 }}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle1">Inspect and administer</Typography>
                <TextField
                  label="Memory / provenance ID"
                  value={memoryId}
                  onChange={(e) => setMemoryId(e.target.value)}
                />
                <Button variant="outlined" disabled={Boolean(busy)} onClick={() => void inspect()}>
                  Inspect safe metadata
                </Button>
                {inspected && (
                  <Alert severity="info" aria-label="Inspected safe metadata">
                    ID {inspected.id}; {inspected.scope.kind} scope {inspected.scope.id};{' '}
                    {inspected.visibility}; {inspected.disabled ? 'disabled' : 'enabled'}; lifetime{' '}
                    {inspected.lifetime}; importance {inspected.importance}. Preview:{' '}
                    {inspected.preview}. Source: {inspected.provenance.sourceKind} ·{' '}
                    {inspected.provenance.sourceId}
                    {inspected.provenance.sourceSessionKey
                      ? ` · session ${inspected.provenance.sourceSessionKey}`
                      : ''}
                    {inspected.provenance.sourceEventId
                      ? ` · event ${inspected.provenance.sourceEventId}`
                      : ''}
                    {inspected.provenance.sourceRunId
                      ? ` · run ${inspected.provenance.sourceRunId}`
                      : ''}
                    {inspected.provenance.sourceArtifactId
                      ? ` · artifact ${inspected.provenance.sourceArtifactId}`
                      : ''}
                    .
                  </Alert>
                )}
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void mutate('Disable', (request) =>
                        api().svcMagicAgentPlatform.setMemoryDisabled({
                          ...request,
                          disabled: true
                        })
                      )
                    }
                  >
                    Disable
                  </Button>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void mutate('Enable', (request) =>
                        api().svcMagicAgentPlatform.setMemoryDisabled({
                          ...request,
                          disabled: false
                        })
                      )
                    }
                  >
                    Enable
                  </Button>
                  <label htmlFor="semantic-memory-visibility">Visibility</label>
                  <select
                    id="semantic-memory-visibility"
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value as SemanticMemoryVisibility)}
                  >
                    {visibilities.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void mutate('Set visibility', (request) =>
                        api().svcMagicAgentPlatform.setMemoryVisibility({ ...request, visibility })
                      )
                    }
                  >
                    Apply visibility
                  </Button>
                </Stack>

                <Alert severity="error">
                  Destructive actions are irreversible. Delete removes one memory record. Clear
                  scope removes every memory record for this session. Rebuild replaces provider
                  embeddings and may make semantic results temporarily unavailable.
                </Alert>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={confirmDelete}
                      onChange={(e) => setConfirmDelete(e.target.checked)}
                    />
                  }
                  label="I understand: delete this record"
                />
                <Button
                  color="error"
                  disabled={Boolean(busy) || !confirmDelete}
                  onClick={() =>
                    void mutate('Delete', (request) =>
                      api().svcMagicAgentPlatform.deleteMemory(request)
                    )
                  }
                >
                  Delete memory
                </Button>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={confirmClear}
                      onChange={(e) => setConfirmClear(e.target.checked)}
                    />
                  }
                  label="I understand: clear the entire session scope"
                />
                <Button
                  color="error"
                  disabled={Boolean(busy) || !confirmClear}
                  onClick={() =>
                    void run('Clear scope', async () => {
                      const result = await api().svcMagicAgentPlatform.clearMemoryScope({
                        scope: { kind: 'session', route: route() }
                      })
                      setNotice(`Clear scope: ${result.affected} record(s) affected.`)
                    })
                  }
                >
                  Clear session scope
                </Button>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={confirmRebuild}
                      onChange={(e) => setConfirmRebuild(e.target.checked)}
                    />
                  }
                  label="I understand: rebuild provider embeddings"
                />
                <Button
                  color="warning"
                  disabled={Boolean(busy) || !confirmRebuild || !providerId.trim()}
                  onClick={() =>
                    void run('Rebuild', async () => {
                      const job = await api().svcMagicAgentPlatform.rebuildMemory({
                        sourceRoute: route(),
                        providerId: providerId.trim()
                      })
                      setNotice(`Rebuild job ${job.id}: ${job.status}, ${job.processed} processed.`)
                    })
                  }
                >
                  Rebuild embeddings
                </Button>
              </Stack>
            </Grid>
          </Grid>
        </Stack>
      </CardContent>
    </Card>
  )
}

export default SemanticMemoryPanel
