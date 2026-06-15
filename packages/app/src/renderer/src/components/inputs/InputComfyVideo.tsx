import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, IconButton, Typography } from '@mui/material'
import { MovieCreationOutlined, UploadOutlined } from '@mui/icons-material'
import { InputProps } from './InputProps'
import { api } from '@renderer/utils/windowUtils'
import { FileItem } from '@shared/comfy/types'
import { fileItemToValue, valueToFileItem } from '@shared/comfy/funcs'
import { useMessage } from '@renderer/hooks/useMessage'
import { guessMimeTypeFromFileName } from '@renderer/utils/fileDisplay'
import { getDroppedVideoDropError, getDroppedVideoFile } from '@renderer/utils/droppedVideoUtils'

type InputComfyVideoProps = InputProps<string> & {
  placeholder: string
}

const InputComfyVideo: React.FC<InputComfyVideoProps> = ({
  value,
  label,
  onChange,
  placeholder,
  Icon
}) => {
  const [internalValue, setInternalValue] = useState(value)
  const [isLoading, setIsLoading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const previewRequestIdRef = useRef(0)
  const previewUrlRef = useRef<string | null>(null)
  const { notifyError } = useMessage()

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

  useEffect(() => {
    setInternalValue((prev) => (prev === value ? prev : value))
  }, [value])

  const doUpload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('video/') && !/\.(avi|mkv|mov|mp4|ogg|webm)$/i.test(file.name)) {
        notifyError('Please upload a video file.')
        return
      }

      setIsLoading(true)
      try {
        const arrayBuffer = await file.arrayBuffer()
        const uint8 = new Uint8Array(arrayBuffer)
        const res: FileItem = await api().svcComfy.uploadImage({
          fileItem: { filename: file.name, type: 'input' },
          image: uint8
        })
        if (!res.filename) {
          throw new Error('failed to upload video, response did not contain filename')
        }
        const uploadedName = fileItemToValue(res)
        setInternalValue(uploadedName)
        onChange(uploadedName)
      } catch (error) {
        console.error('[InputComfyVideo] upload failed:', error)
        notifyError(
          `Video upload failed: ${error instanceof Error ? error.message : 'Check ComfyUI connectivity.'}`
        )
      } finally {
        setIsLoading(false)
      }
    },
    [notifyError, onChange]
  )

  useEffect(() => {
    const requestId = ++previewRequestIdRef.current
    let createdUrl: string | null = null

    if (!internalValue) {
      updatePreviewUrl(null)
      return
    }

    ;(async () => {
      try {
        const res = await api().svcComfy.getView(valueToFileItem(internalValue))
        if (previewRequestIdRef.current !== requestId) return
        const bytes = res.result
        const blob = new Blob([bytes as BlobPart], {
          type: guessMimeTypeFromFileName(internalValue, 'video/mp4')
        })
        createdUrl = URL.createObjectURL(blob)
        updatePreviewUrl(createdUrl)
        createdUrl = null
      } catch (error) {
        if (previewRequestIdRef.current !== requestId) return
        // Preview failures should not erase the selected video value. During
        // ComfyUI startup or heavy execution the file may be temporarily
        // unavailable; clearing it here would write back into QApp form state
        // from an effect and can amplify render/update loops.
        console.warn('[InputComfyVideo] Failed to load video preview:', internalValue, error)
        updatePreviewUrl(null)
      }
    })()

    return () => {
      if (previewRequestIdRef.current === requestId) {
        previewRequestIdRef.current += 1
      }
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl)
        createdUrl = null
      }
    }
  }, [internalValue, updatePreviewUrl])

  return (
    <Box data-panel="quick-app">
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        {Icon ? (
          React.createElement(Icon, {
            sx: { mr: 1, color: 'text.secondary' }
          })
        ) : (
          <MovieCreationOutlined sx={{ mr: 1, color: 'text.secondary' }} />
        )}
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </Box>

      <Box
        onClick={() => {
          if (isLoading) return
          fileInputRef.current?.click()
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setIsDragging(true)
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setIsDragging(false)
        }}
        onDrop={async (event) => {
          event.preventDefault()
          event.stopPropagation()
          setIsDragging(false)

          try {
            const dropError = getDroppedVideoDropError(event.dataTransfer)
            if (dropError) {
              notifyError(dropError)
              return
            }

            const file = await getDroppedVideoFile(event.dataTransfer)
            if (!file) {
              notifyError('Please drop a video file.')
              return
            }

            await doUpload(file)
            event.dataTransfer.clearData()
          } catch (error) {
            console.error('[InputComfyVideo] failed to load dropped video:', error)
            notifyError(
              `Video load failed: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }}
        sx={{
          position: 'relative',
          border: '1px dashed',
          borderColor: isDragging ? 'primary.main' : 'divider',
          borderRadius: 1,
          minHeight: 156,
          p: 1.5,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          cursor: isLoading ? 'default' : 'pointer',
          overflow: 'hidden'
        }}
      >
        {previewUrl ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Typography variant="caption" color="text.secondary" noWrap title={internalValue}>
              {internalValue}
            </Typography>
            <Box sx={{ width: '100%', borderRadius: 1, overflow: 'hidden', bgcolor: '#000' }}>
              <video
                src={previewUrl}
                controls
                playsInline
                preload="metadata"
                style={{ width: '100%', display: 'block', maxHeight: 200, objectFit: 'contain' }}
              />
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
            <IconButton color="default" disabled={isLoading}>
              <UploadOutlined />
            </IconButton>
            <Typography variant="body2" color="text.secondary" textAlign="center">
              {placeholder}
            </Typography>
          </Box>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              void doUpload(file)
              event.target.value = ''
            }
          }}
        />
      </Box>
    </Box>
  )
}

export default InputComfyVideo
