import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../utils/windowUtils'
import { sanitizeFilePart, sanitizeRelativePathSegments } from './canvasExportNamingUtils'
import type { CanvasItem, CanvasModel3DItem, CanvasVideoItem } from './types'

type NotifyFn = (message: string) => unknown
type DownloadImageFormat = 'png' | 'jpg' | 'jpeg' | 'svg'
type RenderedImageFormat = 'png' | 'jpeg' | 'svg'

type UseCanvasMediaActionsOptions = {
  notifySuccess: NotifyFn
  notifyError: NotifyFn
  renderCanvasItemsImageBytes: (
    targetItems: CanvasItem[],
    format: RenderedImageFormat,
    includeBackground?: boolean
  ) => Promise<Uint8Array>
}

const IMAGE_DOWNLOAD_FILTERS = [
  { name: 'PNG Image', extensions: ['png'] },
  { name: 'JPG Image', extensions: ['jpg'] },
  { name: 'JPEG Image', extensions: ['jpeg'] },
  { name: 'SVG Image', extensions: ['svg'] }
]

const getImageDownloadExtension = (format: DownloadImageFormat): string => {
  if (format === 'jpg') return '.jpg'
  if (format === 'jpeg') return '.jpeg'
  if (format === 'svg') return '.svg'
  return '.png'
}

const inferImageDownloadFormat = (filePath: string): DownloadImageFormat => {
  const extension = window.path.extname(filePath).toLowerCase()

  if (extension === '.jpg') return 'jpg'
  if (extension === '.jpeg') return 'jpeg'
  if (extension === '.svg') return 'svg'
  return 'png'
}

const normalizeImageDownloadPath = (filePath: string, format: DownloadImageFormat): string => {
  const parsed = window.path.parse(filePath)
  const extension = (parsed.ext || '').toLowerCase()

  if (['.png', '.jpg', '.jpeg', '.svg'].includes(extension)) {
    return filePath
  }

  return window.path.join(
    parsed.dir || '',
    `${parsed.name || 'canvas-image'}${getImageDownloadExtension(format)}`
  )
}

function toRenderedImageFormat(format: DownloadImageFormat): RenderedImageFormat {
  if (format === 'jpg' || format === 'jpeg') {
    return 'jpeg'
  }

  return format
}

async function fetchBinaryAsset(url: string, label: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `${label} request failed (${response.status} ${response.statusText || 'unknown'})`
    )
  }

  const blob = await response.blob()
  const arrayBuffer = await blob.arrayBuffer()
  return new Uint8Array(arrayBuffer)
}

export function useCanvasMediaActions({
  notifySuccess,
  notifyError,
  renderCanvasItemsImageBytes
}: UseCanvasMediaActionsOptions) {
  const { t } = useTranslation()

  const chooseDownloadDir = useCallback(async (title: string) => {
    const DOWNLOAD_DIR_KEY = 'qapp.downloadDir'
    let downloadDir = localStorage.getItem(DOWNLOAD_DIR_KEY)?.trim()

    if (!downloadDir) {
      try {
        const { config } = await api().svcState.getConfig({})
        downloadDir = config.download_dir?.trim()
        if (downloadDir) {
          localStorage.setItem(DOWNLOAD_DIR_KEY, downloadDir)
        }
      } catch (error) {
        console.warn('[download] failed to read default download dir from config:', error)
      }
    }

    const result = await api().svcDialog.showOpenDialog({
      title,
      properties: ['openDirectory'],
      defaultPath: downloadDir || undefined
    })
    if (result.canceled || !result.filePaths?.length) return null

    downloadDir = result.filePaths[0]
    localStorage.setItem(DOWNLOAD_DIR_KEY, downloadDir)
    void api()
      .svcState.saveConfig({ config: { download_dir: downloadDir } })
      .catch((error) => {
        console.warn('[download] failed to persist download dir:', error)
      })

    return downloadDir
  }, [])

  const chooseImageDownloadTarget = useCallback(async (defaultBaseName: string) => {
    const result = await api().svcDialog.showSaveDialog({
      title: 'Save exported image',
      defaultPath: defaultBaseName,
      filters: IMAGE_DOWNLOAD_FILTERS
    })
    if (result.canceled || !result.filePath) return null

    const format = inferImageDownloadFormat(result.filePath)
    return {
      format,
      filePath: normalizeImageDownloadPath(result.filePath, format)
    }
  }, [])

  const chooseFileDownloadPath = useCallback(
    async (title: string, defaultFileName: string, extensions?: string[]) => {
      const result = await api().svcDialog.showSaveDialog({
        title,
        defaultPath: defaultFileName,
        filters:
          extensions && extensions.length > 0
            ? [{ name: `${extensions[0].toUpperCase()} File`, extensions }]
            : undefined
      })

      if (result.canceled || !result.filePath) return null
      return result.filePath
    },
    []
  )

  const handleCopyCanvasItemsAsImage = useCallback(
    async (targetItems: CanvasItem[]) => {
      if (targetItems.length === 0) return

      try {
        const data = await renderCanvasItemsImageBytes(targetItems, 'png', false)
        const result = await api().svcHyper.writeImageToClipboard({ data })

        if (!result.success) {
          throw new Error('Native clipboard write returned false')
        }

        notifySuccess(t('chat.image_copied'))
      } catch (error) {
        console.error('Copy canvas snapshot failed:', error)
        notifyError(t('chat.image_copy_failed'))
      }
    },
    [notifyError, notifySuccess, renderCanvasItemsImageBytes, t]
  )

  const handleDownloadCanvasItemsAsImage = useCallback(
    async (targetItems: CanvasItem[], prefix = 'canvas-image') => {
      if (targetItems.length === 0) return

      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const defaultBaseName = `${sanitizeFilePart(prefix)}-${timestamp}`
        const target = await chooseImageDownloadTarget(defaultBaseName)
        if (!target) return

        const bytes = await renderCanvasItemsImageBytes(
          targetItems,
          toRenderedImageFormat(target.format),
          false
        )

        await api().svcFs.saveImageToPath({
          image: bytes,
          outputPath: window.path.dirname(target.filePath),
          filename: window.path.basename(target.filePath)
        })

        notifySuccess(`Saved ${window.path.basename(target.filePath)}`)
        console.log(`[download] saved to ${target.filePath}`)
      } catch (error) {
        console.error('Save canvas snapshot failed:', error)
        notifyError(
          `Failed to save image: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },
    [chooseImageDownloadTarget, notifyError, notifySuccess, renderCanvasItemsImageBytes]
  )

  const handleDownloadBlobItem = useCallback(
    async (item: CanvasModel3DItem | CanvasVideoItem) => {
      try {
        const data = await fetchBinaryAsset(
          item.src,
          item.type === 'model3d' ? 'Model file' : 'Video file'
        )

        if (item.type === 'model3d') {
          const textureEntries = Object.entries(item.textures || {})

          if (textureEntries.length > 0) {
            const downloadDir = await chooseDownloadDir('Select a folder to save the model package')
            if (!downloadDir) return

            const modelDir = window.path.join(
              downloadDir,
              sanitizeFilePart(item.fileName.replace(/\.[^.]+$/, ''))
            )

            const saveRelativeFile = async (
              baseDir: string,
              relativePath: string,
              fileData: Uint8Array
            ) => {
              const segments = sanitizeRelativePathSegments(relativePath)
              const fileName = segments[segments.length - 1] || 'texture.bin'
              const targetDir =
                segments.length > 1 ? window.path.join(baseDir, ...segments.slice(0, -1)) : baseDir

              return api().svcHyper.saveImageToDir({
                data: fileData,
                fileName,
                dir: targetDir
              })
            }

            const modelResult = await api().svcHyper.saveImageToDir({
              data,
              fileName: sanitizeFilePart(item.fileName),
              dir: modelDir
            })

            let savedTextureCount = 0
            for (const [textureName, textureUrl] of textureEntries) {
              try {
                const textureData = await fetchBinaryAsset(textureUrl, `Texture "${textureName}"`)
                await saveRelativeFile(modelDir, textureName, textureData)
                savedTextureCount += 1
              } catch (error) {
                console.warn(`[download] skipped texture ${textureName}:`, error)
              }
            }

            notifySuccess(
              savedTextureCount === textureEntries.length
                ? `Saved model package with ${savedTextureCount} texture files`
                : `Saved model package with ${savedTextureCount}/${textureEntries.length} texture files`
            )
            console.log(`[download] saved model package to ${modelResult.savedPath}`)
            return
          }
        }

        const sanitizedFileName = sanitizeFilePart(item.fileName)
        const rawExtension = window.path.extname(sanitizedFileName).replace(/^\./, '').toLowerCase()
        const targetPath = await chooseFileDownloadPath(
          item.type === 'model3d' ? 'Save model file' : 'Save video file',
          sanitizedFileName,
          rawExtension ? [rawExtension] : undefined
        )
        if (!targetPath) return

        await api().svcFs.saveImageToPath({
          image: data,
          outputPath: window.path.dirname(targetPath),
          filename: window.path.basename(targetPath)
        })
        notifySuccess(`Saved ${window.path.basename(targetPath)}`)
        console.log(`[download] saved to ${targetPath}`)
      } catch (error) {
        console.error('Save blob item failed:', error)
        notifyError(
          `Failed to save ${item.type === 'model3d' ? 'model' : 'video'}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    },
    [chooseDownloadDir, chooseFileDownloadPath, notifyError, notifySuccess]
  )

  return {
    handleCopyCanvasItemsAsImage,
    handleDownloadCanvasItemsAsImage,
    handleDownloadBlobItem
  }
}
