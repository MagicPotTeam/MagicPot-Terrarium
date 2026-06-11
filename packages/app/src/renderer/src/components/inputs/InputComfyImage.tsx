import React, { useCallback, useEffect, useRef, useState } from 'react'
import { InputProps } from './InputProps'
import { Button } from '@mui/material'
import { PhotoLibraryOutlined } from '@mui/icons-material'
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
  const previewRequestIdRef = useRef(0)
  const latestValueRef = useRef(value)
  const latestOnChangeRef = useRef(onChange)
  const { notifySuccess, notifyError } = useMessage()
  const { t } = useTranslation()

  useEffect(() => {
    latestValueRef.current = value
  }, [value])

  useEffect(() => {
    latestOnChangeRef.current = onChange
  }, [onChange])

  // 同步外部 value 变化到 internalValue。只依赖外部 value，避免内部预览刷新触发父级重渲染时形成循环。
  useEffect(() => {
    setInternalValue((current) => (value !== current ? value : current))
  }, [value])

  const commitValue = useCallback((nextValue: string) => {
    setInternalValue((current) => (current === nextValue ? current : nextValue))
    if (latestValueRef.current !== nextValue) {
      latestValueRef.current = nextValue
      latestOnChangeRef.current(nextValue)
    }
  }, [])

  const doUpload = useCallback(
    async (file: File) => {
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
        commitValue(fileItemToValue(res))
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
    },
    [commitValue, notifyError, t]
  )

  const viewImage = useCallback(async () => {
    const res = await api().svcComfy.getView(valueToFileItem(internalValue))
    const image: Uint8Array = res.result
    return image
  }, [internalValue])

  const handleLoadFromPhotoshop = useCallback(async () => {
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

      commitValue(fileItemToValue(fileItem))
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
  }, [commitValue, notifyError, notifySuccess, t])

  const handleClear = useCallback(() => {
    commitValue('')
    previewRequestIdRef.current += 1
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
  }, [commitValue])

  useEffect(() => {
    const requestId = ++previewRequestIdRef.current
    let urlToRevoke: string | null = null

    if (!internalValue) {
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
      return
    }

    ;(async () => {
      try {
        const bytes = await viewImage()
        if (previewRequestIdRef.current !== requestId) return
        const blob = new Blob([bytes as BlobPart], { type: 'image/*' })
        const url = URL.createObjectURL(blob)
        urlToRevoke = url
        setPreviewUrl((prev) => {
          if (prev === url) return prev
          if (prev) URL.revokeObjectURL(prev)
          urlToRevoke = null
          return url
        })
      } catch {
        // Image file doesn't exist anymore, clear the value once.
        console.warn('[InputComfyImage] Failed to load image, clearing value:', internalValue)
        if (previewRequestIdRef.current === requestId) {
          commitValue('')
          setPreviewUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev)
            return null
          })
        }
      }
    })()

    return () => {
      if (previewRequestIdRef.current === requestId) {
        previewRequestIdRef.current += 1
      }
      if (urlToRevoke) {
        URL.revokeObjectURL(urlToRevoke)
      }
    }
  }, [internalValue, viewImage, commitValue])

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
