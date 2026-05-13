import {
  DeleteOutlined,
  ExpandMore,
  ChevronRight,
  Search as SearchIcon,
  PushPin as PushPinIcon,
  PushPinOutlined as PushPinOutlinedIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  ImageOutlined,
  PlayArrow as PlayArrowIcon,
  FileDownload as ExportQAppIcon,
  Close as CloseIcon,
  Add as AddIcon,
  ViewInAr as ViewInArIcon
} from '@mui/icons-material'
import { useCallback, useEffect, useState, useMemo, memo, useRef } from 'react' // 引入 memo
import {
  Box,
  Collapse,
  IconButton,
  List,
  Paper,
  Skeleton,
  styled,
  ListItemButton,
  Button,
  Chip,
  Menu,
  MenuItem,
  Typography,
  Tooltip,
  CircularProgress,
  Dialog,
  InputBase,
  Stack
} from '@mui/material'
import { Suspense, lazy } from 'react'
import { useMessage } from '@renderer/hooks/useMessage'
import { useComfyEventCallback } from '@renderer/hooks/useComfyEvent'
import { api } from '@renderer/utils/windowUtils'
import { QAppMenuItem } from '@shared/api/svcQApp'
import { isComfyFrontendOnlyNodeClassType } from '@shared/comfy/funcs'
import type { Config } from '@shared/config/config'
import { useConfig } from '@renderer/hooks/useConfig'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { extractWorkflowFromImage } from '@renderer/utils/fileUtils'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { openTab, closeTab, setActiveTab } from '@renderer/store/slices/layoutSlice'
import { resolveImportedWorkflow } from '@renderer/utils/resolveImportedWorkflow'
import {
  getQuickAppWorkflowImportError,
  hasRestorableHy3dQuickAppPayload,
  parseInternalImageDragPayload
} from '@renderer/utils/droppedImageUtils'
import { clearCachedQAppState, renameCachedQAppState } from './QAppContext'
import {
  QUICK_APP_IMPORT_PROMPT,
  getUnsupportedQuickAppDropMessage,
  isQuickAppBundleFile,
  isQuickAppImportImageFile
} from '../hooks/qAppDropValidation'
import { ProjectSelectorDialog } from './ProjectSelectorDialog'
import {
  BUILTIN_HUNYUAN3D_QAPP_KEY,
  WORKFLOW_STEPS,
  getBuiltinHunyuan3DQuickAppKeyForAction,
  getBuiltinHunyuan3DStepKey,
  isBuiltinHunyuan3DMenuKey
} from '@renderer/pages/ChatPage/hy3d/types'
import {
  buildDefaultQAppManifest,
  createQAppPackagePayload,
  getQAppCompatibilityError,
  parseQAppPackage
} from '@shared/qApp/packageBundle'
import { inferQAppCategory, type QAppCategory as SharedQAppCategory } from '@shared/qApp/category'
import {
  createBuiltinDuplicateCheckQApp,
  isBuiltinDuplicateCheckQApp
} from '../duplicateCheck/builtin'

const QAppDesignPage = lazy(() => import('../QAppDesignPage'))

const fetchRemoteQAppList = async (remoteOrigin: string, config?: Config) => {
  const remoteQApp = await import('@renderer/utils/remoteQApp')
  return remoteQApp.fetchRemoteQAppList(remoteOrigin, config)
}

const QAPP_MENU_CACHE_KEY = 'qapp.menu.cachedItems.v1'
type QAppCategory = SharedQAppCategory

const isBuiltinHunyuan3DQApp = (key: string): boolean => key === BUILTIN_HUNYUAN3D_QAPP_KEY
const isBuiltinProtectedQApp = (key: string): boolean =>
  isBuiltinHunyuan3DQApp(key) || isBuiltinDuplicateCheckQApp(key)

const createBuiltinHunyuan3DQApp = (): QAppMenuItem =>
  ({
    key: BUILTIN_HUNYUAN3D_QAPP_KEY,
    name: 'hunyuan3d',
    isBuiltin: true,
    isDirectory: true,
    children: WORKFLOW_STEPS.map(
      (step) =>
        ({
          key: getBuiltinHunyuan3DStepKey(step.id),
          name: step.label,
          isBuiltin: true,
          isDirectory: false
        }) as QAppMenuItem
    )
  }) as QAppMenuItem

const readCachedQAppItems = (): QAppMenuItem[] => {
  try {
    const raw = window.localStorage.getItem(QAPP_MENU_CACHE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as QAppMenuItem[]) : []
  } catch {
    return []
  }
}

const writeCachedQAppItems = (items: QAppMenuItem[]): void => {
  try {
    window.localStorage.setItem(QAPP_MENU_CACHE_KEY, JSON.stringify(items))
  } catch {
    // ignore cache write failures
  }
}

const collectSelectableQAppKeys = (items: QAppMenuItem[]): string[] =>
  items.reduce<string[]>((result, item) => {
    if (item.isDirectory) {
      result.push(...collectSelectableQAppKeys(item.children ?? []))
      return result
    }

    result.push(item.key)
    return result
  }, [])

const QAPP_CATEGORY_LABELS: Record<QAppCategory, string> = {
  image: '\u56fe\u50cf',
  model3d: '3D',
  video: '\u89c6\u9891',
  inspection: '\u68c0\u67e5'
}

export { QAPP_CATEGORY_LABELS }
export type { QAppCategory }

const getQAppCategory = (item: QAppMenuItem): QAppCategory => {
  if (isBuiltinHunyuan3DQApp(item.key)) {
    return 'model3d'
  }
  return inferQAppCategory({
    key: item.key,
    name: item.name,
    category: item.category
  })
}

// ============================================================================
// 样式组件定义 (保持不变)
// ============================================================================

const overflowWidth = 14
const leftOverflow = overflowWidth + 4
const r = 0 // originally 22, changed to 0 for rectangular edges

const StyledMenuItem = styled(ListItemButton as typeof ListItemButton, {
  shouldForwardProp: (prop) => prop !== '$isDir'
})<{ $isDir?: boolean }>(({ theme, $isDir }) => {
  return {
    display: 'flex',
    border: 0,
    borderRadius: 0,
    position: 'relative',
    isolation: 'isolate',
    paddingLeft: theme.spacing(0.5),
    paddingRight: theme.spacing(0),
    paddingTop: 0,
    paddingBottom: 0,
    minHeight: '100px',
    zIndex: 0,
    overflow: 'visible',
    transition: 'margin .18s ease, box-shadow .18s ease, border-radius .18s ease',
    '&, &.Mui-selected, &.Mui-selected:hover, &:hover, &:active, &.Mui-focusVisible': {
      backgroundColor: 'transparent !important'
    },
    '& .qapp-menu-item-text': {
      fontFamily: theme.typography.fontFamily,
      fontWeight: 600,
      color: theme.palette.menu.inactive
    },
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: `-${overflowWidth}px`,
      left: `-${leftOverflow}px`,
      borderTopRightRadius: r,
      borderBottomRightRadius: r,
      backgroundColor: 'transparent',
      opacity: 0,
      transition: 'opacity .18s ease, background-color .18s ease, box-shadow .18s ease',
      zIndex: 0
    },
    ...($isDir
      ? {
          '&:hover::after': { content: 'none' },
          '& .MuiTouchRipple-root': { display: 'none' }
        }
      : {
          '& .MuiTouchRipple-root': {
            right: `-${overflowWidth}px`,
            left: `-${leftOverflow}px`,
            width: 'auto',
            borderTopRightRadius: r,
            borderBottomRightRadius: r,
            overflow: 'hidden'
          },
          '&:hover': {
            marginLeft: 0,
            marginRight: 0.2,
            boxShadow: 'none'
          },
          '&:hover::after': {
            opacity: 1,
            backgroundColor: theme.palette.menu.hoverBg,
            boxShadow: 'none'
          },
          '&.Mui-selected': {
            marginLeft: 0,
            marginRight: 0.2,
            color: '#fff',
            '& .qapp-menu-item-text': { color: '#fff' }
          },
          '&.Mui-selected::after': {
            opacity: 1,
            backgroundColor: theme.palette.menu.selectedBg,
            boxShadow: theme.palette.menu.sideShadow
          },
          '&.Mui-selected:hover::after': {
            backgroundColor: theme.palette.menu.selectedBg,
            boxShadow: theme.palette.menu.sideShadow
          }
        })
  }
})

// ============================================================================
// 递归菜单项组件 (保持不变)
// ============================================================================
type CascadingMenuItemProps = {
  qAppItem: QAppMenuItem
  currentQAppKey: string
  setCurrentQAppKey: (qAppKey: string) => void
  getDisplayName: (value?: string) => string
  refreshTabs: () => void
  depth?: number
  expandedKeys: Set<string>
  onToggleExpand: (key: string) => void
  usedAsSelector?: boolean
  onMoreClick: (event: React.MouseEvent<HTMLElement>, key: string) => void
  pinnedKeys: Set<string>
  onRunClick?: (key: string) => void
  isRunning?: boolean
  renderExpandedContent?: (key: string) => React.ReactNode
  scrollRootRef: { current: HTMLDivElement | null }
}
const CascadingMenuItem = memo(
  ({
    qAppItem,
    currentQAppKey,
    setCurrentQAppKey,
    getDisplayName,
    refreshTabs,
    depth = 0,
    expandedKeys,
    onToggleExpand,
    usedAsSelector = false,
    onMoreClick,
    pinnedKeys,
    onRunClick,
    isRunning,
    renderExpandedContent,
    scrollRootRef
  }: CascadingMenuItemProps) => {
    const isSelected = currentQAppKey === qAppItem.key
    const isChild = depth > 0
    const isDirectory = !!qAppItem.isDirectory
    const isExpanded = isDirectory && expandedKeys.has(qAppItem.key)
    const displayName = getDisplayName(qAppItem.name) || getDisplayName(qAppItem.key)
    const itemRef = useRef<HTMLDivElement | null>(null)
    const [isPinned, setIsPinned] = useState(false)

    // 进度条状态
    const [progress, setProgress] = useState(0)
    useComfyEventCallback((event) => {
      if (event.type === 'progress') {
        const { value, max } = event.data
        if (max && max > 0) {
          setProgress((value ?? 0) / max)
        }
      }
      if (event.type === 'executed' || event.type === 'execution_error') {
        setProgress(0)
      }
    }, [])

    const isStickyActive = !isDirectory && isSelected && !!renderExpandedContent

    useEffect(() => {
      if (!isStickyActive) {
        setIsPinned(false)
        return
      }

      const scrollRoot = scrollRootRef.current
      if (!scrollRoot || !itemRef.current) {
        return
      }

      let frameId = 0
      const updatePinnedState = () => {
        cancelAnimationFrame(frameId)
        frameId = window.requestAnimationFrame(() => {
          const latestScrollRoot = scrollRootRef.current
          const latestItem = itemRef.current
          if (!latestScrollRoot || !latestItem) {
            return
          }

          const itemRect = latestItem.getBoundingClientRect()
          const rootRect = latestScrollRoot.getBoundingClientRect()
          const nextPinned = latestScrollRoot.scrollTop > 0 && itemRect.top <= rootRect.top + 1

          setIsPinned((prev) => (prev === nextPinned ? prev : nextPinned))
        })
      }

      updatePinnedState()
      scrollRoot.addEventListener('scroll', updatePinnedState, { passive: true })
      window.addEventListener('resize', updatePinnedState)

      return () => {
        cancelAnimationFrame(frameId)
        scrollRoot.removeEventListener('scroll', updatePinnedState)
        window.removeEventListener('resize', updatePinnedState)
      }
    }, [isStickyActive, scrollRootRef])

    return (
      <>
        <StyledMenuItem
          ref={itemRef}
          $isDir={isDirectory}
          selected={!isDirectory && isSelected}
          onClick={(e) => {
            e.stopPropagation()
            if (isDirectory) {
              onToggleExpand(qAppItem.key)
              return
            }
            // 侧边面板模式：点击切换选中/取消
            if (renderExpandedContent && isSelected) {
              setCurrentQAppKey('')
              return
            }
            setCurrentQAppKey(qAppItem.key)
          }}
          onContextMenu={(e) => {
            if (!isDirectory && !isBuiltinHunyuan3DMenuKey(qAppItem.key)) {
              e.preventDefault()
              onMoreClick(e, qAppItem.key)
            }
          }}
          sx={(theme) => ({
            minHeight: isChild ? 40 : 40,
            flexDirection: isDirectory ? 'column' : 'row',
            alignItems: isDirectory ? 'stretch' : 'center',
            py: 0.5,
            '& .qapp-menu-item-text': {
              fontSize: isChild ? 14 : 16
            },
            position: 'relative',
            // 选中时吸顶
            ...(isStickyActive
              ? {
                  position: 'sticky',
                  top: 0,
                  zIndex: 10,
                  '&, &.Mui-selected, &.Mui-selected:hover': {
                    backgroundColor: `${theme.palette.mode === 'dark' ? theme.palette.background.paper : '#eaecf5'} !important`
                  },
                  '&.Mui-selected::after, &.Mui-selected:hover::after': {
                    borderTopRightRadius: 0,
                    left: `-${leftOverflow + 4}px`,
                    right: `-${overflowWidth + 4}px`
                  }
                }
              : {}),
            // 运行时用渐变做进度条：亮紫=已完成，深紫=未完成
            ...(!isDirectory &&
              isSelected &&
              progress > 0 && {
                '&.Mui-selected::after, &.Mui-selected:hover::after': {
                  background: `linear-gradient(to right, #0078d4 ${progress * 100}%, #1a3a5c ${progress * 100}%)`,
                  transition: 'background 0.2s linear, opacity .18s ease, box-shadow .18s ease'
                }
              })
          })}
        >
          <Box
            sx={(theme) => ({
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              position: 'relative',
              zIndex: 1,
              paddingY: theme.spacing(1),
              overflow: 'hidden',
              '&:hover .qapp-run-btn': {
                opacity: 1,
                pointerEvents: 'auto'
              }
            })}
          >
            {/* 自定义图标或展开/折叠箭头（已移除图标） */}
            <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: 1 }}>
              {!isDirectory && qAppItem.icon && (
                <Box
                  sx={{
                    width: 20,
                    height: 20,
                    borderRadius: 1,
                    mr: 1,
                    flexShrink: 0,
                    backgroundImage: `url(${qAppItem.icon})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    boxShadow: '0 0 2px rgba(0,0,0,0.2)'
                  }}
                />
              )}
              <Box
                className="qapp-menu-item-text"
                sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {displayName}
              </Box>
            </Box>
            {/* 非目录项：播放/停止按钮 */}
            {!isDirectory && !isBuiltinHunyuan3DQApp(qAppItem.key) && onRunClick && isSelected && (
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation()
                  onRunClick(qAppItem.key)
                }}
                sx={{
                  p: 0.5,
                  flexShrink: 0,
                  ml: 0.5,
                  color: isRunning ? '#fff' : '#7E73FD',
                  bgcolor: isRunning ? '#d32f2f' : '#ffffff',
                  borderRadius: 1,
                  boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
                  transition:
                    'background-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease',
                  '&:hover': {
                    bgcolor: isRunning ? '#b71c1c' : '#f8f8f8',
                    transform: 'scale(1.12)',
                    boxShadow: '0 4px 8px rgba(0,0,0,0.2)'
                  },
                  '&:active': {
                    transform: 'scale(0.95)'
                  }
                }}
              >
                {isRunning ? (
                  <Box sx={{ width: 10, height: 10, bgcolor: '#fff', borderRadius: 0.5 }} />
                ) : (
                  <PlayArrowIcon sx={{ fontSize: 20 }} />
                )}
              </IconButton>
            )}
            {isDirectory && (
              <IconButton
                size="small"
                sx={{ p: 0.25, flexShrink: 0 }}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleExpand(qAppItem.key)
                }}
              >
                {isExpanded ? <ExpandMore fontSize="small" /> : <ChevronRight fontSize="small" />}
              </IconButton>
            )}
          </Box>
        </StyledMenuItem>
        {isDirectory && (
          <Collapse in={isExpanded} timeout={80} unmountOnExit>
            <Box sx={{ ml: 1, borderLeft: 1, borderColor: 'divider' }}>
              <List sx={{ position: 'relative', p: 0 }}>
                {(qAppItem.children ?? []).map((child) => (
                  <CascadingMenuItem
                    key={child.key}
                    qAppItem={child}
                    currentQAppKey={currentQAppKey}
                    setCurrentQAppKey={setCurrentQAppKey}
                    getDisplayName={getDisplayName}
                    refreshTabs={refreshTabs}
                    depth={depth + 1}
                    expandedKeys={expandedKeys}
                    onToggleExpand={onToggleExpand}
                    usedAsSelector={usedAsSelector}
                    onMoreClick={onMoreClick}
                    pinnedKeys={pinnedKeys}
                    onRunClick={onRunClick}
                    isRunning={isRunning}
                    renderExpandedContent={renderExpandedContent}
                    scrollRootRef={scrollRootRef}
                  />
                ))}
              </List>
            </Box>
          </Collapse>
        )}
        {/* 非目录项选中时：展开参数面板 */}
        {!isDirectory && renderExpandedContent && (
          <Collapse in={isSelected} timeout={80} unmountOnExit>
            <Box
              sx={{
                ml: 0.5,
                pl: 0.5,
                pt: isPinned ? 6 : 1.5,
                pb: 0.5,
                overflow: 'hidden',
                transition: 'padding-top 120ms ease'
              }}
            >
              {renderExpandedContent(qAppItem.key)}
            </Box>
          </Collapse>
        )}
      </>
    )
  },
  (prevProps, nextProps) => {
    if (
      prevProps.qAppItem !== nextProps.qAppItem ||
      prevProps.getDisplayName !== nextProps.getDisplayName ||
      prevProps.refreshTabs !== nextProps.refreshTabs ||
      prevProps.depth !== nextProps.depth ||
      prevProps.onToggleExpand !== nextProps.onToggleExpand ||
      prevProps.usedAsSelector !== nextProps.usedAsSelector ||
      prevProps.onMoreClick !== nextProps.onMoreClick ||
      prevProps.onRunClick !== nextProps.onRunClick ||
      prevProps.renderExpandedContent !== nextProps.renderExpandedContent ||
      prevProps.scrollRootRef !== nextProps.scrollRootRef
    ) {
      return false
    }

    const key = nextProps.qAppItem.key
    const isDir = Boolean(nextProps.qAppItem.isDirectory)

    const prevSelected = prevProps.currentQAppKey === key
    const nextSelected = nextProps.currentQAppKey === key
    if (prevSelected !== nextSelected) return false

    const prevPinned = prevProps.pinnedKeys.has(key)
    const nextPinned = nextProps.pinnedKeys.has(key)
    if (prevPinned !== nextPinned) return false

    if (!isDir) {
      if (nextSelected && prevProps.isRunning !== nextProps.isRunning) {
        return false
      }
      return true
    }

    const prevExpanded = prevProps.expandedKeys.has(key)
    const nextExpanded = nextProps.expandedKeys.has(key)
    if (prevExpanded !== nextExpanded) return false

    if (nextExpanded) {
      if (
        prevProps.currentQAppKey !== nextProps.currentQAppKey ||
        prevProps.expandedKeys !== nextProps.expandedKeys ||
        prevProps.pinnedKeys !== nextProps.pinnedKeys ||
        prevProps.isRunning !== nextProps.isRunning
      ) {
        return false
      }
    }

    return true
  }
)
CascadingMenuItem.displayName = 'CascadingMenuItem'

// ============================================================================
// 菜单主容器组件
// ============================================================================
type QAppMenuProps = {
  currentQAppKey: string
  setCurrentQAppKey: (qAppKey: string) => void
  activeCategory?: QAppCategory
  usedAsSelector?: boolean
  onRunClick?: (key: string) => void
  isRunning?: boolean
  renderExpandedContent?: (key: string) => React.ReactNode
}
export default function QAppMenu({
  currentQAppKey,
  setCurrentQAppKey,
  activeCategory: activeCategoryProp = 'image',
  usedAsSelector = false,
  onRunClick,
  isRunning,
  renderExpandedContent
}: QAppMenuProps) {
  const { t } = useTranslation()
  const { notifyError, notifySuccess } = useMessage()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const openTabs = useAppSelector((s) => s.layout.openTabs)
  const activeTabId = useAppSelector((s) => s.layout.activeTabId)
  // const { configUtils } = useConfig() // 如果不需要 openFolder 按钮，可以注释掉

  const initialCachedQAppItems = useMemo(() => readCachedQAppItems(), [])
  const [isLoading, setIsLoading] = useState(initialCachedQAppItems.length === 0)
  const [qAppItems, setQAppItems] = useState<QAppMenuItem[]>(initialCachedQAppItems)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [searchKeyword, setSearchKeyword] = useState('')
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [designDialogOpen, setDesignDialogOpen] = useState(false)
  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('qapp.pinned')
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>()
    } catch {
      return new Set<string>()
    }
  })

  // ★★★ 项目级快应用管理 ★★★
  const isProject = activeTabId?.startsWith('tab-project-')
  const [projectSelectedKeys, setProjectSelectedKeys] = useState<Set<string>>(() => new Set())
  const [selectorDialogOpen, setSelectorDialogOpen] = useState(false)
  const activeCategory = activeCategoryProp
  const notifyErrorRef = useRef(notifyError)
  const tRef = useRef(t)
  const refreshRequestIdRef = useRef(0)
  const qAppItemsRef = useRef(qAppItems)
  const scrollRootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    qAppItemsRef.current = qAppItems
  }, [qAppItems])

  useEffect(() => {
    notifyErrorRef.current = notifyError
    tRef.current = t
  }, [notifyError, t])

  // 切换 activeTabId 时，如果是项目节点，重新加载该项目已选的快应用
  useEffect(() => {
    if (isProject && activeTabId) {
      const defaultSelection = new Set(collectSelectableQAppKeys(qAppItems))
      try {
        const raw = localStorage.getItem(`qapp.selected.${activeTabId}`)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          setProjectSelectedKeys(new Set(Array.isArray(parsed) ? parsed : []))
        } else {
          setProjectSelectedKeys(defaultSelection)
        }
      } catch {
        setProjectSelectedKeys(defaultSelection)
      }
    }
  }, [activeTabId, isProject, qAppItems])

  // Flat list of all available QApps for the Selector
  const flatAllQApps = useMemo(() => {
    const flatten = (items: QAppMenuItem[]): QAppMenuItem[] => {
      const res: QAppMenuItem[] = []
      for (const i of items) {
        if (!i.isDirectory) res.push(i)
        if (i.children) res.push(...flatten(i.children))
      }
      return res
    }
    return flatten(qAppItems)
  }, [qAppItems])

  // 辅助函数
  const getDisplayName = useCallback(
    (v?: string) => {
      if (!v) return ''
      if (v === BUILTIN_HUNYUAN3D_QAPP_KEY || v === 'hunyuan3d') {
        return t('qapp.names.hunyuan3d_quick_app')
      }
      if (isBuiltinDuplicateCheckQApp(v) || v === '重复图检查') {
        return '重复图检查'
      }
      return t(`qapp.names.${v}`) !== `qapp.names.${v}` ? t(`qapp.names.${v}`) : v
    },
    [t]
  )
  const findFirstLeaf = useCallback(
    (items: QAppMenuItem[]): string | null => {
      for (const item of items) {
        if (item.isDirectory && item.children) {
          const nestedLeaf = findFirstLeaf(item.children)
          if (nestedLeaf) {
            return nestedLeaf
          }
          continue
        }

        const itemCategory = getQAppCategory(item)
        if (itemCategory !== activeCategory) {
          continue
        }

        if (isBuiltinHunyuan3DQApp(item.key) && activeCategory !== 'model3d') {
          continue
        }

        return item.key
      }

      return null
    },
    [activeCategory]
  )

  const featuredModel3DQApps = useMemo(
    () => flatAllQApps.filter((item) => getQAppCategory(item) === 'model3d'),
    [flatAllQApps]
  )

  const filterVisibleItems = useCallback((items: QAppMenuItem[]): QAppMenuItem[] => {
    return items
      .map((item) => {
        if (item.isDirectory && item.children) {
          const children = filterVisibleItems(item.children)
          if (children.length > 0) return { ...item, children }
          return null
        }
        if (item.isHidden === true) return null
        return item
      })
      .filter((i): i is QAppMenuItem => i !== null)
  }, [])

  const sortWithPin = useCallback(
    (list: QAppMenuItem[]): QAppMenuItem[] => {
      return [...list].sort((a, b) => {
        const ap = pinnedKeys.has(a.key)
        const bp = pinnedKeys.has(b.key)
        if (ap !== bp) return ap ? -1 : 1
        return (a.name || a.key).localeCompare(b.name || b.key)
      })
    },
    [pinnedKeys]
  )

  const processItems = useCallback(
    (items: QAppMenuItem[]): QAppMenuItem[] => {
      let visible = filterVisibleItems(items).map((item) => {
        if (item.isDirectory && item.children) {
          return {
            ...item,
            children: sortWithPin(item.children)
          }
        }
        return item
      })

      // ★★★ 项目级过滤 ★★★
      // 如果处于项目内，只显示勾选了的快应用
      if (isProject) {
        const filterProject = (list: QAppMenuItem[]): QAppMenuItem[] | null => {
          const res: QAppMenuItem[] = []
          for (const item of list) {
            if (isBuiltinProtectedQApp(item.key)) {
              res.push(item)
              continue
            }
            if (item.isDirectory && item.children) {
              const c = filterProject(item.children)
              if (c && c.length) res.push({ ...item, children: c })
            } else {
              if (projectSelectedKeys.has(item.key)) {
                res.push(item)
              }
            }
          }
          return res.length > 0 ? res : null
        }
        visible = filterProject(visible) || []
      }

      const filterByCategory = (list: QAppMenuItem[]): QAppMenuItem[] => {
        return list
          .map((item) => {
            if (item.isDirectory && item.children) {
              const children = filterByCategory(item.children)
              return children.length > 0 ? { ...item, children } : null
            }
            return getQAppCategory(item) === activeCategoryProp ? item : null
          })
          .filter((i): i is QAppMenuItem => i !== null)
      }

      if (!usedAsSelector) {
        visible = filterByCategory(visible)
      }

      const sortedVisible = sortWithPin(visible)
      if (!searchKeyword.trim()) return sortedVisible
      const kw = searchKeyword.toLowerCase().trim()
      const filter = (list: QAppMenuItem[]): QAppMenuItem[] => {
        return list
          .map((item) => {
            const name = getDisplayName(item.name) || getDisplayName(item.key)
            const match = name.toLowerCase().includes(kw) || item.key.toLowerCase().includes(kw)
            if (item.isDirectory && item.children) {
              const c = filter(item.children)
              if (match || c.length) return { ...item, children: c }
              return null
            }
            return match ? item : null
          })
          .filter((i): i is QAppMenuItem => i !== null)
      }
      return filter(sortedVisible)
    },
    [
      activeCategoryProp,
      searchKeyword,
      getDisplayName,
      filterVisibleItems,
      sortWithPin,
      isProject,
      projectSelectedKeys,
      usedAsSelector
    ]
  )

  // ★★★ 核心修复：使用 useMemo 缓存计算结果，防止死循环 ★★★
  const displayItems = useMemo(() => {
    return processItems(qAppItems)
  }, [qAppItems, processItems])

  // Effects
  useEffect(() => {
    if (!searchKeyword.trim()) return
    const expand = (items: QAppMenuItem[], keys: Set<string>) => {
      items.forEach((i) => {
        if (i.isDirectory) {
          if (i.children?.length) {
            keys.add(i.key)
            expand(i.children, keys)
          }
        }
      })
      return keys
    }
    setExpandedKeys((prev) => {
      const n = new Set(prev)
      expand(displayItems, n).forEach((k) => n.add(k))
      return n
    })
  }, [searchKeyword, displayItems])

  // 持久化置顶
  useEffect(() => {
    try {
      localStorage.setItem('qapp.pinned', JSON.stringify(Array.from(pinnedKeys)))
    } catch {
      // ignore
    }
  }, [pinnedKeys])

  const { config, buildEnv } = useConfig()

  const refreshTabs = useCallback(async () => {
    const requestId = ++refreshRequestIdRef.current
    if (qAppItemsRef.current.length === 0) {
      setIsLoading(true)
    }
    try {
      const res = await api().svcQApp.listQAppCfgs({})
      if (requestId !== refreshRequestIdRef.current) {
        return
      }
      const localItems = [
        createBuiltinHunyuan3DQApp(),
        createBuiltinDuplicateCheckQApp(),
        ...res.qApps.filter((item) => !isBuiltinProtectedQApp(item.key))
      ]

      // 先显示本地项，加快加载速度
      writeCachedQAppItems(localItems)
      setQAppItems(localItems)
      setIsLoading(false)

      // 如果启用了远程 ComfyUI，在后台拉取并合并
      if (config?.use_remote_comfyui) {
        const serverOrigin = config.remote_comfyui_config?.comfyui_origin
        if (serverOrigin) {
          // 从远程 LLM 服务获取快应用（使用 LLM 服务端口而非 ComfyUI 端口）
          const remoteOrigin = config.remote_llm_server_config?.server_origin
          if (remoteOrigin) {
            fetchRemoteQAppList(remoteOrigin, config)
              .then((remoteItems) => {
                if (requestId !== refreshRequestIdRef.current) {
                  return
                }
                if (remoteItems.length > 0) {
                  setQAppItems((prev) => {
                    const filtered = prev.filter((item) => item.key !== '~remote')
                    return [
                      ...filtered,
                      {
                        key: '~remote',
                        name: '服务端快应用',
                        isBuiltin: false,
                        isDirectory: true,
                        isRemote: true,
                        children: remoteItems
                      }
                    ]
                  })
                }
              })
              .catch((err) => {
                console.error('[QAppMenu] 后台服务拉取失败:', err)
              })
          }
        }
      }
    } catch (error) {
      if (requestId !== refreshRequestIdRef.current) {
        return
      }
      console.error('[QAppMenu] 加载失败:', error)
      notifyErrorRef.current(tRef.current('qapp.menu.load_failed'))
      setIsLoading(false)
    }
  }, [
    config?.use_remote_comfyui,
    config?.remote_comfyui_config?.comfyui_origin,
    config?.remote_llm_server_config?.server_origin
  ])

  useEffect(() => {
    refreshTabs()
  }, [refreshTabs])

  useEffect(() => {
    const handleRefreshList = () => {
      refreshTabs()
    }

    window.addEventListener('qapp:refresh-list', handleRefreshList)

    // 监听主进程文件系统变更通知（用户在资源管理器中删除/添加快应用文件时触发）
    const ipc = (
      window as {
        electron?: {
          ipcRenderer?: {
            on?: (channel: string, listener: () => void) => void
            removeListener?: (channel: string, listener: () => void) => void
          }
        }
      }
    ).electron?.ipcRenderer
    if (typeof ipc?.on === 'function') {
      ipc.on('qapp:dir-changed', handleRefreshList)
    }

    return () => {
      window.removeEventListener('qapp:refresh-list', handleRefreshList)
      if (typeof ipc?.removeListener === 'function') {
        ipc.removeListener('qapp:dir-changed', handleRefreshList)
      }
    }
  }, [refreshTabs])

  useEffect(() => {
    if (!currentQAppKey || qAppItems.length === 0) return
    const find = (items: QAppMenuItem[], k: string, p: string[] = []): string[] | null => {
      for (const i of items) {
        const np = [...p, i.key]
        if (i.key === k) return np
        if (i.children) {
          const f = find(i.children, k, np)
          if (f) return f
        }
      }
      return null
    }
    const path = find(qAppItems, currentQAppKey)
    if (!path) return
    const ancestors = path.slice(0, -1)
    if (ancestors.length)
      setExpandedKeys((p) => {
        const n = new Set(p)
        ancestors.forEach((k) => n.add(k))
        return n
      })
  }, [currentQAppKey, qAppItems])

  useEffect(() => {
    if (usedAsSelector || renderExpandedContent || qAppItems.length === 0) return
    // 没有选中项，或者选中的 key 在列表里已找不到（例如被删除），自动选第一个
    const needAutoSelect =
      !currentQAppKey ||
      (() => {
        const find = (items: QAppMenuItem[]): boolean => {
          for (const i of items) {
            if (i.key === currentQAppKey) return true
            if (i.children && find(i.children)) return true
          }
          return false
        }
        return !find(qAppItems)
      })()
    if (needAutoSelect) {
      const k = findFirstLeaf(qAppItems)
      if (k) setCurrentQAppKey(k)
    }
  }, [
    usedAsSelector,
    renderExpandedContent,
    qAppItems,
    currentQAppKey,
    setCurrentQAppKey,
    findFirstLeaf
  ])

  // ... (拖拽处理) ...
  const clearDraggingOver = useCallback(() => {
    setIsDraggingOver(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(true)
  }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(false)
  }, [])
  // 比较两个工作流的节点结构是否匹配（用于快应用匹配）
  // 使用模糊匹配：因为实际执行的工作流可能比模版多或少节点
  //  - 少节点：生成时未使用 LoRA，InputLoRAChain 不会插入 LoRA 节点
  //  - 多节点：动态插入了额外节点（如多个 LoRA）
  // 策略：检查模版中非 LoRA 核心节点在图片工作流中的匹配率 ≥ 70%
  const compareWorkflows = useCallback(
    (imageWf: Record<string, unknown>, templateWf: Record<string, unknown>): boolean => {
      try {
        const templateKeys = Object.keys(templateWf).filter((k) => !k.startsWith('__'))
        const imageKeys = Object.keys(imageWf).filter((k) => !k.startsWith('__'))

        if (templateKeys.length === 0) return false

        // 统计模版节点中有多少在图片工作流中匹配（相同节点ID + 相同class_type）
        let matched = 0
        let skipped = 0

        for (const key of templateKeys) {
          const templateNode = templateWf[key] as Record<string, unknown> | undefined
          const imageNode = imageWf[key] as Record<string, unknown> | undefined

          if (!templateNode?.class_type) {
            skipped++
            continue
          }

          // 如果是 LoRA 相关节点，不计入匹配（因为这些节点可能被动态增减）
          const classType = String(templateNode.class_type)
          if (
            classType === 'LoraLoader' ||
            classType === 'LoraLoaderModelOnly' ||
            isComfyFrontendOnlyNodeClassType(classType)
          ) {
            skipped++
            continue
          }

          if (imageNode && imageNode.class_type === templateNode.class_type) {
            matched++
          }
        }

        const coreTemplateNodes = templateKeys.length - skipped
        if (coreTemplateNodes === 0) return false

        const matchRate = matched / coreTemplateNodes
        // 同时检查图片工作流中的核心节点数不会比模版多太多（防止误匹配）
        const imageNonLoraKeys = imageKeys.filter((k) => {
          const n = imageWf[k] as Record<string, unknown> | undefined
          const ct = String(n?.class_type || '')
          return (
            ct !== 'LoraLoader' &&
            ct !== 'LoraLoaderModelOnly' &&
            !isComfyFrontendOnlyNodeClassType(ct)
          )
        })
        const sizeDiffRatio =
          Math.abs(imageNonLoraKeys.length - coreTemplateNodes) / coreTemplateNodes

        console.log(
          `[compareWorkflows] 匹配率: ${(matchRate * 100).toFixed(0)}% (${matched}/${coreTemplateNodes}), 大小差异: ${(sizeDiffRatio * 100).toFixed(0)}%`
        )

        return matchRate >= 0.7 && sizeDiffRatio <= 0.3
      } catch {
        return false
      }
    },
    []
  )

  // 从工作流匹配快应用并切换，然后填充参数
  const matchAndFillQApp = useCallback(
    async (workflow: Record<string, unknown>) => {
      // 1. 检查工作流中是否嵌入了 qAppKey
      const embeddedQAppKey = (workflow as Record<string, unknown>).__qAppKey__ as
        | string
        | undefined
      if (embeddedQAppKey) {
        console.log(`[handleDrop] 使用嵌入的 qAppKey: ${embeddedQAppKey}`)
        setCurrentQAppKey(embeddedQAppKey)
        // 等待快应用切换完成后再填充参数
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('qapp:fillParams', { detail: { workflow } }))
        }, 300)
        return true
      }

      // 2. 遍历所有快应用进行工作流结构匹配
      try {
        const qAppList = await api().svcQApp.listQAppCfgs({})
        const findAllKeys = (items: typeof qAppList.qApps): string[] => {
          const keys: string[] = []
          for (const item of items) {
            if (!item.isDirectory) keys.push(item.key)
            if (item.children) keys.push(...findAllKeys(item.children))
          }
          return keys
        }
        const allKeys = findAllKeys(qAppList.qApps)

        for (const key of allKeys) {
          try {
            const qAppData = await api().svcQApp.getQAppCfg({ key })
            if (compareWorkflows(workflow, qAppData.workflow)) {
              console.log(`[handleDrop] 匹配到快应用: ${key}`)
              setCurrentQAppKey(key)
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('qapp:fillParams', { detail: { workflow } }))
              }, 300)
              return true
            }
          } catch {
            continue
          }
        }
      } catch (error) {
        console.error('[handleDrop] 匹配快应用失败:', error)
      }

      // 3. 没有匹配到，直接在当前快应用上填充参数（可能会部分失败）
      console.warn('[handleDrop] 未匹配到快应用，使用当前快应用填充')
      window.dispatchEvent(new CustomEvent('qapp:fillParams', { detail: { workflow } }))
      return false
    },
    [setCurrentQAppKey, compareWorkflows]
  )

  // 导入 .mpqapp 文件（必须定义在 handleDrop 之前，避免 TDZ）
  const importQAppFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text()
        const currentAppVersion = buildEnv.env.packageVersion || '0.0.0'
        const parsedPackage = parseQAppPackage(
          JSON.parse(text),
          currentAppVersion,
          file.name.replace('.mpqapp', '')
        )
        const compatibilityError = getQAppCompatibilityError(
          currentAppVersion,
          parsedPackage.manifest
        )
        if (compatibilityError) {
          notifyError(compatibilityError)
          return
        }
        const data = {
          magic: 'MAGICPOT_QAPP',
          name: parsedPackage.keyName,
          cfg: parsedPackage.cfg,
          workflow: parsedPackage.workflow
        }
        if (data.magic !== 'MAGICPOT_QAPP') {
          notifyError('不是有效的魔壶快应用文件')
          return
        }
        const name = data.name || file.name.replace('.mpqapp', '')
        await api().svcQApp.saveQAppCfg({
          key: name,
          cfg: data.cfg,
          workflow: data.workflow,
          manifest: parsedPackage.manifest
        })
        clearCachedQAppState(name)
        await refreshTabs()
        setCurrentQAppKey(name)
        notifySuccess(`Imported "${name}"`)
        /*
        notifySuccess(`已导入快应用「${name}」`)
        */
      } catch (err) {
        notifyError('Quick App import failed')
        /*
        console.error('[QApp] 导入失败:', err)
        notifyError('导入快应用失败')
        */
      }
    },
    [buildEnv.env.packageVersion, notifyError, notifySuccess, refreshTabs, setCurrentQAppKey]
  )

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      clearDraggingOver()

      // 优先处理应用内拖拽的图片
      const internalPayload = parseInternalImageDragPayload(e.dataTransfer)
      if (internalPayload) {
        const importError = getQuickAppWorkflowImportError(internalPayload)
        if (importError) {
          notifyError(importError)
          return
        }

        if (hasRestorableHy3dQuickAppPayload(internalPayload) && internalPayload.hy3dParams) {
          const nextQAppKey =
            internalPayload.hy3dQuickAppKey ||
            getBuiltinHunyuan3DQuickAppKeyForAction(internalPayload.hy3dParams.apiAction)
          setCurrentQAppKey(nextQAppKey)
          window.dispatchEvent(new CustomEvent('qapp:switch', { detail: { qAppKey: nextQAppKey } }))
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent('hy3d:params-updated', {
                detail: {
                  params: internalPayload.hy3dParams
                }
              })
            )
            if (internalPayload.hy3dMediaState) {
              window.dispatchEvent(
                new CustomEvent('hy3d:media-state-updated', {
                  detail: {
                    mediaState: internalPayload.hy3dMediaState
                  }
                })
              )
            }
          }, 300)
          notifySuccess('已切换到对应的 Hunyuan3D 快应用并恢复生成参数')
          return
        }

        try {
          const wd = await extractWorkflowFromImage(
            internalPayload.objectUrl || '',
            internalPayload.promptId
          )
          if (wd) {
            const resolved = await resolveImportedWorkflow(wd.workflow)
            await matchAndFillQApp(resolved.workflow)
          } else {
            notifyError('无法从图片中提取工作流信息')
          }
        } catch (err) {
          console.error('内部图片拖拽加载失败:', err)
          notifyError('加载失败')
        }
        return
      }

      // 外部文件拖放
      const files = Array.from(e.dataTransfer.files)
      const unsupportedDropMessage = getUnsupportedQuickAppDropMessage(files)
      if (unsupportedDropMessage) {
        notifyError(unsupportedDropMessage)
        return
      }

      // 检测 .mpqapp 文件
      const qappFiles = files.filter((file) => isQuickAppBundleFile(file))
      if (qappFiles.length > 0) {
        for (const file of qappFiles) {
          await importQAppFile(file)
        }
        return
      }

      const imageFiles = files.filter((file) => isQuickAppImportImageFile(file))
      if (imageFiles.length === 0) {
        notifyError(QUICK_APP_IMPORT_PROMPT)
        return
      }
      if (imageFiles.length === 0) {
        notifyError('请拖放图片或 .mpqapp 文件')
        return
      }
      try {
        const wd = await extractWorkflowFromImage(imageFiles[0])
        if (wd) {
          const resolved = await resolveImportedWorkflow(wd.workflow)
          await matchAndFillQApp(resolved.workflow)
        }
      } catch (e) {
        notifyError('加载失败')
      }
    },
    [
      clearDraggingOver,
      importQAppFile,
      matchAndFillQApp,
      notifyError,
      notifySuccess,
      setCurrentQAppKey
    ]
  )

  const handleToggleExpand = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const handleOpenMenu = useCallback((event: React.MouseEvent<HTMLElement>, key: string) => {
    event.stopPropagation()
    setMenuAnchorEl(event.currentTarget)
    setMenuKey(key)
  }, [])

  const handleCloseMenu = () => {
    setMenuAnchorEl(null)
    setMenuKey(null)
  }

  const togglePin = (key: string) => {
    setPinnedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renameQApp = async (key: string) => {
    const name = prompt('重命名', '')
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await api().svcQApp.renameQAppCfg({ key, name: trimmed })
      renameCachedQAppState(key, trimmed)
      if (currentQAppKey === key) {
        setCurrentQAppKey(trimmed)
      }
      await refreshTabs()
    } catch {
      notifyError('重命名失败')
    }
  }

  const deleteQApp = async (key: string) => {
    const ok = window.confirm('确定删除该快应用吗？')
    if (!ok) return
    try {
      await api().svcQApp.deleteQApp({ key })
      clearCachedQAppState(key)
      if (currentQAppKey === key) {
        setCurrentQAppKey('')
      }
      await refreshTabs()
    } catch {
      notifyError('删除失败')
    }
  }

  // 导出快应用为 .mpqapp 文件
  const exportQApp = async (key: string) => {
    try {
      const { cfg, workflow, manifest } = await api().svcQApp.getQAppCfg({ key })
      const exportName = manifest?.name || key.split('/').pop() || key
      const data = {
        ...createQAppPackagePayload({
          cfg,
          workflow,
          manifest:
            manifest || buildDefaultQAppManifest(exportName, buildEnv.env.packageVersion || '0.0.0')
        }),
        name: exportName
      }
      const json = JSON.stringify(data, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${data.name}.mpqapp`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      notifySuccess(`Exported "${data.name}"`)
      /*
      notifySuccess(`已导出「${data.name}」`)
      */
    } catch (err) {
      console.error('[QApp] 导出失败:', err)
      notifyError('导出失败')
    }
  }

  return (
    <Box
      data-dragging-over={isDraggingOver ? 'true' : 'false'}
      sx={{ width: '100%', height: '100%', overflowX: 'visible', minHeight: 0 }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDropCapture={clearDraggingOver}
      onDrop={handleDrop}
    >
      <Paper
        ref={scrollRootRef}
        sx={{
          width: '100%',
          height: '100%',
          px: 1,
          pt: 0,
          pb: 1,
          overflowX: 'hidden',
          overflowY: 'overlay', // Using overlay to not take up space if possible, or auto
          display: 'flex',
          flexDirection: 'column',
          background: 'transparent',
          minHeight: 0,
          border: isDraggingOver ? '2px dashed' : '2px solid transparent',
          borderColor: isDraggingOver ? 'primary.main' : 'transparent',
          transition: 'border-color 0.2s ease'
        }}
      >
        <Box sx={{ display: 'flex', gap: 1, mb: 2, pt: 1 }}>
          <Box
            sx={(theme) => ({
              display: 'flex',
              alignItems: 'center',
              flex: 1,
              height: 38,
              bgcolor:
                theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)',
              border: '1px solid',
              borderColor:
                theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
              borderRadius: '10px',
              px: 1.5,
              transition: 'all 0.2s ease',
              '&:hover': {
                borderColor:
                  theme.palette.mode === 'dark'
                    ? 'rgba(255, 255, 255, 0.15)'
                    : 'rgba(0, 0, 0, 0.15)'
              },
              '&:focus-within': {
                borderColor:
                  theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)',
                bgcolor:
                  theme.palette.mode === 'dark'
                    ? 'rgba(255, 255, 255, 0.06)'
                    : 'rgba(0, 0, 0, 0.04)'
              }
            })}
          >
            <SearchIcon fontSize="small" sx={{ color: 'text.disabled', fontSize: 18, mr: 1 }} />
            <InputBase
              placeholder={
                isProject ? t('qapp.menu.search_project_app') : t('qapp.menu.search_app')
              }
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              sx={{
                width: '100%',
                color: 'inherit',
                '& .MuiInputBase-input': {
                  fontSize: 14,
                  p: 0,
                  border: 'none !important',
                  outline: 'none !important',
                  boxShadow: 'none !important',
                  '&::placeholder': { color: 'text.disabled', opacity: 0.7 },
                  '&:focus': {
                    border: 'none !important',
                    outline: 'none !important',
                    boxShadow: 'none !important'
                  }
                }
              }}
            />
          </Box>

          {isProject && (
            <Tooltip title={t('qapp.menu.config_project_app')}>
              <IconButton
                onClick={() => setSelectorDialogOpen(true)}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'background.paper',
                  borderRadius: 1,
                  height: 38,
                  width: 38
                }}
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>

        {/* Shipped video qapps removed */}

        <List sx={{ position: 'relative', p: 0 }}>
          {isLoading
            ? Array.from({ length: 5 }).map((_, idx) => (
                <StyledMenuItem key={idx}>
                  <Skeleton variant="text" width="80%" height={24} />
                </StyledMenuItem>
              ))
            : displayItems.map((qAppItem) => (
                <CascadingMenuItem
                  key={qAppItem.key}
                  qAppItem={qAppItem}
                  currentQAppKey={currentQAppKey}
                  setCurrentQAppKey={setCurrentQAppKey}
                  getDisplayName={getDisplayName}
                  refreshTabs={refreshTabs}
                  expandedKeys={expandedKeys}
                  usedAsSelector={usedAsSelector}
                  onMoreClick={handleOpenMenu}
                  pinnedKeys={pinnedKeys}
                  onRunClick={onRunClick}
                  isRunning={isRunning}
                  renderExpandedContent={renderExpandedContent}
                  onToggleExpand={handleToggleExpand}
                  scrollRootRef={scrollRootRef}
                />
              ))}
        </List>
        <Box sx={{ flex: 1 }} />
        {/* 拖放提示区域 */}
        <Box
          sx={{
            mt: 2,
            p: 2,
            borderRadius: 2,
            border: isDraggingOver ? '2px dashed' : '2px dashed',
            borderColor: isDraggingOver ? 'primary.main' : 'divider',
            bgcolor: isDraggingOver ? 'action.hover' : 'transparent',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0.5,
            opacity: isDraggingOver ? 1 : 0.5,
            transition: 'all 0.2s ease',
            flexShrink: 0
          }}
        >
          <ImageOutlined
            sx={{ fontSize: 28, color: isDraggingOver ? 'primary.main' : 'text.disabled' }}
          />
          <Typography
            variant="caption"
            color={isDraggingOver ? 'primary.main' : 'text.disabled'}
            textAlign="center"
            lineHeight={1.3}
          >
            {t('qapp.menu.drag_tip1')}
            <br />
            {t('qapp.menu.drag_tip2')}
          </Typography>
        </Box>
      </Paper>

      <Menu
        anchorEl={menuAnchorEl}
        open={Boolean(menuAnchorEl)}
        onClose={handleCloseMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {/* 远程快应用：隐藏置顶 / 重命名 / 删除，只能查看 */}
        {(() => {
          const isRemoteItem = menuKey?.startsWith('~remote')
          const isBuiltinItem = menuKey
            ? isBuiltinHunyuan3DMenuKey(menuKey) || isBuiltinDuplicateCheckQApp(menuKey)
            : false
          const items: React.ReactNode[] = [
            <MenuItem
              key="pin"
              onClick={() => {
                if (menuKey) togglePin(menuKey)
                handleCloseMenu()
              }}
            >
              {menuKey && pinnedKeys.has(menuKey) ? (
                <PushPinIcon fontSize="small" />
              ) : (
                <PushPinOutlinedIcon fontSize="small" />
              )}
              <Typography variant="body2" sx={{ ml: 1 }}>
                {menuKey && pinnedKeys.has(menuKey) ? t('qapp.menu.unpin') : t('qapp.menu.pin')}
              </Typography>
            </MenuItem>
          ]

          if (!isRemoteItem && !isBuiltinItem) {
            items.push(
              <MenuItem
                key="rename"
                onClick={() => {
                  if (menuKey) renameQApp(menuKey)
                  handleCloseMenu()
                }}
              >
                <EditIcon fontSize="small" />
                <Typography variant="body2" sx={{ ml: 1 }}>
                  {t('qapp.menu.rename')}
                </Typography>
              </MenuItem>
            )
          }

          if (!isBuiltinItem) {
            items.push(
              <MenuItem
                key="export"
                onClick={() => {
                  if (menuKey) exportQApp(menuKey)
                  handleCloseMenu()
                }}
              >
                <ExportQAppIcon fontSize="small" />
                <Typography variant="body2" sx={{ ml: 1 }}>
                  {t('qapp.menu.export')}
                </Typography>
              </MenuItem>
            )
          }

          if (!isRemoteItem && !isBuiltinItem) {
            items.push(
              <MenuItem
                key="delete"
                onClick={() => {
                  if (menuKey) {
                    if (isProject) {
                      // 如果在项目视图下，"删除" 操作改为从项目的激活列表中移除
                      setProjectSelectedKeys((p) => {
                        const n = new Set(p)
                        n.delete(menuKey)
                        if (activeTabId) {
                          try {
                            localStorage.setItem(
                              `qapp.selected.${activeTabId}`,
                              JSON.stringify(Array.from(n))
                            )
                          } catch {
                            // ignore
                          }
                        }
                        return n
                      })
                    } else {
                      // 正常的全局删除
                      deleteQApp(menuKey)
                    }
                  }
                  handleCloseMenu()
                }}
                sx={{ color: 'error.main' }}
              >
                <DeleteIcon fontSize="small" />
                <Typography variant="body2" sx={{ ml: 1 }}>
                  {isProject ? t('qapp.menu.remove_from_project') : t('qapp.menu.delete')}
                </Typography>
              </MenuItem>
            )
          }

          return items
        })()}
      </Menu>

      <Dialog
        open={designDialogOpen}
        onClose={() => {
          setDesignDialogOpen(false)
          refreshTabs()
        }}
        maxWidth={false}
        fullWidth
        PaperProps={{
          sx: (theme) => ({
            width: '85vw',
            maxWidth: 1200,
            height: '85vh',
            maxHeight: '85vh',
            bgcolor: 'background.default',
            backgroundImage: 'none',
            borderRadius: '16px',
            overflow: 'hidden'
          })
        }}
      >
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            p: 1.5,
            pb: 0,
            bgcolor: 'background.default'
          }}
        >
          <Typography variant="h6" sx={{ fontSize: '1rem', fontWeight: 600, ml: 1 }}>
            {t('qapp.menu.add_quick_app')}
          </Typography>
          <IconButton
            onClick={() => {
              setDesignDialogOpen(false)
              refreshTabs()
            }}
            size="small"
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
        <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <Suspense fallback={<Box sx={{ flex: 1 }} />}>
            <QAppDesignPage />
          </Suspense>
        </Box>
      </Dialog>

      <ProjectSelectorDialog
        open={selectorDialogOpen}
        onClose={() => setSelectorDialogOpen(false)}
        activeTabId={activeTabId ?? null}
        qAppItems={qAppItems}
        activeCategory={activeCategory}
        projectSelectedKeys={projectSelectedKeys}
        setProjectSelectedKeys={setProjectSelectedKeys}
        getDisplayName={getDisplayName}
      />
    </Box>
  )
}
