import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, IconButton, Typography } from '@mui/material'
import { MovieCreationOutlined, UploadOutlined } from '@mui/icons-material'
import { InputProps } from './InputProps'
import { api } from '@renderer/utils/windowUtils'
import {
  buildDeferredComfyFileValue,
  getDeferredComfyLocalPreview
} from '@renderer/utils/deferredComfyInput'
import {
  getDeferredComfyFileDisplayName,
  isDeferredComfyInputValue
} from '@shared/comfy/deferredImages'
import { valueToFileItem } from '@shared/comfy/funcs'
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
  const selectionRequestIdRef = useRef(0)
  const previewUrlRef = useRef<string | null>(null)
  const latestValueRef = useRef(value)
  const latestOnChangeRef = useRef(onChange)
  const { notifyError } = useMessage()

  const updatePreviewUrl = useCallback((nextUrl: string | null) => {
    setPreviewUrl((prev) => {
      if (prev?.startsWith('blob:') && prev !== nextUrl) {
        URL.revokeObjectURL(prev)
      }
      previewUrlRef.current = nextUrl
      return nextUrl
    })
  }, [])

  useEffect(
    () => () => {
      selectionRequestIdRef.current += 1
      previewRequestIdRef.current += 1
      if (previewUrlRef.current?.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrlRef.current)
      }
      previewUrlRef.current = null
    },
    []
  )

  useEffect(() => {
    selectionRequestIdRef.current += 1
    latestValueRef.current = value
    setInternalValue((prev) => (prev === value ? prev : value))
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
      if (!file.type.startsWith('video/') && !/\.(avi|mkv|mov|mp4|ogg|webm)$/i.test(file.name)) {
        notifyError('Please upload a video file.')
        return
      }

      const requestId = ++selectionRequestIdRef.current
      setIsLoading(true)
      try {
        const deferredValue = await buildDeferredComfyFileValue(file, 'video/mp4')
        if (selectionRequestIdRef.current !== requestId) return
        commitValue(deferredValue)
      } catch (error) {
        if (selectionRequestIdRef.current !== requestId) return
        console.error('[InputComfyVideo] upload failed:', error)
        notifyError(
          `Video upload failed: ${error instanceof Error ? error.message : 'Check ComfyUI connectivity.'}`
        )
      } finally {
        if (selectionRequestIdRef.current === requestId) setIsLoading(false)
      }
    },
    [commitValue, notifyError]
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
        const localPreview = await getDeferredComfyLocalPreview(internalValue)
        if (previewRequestIdRef.current !== requestId) return
        if (localPreview?.dataUrl) {
          updatePreviewUrl(localPreview.dataUrl)
          return
        }
        const bytes = localPreview?.bytes
          ? localPreview.bytes
          : isDeferredComfyInputValue(internalValue)
            ? (() => {
                throw new Error('Deferred Comfy input is unavailable.')
              })()
            : (await api().svcComfy.getView(valueToFileItem(internalValue))).result
        if (previewRequestIdRef.current !== requestId) return
        const blob = new Blob([bytes as BlobPart], {
          type: localPreview?.mimeType || guessMimeTypeFromFileName(internalValue, 'video/mp4')
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
              {getDeferredComfyFileDisplayName(internalValue)}
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
