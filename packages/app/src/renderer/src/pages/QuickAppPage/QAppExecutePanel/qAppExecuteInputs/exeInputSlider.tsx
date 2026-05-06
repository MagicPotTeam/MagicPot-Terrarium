import React from 'react'
import { ExeInputBuilder } from './types'
import InputSlider from '@renderer/components/inputs/InputSlider'
import baseQAppInputBuilder from './baseBuilder'
import { Workflow } from '@shared/comfy/types'
import { QAppCfgInputSlider } from '@shared/qApp/cfgTypes'
import { InputProps } from '@renderer/components/inputs/InputProps'

const buildExeInputSlider: ExeInputBuilder<'InputSlider'> = baseQAppInputBuilder({
  typeofValue: Number(0),
  inputType: 'InputSlider',
  AdvancedInputComponent: ({
    cfg,
    workflow,
    ...props
  }: InputProps<number> & { cfg: QAppCfgInputSlider; workflow: Workflow }) => {
    return <InputSlider {...props} min={cfg.min} max={cfg.max} step={cfg.step} />
  },
  validate: (workflow, value) => ''
})

export default buildExeInputSlider
