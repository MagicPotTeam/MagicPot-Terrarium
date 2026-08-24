import React, { useCallback, useEffect, useRef, useState } from 'react'
import { InputProps } from './InputProps'
import { Button } from '@mui/material'
import { PhotoLibraryOutlined } from '@mui/icons-material'
import { api } from '@renderer/utils/windowUtils'
import BaseInputComfyImage from './BaseInputComfyImage'
import { valueToFileItem } from '@shared/comfy/funcs'
import {
  getDeferredComfyImageDisplayName,
  isDeferredComfyInputValue,
  parseDeferredComfyImageInputValue
} from '@shared/comfy/deferredImages'
import {
  buildDeferredComfyImageValue,
  getDeferredComfyLocalPreview
} from '@renderer/utils/deferredComfyInput'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from 'react-i18next'

type InputComfyImageProps = InputProps<string> & {
  placeholder: string
}

const revokePreviewUrl = (url: string | null) => {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url)
  }
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
  const selectionRequestIdRef = useRef(0)
  const previewUrlRef = useRef<string | null>(null)
  const latestValueRef = useRef(value)
  const latestOnChangeRef = useRef(onChange)
  const { notifySuccess, notifyError } = useMessage()
  const { t } = useTranslation()

  const updatePreviewUrl = useCallback((nextUrl: string | null) => {
    setPreviewUrl((prev) => {
      if (prev !== nextUrl) {
        revokePreviewUrl(prev)
      }
      previewUrlRef.current = nextUrl
      return nextUrl
    })
  }, [])

  useEffect(
    () => () => {
      selectionRequestIdRef.current += 1
      previewRequestIdRef.current += 1
      revokePreviewUrl(previewUrlRef.current)
      previewUrlRef.current = null
    },
    []
  )

  useEffect(() => {
    selectionRequestIdRef.current += 1
    latestValueRef.current = value
    setInternalValue((current) => (value !== current ? value : current))
    setIsLoading(false)
  }, [value])

  useEffect(() => {
    latestOnChangeRef.current = onChange
  }, [onChange])

  const commitValue = useCallback((nextValue: string) => {
    setInternalValue((current) => (current === nextValue ? current : nextValue))
    if (latestValueRef.current !== nextValue) {
      latestValueRef.current = nextValue
      latestOnChangeRef.current(nextValue)
    }
  }, [])

  const doUpload = useCallback(
    async (file: File) => {
      const requestId = ++selectionRequestIdRef.current
      setIsLoading(true)
      try {
        const nextValue = await buildDeferredComfyImageValue(file)
        if (selectionRequestIdRef.current !== requestId) return
        commitValue(nextValue)
      } catch (error) {
        if (selectionRequestIdRef.current !== requestId) return
        console.error('[InputComfyImage] Failed to read image:', error)
        notifyError(
          t('input.image.load_failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        )
      } finally {
        if (selectionRequestIdRef.current === requestId) setIsLoading(false)
      }
    },
    [commitValue, notifyError, t]
  )

  const handleLoadFromPhotoshop = useCallback(async () => {
    const requestId = ++selectionRequestIdRef.current
    try {
      setIsLoading(true)
      const res = await api().svcPhotoshop.loadImageFromPhotoshop({})
      if (selectionRequestIdRef.current !== requestId) return
      const blob = new Blob([res.image as BlobPart], { type: 'image/png' })
      const file = new File([blob], res.fileName || `photoshop-${Date.now()}.png`, {
        type: 'image/png'
      })
      const nextValue = await buildDeferredComfyImageValue(file)
      if (selectionRequestIdRef.current !== requestId) return
      commitValue(nextValue)
      notifySuccess(t('input.image.photoshop_loaded'))
    } catch (error) {
      if (selectionRequestIdRef.current !== requestId) return
      console.error(t('input.image.photoshop_load_failed_log'), error)
      notifyError(
        t('input.image.load_failed_short', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      if (selectionRequestIdRef.current === requestId) setIsLoading(false)
    }
  }, [commitValue, notifyError, notifySuccess, t])

  const handleClear = useCallback(() => {
    selectionRequestIdRef.current += 1
    setIsLoading(false)
    commitValue('')
    previewRequestIdRef.current += 1
    updatePreviewUrl(null)
  }, [commitValue, updatePreviewUrl])

  useEffect(() => {
    const requestId = ++previewRequestIdRef.current
    let urlToRevoke: string | null = null

    if (!internalValue) {
      updatePreviewUrl(null)
      return
    }

    let deferredValue
    try {
      deferredValue = parseDeferredComfyImageInputValue(internalValue)
    } catch {
      updatePreviewUrl(null)
      return
    }
    if (deferredValue?.dataUrl) {
      updatePreviewUrl(deferredValue.dataUrl)
      return
    }

    ;(async () => {
      try {
        const localPreview = deferredValue
          ? await getDeferredComfyLocalPreview(internalValue)
          : null
        const image: Uint8Array = localPreview?.bytes
          ? localPreview.bytes
          : isDeferredComfyInputValue(internalValue)
            ? (() => {
                throw new Error('Deferred Comfy input is unavailable.')
              })()
            : (await api().svcComfy.getView(valueToFileItem(internalValue))).result
        if (previewRequestIdRef.current !== requestId) return
        const blob = new Blob([image as BlobPart], {
          type: localPreview?.mimeType || deferredValue?.mimeType || 'image/*'
        })
        const url = URL.createObjectURL(blob)
        urlToRevoke = url
        updatePreviewUrl(url)
        urlToRevoke = null
      } catch (error) {
        // ComfyUI may be stopped while the form still contains a previously uploaded image name.
        // Keep the value intact; only hide the preview until ComfyUI can serve it again.
        console.warn('[InputComfyImage] Failed to load image preview:', internalValue, error)
        if (previewRequestIdRef.current === requestId) {
          updatePreviewUrl(null)
        }
      }
    })()

    return () => {
      if (previewRequestIdRef.current === requestId) {
        previewRequestIdRef.current += 1
      }
      revokePreviewUrl(urlToRevoke)
    }
  }, [internalValue, updatePreviewUrl])

  return (
    <BaseInputComfyImage
      label={label}
      Icon={Icon}
      placeholder={placeholder}
      internalValue={getDeferredComfyImageDisplayName(internalValue)}
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
