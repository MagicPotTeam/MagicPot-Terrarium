import { Dispatch, ReactNode, SetStateAction, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  Collapse,
  Dialog,
  DialogContent,
  IconButton,
  InputBase,
  List,
  ListItemButton,
  Checkbox,
  ListItemText,
  Stack,
  Typography
} from '@mui/material'
import {
  Search as SearchIcon,
  Close as CloseIcon,
  FolderOutlined as FolderOutlinedIcon,
  ChevronRight as ChevronRightIcon,
  ExpandMore as ExpandMoreIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { QAppMenuItem } from '@shared/api/svcQApp'
import { inferQAppCategory, type QAppCategory } from '@shared/qApp/category'
import { buildQAppSelectorSearchText } from './qAppSelectorLabels'

const countSelectableItems = (items: QAppMenuItem[]): number =>
  items.reduce((total, item) => {
    if (item.isDirectory) {
      return total + countSelectableItems(item.children ?? [])
    }
    return total + 1
  }, 0)

const collectSelectableKeys = (items: QAppMenuItem[]): string[] =>
  items.reduce<string[]>((result, item) => {
    if (item.isDirectory) {
      result.push(...collectSelectableKeys(item.children ?? []))
      return result
    }

    result.push(item.key)
    return result
  }, [])

const matchesSelectorDirectory = (
  item: Pick<QAppMenuItem, 'key' | 'name'>,
  keyword: string,
  getDisplayName: (value?: string) => string
): boolean =>
  [getDisplayName(item.name), item.name, item.key]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(keyword)

const filterSelectorItems = (
  items: QAppMenuItem[],
  keyword: string,
  getDisplayName: (value?: string) => string
): QAppMenuItem[] =>
  items.reduce<QAppMenuItem[]>((result, item) => {
    if (item.isDirectory) {
      if (matchesSelectorDirectory(item, keyword, getDisplayName)) {
        result.push(item)
        return result
      }

      const filteredChildren = filterSelectorItems(item.children ?? [], keyword, getDisplayName)
      if (filteredChildren.length > 0) {
        result.push({
          ...item,
          children: filteredChildren
        })
      }
      return result
    }

    if (buildQAppSelectorSearchText(item, getDisplayName).includes(keyword)) {
      result.push(item)
    }

    return result
  }, [])

const collectDirectoryKeys = (items: QAppMenuItem[]): string[] =>
  items.reduce<string[]>((result, item) => {
    if (!item.isDirectory) {
      return result
    }

    result.push(item.key)
    if (item.children?.length) {
      result.push(...collectDirectoryKeys(item.children))
    }

    return result
  }, [])

const filterItemsByCategory = (
  items: QAppMenuItem[],
  activeCategory?: QAppCategory
): QAppMenuItem[] => {
  if (!activeCategory) {
    return items
  }

  return items
    .map((item) => {
      if (item.isDirectory) {
        const children = filterItemsByCategory(item.children ?? [], activeCategory)
        return children.length > 0 ? { ...item, children } : null
      }

      const itemCategory = inferQAppCategory({
        key: item.key,
        name: item.name,
        category: item.category
      })
      return itemCategory === activeCategory ? item : null
    })
    .filter((item): item is QAppMenuItem => item !== null)
}

type ProjectSelectorDialogProps = {
  open: boolean
  onClose: () => void
  activeTabId: string | null
  qAppItems: QAppMenuItem[]
  activeCategory?: QAppCategory
  projectSelectedKeys: Set<string>
  setProjectSelectedKeys: Dispatch<SetStateAction<Set<string>>>
  getDisplayName: (value?: string) => string
}

export const ProjectSelectorDialog = ({
  open,
  onClose,
  activeTabId,
  qAppItems,
  activeCategory,
  projectSelectedKeys,
  setProjectSelectedKeys,
  getDisplayName
}: ProjectSelectorDialogProps) => {
  const { t } = useTranslation()
  const [selectorSearchKeyword, setSelectorSearchKeyword] = useState('')
  const [expandedDirectoryKeys, setExpandedDirectoryKeys] = useState<Set<string>>(new Set())
  const keyword = selectorSearchKeyword.toLowerCase().trim()

  const categoryItems = useMemo(
    () => filterItemsByCategory(qAppItems, activeCategory),
    [activeCategory, qAppItems]
  )

  useEffect(() => {
    if (!open) {
      setSelectorSearchKeyword('')
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    setExpandedDirectoryKeys(new Set(collectDirectoryKeys(categoryItems)))
  }, [categoryItems, open])

  const visibleItems = useMemo(() => {
    if (!keyword) {
      return categoryItems
    }
    return filterSelectorItems(categoryItems, keyword, getDisplayName)
  }, [categoryItems, getDisplayName, keyword])

  const hasVisibleItems = useMemo(() => countSelectableItems(visibleItems) > 0, [visibleItems])

  const persistSelection = (update: (current: Set<string>) => Set<string>) => {
    setProjectSelectedKeys((previous) => {
      const next = update(new Set(previous))

      if (activeTabId) {
        try {
          localStorage.setItem(`qapp.selected.${activeTabId}`, JSON.stringify(Array.from(next)))
        } catch {
          // ignore
        }
      }

      return next
    })
  }

  const toggleSelection = (key: string) => {
    persistSelection((next) => {
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleDirectory = (key: string) => {
    setExpandedDirectoryKeys((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderTree = (items: QAppMenuItem[], depth = 0): ReactNode =>
    items.map((item) => {
      const displayName = getDisplayName(item.name) || item.name || item.key
      if (item.isDirectory) {
        const visibleCount = countSelectableItems(item.children ?? [])
        const selectableKeys = collectSelectableKeys(item.children ?? [])
        const isExpanded = keyword ? true : expandedDirectoryKeys.has(item.key)
        const selectedCount = selectableKeys.filter((key) => projectSelectedKeys.has(key)).length
        const isChecked = selectableKeys.length > 0 && selectedCount === selectableKeys.length
        const isIndeterminate = selectedCount > 0 && selectedCount < selectableKeys.length
        return (
          <Box key={item.key}>
            <ListItemButton
              onClick={() => toggleDirectory(item.key)}
              sx={{
                py: 0.75,
                pr: 3,
                pl: 3 + depth * 2.75,
                minHeight: 42
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
                <Checkbox
                  checked={isChecked}
                  indeterminate={isIndeterminate}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => {
                    persistSelection((next) => {
                      if (isChecked) {
                        selectableKeys.forEach((key) => next.delete(key))
                      } else {
                        selectableKeys.forEach((key) => next.add(key))
                      }
                      return next
                    })
                  }}
                  inputProps={{ 'aria-label': `Select folder ${item.key}` }}
                  sx={{ p: 0.5 }}
                />
                {isExpanded ? (
                  <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                ) : (
                  <ChevronRightIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                )}
                <FolderOutlinedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                <Typography
                  variant="subtitle2"
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: depth === 0 ? 15 : 14,
                    fontWeight: 700,
                    color: 'text.primary'
                  }}
                >
                  {displayName}
                </Typography>
                <Chip
                  label={visibleCount}
                  size="small"
                  sx={{
                    height: 20,
                    bgcolor: 'action.hover',
                    '& .MuiChip-label': { px: 1, fontSize: 11, fontWeight: 600 }
                  }}
                />
              </Stack>
            </ListItemButton>
            <Collapse in={isExpanded} timeout="auto" unmountOnExit>
              {item.children?.length ? renderTree(item.children, depth + 1) : null}
            </Collapse>
          </Box>
        )
      }

      const checked = projectSelectedKeys.has(item.key)
      const secondaryLabel = item.key.includes('/') ? item.key.replace(/\//g, ' / ') : undefined

      return (
        <ListItemButton
          key={item.key}
          onClick={() => toggleSelection(item.key)}
          sx={{
            py: 1.25,
            pr: 3,
            pl: 3 + depth * 2.75,
            alignItems: 'flex-start'
          }}
        >
          <Checkbox
            checked={checked}
            onClick={(event) => event.stopPropagation()}
            onChange={() => toggleSelection(item.key)}
            inputProps={{ 'aria-label': `Select ${item.key}` }}
            sx={{ p: 0.5, mr: 2, mt: 0.25 }}
          />
          <ListItemText
            primary={displayName}
            secondary={secondaryLabel}
            primaryTypographyProps={{ fontSize: 15, fontWeight: 500 }}
            secondaryTypographyProps={{
              fontSize: 12,
              color: 'text.secondary',
              sx: { mt: 0.25 }
            }}
          />
        </ListItemButton>
      )
    })

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: (theme) => ({
          borderRadius: '16px',
          maxHeight: '80vh',
          minHeight: '60vh',
          bgcolor: 'background.default',
          backgroundImage: 'none'
        })
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', p: 2, pb: 0 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6" sx={{ fontSize: '1.2rem', fontWeight: 600 }}>
            {t('qapp.menu.config_project_app')}
          </Typography>
          <IconButton onClick={onClose} size="small">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
        <Box
          sx={(theme) => ({
            display: 'flex',
            alignItems: 'center',
            height: 48,
            bgcolor:
              theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)',
            border: '1px solid',
            borderColor:
              theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
            borderRadius: '10px',
            px: 2,
            mb: 2,
            transition: 'all 0.2s ease',
            '&:hover': {
              borderColor:
                theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)'
            },
            '&:focus-within': {
              borderColor:
                theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)',
              bgcolor:
                theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)'
            }
          })}
        >
          <SearchIcon sx={{ color: 'text.disabled', fontSize: 18, mr: 1 }} />
          <InputBase
            autoFocus
            placeholder={t('qapp.menu.search_repo_app')}
            value={selectorSearchKeyword}
            onChange={(e) => setSelectorSearchKeyword(e.target.value)}
            sx={{
              width: '100%',
              color: 'inherit',
              '& .MuiInputBase-input': {
                fontSize: 15,
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
      </Box>
      <DialogContent dividers sx={{ p: 0, bgcolor: 'background.paper' }}>
        <List sx={{ pt: 1, pb: 1 }}>
          {hasVisibleItems ? (
            renderTree(visibleItems)
          ) : (
            <Box sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
              {t('qapp.menu.no_qapp_available')}
            </Box>
          )}
        </List>
      </DialogContent>
    </Dialog>
  )
}
