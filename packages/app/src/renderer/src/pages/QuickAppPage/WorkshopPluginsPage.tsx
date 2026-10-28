import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import type { LLMListProfilesResp } from '@shared/api/svcLLMProxy'
import { supportsFigPluginImageGenerationProfile } from '@shared/figplugin/imageGeneration'
import {
  FIGPLUGIN_MANAGEMENT_ERRORS,
  figPluginManagedListSchema,
  figPluginManagedMutationSchema,
  figPluginManagedPathResultSchema,
  figPluginPackagePreviewSchema,
  type FigPluginManagedList,
  type FigPluginManagedSummary,
  type FigPluginPackagePreview,
  type FigPluginManagementErrorCode
} from '@shared/figplugin/management'
import type { FigPluginCapability, FigPluginHost } from '@shared/figplugin/manifest'
import CustomWorkshopTabs from './components/CustomWorkshopTabs'
import PluginBridgePanel from './PluginBridgePanel'
import PluginExecutionHistoryPanel from './PluginExecutionHistoryPanel'
import PluginPlanningHistoryPanel from './PluginPlanningHistoryPanel'

type Profile = Pick<LLMListProfilesResp['profiles'][number], 'id' | 'model_name' | 'model_use'> & {
  generationSupported: boolean
}
type DialogState =
  | { kind: 'preview'; value: FigPluginPackagePreview }
  | { kind: 'configure' | 'remove'; value: FigPluginManagedSummary }
type Live = () => boolean
type CenterCapabilityKey = `figplugin.center.capabilities.${FigPluginCapability}`
type CenterHostKey = `figplugin.center.hosts.${'all' | FigPluginHost}`
type CenterErrorCode = FigPluginManagementErrorCode | 'UNKNOWN'
type CenterErrorKey = `figplugin.center.errors.${CenterErrorCode}`
type CenterNoticeKey =
  | 'figplugin.center.cleanupPending'
  | 'figplugin.bridge.packageFilesInstalled'
  | 'figplugin.center.notCompleted'
  | 'figplugin.bridge.profileReferencesSaved'
  | 'figplugin.center.removeComplete'
  | 'figplugin.center.copyComplete'
  | 'figplugin.center.revealComplete'

const centerCapabilityTranslationKey = (key: FigPluginCapability): CenterCapabilityKey =>
  `figplugin.center.capabilities.${key}`
const centerHostTranslationKey = (key: FigPluginHost): CenterHostKey =>
  `figplugin.center.hosts.${key}`
const centerErrorTranslationKey = (key: CenterErrorCode): CenterErrorKey =>
  `figplugin.center.errors.${key}`

const hasManagementErrorCode = (value: string): value is FigPluginManagementErrorCode =>
  Object.hasOwn(FIGPLUGIN_MANAGEMENT_ERRORS, value)

const errorCode = (error: unknown): CenterErrorCode => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    hasManagementErrorCode(error.code)
  )
    return error.code
  // Electron unary IPC commonly preserves only the message, not custom error fields.
  if (error instanceof Error) {
    for (const code of Object.keys(FIGPLUGIN_MANAGEMENT_ERRORS)) {
      if (!hasManagementErrorCode(code)) continue
      const message = FIGPLUGIN_MANAGEMENT_ERRORS[code]
      if (error.message === message || error.message.endsWith(`: ${message}`)) return code
    }
  }
  return 'UNKNOWN'
}

const discard = (receiptId: string): void => {
  // Navigation and native chooser cancellation must not leave a usable review receipt behind.
  void Promise.resolve()
    .then(() => api().svcFigPluginCenter.discardPreview({ receiptId }))
    .catch(() => {})
}

const WorkshopPluginsPage = () => {
  const { t } = useTranslation()
  const id = useId()
  const [list, setList] = useState<FigPluginManagedList | null>(null)
  const [host, setHost] = useState('all')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<CenterErrorKey | ''>('')
  const [notice, setNotice] = useState<CenterNoticeKey | ''>('')
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [expired, setExpired] = useState(false)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profilesFailed, setProfilesFailed] = useState(false)
  const [analysis, setAnalysis] = useState('')
  const [background, setBackground] = useState('')
  const [imageGeneration, setImageGeneration] = useState('')
  const [confirmName, setConfirmName] = useState('')
  const [confirmVersion, setConfirmVersion] = useState('')
  const pending = useRef(false)
  const mounted = useRef(false)
  const epoch = useRef(0)
  const receipt = useRef<FigPluginPackagePreview | null>(null)
  const operationKey = useRef('')

  const run = useCallback(async (work: (live: Live) => Promise<void>) => {
    if (!mounted.current || pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    const started = epoch.current
    const live = () => mounted.current && epoch.current === started
    try {
      await work(live)
    } catch (failure) {
      if (live()) {
        const code = errorCode(failure)
        setError(centerErrorTranslationKey(code))
        if (code === 'STALE_PREVIEW') {
          setExpired(true)
          setReviewed(false)
        }
      }
    } finally {
      if (live()) {
        pending.current = false
        setBusy(false)
      }
    }
  }, [])

  const loadList = useCallback(async (live: Live) => {
    try {
      const result = figPluginManagedListSchema.parse(
        await api().svcFigPluginCenter.listPackages({})
      )
      if (live()) setList(result)
    } catch (failure) {
      if (live()) setList(null)
      throw failure
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void run(loadList)
    return () => {
      mounted.current = false
      epoch.current += 1
      pending.current = false
      if (receipt.current) discard(receipt.current.receiptId)
      receipt.current = null
    }
  }, [loadList, run])

  const preview = dialog?.kind === 'preview' ? dialog.value : null
  useEffect(() => {
    if (!preview) return
    let timer: ReturnType<typeof setTimeout>
    const check = () => {
      const remaining = preview.expiresAt - Date.now()
      if (remaining <= 0) {
        setExpired(true)
        setReviewed(false)
      } else {
        timer = setTimeout(check, Math.min(remaining, 2_147_483_647))
      }
    }
    check()
    return () => clearTimeout(timer)
  }, [preview])

  const closeDialog = () => {
    if (receipt.current) discard(receipt.current.receiptId)
    receipt.current = null
    operationKey.current = ''
    setDialog(null)
    setReviewed(false)
    setError('')
    setNotice('')
  }

  const choose = () => {
    if (pending.current) return
    closeDialog()
    void run(async (live) => {
      const value = await api().svcFigPluginCenter.choosePackage({})
      if (value === null) return
      const parsed = figPluginPackagePreviewSchema.safeParse(value)
      if (!parsed.success) {
        const token = figPluginPackagePreviewSchema
          .pick({ receiptId: true })
          .strip()
          .safeParse(value)
        if (token.success) discard(token.data.receiptId)
        if (live()) setError('figplugin.center.errors.INVALID_PACKAGE')
        return
      }
      if (!live()) {
        discard(parsed.data.receiptId)
        return
      }
      receipt.current = parsed.data
      setExpired(parsed.data.expiresAt <= Date.now())
      setDialog({ kind: 'preview', value: parsed.data })
    })
  }

  const install = () => {
    if (!preview || !reviewed || expired || pending.current) return
    if (preview.expiresAt <= Date.now()) {
      setExpired(true)
      setReviewed(false)
      return
    }
    void run(async (live) => {
      operationKey.current ||= crypto.randomUUID()
      const result = figPluginManagedMutationSchema.parse(
        await api().svcFigPluginCenter.installPackage({
          receiptId: preview.receiptId,
          expectedGeneration: preview.expectedGeneration,
          idempotencyKey: operationKey.current
        })
      )
      if (!live()) return
      if (result.completed) {
        closeDialog()
        setNotice(
          result.cleanupPending
            ? 'figplugin.center.cleanupPending'
            : 'figplugin.bridge.packageFilesInstalled'
        )
      } else {
        operationKey.current = ''
        setNotice('figplugin.center.notCompleted')
      }
      await loadList(live)
    })
  }

  const configure = (item: FigPluginManagedSummary) => {
    if (pending.current) return
    closeDialog()
    setProfiles([])
    setProfilesFailed(false)
    setAnalysis(item.settings.analysisProfileId ?? '')
    setBackground(item.settings.backgroundRemovalProfileId ?? '')
    setImageGeneration(item.settings.imageGenerationProfileId ?? '')
    setDialog({ kind: 'configure', value: item })
    void run(async (live) => {
      try {
        const result = await api().svcLLMProxy.listProfiles({})
        // Retain only display metadata, never endpoints, runtime keys or provider configuration.
        const seen = new Set<string>()
        const choices = result.profiles
          .slice(0, 256)
          .filter((profile) => {
            if (
              typeof profile.id !== 'string' ||
              !profile.id.trim() ||
              profile.id.length > 512 ||
              typeof profile.model_name !== 'string' ||
              seen.has(profile.id)
            )
              return false
            seen.add(profile.id)
            return true
          })
          .map((profile) => ({
            id: profile.id,
            model_name: profile.model_name,
            model_use: profile.model_use,
            generationSupported: supportsFigPluginImageGenerationProfile(profile)
          }))
        if (live()) setProfiles(choices)
      } catch {
        if (live()) setProfilesFailed(true)
      }
    })
  }

  const save = () => {
    if (dialog?.kind !== 'configure') return
    const target = dialog.value
    void run(async (live) => {
      const result = figPluginManagedMutationSchema.parse(
        await api().svcFigPluginCenter.configurePackage({
          pluginId: target.pluginId,
          expectedGeneration: target.generation,
          settings: {
            ...(analysis ? { analysisProfileId: analysis } : {}),
            ...(background ? { backgroundRemovalProfileId: background } : {}),
            ...(imageGeneration ? { imageGenerationProfileId: imageGeneration } : {})
          }
        })
      )
      if (!live()) return
      if (result.completed) closeDialog()
      setNotice(
        result.completed
          ? result.cleanupPending
            ? 'figplugin.center.cleanupPending'
            : 'figplugin.bridge.profileReferencesSaved'
          : 'figplugin.center.notCompleted'
      )
      await loadList(live)
    })
  }

  const openRemove = (item: FigPluginManagedSummary) => {
    if (pending.current) return
    closeDialog()
    setConfirmName('')
    setConfirmVersion('')
    setDialog({ kind: 'remove', value: item })
  }
  const removalMatches =
    dialog?.kind === 'remove' &&
    confirmName === dialog.value.name &&
    confirmVersion === dialog.value.version
  const remove = () => {
    if (dialog?.kind !== 'remove' || !removalMatches) return
    const target = dialog.value
    void run(async (live) => {
      operationKey.current ||= crypto.randomUUID()
      const result = figPluginManagedMutationSchema.parse(
        await api().svcFigPluginCenter.removePackage({
          pluginId: target.pluginId,
          expectedGeneration: target.generation,
          idempotencyKey: operationKey.current
        })
      )
      if (!live()) return
      if (result.completed) closeDialog()
      else operationKey.current = ''
      setNotice(
        result.completed
          ? result.cleanupPending
            ? 'figplugin.center.cleanupPending'
            : 'figplugin.center.removeComplete'
          : 'figplugin.center.notCompleted'
      )
      await loadList(live)
    })
  }

  const pathAction = (item: FigPluginManagedSummary, action: 'copy' | 'reveal') => {
    if (item.materialization !== 'verified-package') return
    void run(async (live) => {
      const target = { pluginId: item.pluginId, expectedGeneration: item.generation }
      const result = figPluginManagedPathResultSchema.parse(
        await (action === 'copy'
          ? api().svcFigPluginCenter.copyPackagePath(target)
          : api().svcFigPluginCenter.revealPackage(target))
      )
      if (live())
        setNotice(
          result.completed
            ? action === 'copy'
              ? 'figplugin.center.copyComplete'
              : 'figplugin.center.revealComplete'
            : 'figplugin.center.notCompleted'
        )
    })
  }

  const capabilities = (values: FigPluginManagedSummary['capabilities']) =>
    values.map((capability, index) => (
      <Chip
        key={`${capability}-${index}`}
        size="small"
        label={t(centerCapabilityTranslationKey(capability))}
      />
    ))
  const details = (value: FigPluginManagedSummary | FigPluginPackagePreview) => (
    <Stack spacing={1} sx={{ overflowWrap: 'anywhere' }}>
      <Typography>{t('figplugin.center.packageName', { name: value.name })}</Typography>
      <Typography>{t('figplugin.center.pluginId', { id: value.pluginId })}</Typography>
      <Typography>{t('figplugin.center.version', { version: value.version })}</Typography>
      <Typography>
        {t('figplugin.center.hostValue', {
          host: t(centerHostTranslationKey(value.host))
        })}
      </Typography>
      <Typography>
        {t('figplugin.center.content', { bytes: value.contentBytes, files: value.fileCount })}
      </Typography>
      <Typography variant="subtitle2">{t('figplugin.center.permissions')}</Typography>
      <Stack direction="row" gap={1} flexWrap="wrap">
        {capabilities(value.capabilities)}
      </Stack>
      {value.signerFingerprint && (
        <Box>
          <Typography variant="subtitle2">{t('figplugin.center.fingerprint')}</Typography>
          <Typography
            component="code"
            sx={{ fontFamily: 'monospace', userSelect: 'text', wordBreak: 'break-all' }}
          >
            {value.signerFingerprint}
          </Typography>
        </Box>
      )}
      {'manifestSha256' in value && (
        <Box>
          <Typography variant="subtitle2">Manifest SHA-256</Typography>
          <Typography
            component="code"
            sx={{ fontFamily: 'monospace', userSelect: 'text', wordBreak: 'break-all' }}
          >
            {value.manifestSha256}
          </Typography>
        </Box>
      )}
    </Stack>
  )
  const profileField = (
    field: 'analysis' | 'background' | 'imageGeneration',
    value: string,
    change: (value: string) => void
  ) => {
    const candidates = profiles.filter((profile) =>
      field === 'analysis'
        ? (profile.model_use ?? 'chat') === 'chat'
        : field === 'background'
          ? profile.model_use === 'image'
          : profile.generationSupported
    )
    const unavailable = !!value && !candidates.some((profile) => profile.id === value)
    return (
      <TextField
        id={`${id}-${field}`}
        select
        fullWidth
        SelectProps={{ native: true }}
        label={t(
          field === 'analysis'
            ? 'figplugin.center.analysisProfile'
            : field === 'background'
              ? 'figplugin.center.backgroundProfile'
              : 'figplugin.center.imageGenerationProfile'
        )}
        value={value}
        onChange={(event) => change(event.target.value)}
        disabled={busy}
        helperText={
          unavailable
            ? t('figplugin.center.unavailablePreserved')
            : t('figplugin.center.optionalProfile')
        }
      >
        <option value="">{t('figplugin.center.noProfile')}</option>
        {unavailable && (
          <option value={value}>{t('figplugin.center.unavailableProfile', { id: value })}</option>
        )}
        {candidates.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {t('figplugin.center.profileOption', { name: profile.model_name, id: profile.id })}
          </option>
        ))}
      </TextField>
    )
  }
  const feedback = (
    <>
      {busy && <Typography role="status">{t('figplugin.center.busy')}</Typography>}
      {error && <Alert severity="error">{t(error)}</Alert>}
      {notice && (
        <Alert severity="info" role="status">
          {t(notice)}
        </Alert>
      )}
    </>
  )
  const items =
    list?.items.filter(
      (item) =>
        (host === 'all' || item.host === host) &&
        `${item.name} ${item.pluginId} ${item.version}`
          .toLowerCase()
          .includes(search.trim().toLowerCase())
    ) ?? []

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', bgcolor: 'background.default' }}>
      <Paper
        sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', boxShadow: 'none' }}
      >
        <CustomWorkshopTabs />
        <Stack
          component="section"
          aria-labelledby={`${id}-title`}
          spacing={2}
          sx={{ p: 3, overflow: 'auto' }}
        >
          <Typography id={`${id}-title`} variant="h5" component="h1">
            {t('figplugin.center.title')}
          </Typography>
          <Typography color="text.secondary">{t('figplugin.center.description')}</Typography>
          <Alert severity="info">
            <Typography>{t('figplugin.bridge.hostStatus')}</Typography>
            <Typography>{t('figplugin.bridge.hostGuidance')}</Typography>
          </Alert>
          <Stack direction="row" gap={2} flexWrap="wrap" aria-busy={busy}>
            <TextField
              id={`${id}-host`}
              select
              SelectProps={{ native: true }}
              label={t('figplugin.center.hostFilter')}
              value={host}
              disabled={busy}
              onChange={(event) => {
                if (!pending.current) {
                  closeDialog()
                  setHost(event.target.value)
                }
              }}
            >
              <option value="all">{t('figplugin.center.hosts.all')}</option>
              <option value="figma">{t('figplugin.center.hosts.figma')}</option>
              <option value="photoshop">{t('figplugin.center.hosts.photoshop')}</option>
            </TextField>
            <TextField
              id={`${id}-search`}
              label={t('figplugin.center.search')}
              value={search}
              disabled={busy}
              onChange={(event) => {
                if (!pending.current) {
                  closeDialog()
                  setSearch(event.target.value)
                }
              }}
            />
            <Button
              disabled={busy}
              onClick={() => {
                if (!pending.current) {
                  closeDialog()
                  void run(loadList)
                }
              }}
            >
              {t('figplugin.center.refresh')}
            </Button>
            <Button variant="contained" disabled={busy} onClick={choose}>
              {t('figplugin.center.choose')}
            </Button>
          </Stack>
          {!dialog && feedback}
          {list?.truncated && <Alert severity="warning">{t('figplugin.center.truncated')}</Alert>}
          {!!list?.skippedRecords && (
            <Alert severity="warning">
              {t('figplugin.center.skipped', { count: list.skippedRecords })}
            </Alert>
          )}
          {list && !items.length && (
            <Typography>
              {t(list.items.length ? 'figplugin.center.noMatches' : 'figplugin.center.empty')}
            </Typography>
          )}
          {items.map((item, index) => (
            <Paper
              component="article"
              variant="outlined"
              key={`${item.pluginId}-${index}`}
              sx={{ p: 2 }}
              aria-label={item.name}
            >
              <Stack spacing={2}>
                <Typography variant="h6" component="h2" sx={{ overflowWrap: 'anywhere' }}>
                  {item.name}
                </Typography>
                <Stack direction="row" gap={1} flexWrap="wrap">
                  <Chip
                    label={t(
                      item.materialization === 'verified-package'
                        ? 'figplugin.center.verifiedPackage'
                        : item.materialization === 'cleanup-pending'
                          ? 'figplugin.center.removedPending'
                          : 'figplugin.center.metadataOnly'
                    )}
                  />
                  <Chip label={t('figplugin.bridge.runtimeStatus')} />
                  {item.state === 'disabled' && <Chip label={t('figplugin.center.notReady')} />}
                  <Chip
                    label={t(
                      item.configured
                        ? 'figplugin.center.configured'
                        : 'figplugin.center.unconfigured'
                    )}
                  />
                </Stack>
                {details(item)}
                {item.state === 'disabled' && (
                  <Typography color="text.secondary">
                    {t('figplugin.center.hostDisconnected')}
                  </Typography>
                )}
                {item.cleanupPending && (
                  <Alert severity="warning">{t('figplugin.center.cleanupPending')}</Alert>
                )}
                {item.materialization === 'cleanup-pending' && (
                  <Button disabled={busy} onClick={() => openRemove(item)}>
                    {t('figplugin.center.retryCleanup')}
                  </Button>
                )}
                {item.materialization === 'verified-package' && (
                  <>
                    <Typography color="text.secondary">
                      {t('figplugin.center.signatureNotice')}
                    </Typography>
                    <Stack direction="row" gap={1} flexWrap="wrap">
                      <Button disabled={busy} onClick={() => configure(item)}>
                        {t('figplugin.center.configure')}
                      </Button>
                      <Button disabled={busy} onClick={() => pathAction(item, 'copy')}>
                        {t('figplugin.center.copyPath')}
                      </Button>
                      <Button disabled={busy} onClick={() => pathAction(item, 'reveal')}>
                        {t('figplugin.center.reveal')}
                      </Button>
                      <Button disabled={busy} onClick={() => openRemove(item)}>
                        {t('figplugin.center.remove')}
                      </Button>
                    </Stack>
                  </>
                )}
              </Stack>
            </Paper>
          ))}
          <PluginBridgePanel items={list?.items ?? []} />
          <PluginPlanningHistoryPanel items={list?.items ?? []} />
          <PluginExecutionHistoryPanel items={list?.items ?? []} />
        </Stack>
      </Paper>
      <Dialog
        open={!!dialog}
        fullWidth
        maxWidth="sm"
        aria-labelledby={`${id}-dialog-title`}
        aria-describedby={`${id}-dialog-description`}
        onClose={() => {
          if (!pending.current) closeDialog()
        }}
      >
        <DialogTitle id={`${id}-dialog-title`}>
          {t(
            dialog?.kind === 'configure'
              ? 'figplugin.center.configureTitle'
              : dialog?.kind === 'remove'
                ? 'figplugin.center.removeTitle'
                : 'figplugin.center.previewTitle'
          )}
        </DialogTitle>
        <DialogContent aria-busy={busy}>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {dialog && feedback}
            {dialog && details(dialog.value)}
            <Typography id={`${id}-dialog-description`}>
              {t(
                dialog?.kind === 'configure'
                  ? 'figplugin.center.settingsNotice'
                  : dialog?.kind === 'remove'
                    ? 'figplugin.center.removeNotice'
                    : 'figplugin.center.signatureNotice'
              )}
            </Typography>
            {dialog?.kind === 'preview' && (
              <>
                <Typography>{t('figplugin.center.noExecution')}</Typography>
                <Typography>
                  {t('figplugin.center.expires', {
                    expiry: new Date(dialog.value.expiresAt).toLocaleString()
                  })}
                </Typography>
                <Typography>{t('figplugin.center.nativeConfirm')}</Typography>
                {expired && <Alert severity="warning">{t('figplugin.center.expired')}</Alert>}
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={reviewed}
                      disabled={busy || expired}
                      onChange={(event) => setReviewed(event.target.checked)}
                    />
                  }
                  label={t('figplugin.center.reviewConsent')}
                />
              </>
            )}
            {dialog?.kind === 'configure' && (
              <>
                {profilesFailed && (
                  <Alert severity="warning">{t('figplugin.center.profilesFailed')}</Alert>
                )}
                {profileField('analysis', analysis, setAnalysis)}
                {profileField('background', background, setBackground)}
                {profileField('imageGeneration', imageGeneration, setImageGeneration)}
                <Typography variant="body2">
                  {t('figplugin.center.imageGenerationProfileHelp')}
                </Typography>
              </>
            )}
            {dialog?.kind === 'remove' && (
              <>
                <Typography>{t('figplugin.center.nativeConfirm')}</Typography>
                <TextField
                  autoFocus
                  id={`${id}-confirm-name`}
                  label={t('figplugin.center.confirmName')}
                  value={confirmName}
                  disabled={busy}
                  onChange={(event) => setConfirmName(event.target.value)}
                />
                <TextField
                  id={`${id}-confirm-version`}
                  label={t('figplugin.center.confirmVersion')}
                  value={confirmVersion}
                  disabled={busy}
                  onChange={(event) => setConfirmVersion(event.target.value)}
                />
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            autoFocus={dialog?.kind !== 'remove'}
            disabled={busy}
            onClick={() => {
              if (!pending.current) closeDialog()
            }}
          >
            {t('figplugin.center.cancel')}
          </Button>
          {dialog?.kind === 'preview' && (
            <>
              {expired && (
                <Button disabled={busy} onClick={choose}>
                  {t('figplugin.center.reselect')}
                </Button>
              )}
              <Button variant="contained" disabled={busy || expired || !reviewed} onClick={install}>
                {t('figplugin.center.install')}
              </Button>
            </>
          )}
          {dialog?.kind === 'configure' && (
            <Button variant="contained" disabled={busy} onClick={save}>
              {t('figplugin.center.save')}
            </Button>
          )}
          {dialog?.kind === 'remove' && (
            <Button variant="contained" disabled={busy || !removalMatches} onClick={remove}>
              {t('figplugin.center.confirmRemove')}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default WorkshopPluginsPage
