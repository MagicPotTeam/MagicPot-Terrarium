/* eslint-disable react/prop-types */
import {
  Box,
  Stack,
  Typography,
  CircularProgress,
  Card,
  CardContent,
  Button,
  IconButton,
  InputBase,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  alpha
} from '@mui/material'
import { useCallback, useEffect, useState, useRef, ChangeEvent, useMemo } from 'react'
import { QAppCfg } from '@shared/qApp/cfgTypes'
import type { Config } from '@shared/config/config'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { useConfig } from '@renderer/hooks/useConfig'
import { useMessage } from '@renderer/hooks/useMessage'
import {
  clearCachedQAppState,
  renameCachedQAppState,
  useQAppContext
} from '../components/QAppContext'
import { api } from '@renderer/utils/windowUtils'
import { useTranslation } from 'react-i18next'
import { extractWorkflowFromImage } from '@renderer/utils/fileUtils'
import { useLocation, useNavigate } from 'react-router-dom'
import { resolveImportedWorkflow } from '@renderer/utils/resolveImportedWorkflow'
import type { Workflow } from '@shared/comfy/types'

import whiteHu from '@renderer/assets/whitehu.png'
import purpleHu from '@renderer/assets/hu.png'
import arrowPng from '@renderer/assets/arror.png'
import arrow2Png from '@renderer/assets/arror2.png'
import { QAppDesignPopUpPanel, DesignItem } from './QAppDesignPopUpPanel'
import { useQAppDesignState } from './useQAppDesignState'
import {
  Add,
  Close,
  AddBox,
  Edit,
  DeleteOutline as DeleteOutlineIcon,
  Search as SearchIcon,
  ErrorOutline as ErrorOutlineIcon,
  FolderOpen as FolderOpenIcon,
  UploadFile as UploadFileIcon
} from '@mui/icons-material'
import { QAppMenuItem } from '@shared/api/svcQApp'
import { inferQAppCategory, normalizeQAppCategory, type QAppCategory } from '@shared/qApp/category'
import { getQAppCategoryOptions } from './qAppCategoryOptions'

// ==========================================
// 1. 样式常量（与首页 FolderButton 保持一致）
// ==========================================

const PURPLE_MAIN = '#2d2464'
const PURPLE_LIGHT = '#8b3a8f'
const SIDE_SHADOW_LIGHT = '8px 0 16px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.12)'
const SIDE_SHADOW_DARK = '8px 0 14px rgba(0,0,0,0.45), 0 8px 18px rgba(0,0,0,0.55)'

type QAppEditDraft = {
  key: string
  name: string
  category: QAppCategory
}

const getQAppBaseName = (key: string): string => key.replace(/\\/g, '/').split('/').pop() || key

const replaceQAppBaseName = (key: string, name: string): string => {
  const normalized = key.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash >= 0 ? `${normalized.slice(0, lastSlash + 1)}${name}` : name
}

const getQAppItemCategory = (app: QAppMenuItem): QAppCategory =>
  normalizeQAppCategory(app.category ?? app.manifest?.category) ?? 'image'

const getQAppDesignCategory = (
  key: string | undefined,
  cfg: QAppCfg,
  workflow: Workflow,
  category?: unknown
): QAppCategory =>
  normalizeQAppCategory(category) ??
  inferQAppCategory({
    key,
    cfg,
    workflow
  })

type QAppCfgWithHidden = QAppCfg & { isHidden?: boolean }

const QAPP_NAME_OVERRIDES: Record<string, string> = {
  Qwen_多角度相机: 'Qwen 多角度相机'
}

const fetchRemoteQAppList = async (remoteOrigin: string, config?: Config) => {
  const remoteQApp = await import('@renderer/utils/remoteQApp')
  return remoteQApp.fetchRemoteQAppList(remoteOrigin, config)
}

// ==========================================
// WorkflowCard — 与首页 FolderButton 同款卡片

// ==========================================

const WorkflowCard: React.FC<{
  app: QAppMenuItem
  onClick: () => void
  onDelete?: () => void
  onEdit?: (app: QAppMenuItem) => void
}> = ({ app, onClick, onDelete, onEdit }) => {
  const [hovered, setHovered] = useState(false)
  const label = app.name || app.key

  return (
    <Card
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      sx={(t) => ({
        position: 'relative',
        height: 150,
        cursor: 'pointer',
        borderRadius: 3,
        overflow: 'hidden',
        background: hovered
          ? t.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.08)'
            : 'rgba(0,0,0,0.04)'
          : t.palette.background.paper,
        color: t.palette.text.primary,
        border: `1px solid ${hovered ? t.palette.text.secondary : t.palette.divider}`,
        boxShadow: hovered
          ? 'none'
          : t.palette.mode === 'dark'
            ? SIDE_SHADOW_DARK
            : SIDE_SHADOW_LIGHT,
        transition:
          'transform .2s ease, box-shadow .2s ease, background .2s ease, color .2s ease, border-color .2s ease',
        '&:hover': { transform: 'translateY(-6px)' }
      })}
    >
      {/* 渲染自定义背景大图 */}
      {app.icon && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 0,
            backgroundImage: `url(${app.icon})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: hovered ? 1 : 0.6,
            transition: 'opacity 0.2s',
            '&::after': {
              content: '""',
              position: 'absolute',
              inset: 0,
              // 添加渐变遮罩以保证文字可读性
              background: hovered
                ? 'linear-gradient(to top, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0) 100%)'
                : 'linear-gradient(to top, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 100%)'
            }
          }}
        />
      )}

      {/* 右上角删除按钮：远程快应用隐藏 */}
      {!app.isRemote && onDelete && (
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          sx={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            zIndex: 2,
            opacity: hovered ? 1 : 0,
            transition: 'all .2s ease',
            color: 'error.main',
            '&:hover': {
              bgcolor: 'error.main',
              color: '#fff'
            }
          }}
        >
          <DeleteOutlineIcon sx={{ fontSize: 18 }} />
        </IconButton>
      )}
      <CardContent
        sx={{
          position: 'relative',
          zIndex: 1,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'flex-start',
          gap: 0.25,
          p: 2,
          pb: 5
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', maxWidth: '100%' }}>
          <Typography
            variant="subtitle1"
            sx={{
              fontWeight: 700,
              fontSize: 16,
              lineHeight: 1.3,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
              color: app.icon ? '#fff' : 'inherit',
              flex: '0 1 auto'
            }}
            title={label}
          >
            {label}
          </Typography>
          {!app.isRemote && onEdit && (
            <IconButton
              size="small"
              aria-label="Edit quick app"
              onMouseDown={(e) => {
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                onEdit(app)
              }}
              sx={{
                opacity: 0.6,
                transition: 'opacity .2s ease, background .2s ease',
                color: hovered ? 'rgba(255,255,255,0.85)' : 'text.secondary',
                p: '4px',
                ml: 0.5,
                flexShrink: 0,
                alignSelf: 'flex-start',
                mt: -0.25,
                '&:hover': {
                  opacity: 1,
                  bgcolor: hovered ? 'rgba(255,255,255,0.2)' : 'action.hover',
                  color: hovered ? '#fff' : 'primary.main'
                }
              }}
            >
              <Edit sx={{ fontSize: 16 }} />
            </IconButton>
          )}
        </Box>
      </CardContent>

      {/* 只有在没有自定义图标时才显示默认水印 */}
      {!app.icon && (
        <Box
          sx={{
            position: 'absolute',
            zIndex: 0,
            right: 0,
            bottom: 0,
            width: 56,
            height: 56,
            pointerEvents: 'none',
            userSelect: 'none'
          }}
        >
          <Box
            component="img"
            src={hovered ? purpleHu : whiteHu}
            alt=""
            aria-hidden
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              filter: hovered ? 'none' : 'drop-shadow(0 0 2px rgba(0,0,0,0.08))',
              opacity: hovered ? 0.3 : 0.95,
              transform: 'scale(1.3)',
              transformOrigin: 'right bottom',
              transition: 'opacity 120ms ease, filter 120ms ease'
            }}
          />
          <Box
            component="img"
            src={hovered ? arrow2Png : arrowPng}
            alt=""
            aria-hidden
            sx={{
              position: 'absolute',
              right: hovered ? 11 : 13,
              bottom: hovered ? 13 : 6,
              width: 25,
              height: 'auto',
              objectFit: 'contain',
              opacity: 0.9,
              transition: 'all 120ms ease'
            }}
          />
        </Box>
      )}
    </Card>
  )
}
const QAppDesignPanel: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { notifyError, notifyWarning } = useMessage()
  const { workflow: globalWorkflow, qAppCfg, setWorkflow, setQAppCfg } = useQAppContext()
  const { config, buildEnv, configUtils } = useConfig()
  const configRef = useRef<Config | undefined>(config)

  const [isPopUpOpen, setIsPopUpOpen] = useState(false)
  const [qAppList, setQAppList] = useState<QAppMenuItem[]>([])
  const [isLoadingList, setIsLoadingList] = useState(false)
  const [deleteQAppKey, setDeleteQAppKey] = useState<string | null>(null)
  const [editQAppDraft, setEditQAppDraft] = useState<QAppEditDraft | null>(null)
  const [designQAppKey, setDesignQAppKey] = useState<string | undefined>(undefined)
  const [designQAppCategory, setDesignQAppCategory] = useState<QAppCategory>('image')

  const openFolderHint = t('custom_workshop.qapp_folder_hint', {
    defaultValue:
      '请前往文件夹创建当前页面的快应用分类文件夹，以及将创建好的快应用移动至创建好的快应用分类文件夹'
  })

  const fileInputRef = useRef<HTMLInputElement>(null)
  const autoLoadedRouteQAppRef = useRef<string | null>(null)
  const refreshRequestIdRef = useRef(0)
  const useRemoteComfyUI = config?.use_remote_comfyui
  const remoteServerOrigin = config?.remote_llm_server_config?.server_origin

  useEffect(() => {
    configRef.current = config
  }, [config])

  const designState = useQAppDesignState(setQAppCfg, globalWorkflow, qAppCfg)
  const qAppCategoryOptions = useMemo(() => getQAppCategoryOptions(t), [t])

  const displayQAppList = useMemo(
    () =>
      qAppList.map((app) => ({
        ...app,
        name: QAPP_NAME_OVERRIDES[app.key] ?? app.name
      })),
    [qAppList]
  )

  const {
    state: { objectInfos }
  } = useComfyStatus()

  // ----------------------------------------------------------------
  // 加载列表 (核心修复：增加 silent 参数)
  // ----------------------------------------------------------------
  const refreshQAppList = useCallback(
    async (silent = false) => {
      const requestId = ++refreshRequestIdRef.current
      if (!silent) {
        setIsLoadingList(true)
      }
      try {
        const res = await api().svcQApp.listQAppCfgs({})
        if (requestId !== refreshRequestIdRef.current) {
          return
        }
        setQAppList(res.qApps)
        if (!silent) {
          setIsLoadingList(false)
        }

        // 合并远程快应用
        if (useRemoteComfyUI) {
          const remoteOrigin = remoteServerOrigin
          if (remoteOrigin) {
            fetchRemoteQAppList(remoteOrigin, configRef.current)
              .then((remoteItems) => {
                if (requestId !== refreshRequestIdRef.current) {
                  return
                }
                if (remoteItems.length > 0) {
                  setQAppList((prev) => {
                    const locals = prev.filter((p) => !p.isRemote)
                    return [...locals, ...remoteItems]
                  })
                }
              })
              .catch((e) => {
                console.error('拉取远程快应用失败', e)
              })
          }
        }
      } catch (e) {
        if (requestId !== refreshRequestIdRef.current) {
          return
        }
        console.error('加载列表失败', e)
        if (!silent) {
          setIsLoadingList(false)
        }
      }
    },
    [remoteServerOrigin, useRemoteComfyUI]
  )

  useEffect(() => {
    refreshQAppList(false)
  }, [refreshQAppList])

  // ----------------------------------------------------------------
  // 打开文件夹
  // ----------------------------------------------------------------
  const handleOpenFolder = () => {
    const dirPath = configUtils.getBuiltinQAppDir()
    if (!dirPath) {
      notifyError(t('qapp.design.err_no_qapp_dir'))
      return
    }
    api().svcShell.openPath(dirPath)
  }

  const applyImportedWorkflow = useCallback(
    async (loadedWorkflow: unknown) => {
      const resolved = await resolveImportedWorkflow(loadedWorkflow, { objectInfos })

      setWorkflow(resolved.workflow)
      setQAppCfg(resolved.cfg)
      designState.loadFromCfg(resolved.cfg)
      setDesignQAppKey(undefined)
      setDesignQAppCategory(getQAppDesignCategory(undefined, resolved.cfg, resolved.workflow))

      if (resolved.isAppMode && resolved.warnings.length > 0) {
        notifyWarning(
          `已导入 ComfyUI APP Mode 工作流，但有 ${resolved.warnings.length} 项输入未完全自动映射，可在设计器中继续调整`
        )
        console.warn('[QAppDesignPanel] APP Mode import warnings:', resolved.warnings)
      }

      setIsPopUpOpen(true)
    },
    [designState, notifyWarning, objectInfos, setQAppCfg, setWorkflow]
  )

  // ----------------------------------------------------------------
  // 智能加载
  // ----------------------------------------------------------------
  const handleUniversalFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = ''

    const isImage = file.type.startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(file.name)
    const isJson = file.type === 'application/json' || file.name.endsWith('.json')

    if (!isImage && !isJson) {
      notifyError(t('qapp.design.err_unsupported_format'))
      return
    }

    try {
      let loadedWorkflow: unknown = null

      if (isJson) {
        const text = await file.text()
        try {
          loadedWorkflow = JSON.parse(text)
        } catch {
          notifyError(t('qapp.design.err_invalid_workflow'))
          return
        }
      } else {
        const workflowData = await extractWorkflowFromImage(file)
        if (workflowData) {
          loadedWorkflow = workflowData.workflow
        } else {
          notifyError(t('qapp.design.err_extract_workflow'))
          return
        }
      }

      const resolved = await resolveImportedWorkflow(loadedWorkflow, { objectInfos })

      setWorkflow(resolved.workflow)
      setQAppCfg(resolved.cfg)
      designState.loadFromCfg(resolved.cfg)
      setDesignQAppKey(undefined)
      setDesignQAppCategory(getQAppDesignCategory(undefined, resolved.cfg, resolved.workflow))

      if (resolved.isAppMode && resolved.warnings.length > 0) {
        notifyWarning(
          `已导入 ComfyUI APP Mode 工作流，但有 ${resolved.warnings.length} 项输入未完全自动映射，可在设计器中继续调整`
        )
        console.warn('[QAppDesignPanel] APP Mode import warnings:', resolved.warnings)
      }

      setIsPopUpOpen(true)
    } catch (error) {
      console.error('Load file error:', error)
      notifyError(t('qapp.design.err_load_failed') + ': ' + String(error))
    }
  }

  const handleLoadQApp = useCallback(
    async (key: string) => {
      try {
        const res = await api().svcQApp.getQAppCfg({ key })
        setQAppCfg(res.cfg)
        setWorkflow(res.workflow)
        designState.loadFromCfg(res.cfg)
        setDesignQAppKey(key)
        setDesignQAppCategory(
          getQAppDesignCategory(key, res.cfg, res.workflow, res.manifest?.category)
        )
        setIsPopUpOpen(true)
      } catch (error) {
        notifyError(t('qapp.design.err_load_qapp'))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setQAppCfg, setWorkflow, notifyError, t, designState.loadFromCfg]
  )

  // 删除卡片
  useEffect(() => {
    const routeState = location.state as { loadQAppKey?: string } | null
    const loadQAppKey = routeState?.loadQAppKey
    if (!loadQAppKey || autoLoadedRouteQAppRef.current === loadQAppKey) {
      return
    }

    autoLoadedRouteQAppRef.current = loadQAppKey
    void handleLoadQApp(loadQAppKey)
    navigate(location.pathname, { replace: true, state: null })
  }, [handleLoadQApp, location.pathname, location.state, navigate])

  const handleDeleteQApp = useCallback(
    async (key: string) => {
      try {
        await api().svcQApp.deleteQAppCfg({ key })
        clearCachedQAppState(key)
        setQAppList((prev) => prev.filter((app) => app.key !== key))
        await refreshQAppList(true)
      } catch (error) {
        notifyError(t('qapp.design.err_delete_failed'))
      }
    },
    [refreshQAppList, notifyError, t]
  )

  // 修改卡片名称和分类
  const openEditQAppDialog = useCallback((app: QAppMenuItem) => {
    setEditQAppDraft({
      key: app.key,
      name: app.name || getQAppBaseName(app.key),
      category: getQAppItemCategory(app)
    })
  }, [])

  const handleSaveQAppDetails = useCallback(async () => {
    if (!editQAppDraft) {
      return
    }

    const trimmedName = editQAppDraft.name.trim()
    if (!trimmedName) {
      notifyError(t('qapp.design.save.error_name'))
      return
    }

    const oldKey = editQAppDraft.key
    const nextKey = replaceQAppBaseName(oldKey, trimmedName)

    try {
      const { cfg, workflow, manifest } = await api().svcQApp.getQAppCfg({ key: oldKey })
      if (nextKey !== oldKey) {
        await api().svcQApp.renameQAppCfg({ key: oldKey, name: trimmedName })
        renameCachedQAppState(oldKey, nextKey)
      } else {
        clearCachedQAppState(oldKey)
      }

      await api().svcQApp.saveQAppCfg({
        key: nextKey,
        cfg,
        workflow,
        manifest: {
          ...(manifest || {}),
          name: trimmedName,
          category: editQAppDraft.category
        }
      })

      setEditQAppDraft(null)
      await refreshQAppList(true)
    } catch (error) {
      notifyError(t('qapp.design.err_update_failed', { defaultValue: '保存快应用修改失败' }))
    }
  }, [editQAppDraft, notifyError, refreshQAppList, t])

  // ---- 按目录编排分组 ----
  const [searchQuery, setSearchQuery] = useState('')
  const categorySections = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()

    // Process original hierarchical qAppList
    // If it's a directory, it's a category. If it's a file, it goes to "Uncategorized"
    const sections: { category: string; apps: (QAppMenuItem & { name: string })[] }[] = []

    const uncategorized: (QAppMenuItem & { name: string })[] = []

    // First, process the top-level items
    for (const item of qAppList) {
      if (item.isDirectory && item.children) {
        // Collect all apps inside this category
        const apps = item.children
          .filter((child) => !child.isDirectory)
          .map((app) => ({
            ...app,
            name: QAPP_NAME_OVERRIDES[app.key] ?? app.name
          }))
          .filter(
            (app) =>
              !q || (app.name || '').toLowerCase().includes(q) || app.key.toLowerCase().includes(q)
          )

        if (apps.length > 0 || (!q && apps.length === 0)) {
          sections.push({ category: item.name, apps })
        }
      } else if (!item.isDirectory) {
        const mappedApp = {
          ...item,
          name: QAPP_NAME_OVERRIDES[item.key] ?? item.name
        }
        if (
          !q ||
          (mappedApp.name || '').toLowerCase().includes(q) ||
          mappedApp.key.toLowerCase().includes(q)
        ) {
          uncategorized.push(mappedApp)
        }
      }
    }

    if (uncategorized.length > 0) {
      sections.unshift({
        category: t('custom_workshop.category_empty', { defaultValue: '未分类' }),
        apps: uncategorized
      })
    }

    return sections
  }, [qAppList, searchQuery, t])

  return (
    <Stack spacing={0} sx={{ flex: 1, minHeight: 0, bgcolor: 'background.default' }}>
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          px: { xs: 2, sm: 3 },
          py: 3,
          scrollbarGutter: 'stable'
        }}
      >
        <Stack spacing={3} sx={{ maxWidth: 960, mx: 'auto' }}>
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: 'none' }}
            accept=".json,image/png,image/jpeg,image/webp"
            onChange={handleUniversalFile}
          />

          {/* 搜索栏 + 操作按钮 */}
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            alignItems={{ sm: 'center' }}
          >
            <Box
              sx={(theme) => ({
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 0.75,
                borderRadius: 2,
                bgcolor: alpha(theme.palette.text.primary, 0.04),
                border: `1px solid ${theme.palette.divider}`,
                transition: 'border-color .2s',
                '&:focus-within': { borderColor: theme.palette.primary.main }
              })}
            >
              <SearchIcon sx={{ fontSize: 20, color: 'text.secondary', flexShrink: 0 }} />
              <InputBase
                placeholder={t('custom_workshop.search_placeholder', {
                  defaultValue: '搜索快应用...'
                })}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                sx={{ flex: 1, fontSize: 14 }}
              />
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<UploadFileIcon sx={{ fontSize: 18 }} />}
                onClick={() => fileInputRef.current?.click()}
                sx={{
                  textTransform: 'none',
                  fontWeight: 600,
                  fontSize: 13,
                  borderRadius: 2,
                  borderColor: 'divider',
                  color: 'text.primary',
                  px: 1.5,
                  '&:hover': { borderColor: 'text.secondary', bgcolor: 'action.hover' }
                }}
              >
                {t('qapp.design.load_workflow', { defaultValue: '加载工作流' })}
              </Button>
              <IconButton
                size="small"
                aria-label={t('qapp.design.open_qapps_folder', {
                  defaultValue: 'Open qApps Folder'
                })}
                onClick={handleOpenFolder}
                sx={{ color: 'text.secondary' }}
              >
                <FolderOpenIcon sx={{ fontSize: 20 }} />
              </IconButton>
              <Tooltip title={openFolderHint} placement="top" arrow>
                <IconButton
                  size="small"
                  aria-label={t('custom_workshop.qapp_folder_hint_label', {
                    defaultValue: '查看快应用分类说明'
                  })}
                  sx={(theme) => ({
                    color: 'text.disabled',
                    border: '1px solid',
                    borderColor: alpha(theme.palette.text.primary, 0.14),
                    bgcolor: alpha(
                      theme.palette.text.primary,
                      theme.palette.mode === 'dark' ? 0.04 : 0.02
                    ),
                    '&:hover': {
                      color: 'text.secondary',
                      borderColor: alpha(theme.palette.text.primary, 0.26),
                      bgcolor: alpha(
                        theme.palette.text.primary,
                        theme.palette.mode === 'dark' ? 0.08 : 0.05
                      )
                    }
                  })}
                >
                  <ErrorOutlineIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>

          {/* 快应用列表 - 按分类显示 */}
          {isLoadingList ? (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', py: 8 }}>
              <CircularProgress size={28} />
            </Box>
          ) : categorySections.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography color="text.secondary" variant="body2">
                {searchQuery.trim()
                  ? t('custom_workshop.search_empty', { defaultValue: '没有找到匹配的快应用' })
                  : t('custom_workshop.qapp_empty', {
                      defaultValue: '还没有快应用，点击上方按钮创建或导入'
                    })}
              </Typography>
            </Box>
          ) : (
            <Stack spacing={4}>
              {categorySections.map((section) => (
                <Box key={section.category}>
                  <Typography
                    variant="h6"
                    sx={{ mb: 2, fontWeight: 700, fontSize: 16, color: 'text.primary' }}
                  >
                    {section.category}
                  </Typography>
                  {section.apps.length > 0 ? (
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: {
                          xs: 'minmax(0, 1fr)',
                          sm: 'repeat(2, minmax(0, 1fr))',
                          md: 'repeat(3, minmax(0, 1fr))'
                        },
                        gap: 1.5
                      }}
                    >
                      {section.apps.map((app) => (
                        <WorkflowCard
                          key={app.key}
                          app={app}
                          onClick={() => handleLoadQApp(app.key)}
                          onDelete={() => setDeleteQAppKey(app.key)}
                          onEdit={openEditQAppDialog}
                        />
                      ))}
                    </Box>
                  ) : (
                    <Typography color="text.secondary" variant="body2">
                      {t('custom_workshop.category_empty_apps', {
                        defaultValue: '该分类下暂无应用'
                      })}
                    </Typography>
                  )}
                </Box>
              ))}
            </Stack>
          )}
        </Stack>
      </Box>

      {globalWorkflow && (
        <QAppDesignPopUpPanel
          open={isPopUpOpen}
          onClose={() => {
            setIsPopUpOpen(false)
            refreshQAppList(true)
          }}
          workflow={globalWorkflow}
          objectInfos={objectInfos}
          config={config}
          buildEnv={buildEnv}
          initialKey={designQAppKey}
          initialName={designQAppKey ? getQAppBaseName(designQAppKey) : undefined}
          selectedCategory={designQAppCategory}
          onSelectedCategoryChange={setDesignQAppCategory}
          {...designState}
        />
      )}

      {/* 编辑快应用弹窗 */}
      <Dialog open={!!editQAppDraft} onClose={() => setEditQAppDraft(null)} maxWidth="xs" fullWidth>
        <DialogTitle>
          {t('qapp.design.edit_qapp_title', { defaultValue: '修改快应用' })}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              autoFocus
              fullWidth
              size="small"
              label={t('qapp.design.edit_qapp_name', { defaultValue: '快应用名称' })}
              value={editQAppDraft?.name ?? ''}
              onChange={(event) =>
                setEditQAppDraft((draft) =>
                  draft ? { ...draft, name: event.target.value } : draft
                )
              }
            />
            <FormControl fullWidth size="small">
              <InputLabel id="qapp-edit-category-label">
                {t('qapp.design.save.category_label', { defaultValue: '快应用分类' })}
              </InputLabel>
              <Select<QAppCategory>
                labelId="qapp-edit-category-label"
                label={t('qapp.design.save.category_label', { defaultValue: '快应用分类' })}
                value={editQAppDraft?.category ?? 'image'}
                onChange={(event) =>
                  setEditQAppDraft((draft) =>
                    draft ? { ...draft, category: event.target.value as QAppCategory } : draft
                  )
                }
              >
                {qAppCategoryOptions.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditQAppDraft(null)}>{t('project.cancel')}</Button>
          <Button
            onClick={handleSaveQAppDetails}
            disabled={!editQAppDraft?.name.trim()}
            variant="contained"
            autoFocus
          >
            {t('project.save', { defaultValue: '保存' })}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={!!deleteQAppKey} onClose={() => setDeleteQAppKey(null)}>
        <DialogTitle>{t('project.delete_title')}</DialogTitle>
        <DialogContent>
          <Typography>{t('qapp.design.delete_desc')}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteQAppKey(null)}>{t('project.cancel')}</Button>
          <Button
            onClick={async () => {
              if (deleteQAppKey) {
                const key = deleteQAppKey
                setDeleteQAppKey(null)
                await handleDeleteQApp(key)
              }
            }}
            color="error"
            autoFocus
          >
            {t('project.delete_confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
export default QAppDesignPanel
