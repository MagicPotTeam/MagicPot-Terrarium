// AIEngineElectron/packages/app/src/renderer/src/pages/FileBrowserPage/FileBrowserPannel.tsx
import React, { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  Button,
  Stack,
  TextField,
  InputAdornment
} from '@mui/material'
import {
  FolderOpen as FolderOpenIcon,
  Storage as StorageIcon,
  Search as SearchIcon
} from '@mui/icons-material'
import { useTheme } from '@mui/material/styles'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import { FileInfo, ListComfyFilesResp } from '@shared/api/svcHyper'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { MESSAGE_COMFYUI_DIR_NOT_SET } from '@shared/config/messageConst'

// 与 MainPage 一致的 3D 阴影
const CARD_3D_SHADOW = '8px 0 16px rgba(0,0,0,0.04), 0 8px 16px rgba(0,0,0,0.04)'

export type FileBrowserPannelProps = {
  label: string
  dirPath: string
  exts?: string[]
  itemMinHeight?: number
  /** 是否显示底部统计与“打开文件夹”按钮（默认：true） */
  showFooter?: boolean
}

type FileOrDir = FileInfo & { isDir?: boolean }

const FileBrowserPannel: React.FC<FileBrowserPannelProps> = ({
  label,
  dirPath,
  exts,
  itemMinHeight = 36,
  showFooter = true
}) => {
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'

  const { notifyError } = useMessage()
  const [all, setAll] = useState<FileOrDir[]>([])
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')

  useEffect(() => {
    if (!dirPath) return
    setLoading(true)
    setAll([])

    api()
      .svcHyper.listComfyFiles(
        { dir: dirPath, exts },
        {
          onData: (resp: ListComfyFilesResp) => {
            const f = resp.file
            const uid = f.path || f.name
            setAll((prev) => (prev.some((p) => (p.path || p.name) === uid) ? prev : [...prev, f]))
          }
        }
      )
      .catch((err) => {
        notifyError(
          isServerStreamingError(err)
            ? `获取文件列表失败: ${err.message}`
            : `获取文件列表失败: ${String(err)}`
        )
      })
      .finally(() => setLoading(false))
  }, [dirPath, exts, notifyError])

  const visible = useMemo(() => {
    let list = all.map((f) => {
      // 获取相对于 dirPath 的相对路径
      const escapedDir = dirPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const relPath =
        (f.path || '').replace(new RegExp(`^${escapedDir}[\\\\/]?`, 'i'), '') || f.name
      return { ...f, relPath }
    })

    if (searchText) {
      const lowerSearch = searchText.toLowerCase()
      list = list.filter((f) => f.relPath.toLowerCase().includes(lowerSearch))
    }

    list.sort((a, b) => a.relPath.localeCompare(b.relPath))

    return list
  }, [all, searchText, dirPath])
  const isEmpty = !loading && visible.length === 0

  const handleOpenFolder = () => {
    if (!dirPath) {
      notifyError(MESSAGE_COMFYUI_DIR_NOT_SET)
      return
    }
    api().svcShell.openPath(dirPath)
  }

  return (
    <>
      <Box sx={{ px: 2, pt: 2, pb: 1 }}>
        <TextField
          fullWidth
          size="small"
          placeholder="搜索并过滤模型 (可输入文件夹名) ..."
          variant="outlined"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }
          }}
          sx={{
            '& .MuiOutlinedInput-root': {
              bgcolor: isLight ? '#f5f6fb' : 'rgba(0,0,0,0.2)',
              borderRadius: 2
            }
          }}
        />
      </Box>
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
          mr: '5px'
        }}
      >
        {isEmpty ? (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <Box sx={{ fontSize: 64, mb: 2 }}>
              <StorageIcon />
            </Box>
            <Typography variant="h6" color="text.secondary" sx={{ mb: 2 }}>
              暂无{label}
            </Typography>
          </Box>
        ) : (
          <List dense sx={{ p: 0, pt: 1 }}>
            {visible.map((file, idx) => (
              <ListItem key={`${file.name}-${idx}`} dense sx={{ px: 2, py: 0.6 }}>
                <Box
                  sx={{
                    position: 'relative',
                    px: 3,
                    py: 3,
                    minHeight: itemMinHeight,
                    borderRadius: 3,
                    width: '100%',
                    // 主题切换的底色 + 高光渐变 + 阴影
                    bgcolor: isLight ? '#e7e9f5' : 'rgba(255,255,255,0.06)',
                    border: 1,
                    borderColor: 'divider',
                    background: isLight
                      ? 'linear-gradient(180deg, rgba(255,255,255,0.35), rgba(255,255,255,0) 40%), #e7e9f5'
                      : 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0) 40%), rgba(255,255,255,0.06)',
                    boxShadow: isLight ? CARD_3D_SHADOW : 'none'
                  }}
                >
                  <ListItemText
                    primary={file.relPath}
                    slotProps={{
                      primary: {
                        variant: 'subtitle1',
                        sx: {
                          fontWeight: 600,
                          lineHeight: 1.2,
                          color: isLight ? '#333' : '#fff',
                          wordBreak: 'break-all'
                        }
                      }
                    }}
                  />
                </Box>
              </ListItem>
            ))}
          </List>
        )}
      </Box>

      {/* 底部统计 & 打开文件夹（可隐藏） */}
      {showFooter && (
        <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">
              共 {visible.length} 个{label}
            </Typography>
            <Button variant="contained" startIcon={<FolderOpenIcon />} onClick={handleOpenFolder}>
              打开文件夹
            </Button>
          </Stack>
        </Box>
      )}
    </>
  )
}

export default FileBrowserPannel
