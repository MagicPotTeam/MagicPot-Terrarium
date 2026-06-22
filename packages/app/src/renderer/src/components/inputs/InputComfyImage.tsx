import React, { useCallback, useEffect, useRef, useState } from 'react'
import { InputProps } from './InputProps'
import { Button } from '@mui/material'
import { PhotoLibraryOutlined } from '@mui/icons-material'
import { api } from '@renderer/utils/windowUtils'
import BaseInputComfyImage from './BaseInputComfyImage'
import { valueToFileItem } from '@shared/comfy/funcs'
import {
  encodeDeferredComfyImageInputValue,
  getDeferredComfyImageDisplayName,
  parseDeferredComfyImageInputValue
} from '@shared/comfy/deferredImages'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from 'react-i18next'

type InputComfyImageProps = InputProps<string> & {
  placeholder: string
}

const IMAGE_EXTENSIONS_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

const inferImageMimeTypeFromFile = (file: File): string => {
  if (file.type.startsWith('image/')) return file.type
  const lowerName = file.name.trim().toLowerCase()
  const extension = Object.keys(IMAGE_EXTENSIONS_TO_MIME).find((ext) => lowerName.endsWith(ext))
  return (extension && IMAGE_EXTENSIONS_TO_MIME[extension]) || 'image/png'
}

const readBlobArrayBuffer = async (blob: Blob): Promise<ArrayBuffer> => {
  const maybeArrayBuffer = (blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer
  if (typeof maybeArrayBuffer === 'function') {
    return maybeArrayBuffer.call(blob)
  }

  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('failed to read image file'))
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result)
        return
      }
      reject(new Error('failed to read image file'))
    }
    reader.readAsArrayBuffer(blob)
  })
}

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

const buildDeferredComfyImageValue = async (file: File): Promise<string> => {
  const mimeType = inferImageMimeTypeFromFile(file)
  const buffer = await readBlobArrayBuffer(file)
  const fileName = file.name || `image-${Date.now()}.png`
  const imageBytes = new Uint8Array(buffer)

  try {
    const saved = await api().svcFs.saveQAppInputImage({
      filename: fileName,
      image: imageBytes
    })
    if (saved.fullPath) {
      return encodeDeferredComfyImageInputValue({
        fileName,
        mimeType,
        sizeBytes: file.size,
        filePath: saved.fullPath
      })
    }
  } catch (error) {
    // Keep drag/drop usable even if the durable cache is unavailable.
    // The inline payload path is also used for older saved form state.
    console.warn(
      '[InputComfyImage] Failed to persist image input, falling back to inline data:',
      error
    )
  }

  return encodeDeferredComfyImageInputValue({
    fileName,
    mimeType,
    sizeBytes: file.size,
    dataUrl: `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`
  })
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
      revokePreviewUrl(previewUrlRef.current)
      previewUrlRef.current = null
    },
    []
  )

  useEffect(() => {
    latestValueRef.current = value
    setInternalValue((current) => (value !== current ? value : current))
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
      setIsLoading(true)
      try {
        commitValue(await buildDeferredComfyImageValue(file))
      } catch (error) {
        console.error('[InputComfyImage] Failed to read image:', error)
        notifyError(
          t('input.image.load_failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        )
      } finally {
        setIsLoading(false)
      }
    },
    [commitValue, notifyError, t]
  )

  const handleLoadFromPhotoshop = useCallback(async () => {
    try {
      setIsLoading(true)
      const res = await api().svcPhotoshop.loadImageFromPhotoshop({})
      const blob = new Blob([res.image as BlobPart], { type: 'image/png' })
      const file = new File([blob], res.fileName || `photoshop-${Date.now()}.png`, {
        type: 'image/png'
      })
      commitValue(await buildDeferredComfyImageValue(file))
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
    updatePreviewUrl(null)
  }, [commitValue, updatePreviewUrl])

  useEffect(() => {
    const requestId = ++previewRequestIdRef.current
    let urlToRevoke: string | null = null

    if (!internalValue) {
      updatePreviewUrl(null)
      return
    }

    const deferredValue = parseDeferredComfyImageInputValue(internalValue)
    if (deferredValue?.dataUrl) {
      updatePreviewUrl(deferredValue.dataUrl)
      return
    }

    ;(async () => {
      try {
        const image: Uint8Array = deferredValue?.filePath
          ? (
              await api().svcFs.readImageFromPath({
                fullPath: deferredValue.filePath
              })
            ).image
          : (await api().svcComfy.getView(valueToFileItem(internalValue))).result
        if (previewRequestIdRef.current !== requestId) return
        const blob = new Blob([image as BlobPart], { type: deferredValue?.mimeType || 'image/*' })
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
