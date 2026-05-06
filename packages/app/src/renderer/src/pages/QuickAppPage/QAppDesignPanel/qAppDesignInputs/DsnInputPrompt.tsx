import { QAppDesignComponent, QAppDesignProps } from './types'
import { useEffect, useState } from 'react'
import DsnComponentLayout from './components/DsnComponentLayout'
import { useInputLabel } from './components/InputLabel'
import InputNodeSelect from './components/InputNodeSelect'
import InputSwitch from '@renderer/components/inputs/InputSwitch'
import { conditionFieldTypeIs } from './conditions'
import { QAppCfgComponentNameMap } from '@shared/qApp/consts'
import InputTextArea from '@renderer/components/inputs/InputTextArea'
import { QAppCfgInputPrompt } from '@shared/qApp/cfgTypes'
import { Alert, Typography } from '@mui/material'
import InputNumber from '@renderer/components/inputs/InputNumber'

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

  const [withMaxLength, setWithMaxLength] = useState<boolean>(!!value?.maxLength || false)
  const [maxLength, setMaxLength] = useState<number>(value?.maxLength || 0)

  const [withPromptDescription, setWithPromptDescription] = useState<boolean>(
    !!value?.promptDescription || false
  )
  const [promptDescription, setPromptDescription] = useState<string>(value?.promptDescription || '')

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
    if (withMaxLength) {
      value.maxLength = maxLength
    }
    if (withPromptDescription) {
      value.promptDescription = promptDescription
    }
    setValue(value satisfies QAppCfgInputPrompt)
  }, [
    label,
    slot,
    withPromptDescription,
    promptDescription,
    suffixPrompt,
    withMaxLength,
    maxLength,
    setValue
  ])

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
      <InputSwitch
        value={withMaxLength}
        onChange={setWithMaxLength}
        label="添加提示词最大长度限制"
      />
      {withMaxLength && (
        <>
          <Alert severity="info">
            <Typography>提示词最大长度限制，如果小于等于 0 ，则不限制。</Typography>
          </Alert>
          <InputNumber value={maxLength} onChange={setMaxLength} label="提示词最大长度限制" />
        </>
      )}
      <InputSwitch
        value={withPromptDescription}
        onChange={setWithPromptDescription}
        label="添加 LLM 生成描述"
      />
      {withPromptDescription && (
        <>
          <Alert severity="info">
            <Typography>
              在使用随机提示词生成时，会用到以下描述，可以使生成的提示词更加符合功能需求。
            </Typography>
            <Typography>例如：”生成图片背景“、”生成新的室内装修样式”等。</Typography>
          </Alert>
          <InputTextArea
            value={promptDescription}
            onChange={setPromptDescription}
            label="提示词描述"
            placeholder="这段提示词用于描述什么..."
          />
        </>
      )}
    </DsnComponentLayout>
  )
}

DsnInputPrompt.displayName = 'QAppDsnPrompt'

export default DsnInputPrompt
