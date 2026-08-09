import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { importCanvasFile, saveCanvasItems } from '../pages/ProjectCanvasPage/canvasStorage'
import { toProjectCanvasRoutePath } from '../pages/ProjectCanvasPage/projectCanvasRouting'
import { createProjectRecord, listProjects, saveProjects } from '../pages/MainPage/projectStore'
import { useAppDispatch } from '../store'
import { openTab } from '../store/slices/layoutSlice'
import { getCanvasProjectName, isCanvasSceneFile } from './canvasProjectDropUtils'

const CANVAS_DROP_SURFACE_SELECTOR = '[data-project-canvas-drop-surface="true"]'

function isCanvasSurfaceDrop(event: DragEvent): boolean {
  if (event.target instanceof Element && event.target.closest(CANVAS_DROP_SURFACE_SELECTOR)) {
    return true
  }
  return document
    .elementsFromPoint(event.clientX, event.clientY)
    .some((element) => element.closest(CANVAS_DROP_SURFACE_SELECTOR))
}

const CanvasProjectDropBridge = () => {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  useEffect(() => {
    const handleDragOver = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files || [])
      if (files.some(isCanvasSceneFile) && !isCanvasSurfaceDrop(event)) {
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      }
    }

    const handleDrop = async (event: DragEvent) => {
      if (isCanvasSurfaceDrop(event)) return
      const file = Array.from(event.dataTransfer?.files || []).find(isCanvasSceneFile)
      if (!file) return

      event.preventDefault()
      event.stopImmediatePropagation()

      const projectName = getCanvasProjectName(file.name)
      const projectId = `tab-project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      try {
        const imported = await importCanvasFile(file, projectId)
        const project = createProjectRecord({
          id: projectId,
          name: projectName,
          createdAt: Date.now()
        })
        saveProjects([...listProjects(), project])
        try {
          await saveCanvasItems(
            imported.items,
            projectId,
            imported.groups,
            imported.groupBranches,
            imported.figmaBinding
          )
        } catch (error) {
          saveProjects(listProjects().filter((entry) => entry.id !== projectId))
          throw error
        }
        const routePath = toProjectCanvasRoutePath(projectId)
        dispatch(openTab({ id: projectId, label: projectName, routePath, closable: true }))
        navigate(routePath)
      } catch (error) {
        console.error('[Canvas Import] Failed to open dropped project:', error)
      }
    }

    document.addEventListener('dragover', handleDragOver, true)
    document.addEventListener('drop', handleDrop, true)
    return () => {
      document.removeEventListener('dragover', handleDragOver, true)
      document.removeEventListener('drop', handleDrop, true)
    }
  }, [dispatch, navigate])

  return null
}

export default CanvasProjectDropBridge
