import React, { useCallback, useEffect, useState } from 'react'
import { InputProps } from './InputProps'
import { api } from '@renderer/utils/windowUtils'
import { FileItem } from '@shared/comfy/types'
import MaskEditor from '../ImageCanvas/MaskEditor'
import ModalLayout from '../ModalLayout'
import { fileItemToValue, valueToFileItem } from '@shared/comfy/funcs'
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
  const [modalOpen, setModalOpen] = useState(false)

  // 同步外部 value 变化到 internalValue
  useEffect(() => {
    if (value !== internalValue) {
      setInternalValue(value)
    }
  }, [value, internalValue])

  const { notifyError } = useMessage()
  const { t } = useTranslation()

  const doUpload = async (file: File) => {
    setIsLoading(true)
    try {
      const arrayBuffer = await file.arrayBuffer()
      const uint8 = new Uint8Array(arrayBuffer)
      const res: FileItem = await api().svcComfy.uploadImage({
        fileItem: { filename: file.name, type: 'input' },
        image: uint8
      })
      const uploadedName = fileItemToValue(res)
      setInternalValue(uploadedName)
      onChange(uploadedName)
    } catch (error) {
      console.error('[InputComfyImageMask] Upload failed:', error)
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
        // ignore preview errors
      }
    })()
    return () => {
      active = false
    }
  }, [internalValue, viewImage])

  const doUploadMask = async (maskCanvas: HTMLCanvasElement) => {
    console.log('doUploadMask', maskCanvas)
    console.log('maskCanvas.toDataURL length', maskCanvas.toDataURL().length)
    setIsLoading(true)
    try {
      const blob = await drawMaskBlob(maskCanvas)
      const res: FileItem = await api().svcComfy.uploadMask({
        fileItem: {
          filename: 'clipspace-mask-' + Date.now() + '.png',
          type: 'input',
          subfolder: 'clipspace'
        },
        mask: new Uint8Array(await blob.arrayBuffer()),
        original_ref: valueToFileItem(internalValue)
      })
      const uploadedName = fileItemToValue(res)
      setInternalValue(uploadedName)
      onChange(uploadedName)
    } finally {
      setIsLoading(false)
      setModalOpen(false)
    }
  }

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
