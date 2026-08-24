import React, { useCallback, useEffect, useRef, useState } from 'react'
import { InputProps } from './InputProps'
import { api } from '@renderer/utils/windowUtils'
import {
  buildDeferredComfyImageValue,
  buildDeferredComfyMaskValue,
  getDeferredComfyLocalPreview
} from '@renderer/utils/deferredComfyInput'
import MaskEditor from '../ImageCanvas/MaskEditor'
import ModalLayout from '../ModalLayout'
import { valueToFileItem } from '@shared/comfy/funcs'
import {
  getDeferredComfyFileDisplayName,
  isDeferredComfyInputValue
} from '@shared/comfy/deferredImages'
import BaseInputComfyImage from './BaseInputComfyImage'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from 'react-i18next'

const drawMaskBlob = async (maskCanvas: HTMLCanvasElement) => {
  const tmpCanvas = document.createElement('canvas')
  tmpCanvas.width = maskCanvas.width
  tmpCanvas.height = maskCanvas.height
  const ctx = tmpCanvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get context')
  ctx.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height)
  const imageData = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
  const data = imageData.data

  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 5 || data[i + 1] > 5 || data[i + 2] > 5) {
      // 有东西，应该作为蒙版外（被蒙住）
      data[i] = 0
      data[i + 1] = 0
      data[i + 2] = 0
      data[i + 3] = 0
    } else {
      data[i + 3] = 255 // 完全不透明
    }
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.putImageData(imageData, 0, 0)

  const dataUrl = tmpCanvas.toDataURL()
  const blob = await fetch(dataUrl).then((res) => res.blob())
  return blob
}

type InputComfyImageMaskProps = InputProps<string> & {
  placeholder: string
}

const InputComfyImageMask: React.FC<InputComfyImageMaskProps> = ({
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
  const selectionRequestIdRef = useRef(0)
  const latestValueRef = useRef(value)
  const latestOnChangeRef = useRef(onChange)
  const [modalOpen, setModalOpen] = useState(false)

  const replacePreviewUrl = useCallback((nextUrl: string | null) => {
    const previousUrl = previewUrlRef.current
    previewUrlRef.current = nextUrl
    setPreviewUrl(nextUrl)
    if (previousUrl?.startsWith('blob:') && previousUrl !== nextUrl) {
      URL.revokeObjectURL(previousUrl)
    }
  }, [])

  // 同步外部 value 变化到 internalValue
  useEffect(() => {
    selectionRequestIdRef.current += 1
    latestValueRef.current = value
    setInternalValue((prev) => (prev === value ? prev : value))
    setIsLoading(false)
    setModalOpen(false)
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

  const { notifyError } = useMessage()
  const { t } = useTranslation()

  const doUpload = async (file: File) => {
    const requestId = ++selectionRequestIdRef.current
    setIsLoading(true)
    try {
      const deferredValue = await buildDeferredComfyImageValue(file)
      if (selectionRequestIdRef.current !== requestId) return
      commitValue(deferredValue)
    } catch (error) {
      if (selectionRequestIdRef.current !== requestId) return
      console.error('[InputComfyImageMask] Upload failed:', error)
      notifyError(
        t('input.image.load_failed', {
          error: error instanceof Error ? error.message : t('input.image.check_comfy_connection')
        })
      )
    } finally {
      if (selectionRequestIdRef.current === requestId) setIsLoading(false)
    }
  }

  const handleClear = useCallback(() => {
    selectionRequestIdRef.current += 1
    setIsLoading(false)
    setModalOpen(false)
    commitValue('')
    replacePreviewUrl(null)
  }, [commitValue, replacePreviewUrl])

  useEffect(() => {
    let active = true
    ;(async () => {
      if (!internalValue) {
        replacePreviewUrl(null)
        return
      }
      try {
        const localPreview = await getDeferredComfyLocalPreview(internalValue)
        if (!active) return
        if (localPreview?.dataUrl) {
          replacePreviewUrl(localPreview.dataUrl)
          return
        }
        const image: Uint8Array = localPreview?.bytes
          ? localPreview.bytes
          : isDeferredComfyInputValue(internalValue)
            ? (() => {
                throw new Error('Deferred Comfy input is unavailable.')
              })()
            : (await api().svcComfy.getView(valueToFileItem(internalValue))).result
        if (!active) return
        const blob = new Blob([image as BlobPart], {
          type: localPreview?.mimeType || 'image/*'
        })
        const url = URL.createObjectURL(blob)
        if (!active) {
          URL.revokeObjectURL(url)
          return
        }
        replacePreviewUrl(url)
      } catch (error) {
        console.warn('[InputComfyImageMask] Failed to load image preview:', internalValue, error)
        if (active) {
          replacePreviewUrl(null)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [internalValue, replacePreviewUrl])

  useEffect(
    () => () => {
      selectionRequestIdRef.current += 1
      const url = previewUrlRef.current
      previewUrlRef.current = null
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    },
    []
  )

  const doUploadMask = async (maskCanvas: HTMLCanvasElement) => {
    const requestId = ++selectionRequestIdRef.current
    const originalValue = latestValueRef.current
    setIsLoading(true)
    try {
      const blob = await drawMaskBlob(maskCanvas)
      const deferredValue = await buildDeferredComfyMaskValue({
        blob,
        fileName: `clipspace-mask-${Date.now()}.png`,
        originalValue
      })
      if (selectionRequestIdRef.current !== requestId) return
      commitValue(deferredValue)
    } catch (error) {
      if (selectionRequestIdRef.current !== requestId) return
      notifyError(
        t('input.image.load_failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      if (selectionRequestIdRef.current === requestId) {
        setIsLoading(false)
        setModalOpen(false)
      }
    }
  }

  return (
    <BaseInputComfyImage
      label={label}
      Icon={Icon}
      placeholder={placeholder}
      internalValue={getDeferredComfyFileDisplayName(internalValue)}
      isLoading={isLoading}
      previewUrl={previewUrl}
      doUpload={doUpload}
      onClear={handleClear}
      buttonSlot={
        previewUrl && (
          <ModalLayout buttonText="Open Mask Editor" open={modalOpen} setOpen={setModalOpen}>
            <MaskEditor
              imageUrl={previewUrl ?? ''}
              doSave={doUploadMask}
              doCancel={() => setModalOpen(false)}
            />
          </ModalLayout>
        )
      }
    />
  )
}

export default InputComfyImageMask
