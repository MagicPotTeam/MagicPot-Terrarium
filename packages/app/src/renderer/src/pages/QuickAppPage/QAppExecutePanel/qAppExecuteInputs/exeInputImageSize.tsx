import React from 'react'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { ExeInputBuilder, ExeInputProps } from './types'
import { useImperativeHandle } from 'react'
import InputImageSize from '@renderer/components/inputs/InputImageSize'
import { valueIsJsonDict } from '@shared/utils/utilTypes'
import { useQAppInputState } from '../../components/QAppContext'

const buildExeInputImageSize: ExeInputBuilder<'InputImageSize'> = (cfg, workflow) => {
  const { label, seperateSlots } = cfg
  const [widthSlot, heightSlot] = (() => {
    if (seperateSlots) {
      const { widthSlot, heightSlot } = cfg
      return [widthSlot, heightSlot]
    }
    const { nodeSlot } = cfg
    const sizeNode = getJsonPath(nodeSlot, workflow)
    if (
      !valueIsJsonDict(sizeNode) ||
      !('inputs' in sizeNode) ||
      !valueIsJsonDict(sizeNode.inputs)
    ) {
      throw new Error(`nodeSlot ${nodeSlot} is not a valid node`)
    }
    return [nodeSlot + '.inputs.width', nodeSlot + '.inputs.height']
  })()
  const defaultWidth = getJsonPath(widthSlot, workflow)
  const defaultHeight = getJsonPath(heightSlot, workflow)
  if (typeof defaultWidth !== 'number' || typeof defaultHeight !== 'number') {
    throw new Error(
      `defaultValue width or height of node ${widthSlot} or ${heightSlot} is not a number`
    )
  }
  const id = `QAppInputImageSize-${label}`

  const formKey = `${widthSlot}|${heightSlot}`

  const QAppInputImageSize: React.FC<ExeInputProps> = ({ ref, ...props }) => {
    const [value, setValue] = useQAppInputState<{ width: number; height: number }>(formKey, {
      width: defaultWidth,
      height: defaultHeight
    })

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (workflow) => {
          setJsonPath(widthSlot, workflow, value.width)
          setJsonPath(heightSlot, workflow, value.height)
        },
        validate: (workflow) => (value.width && value.height ? '' : `请输入${label}`)
      }),
      [value]
    )

    return (
      <InputImageSize
        label={label}
        value={value}
        onChange={(v) => setValue(v)}
        placeholder={{ width: '宽', height: '高' }}
      />
    )
  }

  QAppInputImageSize.displayName = id
  return QAppInputImageSize
}

export default buildExeInputImageSize
