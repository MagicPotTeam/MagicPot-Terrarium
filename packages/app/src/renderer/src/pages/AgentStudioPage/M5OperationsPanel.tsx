import { Refresh } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Stack,
  Typography
} from '@mui/material'
import { api } from '@renderer/utils/windowUtils'
import type {
  MagicAgentPlatformDriveResource,
  MagicAgentPlatformListDrivesResp,
  MagicAgentPlatformListTriggersResp,
  MagicAgentPlatformTriggerResource
} from '@shared/api/svcMagicAgentPlatform'
import { useCallback, useEffect, useState } from 'react'

const makeKey = (prefix: string, id: string): string => `${prefix}:${id}:${Date.now().toString(36)}`

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value : fallback

const revisionOf = (resource: { revision: number }): number => resource.revision

const triggerLabel = (resource: MagicAgentPlatformTriggerResource): string => {
  const state = record(resource.state)
  return text(state.title, resource.id)
}

const triggerStatus = (resource: MagicAgentPlatformTriggerResource): string => {
  const state = record(resource.state)
  return text(state.status, state.enabled === false ? 'disabled' : 'active')
}

const driveState = (resource: MagicAgentPlatformDriveResource): Record<string, unknown> =>
  record(resource.state)

const invokeTriggerControl = async (
  action: 'enableTrigger' | 'disableTrigger' | 'pauseTrigger' | 'resumeTrigger' | 'retryTrigger',
  trigger: MagicAgentPlatformTriggerResource
): Promise<void> => {
  const svc = api().svcMagicAgentPlatform
  await svc[action]({
    triggerId: trigger.id,
    expectedTriggerRevision: revisionOf(trigger),
    idempotencyKey: makeKey(action, trigger.id),
    requestedAt: Date.now()
  })
}

export const M5OperationsPanel: React.FC = () => {
  const [triggers, setTriggers] = useState<readonly MagicAgentPlatformTriggerResource[]>([])
  const [drives, setDrives] = useState<readonly MagicAgentPlatformDriveResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const svc = api().svcMagicAgentPlatform
      const [triggerResponse, driveResponse] = await Promise.all([
        svc.listTriggers({}),
        svc.listDrives({})
      ])
      setTriggers((triggerResponse as MagicAgentPlatformListTriggersResp).triggers)
      setDrives((driveResponse as MagicAgentPlatformListDrivesResp).drives)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card data-testid="m5-operations-panel">
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Box>
              <Typography variant="h6">M5 Operations</Typography>
              <Typography variant="body2" color="text.secondary">
                Trigger controls and Drive runtime projection.
              </Typography>
            </Box>
            <Button startIcon={<Refresh />} onClick={() => void refresh()} disabled={loading}>
              Refresh
            </Button>
          </Stack>
          {error ? <Alert severity="error">{error}</Alert> : null}
          <Box>
            <Typography variant="subtitle1">Triggers</Typography>
            {loading && !triggers.length ? (
              <Typography color="text.secondary">Loading…</Typography>
            ) : null}
            {!loading && !triggers.length ? (
              <Typography color="text.secondary">No triggers.</Typography>
            ) : null}
            <Stack spacing={1} sx={{ mt: 1 }}>
              {triggers.map((trigger) => {
                const status = triggerStatus(trigger)
                const controls =
                  status === 'disabled'
                    ? ['enableTrigger']
                    : status === 'paused'
                      ? ['resumeTrigger']
                      : ['disableTrigger', 'pauseTrigger']
                return (
                  <Stack
                    key={trigger.id}
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={1}
                    alignItems={{ md: 'center' }}
                  >
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {triggerLabel(trigger)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {trigger.id}
                      </Typography>
                    </Box>
                    <Chip size="small" label={status} />
                    {controls.map((action) => (
                      <Button
                        key={action}
                        size="small"
                        variant="outlined"
                        disabled={busy === `${action}:${trigger.id}`}
                        onClick={() =>
                          void run(`${action}:${trigger.id}`, () =>
                            invokeTriggerControl(
                              action as Parameters<typeof invokeTriggerControl>[0],
                              trigger
                            )
                          )
                        }
                      >
                        {action.replace('Trigger', '')}
                      </Button>
                    ))}
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={busy === `retry:${trigger.id}`}
                      onClick={() =>
                        void run(`retry:${trigger.id}`, () =>
                          invokeTriggerControl('retryTrigger', trigger)
                        )
                      }
                    >
                      Retry
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      disabled={busy === `fire:${trigger.id}`}
                      onClick={() =>
                        void run(`fire:${trigger.id}`, async () => {
                          await api().svcMagicAgentPlatform.manualFireTrigger({
                            triggerId: trigger.id,
                            expectedTriggerRevision: revisionOf(trigger),
                            idempotencyKey: makeKey('manual-fire', trigger.id),
                            requestedAt: Date.now(),
                            occurrenceId: makeKey('occurrence', trigger.id)
                          })
                        })
                      }
                    >
                      Manual fire
                    </Button>
                  </Stack>
                )
              })}
            </Stack>
          </Box>
          <Divider />
          <Box>
            <Typography variant="subtitle1">Drives</Typography>
            {!drives.length ? <Typography color="text.secondary">No drives.</Typography> : null}
            <Stack spacing={1} sx={{ mt: 1 }}>
              {drives.map((drive) => {
                const state = driveState(drive)
                const delivery = record(state.delivery)
                const lastFailure = record(delivery.lastFailure)
                const deliveryText = delivery.deadLetteredAt
                  ? 'dead-lettered'
                  : `attempt ${String(delivery.attemptCount ?? 0)}`
                return (
                  <Stack
                    key={drive.id}
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={1}
                    alignItems={{ md: 'center' }}
                  >
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {text(state.title, drive.id)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {drive.id} · {text(state.status, 'unknown')} · priority{' '}
                        {String(state.priority ?? '—')}
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      label={deliveryText}
                      color={delivery.deadLetteredAt ? 'error' : 'default'}
                    />
                    {delivery.deadLetteredAt || lastFailure.reason ? (
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={busy === `retry-drive:${drive.id}`}
                        onClick={() =>
                          void run(`retry-drive:${drive.id}`, async () => {
                            await api().svcMagicAgentPlatform.retryDelivery({
                              driveId: drive.id,
                              expectedRevision: drive.revision,
                              retryAt: Date.now(),
                              idempotencyKey: makeKey('retry-drive', drive.id)
                            })
                          })
                        }
                      >
                        Retry delivery
                      </Button>
                    ) : null}
                    {lastFailure.reason ? (
                      <Typography variant="caption" color="error">
                        {String(lastFailure.reason)}
                      </Typography>
                    ) : null}
                  </Stack>
                )
              })}
            </Stack>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  )
}

export default M5OperationsPanel
