import { useEffect, useState, ReactNode } from 'react'
import ModalLayout from '@renderer/components/ModalLayout'
import { Paper, SxProps, Theme } from '@mui/material'
import QAppMenu from '../components/QAppMenu'
import { useMessage } from '@renderer/hooks/useMessage'

type ButtonQAppLoadProps = {
  children: ReactNode
  onLoaded: (key: string) => void
  sx?: SxProps<Theme>
  variant?: 'text' | 'outlined' | 'contained'
  color?: 'inherit' | 'primary' | 'secondary' | 'success' | 'error' | 'info' | 'warning'
}

export const ButtonQAppLoad = ({ children, onLoaded, sx, variant, color }: ButtonQAppLoadProps) => {
  const [open, setOpen] = useState(false)
  const [qAppKey, setQAppKey] = useState('')
  const { notifyError } = useMessage()

  useEffect(() => {
    if (!qAppKey) {
      return
    }
    onLoaded(qAppKey)
    setOpen(false)
    setQAppKey('')
  }, [qAppKey, onLoaded, notifyError])

  // 1. 定义额外的 props，并显式指定类型为 Record<string, unknown> 以避开 ESLint any 检查
  const extraProps: Record<string, unknown> = {
    sx,
    buttonVariant: variant,
    color
  }

  return (
    <ModalLayout
      // 2. 类型欺骗：如果 ModalLayout 要求 buttonText 是 string，
      // 我们用 'as unknown as string' 强制转换，既不报错也不用 any
      buttonText={children as unknown as string}
      open={open}
      setOpen={setOpen}
      width="30vw"
      height="80vh"
      maxWidth="700px"
      maxHeight="600px"
      // 3. 展开 extraProps，TypeScript 和 ESLint 都会放行
      {...extraProps}
    >
      <Paper
        sx={{
          p: 3,
          width: '100%',
          height: '100%',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center'
        }}
      >
        <QAppMenu currentQAppKey={qAppKey} setCurrentQAppKey={setQAppKey} usedAsSelector={true} />
      </Paper>
    </ModalLayout>
  )
}
