/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react/no-unknown-property */
/* eslint-disable react-refresh/only-export-components */
import React, { Suspense, lazy } from 'react'
import { useThree } from '@react-three/fiber'
import { Box, CircularProgress, IconButton, TextField, Typography } from '@mui/material'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import LinkIcon from '@mui/icons-material/Link'
import ViewInArIcon from '@mui/icons-material/ViewInAr'
import * as THREE from 'three'
import { useMessage } from '@renderer/hooks/useMessage'
import { fileToDataUrl } from '@renderer/utils/fileUtils'
import { parseInternalImageDragPayload } from '@renderer/utils/droppedImageUtils'
import { api } from '@renderer/utils/windowUtils'
import { collectDroppedDirectoryFiles } from '../../ProjectCanvasPage/dropDirectory'
import {
  extractModelArchive,
  extractModelPackageFiles,
  listContainedModelExtensions,
  ModelPackageUnsupportedFormatError,
  type ModelPackageFileEntry
} from '../../ProjectCanvasPage/modelArchive'
import { isModelArchiveFile } from '../../ProjectCanvasPage/types'
import { hyColors } from './theme'
import { SectionLabel } from './ui'
import { parseHy3dModelInputValue } from './types'
import { AGENT_MODEL3D_DRAG_MIME } from '../chatDragData'
import { getDownloadFileNameFromUrl, isModel3DUrl, normalizeLocalMediaUrl } from '../chatPageShared'
import {
  ModelSceneCanvasSetup,
  type ModelBounds
} from '../../ProjectCanvasPage/components/modelLoaders/shared'
import {
  DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
  getSceneInstanceCloneCacheKey
} from '../../ProjectCanvasPage/components/modelLoaders/sceneInstanceCloneCacheKey'

const Canvas = lazy(() => import('@react-three/fiber').then((m) => ({ default: m.Canvas })))
const OrbitControls = lazy(() =>
  import('@react-three/drei').then((m) => ({ default: m.OrbitControls }))
)
const GLTFScene = lazy(() => import('../../ProjectCanvasPage/components/modelLoaders/GLTFScene'))
const FBXScene = lazy(() => import('../../ProjectCanvasPage/components/modelLoaders/FBXScene'))
const OBJScene = lazy(() => import('../../ProjectCanvasPage/components/modelLoaders/OBJScene'))
const STLScene = lazy(() => import('../../ProjectCanvasPage/components/modelLoaders/STLScene'))

type ModelStorageMeta = {
  sourceFileName: string
  storageKey: string
  storageBucket: string
  storageRegion: string
  signedUrlExpiresAt: string
}

type ParsedHy3dCosModelMeta = ModelStorageMeta & {
  expiresAtMs: number
}

interface ModelDropZoneProps {
  value: string
  onChange: (v: string) => void
  label?: string
  fileName?: string
  storageMeta?: Partial<ModelStorageMeta> | null
  onFileLoad?: (file: File, blobUrl: string) => void
  onClear?: () => void
  sx?: any
  acceptExtensions?: readonly string[]
  allowedFormatsLabel?: string
  urlOnly?: boolean
  enableLocalUpload?: boolean
  onMetaChange?: (meta: ModelStorageMeta) => void
}

const EMPTY_MODEL_META: ModelStorageMeta = {
  sourceFileName: '',
  storageKey: '',
  storageBucket: '',
  storageRegion: '',
  signedUrlExpiresAt: ''
}

const HY3D_SIGNED_URL_REFRESH_BUFFER_MS = 5 * 60 * 1000
const HY3D_PREVIEW_CAMERA_DIRECTION = new THREE.Vector3(1, 1, 1.5).normalize()

type OrbitControlsLike = {
  target: THREE.Vector3
  update: () => void
  minDistance: number
  maxDistance: number
}

const inferExt = (name: string): string => {
  const normalized = name.toLowerCase()
  const queryless = normalized.split('?')[0].split('#')[0]
  const ext = queryless.split('.').pop() || ''
  return ext
}

const asOrbitControls = (controls: unknown): OrbitControlsLike | null => {
  if (!controls || typeof controls !== 'object') {
    return null
  }

  const maybeControls = controls as Partial<OrbitControlsLike>
  if (
    !(maybeControls.target instanceof THREE.Vector3) ||
    typeof maybeControls.update !== 'function' ||
    typeof maybeControls.minDistance !== 'number' ||
    typeof maybeControls.maxDistance !== 'number'
  ) {
    return null
  }

  return maybeControls as OrbitControlsLike
}

const resolvePreviewCameraDistance = ({
  size,
  radius,
  fov,
  aspect
}: {
  size: THREE.Vector3
  radius: number
  fov: number
  aspect: number
}) => {
  const halfHeight = Math.max(size.y / 2, 0.001)
  const halfWidth = Math.max(size.x / 2, 0.001)
  const fitHeightDistance = halfHeight / Math.tan(fov / 2)
  const fitWidthDistance = halfWidth / (Math.tan(fov / 2) * Math.max(aspect, 0.1))
  return Math.max(fitHeightDistance, fitWidthDistance, radius * 1.2) * 1.02
}

export const resolveHy3dPreviewCameraFrame = ({
  center,
  size,
  radius,
  cameraFovDeg,
  viewportWidth,
  viewportHeight
}: {
  center: THREE.Vector3
  size: THREE.Vector3
  radius: number
  cameraFovDeg: number
  viewportWidth: number
  viewportHeight: number
}) => {
  const distance = resolvePreviewCameraDistance({
    size,
    radius,
    fov: THREE.MathUtils.degToRad(cameraFovDeg),
    aspect: Math.max(viewportWidth / Math.max(viewportHeight, 1), 0.1)
  })

  return {
    target: center.clone(),
    position: center.clone().add(HY3D_PREVIEW_CAMERA_DIRECTION.clone().multiplyScalar(distance)),
    near: Math.max(distance / 100, 0.01),
    far: Math.max(distance * 20, 100),
    minDistance: Math.max(distance * 0.5, 0.1),
    maxDistance: Math.max(distance * 3, Math.max(distance * 0.5, 0.1) + 1)
  }
}

const PreviewAutoFitCamera: React.FC<{ bounds: ModelBounds | null }> = ({ bounds }) => {
  const { camera, controls, size } = useThree()

  React.useEffect(() => {
    if (!bounds || !(camera instanceof THREE.PerspectiveCamera)) {
      return
    }

    const applyCameraFrame = () => {
      const orbitControls = asOrbitControls(controls)
      if (!orbitControls) {
        return
      }

      const frame = resolveHy3dPreviewCameraFrame({
        center: bounds.center,
        size: bounds.size,
        radius: bounds.radius,
        cameraFovDeg: camera.fov,
        viewportWidth: size.width,
        viewportHeight: size.height
      })

      orbitControls.target.copy(frame.target)
      camera.position.copy(frame.position)
      camera.up.set(0, 1, 0)
      camera.near = frame.near
      camera.far = frame.far
      camera.updateProjectionMatrix()
      orbitControls.minDistance = frame.minDistance
      orbitControls.maxDistance = frame.maxDistance
      orbitControls.update()
    }

    applyCameraFrame()
    const rafId = requestAnimationFrame(applyCameraFrame)

    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [bounds, camera, controls, size.height, size.width])

  return null
}

const getFileNameFromPath = (filePath: string): string => filePath.split(/[\\/]/).pop() || filePath

const HUNYUAN_TENCENT_COS_HOST_REGEX =
  /^(?<bucket>[^.]+)\.cos\.(?<region>[^.]+)\.(?:tencentcos\.cn|myqcloud\.com)$/i

type DroppedModelReference = {
  url: string
  fileName: string
}

type ElectronFile = File & { path?: string }

type ModelDragReader = Pick<DataTransfer, 'getData'>

const parseUriList = (value: string): string[] =>
  String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

const createDroppedModelReference = (
  url: string,
  fileName?: string
): DroppedModelReference | null => {
  const normalizedUrl = normalizeLocalMediaUrl(String(url || '').trim())
  if (!normalizedUrl) {
    return null
  }

  return {
    url: normalizedUrl,
    fileName:
      String(fileName || '').trim() || getDownloadFileNameFromUrl(normalizedUrl, 'model.glb')
  }
}

const decodeLocalModelPath = (url: string): string | null => {
  if (url.startsWith('local-media:///')) {
    return decodeURIComponent(url.slice('local-media:///'.length))
  }

  if (url.startsWith('local-media://')) {
    return decodeURIComponent(url.slice('local-media://'.length).replace(/^\/+/, ''))
  }

  if (url.startsWith('file:///')) {
    return decodeURIComponent(url.slice('file:///'.length))
  }

  if (url.startsWith('file://')) {
    return decodeURIComponent(url.slice('file://'.length).replace(/^\/+/, ''))
  }

  return null
}

const parseHy3dSignedUrlExpiresAt = (
  url: URL
): { expiresAt: string; expiresAtMs: number } | null => {
  const qSignTime = url.searchParams.get('q-sign-time') || url.searchParams.get('q-key-time')
  if (!qSignTime) {
    return null
  }

  const [, endRaw = ''] = qSignTime.split(';')
  const expiresAtSeconds = Number.parseInt(endRaw, 10)
  if (!Number.isFinite(expiresAtSeconds)) {
    return null
  }

  const expiresAtMs = expiresAtSeconds * 1000
  return {
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs
  }
}

export const parseHy3dCosModelMetaFromUrl = (
  rawUrl: string,
  fallbackFileName?: string
): ParsedHy3dCosModelMeta | null => {
  try {
    const parsedUrl = new URL(String(rawUrl || '').trim())
    const hostMatch = parsedUrl.hostname.match(HUNYUAN_TENCENT_COS_HOST_REGEX)
    if (!hostMatch?.groups?.bucket || !hostMatch?.groups?.region) {
      return null
    }

    const storageKey = parsedUrl.pathname.replace(/^\/+/, '')
    if (!storageKey) {
      return null
    }

    const expiresAtInfo = parseHy3dSignedUrlExpiresAt(parsedUrl)
    const sourceFileName =
      String(fallbackFileName || '').trim() ||
      getDownloadFileNameFromUrl(parsedUrl.toString(), 'model.glb')

    return {
      sourceFileName,
      storageKey,
      storageBucket: hostMatch.groups.bucket,
      storageRegion: hostMatch.groups.region,
      signedUrlExpiresAt: expiresAtInfo?.expiresAt || '',
      expiresAtMs: expiresAtInfo?.expiresAtMs || Number.NaN
    }
  } catch {
    return null
  }
}

export const isHy3dCosModelUrlExpiringSoon = (
  meta: Pick<ParsedHy3dCosModelMeta, 'expiresAtMs'> | null,
  nowMs = Date.now()
): boolean => {
  if (!meta || !Number.isFinite(meta.expiresAtMs)) {
    return false
  }

  return meta.expiresAtMs <= nowMs + HY3D_SIGNED_URL_REFRESH_BUFFER_MS
}

type InlinePreviewErrorBoundaryProps = {
  children: React.ReactNode
  fallback: React.ReactNode
  resetKey: string
}

type InlinePreviewErrorBoundaryState = {
  hasError: boolean
}

class InlinePreviewErrorBoundary extends React.Component<
  InlinePreviewErrorBoundaryProps,
  InlinePreviewErrorBoundaryState
> {
  state: InlinePreviewErrorBoundaryState = {
    hasError: false
  }

  static getDerivedStateFromError(): InlinePreviewErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error): void {
    console.error('[Hy3D] 模型预览加载失败:', error)
  }

  componentDidUpdate(prevProps: InlinePreviewErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback
    }

    return this.props.children
  }
}

const getDroppedModelReference = (dataTransfer: ModelDragReader): DroppedModelReference | null => {
  const internalPayload = parseInternalImageDragPayload(dataTransfer)
  const internalModelAttachment = internalPayload?.attachments?.find(
    (attachment) => attachment.type === 'model3d'
  )

  if (internalModelAttachment?.url) {
    return createDroppedModelReference(
      internalModelAttachment.url,
      internalModelAttachment.fileName
    )
  }

  if (internalPayload?.itemTypes?.includes('model3d') && internalPayload.objectUrl) {
    return createDroppedModelReference(internalPayload.objectUrl)
  }

  const directAgentReference = createDroppedModelReference(
    dataTransfer.getData(AGENT_MODEL3D_DRAG_MIME)
  )
  if (directAgentReference && isModel3DUrl(directAgentReference.url)) {
    return directAgentReference
  }

  const uriListReference = parseUriList(dataTransfer.getData('text/uri-list'))
    .map((url) => createDroppedModelReference(url))
    .find(
      (reference: DroppedModelReference | null): reference is DroppedModelReference =>
        reference !== null && isModel3DUrl(reference.url)
    )
  if (uriListReference) {
    return uriListReference
  }

  const plainTextReference = createDroppedModelReference(dataTransfer.getData('text/plain'))
  if (plainTextReference && isModel3DUrl(plainTextReference.url)) {
    return plainTextReference
  }

  return null
}

const getFriendlyHy3dUploadError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || '')
  if (
    message.includes("No handler registered for 'svcLLMProxy.uploadHy3DModel'") ||
    message.includes("No handler registered for 'svcLLMProxy.signHy3DModel'")
  ) {
    return '当前运行中的主进程还是旧版本，Hy3D 本地上传能力尚未加载。请完全退出应用后重新启动一次。'
  }
  return message || '本地模型上传失败'
}

const getBase64Payload = async (file: File): Promise<string> => {
  const dataUrl = await fileToDataUrl(file)
  const separatorIndex = dataUrl.indexOf(',')
  return separatorIndex >= 0 ? dataUrl.slice(separatorIndex + 1) : dataUrl
}

const revokeLinkedAssetUrls = (linkedAssets: Record<string, string>) => {
  Object.values(linkedAssets).forEach((url) => URL.revokeObjectURL(url))
}

const getPackageNameFromEntries = (entries: ModelPackageFileEntry[]): string => {
  const firstPath = entries.find((entry) => entry.path)?.path || entries[0]?.file.name || 'package'
  return firstPath.split('/').filter(Boolean)[0] || firstPath
}

const formatModelExtensionsLabel = (extensions: readonly string[]): string =>
  extensions.map((extension) => extension.replace(/^\./, '').toUpperCase()).join(' / ')

const getPackageModelWarning = (
  detectedModelExtensions: readonly string[],
  allowedFormatsLabel: string,
  scopeLabel: string
): string => {
  if (detectedModelExtensions.length === 0) {
    return `${scopeLabel}没有找到可上传的 ${allowedFormatsLabel} 模型文件。`
  }

  return `${scopeLabel}检测到 ${formatModelExtensionsLabel(detectedModelExtensions)} 模型，但当前仅支持 ${allowedFormatsLabel}。`
}

const ModelDropZone: React.FC<ModelDropZoneProps> = ({
  value,
  onChange,
  label,
  fileName: fileNameProp,
  storageMeta,
  onFileLoad,
  onClear,
  acceptExtensions = ['.glb', '.obj', '.fbx'],
  allowedFormatsLabel = 'GLB / OBJ / FBX',
  urlOnly = false,
  enableLocalUpload = false,
  onMetaChange
}) => {
  const { notifyInfo, notifySuccess, notifyWarning, closeMessage } = useMessage()
  const [isDragOver, setIsDragOver] = React.useState(false)
  const [showUrlInput, setShowUrlInput] = React.useState(urlOnly)
  const [localFileName, setLocalFileName] = React.useState(fileNameProp || '')
  const [isUploading, setIsUploading] = React.useState(false)
  const [isRefreshingSignedUrl, setIsRefreshingSignedUrl] = React.useState(false)
  const [previewLoadError, setPreviewLoadError] = React.useState('')
  const [previewBounds, setPreviewBounds] = React.useState<ModelBounds | null>(null)
  const urlInputRef = React.useRef<HTMLInputElement | null>(null)

  const localUploadEnabled = urlOnly && enableLocalUpload

  React.useEffect(() => {
    setLocalFileName(fileNameProp || '')
  }, [fileNameProp])

  React.useEffect(() => {
    if (urlOnly) setShowUrlInput(true)
  }, [urlOnly])

  React.useEffect(() => {
    setPreviewLoadError('')
  }, [value])

  React.useEffect(() => {
    setPreviewBounds(null)
  }, [value])

  const isLocalModel =
    value.startsWith('blob:') || value.startsWith('file:') || value.startsWith('local-media:')
  const isRemoteUrl = value.startsWith('http://') || value.startsWith('https://')
  const hasModel = !!(value && (isLocalModel || isRemoteUrl))
  const refreshableStorageMeta = React.useMemo<ParsedHy3dCosModelMeta | null>(() => {
    const storageKey = String(storageMeta?.storageKey || '').trim()
    const storageBucket = String(storageMeta?.storageBucket || '').trim()
    const storageRegion = String(storageMeta?.storageRegion || '').trim()
    if (!storageKey || !storageBucket || !storageRegion) {
      return null
    }

    const sourceFileName =
      String(storageMeta?.sourceFileName || '').trim() ||
      fileNameProp ||
      localFileName ||
      getDownloadFileNameFromUrl(value, 'model.glb')
    const signedUrlExpiresAt = String(storageMeta?.signedUrlExpiresAt || '').trim()
    return {
      sourceFileName,
      storageKey,
      storageBucket,
      storageRegion,
      signedUrlExpiresAt,
      expiresAtMs: Date.parse(signedUrlExpiresAt)
    }
  }, [fileNameProp, localFileName, storageMeta, value])
  const previewNeedsSignedUrlRefresh =
    isRemoteUrl && isHy3dCosModelUrlExpiringSoon(refreshableStorageMeta)

  const clearStoredModelMeta = React.useCallback(() => {
    onMetaChange?.(EMPTY_MODEL_META)
  }, [onMetaChange])

  const applyResolvedModelUrl = React.useCallback(
    (url: string, fileName?: string) => {
      const normalizedUrl = normalizeLocalMediaUrl(String(url || '').trim())
      if (!normalizedUrl) return

      const resolvedFileName =
        String(fileName || '').trim() || getDownloadFileNameFromUrl(normalizedUrl, 'model.glb')
      setLocalFileName(resolvedFileName)
      onMetaChange?.({
        ...EMPTY_MODEL_META,
        sourceFileName: resolvedFileName
      })
      onChange(normalizedUrl)
    },
    [onChange, onMetaChange]
  )

  const refreshSignedRemoteModelUrl = React.useCallback(
    async (meta: ParsedHy3dCosModelMeta, force = false) => {
      if (!force && !isHy3dCosModelUrlExpiringSoon(meta)) {
        return false
      }

      setIsRefreshingSignedUrl(true)
      setPreviewLoadError('')
      try {
        const signed = await api().svcLLMProxy.signHy3DModel({
          key: meta.storageKey,
          bucket: meta.storageBucket,
          region: meta.storageRegion
        })
        setLocalFileName(meta.sourceFileName)
        onMetaChange?.({
          sourceFileName: meta.sourceFileName,
          storageKey: meta.storageKey,
          storageBucket: meta.storageBucket,
          storageRegion: meta.storageRegion,
          signedUrlExpiresAt: signed.expiresAt
        })
        onChange(signed.url)
        return true
      } catch (error) {
        console.error('[Hy3D] 刷新模型签名链接失败:', error)
        setPreviewLoadError(getFriendlyHy3dUploadError(error))
        return false
      } finally {
        setIsRefreshingSignedUrl(false)
      }
    },
    [onChange, onMetaChange]
  )

  React.useEffect(() => {
    if (!refreshableStorageMeta || !previewNeedsSignedUrlRefresh) return

    void refreshSignedRemoteModelUrl(refreshableStorageMeta)
  }, [previewNeedsSignedUrlRefresh, refreshSignedRemoteModelUrl, refreshableStorageMeta])

  const focusUrlInput = React.useCallback(() => {
    setShowUrlInput(true)
    requestAnimationFrame(() => {
      urlInputRef.current?.focus()
      urlInputRef.current?.select()
    })
  }, [])

  const toggleUrlInput = React.useCallback(() => {
    if (isUploading) return

    setShowUrlInput((prev) => {
      const next = !prev
      if (next) {
        requestAnimationFrame(() => {
          urlInputRef.current?.focus()
          urlInputRef.current?.select()
        })
      }
      return next
    })
  }, [isUploading])

  const handleFile = React.useCallback(
    (file: File) => {
      if (urlOnly) return

      const ext = `.${inferExt(file.name)}`
      if (!acceptExtensions.includes(ext)) return

      const blobUrl = URL.createObjectURL(file)
      setLocalFileName(file.name)
      clearStoredModelMeta()
      onChange(blobUrl)
      onFileLoad?.(file, blobUrl)
    },
    [acceptExtensions, clearStoredModelMeta, onChange, onFileLoad, urlOnly]
  )

  const uploadResolvedModel = React.useCallback(
    async (file: File, fallbackPath?: string) => {
      const resolvedPath = fallbackPath || (file as ElectronFile).path
      const selectedFileName = file.name || getFileNameFromPath(resolvedPath || '')
      const ext = `.${inferExt(selectedFileName)}`
      if (!acceptExtensions.includes(ext)) {
        notifyWarning(`当前仅支持 ${allowedFormatsLabel} 格式。`)
        return false
      }

      const messageKey = notifyInfo(`正在上传 ${selectedFileName}...`, null)
      setIsUploading(true)
      try {
        const result = resolvedPath
          ? await api().svcLLMProxy.uploadHy3DModel({ filePath: resolvedPath })
          : await api().svcLLMProxy.uploadHy3DModel({
              fileName: selectedFileName,
              fileDataBase64: await getBase64Payload(file)
            })
        setLocalFileName(result.fileName)
        onChange(result.url)
        onMetaChange?.({
          sourceFileName: result.fileName,
          storageKey: result.key,
          storageBucket: result.bucket,
          storageRegion: result.region,
          signedUrlExpiresAt: result.expiresAt
        })
        notifySuccess(`已上传 ${result.fileName}`)
        return true
      } catch (error) {
        console.error('[Hy3D] 上传本地模型失败:', error)
        notifyWarning(getFriendlyHy3dUploadError(error))
        return false
      } finally {
        setIsUploading(false)
        closeMessage(messageKey)
      }
    },
    [
      acceptExtensions,
      allowedFormatsLabel,
      closeMessage,
      notifyInfo,
      notifySuccess,
      notifyWarning,
      onChange,
      onMetaChange
    ]
  )

  const uploadPackageEntries = React.useCallback(
    async (entries: ModelPackageFileEntry[]) => {
      const extracted = extractModelPackageFiles(
        entries,
        getPackageNameFromEntries(entries),
        acceptExtensions
      )

      if (!extracted) {
        notifyWarning(
          getPackageModelWarning(
            listContainedModelExtensions(entries),
            allowedFormatsLabel,
            '拖入内容里'
          )
        )
        return
      }

      try {
        await uploadResolvedModel(extracted.file)
      } finally {
        revokeLinkedAssetUrls(extracted.linkedAssets)
      }
    },
    [acceptExtensions, allowedFormatsLabel, notifyWarning, uploadResolvedModel]
  )

  const handleDroppedModelReference = React.useCallback(
    async (reference: DroppedModelReference) => {
      const normalizedUrl = reference.url.trim()
      if (!normalizedUrl) {
        return false
      }

      if (normalizedUrl.startsWith('http://') || normalizedUrl.startsWith('https://')) {
        applyResolvedModelUrl(normalizedUrl, reference.fileName)
        return true
      }

      if (localUploadEnabled) {
        const localPath = decodeLocalModelPath(normalizedUrl)
        if (localPath) {
          return await uploadResolvedModel(
            new File([], reference.fileName, { type: 'application/octet-stream' }),
            localPath
          )
        }

        if (normalizedUrl.startsWith('blob:') || normalizedUrl.startsWith('data:')) {
          const response = await fetch(normalizedUrl)
          if (!response.ok) {
            throw new Error(`Failed to load dropped model (${response.status})`)
          }

          const blob = await response.blob()
          return await uploadResolvedModel(
            new File([blob], reference.fileName, {
              type: blob.type || 'application/octet-stream'
            })
          )
        }
      }

      if (urlOnly) {
        notifyWarning('请拖入公开可访问的 OBJ / GLB 链接，或改用点击选择本地模型。')
        return false
      }

      applyResolvedModelUrl(normalizedUrl, reference.fileName)
      return true
    },
    [applyResolvedModelUrl, localUploadEnabled, notifyWarning, uploadResolvedModel, urlOnly]
  )

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragOver(false)
    if (isUploading) return

    const droppedModelReference = getDroppedModelReference(event.dataTransfer)
    if (droppedModelReference) {
      void (async () => {
        try {
          await handleDroppedModelReference(droppedModelReference)
        } catch (error) {
          console.error('[Hy3D] 解析拖入模型引用失败:', error)
          notifyWarning(error instanceof Error ? error.message : '拖入内容解析失败')
        }
      })()
      return
    }

    if (localUploadEnabled) {
      const droppedFiles = Array.from(event.dataTransfer.files)
      const droppedItems = event.dataTransfer.items

      void (async () => {
        try {
          const droppedEntries =
            droppedItems && droppedItems.length > 0
              ? await collectDroppedDirectoryFiles(droppedItems)
              : []

          if (
            droppedEntries.length > 1 ||
            droppedEntries.some((entry) => entry.path.includes('/'))
          ) {
            await uploadPackageEntries(droppedEntries)
            return
          }

          const file = droppedFiles[0]
          if (!file) {
            notifyWarning('未读取到拖入内容，请改用点击选择。')
            return
          }

          if (isModelArchiveFile(file.name)) {
            let extracted: Awaited<ReturnType<typeof extractModelArchive>> | null = null
            try {
              extracted = await extractModelArchive(file, acceptExtensions)
              if (!extracted) {
                notifyWarning(`压缩包里没有找到可上传的 ${allowedFormatsLabel} 模型文件。`)
                return
              }
              await uploadResolvedModel(extracted.file)
            } catch (error) {
              if (error instanceof ModelPackageUnsupportedFormatError) {
                notifyWarning(
                  getPackageModelWarning(
                    error.detectedModelExtensions,
                    allowedFormatsLabel,
                    '压缩包里'
                  )
                )
                return
              }
              throw error
            } finally {
              if (extracted) {
                revokeLinkedAssetUrls(extracted.linkedAssets)
              }
            }
            return
          }

          await uploadResolvedModel(file)
        } catch (error) {
          console.error('[Hy3D] 解析拖入模型失败:', error)
          notifyWarning(error instanceof Error ? error.message : '拖入内容解析失败')
        }
      })()
      return
    }

    if (urlOnly) return
    const file = event.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!urlOnly || localUploadEnabled || Boolean(getDroppedModelReference(event.dataTransfer))) {
      event.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragOver(false)
  }

  const handlePickFile = React.useCallback(() => {
    if (isUploading) return

    if (localUploadEnabled) {
      void (async () => {
        const dialogResult = await api().svcDialog.showOpenDialog({
          title: label || '选择 3D 模型',
          properties: ['openFile'],
          filters: [
            {
              name: `${allowedFormatsLabel} Model`,
              extensions: acceptExtensions.map((ext) => ext.replace(/^\./, ''))
            }
          ]
        })

        const selectedPath = dialogResult.filePaths?.[0]
        if (!dialogResult.canceled && selectedPath) {
          await uploadResolvedModel(
            new File([], getFileNameFromPath(selectedPath), {
              type: 'application/octet-stream'
            }),
            selectedPath
          )
        }
      })()
      return
    }

    if (urlOnly) {
      focusUrlInput()
      return
    }

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = acceptExtensions.join(',')
    input.onchange = (event: any) => {
      const file = event.target?.files?.[0]
      if (file) handleFile(file)
    }
    input.click()
  }, [
    acceptExtensions,
    allowedFormatsLabel,
    focusUrlInput,
    handleFile,
    isUploading,
    label,
    localUploadEnabled,
    uploadResolvedModel,
    urlOnly
  ])

  const handleClear = () => {
    if (value.startsWith('blob:')) URL.revokeObjectURL(value)
    onChange('')
    setLocalFileName('')
    setPreviewLoadError('')
    clearStoredModelMeta()
    onClear?.()
  }

  const getDisplayName = React.useCallback((): string => {
    if (localFileName) return localFileName
    const pastedHint = parseHy3dModelInputValue(value).modelSourceFileName
    if (pastedHint) return pastedHint
    if (isRemoteUrl) {
      try {
        return decodeURIComponent(value.split('/').pop() || value)
      } catch {
        return value
      }
    }
    return ''
  }, [isRemoteUrl, localFileName, value])

  const previewInstanceCacheKey = React.useMemo(() => {
    if (!value) return undefined

    const resolvedFileName = getDisplayName()
    if (!resolvedFileName) return undefined

    return getSceneInstanceCloneCacheKey({
      sessionKey: DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
      src: value,
      fileName: resolvedFileName,
      itemId: `hy3d-preview:${value}`
    })
  }, [getDisplayName, value])

  const renderModelScene = () => {
    const ext = inferExt(getDisplayName())
    switch (ext) {
      case 'glb':
      case 'gltf':
        return (
          <GLTFScene
            src={value}
            instanceCacheKey={previewInstanceCacheKey}
            onBoundsChange={setPreviewBounds}
            emitModelCenteredEvent={false}
          />
        )
      case 'fbx':
        return (
          <FBXScene
            src={value}
            instanceCacheKey={previewInstanceCacheKey}
            onBoundsChange={setPreviewBounds}
            emitModelCenteredEvent={false}
          />
        )
      case 'obj':
        return (
          <OBJScene
            src={value}
            instanceCacheKey={previewInstanceCacheKey}
            onBoundsChange={setPreviewBounds}
            emitModelCenteredEvent={false}
          />
        )
      case 'stl':
        return (
          <STLScene
            src={value}
            instanceCacheKey={previewInstanceCacheKey}
            onBoundsChange={setPreviewBounds}
            emitModelCenteredEvent={false}
          />
        )
      default:
        return null
    }
  }

  const emptyTitle = isUploading
    ? '正在上传本地模型...'
    : localUploadEnabled
      ? isDragOver
        ? '松开放入并上传模型'
        : '选择本地模型或拖入文件'
      : urlOnly
        ? '粘贴公开可访问的模型 URL'
        : isDragOver
          ? '松开放入模型'
          : '拖入 3D 模型文件'

  const emptySubtitle = localUploadEnabled
    ? `支持 ${allowedFormatsLabel} 文件、文件夹或 ZIP 模型包，也可粘贴公开 URL`
    : urlOnly
      ? `支持 ${allowedFormatsLabel} 链接`
      : `支持 ${allowedFormatsLabel} 文件或公开 URL`

  const previewFallback = (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        px: 2,
        textAlign: 'center'
      }}
    >
      <ViewInArIcon sx={{ fontSize: 28, color: 'rgba(255,255,255,0.24)' }} />
      <Typography sx={{ fontSize: 12.5, color: 'rgba(255,255,255,0.72)', fontWeight: 500 }}>
        模型预览加载失败
      </Typography>
      <Typography sx={{ fontSize: 11.5, color: 'rgba(255,255,255,0.48)' }}>
        {previewLoadError || '请重新选择模型，或粘贴新的可访问链接'}
      </Typography>
    </Box>
  )

  return (
    <Box sx={{ mb: 2, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <SectionLabel
        info={
          localUploadEnabled
            ? '选择或拖入本地模型后会自动上传到 COS 并生成临时 URL，支持直接拖入文件夹或 ZIP 模型包，也可粘贴公开可访问的模型 URL。'
            : urlOnly
              ? '该接口只接受公开可访问的模型 URL。'
              : '拖入 3D 模型文件或粘贴 URL'
        }
      >
        {label || '3D 模型'}
      </SectionLabel>

      {hasModel ? (
        <Box
          data-testid="hy3d-model-preview-drop-zone"
          onDrop={handleDrop}
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          sx={{
            position: 'relative',
            width: '100%',
            flex: 1,
            minHeight: 180,
            borderRadius: '10px',
            overflow: 'hidden',
            border: isDragOver
              ? '1.5px dashed rgba(99,102,241,0.6)'
              : '1px solid rgba(255,255,255,0.1)',
            bgcolor: isDragOver ? 'rgba(99,102,241,0.08)' : '#1a1b1f',
            cursor: 'default',
            transition: 'border-color 0.2s ease, background-color 0.2s ease',
            '&:active': { cursor: 'default' }
          }}
        >
          {isRefreshingSignedUrl || previewNeedsSignedUrlRefresh ? (
            <Box
              sx={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1
              }}
            >
              <CircularProgress size={28} sx={{ color: 'rgba(99,102,241,0.8)' }} />
              <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.62)' }}>
                正在刷新模型链接...
              </Typography>
            </Box>
          ) : previewLoadError ? (
            previewFallback
          ) : (
            <InlinePreviewErrorBoundary fallback={previewFallback} resetKey={value}>
              <Suspense
                fallback={
                  <Box
                    sx={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    <ViewInArIcon
                      sx={{
                        fontSize: 32,
                        color: 'rgba(255,255,255,0.15)',
                        animation: 'pulse 1.5s infinite'
                      }}
                    />
                  </Box>
                }
              >
                <Canvas
                  camera={{ position: [0, 0, 3.2], fov: 40 }}
                  gl={{
                    alpha: true,
                    antialias: false,
                    powerPreference: 'high-performance',
                    preserveDrawingBuffer: false,
                    stencil: false
                  }}
                  dpr={1}
                  frameloop="demand"
                  shadows={false}
                  style={{ width: '100%', height: '100%', background: 'transparent' }}
                >
                  <ModelSceneCanvasSetup enableEnvironment={false} />
                  <ambientLight intensity={0.78} />
                  <hemisphereLight args={['#ffffff', '#52606d', 0.58]} />
                  <directionalLight position={[5, 8, 5]} intensity={0.66} />
                  <directionalLight position={[-4, 3, -4]} intensity={0.22} />
                  <Suspense
                    fallback={
                      <mesh>
                        <boxGeometry args={[1, 1, 1]} />
                        <meshStandardMaterial color="#6366f1" wireframe opacity={0.5} transparent />
                      </mesh>
                    }
                  >
                    {renderModelScene()}
                  </Suspense>
                  <OrbitControls
                    makeDefault
                    enablePan
                    enableZoom
                    enableRotate
                    enableDamping={false}
                    minDistance={0.5}
                    maxDistance={10}
                  />
                  <PreviewAutoFitCamera bounds={previewBounds} />
                </Canvas>
              </Suspense>
            </InlinePreviewErrorBoundary>
          )}

          <Box
            sx={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              px: 1.3,
              py: 0.6,
              background: 'linear-gradient(transparent, rgba(0,0,0,0.75))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
              <ViewInArIcon sx={{ fontSize: 14, color: '#a5b4fc', flexShrink: 0 }} />
              <Typography
                sx={{
                  fontSize: 11.5,
                  color: '#e0e7ff',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {getDisplayName()}
              </Typography>
            </Box>
          </Box>

          <IconButton
            size="small"
            onClick={handleClear}
            sx={{
              position: 'absolute',
              top: 6,
              right: 6,
              bgcolor: 'rgba(0,0,0,0.6)',
              color: '#ff4d4f',
              width: 28,
              height: 28,
              zIndex: 10,
              '&:hover': { bgcolor: 'rgba(0,0,0,0.85)' }
            }}
          >
            <DeleteOutlineIcon sx={{ fontSize: 16 }} />
          </IconButton>

          {isDragOver && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'rgba(15,23,42,0.28)',
                pointerEvents: 'none',
                zIndex: 6
              }}
            >
              <Typography
                sx={{
                  px: 1.4,
                  py: 0.7,
                  borderRadius: 999,
                  bgcolor: 'rgba(15,23,42,0.84)',
                  border: '1px solid rgba(99,102,241,0.5)',
                  color: '#e0e7ff',
                  fontSize: 12.5,
                  fontWeight: 600
                }}
              >
                松开替换当前模型
              </Typography>
            </Box>
          )}
        </Box>
      ) : (
        <Box
          data-testid="hy3d-model-drop-zone"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={handlePickFile}
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.1,
            py: 3.2,
            borderRadius: '10px',
            border: `1.5px dashed ${isDragOver ? 'rgba(99,102,241,0.6)' : hyColors.dashedBorder}`,
            bgcolor: isDragOver ? 'rgba(99,102,241,0.08)' : hyColors.softBg,
            cursor: isUploading ? 'progress' : localUploadEnabled || !urlOnly ? 'pointer' : 'text',
            transition: 'all 0.25s ease',
            minHeight: 120,
            '&:hover':
              isUploading || (!localUploadEnabled && urlOnly)
                ? {}
                : {
                    borderColor: localUploadEnabled
                      ? 'rgba(99,102,241,0.35)'
                      : hyColors.softHoverBorder,
                    bgcolor: localUploadEnabled ? 'rgba(99,102,241,0.04)' : hyColors.softHoverBg,
                    '& .drop-icon': {
                      transform: localUploadEnabled ? 'none' : 'translateY(-2px)',
                      color: localUploadEnabled ? 'rgba(99,102,241,0.7)' : hyColors.textSecondary
                    }
                  }
          }}
        >
          {isUploading ? (
            <CircularProgress size={28} sx={{ color: 'rgba(99,102,241,0.8)' }} />
          ) : (
            <ViewInArIcon
              className="drop-icon"
              sx={{
                fontSize: 32,
                color: isDragOver ? 'rgba(99,102,241,0.7)' : hyColors.mutedIcon,
                transition: 'all 0.25s ease'
              }}
            />
          )}
          <Typography sx={{ fontSize: 13.5, color: hyColors.textSecondary, fontWeight: 500 }}>
            {emptyTitle}
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: hyColors.textSecondary }}>
            {emptySubtitle}
          </Typography>
        </Box>
      )}

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          mt: 0.8,
          gap: 0.5,
          flexShrink: 0
        }}
      >
        <Typography
          data-testid="hy3d-model-url-toggle"
          onClick={toggleUrlInput}
          sx={{
            fontSize: 12.5,
            color: hyColors.primaryHover,
            cursor: isUploading ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 0.3,
            '&:hover': { opacity: isUploading ? 1 : 0.8 }
          }}
        >
          <LinkIcon sx={{ fontSize: 15 }} />
          {showUrlInput ? '收起 URL' : '粘贴 URL'}
        </Typography>
      </Box>

      {showUrlInput && (
        <TextField
          fullWidth
          inputRef={urlInputRef}
          placeholder={`https://example.com/model${acceptExtensions[0] || '.glb'}`}
          value={value.startsWith('blob:') ? '' : value}
          onChange={(event) => {
            const parsedInput = parseHy3dModelInputValue(event.target.value)
            setLocalFileName(parsedInput.modelSourceFileName)
            onMetaChange?.({
              ...EMPTY_MODEL_META,
              sourceFileName: parsedInput.modelSourceFileName
            })
            onChange(parsedInput.modelUrl)
          }}
          disabled={isUploading}
          size="small"
          sx={{
            mt: 0.5,
            '& .MuiOutlinedInput-root': {
              bgcolor: hyColors.card,
              color: hyColors.textPrimary,
              fontSize: 12.5,
              borderRadius: '7px',
              height: 38,
              '& fieldset': { borderColor: 'transparent' },
              '&:hover': { bgcolor: hyColors.cardHover },
              '&.Mui-focused fieldset': { borderColor: hyColors.primary, borderWidth: '1px' }
            },
            '& .MuiInputBase-input': {
              '&::placeholder': { color: hyColors.textSecondary, opacity: 0.6, fontSize: 12 }
            }
          }}
        />
      )}
    </Box>
  )
}

export default ModelDropZone
