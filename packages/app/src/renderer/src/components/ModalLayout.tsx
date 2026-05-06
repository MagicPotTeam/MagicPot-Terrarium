import { Box, Button, ButtonProps, Modal, Paper } from '@mui/material'
import { ResponsiveStyleValue } from '@mui/system'
import { Property as CSSProperty } from 'csstype'

type ModalLayoutProps = {
  buttonText: string
  children: React.ReactNode
  open: boolean
  setOpen: (open: boolean) => void
  width?: ResponsiveStyleValue<CSSProperty.Width>
  height?: ResponsiveStyleValue<CSSProperty.Height>
  maxWidth?: ResponsiveStyleValue<CSSProperty.MaxWidth>
  maxHeight?: ResponsiveStyleValue<CSSProperty.MaxHeight>
  noButton?: boolean
  disabled?: boolean
  buttonVariant?: ButtonProps['variant']
}

export default function ModalLayout({
  buttonText,
  children,
  open,
  setOpen,
  width = '80vw',
  height = '80vh',
  maxWidth = '1080px',
  maxHeight = '720px',
  noButton = false,
  disabled = false,
  buttonVariant = undefined
}: ModalLayoutProps) {
  return (
    <>
      {!noButton && (
        <Button onClick={() => setOpen(true)} disabled={disabled} variant={buttonVariant}>
          {buttonText}
        </Button>
      )}
      <Modal open={open} onClose={() => setOpen(false)}>
        <Box
          sx={{
            width,
            height,
            maxWidth,
            maxHeight,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            margin: 'auto',
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)'
          }}
        >
          <Paper
            sx={{
              flex: 1,
              display: 'flex',
              height: '100%',
              width: '100%'
            }}
          >
            {open && children}
          </Paper>
        </Box>
      </Modal>
    </>
  )
}
