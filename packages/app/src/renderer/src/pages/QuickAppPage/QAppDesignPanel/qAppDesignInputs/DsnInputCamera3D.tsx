import { useEffect, useState } from 'react'
import { QAppDesignComponent, QAppDesignProps } from './types'
import DsnComponentLayout from './components/DsnComponentLayout'
import { useInputLabel } from './components/InputLabel'
import InputNodeSelect from './components/InputNodeSelect'
import { conditionFieldTypeIs } from './conditions'
import { QAppCfgComponentNameMap } from '@shared/qApp/consts'
import { QAppCfgInputCamera3D } from '@shared/qApp/cfgTypes'

const allowFieldCondition = conditionFieldTypeIs('INT', 'FLOAT')

const DsnInputCamera3D: QAppDesignComponent<'InputCamera3D'> = ({
  workflow,
  objectInfos,
  id,
  value,
  setValue,
  onDelete
}: QAppDesignProps<'InputCamera3D'>) => {
  const { label, InputLabel } = useInputLabel(value?.label, id, 'InputCamera3D', onDelete)
  const [horizontalSlot, setHorizontalSlot] = useState<string | null>(value?.horizontalSlot || null)
  const [verticalSlot, setVerticalSlot] = useState<string | null>(value?.verticalSlot || null)
  const [zoomSlot, setZoomSlot] = useState<string | null>(value?.zoomSlot || null)

  useEffect(() => {
    if (!horizontalSlot || !verticalSlot || !zoomSlot) {
      return
    }
    setValue({
      label,
      horizontalSlot,
      verticalSlot,
      zoomSlot,
      component: 'InputCamera3D'
    } satisfies QAppCfgInputCamera3D)
  }, [label, horizontalSlot, verticalSlot, zoomSlot, setValue])

  return (
    <DsnComponentLayout>
      <InputLabel />
      <InputNodeSelect
        label={`${QAppCfgComponentNameMap['InputCamera3D']} 水平角度`}
        value={horizontalSlot}
        onChange={setHorizontalSlot}
        workflow={workflow}
        objectInfos={objectInfos}
        mode="field"
        allowFieldCondition={allowFieldCondition}
      />
      <InputNodeSelect
        label={`${QAppCfgComponentNameMap['InputCamera3D']} 垂直角度`}
        value={verticalSlot}
        onChange={setVerticalSlot}
        workflow={workflow}
        objectInfos={objectInfos}
        mode="field"
        allowFieldCondition={allowFieldCondition}
      />
      <InputNodeSelect
        label={`${QAppCfgComponentNameMap['InputCamera3D']} 缩放`}
        value={zoomSlot}
        onChange={setZoomSlot}
        workflow={workflow}
        objectInfos={objectInfos}
        mode="field"
        allowFieldCondition={allowFieldCondition}
      />
    </DsnComponentLayout>
  )
}

DsnInputCamera3D.displayName = 'QAppDsnCamera3D'

export default DsnInputCamera3D
