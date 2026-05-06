import { Button, ButtonProps } from '@mui/material'
import { ActionCtx } from '../types/actions'
import { useHistory } from '../contexts/HistoryContext'
import { TransformHandler } from '../types/transform'
import { useTransform } from '../contexts/TransformContext'

type CustomActionButtonProps = Omit<ButtonProps, 'onClick'> & {
  onClick: (ctx: ActionCtx) => void | Promise<void>
}

export const CustomActionButton = ({ onClick, children, ...props }: CustomActionButtonProps) => {
  const { historyHandler } = useHistory()
  const { transformHandler } = useTransform()

  return (
    <Button {...props} onClick={(e) => onClick({ transformHandler, historyHandler })}>
      {children}
    </Button>
  )
}
