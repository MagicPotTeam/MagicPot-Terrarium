import React from 'react'
import { InputProps } from '@renderer/components/inputs/InputProps'
import { ExeInputBuilder, ExeInputProps } from './types'
import { QAppCfgInputTypeMap } from '@shared/qApp/cfgTypes'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { useImperativeHandle } from 'react'
import { JsonValue } from '@shared/utils/utilTypes'
import { Workflow } from '@shared/comfy/types'
import { HaveSlotCfgInputType } from '../../baseBuilderTypes'
import { useQAppLabel } from '../../hooks/useQAppLabel'
import { useQAppInputState } from '../../components/QAppContext'

type BaseBuilderArgs<T extends JsonValue, InputType extends HaveSlotCfgInputType> = {
  inputType: InputType
  typeofValue: T // "" or 0 or false
} & (
  | {
      InputComponent: React.ComponentType<InputProps<T> & { placeholder: string }>
    }
  | {
      AdvancedInputComponent: React.ComponentType<
        InputProps<T> & { placeholder: string } & {
          cfg: QAppCfgInputTypeMap[InputType]
          workflow: Workflow
        }
      >
    }
) & {
    validateQApp?: (
      cfg: QAppCfgInputTypeMap[InputType],
      workflow: Workflow,
      defaultValue: JsonValue
    ) => string // 自定义验证 QApp 输入组件配置是否合法
    getDefaultValue?: (cfg: QAppCfgInputTypeMap[InputType], workflow: Workflow) => T // 自定义默认值
    validate?: (workflow: Workflow, value: T) => string // 自定义验证输入值是否合法
  }

/**
 * 构建一个 QAppInputBuilder，用于构建有 slot 字段的 QAppCfgInput 子类型
 * @param args
 * @returns
 */
const baseQAppInputBuilder = <T extends JsonValue, InputType extends HaveSlotCfgInputType>(
  args: BaseBuilderArgs<T, InputType>
): ExeInputBuilder<InputType> => {
  return (cfg, workflow) => {
    const { label, slot } = cfg

    const id = `QApp${args.inputType}-${label}`

    const AdvancedInputComponent =
      'AdvancedInputComponent' in args ? args.AdvancedInputComponent : args.InputComponent

    const defaultValue = args.getDefaultValue
      ? args.getDefaultValue(cfg, workflow)
      : getJsonPath(slot, workflow)
    const validateQApp =
      args.validateQApp ??
      ((cfg: QAppCfgInputTypeMap[InputType], workflow: Workflow, defaultValue: JsonValue) => {
        if (typeof defaultValue !== typeof args.typeofValue) {
          return `defaultValue of slot ${slot} is not a ${typeof args.typeofValue}`
        }
        return ''
      })
    const validate = args.validate ?? ((workflow: Workflow, value: T) => '')

    const errorText = validateQApp(cfg, workflow, defaultValue)
    if (errorText) {
      throw new Error(errorText)
    }

    const QAppInputComponent: React.FC<ExeInputProps> = ({ ref, ...props }) => {
      const [value, setValue] = useQAppInputState<T>(slot, defaultValue as T)
      const translatedLabel = useQAppLabel(label)

      useImperativeHandle(
        ref,
        () => ({
          id,
          modifyWorkflow: (workflow) => setJsonPath(slot, workflow, value),
          validate: (workflow) => validate(workflow, value)
        }),
        [value]
      )

      return (
        <AdvancedInputComponent
          cfg={cfg}
          workflow={workflow}
          label={translatedLabel}
          value={value}
          onChange={(v) => setValue(v)}
          placeholder={`${translatedLabel}...`}
        />
      )
    }

    QAppInputComponent.displayName = id
    return QAppInputComponent
  }
}

export default baseQAppInputBuilder
