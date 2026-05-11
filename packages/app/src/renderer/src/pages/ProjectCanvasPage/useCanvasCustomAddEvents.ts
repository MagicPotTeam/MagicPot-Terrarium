import { useEffect } from 'react'
import type { CanvasImageItem, CanvasModel3DItem, CanvasTextItem, CanvasVideoItem } from './types'
import { CANVAS_NEW_RESULT_HINT_EVENT, type CanvasNewResultHintDetail } from './canvasNewResultHint'

type AddImageToCanvasFn = (
  src: string,
  options?: {
    fileName?: string
    promptId?: CanvasImageItem['promptId']
    fileItem?: CanvasImageItem['fileItem']
    sourceFile?: Blob
    sourceWidthHint?: number
    sourceHeightHint?: number
    select?: boolean
  }
) => Promise<CanvasImageItem | null | undefined>

type AddImagesToCanvasFn = (
  sources: Array<string | { src: string; fileName?: string; sizeBytes?: number }>
) => Promise<unknown>

type AddModel3DUrlToCanvasFn = (
  src: string,
  options?: {
    fileName?: string
    offsetX?: number
    offsetY?: number
    width?: number
    height?: number
    select?: boolean
    hy3dQuickAppKey?: CanvasModel3DItem['hy3dQuickAppKey']
    hy3dParams?: CanvasModel3DItem['hy3dParams']
    hy3dMediaState?: CanvasModel3DItem['hy3dMediaState']
  }
) => CanvasModel3DItem | null

type AddVideoToCanvasFn = (
  file: File,
  options?: {
    select?: boolean
    promptId?: CanvasVideoItem['promptId']
    fileItem?: CanvasVideoItem['fileItem']
    onAdded?: (item: CanvasVideoItem) => void
  }
) => unknown

type AddTextToCanvasFn = (text: string) => CanvasTextItem | null | undefined | void

type HandleAppendGenerationTraceCandidateFn = (options: {
  canvasId: string
  sessionId?: string
  candidate: {
    id: string
    canvasItemId: string
    fileName?: string
    src: string
    thumbnailSrc?: string
  }
}) => unknown

type UseCanvasCustomAddEventsOptions = {
  canvasId: string
  addImageToCanvas: AddImageToCanvasFn
  addImagesToCanvas: AddImagesToCanvasFn
  addModel3DUrlToCanvas: AddModel3DUrlToCanvasFn
  addVideoToCanvas: AddVideoToCanvasFn
  addTextToCanvas: AddTextToCanvasFn
  handleAppendGenerationTraceCandidate: HandleAppendGenerationTraceCandidateFn
}

function getPositiveCanvasDimensionHint(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function useCanvasCustomAddEvents({
  canvasId,
  addImageToCanvas,
  addImagesToCanvas,
  addModel3DUrlToCanvas,
  addVideoToCanvas,
  addTextToCanvas,
  handleAppendGenerationTraceCandidate
}: UseCanvasCustomAddEventsOptions) {
  useEffect(() => {
    const removeIpc = window.electron?.ipcRenderer?.on?.(
      'canvas:add-image',
      (_event: unknown, dataUrl: string) => {
        console.log('[Canvas] Received image from floating window')
        void addImageToCanvas(dataUrl)
      }
    )

    const handleCustomAdd = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          src: string
          fileName?: string
          projectId?: string
          generationSessionId?: string
          select?: boolean
          promptId?: CanvasImageItem['promptId']
          fileItem?: CanvasImageItem['fileItem']
          sourceFile?: Blob
          sourceWidth?: number
          sourceHeight?: number
          sourceWidthHint?: number
          sourceHeightHint?: number
          newResultHint?: 'quickapp'
          onAdded?: (item: CanvasImageItem) => void
        }>
      ).detail

      if (detail?.projectId && detail.projectId !== canvasId) {
        return
      }

      if (!detail?.src) {
        return
      }

      console.log('[Canvas] Received custom add image event')
      void (async () => {
        const sourceWidthHint = getPositiveCanvasDimensionHint(
          detail.sourceWidthHint ?? detail.sourceWidth
        )
        const sourceHeightHint = getPositiveCanvasDimensionHint(
          detail.sourceHeightHint ?? detail.sourceHeight
        )
        const addedItem = await addImageToCanvas(detail.src, {
          fileName: detail.fileName || detail.fileItem?.filename,
          promptId: detail.promptId,
          fileItem: detail.fileItem,
          sourceFile: detail.sourceFile,
          sourceWidthHint,
          sourceHeightHint,
          select: detail.select
        })
        if (!addedItem) return
        detail.onAdded?.(addedItem)
        if (detail.newResultHint === 'quickapp') {
          window.dispatchEvent(
            new CustomEvent<CanvasNewResultHintDetail>(CANVAS_NEW_RESULT_HINT_EVENT, {
              detail: {
                itemId: addedItem.id,
                canvasId,
                generationSessionId: detail.generationSessionId,
                source: 'quickapp'
              }
            })
          )
        }

        handleAppendGenerationTraceCandidate({
          canvasId,
          sessionId: detail.generationSessionId,
          candidate: {
            id: addedItem.id,
            canvasItemId: addedItem.id,
            fileName: addedItem.fileName,
            src: addedItem.src,
            thumbnailSrc: addedItem.src
          }
        })
      })()
    }

    const handleCustomAddModel3D = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          src: string
          fileName?: string
          offsetX?: number
          offsetY?: number
          width?: number
          height?: number
          projectId?: string
          generationSessionId?: string
          select?: boolean
          hy3dQuickAppKey?: CanvasModel3DItem['hy3dQuickAppKey']
          hy3dParams?: CanvasModel3DItem['hy3dParams']
          hy3dMediaState?: CanvasModel3DItem['hy3dMediaState']
          onAdded?: (item: CanvasModel3DItem) => void
        }>
      ).detail

      if (detail?.projectId && detail.projectId !== canvasId) {
        return
      }

      if (!detail?.src) {
        return
      }

      console.log('[Canvas] Received custom add 3D model event')
      const addedItem = addModel3DUrlToCanvas(detail.src, {
        fileName: detail.fileName,
        offsetX: detail.offsetX,
        offsetY: detail.offsetY,
        width: detail.width,
        height: detail.height,
        select: detail.select,
        hy3dQuickAppKey: detail.hy3dQuickAppKey,
        hy3dParams: detail.hy3dParams,
        hy3dMediaState: detail.hy3dMediaState
      })
      if (!addedItem) return
      detail.onAdded?.(addedItem)

      handleAppendGenerationTraceCandidate({
        canvasId,
        sessionId: detail.generationSessionId,
        candidate: {
          id: addedItem.id,
          canvasItemId: addedItem.id,
          fileName: addedItem.fileName,
          src: addedItem.src,
          thumbnailSrc: addedItem.src
        }
      })
    }

    const handleCustomAddVideo = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          src: string
          fileName?: string
          projectId?: string
          sourceFile?: Blob
          select?: boolean
          promptId?: CanvasVideoItem['promptId']
          fileItem?: CanvasVideoItem['fileItem']
          onAdded?: (item: CanvasVideoItem) => void
        }>
      ).detail

      if (detail?.projectId && detail.projectId !== canvasId) {
        return
      }

      if (!detail?.src) {
        return
      }

      console.log('[Canvas] Received custom add video event')
      void (async () => {
        const sourceBlob =
          detail.sourceFile ||
          (await fetch(detail.src)
            .then((response) => response.blob())
            .catch(() => null))
        if (!sourceBlob) return

        const file = new File([sourceBlob], detail.fileName || 'canvas-video.mp4', {
          type: sourceBlob.type || 'video/mp4'
        })
        addVideoToCanvas(file, {
          select: detail.select,
          promptId: detail.promptId,
          fileItem: detail.fileItem,
          onAdded: detail.onAdded
        })
      })()
    }

    const handleCustomAddText = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          text: string
          projectId?: string
          onAdded?: (item: CanvasTextItem) => void
        }>
      ).detail

      if (detail?.projectId && detail.projectId !== canvasId) {
        return
      }

      if (detail?.text) {
        console.log('[Canvas] Received custom add text event')
        const addedItem = addTextToCanvas(detail.text)
        if (addedItem) {
          detail.onAdded?.(addedItem)
        }
      }
    }

    const handleAddFromAI = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as {
        text?: string
        images?: string[]
        projectId?: string
      }

      if (detail.projectId && detail.projectId !== canvasId) {
        return
      }

      if (detail.text) {
        addTextToCanvas(detail.text)
      }

      if (detail.images && detail.images.length > 0) {
        void addImagesToCanvas(detail.images)
      }
    }

    window.addEventListener('canvas:add-image', handleCustomAdd)
    window.addEventListener('canvas:add-video', handleCustomAddVideo)
    window.addEventListener('canvas:add-model3d', handleCustomAddModel3D)
    window.addEventListener('canvas:add-text', handleCustomAddText)
    window.addEventListener('canvas:add-from-ai', handleAddFromAI)

    return () => {
      if (typeof removeIpc === 'function') removeIpc()
      window.removeEventListener('canvas:add-image', handleCustomAdd)
      window.removeEventListener('canvas:add-video', handleCustomAddVideo)
      window.removeEventListener('canvas:add-model3d', handleCustomAddModel3D)
      window.removeEventListener('canvas:add-text', handleCustomAddText)
      window.removeEventListener('canvas:add-from-ai', handleAddFromAI)
    }
  }, [
    addImageToCanvas,
    addImagesToCanvas,
    addModel3DUrlToCanvas,
    addVideoToCanvas,
    addTextToCanvas,
    canvasId,
    handleAppendGenerationTraceCandidate
  ])
}
