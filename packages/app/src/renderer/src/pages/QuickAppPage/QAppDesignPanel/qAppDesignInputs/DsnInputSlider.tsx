import { useEffect, useRef, useState } from 'react'
import { QAppDesignComponent, QAppDesignProps } from './types'
import DsnComponentLayout from './components/DsnComponentLayout'
import { useInputLabel } from './components/InputLabel'
import InputNodeSelect from './components/InputNodeSelect'
import { conditionFieldTypeIs } from './conditions'
import InputNumber from '@renderer/components/inputs/InputNumber'
import { clsAndFieldByJsonPath } from '@shared/comfy/funcs'
import { FieldType } from '@shared/comfy/types'
import { QAppCfgComponentNameMap } from '@shared/qApp/consts'
import { QAppCfgInputSlider } from '@shared/qApp/cfgTypes'

const allowFieldCondition = conditionFieldTypeIs('INT', 'FLOAT')

const DsnInputSlider: QAppDesignComponent<'InputSlider'> = ({
  workflow,
  objectInfos,
  config,
  buildEnv,
  id,
  value,
  setValue,
  onDelete
}: QAppDesignProps<'InputSlider'>) => {
  const { label, InputLabel } = useInputLabel(value?.label, id, 'InputSlider', onDelete)
  const [slot, setSlot] = useState<string | null>(value?.slot || null)
  const [min, setMin] = useState<number>(value?.min ?? 0)
  const [max, setMax] = useState<number>(value?.max ?? 100)
  const [step, setStep] = useState<number>(value?.step ?? 1)

  // Track the previous slot to detect actual user-initiated slot changes
  // vs. component re-mounting with a saved value
  const prevSlotRef = useRef<string | null>(value?.slot || null)

  useEffect(() => {
    if (!slot) {
      return
    }
    setValue({
      label,
      slot,
      min,
      max,
      step,
      component: 'InputSlider'
    } satisfies QAppCfgInputSlider)
  }, [label, slot, min, max, step, setValue])

  useEffect(() => {
    if (!slot) {
      return
    }
    // Only auto-fill min/max/step from objectInfos when the user picks a NEW slot,
    // not when the component re-mounts with an existing saved slot.
    // This preserves user-customized min/max/step values.
    if (slot === prevSlotRef.current) {
      return
    }
    prevSlotRef.current = slot

    const [cls, field] = clsAndFieldByJsonPath(slot, workflow)
    const nodeObjInfo = objectInfos[cls]
    if (!nodeObjInfo) {
      return
    }
    const fieldObjInfo =
      nodeObjInfo.input?.required?.[field] ?? nodeObjInfo.input?.optional?.[field]
    if (!fieldObjInfo) {
      return
    }
    const [, fieldCfg] = fieldObjInfo as [FieldType, { min?: number; max?: number; step?: number }]
    const newMin = fieldCfg?.min ?? 0
    const newMax = fieldCfg?.max ?? 100
    const newStep = fieldCfg?.step ?? 1
    setMin(newMin)
    setMax(newMax)
    setStep(newStep)
  }, [slot, workflow, objectInfos])

  return (
    <DsnComponentLayout>
      <InputLabel />
      <InputNodeSelect
        label={`${QAppCfgComponentNameMap['InputSlider']}字段`}
        value={slot}
        onChange={setSlot}
        workflow={workflow}
        objectInfos={objectInfos}
        mode="field"
        allowFieldCondition={allowFieldCondition}
      />
      <InputNumber value={min} onChange={setMin} label="最小值" />
      <InputNumber value={max} onChange={setMax} label="最大值" />
      <InputNumber value={step} onChange={setStep} label="步长" />
    </DsnComponentLayout>
  )
}

DsnInputSlider.displayName = 'QAppDsnSlider'

export default DsnInputSlider
