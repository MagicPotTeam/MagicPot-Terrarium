import React, { useCallback, useEffect, useRef, useState } from 'react'
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
  const previewUrlRef = useRef<string | null>(null)
  const { notifySuccess, notifyError } = useMessage()
  const { t } = useTranslation()

  const updatePreviewUrl = useCallback((nextUrl: string | null) => {
    setPreviewUrl((prev) => {
      if (prev && prev !== nextUrl) {
        URL.revokeObjectURL(prev)
      }
      previewUrlRef.current = nextUrl
      return nextUrl
    })
  }, [])

  useEffect(
    () => () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = null
      }
    },
    []
  )

  // 同步外部 value 变化到 internalValue
  useEffect(() => {
    setInternalValue((prev) => (prev === value ? prev : value))
  }, [value])

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

  const handleClear = useCallback(() => {
    setInternalValue('')
    onChange('')
    updatePreviewUrl(null)
  }, [onChange, updatePreviewUrl])

  useEffect(() => {
    let active = true
    ;(async () => {
      if (!internalValue) {
        updatePreviewUrl(null)
        return
      }
      try {
        const res = await api().svcComfy.getView(valueToFileItem(internalValue))
        if (!active) return
        const image: Uint8Array = res.result
        const blob = new Blob([image as BlobPart], { type: 'image/*' })
        const url = URL.createObjectURL(blob)
        updatePreviewUrl(url)
      } catch (error) {
        // Preview failures should not erase the selected input value; the
        // uploaded image may still be available once ComfyUI refreshes.
        console.warn('[InputComfyImage] Failed to load image preview:', internalValue, error)
        if (active) {
          updatePreviewUrl(null)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [internalValue, updatePreviewUrl])

  return (
    <BaseInputComfyImage
      label={label}
      Icon={Icon}
      placeholder={placeholder}
      internalValue={internalValue}
      isLoading={isLoading}
      previewUrl={previewUrl}
      doUpload={doUpload}
      onClear={handleClear}
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
