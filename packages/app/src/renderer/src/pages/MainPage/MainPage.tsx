import React, { useState, useEffect, useRef } from 'react'
import {
  Box,
  Typography,
  Divider,
  Card,
  CardContent,
  IconButton,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  InputBase,
  Checkbox,
  FormControlLabel,
  CircularProgress
} from '@mui/material'
import { AddBox, Edit, Delete, FolderOpenRounded } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { flushSync } from 'react-dom'
import { useAppDispatch } from '../../store'
import { openTab, setActiveTab, updateTabLabel, closeTab } from '../../store/slices/layoutSlice'
import { toProjectCanvasRoutePath } from '../ProjectCanvasPage/projectCanvasRouting'
import {
  createProjectRecord,
  listProjects,
  saveProjects,
  touchProjectOpen,
  type ProjectRecord
} from './projectStore'

// Prefetch the ProjectCanvas route chunk so navigation after creating a project is instant.
let projectCanvasPagePrefetchPromise: Promise<unknown> | null = null
const prefetchProjectCanvasPage = () => {
  if (!projectCanvasPagePrefetchPromise) {
    projectCanvasPagePrefetchPromise = import('../ProjectCanvasPage/ProjectCanvasPage').catch(
      (error) => {
        console.warn('[MainPage] Failed to prefetch ProjectCanvasPage:', error)
        projectCanvasPagePrefetchPromise = null
        return undefined
      }
    )
  }
  return projectCanvasPagePrefetchPromise
}

const PURPLE_MAIN = '#2d2464'
const PURPLE_LIGHT = '#8b3a8f'
const SIDE_SHADOW_LIGHT = '8px 0 16px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.12)'
const SIDE_SHADOW_DARK = '8px 0 14px rgba(0,0,0,0.45), 0 8px 18px rgba(0,0,0,0.55)'

const scheduleIdle = (callback: () => void, timeout = 1500): (() => void) => {
  const idleApi = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }

  if (typeof idleApi.requestIdleCallback === 'function') {
    const id = idleApi.requestIdleCallback(callback, { timeout })
    return () => {
      if (typeof idleApi.cancelIdleCallback === 'function') {
        idleApi.cancelIdleCallback(id)
      }
    }
  }

  const timer = window.setTimeout(callback, timeout)
  return () => window.clearTimeout(timer)
}

type ProjectItem = ProjectRecord

const ProjectCardMark: React.FC<{ hovered: boolean }> = ({ hovered }) => (
  <Box
    sx={{
      position: 'absolute',
      zIndex: 0,
      right: 8,
      bottom: 8,
      width: 64,
      height: 64,
      pointerEvents: 'none',
      userSelect: 'none'
    }}
  >
    <FolderOpenRounded
      sx={(theme) => ({
        position: 'absolute',
        right: hovered ? 2 : 0,
        bottom: hovered ? 2 : 0,
        fontSize: 56,
        color: hovered
          ? 'rgba(255,255,255,0.22)'
          : theme.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.18)'
            : 'rgba(72,86,130,0.2)',
        transform: hovered ? 'scale(1.06)' : 'scale(1)',
        transformOrigin: 'right bottom',
        transition: 'transform 120ms ease, color 120ms ease'
      })}
    />
  </Box>
)

const ProjectCard: React.FC<{
  project: ProjectItem
  onClick: () => void
  onDelete: () => void
  onEdit: (name: string) => void
  autoEdit?: boolean
  onAutoEditDone?: () => void
}> = ({ project, onClick, onDelete, onEdit, autoEdit, onAutoEditDone }) => {
  const [hovered, setHovered] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(project.name)
  const autoEditTriggered = useRef(false)

  useEffect(() => {
    setEditName(project.name)
  }, [project.name])

  useEffect(() => {
    if (autoEdit && !autoEditTriggered.current) {
      autoEditTriggered.current = true
      setIsEditing(true)
    }
  }, [autoEdit])

  const handleSave = () => {
    if (editName.trim() && editName.trim() !== project.name) {
      onEdit(editName.trim())
    } else {
      setEditName(project.name)
    }
    setIsEditing(false)
    onAutoEditDone?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.stopPropagation()
      handleSave()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setEditName(project.name)
      setIsEditing(false)
      onAutoEditDone?.()
    }
  }

  return (
    <Card
      onMouseEnter={() => {
        setHovered(true)
        void prefetchProjectCanvasPage()
      }}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      sx={(t) => ({
        position: 'relative',
        height: 150,
        cursor: 'pointer',
        borderRadius: 3,
        overflow: 'hidden',
        background: hovered
          ? `linear-gradient(135deg, ${PURPLE_MAIN} 0%, ${PURPLE_LIGHT} 100%)`
          : t.palette.background.paper,
        color: hovered ? '#fff' : t.palette.text.primary,
        border: hovered ? '1px solid transparent' : `1px solid ${t.palette.divider}`,
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
        <Delete sx={{ fontSize: 18 }} />
      </IconButton>
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
          {isEditing ? (
            <InputBase
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.target.select()}
              sx={{
                flex: 1,
                fontSize: 18,
                fontWeight: 700,
                lineHeight: 1.2,
                color: 'inherit',
                p: 0,
                width: '100%',
                minWidth: 0,
                outline: 'none',
                input: {
                  p: 0,
                  textOverflow: 'ellipsis',
                  outline: 'none',
                  border: 'none',
                  boxShadow: 'none',
                  '&:focus': {
                    outline: 'none',
                    boxShadow: 'none',
                    border: 'none'
                  },
                  '&::selection': {
                    backgroundColor: 'rgba(55,130,250,0.55)'
                  }
                }
              }}
            />
          ) : (
            <>
              <Typography
                variant="subtitle1"
                sx={{
                  fontWeight: 700,
                  fontSize: 18,
                  lineHeight: 1.2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'inherit',
                  flex: '0 1 auto'
                }}
                title={project.name}
              >
                {project.name}
              </Typography>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation()
                  setIsEditing(true)
                }}
                sx={{
                  opacity: 0.6,
                  transition: 'opacity .2s ease, background .2s ease',
                  color: hovered ? 'rgba(255,255,255,0.85)' : 'text.secondary',
                  p: '4px',
                  ml: 0.5,
                  flexShrink: 0,
                  '&:hover': {
                    opacity: 1,
                    bgcolor: hovered ? 'rgba(255,255,255,0.2)' : 'action.hover',
                    color: hovered ? '#fff' : 'primary.main'
                  }
                }}
              >
                <Edit sx={{ fontSize: 16 }} />
              </IconButton>
            </>
          )}
        </Box>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 400,
            fontSize: 13,
            lineHeight: 1.3,
            opacity: 0.65,
            color: 'inherit',
            mt: 1
          }}
        >
          {(() => {
            const dt = new Date(project.createdAt)
            const y = dt.getFullYear()
            const m = dt.getMonth() + 1
            const d = dt.getDate()
            const hh = dt.getHours().toString().padStart(2, '0')
            const mm = dt.getMinutes().toString().padStart(2, '0')
            return `${y}/${m}/${d} ${hh}:${mm}`
          })()}
        </Typography>
      </CardContent>

      <ProjectCardMark hovered={hovered} />
    </Card>
  )
}

const MainPage: React.FC = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  const [projects, setProjects] = useState<ProjectItem[]>(listProjects())
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null)
  const [newlyCreatedId, setNewlyCreatedId] = useState<string | null>(null)

  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const openProjectTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return scheduleIdle(() => {
      void prefetchProjectCanvasPage()
    })
  }, [])

  useEffect(() => {
    return () => {
      if (openProjectTimerRef.current != null) {
        window.clearTimeout(openProjectTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const handleProjectCreated = () => {
      setProjects(listProjects())
    }
    window.addEventListener('app:project-created', handleProjectCreated)
    return () => window.removeEventListener('app:project-created', handleProjectCreated)
  }, [])

  const handleCreateProject = () => {
    const id = `tab-project-${Date.now()}`
    const routePath = toProjectCanvasRoutePath(id)

    // Auto-generate name: find the next available number
    const existingNumbers = projects
      .map((p) => {
        const match = p.name.match(/^(\d+)$/)
        return match ? parseInt(match[1], 10) : 0
      })
      .filter((n) => n > 0)
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1
    const autoName = String(nextNumber)

    const newItem = createProjectRecord({
      id,
      name: autoName,
      createdAt: Date.now()
    })
    const updated = [newItem, ...projects]
    setProjects(updated)
    saveProjects(updated)
    dispatch(
      openTab({
        id,
        label: autoName,
        routePath,
        closable: true
      })
    )
    dispatch(setActiveTab(id))
    setNewlyCreatedId(id)
  }

  const doDeleteProject = (id: string) => {
    const updated = projects.filter((p) => p.id !== id)
    setProjects(updated)
    saveProjects(updated)
    dispatch(closeTab(id))
  }

  const handleDeleteProject = (id: string) => {
    const shouldConfirm = localStorage.getItem('confirmDeleteProject') !== 'false'
    if (!shouldConfirm) {
      doDeleteProject(id)
    } else {
      setDontAskAgain(false)
      setDeleteProjectId(id)
    }
  }

  const confirmDeleteProject = () => {
    if (deleteProjectId) {
      if (dontAskAgain) {
        localStorage.setItem('confirmDeleteProject', 'false')
      }
      doDeleteProject(deleteProjectId)
      setDeleteProjectId(null)
    }
  }

  const handleRenameProject = (id: string, newName: string) => {
    if (!newName.trim()) return
    const updated = projects.map((p) => {
      if (p.id === id) {
        return { ...p, name: newName.trim() }
      }
      return p
    })
    setProjects(updated)
    saveProjects(updated)
    dispatch(updateTabLabel({ id, label: newName.trim() }))
  }

  const handleOpenProject = (p: ProjectItem) => {
    const routePath = toProjectCanvasRoutePath(p.id)
    void prefetchProjectCanvasPage()
    touchProjectOpen(p.id)

    flushSync(() => {
      setOpeningProjectId(p.id)
    })

    if (openProjectTimerRef.current != null) {
      window.clearTimeout(openProjectTimerRef.current)
    }

    openProjectTimerRef.current = window.setTimeout(() => {
      dispatch(openTab({ id: p.id, label: p.name, routePath, closable: true }))
      dispatch(setActiveTab(p.id))
      navigate(routePath)
    }, 0)
  }

  return (
    <Stack spacing={0} sx={{ height: '100%', bgcolor: 'background.default', position: 'relative' }}>
      <Box sx={{ flex: 1, overflowY: 'auto', p: 3 }}>
        <Stack spacing={3}>
          <Box>
            <Typography
              variant="h6"
              sx={{
                fontWeight: 'bold',
                color: (t) => t.palette.menu.inactive,
                mb: 1
              }}
            >
              {t('project.my')}
            </Typography>
            <Divider sx={{ borderColor: 'divider' }} />
          </Box>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 2
            }}
          >
            {/* New Project Card */}
            <Card
              onClick={handleCreateProject}
              onMouseEnter={() => void prefetchProjectCanvasPage()}
              sx={(theme) => ({
                position: 'relative',
                height: 150,
                cursor: 'pointer',
                borderRadius: 3,
                overflow: 'hidden',
                background:
                  theme.palette.mode === 'dark'
                    ? 'rgba(255,255,255,0.04)'
                    : theme.palette.background.paper,
                border: `1.5px dashed ${theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.2)'}`,
                boxShadow: 'none',
                transition:
                  'transform .2s ease, box-shadow .2s ease, background .2s ease, border-color .2s ease',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.5,
                '&:hover': {
                  transform: 'translateY(-6px)',
                  background:
                    theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.03)',
                  borderColor:
                    theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)',
                  '& .add-label': {
                    color: theme.palette.mode === 'dark' ? '#fff' : theme.palette.text.primary
                  },
                  '& .add-icon': {
                    color: theme.palette.mode === 'dark' ? '#fff' : theme.palette.text.primary
                  }
                }
              })}
            >
              <AddBox
                className="add-icon"
                sx={(theme) => ({
                  fontSize: 38,
                  color: theme.palette.mode === 'dark' ? '#b0adc0' : '#5a5870',
                  transition: 'color .2s ease'
                })}
              />
              <Typography
                className="add-label"
                variant="subtitle1"
                sx={(theme) => ({
                  fontWeight: 700,
                  fontSize: 15,
                  color: theme.palette.mode === 'dark' ? '#d4d2e0' : '#3a3850',
                  transition: 'color .2s ease',
                  mt: 0.5
                })}
              >
                {t('project.new')}
              </Typography>
            </Card>

            {/* Render projects */}
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onClick={() => handleOpenProject(p)}
                onDelete={() => handleDeleteProject(p.id)}
                onEdit={(name) => handleRenameProject(p.id, name)}
                autoEdit={p.id === newlyCreatedId}
                onAutoEditDone={() => setNewlyCreatedId(null)}
              />
            ))}
          </Box>
        </Stack>
      </Box>

      {/* Delete Project Dialog */}
      <Dialog open={!!deleteProjectId} onClose={() => setDeleteProjectId(null)}>
        <DialogTitle>{t('project.delete_title')}</DialogTitle>
        <DialogContent>
          <Typography>{t('project.delete_desc')}</Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
                size="small"
              />
            }
            label={t('project.delete_dont_ask')}
            sx={{ mt: 1, display: 'block' }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteProjectId(null)} color="inherit">
            {t('project.cancel')}
          </Button>
          <Button onClick={confirmDeleteProject} color="error" variant="contained" disableElevation>
            {t('project.delete_confirm')}
          </Button>
        </DialogActions>
      </Dialog>

      {openingProjectId && (
        <Box
          data-testid="project-open-overlay"
          sx={(theme) => ({
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor:
              theme.palette.mode === 'dark'
                ? 'rgba(15, 15, 18, 0.76)'
                : 'rgba(248, 249, 252, 0.82)',
            backdropFilter: 'blur(8px)'
          })}
        >
          <Box
            sx={(theme) => ({
              width: 56,
              height: 56,
              borderRadius: 3,
              display: 'grid',
              placeItems: 'center',
              backgroundColor:
                theme.palette.mode === 'dark' ? 'rgba(36, 37, 43, 0.92)' : 'rgba(255,255,255,0.95)',
              boxShadow:
                theme.palette.mode === 'dark'
                  ? '0 18px 42px rgba(0,0,0,0.34)'
                  : '0 18px 42px rgba(45,56,84,0.16)'
            })}
          >
            <CircularProgress size={24} />
          </Box>
        </Box>
      )}
    </Stack>
  )
}

export default MainPage
