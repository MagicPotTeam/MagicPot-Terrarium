/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react'
import { Menu, MenuItem } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { api } from '@renderer/utils/windowUtils'
import { useMessage } from '@renderer/hooks/useMessage'

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
      const response = await fetch(imageUrl)
      const blob = await response.blob()
      const arrayBuffer = await blob.arrayBuffer()
      const res = await api().svcHyper.writeImageToClipboard({ data: new Uint8Array(arrayBuffer) })
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
              const DOWNLOAD_DIR_KEY = 'qapp.downloadDir'
              let downloadDir = localStorage.getItem(DOWNLOAD_DIR_KEY) || config.download_dir

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
                localStorage.setItem(DOWNLOAD_DIR_KEY, downloadDir)
                api().svcState.saveConfig({ config: { download_dir: downloadDir } })
              }

              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
              const fileName = `image_${timestamp}.png`
              const response = await fetch(imageContextMenu.imageUrl || '')
              const blob = await response.blob()
              const arrayBuffer = await blob.arrayBuffer()
              const data = new Uint8Array(arrayBuffer)
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
              const response = await fetch(imageContextMenu.imageUrl || '')
              const blob = await response.blob()
              const reader = new FileReader()
              const dataUrl = await new Promise<string>((resolve, reject) => {
                reader.onload = () => resolve(reader.result as string)
                reader.onerror = reject
                reader.readAsDataURL(blob)
              })

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
