import { useEffect, useState } from 'react'
import { QAppDesignComponent, QAppDesignProps } from './types'
import { QAppCfgInputImageSize } from '@shared/qApp/cfgTypes'
import { useInputLabel } from './components/InputLabel'
import DsnComponentLayout from './components/DsnComponentLayout'
import InputNodeSelect from './components/InputNodeSelect'
import { conditionFieldTypeIs, conditionNodeImageSize } from './conditions'
import InputSwitch from '@renderer/components/inputs/InputSwitch'
import { QAppCfgComponentNameMap } from '@shared/qApp/consts'

const allowFieldCondition = conditionFieldTypeIs('INT')

const DsnInputImageSize: QAppDesignComponent<'InputImageSize'> = ({
  workflow,
  objectInfos,
  id,
  value,
  setValue,
  onDelete
}: QAppDesignProps<'InputImageSize'>) => {
  const { label, InputLabel } = useInputLabel(value?.label, id, 'InputImageSize', onDelete)
  const [seperateSlots, setSeperateSlots] = useState<boolean>(value?.seperateSlots || false)
  const [widthSlot, setWidthSlot] = useState<string | null>(
    value?.seperateSlots ? value?.widthSlot || null : null
  )
  const [heightSlot, setHeightSlot] = useState<string | null>(
    value?.seperateSlots ? value?.heightSlot || null : null
  )
  const [nodeSlot, setNodeSlot] = useState<string | null>(
    value?.seperateSlots ? null : value?.nodeSlot || null
  )

  useEffect(() => {
    if (seperateSlots) {
      if (!widthSlot || !heightSlot) {
        return
      }
      const cfg: QAppCfgInputImageSize = {
        label,
        component: 'InputImageSize',
        seperateSlots,
        widthSlot,
        heightSlot
      }
      setValue(cfg)
    } else {
      if (!nodeSlot) {
        return
      }
      const cfg: QAppCfgInputImageSize = {
        label,
        component: 'InputImageSize',
        nodeSlot
      }
      setValue(cfg)
    }
  }, [label, seperateSlots, widthSlot, heightSlot, nodeSlot, setValue])

  return (
    <DsnComponentLayout>
      <InputLabel />
      <InputSwitch
        value={seperateSlots}
        label="是否分开设置宽度和高度的字段"
        onChange={setSeperateSlots}
      />
      {seperateSlots && (
        <>
          <InputNodeSelect
            label="宽度字段"
            value={widthSlot}
            onChange={setWidthSlot}
            workflow={workflow}
            objectInfos={objectInfos}
            mode="field"
            allowFieldCondition={allowFieldCondition}
          />
          <InputNodeSelect
            label="高度字段"
            value={heightSlot}
            onChange={setHeightSlot}
            workflow={workflow}
            objectInfos={objectInfos}
            mode="field"
            allowFieldCondition={allowFieldCondition}
          />
        </>
      )}
      {!seperateSlots && (
        <>
          <InputNodeSelect
            label={`${QAppCfgComponentNameMap['InputImageSize']}节点`}
            value={nodeSlot}
            onChange={setNodeSlot}
            workflow={workflow}
            objectInfos={objectInfos}
            mode="node"
            allowNodeCondition={conditionNodeImageSize}
          />
        </>
      )}
    </DsnComponentLayout>
  )
}

DsnInputImageSize.displayName = 'QAppDsnImageSize'

export default DsnInputImageSize
