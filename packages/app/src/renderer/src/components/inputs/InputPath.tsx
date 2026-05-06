import React from 'react'
import { InputProps } from './InputProps'
import { IconButton, InputAdornment, TextField } from '@mui/material'
import { FolderOutlined } from '@mui/icons-material'
import { api } from '@renderer/utils/windowUtils'
import BaseInputTextField from './BaseInputTextField'

type InputPathProps = InputProps<string> & {
  pathType: 'file' | 'directory' | 'both'
  placeholder: string
  relativeTo?: string // 打开按钮时，如果是相对路径，代表相对于这个路径
  defaultTo?: string // 打开按钮时，如果为空且 relativeTo 为空，默认打开的路径
  errorText?: string
  resolveAliases?: boolean
  treatPackageAsDirectory?: boolean
  hideHiddenFiles?: boolean
}

type DialogProperties = Array<
  | 'openFile'
  | 'openDirectory'
  | 'multiSelections'
  | 'showHiddenFiles'
  | 'createDirectory'
  | 'promptToCreate'
  | 'noResolveAliases'
  | 'treatPackageAsDirectory'
  | 'dontAddToRecent'
>

/**
 * 受控版 InputPath：
 * - 不再维护内部输入值；显示值完全由 props.value 决定
 * - 用户输入/选择后，立即通过 onChange 往上抛，父组件更新 state -> UI 立刻同步
 */
const InputPath: React.FC<InputPathProps> = ({
  value,
  label,
  onChange,
  placeholder,
  Icon,
  relativeTo,
  defaultTo,
  errorText,
  pathType,
  resolveAliases = false,
  treatPackageAsDirectory = false,
  hideHiddenFiles = false
}) => {
  const [isLoading, setIsLoading] = React.useState(false)

  const pathTypeProperties: Record<InputPathProps['pathType'], DialogProperties> = {
    file: ['openFile'],
    directory: ['openDirectory'],
    both: ['openFile', 'openDirectory']
  }

  const resolveAliases2Properties: DialogProperties = resolveAliases ? [] : ['noResolveAliases']
  const treatPackageAsDirectory2Properties: DialogProperties = treatPackageAsDirectory
    ? ['treatPackageAsDirectory']
    : []
  const hideHiddenFiles2Properties: DialogProperties = hideHiddenFiles ? [] : ['showHiddenFiles']

  const handleSelectPath = async () => {
    let defaultPath: string
    if (window.path.isAbsolute(value)) {
      defaultPath = value // 如果为绝对路径，直接使用
    } else if (relativeTo) {
      defaultPath = window.path.join(relativeTo, value) // 如果为相对路径且 relativeTo 不为空，使用相对于 relativeTo 的路径
    } else if (defaultTo) {
      defaultPath = defaultTo // 如果为相对路径也没有设置 relativeTo ，使用 defaultTo
    } else {
      defaultPath = value // 兜底，直接使用 value
    }
    try {
      setIsLoading(true)
      const ret = await api().svcDialog.showOpenDialog({
        title: label,
        properties: [
          ...pathTypeProperties[pathType],
          ...resolveAliases2Properties,
          ...treatPackageAsDirectory2Properties,
          ...hideHiddenFiles2Properties
        ],
        defaultPath: defaultPath || ''
      })
      if (!ret.canceled && ret.filePaths?.length > 0) {
        onChange(ret.filePaths[0]) // 直接把选择结果抛给父级
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <BaseInputTextField
      fullWidth
      disabled={isLoading}
      errorText={errorText}
      label={label}
      value={value} // 受控显示
      onChange={onChange} // 直接上抛，父组件立刻更新
      placeholder={placeholder}
      Icon={Icon}
      slotProps={{
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton onClick={handleSelectPath} edge="end" aria-label="选择路径" size="small">
                <FolderOutlined fontSize="small" />
              </IconButton>
            </InputAdornment>
          )
        }
      }}
    />
  )
}

export default InputPath
