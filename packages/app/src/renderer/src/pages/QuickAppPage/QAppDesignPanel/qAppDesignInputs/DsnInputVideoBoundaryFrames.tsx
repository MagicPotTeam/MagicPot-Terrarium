/* eslint-disable react/prop-types */
import { useEffect, useState } from 'react'
import { QAppDesignComponent } from './types'
import { QAppCfgInputVideoBoundaryFrames } from '@shared/qApp/cfgTypes'
import { useInputLabel } from './components/InputLabel'
import DsnComponentLayout from './components/DsnComponentLayout'
import InputNodeSelect from './components/InputNodeSelect'
import { conditionFieldImageUpload } from './conditions'

const DsnInputVideoBoundaryFrames: QAppDesignComponent<'InputVideoBoundaryFrames'> = ({
  workflow,
  objectInfos,
  id,
  value,
  setValue,
  onDelete
}) => {
  const { label, InputLabel } = useInputLabel(
    value?.label,
    id,
    'InputVideoBoundaryFrames',
    onDelete
  )
  const [firstFrameSlot, setFirstFrameSlot] = useState<string | null>(value?.firstFrameSlot || null)
  const [lastFrameSlot, setLastFrameSlot] = useState<string | null>(value?.lastFrameSlot || null)

  useEffect(() => {
    if (!firstFrameSlot || !lastFrameSlot) {
      return
    }

    const cfg: QAppCfgInputVideoBoundaryFrames = {
      label,
      component: 'InputVideoBoundaryFrames',
      firstFrameSlot,
      lastFrameSlot
    }
    setValue(cfg)
  }, [label, firstFrameSlot, lastFrameSlot, setValue])

  return (
    <DsnComponentLayout>
      <InputLabel />
      <InputNodeSelect
        label="首帧字段"
        value={firstFrameSlot}
        onChange={setFirstFrameSlot}
        workflow={workflow}
        objectInfos={objectInfos}
        mode="field"
        allowFieldCondition={conditionFieldImageUpload}
      />
      <InputNodeSelect
        label="尾帧字段"
        value={lastFrameSlot}
        onChange={setLastFrameSlot}
        workflow={workflow}
        objectInfos={objectInfos}
        mode="field"
        allowFieldCondition={conditionFieldImageUpload}
      />
    </DsnComponentLayout>
  )
}

DsnInputVideoBoundaryFrames.displayName = 'QAppDsnInputVideoBoundaryFrames'

export default DsnInputVideoBoundaryFrames
