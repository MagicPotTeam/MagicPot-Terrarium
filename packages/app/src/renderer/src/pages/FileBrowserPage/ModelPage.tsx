import React, { useState, useEffect, useCallback } from 'react'
import {
  Box,
  Paper,
  Button,
  Typography,
  CircularProgress,
  Menu,
  MenuItem,
  Divider,
  ListItemIcon,
  ListItemText
} from '@mui/material'
import {
  Storage as StorageIcon,
  Extension as ExtensionIcon,
  ControlCamera as ControlCameraIcon,
  Palette as PaletteIcon,
  Description as DescriptionIcon,
  ExpandMore,
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  InsertDriveFile as FileIcon,
  ContentCopy as CopyIcon,
  OpenInNew as OpenInNewIcon,
  FindInPage as RevealIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
  Terminal as TerminalIcon
} from '@mui/icons-material'
import { useTheme } from '@mui/material/styles'
import FileBrowserPannel from './FileBrowserPannel'
import { useConfig } from '@renderer/hooks/useConfig'
import whiteHu from '@renderer/assets/whitehu.png'
import { api } from '@renderer/utils/windowUtils'
import { useTranslation } from 'react-i18next'
import { DirEntry } from '@shared/api/svcHyper'

type FileType = 'checkpoint' | 'lora' | 'controlnet' | 'vae' | 'workflow'
type ExtendedFileType = FileType | 'clip' | 'diffusion_models' | 'unet' | 'upscale_models'

interface ModelPageProps {
  compact?: boolean
}

// ─── 右键菜单样式 ───
const contextMenuSx = {
  '& .MuiPaper-root': {
    minWidth: 200,
    borderRadius: '6px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
    '& .MuiMenuItem-root': {
      fontSize: 13,
      minHeight: 30,
      py: 0.5,
      px: 1.5,
      '& .MuiListItemIcon-root': {
        minWidth: 28
      }
    },
    '& .MuiDivider-root': {
      my: 0.5
    }
  }
}

// ─── 递归文件树节点（compact 模式用） ───
const TreeNode: React.FC<{ entry: DirEntry; depth: number }> = ({ entry, depth }) => {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{ mouseX: number; mouseY: number } | null>(null)

  const loadChildren = useCallback(async () => {
    if (!entry.isDirectory || loaded || loading) return
    setLoading(true)
    try {
      const result = await api().svcHyper.listDirShallow({ dir: entry.path })
      setChildren(result.entries)
    } catch (err) {
      console.error('[Explorer] listDirShallow error:', err)
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [entry.path, entry.isDirectory, loaded, loading])

  const handleClick = () => {
    if (entry.isDirectory) {
      const newExpanded = !expanded
      setExpanded(newExpanded)
      if (newExpanded && !loaded) {
        loadChildren()
      }
    } else {
      // 点击文件 → 在系统管理器中显示
      api().svcShell.showItemInFolder(entry.path)
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ mouseX: e.clientX, mouseY: e.clientY })
  }

  const closeMenu = () => setContextMenu(null)

  // ─── 菜单操作 ───
  const handleRevealInExplorer = () => {
    closeMenu()
    if (entry.isDirectory) {
      api().svcShell.openPath(entry.path)
    } else {
      api().svcShell.showItemInFolder(entry.path)
    }
  }

  const handleCopyPath = () => {
    closeMenu()
    navigator.clipboard.writeText(entry.path)
  }

  const handleCopyName = () => {
    closeMenu()
    navigator.clipboard.writeText(entry.name)
  }

  const handleRefresh = async () => {
    closeMenu()
    if (entry.isDirectory) {
      setLoading(true)
      try {
        const result = await api().svcHyper.listDirShallow({ dir: entry.path })
        setChildren(result.entries)
        setLoaded(true)
      } catch (err) {
        console.error('[Explorer] refresh error:', err)
      } finally {
        setLoading(false)
      }
    }
  }

  const handleOpenFolder = () => {
    closeMenu()
    api().svcShell.openPath(
      entry.isDirectory ? entry.path : entry.path.replace(/[\\/][^\\/]+$/, '')
    )
  }

  // 格式化文件大小
  const formatSize = (bytes?: number) => {
    if (!bytes) return ''
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
  }

  const indent = 12 + depth * 16 // VS Code 风格缩进

  return (
    <>
      <Box
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        sx={(theme) => ({
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          pl: `${indent}px`,
          pr: 1,
          py: 0.1,
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: 13,
          lineHeight: '22px',
          minHeight: 22,
          color: theme.palette.text.secondary,
          '&:hover': {
            backgroundColor:
              theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            color: theme.palette.text.primary
          }
        })}
      >
        {/* 箭头（仅目录） */}
        {entry.isDirectory ? (
          expanded ? (
            <ExpandMore sx={{ fontSize: 16, opacity: 0.6, flexShrink: 0 }} />
          ) : (
            <ChevronRight sx={{ fontSize: 16, opacity: 0.6, flexShrink: 0 }} />
          )
        ) : (
          <Box sx={{ width: 16, flexShrink: 0 }} /> // 占位
        )}

        {/* 图标 */}
        {entry.isDirectory ? (
          expanded ? (
            <FolderOpenIcon sx={{ fontSize: 16, color: '#dcb67a', flexShrink: 0, mr: 0.5 }} />
          ) : (
            <FolderIcon sx={{ fontSize: 16, color: '#dcb67a', flexShrink: 0, mr: 0.5 }} />
          )
        ) : (
          <FileIcon sx={{ fontSize: 16, opacity: 0.5, flexShrink: 0, mr: 0.5 }} />
        )}

        {/* 文件名 */}
        <Typography
          component="span"
          sx={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 13,
            lineHeight: '22px'
          }}
        >
          {entry.name}
        </Typography>

        {/* 文件大小 */}
        {!entry.isDirectory && entry.size != null && entry.size > 0 && (
          <Typography component="span" sx={{ fontSize: 10, opacity: 0.4, flexShrink: 0, ml: 0.5 }}>
            {formatSize(entry.size)}
          </Typography>
        )}

        {/* 加载中 */}
        {loading && <CircularProgress size={10} sx={{ flexShrink: 0, ml: 0.5 }} />}
      </Box>

      {/* ─── 右键菜单 ─── */}
      <Menu
        open={contextMenu !== null}
        onClose={closeMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined
        }
        sx={contextMenuSx}
      >
        {/* 在文件资源管理器中显示 */}
        <MenuItem onClick={handleRevealInExplorer}>
          <ListItemIcon>
            <RevealIcon sx={{ fontSize: 16 }} />
          </ListItemIcon>
          <ListItemText>在文件资源管理器中显示</ListItemText>
        </MenuItem>

        {/* 打开所在文件夹 (文件时) */}
        {!entry.isDirectory && (
          <MenuItem onClick={handleOpenFolder}>
            <ListItemIcon>
              <FolderOpenIcon sx={{ fontSize: 16 }} />
            </ListItemIcon>
            <ListItemText>打开所在文件夹</ListItemText>
          </MenuItem>
        )}

        <Divider />

        {/* 复制路径 */}
        <MenuItem onClick={handleCopyPath}>
          <ListItemIcon>
            <CopyIcon sx={{ fontSize: 16 }} />
          </ListItemIcon>
          <ListItemText>复制路径</ListItemText>
        </MenuItem>

        {/* 复制文件名 */}
        <MenuItem onClick={handleCopyName}>
          <ListItemIcon>
            <CopyIcon sx={{ fontSize: 16 }} />
          </ListItemIcon>
          <ListItemText>复制文件名</ListItemText>
        </MenuItem>

        {/* 目录专属：刷新 */}
        {entry.isDirectory && (
          <>
            <Divider />
            <MenuItem onClick={handleRefresh}>
              <ListItemIcon>
                <RefreshIcon sx={{ fontSize: 16 }} />
              </ListItemIcon>
              <ListItemText>刷新</ListItemText>
            </MenuItem>
          </>
        )}
      </Menu>

      {/* 子节点 */}
      {expanded &&
        loaded &&
        children.map((child) => <TreeNode key={child.path} entry={child} depth={depth + 1} />)}
    </>
  )
}

// ─── 文件树根节点（compact 模式用） ───
const FileTreeRoot: React.FC<{ rootDir: string; rootLabel: string }> = ({ rootDir, rootLabel }) => {
  const [expanded, setExpanded] = useState(true)
  const [children, setChildren] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!rootDir || loaded || loading) return
    setLoading(true)
    api()
      .svcHyper.listDirShallow({ dir: rootDir })
      .then((result) => setChildren(result.entries))
      .catch((err) => console.error('[Explorer] listDirShallow root error:', err))
      .finally(() => {
        setLoading(false)
        setLoaded(true)
      })
  }, [rootDir]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Box>
      {/* 根标题 */}
      <Box
        onClick={() => setExpanded(!expanded)}
        sx={(theme) => ({
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          pl: 0.5,
          pr: 1,
          py: 0.25,
          cursor: 'pointer',
          userSelect: 'none',
          fontWeight: 700,
          fontSize: 11,
          lineHeight: '22px',
          minHeight: 22,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: theme.palette.text.secondary,
          '&:hover': {
            backgroundColor:
              theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'
          }
        })}
      >
        {expanded ? (
          <ExpandMore sx={{ fontSize: 16, opacity: 0.6 }} />
        ) : (
          <ChevronRight sx={{ fontSize: 16, opacity: 0.6 }} />
        )}
        <Typography
          component="span"
          sx={{ fontWeight: 700, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' }}
        >
          {rootLabel}
        </Typography>
        {loading && <CircularProgress size={10} sx={{ ml: 1 }} />}
      </Box>

      {/* 树内容 */}
      {expanded &&
        loaded &&
        children.map((child) => <TreeNode key={child.path} entry={child} depth={0} />)}
    </Box>
  )
}

// ─── 主组件 ───
const ModelPage: React.FC<ModelPageProps> = ({ compact = false }) => {
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const { t } = useTranslation()
  const { configUtils } = useConfig()

  const sections = [
    {
      value: 'checkpoint' as ExtendedFileType,
      label: t('model.tabs.models'),
      icon: <StorageIcon sx={{ fontSize: 14 }} />,
      getDirPath: () => configUtils.getCheckpointsDir(),
      exts: ['.safetensors', '.ckpt']
    },
    {
      value: 'clip' as ExtendedFileType,
      label: t('model.tabs.clip'),
      icon: <ExtensionIcon sx={{ fontSize: 14 }} />,
      getDirPath: () => configUtils.getClipDir(),
      exts: ['.safetensors', '.bin', '.pt']
    },
    {
      value: 'lora' as ExtendedFileType,
      label: t('model.tabs.lora'),
      icon: <ExtensionIcon sx={{ fontSize: 14 }} />,
      getDirPath: () => configUtils.getLoraDir(),
      exts: ['.pt', '.safetensors', '.ckpt']
    },
    {
      value: 'controlnet' as ExtendedFileType,
      label: t('model.tabs.controlnet'),
      icon: <ControlCameraIcon sx={{ fontSize: 14 }} />,
      getDirPath: () => configUtils.getControlnetDir(),
      exts: ['.safetensors', '.ckpt']
    },
    {
      value: 'diffusion_models' as ExtendedFileType,
      label: t('model.tabs.diffusion_models'),
      icon: <StorageIcon sx={{ fontSize: 14 }} />,
      getDirPath: () => configUtils.getDiffusionModelsDir(),
      exts: ['.safetensors', '.ckpt', '.pt']
    },
    {
      value: 'unet' as ExtendedFileType,
      label: t('model.tabs.unet'),
      icon: <StorageIcon sx={{ fontSize: 14 }} />,
      getDirPath: () => configUtils.getUNetDir(),
      exts: ['.safetensors', '.ckpt', '.pt']
    },
    {
      value: 'vae' as ExtendedFileType,
      label: t('model.tabs.vae'),
      icon: <PaletteIcon sx={{ fontSize: 14 }} />,
      getDirPath: () => configUtils.getVAEDir(),
      exts: ['.safetensors']
    },
    {
      value: 'upscale_models' as ExtendedFileType,
      label: t('model.tabs.upscale_models'),
      icon: <StorageIcon sx={{ fontSize: 14 }} />,
      getDirPath: () => configUtils.getUpscaleModelsDir(),
      exts: ['.pth', '.pt', '.bin', '.safetensors']
    },
    {
      value: 'workflow' as ExtendedFileType,
      label: t('model.tabs.workflow'),
      icon: <DescriptionIcon sx={{ fontSize: 14 }} />,
      getDirPath: () => configUtils.getWorkflowDir(),
      exts: ['.json']
    }
  ]

  const [currentTab, setCurrentTab] = useState<ExtendedFileType>('checkpoint')
  const PILL_3D_SHADOW = '8px 0 10px rgba(0,0,0,0.04), 0 8px 10px rgba(0,0,0,0.04)'
  const currentTabInfo = sections.find((t) => t.value === currentTab)

  // ─── compact 模式：VS Code 风格文件树 ───
  if (compact) {
    const [comfyDir] = configUtils.getComfyUIDir()
    // 获取目录名作为根标签
    const dirName = comfyDir
      ? comfyDir.split(/[\\/]/).filter(Boolean).pop() || 'ComfyUI'
      : 'ComfyUI'

    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          {comfyDir ? (
            <FileTreeRoot rootDir={comfyDir} rootLabel={dirName} />
          ) : (
            <Typography variant="caption" sx={{ p: 2, opacity: 0.5, display: 'block' }}>
              ComfyUI 目录未设置
            </Typography>
          )}
        </Box>
      </Box>
    )
  }

  // ─── 全屏模式：原有布局 ───

  return (
    <Box
      sx={(t) => ({
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        bgcolor: isLight ? '#e7e9f5' : t.palette.background.default
      })}
    >
      {/* 上部内容（80%） */}
      <Paper
        sx={{
          flex: '0 0 80%',
          m: 2,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          bgcolor: isLight ? '#d1d2e6' : undefined
        }}
      >
        <Box sx={{ px: 2, pt: 2 }}>
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'row',
              gap: 1.5,
              overflowX: 'auto',
              whiteSpace: 'nowrap',
              pb: 2
            }}
          >
            {sections.map((t) => {
              const selected = currentTab === t.value
              return (
                <Button
                  key={t.value}
                  onClick={() => setCurrentTab(t.value)}
                  disableElevation
                  startIcon={t.icon}
                  sx={{
                    display: 'inline-flex',
                    width: 120,
                    minWidth: 120,
                    borderRadius: 1,
                    textTransform: 'none',
                    fontSize: '1rem',
                    fontWeight: 500,
                    py: 0.4,
                    px: 2,
                    boxShadow: PILL_3D_SHADOW,
                    color: selected ? '#fff' : isLight ? '#7a7a81ff' : '#808694',
                    bgcolor: selected ? '#7d72fc' : isLight ? '#efeff7' : '#2a2a2a',
                    '&:hover': {
                      transform: 'none',
                      bgcolor: selected ? '#7369f0' : isLight ? '#e8e7f4' : '#333333'
                    },
                    '& .MuiSvgIcon-root': {
                      fontSize: 18
                    }
                  }}
                >
                  {t.label}
                </Button>
              )
            })}
          </Box>
          <Box sx={{ borderBottom: `1px solid ${isLight ? '#c1c2d6' : '#333333'}` }} />
        </Box>

        <FileBrowserPannel
          label={currentTabInfo?.label ?? ''}
          dirPath={currentTabInfo?.getDirPath() ?? ''}
          exts={currentTabInfo?.exts}
          showFooter={false}
        />
      </Paper>

      {/* 下部（20%） */}
      <Box
        sx={{
          flex: '1 1 20%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          px: 3,
          mt: -4
        }}
      >
        <Button
          variant="contained"
          color="inherit"
          size="large"
          onClick={() => {
            const dir = currentTabInfo?.getDirPath() ?? ''
            if (!dir) return
            api().svcShell.openPath(dir)
          }}
          sx={{
            position: 'relative',
            bgcolor: '#7e73fd',
            color: '#fff',
            '&:hover': { bgcolor: '#7369f0' },
            overflow: 'hidden',
            borderRadius: 3,
            px: 8,
            py: 2,
            minWidth: 240,
            fontSize: '1.25rem',
            fontWeight: 550,
            boxShadow: '8px 0 10px rgba(0,0,0,0.04), 0 8px 10px rgba(0,0,0,0.04)'
          }}
        >
          {t('model.open_folder')}
          <Box
            component="img"
            src={whiteHu}
            alt=""
            aria-hidden
            sx={{
              position: 'absolute',
              right: -8,
              top: '60%',
              transform: 'translateY(-50%)',
              width: 60,
              height: 60,
              mixBlendMode: 'normal',
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.28))',
              pointerEvents: 'none',
              userSelect: 'none'
            }}
          />
        </Button>
      </Box>
    </Box>
  )
}

export default ModelPage
