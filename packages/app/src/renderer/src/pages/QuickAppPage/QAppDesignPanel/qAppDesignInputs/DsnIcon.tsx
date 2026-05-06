import { Box, Button, Typography, Stack } from '@mui/material'
import { ChangeEvent, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CloudUpload, Delete } from '@mui/icons-material'

type DsnIconProps = {
  value: string
  setValue: (val: string) => void
}

export default function DsnIcon({ value, setValue }: DsnIconProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const noIconLabel = t('qapp.design.no_icon', { defaultValue: '暂无封面图' })
  const uploadIconLabel = t('qapp.design.upload_icon', { defaultValue: '上传快应用封面图' })
  const removeIconLabel = t('qapp.design.remove_icon', { defaultValue: '移除封面图' })

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Convert to base64 and resize if necessary
    const reader = new FileReader()
    reader.onload = (event) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const maxDim = 128
        let width = img.width
        let height = img.height

        if (width > height) {
          if (width > maxDim) {
            height *= maxDim / width
            width = maxDim
          }
        } else {
          if (height > maxDim) {
            width *= maxDim / height
            height = maxDim
          }
        }

        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx?.drawImage(img, 0, 0, width, height)
        const dataUrl = canvas.toDataURL('image/png')
        setValue(dataUrl)
      }
      img.src = event.target?.result as string
    }
    reader.readAsDataURL(file)
    e.target.value = '' // reset input
  }

  return (
    <Box
      sx={{
        bgcolor: 'background.paper',
        p: 2,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider'
      }}
    >
      <Stack direction="row" spacing={3} alignItems="center" sx={{ minWidth: 0 }}>
        {value ? (
          <Box
            component="img"
            src={value}
            alt="icon"
            sx={{
              width: 80,
              height: 80,
              borderRadius: 2,
              objectFit: 'cover',
              boxShadow: 1
            }}
          />
        ) : (
          <Box
            sx={{
              width: 80,
              height: 80,
              borderRadius: 2,
              border: '1px dashed',
              borderColor: 'divider',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'text.secondary',
              bgcolor: 'rgba(0,0,0,0.02)'
            }}
          >
            <Typography
              variant="body2"
              sx={{ px: 1, textAlign: 'center', overflowWrap: 'anywhere' }}
            >
              {noIconLabel}
            </Typography>
          </Box>
        )}

        <Stack spacing={1} sx={{ minWidth: 0, flex: 1 }}>
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            ref={fileInputRef}
            onChange={handleFileChange}
          />
          <Button
            variant="outlined"
            startIcon={<CloudUpload />}
            onClick={() => fileInputRef.current?.click()}
            size="small"
            sx={{ maxWidth: 240, justifyContent: 'flex-start' }}
          >
            <Box
              component="span"
              sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {uploadIconLabel}
            </Box>
          </Button>
          {value && (
            <Button
              variant="text"
              color="error"
              startIcon={<Delete />}
              onClick={() => setValue('')}
              size="small"
              sx={{ maxWidth: 240, justifyContent: 'flex-start' }}
            >
              <Box
                component="span"
                sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {removeIconLabel}
              </Box>
            </Button>
          )}
        </Stack>
      </Stack>
    </Box>
  )
}
