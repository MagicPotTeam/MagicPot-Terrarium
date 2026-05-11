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
  const [suffixPrompt, setSuffixPrompt] = useState<string>(value?.suffixPrompt || '')

  useEffect(() => {
    if (!slot) {
      return
    }
    const value: QAppCfgInputPrompt = {
      label,
      slot,
      component: 'InputPrompt',
      suffixPrompt
    }
    setValue(value satisfies QAppCfgInputPrompt)
  }, [label, slot, suffixPrompt, setValue])

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
        value={suffixPrompt}
        onChange={setSuffixPrompt}
        label="提示词后缀"
        placeholder="提示词后缀..."
      />
    </DsnComponentLayout>
  )
}

DsnInputPrompt.displayName = 'QAppDsnPrompt'

export default DsnInputPrompt
