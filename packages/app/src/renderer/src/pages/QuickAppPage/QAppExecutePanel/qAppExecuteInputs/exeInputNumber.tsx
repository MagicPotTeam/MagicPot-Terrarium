import { ExeInputBuilder } from './types'
import InputNumber from '@renderer/components/inputs/InputNumber'
import baseQAppInputBuilder from './baseBuilder'
import { Workflow } from '@shared/comfy/types'
import { InputProps } from '@renderer/components/inputs/InputProps'
import { QAppCfgInputNumber } from '@shared/qApp/cfgTypes'

const buildExeInputNumber: ExeInputBuilder<'InputNumber'> = baseQAppInputBuilder({
  typeofValue: 0,
  inputType: 'InputNumber',
  AdvancedInputComponent: ({
    cfg,
    workflow,
    ...props
  }: InputProps<number> & { cfg: QAppCfgInputNumber; workflow: Workflow }) => {
    return <InputNumber {...props} min={cfg.min} max={cfg.max} step={cfg.step} />
  },
  validate: (workflow, value) => ''
})

export default buildExeInputNumber
