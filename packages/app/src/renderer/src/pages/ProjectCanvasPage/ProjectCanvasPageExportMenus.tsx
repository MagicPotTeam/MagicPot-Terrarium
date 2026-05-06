import React from 'react'
import { Box, Button, Menu, MenuItem, TextField, Typography, ListItemText } from '@mui/material'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'

type TranslateFn = (key: string, options?: Record<string, unknown>) => string

type ExportScope = 'scene' | 'selected-scene' | 'all-elements' | 'selected-elements'
type ExportFormat = 'png' | 'jpeg' | 'svg'
type AnchorPosition = { x: number; y: number } | null
type ToolShortcutContextMenu = { x: number; y: number; toolKey: string } | null

interface ProjectCanvasPageExportMenusProps {
  closeExportMenus: () => void
  exportCtxMenuPos: AnchorPosition
  exportMenuAnchor: HTMLElement | null
  exportSubmenuAnchor: HTMLElement | null
  exportSubmenuPlacement: 'left' | 'right'
  exportableItems: readonly unknown[]
  handleCloseExportContextMenu: () => void
  handleCloseExportSubmenu: () => void
  handleExportCanvasProjectFile: () => void | Promise<void>
  handleExportScopeWithFormat: (scope: ExportScope, format: ExportFormat) => void
  handleSaveCanvas: () => void | Promise<void>
  handleSaveCanvasAs: () => void | Promise<void>
  handleSaveCanvasAsFromContextMenu: () => void | Promise<void>
  openExportSubmenu: (anchorEl: HTMLElement) => void
  selectedExportableItems: readonly unknown[]
  selectedIds: Set<string>
  setToolShortcutCtxMenu: (value: ToolShortcutContextMenu) => void
  setToolShortcutRecorded: (value: string) => void
  t: TranslateFn
  toolShortcutCtxMenu: ToolShortcutContextMenu
  toolShortcutRecorded: string
  toolShortcuts: Record<string, string>
  updateToolShortcut: (toolKey: string, combo: string) => void
}

export default function ProjectCanvasPageExportMenus({
  closeExportMenus,
  exportCtxMenuPos,
  exportMenuAnchor,
  exportSubmenuAnchor,
  exportSubmenuPlacement,
  exportableItems,
  handleCloseExportContextMenu,
  handleCloseExportSubmenu,
  handleExportCanvasProjectFile,
  handleExportScopeWithFormat,
  handleSaveCanvas,
  handleSaveCanvasAs,
  handleSaveCanvasAsFromContextMenu,
  openExportSubmenu,
  selectedExportableItems,
  selectedIds,
  setToolShortcutCtxMenu,
  setToolShortcutRecorded,
  t,
  toolShortcutCtxMenu,
  toolShortcutRecorded,
  toolShortcuts,
  updateToolShortcut
}: ProjectCanvasPageExportMenusProps) {
  return (
    <>
      <Menu
        anchorEl={exportMenuAnchor}
        open={Boolean(exportMenuAnchor)}
        onClose={closeExportMenus}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <MenuItem
          onClick={() => void handleSaveCanvas()}
          sx={{ minWidth: 240, gap: 3, justifyContent: 'space-between' }}
        >
          <ListItemText primary={t('canvas.action_save')} />
          <Typography variant="body2" sx={{ color: 'text.secondary', flexShrink: 0 }}>
            {toolShortcuts.export}
          </Typography>
        </MenuItem>
        <MenuItem
          onClick={() => void handleSaveCanvasAs()}
          sx={{ minWidth: 240, gap: 3, justifyContent: 'space-between' }}
        >
          <ListItemText primary={t('canvas.action_export_save_as')} />
          <Typography variant="body2" sx={{ color: 'text.secondary', flexShrink: 0 }}>
            Ctrl+Shift+S
          </Typography>
        </MenuItem>
        <MenuItem
          onClick={() => void handleExportCanvasProjectFile()}
          sx={{ minWidth: 240, gap: 3, justifyContent: 'space-between' }}
        >
          <ListItemText primary={t('canvas.action_export_mpcanvas')} />
        </MenuItem>
        <MenuItem
          onClick={(e) => openExportSubmenu(e.currentTarget)}
          onMouseEnter={(e) => openExportSubmenu(e.currentTarget)}
          sx={{ minWidth: 240, gap: 3, justifyContent: 'space-between' }}
        >
          <ListItemText primary={t('canvas.action_export')} />
          <ChevronRightIcon fontSize="small" color="action" />
        </MenuItem>
      </Menu>

      <Menu
        anchorEl={exportSubmenuAnchor}
        open={Boolean(exportSubmenuAnchor)}
        onClose={handleCloseExportSubmenu}
        anchorOrigin={{
          vertical: 'top',
          horizontal: exportSubmenuPlacement === 'right' ? 'right' : 'left'
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: exportSubmenuPlacement === 'right' ? 'left' : 'right'
        }}
        sx={{
          '& .MuiPaper-root': exportSubmenuPlacement === 'right' ? { ml: 1 } : { mr: 1 }
        }}
      >
        <Box sx={{ minWidth: 348, py: 0.5 }}>
          {[
            {
              scope: 'scene' as const,
              label: t('canvas.action_export_scene'),
              shortcut: 'Ctrl+E',
              disabled: false
            },
            {
              scope: 'selected-scene' as const,
              label: t('canvas.action_export_selected_scene'),
              shortcut: 'Ctrl+Shift+E',
              disabled: selectedIds.size === 0
            },
            {
              scope: 'all-elements' as const,
              label: t('canvas.action_export_all_images'),
              shortcut: 'Ctrl+Alt+I',
              disabled: exportableItems.length === 0
            },
            {
              scope: 'selected-elements' as const,
              label: t('canvas.action_export_selected_images'),
              shortcut: 'Ctrl+Shift+I',
              disabled: selectedExportableItems.length === 0
            }
          ].map((option, index) => (
            <React.Fragment key={option.scope}>
              {index === 2 && (
                <Box sx={{ my: 0.5, borderTop: '1px solid', borderColor: 'divider' }} />
              )}
              <Box
                sx={{
                  px: 1.5,
                  py: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  opacity: option.disabled ? 0.45 : 1
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {option.label}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {option.shortcut}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={option.disabled}
                  onClick={() => handleExportScopeWithFormat(option.scope, 'png')}
                  sx={{ minWidth: 58, px: 1.25 }}
                >
                  PNG
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={option.disabled}
                  onClick={() => handleExportScopeWithFormat(option.scope, 'jpeg')}
                  sx={{ minWidth: 58, px: 1.25 }}
                >
                  JPG
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={option.disabled}
                  onClick={() => handleExportScopeWithFormat(option.scope, 'svg')}
                  sx={{ minWidth: 58, px: 1.25 }}
                >
                  SVG
                </Button>
              </Box>
            </React.Fragment>
          ))}
        </Box>
      </Menu>

      <Menu
        open={exportCtxMenuPos !== null}
        onClose={handleCloseExportContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          exportCtxMenuPos ? { top: exportCtxMenuPos.y, left: exportCtxMenuPos.x } : undefined
        }
      >
        <MenuItem onClick={() => void handleSaveCanvasAsFromContextMenu()}>
          <ListItemText primary={t('canvas.action_export_save_as')} />
        </MenuItem>
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', mb: 0.5, display: 'block' }}>
            {t('canvas.action_export_set_shortcut', { shortcut: toolShortcuts.export })}
          </Typography>
          <TextField
            size="small"
            variant="outlined"
            placeholder={t('canvas.export_shortcut_placeholder')}
            value={toolShortcutRecorded}
            InputProps={{ readOnly: true }}
            onKeyDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const parts: string[] = []
              if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
              if (e.altKey) parts.push('Alt')
              if (e.shiftKey) parts.push('Shift')
              const key = e.key
              if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
                parts.push(key.length === 1 ? key.toUpperCase() : key)
              }
              if (parts.length > 0) {
                const combo = parts.join('+')
                setToolShortcutRecorded(combo)
                updateToolShortcut('export', combo)
                setTimeout(() => {
                  handleCloseExportContextMenu()
                  setToolShortcutRecorded('')
                }, 400)
              }
            }}
            sx={{
              width: '100%',
              '& input': { textAlign: 'center', fontWeight: 700, fontSize: 13, py: 0.5 }
            }}
          />
        </Box>
      </Menu>

      <Menu
        open={toolShortcutCtxMenu !== null}
        onClose={() => setToolShortcutCtxMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          toolShortcutCtxMenu
            ? { top: toolShortcutCtxMenu.y, left: toolShortcutCtxMenu.x }
            : undefined
        }
      >
        <Box sx={{ px: 2, py: 1, minWidth: 180 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', mb: 0.5, display: 'block' }}>
            {t('canvas.action_export_set_shortcut', {
              shortcut: toolShortcutCtxMenu ? toolShortcuts[toolShortcutCtxMenu.toolKey] : ''
            })}
          </Typography>
          <TextField
            size="small"
            placeholder={t('canvas.export_shortcut_placeholder')}
            value={toolShortcutRecorded}
            InputProps={{ readOnly: true }}
            autoFocus
            onKeyDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const parts: string[] = []
              if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
              if (e.altKey) parts.push('Alt')
              if (e.shiftKey) parts.push('Shift')
              const key = e.key
              if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
                parts.push(key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key)
              }
              if (parts.length > 0 && toolShortcutCtxMenu) {
                const combo = parts.join('+')
                setToolShortcutRecorded(combo)
                updateToolShortcut(toolShortcutCtxMenu.toolKey, combo)
                setTimeout(() => {
                  setToolShortcutCtxMenu(null)
                  setToolShortcutRecorded('')
                }, 400)
              }
            }}
            sx={{
              width: '100%',
              '& input': { textAlign: 'center', fontWeight: 700, fontSize: 13, py: 0.5 }
            }}
          />
        </Box>
      </Menu>
    </>
  )
}
