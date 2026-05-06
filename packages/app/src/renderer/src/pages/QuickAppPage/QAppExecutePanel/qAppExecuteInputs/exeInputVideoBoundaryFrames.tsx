import React, { useImperativeHandle } from 'react'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { ExeInputBuilder, ExeInputProps } from './types'
import { useQAppInputState } from '../../components/QAppContext'
import { useQAppLabel } from '../../hooks/useQAppLabel'
import InputVideoBoundaryFrames, {
  InputVideoBoundaryFramesValue
} from '@renderer/components/inputs/InputVideoBoundaryFrames'
import { Workflow } from '@shared/comfy/types'

export const getVideoBoundaryFramesValidationMessage = (label: string): string =>
  `请先加载 ${label}`

const readDefaultFrameValue = (slot: string, workflow: Workflow): string => {
  try {
    const defaultValue = getJsonPath(slot, workflow)
    if (typeof defaultValue === 'string') {
      return defaultValue
    }

    if (defaultValue !== undefined && defaultValue !== null) {
      console.warn(
        `[exeInputVideoBoundaryFrames] defaultValue of slot ${slot} is not a string; falling back to empty string`,
        defaultValue
      )
    }
  } catch (error) {
    console.warn(
      `[exeInputVideoBoundaryFrames] failed to read defaultValue of slot ${slot}; falling back to empty string`,
      error
    )
  }

  return ''
}

const buildExeInputVideoBoundaryFrames: ExeInputBuilder<'InputVideoBoundaryFrames'> = (
  cfg,
  workflow
) => {
  const { label, firstFrameSlot, lastFrameSlot } = cfg
  const defaultFirstFrameValue = readDefaultFrameValue(firstFrameSlot, workflow)
  const defaultLastFrameValue = readDefaultFrameValue(lastFrameSlot, workflow)

  const formKey = `${firstFrameSlot}|${lastFrameSlot}`
  const id = `QAppInputVideoBoundaryFrames-${label}`

  const QAppInputVideoBoundaryFrames: React.FC<ExeInputProps> = ({ ref }) => {
    const translatedLabel = useQAppLabel(label)
    const [value, setValue] = useQAppInputState<InputVideoBoundaryFramesValue>(formKey, {
      videoFileName: '',
      firstFrameValue: defaultFirstFrameValue,
      lastFrameValue: defaultLastFrameValue
    })

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (nextWorkflow) => {
          setJsonPath(firstFrameSlot, nextWorkflow, value.firstFrameValue)
          setJsonPath(lastFrameSlot, nextWorkflow, value.lastFrameValue)
        },
        validate: () => {
          const hasFirstFrame = Boolean(value.firstFrameValue?.trim())
          const hasLastFrame = Boolean(value.lastFrameValue?.trim())
          return hasFirstFrame && hasLastFrame
            ? ''
            : getVideoBoundaryFramesValidationMessage(translatedLabel)
        }
      }),
      [translatedLabel, value]
    )

    return (
      <InputVideoBoundaryFrames
        label={translatedLabel}
        value={value}
        onChange={setValue}
        placeholder={`${translatedLabel}...`}
      />
    )
  }

  QAppInputVideoBoundaryFrames.displayName = id
  return QAppInputVideoBoundaryFrames
}

export default buildExeInputVideoBoundaryFrames
