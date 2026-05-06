import React, { useCallback, useEffect, useState } from 'react'
import { InputProps } from './InputProps'
import { Box, IconButton, Typography, Button } from '@mui/material'
import { UploadOutlined, PhotoLibraryOutlined } from '@mui/icons-material'
import { api } from '@renderer/utils/windowUtils'
import { FileItem } from '@shared/comfy/types'
import BaseInputComfyImage from './BaseInputComfyImage'
import { fileItemToValue, valueToFileItem } from '@shared/comfy/funcs'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from 'react-i18next'

type InputComfyImageProps = InputProps<string> & {
  placeholder: string
}

const InputComfyImage: React.FC<InputComfyImageProps> = ({
  value,
  label,
  onChange,
  placeholder,
  Icon
}) => {
  const [internalValue, setInternalValue] = useState(value)
  const [isLoading, setIsLoading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const { notifySuccess, notifyError } = useMessage()
  const { t } = useTranslation()

  // 同步外部 value 变化到 internalValue
  useEffect(() => {
    if (value !== internalValue) {
      setInternalValue(value)
    }
  }, [value, internalValue])

  const doUpload = async (file: File) => {
    setIsLoading(true)
    try {
      const arrayBuffer = await file.arrayBuffer()
      const uint8 = new Uint8Array(arrayBuffer)
      const res: FileItem = await api().svcComfy.uploadImage({
        fileItem: { filename: file.name, type: 'input' },
        image: uint8
      })
      if (!res.filename) {
        throw new Error('failed to upload image, response did not contain filename')
      }
      const uploadedName = fileItemToValue(res)
      setInternalValue(uploadedName)
      onChange(uploadedName)
    } catch (error) {
      console.error('[InputComfyImage] Upload failed:', error)
      notifyError(
        t('input.image.load_failed', {
          error: error instanceof Error ? error.message : t('input.image.check_comfy_connection')
        })
      )
    } finally {
      setIsLoading(false)
    }
  }

  const viewImage = useCallback(async () => {
    const res = await api().svcComfy.getView(valueToFileItem(internalValue))
    const image: Uint8Array = res.result
    return image
  }, [internalValue])

  const handleLoadFromPhotoshop = async () => {
    try {
      setIsLoading(true)
      const res = await api().svcPhotoshop.loadImageFromPhotoshop({})

      // 将图片上传到 ComfyUI
      const fileItem: FileItem = await api().svcComfy.uploadImage({
        fileItem: { filename: res.fileName, type: 'input' },
        image: res.image
      })

      if (!fileItem.filename) {
        throw new Error(t('input.image.upload_missing_filename'))
      }

      const uploadedName = fileItemToValue(fileItem)
      setInternalValue(uploadedName)
      onChange(uploadedName)
      notifySuccess(t('input.image.photoshop_loaded'))
    } catch (error) {
      console.error(t('input.image.photoshop_load_failed_log'), error)
      notifyError(
        t('input.image.load_failed_short', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    ;(async () => {
      if (!internalValue) {
        setPreviewUrl(null)
        return
      }
      try {
        const bytes = await viewImage()
        if (!active) return
        const blob = new Blob([bytes as BlobPart], { type: 'image/*' })
        const url = URL.createObjectURL(blob)
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return url
        })
      } catch {
        // Image file doesn't exist anymore, clear the value
        console.warn('[InputComfyImage] Failed to load image, clearing value:', internalValue)
        if (active) {
          setInternalValue('')
          onChange('')
          setPreviewUrl(null)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [internalValue, viewImage, onChange])

  return (
    <BaseInputComfyImage
      label={label}
      Icon={Icon}
      placeholder={placeholder}
      internalValue={internalValue}
      isLoading={isLoading}
      previewUrl={previewUrl}
      doUpload={doUpload}
      buttonSlot={
        <Button
          size="small"
          variant="outlined"
          startIcon={<PhotoLibraryOutlined />}
          onClick={(e) => {
            e.stopPropagation()
            void handleLoadFromPhotoshop()
          }}
          disabled={isLoading}
          sx={{ ml: 'auto' }}
        >
          {t('input.image.load_from_photoshop')}
        </Button>
      }
    />
  )
}

export default InputComfyImage
