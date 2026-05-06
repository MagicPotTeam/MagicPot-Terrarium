import { Box, Modal, Typography } from '@mui/material'
import ModalLayout from '@renderer/components/ModalLayout'
import { useEffect, useState } from 'react'

type FastSettingErrorModalProps = {
  errorMessage: string
  errorDescription: string
}

export const FastSettingErrorModal = ({
  errorMessage,
  errorDescription
}: FastSettingErrorModalProps) => {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (errorMessage || errorDescription) {
      setOpen(true)
    }
  }, [errorMessage, errorDescription])

  return (
    <ModalLayout
      buttonText="错误"
      open={open}
      setOpen={setOpen}
      noButton
      width={'50vw'}
      height={'50vh'}
    >
      <Box
        sx={{
          p: 3,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 2
        }}
      >
        <Typography variant="h3" color="error">
          {errorMessage}
        </Typography>
        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
          {errorDescription}
        </Typography>
      </Box>
    </ModalLayout>
  )
}
