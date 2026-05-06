import { Add } from '@mui/icons-material'
import { Divider, MenuItem } from '@mui/material'
import { QAppCfgAutoType, QAppCfgInputType } from '@shared/qApp/cfgTypes'
import { qAppDesignAutoMap, qAppDesignInputMap, qAppDesignMetaMap } from './qAppDesignInputs'
import { QAppCfgComponentNameMap } from '@shared/qApp/consts'
import { DropdownButton } from '@renderer/components/DropdownButton'

type ButtonAddInputItemProps = {
  addInputItem: (component: QAppCfgInputType | 'Section' | 'Description') => void | Promise<void>
}

export const ButtonAddInputItem = ({ addInputItem }: ButtonAddInputItemProps) => {
  return (
    <DropdownButton
      variant="text"
      size="large"
      color="inherit"
      disableElevation
      buttonChildren={<Add />}
    >
      {({ handleClose }) => [
        ...Object.keys(qAppDesignMetaMap).map((key) => (
          <MenuItem
            key={key}
            onClick={() => {
              addInputItem(key as 'Section' | 'Description')
              handleClose()
            }}
          >
            {QAppCfgComponentNameMap[key as 'Section' | 'Description']}
          </MenuItem>
        )),
        <Divider key="divider" sx={{ my: 0.5 }} />,
        ...Object.keys(qAppDesignInputMap).map((key) => (
          <MenuItem
            key={key}
            onClick={() => {
              addInputItem(key as QAppCfgInputType)
              handleClose()
            }}
          >
            {QAppCfgComponentNameMap[key as QAppCfgInputType]}
          </MenuItem>
        ))
      ]}
    </DropdownButton>
  )
}
