import { QAppCfg } from '@shared/qApp/cfgTypes'
import { ExeAutoComponent, ExeInputComponent } from './qAppExecuteInputs/types'
import buildExeSection, { ExecuteSectionProps } from './qAppExecuteInputs/exeSection'
import { buildQAppAutoMap, buildQAppInputMap } from './qAppExecuteInputs'
import { Workflow } from '@shared/comfy/types'
import React, { useImperativeHandle } from 'react'
import { Alert, Typography } from '@mui/material'
import { useQAppLabel } from '../hooks/useQAppLabel'

type AutoInputStruct = {
  componentIndex: number
  Component: ExeAutoComponent
}

type InputStruct = {
  componentIndex: number
  Component: ExeInputComponent
}

type SectionStruct = {
  sectionIndex: number
  Component: React.FC<ExecuteSectionProps>
  inputs: InputStruct[]
}

type StructuredInputComponent = {
  autoInputs: AutoInputStruct[]
  headInputs: InputStruct[]
  sections: SectionStruct[]
}

const buildBrokenInputComponent = (
  label: string,
  component: string,
  error: unknown
): ExeInputComponent => {
  const errorText = error instanceof Error ? error.message : String(error)
  const validationMessage = `${label} 配置异常，请刷新快应用或重新保存配置`
  const id = `QAppInputBroken-${label}`

  // eslint-disable-next-line react/prop-types
  const BrokenInputComponent: ExeInputComponent = ({ ref }) => {
    const translatedLabel = useQAppLabel(label)

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: () => {},
        validate: () => validationMessage
      }),
      []
    )

    return React.createElement(
      Alert,
      { severity: 'warning' },
      React.createElement(
        Typography,
        { variant: 'body2', sx: { fontWeight: 600, mb: 0.5 } },
        translatedLabel
      ),
      React.createElement(Typography, { variant: 'body2' }, validationMessage),
      React.createElement(
        Typography,
        { variant: 'caption', sx: { display: 'block', mt: 0.5, opacity: 0.85 } },
        `${component}: ${errorText}`
      )
    )
  }

  BrokenInputComponent.displayName = id
  return BrokenInputComponent
}

const buildBrokenAutoComponent = (
  label: string,
  component: string,
  error: unknown
): ExeAutoComponent => {
  const errorText = error instanceof Error ? error.message : String(error)
  const validationMessage = `${label} 配置异常，请刷新快应用或重新保存配置`
  const id = `QAppAutoBroken-${label}`

  // eslint-disable-next-line react/prop-types
  const BrokenAutoComponent: ExeAutoComponent = ({ ref }) => {
    const translatedLabel = useQAppLabel(label)

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: () => {},
        validate: () => validationMessage
      }),
      []
    )

    return React.createElement(
      Alert,
      { severity: 'warning' },
      React.createElement(
        Typography,
        { variant: 'body2', sx: { fontWeight: 600, mb: 0.5 } },
        translatedLabel
      ),
      React.createElement(Typography, { variant: 'body2' }, validationMessage),
      React.createElement(
        Typography,
        { variant: 'caption', sx: { display: 'block', mt: 0.5, opacity: 0.85 } },
        `${component}: ${errorText}`
      )
    )
  }

  BrokenAutoComponent.displayName = id
  return BrokenAutoComponent
}

export const sectionize = (cfg: QAppCfg, workflowTemplate: Workflow): StructuredInputComponent => {
  const structedInput: StructuredInputComponent = {
    autoInputs: [],
    headInputs: [],
    sections: []
  }

  for (let i = 0; i < (cfg.autoInputs?.length ?? 0); i += 1) {
    const autoInput = cfg.autoInputs![i]
    const builder = buildQAppAutoMap[autoInput.component]

    try {
      structedInput.autoInputs.push({
        componentIndex: i,
        // @ts-ignore buildQAppAutoMap key type matches autoInput.component
        Component: builder(autoInput, workflowTemplate)
      })
    } catch (error) {
      console.error(
        `[sectionize] failed to build auto input "${autoInput.label}" (${autoInput.component})`,
        error
      )
      structedInput.autoInputs.push({
        componentIndex: i,
        Component: buildBrokenAutoComponent(autoInput.label, autoInput.component, error)
      })
    }
  }

  let currentSectionTop = 0
  let currentComponentTop = 0
  for (let i = 0; i < cfg.inputs.length; i += 1) {
    const input = cfg.inputs[i]
    if (input.component === 'Section') {
      structedInput.sections[currentSectionTop] = {
        sectionIndex: currentSectionTop,
        Component: buildExeSection(input),
        inputs: []
      }
      currentSectionTop += 1
      continue
    }

    const builder = buildQAppInputMap[input.component as keyof typeof buildQAppInputMap]
    if (!builder) {
      console.error(`[sectionize] unknown input component: ${input.component}`)
      continue
    }

    let Component: ExeInputComponent
    try {
      // @ts-ignore buildQAppInputMap key type matches input.component
      Component = builder(input, workflowTemplate)
    } catch (error) {
      console.error(
        `[sectionize] failed to build input "${input.label}" (${input.component})`,
        error
      )
      Component = buildBrokenInputComponent(input.label, input.component, error)
    }

    if (currentSectionTop > 0) {
      structedInput.sections[currentSectionTop - 1].inputs.push({
        componentIndex: currentComponentTop,
        Component
      })
    } else {
      structedInput.headInputs.push({
        componentIndex: currentComponentTop,
        Component
      })
    }

    currentComponentTop += 1
  }

  return structedInput
}
