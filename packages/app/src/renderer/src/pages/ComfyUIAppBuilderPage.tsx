/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography
} from '@mui/material'
import {
  ArrowBack as ArrowBackIcon,
  ArrowForward as ArrowForwardIcon,
  Home as HomeIcon,
  OpenInNew as OpenInNewIcon,
  PlayArrow as PlayArrowIcon,
  Refresh as RefreshIcon,
  Settings as SettingsIcon,
  Terminal as TerminalIcon
} from '@mui/icons-material'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@mui/material/styles'
import { useConfig } from '@renderer/hooks/useConfig'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { useComfyProcess } from '@renderer/store/hooks/comfyProcess'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { openTab, setActiveTab } from '@renderer/store/slices/layoutSlice'

interface WebViewRef {
  reload: () => void
  goBack: () => void
  goForward: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  getURL: () => string
  loadURL: (url: string) => void
}

const sameOrigin = (left: string, right: string): boolean => {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

const ComfyUIAppBuilderPage: React.FC = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const openTabs = useAppSelector((state) => state.layout.openTabs)
  const { notifyError } = useMessage()
  const { config, configUtils } = useConfig()
  const { state: comfyProcess, setPid, setIsRunning, addOutput } = useComfyProcess()
  const webviewRef = useRef<HTMLWebViewElement | null>(null)
  const [currentUrl, setCurrentUrl] = useState(
    () => configUtils.getComfyUIOrigin() || 'about:blank'
  )
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const comfyOrigin = configUtils.getComfyUIOrigin()
  const isRemoteComfyUI = config.use_remote_comfyui
  const hasConfiguredOrigin =
    !isRemoteComfyUI || config.remote_comfyui_config.comfyui_origin.trim() !== ''
  const canStartLocalComfyUI = !isRemoteComfyUI && configUtils.isComfyUICommandAvailable()

  const openRouteTab = useCallback(
    (id: string, label: string, routePath: string) => {
      const has = openTabs.some((tab) => tab.id === id)
      if (has) {
        dispatch(setActiveTab(id))
      } else {
        dispatch(openTab({ id, label, routePath, closable: true }))
      }
      navigate(routePath)
    },
    [dispatch, navigate, openTabs]
  )

  const updateNavigationState = useCallback(() => {
    const webview = webviewRef.current as unknown as WebViewRef | null
    if (!webview) return
    setCurrentUrl(webview.getURL())
    setCanGoBack(webview.canGoBack())
    setCanGoForward(webview.canGoForward())
  }, [])

  const loadHome = useCallback(() => {
    const target = comfyOrigin || 'about:blank'
    setCurrentUrl(target)
    setLoadError(null)
    const webview = webviewRef.current as unknown as WebViewRef | null
    webview?.loadURL(target)
  }, [comfyOrigin])

  const handleOpenExternal = useCallback(async () => {
    if (!comfyOrigin) return
    await api().svcShell.openExternal(comfyOrigin)
  }, [comfyOrigin])

  const handleOpenServerPage = useCallback(() => {
    openRouteTab('tab-comfyui', t('menu.comfyui'), '/comfyui')
  }, [openRouteTab, t])

  const handleOpenSettings = useCallback(() => {
    openRouteTab('tab-settings', t('menu.settings'), '/settings')
  }, [openRouteTab, t])

  const handleStartLocalComfyUI = useCallback(async () => {
    if (!canStartLocalComfyUI) {
      notifyError(t('comfyui_builder.local_setup_missing'))
      return
    }

    try {
      const { pid } = await api().svcHyper.comfyPortDetect({})
      if (pid !== 0) {
        setPid(pid)
        window.dispatchEvent(new CustomEvent('comfyui:ready'))
        loadHome()
        return
      }

      setIsRunning(true)
      addOutput(t('terminal.starting_server'))

      await api().svcHyper.startComfyUI(
        {},
        {
          onData: (data) => {
            if (data.pid !== 0) {
              setPid(data.pid)
            }

            if (data.logLine?.includes('To see the GUI go to')) {
              window.dispatchEvent(new CustomEvent('comfyui:ready'))
            }
          }
        }
      )
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : isServerStreamingError(error)
            ? error.message
            : String(error)
      notifyError(`${t('comfyui_builder.start_failed')}: ${message}`)
    } finally {
      setIsRunning(false)
    }
  }, [addOutput, canStartLocalComfyUI, loadHome, notifyError, setIsRunning, setPid, t])

  useEffect(() => {
    setCurrentUrl(comfyOrigin || 'about:blank')
    setLoadError(null)
  }, [comfyOrigin])

  useEffect(() => {
    const handleReady = () => {
      setLoadError(null)
      setTimeout(() => {
        loadHome()
      }, 300)
    }

    window.addEventListener('comfyui:ready', handleReady)
    return () => {
      window.removeEventListener('comfyui:ready', handleReady)
    }
  }, [loadHome])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const handleDidNavigate = () => {
      updateNavigationState()
    }

    const handleDidStartLoading = () => {
      setIsLoading(true)
      setLoadError(null)
    }

    const handleDidStopLoading = () => {
      setIsLoading(false)
      updateNavigationState()
    }

    const handleDidFailLoad = (event: any) => {
      if (event?.errorCode === -3 || event?.isMainFrame === false) {
        return
      }

      setIsLoading(false)
      setLoadError(
        isRemoteComfyUI
          ? t('comfyui_builder.load_failed_remote')
          : canStartLocalComfyUI
            ? t('comfyui_builder.load_failed_local')
            : t('comfyui_builder.local_setup_missing')
      )
    }

    const handleWillNavigate = (event: any) => {
      if (!comfyOrigin || sameOrigin(event.url, comfyOrigin)) {
        return
      }

      event.preventDefault?.()
      void api().svcShell.openExternal(event.url)
    }

    const handleNewWindow = (event: any) => {
      event.preventDefault?.()

      if (comfyOrigin && sameOrigin(event.url, comfyOrigin)) {
        const view = webview as unknown as WebViewRef
        view.loadURL(event.url)
        return
      }

      void api().svcShell.openExternal(event.url)
    }

    webview.addEventListener('did-navigate', handleDidNavigate)
    webview.addEventListener('did-navigate-in-page', handleDidNavigate)
    webview.addEventListener('did-start-loading', handleDidStartLoading)
    webview.addEventListener('did-stop-loading', handleDidStopLoading)
    webview.addEventListener('did-fail-load', handleDidFailLoad)
    webview.addEventListener('will-navigate', handleWillNavigate)
    webview.addEventListener('new-window', handleNewWindow)

    return () => {
      webview.removeEventListener('did-navigate', handleDidNavigate)
      webview.removeEventListener('did-navigate-in-page', handleDidNavigate)
      webview.removeEventListener('did-start-loading', handleDidStartLoading)
      webview.removeEventListener('did-stop-loading', handleDidStopLoading)
      webview.removeEventListener('did-fail-load', handleDidFailLoad)
      webview.removeEventListener('will-navigate', handleWillNavigate)
      webview.removeEventListener('new-window', handleNewWindow)
    }
  }, [canStartLocalComfyUI, comfyOrigin, isRemoteComfyUI, t, updateNavigationState])

  return (
    <Box sx={{ height: '100%', display: 'flex', bgcolor: 'background.default' }}>
      <Paper
        sx={{
          flex: 1,
          m: 2,
          p: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          minHeight: 0
        }}
      >
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', md: 'center' }}
        >
          <Box>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              {t('comfyui_builder.title')}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {t('comfyui_builder.subtitle')}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1.25, flexWrap: 'wrap', rowGap: 1 }}>
              <Chip
                size="small"
                color={isRemoteComfyUI ? 'info' : 'primary'}
                label={t(
                  isRemoteComfyUI ? 'comfyui_builder.mode_remote' : 'comfyui_builder.mode_local'
                )}
              />
              <Chip size="small" variant="outlined" label={comfyOrigin || 'about:blank'} />
            </Stack>
          </Box>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {!isRemoteComfyUI && (
              <Button
                variant="contained"
                startIcon={<PlayArrowIcon />}
                onClick={handleStartLocalComfyUI}
                disabled={!canStartLocalComfyUI || comfyProcess.isRunning}
              >
                {t('comfyui_builder.start_local')}
              </Button>
            )}
            <Button variant="outlined" startIcon={<TerminalIcon />} onClick={handleOpenServerPage}>
              {t('comfyui_builder.manage_server')}
            </Button>
            <Button variant="outlined" startIcon={<OpenInNewIcon />} onClick={handleOpenExternal}>
              {t('comfyui_builder.open_external')}
            </Button>
          </Stack>
        </Stack>

        <Alert severity="info">
          <AlertTitle>{t('comfyui_builder.guide_title')}</AlertTitle>
          <Typography variant="body2">{t('comfyui_builder.guide_intro')}</Typography>
          <Typography variant="body2">{t('comfyui_builder.guide_step_enter')}</Typography>
          <Typography variant="body2">{t('comfyui_builder.guide_step_build')}</Typography>
          <Typography variant="body2">{t('comfyui_builder.guide_step_save')}</Typography>
          <Typography variant="body2">{t('comfyui_builder.guide_step_sync')}</Typography>
        </Alert>

        {!hasConfiguredOrigin && (
          <Alert
            severity="warning"
            action={
              <Button
                color="inherit"
                size="small"
                startIcon={<SettingsIcon />}
                onClick={handleOpenSettings}
              >
                {t('comfyui_builder.open_settings')}
              </Button>
            }
          >
            <AlertTitle>{t('comfyui_builder.missing_origin')}</AlertTitle>
            <Typography variant="body2">
              {t('environment.err_remote_comfyui_origin_required')}
            </Typography>
          </Alert>
        )}

        {loadError && hasConfiguredOrigin && (
          <Alert severity="warning">
            <AlertTitle>{t('comfyui_builder.load_error_title')}</AlertTitle>
            <Typography variant="body2">{loadError}</Typography>
          </Alert>
        )}

        <Paper
          variant="outlined"
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{ px: 1, py: 0.75, borderBottom: 1, borderColor: 'divider' }}
          >
            <Tooltip title={t('comfyui_builder.go_back')}>
              <span>
                <IconButton
                  size="small"
                  onClick={() => (webviewRef.current as unknown as WebViewRef | null)?.goBack()}
                  disabled={!canGoBack}
                >
                  <ArrowBackIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t('comfyui_builder.go_forward')}>
              <span>
                <IconButton
                  size="small"
                  onClick={() => (webviewRef.current as unknown as WebViewRef | null)?.goForward()}
                  disabled={!canGoForward}
                >
                  <ArrowForwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t('comfyui_builder.go_home')}>
              <IconButton size="small" onClick={loadHome}>
                <HomeIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t('comfyui_builder.refresh')}>
              <IconButton
                size="small"
                onClick={() => (webviewRef.current as unknown as WebViewRef | null)?.reload()}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{
                ml: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {currentUrl}
            </Typography>
          </Stack>

          <Box
            sx={{
              position: 'relative',
              flex: 1,
              minHeight: 0,
              bgcolor: isLight ? '#eef1f9' : '#101114'
            }}
          >
            {hasConfiguredOrigin ? (
              <webview
                key={comfyOrigin || 'about:blank'}
                ref={webviewRef}
                src={currentUrl || 'about:blank'}
                style={{ width: '100%', height: '100%', border: 'none' }}
              />
            ) : (
              <Stack
                spacing={2}
                alignItems="center"
                justifyContent="center"
                sx={{ width: '100%', height: '100%', px: 3, textAlign: 'center' }}
              >
                <Typography variant="h6" sx={{ color: 'text.primary' }}>
                  {t('comfyui_builder.missing_origin')}
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<SettingsIcon />}
                  onClick={handleOpenSettings}
                >
                  {t('comfyui_builder.open_settings')}
                </Button>
              </Stack>
            )}

            {isLoading && hasConfiguredOrigin && (
              <Stack
                spacing={1}
                alignItems="center"
                justifyContent="center"
                sx={{
                  position: 'absolute',
                  inset: 0,
                  bgcolor: isLight ? 'rgba(238, 241, 249, 0.78)' : 'rgba(10, 12, 18, 0.45)',
                  pointerEvents: 'none'
                }}
              >
                <CircularProgress size={28} />
                <Typography variant="body2" sx={{ color: 'text.primary' }}>
                  {t('comfyui_builder.status_loading')}
                </Typography>
              </Stack>
            )}
          </Box>
        </Paper>
      </Paper>
    </Box>
  )
}

export default ComfyUIAppBuilderPage
