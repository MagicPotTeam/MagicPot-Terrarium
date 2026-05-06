import { alpha, Button, ButtonProps, Menu, MenuProps } from '@mui/material'
import { styled } from '@mui/material/styles'
import React, { useState } from 'react'

const StyledMenu = styled((props: MenuProps) => (
  <Menu
    elevation={0}
    anchorOrigin={{
      vertical: 'bottom',
      horizontal: 'right'
    }}
    transformOrigin={{
      vertical: 'top',
      horizontal: 'right'
    }}
    {...props}
  />
))(({ theme }) => ({
  '& .MuiPaper-root': {
    borderRadius: 6,
    marginTop: theme.spacing(1),
    minWidth: 180,
    color: theme.palette.text.primary,
    boxShadow: theme.shadows[8],
    '& .MuiMenu-list': {
      padding: `${theme.spacing(0.5)} 0`
    },
    '& .MuiMenuItem-root': {
      '& .MuiSvgIcon-root': {
        fontSize: 18,
        color: theme.palette.text.secondary,
        marginRight: theme.spacing(1.5),
        ...theme.applyStyles('dark', {
          color: 'inherit'
        })
      },
      '&:active': {
        backgroundColor: alpha(theme.palette.primary.main, theme.palette.action.selectedOpacity)
      }
    },
    ...theme.applyStyles('dark', {
      color: theme.palette.grey[300]
    })
  }
}))

type DropDownButtonProps = Omit<ButtonProps, 'onClick' | 'children'> & {
  buttonChildren: React.ReactNode
  children: (props: { handleClose: () => void }) => React.ReactNode[]
}

export const DropdownButton = ({ buttonChildren, children, ...props }: DropDownButtonProps) => {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const open = Boolean(anchorEl)
  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget)
  }
  const handleClose = () => {
    setAnchorEl(null)
  }

  // MUI v7 的 Menu 不允许 Fragment 作为 children，
  // 所以这里用 React.Children 确保传入的是扁平数组
  const menuItems = children({ handleClose })

  return (
    <>
      <Button
        id="dropdown-button"
        aria-controls={open ? 'dropdown-menu' : undefined}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : undefined}
        onClick={handleClick}
        {...props}
      >
        {buttonChildren}
      </Button>
      <StyledMenu
        id="dropdown-menu"
        slotProps={{
          list: {
            'aria-labelledby': 'dropdown-button'
          }
        }}
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
      >
        {menuItems.map((item, index) =>
          React.isValidElement(item)
            ? React.cloneElement(item, { key: item.key ?? `menu-item-${index}` })
            : item
        )}
      </StyledMenu>
    </>
  )
}
