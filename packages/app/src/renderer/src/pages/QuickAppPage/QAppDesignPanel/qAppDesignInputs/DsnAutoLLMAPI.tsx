import { conditionFieldTypeIs, conditionNodeLLMAPI } from './conditions'
import { QAppDesignComponent, QAppDesignProps } from './types'
import { useEffect, useState } from 'react'
import useInputLabel from './components/InputLabel'
import DsnComponentLayout from './components/DsnComponentLayout'
import { QAppCfgAutoLLMAPI } from '@shared/qApp/cfgTypes'
import InputSwitch from '@renderer/components/inputs/InputSwitch'
import InputNodeSelect from './components/InputNodeSelect'
import { Alert, Box } from '@mui/material'

const conditionFieldIsString = conditionFieldTypeIs('STRING')
const conditionFieldIsBoolean = conditionFieldTypeIs('BOOLEAN')

const DsnAutoLLMAPI: QAppDesignComponent<'AutoLLMAPI'> = ({
  workflow,
  objectInfos,
  id,
  value,
  setValue,
  onDelete
}: QAppDesignProps<'AutoLLMAPI'>) => {
  const { label, InputLabel } = useInputLabel(value?.label, id, 'AutoLLMAPI', onDelete)
  const [seperateSlots, setSeperateSlots] = useState<boolean>(value?.seperateSlots || false)
  const [modelNameSlot, setModelNameSlot] = useState<string | null>(
    value?.seperateSlots ? value?.modelNameSlot || null : null
  )
  const [baseUrlSlot, setBaseUrlSlot] = useState<string | null>(
    value?.seperateSlots ? value?.baseUrlSlot || null : null
  )
  const [apiKeySlot, setApiKeySlot] = useState<string | null>(
    value?.seperateSlots ? value?.apiKeySlot || null : null
  )
  const [isOllamaSlot, setIsOllamaSlot] = useState<string | null>(
    value?.seperateSlots ? value?.isOllamaSlot || null : null
  )

  const [nodeSlot, setNodeSlot] = useState<string | null>(
    value?.seperateSlots ? null : value?.nodeSlot || null
  )

  const [needVisionModel, setNeedVisionModel] = useState<boolean>(value?.needVisionModel || false)

  useEffect(() => {
    if (seperateSlots) {
      if (!modelNameSlot || !baseUrlSlot || !apiKeySlot || !isOllamaSlot) {
        return
      }
      const cfg: QAppCfgAutoLLMAPI = {
        label,
        component: 'AutoLLMAPI',
        seperateSlots,
        modelNameSlot,
        baseUrlSlot,
        apiKeySlot,
        isOllamaSlot
      }
      if (needVisionModel) {
        cfg.needVisionModel = true
      }
      setValue(cfg)
    } else {
      if (!nodeSlot) {
        return
      }
      const cfg: QAppCfgAutoLLMAPI = {
        label,
        component: 'AutoLLMAPI',
        nodeSlot
      }
      if (needVisionModel) {
        cfg.needVisionModel = true
      }
      setValue(cfg)
    }
  }, [
    label,
    seperateSlots,
    modelNameSlot,
    baseUrlSlot,
    apiKeySlot,
    isOllamaSlot,
    nodeSlot,
    needVisionModel,
    setValue
  ])

  return (
    <DsnComponentLayout>
      <InputLabel />
      <Alert severity="info">读取快应用 API 配置中的默认 API Profile，执行时自动填入。</Alert>
      <InputSwitch
        value={seperateSlots}
        label="是否分开设置模型名称、基础URL和API密钥的字段"
        onChange={setSeperateSlots}
      />
      {seperateSlots && (
        <>
          <InputNodeSelect
            label="模型名称字段"
            value={modelNameSlot}
            onChange={setModelNameSlot}
            workflow={workflow}
            objectInfos={objectInfos}
            mode="field"
            allowFieldCondition={conditionFieldIsString}
          />
          <InputNodeSelect
            label="Base URL字段"
            value={baseUrlSlot}
            onChange={setBaseUrlSlot}
            workflow={workflow}
            objectInfos={objectInfos}
            mode="field"
            allowFieldCondition={conditionFieldIsString}
          />
          <InputNodeSelect
            label="API Key字段"
            value={apiKeySlot}
            onChange={setApiKeySlot}
            workflow={workflow}
            objectInfos={objectInfos}
            mode="field"
            allowFieldCondition={conditionFieldIsString}
          />
          <InputNodeSelect
            label="是否是 Ollama 模型字段"
            value={isOllamaSlot}
            onChange={setIsOllamaSlot}
            workflow={workflow}
            objectInfos={objectInfos}
            mode="field"
            allowFieldCondition={conditionFieldIsBoolean}
          />
        </>
      )}
      {!seperateSlots && (
        <>
          <InputNodeSelect
            label="模型节点"
            value={nodeSlot}
            onChange={setNodeSlot}
            workflow={workflow}
            objectInfos={objectInfos}
            mode="node"
            allowNodeCondition={conditionNodeLLMAPI}
          />
        </>
      )}
      <Box>
        <InputSwitch
          value={needVisionModel}
          label="是否必须为视觉模型"
          onChange={setNeedVisionModel}
          tooltip="如果工作流中需要将图片等视觉信息提供给 LLM 模型，则必须为视觉模型。"
        />
      </Box>
    </DsnComponentLayout>
  )
}

DsnAutoLLMAPI.displayName = 'QAppDsnAutoLLMAPI'

export default DsnAutoLLMAPI
