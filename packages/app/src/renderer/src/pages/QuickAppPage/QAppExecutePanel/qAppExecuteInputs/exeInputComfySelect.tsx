import React from 'react'
import { QAppCfgInputComfySelect } from '@shared/qApp/cfgTypes'
import { ExeInputBuilder, ExeInputProps } from './types'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { Workflow } from '@shared/comfy/types'
import { useImperativeHandle } from 'react'
import { Autocomplete, TextField } from '@mui/material'
import { clsAndFieldByJsonPath, findFieldOptions } from '@shared/comfy/funcs'
import { useQAppInputState } from '../../components/QAppContext'

const readDefaultSelectValue = (slot: string, workflow: Workflow): string => {
  try {
    const defaultValue = getJsonPath(slot, workflow)
    if (typeof defaultValue === 'string') {
      return defaultValue
    }

    if (defaultValue !== undefined && defaultValue !== null) {
      console.warn(
        `[exeInputComfySelect] defaultValue of slot ${slot} is not a string; falling back to empty string`,
        defaultValue
      )
    }
  } catch (error) {
    console.warn(
      `[exeInputComfySelect] failed to read defaultValue of slot ${slot}; falling back to empty string`,
      error
    )
  }

  return ''
}

const buildExeInputComfySelect: ExeInputBuilder<'InputComfySelect'> = (
  cfg: QAppCfgInputComfySelect,
  workflow: Workflow
) => {
  const { label, slot } = cfg
  const defaultValue = readDefaultSelectValue(slot, workflow)

  const [cls, field] = clsAndFieldByJsonPath(slot, workflow)
  const id = `QAppInputComfySelect-${label}`

  const QAppInputComfySelect: React.FC<ExeInputProps> = ({ objectInfos, ref }) => {
    const options = findFieldOptions(objectInfos, cls, field)
    const [value, setValue] = useQAppInputState<string>(slot, defaultValue)

    // Check if current value is valid (exists in options)
    // If not, reset to first available option or empty string
    React.useEffect(() => {
      if (options.length > 0 && value && !options.includes(value)) {
        // Current value is not in available options (file may have been deleted)
        console.warn(
          `[exeInputComfySelect] Value "${value}" not in options for ${label}, resetting`
        )
        setValue(options[0] || '')
      }
    }, [options, value, setValue])

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (workflow) => setJsonPath(slot, workflow, value),
        validate: (workflow) => (value ? '' : `请选择${label}`)
      }),
      [value]
    )

    return (
      <Autocomplete
        value={value || null}
        onChange={(event, newValue) => setValue(newValue || '')}
        options={options}
        freeSolo={false}
        disableClearable={false}
        renderInput={(params) => (
          <TextField
            {...params}
            label={label}
            variant="outlined"
            size="small"
            placeholder="输入搜索或选择..."
          />
        )}
        ListboxProps={{
          style: {
            maxHeight: '400px',
            overflow: 'auto'
          }
        }}
        renderOption={(props, option) => (
          <li
            {...props}
            style={{ whiteSpace: 'normal', wordBreak: 'break-word', padding: '8px 16px' }}
          >
            {option}
          </li>
        )}
      />
    )
  }

  QAppInputComfySelect.displayName = id
  return QAppInputComfySelect
}

export default buildExeInputComfySelect
