import { Tooltip, IconButton } from '@mui/material'

type ResultIconButtonBaseProps = {
  tooltip: string
  onClick: () => void
  Icon: React.ComponentType
}

const ResultIconButtonBase = ({ tooltip, onClick, Icon }: ResultIconButtonBaseProps) => {
  return (
    <Tooltip title={tooltip}>
      <IconButton
        onClick={onClick}
        size="small"
        sx={{ bgcolor: 'rgba(0,0,0,0.5)', color: 'white' }}
      >
        <Icon />
      </IconButton>
    </Tooltip>
  )
}

export default ResultIconButtonBase
