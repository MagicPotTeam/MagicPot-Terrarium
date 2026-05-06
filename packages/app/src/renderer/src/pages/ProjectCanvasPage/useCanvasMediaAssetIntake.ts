import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { getDownloadFileNameFromUrl, normalizeLocalMediaUrl } from '../ChatPage/chatPageShared'
import { resolveCanvas3DRenderActivationDelay } from './canvas3DRenderActivation'
import { extractModelArchive } from './modelArchive'
import {
  createCanvasHtmlItemDraft,
  createCanvasItemId,
  createCanvasModel3DItemDraft,
  createCanvasTextItemDraft,
  createCanvasVideoItemDraft
} from './canvasAssetDraftFactories'
import { isModelArchiveFile } from './types'
import type {
  CanvasHtmlItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'
import type { CanvasTool } from './projectCanvasPageShared'
import { measureCanvasTextBoxSize } from './canvasTextLayout'

type CanvasPoint = { x: number; y: number }

type AppendItemsSetter = Dispatch<SetStateAction<CanvasItem[]>>

type AppendMode = {
  selectIds?: string[]
  selectTool?: boolean
  useHistory?: boolean
}

export type UseCanvasMediaAssetIntakeOptions = {
  nextZIndexRef: MutableRefObject<number>
  getCenterPosition: (width: number, height: number) => CanvasPoint
  getCanvasPointFromClient?: (clientX?: number, clientY?: number) => CanvasPoint | null
  setItems?: AppendItemsSetter
  setItemsWithHistory?: AppendItemsSetter
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setTool: Dispatch<SetStateAction<CanvasTool>>
  notifyError: (message: string) => unknown
  isChineseUi?: boolean
  activateModel3DRender?: (itemId: string, delay?: number) => void
  setPendingTextureModelId?: (itemId: string | null) => void
  setTextureImportDialogOpen?: (open: boolean) => void
}

export type CanvasMediaAssetIntakeApi = {
  addModel3DToCanvas: (
    file: File,
    options?: {
      linkedAssets?: Record<string, string>
      skipTexturePrompt?: boolean
    }
  ) => Promise<void>
  addModel3DUrlToCanvas: (
    src: string,
    options?: {
      clientX?: number
      clientY?: number
      fileName?: string
      select?: boolean
    }
  ) => CanvasModel3DItem | null
  addHtmlToCanvas: (htmlData: string) => void
  addVideoToCanvas: (
    file: File,
    options?: {
      select?: boolean
      promptId?: CanvasVideoItem['promptId']
      fileItem?: CanvasVideoItem['fileItem']
      onAdded?: (item: CanvasVideoItem) => void
    }
  ) => void
  addTextToCanvas: (text: string, clientX?: number, clientY?: number) => CanvasTextItem
}

const TEXT_FONT_FAMILY = 'system-ui, sans-serif'
const TEXT_FONT_SIZE = 16
const MODEL_DEFAULT_SIZE = 400
const HTML_DEFAULT_WIDTH = 400
const HTML_DEFAULT_HEIGHT = 500
const VIDEO_FALLBACK_WIDTH = 480
const VIDEO_FALLBACK_HEIGHT = 270
const VIDEO_MAX_SIDE = 600

type ElectronCanvasFile = File & {
  path?: string
}

function getCanvasLocalMediaSourceUrl(file: File): string | null {
  const filePath =
    typeof (file as ElectronCanvasFile).path === 'string'
      ? (file as ElectronCanvasFile).path!.replace(/\\/g, '/')
      : ''
  if (!filePath) {
    return null
  }

  return normalizeLocalMediaUrl(`file://${filePath}`)
}

function measureCanvasTextBox(text: string): { width: number; height: number } {
  return measureCanvasTextBoxSize({
    text,
    fontSize: TEXT_FONT_SIZE,
    fontFamily: TEXT_FONT_FAMILY,
    lineHeight: 1.5,
    wrap: 'word'
  })
}

export function useCanvasMediaAssetIntake({
  nextZIndexRef,
  getCenterPosition,
  getCanvasPointFromClient,
  setItems,
  setItemsWithHistory,
  setSelectedIds,
  setTool,
  notifyError,
  isChineseUi = false,
  activateModel3DRender,
  setPendingTextureModelId,
  setTextureImportDialogOpen
}: UseCanvasMediaAssetIntakeOptions): CanvasMediaAssetIntakeApi {
  const appendCanvasItems = useCallback(
    (items: CanvasItem[], options: AppendMode = {}) => {
      if (items.length === 0) return

      const setter =
        options.useHistory === false
          ? (setItems ?? setItemsWithHistory)
          : (setItemsWithHistory ?? setItems)

      setter?.((prev) => [...prev, ...items])

      if (options.selectIds && options.selectIds.length > 0) {
        setSelectedIds(new Set(options.selectIds))
      }

      if (options.selectTool !== false) {
        setTool('select')
      }
    },
    [setItems, setItemsWithHistory, setSelectedIds, setTool]
  )

  const resolveClientPlacement = useCallback(
    (width: number, height: number, clientX?: number, clientY?: number) => {
      const point = getCanvasPointFromClient?.(clientX, clientY)
      if (point) {
        return {
          x: point.x - width / 2,
          y: point.y - height / 2
        }
      }

      return getCenterPosition(width, height)
    },
    [getCanvasPointFromClient, getCenterPosition]
  )

  const addModel3DToCanvas = useCallback(
    async (
      file: File,
      options?: {
        linkedAssets?: Record<string, string>
        skipTexturePrompt?: boolean
      }
    ) => {
      try {
        let sourceFile = file
        let linkedAssets = options?.linkedAssets
        let skipTexturePrompt = options?.skipTexturePrompt ?? false

        if (isModelArchiveFile(file.name)) {
          const extracted = await extractModelArchive(file)
          if (!extracted) return

          sourceFile = extracted.file
          linkedAssets = extracted.linkedAssets
          skipTexturePrompt = skipTexturePrompt || Object.keys(extracted.linkedAssets).length > 0
          console.log('[Canvas] Resolved 3D source file:', file.name, '=>', extracted.sourcePath)
        }

        const src = getCanvasLocalMediaSourceUrl(sourceFile) || URL.createObjectURL(sourceFile)
        const pos = getCenterPosition(MODEL_DEFAULT_SIZE, MODEL_DEFAULT_SIZE)
        const assetCount = linkedAssets ? Object.keys(linkedAssets).length : 0

        const newItem = createCanvasModel3DItemDraft({
          id: createCanvasItemId('model'),
          src,
          fileName: sourceFile.name,
          ...(assetCount > 0 ? { textures: linkedAssets } : {}),
          x: pos.x,
          y: pos.y,
          width: MODEL_DEFAULT_SIZE,
          height: MODEL_DEFAULT_SIZE,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: nextZIndexRef.current++,
          locked: false
        }) as CanvasModel3DItem & { deferRender?: boolean }

        newItem.deferRender = true
        appendCanvasItems([newItem], { selectIds: [newItem.id] })
        console.log('[Canvas] Imported 3D model:', sourceFile.name)

        const ext = sourceFile.name.toLowerCase().split('.').pop()
        const activationDelay = resolveCanvas3DRenderActivationDelay({
          fileName: sourceFile.name,
          hasLinkedAssets: assetCount > 0,
          isAwaitingTexturePrompt: ext !== 'glb' && !skipTexturePrompt
        })
        if (assetCount > 0) {
          activateModel3DRender?.(newItem.id, activationDelay)
          return
        }

        if (ext !== 'glb' && !skipTexturePrompt) {
          setPendingTextureModelId?.(newItem.id)
          setTextureImportDialogOpen?.(true)
          activateModel3DRender?.(newItem.id, activationDelay)
        } else {
          activateModel3DRender?.(newItem.id, activationDelay)
        }
      } catch (error) {
        console.error('[Canvas] Failed to import 3D model:', error)
        notifyError(
          `${isChineseUi ? '导入 3D 模型失败' : 'Failed to import 3D model'}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    },
    [
      activateModel3DRender,
      appendCanvasItems,
      getCenterPosition,
      isChineseUi,
      nextZIndexRef,
      notifyError,
      setPendingTextureModelId,
      setTextureImportDialogOpen
    ]
  )

  const addModel3DUrlToCanvas = useCallback(
    (
      src: string,
      options?: {
        clientX?: number
        clientY?: number
        fileName?: string
        select?: boolean
      }
    ): CanvasModel3DItem | null => {
      const normalizedSrc = normalizeLocalMediaUrl(src).trim()
      if (!normalizedSrc) {
        return null
      }

      const pos = resolveClientPlacement(
        MODEL_DEFAULT_SIZE,
        MODEL_DEFAULT_SIZE,
        options?.clientX,
        options?.clientY
      )

      const newItem = createCanvasModel3DItemDraft({
        id: createCanvasItemId('model'),
        src: normalizedSrc,
        fileName: options?.fileName || getDownloadFileNameFromUrl(normalizedSrc, 'model.glb'),
        x: pos.x,
        y: pos.y,
        width: MODEL_DEFAULT_SIZE,
        height: MODEL_DEFAULT_SIZE,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: nextZIndexRef.current++,
        locked: false
      }) as CanvasModel3DItem & { deferRender?: boolean }

      newItem.deferRender = true
      appendCanvasItems([newItem], {
        selectIds: options?.select === false ? [] : [newItem.id]
      })
      activateModel3DRender?.(
        newItem.id,
        resolveCanvas3DRenderActivationDelay({
          fileName: newItem.fileName
        })
      )
      console.log('[Canvas] Added 3D model from URL:', normalizedSrc)
      return newItem
    },
    [activateModel3DRender, appendCanvasItems, nextZIndexRef, resolveClientPlacement]
  )

  const addHtmlToCanvas = useCallback(
    (htmlData: string) => {
      const pos = getCenterPosition(HTML_DEFAULT_WIDTH, HTML_DEFAULT_HEIGHT)
      const newItem: CanvasHtmlItem = createCanvasHtmlItemDraft({
        id: createCanvasItemId('html'),
        htmlData,
        x: pos.x,
        y: pos.y,
        width: HTML_DEFAULT_WIDTH,
        height: HTML_DEFAULT_HEIGHT,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: nextZIndexRef.current++,
        locked: false,
        interactive: true
      })

      appendCanvasItems([newItem], { selectIds: [newItem.id] })
    },
    [appendCanvasItems, getCenterPosition, nextZIndexRef]
  )

  const addVideoToCanvas = useCallback(
    (
      file: File,
      options?: {
        select?: boolean
        promptId?: CanvasVideoItem['promptId']
        fileItem?: CanvasVideoItem['fileItem']
        onAdded?: (item: CanvasVideoItem) => void
      }
    ) => {
      const probeObjectUrl = URL.createObjectURL(file)
      const persistentSrc = getCanvasLocalMediaSourceUrl(file) || probeObjectUrl
      const releaseProbeObjectUrl = () => {
        if (persistentSrc !== probeObjectUrl) {
          URL.revokeObjectURL(probeObjectUrl)
        }
      }

      const createVideoItem = (width: number, height: number) => {
        const pos = getCenterPosition(width, height)
        const newItem: CanvasVideoItem = createCanvasVideoItemDraft({
          id: createCanvasItemId('video'),
          src: persistentSrc,
          fileName: file.name,
          x: pos.x,
          y: pos.y,
          width,
          height,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: nextZIndexRef.current++,
          locked: false,
          playing: false,
          muted: true,
          volume: 0.5,
          promptId: options?.promptId,
          fileItem: options?.fileItem
        })

        appendCanvasItems([newItem], {
          selectIds: options?.select === false ? [] : [newItem.id]
        })
        options?.onAdded?.(newItem)
      }

      const video = document.createElement('video')
      video.preload = 'metadata'
      video.onloadedmetadata = () => {
        releaseProbeObjectUrl()
        const rawWidth = Math.max(1, video.videoWidth || VIDEO_FALLBACK_WIDTH)
        const rawHeight = Math.max(1, video.videoHeight || VIDEO_FALLBACK_HEIGHT)
        const maxSide = Math.max(rawWidth, rawHeight)
        const scale = maxSide > VIDEO_MAX_SIDE ? VIDEO_MAX_SIDE / maxSide : 1
        createVideoItem(
          Math.max(1, Math.round(rawWidth * scale)),
          Math.max(1, Math.round(rawHeight * scale))
        )
      }
      video.onerror = () => {
        console.error('[Canvas] Failed to load video metadata:', file.name)
        releaseProbeObjectUrl()
        createVideoItem(VIDEO_FALLBACK_WIDTH, VIDEO_FALLBACK_HEIGHT)
      }
      video.src = probeObjectUrl
    },
    [appendCanvasItems, getCenterPosition, nextZIndexRef]
  )

  const addTextToCanvas = useCallback(
    (text: string, clientX?: number, clientY?: number): CanvasTextItem => {
      const { width, height } = measureCanvasTextBox(text)
      const pos = resolveClientPlacement(width, height, clientX, clientY)

      const newItem: CanvasTextItem = createCanvasTextItemDraft({
        id: createCanvasItemId('text'),
        text,
        fontSize: TEXT_FONT_SIZE,
        fontFamily: TEXT_FONT_FAMILY,
        fill: '#e0e0e0',
        x: pos.x,
        y: pos.y,
        width,
        height,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: nextZIndexRef.current++,
        locked: false
      })

      appendCanvasItems([newItem], { selectIds: [newItem.id] })
      return newItem
    },
    [appendCanvasItems, nextZIndexRef, resolveClientPlacement]
  )

  return {
    addModel3DToCanvas,
    addModel3DUrlToCanvas,
    addHtmlToCanvas,
    addVideoToCanvas,
    addTextToCanvas
  }
}
