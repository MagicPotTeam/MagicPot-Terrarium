import { memo, useState, useRef, useEffect } from 'react'
import { Box, Collapse, IconButton, List, ListItemButton, styled } from '@mui/material'
import { ExpandMore, ChevronRight, PlayArrow as PlayArrowIcon } from '@mui/icons-material'
import { useComfyEventCallback } from '@renderer/hooks/useComfyEvent'
import { QAppMenuItem } from '@shared/api/svcQApp'
import { isBuiltinDuplicateCheckQApp } from '../duplicateCheck/builtin'

const overflowWidth = 14
const leftOverflow = overflowWidth + 4
const r = 0 // originally 22, changed to 0 for rectangular edges

export const StyledMenuItem = styled(ListItemButton as typeof ListItemButton, {
  shouldForwardProp: (prop) => prop !== '$isDir'
})<{ $isDir?: boolean }>(({ theme, $isDir }) => {
  return {
    display: 'flex',
    border: 0,
    borderRadius: 0,
    position: 'relative',
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
      zIndex: -1
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

export type CascadingMenuItemProps = {
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
}

export const CascadingMenuItem = memo(
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
    renderExpandedContent
  }: CascadingMenuItemProps) => {
    const isSelected = currentQAppKey === qAppItem.key
    const isChild = depth > 0
    const isDirectory = !!qAppItem.isDirectory
    const isExpanded = isDirectory && expandedKeys.has(qAppItem.key)
    const displayName = getDisplayName(qAppItem.name) || getDisplayName(qAppItem.key)
    const canCancelRun = isBuiltinDuplicateCheckQApp(qAppItem.key) && Boolean(isRunning)

    // 进度条状态
    const [progress, setProgress] = useState(0)
    const isSelectedRef = useRef(isSelected)
    useEffect(() => {
      isSelectedRef.current = isSelected
    }, [isSelected])

    useComfyEventCallback((event) => {
      if (!isSelectedRef.current) return
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

    return (
      <>
        <StyledMenuItem
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
            if (!isDirectory) {
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
            ...(isStickyActive && {
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
            }),
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
            {!isDirectory && onRunClick && isSelected && (
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
                  color: canCancelRun ? '#fff' : '#7E73FD',
                  bgcolor: canCancelRun ? '#d32f2f' : '#ffffff',
                  borderRadius: 1,
                  boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
                  transition:
                    'background-color 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease',
                  '&:hover': {
                    bgcolor: canCancelRun ? '#b71c1c' : '#f8f8f8',
                    transform: 'scale(1.12)',
                    boxShadow: '0 4px 8px rgba(0,0,0,0.2)'
                  },
                  '&:active': {
                    transform: 'scale(0.95)'
                  }
                }}
              >
                {canCancelRun ? (
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
                ml: 2,
                pl: 1,
                py: 0.5,
                overflow: 'hidden'
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
      prevProps.renderExpandedContent !== nextProps.renderExpandedContent
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
