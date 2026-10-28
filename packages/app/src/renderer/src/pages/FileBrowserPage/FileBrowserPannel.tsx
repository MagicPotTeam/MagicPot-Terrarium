// AIEngineElectron/packages/app/src/renderer/src/pages/FileBrowserPage/FileBrowserPannel.tsx
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  Button,
  IconButton,
  Stack,
  TextField,
  InputAdornment
} from '@mui/material'
import {
  ContentCopy as ContentCopyIcon,
  FolderOpen as FolderOpenIcon,
  Storage as StorageIcon,
  Search as SearchIcon
} from '@mui/icons-material'
import { useTheme } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import type { FileInfo, ListComfyFilesResp } from '@shared/api/svcHyper'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { MESSAGE_COMFYUI_DIR_NOT_SET } from '@shared/config/messageConst'

// 与 MainPage 一致的 3D 阴影
const CARD_3D_SHADOW = '8px 0 16px rgba(0,0,0,0.04), 0 8px 16px rgba(0,0,0,0.04)'

export type FileBrowserPannelProps = {
  label: string
  dirPath: string
  exts?: string[]
  /** Stable category identity used when two categories share the same directory and extensions. */
  requestScopeKey?: string
  itemMinHeight?: number
  /** 是否显示底部统计与“打开文件夹”按钮（默认：true） */
  showFooter?: boolean
}

type FileOrDir = FileInfo & { isDir?: boolean }
type ScopeToken = { key: string }
type ListingState = {
  scope: ScopeToken
  files: FileOrDir[]
  loading: boolean
}
type PendingState = {
  scope: ScopeToken
  keys: ReadonlySet<string>
}
type ActionLock = {
  scope: ScopeToken
  id: symbol
}

type VisibleFile = FileOrDir & {
  uid: string
  relPath: string
}

const relativeFilePath = (
  filePath: string | undefined,
  fileName: string,
  dirPath: string
): string => {
  if (!filePath) return fileName
  const escapedDir = dirPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return filePath.replace(new RegExp(`^${escapedDir}[\\\\/]?`, 'i'), '') || fileName
}

const FileBrowserPannel: React.FC<FileBrowserPannelProps> = ({
  label,
  dirPath,
  exts,
  requestScopeKey,
  itemMinHeight = 36,
  showFooter = true
}) => {
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const { t } = useTranslation()
  const { notifyError } = useMessage()

  const tRef = useRef(t)
  const notifyErrorRef = useRef(notifyError)
  tRef.current = t
  notifyErrorRef.current = notifyError

  const extensionKey = JSON.stringify(exts ?? null)
  const requestExts = useMemo(() => (exts ? [...exts] : undefined), [extensionKey])
  const resolvedScopeKey = JSON.stringify([requestScopeKey ?? null, dirPath, exts ?? null])
  const scope = useMemo<ScopeToken>(() => ({ key: resolvedScopeKey }), [resolvedScopeKey])
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const [listingState, setListingState] = useState<ListingState>({
    scope,
    files: [],
    loading: Boolean(dirPath)
  })
  const [searchText, setSearchText] = useState('')
  const [pendingState, setPendingState] = useState<PendingState>({
    scope,
    keys: new Set<string>()
  })
  const actionLocksRef = useRef(new Map<string, ActionLock>())

  const reportListingFailure = () => {
    notifyErrorRef.current(tRef.current('chat.local_files.errors.IO_ERROR'))
  }
  const reportOpenFailure = () => {
    notifyErrorRef.current(
      tRef.current('qapp.callout.open_directory_failed', {
        error: tRef.current('chat.unknown_error')
      })
    )
  }
  const reportCopyFailure = () => {
    notifyErrorRef.current(tRef.current('model.copy_path_failed'))
  }

  useLayoutEffect(() => {
    const [abortSender, abortReceiver] = newAbortHandler()
    let active = true
    const isCurrent = () => active && scopeRef.current === scope && !abortReceiver.isAborted()
    const invalidateAndAbort = () => {
      active = false
      try {
        abortSender.abort()
      } catch {
        // A transport abort listener is not allowed to revive or crash this view.
      }
    }

    if (!dirPath) {
      setListingState({ scope, files: [], loading: false })
      return invalidateAndAbort
    }

    setListingState({ scope, files: [], loading: true })
    let request: Promise<void>
    try {
      request = api().svcHyper.listComfyFiles(
        { dir: dirPath, exts: requestExts },
        {
          abortReceiver,
          onData: (resp: ListComfyFilesResp) => {
            if (!isCurrent()) return
            const file = resp.file
            const uid = file.path || file.name
            setListingState((previous) => {
              if (!isCurrent()) return previous
              const files = previous.scope === scope ? previous.files : []
              if (files.some((entry) => (entry.path || entry.name) === uid)) {
                return previous.scope === scope ? previous : { scope, files, loading: true }
              }
              return { scope, files: [...files, file], loading: true }
            })
          }
        }
      )
    } catch {
      if (isCurrent()) {
        reportListingFailure()
        setListingState({ scope, files: [], loading: false })
      }
      return invalidateAndAbort
    }

    void Promise.resolve(request).then(
      () => {
        if (!isCurrent()) return
        setListingState((previous) =>
          previous.scope === scope ? { ...previous, loading: false } : previous
        )
      },
      () => {
        if (!isCurrent()) return
        reportListingFailure()
        setListingState((previous) =>
          previous.scope === scope ? { ...previous, loading: false } : previous
        )
      }
    )

    return invalidateAndAbort
  }, [dirPath, requestExts, scope])

  const beginAction = (key: string): ActionLock | null => {
    const existing = actionLocksRef.current.get(key)
    if (existing?.scope === scope) return null

    const lock: ActionLock = { scope, id: Symbol(key) }
    actionLocksRef.current.set(key, lock)
    setPendingState((previous) => {
      const keys = new Set(previous.scope === scope ? previous.keys : [])
      keys.add(key)
      return { scope, keys }
    })
    return lock
  }

  const finishAction = (key: string, lock: ActionLock) => {
    if (actionLocksRef.current.get(key) !== lock) return
    actionLocksRef.current.delete(key)
    if (!mountedRef.current || scopeRef.current !== lock.scope) return
    setPendingState((previous) => {
      if (previous.scope !== lock.scope || !previous.keys.has(key)) return previous
      const keys = new Set(previous.keys)
      keys.delete(key)
      return { scope: lock.scope, keys }
    })
  }

  const actionIsCurrent = (key: string, lock: ActionLock): boolean =>
    mountedRef.current &&
    scopeRef.current === lock.scope &&
    actionLocksRef.current.get(key) === lock

  const runScopedAction = (
    key: string,
    operation: () => Promise<void>,
    reportFailure: () => void
  ) => {
    const lock = beginAction(key)
    if (!lock) return
    void (async () => {
      try {
        await operation()
      } catch {
        if (actionIsCurrent(key, lock)) reportFailure()
      } finally {
        finishAction(key, lock)
      }
    })()
  }

  const files = listingState.scope === scope ? listingState.files : []
  const loading = listingState.scope === scope ? listingState.loading : Boolean(dirPath)
  const pendingKeys = pendingState.scope === scope ? pendingState.keys : new Set<string>()

  const visible = useMemo<VisibleFile[]>(() => {
    let list = files.map((file) => ({
      ...file,
      uid: file.path || file.name,
      relPath: relativeFilePath(file.path, file.name, dirPath)
    }))

    if (searchText) {
      const lowerSearch = searchText.toLowerCase()
      list = list.filter((file) => file.relPath.toLowerCase().includes(lowerSearch))
    }

    list.sort((left, right) => left.relPath.localeCompare(right.relPath))
    return list
  }, [files, searchText, dirPath])

  const isEmpty = !loading && visible.length === 0

  const handleOpenFolder = () => {
    if (!dirPath) {
      notifyErrorRef.current(MESSAGE_COMFYUI_DIR_NOT_SET)
      return
    }
    runScopedAction(
      'root',
      async () => {
        const result = await api().svcShell.openPath(dirPath)
        if (result !== '') throw new Error('The shell rejected the directory.')
      },
      reportOpenFailure
    )
  }

  const handleReveal = (file: VisibleFile) => {
    if (!file.path) return
    runScopedAction(
      `reveal:${file.path}`,
      async () => {
        await api().svcShell.showItemInFolder(file.path!)
      },
      reportOpenFailure
    )
  }

  const handleCopy = (file: VisibleFile) => {
    if (!file.path) return
    runScopedAction(
      `copy:${file.path}`,
      async () => {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.')
        await navigator.clipboard.writeText(file.path!)
      },
      reportCopyFailure
    )
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
          onChange={(event) => setSearchText(event.target.value)}
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
            {visible.map((file) => {
              const revealKey = file.path ? `reveal:${file.path}` : ''
              const copyKey = file.path ? `copy:${file.path}` : ''
              return (
                <ListItem key={file.uid} dense sx={{ px: 2, py: 0.6 }}>
                  <Box
                    sx={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      px: 3,
                      py: 3,
                      minHeight: itemMinHeight,
                      borderRadius: 3,
                      width: '100%',
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
                      sx={{ minWidth: 0 }}
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
                    <Stack direction="row" spacing={0.5} flexShrink={0}>
                      <IconButton
                        size="small"
                        aria-label={`${t('model.copy_path')}: ${file.relPath}`}
                        disabled={!file.path || pendingKeys.has(copyKey)}
                        onClick={() => handleCopy(file)}
                      >
                        <ContentCopyIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        aria-label={`${t('model.open_folder')}: ${file.relPath}`}
                        disabled={!file.path || pendingKeys.has(revealKey)}
                        onClick={() => handleReveal(file)}
                      >
                        <FolderOpenIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  </Box>
                </ListItem>
              )
            })}
          </List>
        )}
      </Box>

      {showFooter && (
        <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">
              共 {visible.length} 个{label}
            </Typography>
            <Button
              variant="contained"
              startIcon={<FolderOpenIcon />}
              disabled={pendingKeys.has('root')}
              onClick={handleOpenFolder}
            >
              {t('model.open_folder')}
            </Button>
          </Stack>
        </Box>
      )}
    </>
  )
}

export default FileBrowserPannel
