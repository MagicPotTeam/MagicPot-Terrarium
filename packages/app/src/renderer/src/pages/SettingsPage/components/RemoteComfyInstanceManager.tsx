import {
  Add as AddIcon,
  Check as CheckIcon,
  Close as CloseIcon,
  DeleteOutline as DeleteIcon,
  EditOutlined as EditIcon,
  InfoOutlined as InfoIcon,
  Refresh as RefreshIcon
} from '@mui/icons-material'
import {
  Box,
  Button,
  Chip,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import type { ComfyInstanceProfile } from '@shared/api/svcComfyBatch'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const createInstanceId = (): string =>
  globalThis.crypto?.randomUUID?.() || `comfy-${Date.now()}-${Math.random().toString(36).slice(2)}`

export default function RemoteComfyInstanceManager() {
  const { t } = useTranslation()
  const { notifyError, notifySuccess } = useMessage()
  const [instances, setInstances] = useState<readonly ComfyInstanceProfile[]>([])
  const [showAddForm, setShowAddForm] = useState(false)
  const [name, setName] = useState('ComfyUI')
  const [origin, setOrigin] = useState('https://comfy.example.com/')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editOrigin, setEditOrigin] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setInstances(await api().svcComfyBatch.listInstances({}))
  }, [])

  useEffect(() => {
    void refresh().catch((error) => notifyError(String(error)))
  }, [notifyError, refresh])

  const addAndProbe = useCallback(async () => {
    const id = createInstanceId()
    setBusyId(id)
    try {
      await api().svcComfyBatch.putInstance({
        id,
        name: name.trim(),
        origin: origin.trim(),
        kind: 'remote',
        maxConcurrency: 1,
        enabled: true
      })
      await api().svcComfyBatch.probeInstance({ id })
      await refresh()
      setShowAddForm(false)
      setName('ComfyUI')
      setOrigin('https://comfy.example.com/')
      notifySuccess(t('environment.remote_instances.notifications.added'))
    } catch (error) {
      await api()
        .svcComfyBatch.listInstances({})
        .then((profiles) => profiles.find((profile) => profile.state.id === id))
        .then((profile) =>
          profile
            ? api().svcComfyBatch.removeInstance({
                id,
                expectedRevision: profile.revision
              })
            : undefined
        )
        .catch(() => undefined)
      notifyError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(null)
    }
  }, [name, notifyError, notifySuccess, origin, refresh, t])

  const updateInstance = useCallback(
    async (
      profile: ComfyInstanceProfile,
      patch: Partial<Pick<ComfyInstanceProfile['state'], 'enabled' | 'name' | 'origin'>>
    ) => {
      setBusyId(profile.state.id)
      try {
        await api().svcComfyBatch.updateInstance({
          id: profile.state.id,
          expectedRevision: profile.revision,
          patch
        })
        await refresh()
      } catch (error) {
        notifyError(error instanceof Error ? error.message : String(error))
      } finally {
        setBusyId(null)
      }
    },
    [notifyError, refresh]
  )

  const beginEdit = useCallback((profile: ComfyInstanceProfile) => {
    setEditingId(profile.state.id)
    setEditName(profile.state.name)
    setEditOrigin(profile.state.origin)
  }, [])

  const saveEdit = useCallback(
    async (profile: ComfyInstanceProfile) => {
      const nextName = editName.trim()
      const nextOrigin = editOrigin.trim()
      if (!nextName || !nextOrigin) return

      const patch: { name?: string; origin?: string } = {}
      if (nextName !== profile.state.name) patch.name = nextName
      if (nextOrigin !== profile.state.origin) patch.origin = nextOrigin
      if (Object.keys(patch).length > 0) await updateInstance(profile, patch)
      setEditingId(null)
    },
    [editName, editOrigin, updateInstance]
  )

  const probe = useCallback(
    async (profile: ComfyInstanceProfile) => {
      setBusyId(profile.state.id)
      try {
        await api().svcComfyBatch.probeInstance({ id: profile.state.id })
        await refresh()
        notifySuccess(
          t('environment.remote_instances.notifications.connection_ok', {
            name: profile.state.name
          })
        )
      } catch (error) {
        await refresh().catch(() => undefined)
        notifyError(error instanceof Error ? error.message : String(error))
      } finally {
        setBusyId(null)
      }
    },
    [notifyError, notifySuccess, refresh, t]
  )

  const remove = useCallback(
    async (profile: ComfyInstanceProfile) => {
      setBusyId(profile.state.id)
      try {
        await api().svcComfyBatch.removeInstance({
          id: profile.state.id,
          expectedRevision: profile.revision
        })
        await refresh()
      } catch (error) {
        notifyError(error instanceof Error ? error.message : String(error))
      } finally {
        setBusyId(null)
      }
    },
    [notifyError, refresh]
  )

  return (
    <Stack spacing={1.5}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        alignItems={{ xs: 'stretch', sm: 'center' }}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
          <InfoIcon color="info" fontSize="small" />
          <Typography variant="body2" color="text.secondary">
            {t('environment.remote_instances.description')}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Button
            size="small"
            variant={showAddForm ? 'outlined' : 'contained'}
            startIcon={showAddForm ? <CloseIcon /> : <AddIcon />}
            onClick={() => setShowAddForm((value) => !value)}
          >
            {showAddForm
              ? t('environment.remote_instances.action.cancel_add')
              : t('environment.remote_instances.action.add_instance')}
          </Button>
          <Tooltip title={t('environment.remote_instances.action.refresh_status')}>
            <span>
              <IconButton
                size="small"
                disabled={busyId !== null}
                onClick={() => void refresh()}
                aria-label={t('environment.remote_instances.action.refresh_status')}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      {showAddForm && (
        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 2,
            bgcolor: 'action.hover',
            p: 1.5
          }}
        >
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1}
            alignItems={{ xs: 'stretch', md: 'center' }}
          >
            <TextField
              size="small"
              label={t('environment.remote_instances.field.instance_name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              sx={{ width: { xs: '100%', md: 200 } }}
            />
            <TextField
              fullWidth
              size="small"
              label={t('environment.remote_instances.field.comfyui_address')}
              value={origin}
              placeholder="http://192.168.1.100:8188/"
              onChange={(event) => setOrigin(event.target.value)}
            />
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              disabled={busyId !== null || !name.trim() || !origin.trim()}
              onClick={() => void addAndProbe()}
              sx={{ whiteSpace: 'nowrap' }}
            >
              {t('environment.remote_instances.action.add_and_test')}
            </Button>
          </Stack>
        </Box>
      )}

      {instances.length === 0 ? (
        <Box
          sx={{
            border: '1px dashed',
            borderColor: 'divider',
            borderRadius: 2,
            py: 4,
            textAlign: 'center'
          }}
        >
          <Typography color="text.secondary">{t('environment.remote_instances.empty')}</Typography>
        </Box>
      ) : (
        <Stack spacing={1}>
          {instances.map((profile) => {
            const { state } = profile
            const busy = busyId === state.id
            const editing = editingId === state.id
            const online = state.health.status === 'online'

            return (
              <Box
                key={state.id}
                sx={{
                  border: '1px solid',
                  borderColor: online ? 'success.dark' : 'divider',
                  borderRadius: 2,
                  px: 1.75,
                  py: 1.5,
                  transition: 'border-color 150ms ease'
                }}
              >
                {editing ? (
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={1}
                    alignItems={{ xs: 'stretch', md: 'center' }}
                  >
                    <TextField
                      size="small"
                      label={t('environment.remote_instances.field.name')}
                      value={editName}
                      disabled={busy}
                      onChange={(event) => setEditName(event.target.value)}
                      sx={{ width: { xs: '100%', md: 200 } }}
                    />
                    <TextField
                      fullWidth
                      size="small"
                      label={t('environment.remote_instances.field.address')}
                      value={editOrigin}
                      disabled={busy}
                      onChange={(event) => setEditOrigin(event.target.value)}
                    />
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<CheckIcon />}
                      disabled={busy || !editName.trim() || !editOrigin.trim()}
                      onClick={() => void saveEdit(profile)}
                    >
                      {t('environment.remote_instances.action.save')}
                    </Button>
                    <Button
                      size="small"
                      startIcon={<CloseIcon />}
                      disabled={busy}
                      onClick={() => setEditingId(null)}
                    >
                      {t('environment.remote_instances.action.cancel')}
                    </Button>
                  </Stack>
                ) : (
                  <Stack spacing={1}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="subtitle1" fontWeight={600} noWrap>
                        {state.name}
                      </Typography>
                      <Chip
                        size="small"
                        color={online ? 'success' : 'default'}
                        label={t(`environment.remote_instances.health.${state.health.status}`)}
                      />
                      <Box sx={{ flex: 1 }} />
                      <FormControlLabel
                        sx={{ mr: 0 }}
                        control={
                          <Switch
                            size="small"
                            checked={state.enabled}
                            disabled={busy}
                            onChange={(_, checked) =>
                              void updateInstance(profile, { enabled: checked })
                            }
                          />
                        }
                        label={t('environment.remote_instances.enabled')}
                      />
                    </Stack>

                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                    >
                      {state.origin}
                    </Typography>

                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={1}
                      alignItems={{ xs: 'flex-start', sm: 'center' }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        {t('environment.remote_instances.detected_nodes', {
                          count: state.capabilities.customNodes.length
                        })}
                        {state.health.lastError ? ` · ${state.health.lastError}` : ''}
                      </Typography>
                      <Box sx={{ flex: 1 }} />
                      <Stack direction="row" spacing={0.5}>
                        <Button
                          size="small"
                          startIcon={<RefreshIcon />}
                          disabled={busy}
                          onClick={() => void probe(profile)}
                        >
                          {t('environment.remote_instances.action.test_connection')}
                        </Button>
                        <Button
                          size="small"
                          startIcon={<EditIcon />}
                          disabled={busy}
                          onClick={() => beginEdit(profile)}
                        >
                          {t('environment.remote_instances.action.edit')}
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          startIcon={<DeleteIcon />}
                          disabled={busy}
                          onClick={() => void remove(profile)}
                        >
                          {t('environment.remote_instances.action.delete')}
                        </Button>
                      </Stack>
                    </Stack>
                  </Stack>
                )}
              </Box>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}
