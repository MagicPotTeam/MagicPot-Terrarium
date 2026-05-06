import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, IconButton, Stack, Typography } from '@mui/material'
import { MovieCreationOutlined, UploadOutlined } from '@mui/icons-material'
import { InputProps } from './InputProps'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import { fileItemToValue, valueToFileItem } from '@shared/comfy/funcs'
import { FileItem } from '@shared/comfy/types'
import { createVideoBoundaryFrameFiles } from '@renderer/pages/QuickAppPage/utils/videoBoundaryFrameFiles'
import { formatQAppErrorMessage } from '@renderer/pages/QuickAppPage/hooks/useQAppRunner'

export type InputVideoBoundaryFramesValue = {
  videoFileName: string
  firstFrameValue: string
  lastFrameValue: string
}

type InputVideoBoundaryFramesProps = InputProps<InputVideoBoundaryFramesValue> & {
  placeholder: string
}

const framePreviewStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'contain'
}

const PreviewPanel: React.FC<{
  title: string
  previewUrl: string | null
}> = ({ title, previewUrl }) => (
  <Box
    sx={{
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      borderRadius: 1,
      border: '1px solid',
      borderColor: 'divider',
      bgcolor: 'background.paper',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column'
    }}
  >
    <Typography variant="caption" color="text.secondary" sx={{ px: 1, py: 0.5 }}>
      {title}
    </Typography>
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {previewUrl ? (
        <img src={previewUrl} alt={title} style={framePreviewStyle} />
      ) : (
        <Typography variant="caption" color="text.disabled">
          尚未生成
        </Typography>
      )}
    </Box>
  </Box>
)
const InputVideoBoundaryFrames: React.FC<InputVideoBoundaryFramesProps> = ({
  value,
  label,
  onChange,
  placeholder,
  Icon
}) => {
  const [isLoading, setIsLoading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [firstFramePreviewUrl, setFirstFramePreviewUrl] = useState<string | null>(null)
  const [lastFramePreviewUrl, setLastFramePreviewUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const { notifyError, notifySuccess } = useMessage()

  const updatePreviewUrl = useCallback(
    async (
      imageValue: string,
      setPreviewUrl: React.Dispatch<React.SetStateAction<string | null>>
    ) => {
      if (!imageValue) {
        setPreviewUrl((prev) => {
          if (prev) {
            URL.revokeObjectURL(prev)
          }
          return null
        })
        return
      }

      try {
        const response = await api().svcComfy.getView(valueToFileItem(imageValue))
        const previewBlob = new Blob([response.result as BlobPart], { type: 'image/png' })
        const nextPreviewUrl = URL.createObjectURL(previewBlob)
        setPreviewUrl((prev) => {
          if (prev) {
            URL.revokeObjectURL(prev)
          }
          return nextPreviewUrl
        })
      } catch (error) {
        console.warn('[InputVideoBoundaryFrames] Failed to load frame preview:', imageValue, error)
        setPreviewUrl((prev) => {
          if (prev) {
            URL.revokeObjectURL(prev)
          }
          return null
        })
      }
    },
    []
  )

  useEffect(() => {
    void updatePreviewUrl(value.firstFrameValue, setFirstFramePreviewUrl)
  }, [updatePreviewUrl, value.firstFrameValue])

  useEffect(() => {
    void updatePreviewUrl(value.lastFrameValue, setLastFramePreviewUrl)
  }, [updatePreviewUrl, value.lastFrameValue])

  useEffect(() => {
    return () => {
      if (firstFramePreviewUrl) {
        URL.revokeObjectURL(firstFramePreviewUrl)
      }
      if (lastFramePreviewUrl) {
        URL.revokeObjectURL(lastFramePreviewUrl)
      }
    }
  }, [firstFramePreviewUrl, lastFramePreviewUrl])

  const uploadFrameImage = useCallback(async (file: File): Promise<FileItem> => {
    const image = new Uint8Array(await file.arrayBuffer())
    const response = await api().svcComfy.uploadImage({
      fileItem: { filename: file.name, type: 'input' },
      image
    })
    if (!response.filename) {
      throw new Error('failed to upload extracted frame')
    }
    return response
  }, [])

  const processVideoFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('video/')) {
        notifyError('请上传视频文件')
        return
      }

      setIsLoading(true)
      try {
        const { firstFrameFile, lastFrameFile } = await createVideoBoundaryFrameFiles(file)
        if (!firstFrameFile || !lastFrameFile) {
          throw new Error('failed to extract both first and last frames from the video')
        }

        const [firstFrameItem, lastFrameItem] = await Promise.all([
          uploadFrameImage(firstFrameFile),
          uploadFrameImage(lastFrameFile)
        ])

        onChange({
          videoFileName: file.name,
          firstFrameValue: fileItemToValue(firstFrameItem),
          lastFrameValue: fileItemToValue(lastFrameItem)
        })
        notifySuccess('已提取视频首尾帧')
      } catch (error) {
        console.error('[InputVideoBoundaryFrames] Failed to process video file:', error)
        notifyError(`视频处理失败: ${formatQAppErrorMessage(error)}`)
      } finally {
        setIsLoading(false)
      }
    },
    [notifyError, notifySuccess, onChange, uploadFrameImage]
  )

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      void processVideoFile(file)
      event.target.value = ''
    }
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(false)

    const file = Array.from(event.dataTransfer.files ?? []).find((item) =>
      item.type.startsWith('video/')
    )
    if (!file) {
      notifyError('请拖入视频文件')
      return
    }

    void processVideoFile(file)
  }

  const hasPreview = useMemo(() => {
    return Boolean(firstFramePreviewUrl || lastFramePreviewUrl)
  }, [firstFramePreviewUrl, lastFramePreviewUrl])

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
        onClick={() => fileInputRef.current?.click()}
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
        onDrop={handleDrop}
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
        {hasPreview ? (
          <Stack spacing={1} sx={{ minHeight: 0 }}>
            <Typography variant="caption" color="text.secondary" noWrap title={value.videoFileName}>
              {value.videoFileName || placeholder}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, minHeight: 112 }}>
              <PreviewPanel title="首帧" previewUrl={firstFramePreviewUrl} />
              <PreviewPanel title="尾帧" previewUrl={lastFramePreviewUrl} />
            </Box>
          </Stack>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
            <IconButton color="default" disabled={isLoading}>
              <UploadOutlined />
            </IconButton>
            <Typography variant="body2" color="text.secondary" textAlign="center">
              {placeholder}
            </Typography>
            <Typography variant="caption" color="text.disabled">
              上传一个视频，自动生成首帧和尾帧
            </Typography>
          </Box>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </Box>
    </Box>
  )
}

export default InputVideoBoundaryFrames
