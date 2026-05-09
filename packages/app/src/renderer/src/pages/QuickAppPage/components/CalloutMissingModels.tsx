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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { checkRequiredModels, type MissingRequiredModel } from '../utils/qAppDependencyCheck'

type CalloutMissingModelsProps = {
  requiredModels?: QAppRequiredModel[]
}

type ModelDownloadProgress = Extract<DownloadFileProgressEvent, { type: 'progress' }>

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
  const { configUtils } = useConfig()
  const { notifySuccess, notifyError } = useMessage()
  const configUtilsRef = useRef(configUtils)
  configUtilsRef.current = configUtils
  const [missingModels, setMissingModels] = useState<MissingRequiredModel[]>([])
  const busyModelKeysRef = useRef<Set<string>>(new Set())
  const [busyModelKeys, setBusyModelKeys] = useState<Set<string>>(new Set())
  const [downloadProgressByKey, setDownloadProgressByKey] = useState<
    Record<string, ModelDownloadProgress>
  >({})

  useEffect(() => {
    if (!requiredModels || requiredModels.length === 0) {
      setMissingModels([])
      return
    }

    const checkModels = async () => {
      setMissingModels(await checkRequiredModels(requiredModels, configUtilsRef.current))
    }

    checkModels()

    const interval = setInterval(checkModels, 10_000)
    const onFocus = () => checkModels()
    window.addEventListener('focus', onFocus)

    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [requiredModels])

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

  const getModelKey = (item: MissingRequiredModel) =>
    `${item.model.baseDir ?? 'comfyui'}:${item.model.dir}:${item.model.name}`

  const addBusyModelKey = (key: string) => {
    if (busyModelKeysRef.current.has(key)) {
      return false
    }
    const next = new Set(busyModelKeysRef.current)
    next.add(key)
    busyModelKeysRef.current = next
    setBusyModelKeys(next)
    return true
  }

  const removeBusyModelKey = (key: string) => {
    const next = new Set(busyModelKeysRef.current)
    next.delete(key)
    busyModelKeysRef.current = next
    setBusyModelKeys(next)
  }

  const setDownloadProgress = (key: string, progress: ModelDownloadProgress) => {
    setDownloadProgressByKey((prev) => ({ ...prev, [key]: progress }))
  }

  const clearDownloadProgress = (key: string) => {
    setDownloadProgressByKey((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const openModelDir = async (item: MissingRequiredModel) => {
    const key = getModelKey(item)
    if (!addBusyModelKey(key)) {
      return
    }
    try {
      await api().svcShell.ensureDirectory({ path: item.dirPath })
      const openError = await api().svcShell.openPath(item.dirPath)
      if (openError) {
        notifyError(openError)
      }
    } catch (error) {
      notifyError(t('qapp.callout.open_directory_failed', { error: String(error) }))
    } finally {
      removeBusyModelKey(key)
    }
  }

  const downloadModel = async (item: MissingRequiredModel) => {
    const key = getModelKey(item)
    if (!addBusyModelKey(key)) {
      return
    }
    try {
      let result: DownloadFileResp | undefined
      await api().svcShell.downloadFileWithProgress(
        {
          url: item.model.url,
          outputDir: item.dirPath,
          filename: item.model.name
        },
        {
          onData: (event) => {
            if (event.type === 'progress') {
              setDownloadProgress(key, event)
            } else {
              result = event.result
            }
          }
        }
      )
      if (!result) {
        throw new Error('Download completed without a result')
      }
      notifySuccess(
        result.alreadyExists
          ? t('qapp.callout.model_exists')
          : t('qapp.callout.model_downloaded', { name: item.model.name })
      )
      setMissingModels((prev) => prev.filter((model) => getModelKey(model) !== key))
    } catch (error) {
      notifyError(t('qapp.callout.model_download_failed', { error: String(error) }))
    } finally {
      clearDownloadProgress(key)
      removeBusyModelKey(key)
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
          const busy = busyModelKeys.has(key)
          const downloadProgress = downloadProgressByKey[key]
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
