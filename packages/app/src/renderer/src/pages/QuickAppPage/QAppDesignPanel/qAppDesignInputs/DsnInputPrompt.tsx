import { QAppDesignComponent, QAppDesignProps } from './types'
import { useEffect, useState } from 'react'
import DsnComponentLayout from './components/DsnComponentLayout'
import { useInputLabel } from './components/InputLabel'
import InputNodeSelect from './components/InputNodeSelect'
import { conditionFieldTypeIs } from './conditions'
import { QAppCfgComponentNameMap } from '@shared/qApp/consts'
import InputTextArea from '@renderer/components/inputs/InputTextArea'
import { QAppCfgInputPrompt } from '@shared/qApp/cfgTypes'

const allowFieldCondition = conditionFieldTypeIs('STRING')

const DsnInputPrompt: QAppDesignComponent<'InputPrompt'> = ({
  workflow,
  objectInfos,
  config,
  buildEnv,
  id,
  value,
  setValue,
  onDelete
}: QAppDesignProps<'InputPrompt'>) => {
  const { label, InputLabel } = useInputLabel(value?.label, id, 'InputPrompt', onDelete)
  const [slot, setSlot] = useState<string | null>(value?.slot || null)
  const [presetPrompt, setPresetPrompt] = useState<string>(value?.suffixPrompt || '')

  useEffect(() => {
    if (!slot) {
      return
    }
    const value: QAppCfgInputPrompt = {
      label,
      slot,
      component: 'InputPrompt',
      suffixPrompt: presetPrompt
    }
    setValue(value satisfies QAppCfgInputPrompt)
  }, [label, slot, presetPrompt, setValue])

  return (
    <DsnComponentLayout>
      <InputLabel />
      <InputNodeSelect
        label={`${QAppCfgComponentNameMap['InputPrompt']}字段`}
        value={slot}
        onChange={setSlot}
        workflow={workflow}
        objectInfos={objectInfos}
        mode="field"
        allowFieldCondition={allowFieldCondition}
      />
      <InputTextArea
        value={presetPrompt}
        onChange={setPresetPrompt}
        label="预设提示词"
        placeholder="一般填写质量词，会显示在用户输入前面"
      />
    </DsnComponentLayout>
  )
}

DsnInputPrompt.displayName = 'QAppDsnPrompt'

export default DsnInputPrompt
