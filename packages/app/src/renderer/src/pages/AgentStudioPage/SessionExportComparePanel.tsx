import React, { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Grid,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { api } from '@renderer/utils/windowUtils'
import type { AgentRouteLike } from '@shared/agent'
import type {
  MagicAgentPlatformSessionDiffResp,
  MagicAgentPlatformSessionExportFormat,
  MagicAgentPlatformSessionExportResp
} from '@shared/api/svcMagicAgentPlatform'

const parseRoute = (value: string): AgentRouteLike => {
  const [channel, scopeType, ...scopeId] = value.trim().split(':')
  if (!channel || !scopeType || !scopeId.length)
    throw new Error('Route must be channel:scopeType:scopeId.')
  return {
    channel,
    scopeType: scopeType as AgentRouteLike['scopeType'],
    scopeId: scopeId.join(':')
  }
}

const snapshot = (value: unknown): string => JSON.stringify(value, null, 2)

export const SessionExportComparePanel: React.FC = () => {
  const [sourceRoute, setSourceRoute] = useState('generic:dm:agent-studio')
  const [leftRoute, setLeftRoute] = useState('generic:dm:agent-studio')
  const [rightRoute, setRightRoute] = useState('generic:dm:agent-studio-fork')
  const [format, setFormat] = useState<MagicAgentPlatformSessionExportFormat>('markdown')
  const [exportResult, setExportResult] = useState<MagicAgentPlatformSessionExportResp>()
  const [diffResult, setDiffResult] = useState<MagicAgentPlatformSessionDiffResp>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'export' | 'diff'>()
  const objectUrl = useRef<string | undefined>(undefined)

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    },
    []
  )

  const runExport = async () => {
    setBusy('export')
    setError(undefined)
    try {
      setExportResult(
        await api().svcMagicAgentPlatform.exportSession({
          sourceRoute: parseRoute(sourceRoute),
          format
        })
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const runDiff = async () => {
    setBusy('diff')
    setError(undefined)
    try {
      setDiffResult(
        await api().svcMagicAgentPlatform.diffSessions({
          leftRoute: parseRoute(leftRoute),
          rightRoute: parseRoute(rightRoute)
        })
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const download = () => {
    if (!exportResult) return
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = URL.createObjectURL(
      new Blob([exportResult.body], { type: exportResult.mimeType })
    )
    const link = document.createElement('a')
    link.href = objectUrl.current
    link.download = exportResult.filename
    link.rel = 'noopener'
    link.click()
  }

  const unavailable = exportResult
    ? Object.entries(exportResult.availability).filter(
        ([, value]) => value.status === 'unavailable'
      )
    : []

  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6">Session Export &amp; Compare</Typography>
            <Typography variant="body2" color="text.secondary">
              Export a bounded, redacted session projection or compare two session routes.
            </Typography>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 6 }}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle1">Export</Typography>
                <TextField
                  label="Source route"
                  value={sourceRoute}
                  onChange={(event) => setSourceRoute(event.target.value)}
                />
                <label htmlFor="session-export-format">
                  <Typography variant="caption">Format</Typography>
                </label>
                <select
                  id="session-export-format"
                  value={format}
                  onChange={(event) =>
                    setFormat(event.target.value as MagicAgentPlatformSessionExportFormat)
                  }
                >
                  <option value="markdown">Markdown</option>
                  <option value="html">HTML</option>
                  <option value="jsonl">JSONL</option>
                </select>
                <Stack direction="row" spacing={1}>
                  <Button
                    variant="contained"
                    disabled={Boolean(busy)}
                    onClick={() => void runExport()}
                  >
                    Export preview
                  </Button>
                  <Button variant="outlined" disabled={!exportResult} onClick={download}>
                    Download
                  </Button>
                </Stack>
                {unavailable.map(([dimension, value]) => (
                  <Alert severity="warning" key={dimension}>
                    {dimension}: {value.reason || 'unavailable'}
                  </Alert>
                ))}
                {exportResult && (
                  <Box
                    component="pre"
                    aria-label="Export preview"
                    sx={{
                      whiteSpace: 'pre-wrap',
                      overflow: 'auto',
                      maxHeight: 360,
                      p: 1,
                      bgcolor: 'action.hover'
                    }}
                  >
                    {exportResult.body}
                  </Box>
                )}
              </Stack>
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle1">Compare</Typography>
                <TextField
                  label="Left route"
                  value={leftRoute}
                  onChange={(event) => setLeftRoute(event.target.value)}
                />
                <TextField
                  label="Right route"
                  value={rightRoute}
                  onChange={(event) => setRightRoute(event.target.value)}
                />
                <Button variant="contained" disabled={Boolean(busy)} onClick={() => void runDiff()}>
                  Compare sessions
                </Button>
                {diffResult && (
                  <>
                    <Alert severity="info">
                      Relationship: {diffResult.relationship.relationship}
                      {diffResult.relationship.commonSourceSessionKey
                        ? ` (${diffResult.relationship.commonSourceSessionKey})`
                        : ''}
                    </Alert>
                    <Typography variant="subtitle2">Dimension summary</Typography>
                    <Stack direction="row" gap={1} flexWrap="wrap">
                      {Object.entries(diffResult.dimensions).map(([name, dimension]) => (
                        <Chip
                          key={name}
                          label={`${name}: ${dimension.classification} (${dimension.leftCount ?? '—'} / ${dimension.rightCount ?? '—'})`}
                          size="small"
                        />
                      ))}
                    </Stack>
                    <Divider />
                    <Typography variant="subtitle2">Merged timeline</Typography>
                    <Box
                      component="pre"
                      aria-label="Merged timeline"
                      sx={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 260 }}
                    >
                      {snapshot(diffResult.timeline)}
                    </Box>
                    <Divider />
                    <Typography variant="subtitle2">Side-by-side messages</Typography>
                    {diffResult.sideBySide.map((row) => (
                      <Grid
                        container
                        spacing={1}
                        key={row.index}
                        data-classification={row.classification}
                      >
                        <Grid size={6}>
                          <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflow: 'auto' }}>
                            {snapshot(row.left)}
                          </Box>
                        </Grid>
                        <Grid size={6}>
                          <Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflow: 'auto' }}>
                            {snapshot(row.right)}
                          </Box>
                        </Grid>
                      </Grid>
                    ))}
                  </>
                )}
              </Stack>
            </Grid>
          </Grid>
        </Stack>
      </CardContent>
    </Card>
  )
}
