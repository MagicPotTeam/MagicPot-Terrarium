import { Add } from '@mui/icons-material'
import { Divider, MenuItem } from '@mui/material'
import { QAppCfgAutoType, QAppCfgInputType } from '@shared/qApp/cfgTypes'
import { qAppDesignAutoMap, qAppDesignInputMap, qAppDesignMetaMap } from './qAppDesignInputs'
import { QAppCfgComponentNameMap } from '@shared/qApp/consts'
import { DropdownButton } from '@renderer/components/DropdownButton'

type ButtonAddAutoItemProps = {
  addAutoItem: (component: QAppCfgAutoType) => void | Promise<void>
}

export const ButtonAddAutoItem = ({ addAutoItem }: ButtonAddAutoItemProps) => {
  return (
    <DropdownButton
      variant="text"
      size="large"
      color="inherit"
      disableElevation
      buttonChildren={<Add />}
    >
      {({ handleClose }) => [
        ...Object.keys(qAppDesignAutoMap).map((key) => (
          <MenuItem
            key={key}
            onClick={() => {
              addAutoItem(key as QAppCfgAutoType)
              handleClose()
            }}
          >
            {QAppCfgComponentNameMap[key as QAppCfgAutoType]}
          </MenuItem>
        ))
      ]}
    </DropdownButton>
  )
}
