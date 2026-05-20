import { Box, Button, Stack, Typography } from '@mui/material'
import {
  CloudDownload as CloudDownloadIcon,
  FolderOpen as FolderOpenIcon,
  OpenInNew as OpenInNewIcon
} from '@mui/icons-material'
import { useConfig } from '@renderer/hooks/useConfig'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import { DownloadFileProgressEvent, DownloadFileResp } from '@shared/api/svcShell'
import { QAppRequiredModel } from '@shared/qApp/cfgTypes'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { checkRequiredModels, type MissingRequiredModel } from '../utils/qAppDependencyCheck'

type CalloutMissingModelsProps = {
  requiredModels?: QAppRequiredModel[]
}

type ModelDownloadProgress = Extract<DownloadFileProgressEvent, { type: 'progress' }>

type ModelDownloadSnapshot = {
  busyKeys: Set<string>
  progressByKey: Record<string, ModelDownloadProgress>
  settledVersion: number
}

const modelDownloadListeners = new Set<() => void>()
const activeModelDownloads = new Map<string, Promise<DownloadFileResp>>()
let modelDownloadProgressByKey: Record<string, ModelDownloadProgress> = {}
let modelDownloadSettledVersion = 0

const getModelKey = (item: MissingRequiredModel) =>
  `${item.model.baseDir ?? 'comfyui'}:${item.model.dir}:${item.model.name}`

const getModelDownloadSnapshot = (): ModelDownloadSnapshot => ({
  busyKeys: new Set(activeModelDownloads.keys()),
  progressByKey: { ...modelDownloadProgressByKey },
  settledVersion: modelDownloadSettledVersion
})

const subscribeModelDownloads = (listener: () => void) => {
  modelDownloadListeners.add(listener)
  return () => {
    modelDownloadListeners.delete(listener)
  }
}

const emitModelDownloadChange = () => {
  modelDownloadListeners.forEach((listener) => listener())
}

const startModelDownload = (
  item: MissingRequiredModel
): { promise: Promise<DownloadFileResp>; started: boolean } => {
  const key = getModelKey(item)
  const activeDownload = activeModelDownloads.get(key)
  if (activeDownload) {
    return { promise: activeDownload, started: false }
  }

  let result: DownloadFileResp | undefined
  const promise = api()
    .svcShell.downloadFileWithProgress(
      {
        url: item.model.url,
        outputDir: item.dirPath,
        filename: item.model.name
      },
      {
        onData: (event) => {
          if (event.type === 'progress') {
            modelDownloadProgressByKey = { ...modelDownloadProgressByKey, [key]: event }
            emitModelDownloadChange()
          } else {
            result = event.result
          }
        }
      }
    )
    .then(() => {
      if (!result) {
        throw new Error('Download completed without a result')
      }
      return result
    })

  activeModelDownloads.set(key, promise)
  emitModelDownloadChange()

  void promise
    .finally(() => {
      const nextProgress = { ...modelDownloadProgressByKey }
      delete nextProgress[key]
      modelDownloadProgressByKey = nextProgress
      activeModelDownloads.delete(key)
      modelDownloadSettledVersion += 1
      emitModelDownloadChange()
    })
    .catch(() => undefined)

  return { promise, started: true }
}

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const digits = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

const formatDownloadButtonText = (progress: ModelDownloadProgress, downloadingLabel: string) => {
  const speed = `${formatBytes(progress.bytesPerSecond)}/s`
  if (progress.percent !== undefined) {
    return `${progress.percent}% | ${speed}`
  }
  return `${downloadingLabel} | ${speed}`
}

export const CalloutMissingModels = ({ requiredModels }: CalloutMissingModelsProps) => {
  const { t } = useTranslation()
  const { config, configUtils } = useConfig()
  const { notifySuccess, notifyError } = useMessage()
  const isMountedRef = useRef(false)
  const configRef = useRef(config)
  const configUtilsRef = useRef(configUtils)
  const requiredModelsRef = useRef(requiredModels)
  const refreshVersionRef = useRef(0)
  configRef.current = config
  configUtilsRef.current = configUtils
  requiredModelsRef.current = requiredModels
  const [missingModels, setMissingModels] = useState<MissingRequiredModel[]>([])
  const [downloadSnapshot, setDownloadSnapshot] = useState(getModelDownloadSnapshot)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const refreshMissingModels = useCallback(async () => {
    const refreshVersion = refreshVersionRef.current + 1
    refreshVersionRef.current = refreshVersion
    const requestRemoteMode = configRef.current.use_remote_comfyui
    const requestRequiredModels = requiredModels

    if (!requiredModels || requiredModels.length === 0) {
      if (
        isMountedRef.current &&
        refreshVersion === refreshVersionRef.current &&
        requestRequiredModels === requiredModelsRef.current
      ) {
        setMissingModels([])
      }
      return
    }

    const nextMissingModels = await checkRequiredModels(
      requiredModels,
      configUtilsRef.current,
      configRef.current
    )
    if (
      isMountedRef.current &&
      refreshVersion === refreshVersionRef.current &&
      requestRemoteMode === configRef.current.use_remote_comfyui &&
      requestRequiredModels === requiredModelsRef.current
    ) {
      setMissingModels(nextMissingModels)
    }
  }, [config.use_remote_comfyui, requiredModels])

  useEffect(() => {
    return subscribeModelDownloads(() => {
      setDownloadSnapshot(getModelDownloadSnapshot())
    })
  }, [])

  useEffect(() => {
    void refreshMissingModels()

    const interval = setInterval(() => void refreshMissingModels(), 10_000)
    const onFocus = () => void refreshMissingModels()
    window.addEventListener('focus', onFocus)

    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshMissingModels])

  useEffect(() => {
    if (downloadSnapshot.settledVersion === 0) {
      return
    }
    void refreshMissingModels()
  }, [downloadSnapshot.settledVersion, refreshMissingModels])

  if (missingModels.length === 0) {
    return null
  }

  const getUrlFileName = (url: string) => {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
    } catch {
      return ''
    }
  }

  const openModelDir = async (item: MissingRequiredModel) => {
    try {
      await api().svcShell.ensureDirectory({ path: item.dirPath })
      const openError = await api().svcShell.openPath(item.dirPath)
      if (openError) {
        notifyError(openError)
      }
    } catch (error) {
      notifyError(t('qapp.callout.open_directory_failed', { error: String(error) }))
    }
  }

  const downloadModel = async (item: MissingRequiredModel) => {
    const key = getModelKey(item)
    const { promise, started } = startModelDownload(item)
    if (!started) {
      return
    }
    try {
      const result = await promise
      if (isMountedRef.current) {
        notifySuccess(
          result.alreadyExists
            ? t('qapp.callout.model_exists')
            : t('qapp.callout.model_downloaded', { name: item.model.name })
        )
        setMissingModels((prev) => prev.filter((model) => getModelKey(model) !== key))
      }
    } catch (error) {
      if (isMountedRef.current) {
        notifyError(t('qapp.callout.model_download_failed', { error: String(error) }))
      }
    }
  }

  const amber = '#e6a117'
  const amberGlow = 'rgba(230, 161, 23, 0.15)'
  const amberBorder = 'rgba(230, 161, 23, 0.4)'

  return (
    <Box
      sx={{
        borderRadius: 2,
        border: `1px solid ${amberBorder}`,
        bgcolor: 'rgba(0,0,0,0.35)',
        boxShadow: `0 0 20px ${amberGlow}, inset 0 0 20px rgba(230,161,23,0.03)`,
        p: 2.5,
        mb: 2
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
        <CloudDownloadIcon sx={{ fontSize: 40, color: amber }} />
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>
            {t('qapp.callout.missing_models_title')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)' }}>
            {t('qapp.callout.missing_models_subtitle')}
          </Typography>
        </Box>
      </Box>

      <Stack spacing={1.5}>
        {missingModels.map((item) => {
          const { model, displayDir } = item
          const key = getModelKey(item)
          const busy = downloadSnapshot.busyKeys.has(key)
          const downloadProgress =
            downloadSnapshot.progressByKey[key] ||
            (busy
              ? ({
                  type: 'progress',
                  downloadedBytes: 0,
                  bytesPerSecond: 0
                } satisfies ModelDownloadProgress)
              : undefined)
          const progressWidth =
            downloadProgress?.percent === undefined
              ? '100%'
              : `${Math.max(4, Math.min(100, downloadProgress.percent))}%`
          const urlFileName = getUrlFileName(model.url)
          const needsRename = urlFileName && urlFileName !== model.name

          return (
            <Box
              key={key}
              sx={{
                p: 1.5,
                borderRadius: 1.5,
                bgcolor: 'rgba(255,255,255,0.04)',
                border: `1px solid ${amberBorder}`,
                boxShadow: `0 0 8px rgba(230,161,23,0.08)`,
                '&:hover': {
                  bgcolor: 'rgba(255,255,255,0.06)',
                  boxShadow: `0 0 12px ${amberGlow}`
                },
                transition: 'all 0.2s ease'
              }}
            >
              <Typography variant="subtitle2" sx={{ fontWeight: 600, color: '#fff' }}>
                {model.name}
                <Typography
                  component="span"
                  variant="caption"
                  sx={{ ml: 1, color: 'rgba(255,255,255,0.5)' }}
                >
                  ({model.size})
                </Typography>
              </Typography>

              <Typography
                variant="caption"
                sx={{ display: 'block', color: 'rgba(255,255,255,0.45)', wordBreak: 'break-all' }}
              >
                {t('qapp.callout.put_to', { dir: displayDir })}
              </Typography>

              <Stack direction="row" spacing={1} sx={{ mt: 1.25, flexWrap: 'wrap', rowGap: 1 }}>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={downloadProgress ? undefined : <CloudDownloadIcon />}
                  disabled={busy}
                  onClick={() => void downloadModel(item)}
                  sx={{
                    minWidth: downloadProgress ? 156 : undefined,
                    overflow: 'hidden',
                    position: 'relative',
                    ...(downloadProgress
                      ? {
                          '&.Mui-disabled': {
                            bgcolor: '#6f5cff',
                            color: '#fff'
                          },
                          '&::before': {
                            content: '""',
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: progressWidth,
                            bgcolor:
                              downloadProgress.percent === undefined
                                ? 'rgba(255,255,255,0.18)'
                                : 'rgba(255,255,255,0.24)',
                            transition: 'width 0.2s ease'
                          },
                          ...(downloadProgress.percent === undefined
                            ? {
                                '&::after': {
                                  animation: 'qapp-download-progress-sweep 1.2s linear infinite',
                                  bgcolor: 'rgba(255,255,255,0.12)',
                                  content: '""',
                                  inset: 0,
                                  position: 'absolute',
                                  transform: 'translateX(-100%)',
                                  width: '60%'
                                },
                                '@keyframes qapp-download-progress-sweep': {
                                  '0%': { transform: 'translateX(-100%)' },
                                  '100%': { transform: 'translateX(220%)' }
                                }
                              }
                            : {})
                        }
                      : {})
                  }}
                >
                  {downloadProgress ? (
                    <Box
                      component="span"
                      sx={{
                        fontVariantNumeric: 'tabular-nums',
                        position: 'relative',
                        whiteSpace: 'nowrap',
                        zIndex: 1
                      }}
                    >
                      {formatDownloadButtonText(downloadProgress, t('qapp.callout.downloading'))}
                    </Box>
                  ) : (
                    t('qapp.callout.download')
                  )}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<FolderOpenIcon />}
                  disabled={busy}
                  onClick={() => void openModelDir(item)}
                >
                  {t('qapp.callout.open_directory')}
                </Button>
                <Button
                  size="small"
                  variant="text"
                  startIcon={<OpenInNewIcon />}
                  onClick={() => void api().svcShell.openExternal(model.url)}
                >
                  {t('qapp.callout.open_link')}
                </Button>
              </Stack>

              {needsRename && (
                <Typography
                  variant="caption"
                  sx={{
                    display: 'block',
                    mt: 0.5,
                    color: '#e67c17',
                    fontWeight: 500
                  }}
                >
                  {t('qapp.callout.rename_model_hint')}{' '}
                  <Typography
                    component="span"
                    variant="caption"
                    sx={{ fontWeight: 700, color: amber }}
                  >
                    {model.name}
                  </Typography>
                </Typography>
              )}
            </Box>
          )
        })}
      </Stack>
    </Box>
  )
}
