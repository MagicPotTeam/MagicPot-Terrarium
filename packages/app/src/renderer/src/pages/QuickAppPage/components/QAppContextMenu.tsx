import { Menu, MenuItem, Typography } from '@mui/material'
import {
  PushPin as PushPinIcon,
  PushPinOutlined as PushPinOutlinedIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  FileDownload as ExportQAppIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { SetStateAction, Dispatch } from 'react'

export type QAppContextMenuProps = {
  menuAnchorEl: HTMLElement | null
  menuKey: string | null
  handleCloseMenu: () => void
  pinnedKeys: Set<string>
  togglePin: (key: string) => void
  renameQApp: (key: string) => void
  exportQApp: (key: string) => void
  isProject: boolean
  activeTabId: string | null
  setProjectSelectedKeys: Dispatch<SetStateAction<Set<string>>>
  deleteQApp: (key: string) => void
}

export const QAppContextMenu = ({
  menuAnchorEl,
  menuKey,
  handleCloseMenu,
  pinnedKeys,
  togglePin,
  renameQApp,
  exportQApp,
  isProject,
  activeTabId,
  setProjectSelectedKeys,
  deleteQApp
}: QAppContextMenuProps) => {
  const { t } = useTranslation()
  const isRemoteItem = menuKey?.startsWith('~remote')

  return (
    <Menu
      anchorEl={menuAnchorEl}
      open={Boolean(menuAnchorEl)}
      onClose={handleCloseMenu}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
      <MenuItem
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
      {!isRemoteItem && (
        <MenuItem
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
      )}
      <MenuItem
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
      {!isRemoteItem && (
        <MenuItem
          onClick={() => {
            if (menuKey) {
              if (isProject) {
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
      )}
    </Menu>
  )
}
