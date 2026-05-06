import { QAppDesignComponent, QAppDesignProps } from './types'
import { conditionFieldTypeIs } from './conditions'
import buildDesignComponent from './buildDesignComponent'
import { useEffect, useState } from 'react'
import { useInputLabel } from './components/InputLabel'
import { QAppCfgInputNumber } from '@shared/qApp/cfgTypes'
import DsnComponentLayout from './components/DsnComponentLayout'
import InputNodeSelect from './components/InputNodeSelect'
import { QAppCfgComponentNameMap } from '@shared/qApp/consts'
import InputNumber from '@renderer/components/inputs/InputNumber'
import { clsAndFieldByJsonPath } from '@shared/comfy/funcs'
import { FieldType } from '@shared/comfy/types'

const allowFieldCondition = conditionFieldTypeIs('INT', 'FLOAT')

const DsnInputNumber: QAppDesignComponent<'InputNumber'> = ({
  workflow,
  objectInfos,
  config,
  buildEnv,
  id,
  value,
  setValue,
  onDelete
}: QAppDesignProps<'InputNumber'>) => {
  const { label, InputLabel } = useInputLabel(value?.label, id, 'InputNumber', onDelete)
  const [slot, setSlot] = useState<string | null>(value?.slot || null)
  const [min, setMin] = useState<number>(value?.min || 0)
  const [max, setMax] = useState<number>(value?.max || 100)
  const [step, setStep] = useState<number>(value?.step || 1)

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
      component: 'InputNumber'
    } satisfies QAppCfgInputNumber)
  }, [label, slot, min, max, step, setValue])

  useEffect(() => {
    if (!slot) {
      return
    }
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
    const min = fieldCfg?.min ?? 0
    const max = fieldCfg?.max ?? 100
    const step = fieldCfg?.step ?? 1
    setMin(min)
    setMax(max)
    setStep(step)
  }, [slot, workflow, objectInfos])

  return (
    <DsnComponentLayout>
      <InputLabel />
      <InputNodeSelect
        label={`${QAppCfgComponentNameMap['InputNumber']}字段`}
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

export default DsnInputNumber
