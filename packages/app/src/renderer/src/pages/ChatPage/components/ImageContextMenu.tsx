/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react'
import { Menu, MenuItem } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import { useMessage } from '@renderer/hooks/useMessage'
import {
  getDownloadFileNameFromUrl,
  normalizeLocalMediaUrl,
  resolveLocalMediaPathFromUrl
} from '../chatPageShared'

const CHAT_DOWNLOAD_DIR_KEY = 'qapp.downloadDir'

const bytesToBase64 = (data: Uint8Array): string => {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

const inferImageMimeType = (fileName: string): string => {
  const normalized = fileName.toLowerCase()
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg'
  if (normalized.endsWith('.webp')) return 'image/webp'
  if (normalized.endsWith('.gif')) return 'image/gif'
  if (normalized.endsWith('.bmp')) return 'image/bmp'
  if (normalized.endsWith('.svg')) return 'image/svg+xml'
  return 'image/png'
}

const resolveImageBytes = async (imageUrl: string, fallbackFileName = 'image.png') => {
  const normalizedUrl = normalizeLocalMediaUrl(imageUrl || '').trim()
  if (!normalizedUrl) {
    throw new Error('Image URL is empty')
  }

  const localPath = resolveLocalMediaPathFromUrl(normalizedUrl)
  const fileNameFromUrl = getDownloadFileNameFromUrl(normalizedUrl, fallbackFileName)
  if (localPath && api().svcFs?.readFileFromPath) {
    const { data, filename } = await api().svcFs.readFileFromPath({ fullPath: localPath })
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayLike<number>)
    const fileName = filename || fileNameFromUrl || fallbackFileName
    return { data: bytes, fileName, mimeType: inferImageMimeType(fileName) }
  }

  const response = await fetch(normalizedUrl)
  if (response.ok === false && response.status !== 0) {
    throw new Error(`Failed to load image (${response.status})`)
  }

  const blob = await response.blob()
  const fileName = fileNameFromUrl || fallbackFileName
  return {
    data: new Uint8Array(await blob.arrayBuffer()),
    fileName,
    mimeType: blob.type || inferImageMimeType(fileName)
  }
}

interface ImageContextMenuProps {
  imageContextMenu: {
    mouseX: number
    mouseY: number
    imageUrl: string
  } | null
  onClose: () => void
  config: any
}

const ImageContextMenu: React.FC<ImageContextMenuProps> = ({
  imageContextMenu,
  onClose,
  config
}) => {
  const { t } = useTranslation()
  const { notifySuccess, notifyError } = useMessage()

  const handleCopyImage = async (imageUrl: string) => {
    try {
      const { data } = await resolveImageBytes(imageUrl, 'image.png')
      const res = await api().svcHyper.writeImageToClipboard({ data })
      if (res.success) {
        notifySuccess(t('chat.image_copied'))
      } else {
        throw new Error('Native clipboard write returned false')
      }
      onClose()
    } catch (error) {
      console.error('[ChatPage] Failed to copy image:', error)
      notifyError(t('chat.image_copy_failed'))
      onClose()
    }
  }

  return (
    <Menu
      open={imageContextMenu !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={
        imageContextMenu !== null
          ? { top: imageContextMenu.mouseY, left: imageContextMenu.mouseX }
          : undefined
      }
    >
      <MenuItem
        onClick={() => {
          if (imageContextMenu) {
            handleCopyImage(imageContextMenu.imageUrl || '')
          }
        }}
      >
        {t('chat.copy_image')}
      </MenuItem>
      <MenuItem
        onClick={async () => {
          if (imageContextMenu) {
            try {
              let downloadDir = localStorage.getItem(CHAT_DOWNLOAD_DIR_KEY) || config.download_dir

              if (!downloadDir) {
                const result = await api().svcDialog.showOpenDialog({
                  title: t('chat.select_download_dir'),
                  properties: ['openDirectory']
                })
                if (result.canceled || !result.filePaths?.length) {
                  onClose()
                  return
                }
                downloadDir = result.filePaths[0]
                localStorage.setItem(CHAT_DOWNLOAD_DIR_KEY, downloadDir)
                api().svcState.saveConfig({ config: { download_dir: downloadDir } })
              }

              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
              const fileName = `image_${timestamp}.png`
              const { data } = await resolveImageBytes(imageContextMenu.imageUrl || '', fileName)
              const res = await api().svcHyper.saveImageToDir({
                data,
                fileName,
                dir: downloadDir
              })
              console.log(`[保存] 已保存到 ${res.savedPath}`)
              // Keep image-save success silent because the toast covers the canvas.
            } catch (error) {
              console.error('保存图片失败:', error)
              notifyError(
                t('chat.image_save_failed', {
                  error: error instanceof Error ? error.message : String(error)
                })
              )
            }
            onClose()
          }
        }}
      >
        {t('chat.save_image')}
      </MenuItem>
      <MenuItem
        onClick={async () => {
          if (imageContextMenu) {
            try {
              const imageBytes = await resolveImageBytes(
                imageContextMenu.imageUrl || '',
                'image.png'
              )
              const dataUrl = `data:${imageBytes.mimeType};base64,${bytesToBase64(imageBytes.data)}`

              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
              const res = await api().svcPhotoshop.sendImageToPhotoshop({
                imageUrl: dataUrl,
                fileName: `chat-image-${timestamp}.png`
              })

              if (res.success) {
                notifySuccess(t('chat.sent_to_photoshop'))
              } else {
                notifyError(
                  t('chat.send_to_photoshop_failed', {
                    error: res.error || t('chat.unknown_error')
                  })
                )
              }
            } catch (error) {
              console.error('发送到当前 Photoshop 文档失败:', error)
              notifyError(
                t('chat.send_to_photoshop_failed', {
                  error: error instanceof Error ? error.message : String(error)
                })
              )
            }
            onClose()
          }
        }}
      >
        {t('chat.send_to_photoshop')}
      </MenuItem>
    </Menu>
  )
}

export default ImageContextMenu
