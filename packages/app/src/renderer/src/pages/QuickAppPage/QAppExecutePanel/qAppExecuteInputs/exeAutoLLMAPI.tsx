import React, { useImperativeHandle } from 'react'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { ExeAutoBuilder, ExeAutoProps } from './types'
import { valueIsJsonDict } from '@shared/utils/utilTypes'
import { Config, LLMAPIProfile } from '@shared/config/config'
import { isVisionCapableApiProfile } from '@shared/config/apiProfileSelectors'
import { Alert, Button } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { findQAppApiProfile, getQAppApiProfiles } from './qAppApiProfiles'
import {
  isQAppLlmProfileUsableInWorkflow,
  resolveQAppLlmProfileSlotValues
} from './qAppLlmProfileSlots'

const llmProfile = (config: Config, needVisionModel?: boolean) => {
  const profiles = getQAppApiProfiles(config)
  if (config.use_remote_llm) {
    const serverOrigin = config.remote_llm_server_config?.server_origin || 'http://localhost:3721'
    return {
      id: 'remote',
      model_name: 'gpt-4o', // 使用一个通用的模型名，代理端可能不仅支持 Gemini
      base_url: `${serverOrigin}/v1`,
      api_key: 'sk-remote',
      is_ollama: false,
      is_vision_model: true // 假设远程服务端支持视觉
    } as LLMAPIProfile
  }

  if (profiles.length === 0) {
    return undefined
  }
  return findQAppApiProfile(config, { needVisionModel })
}

const llmConfigValid = (config: Config, needVisionModel?: boolean) => {
  const apiProfile = llmProfile(config, needVisionModel)
  if (!apiProfile) {
    return false
  }
  if (needVisionModel && !isVisionCapableApiProfile(apiProfile)) {
    return false
  }
  if (!isQAppLlmProfileUsableInWorkflow(config, apiProfile)) {
    return false
  }
  return !!apiProfile.model_name
}

const buildExeAutoLLMAPI: ExeAutoBuilder<'AutoLLMAPI'> = (cfg, workflow) => {
  const { label, seperateSlots, needVisionModel } = cfg
  const [modelNameSlot, baseUrlSlot, apiKeySlot, isOllamaSlot] = (() => {
    if (seperateSlots) {
      return [cfg.modelNameSlot, cfg.baseUrlSlot, cfg.apiKeySlot, cfg.isOllamaSlot]
    }
    const { nodeSlot } = cfg
    if (!nodeSlot) {
      throw new Error(`nodeSlot is required`)
    }

    const llmLoaderNode = getJsonPath(nodeSlot, workflow)
    if (
      !valueIsJsonDict(llmLoaderNode) ||
      !('inputs' in llmLoaderNode) ||
      !valueIsJsonDict(llmLoaderNode.inputs)
    ) {
      throw new Error(`nodeSlot ${nodeSlot} is not a valid node`)
    }
    return [
      nodeSlot + '.inputs.model_name',
      nodeSlot + '.inputs.base_url',
      nodeSlot + '.inputs.api_key',
      nodeSlot + '.inputs.is_ollama'
    ]
  })()

  const id = `QAppAutoLLMAPI-${label}`
  const QAppAutoLLMAPI: React.FC<ExeAutoProps> = ({ ref, config, ...props }) => {
    const navigate = useNavigate()
    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (workflow) => {
          const apiProfile = llmProfile(config, needVisionModel)
          if (!apiProfile) {
            return
          }
          const slotValues = resolveQAppLlmProfileSlotValues(config, apiProfile)
          setJsonPath(modelNameSlot, workflow, slotValues.modelName)
          setJsonPath(baseUrlSlot, workflow, slotValues.baseUrl)
          setJsonPath(apiKeySlot, workflow, slotValues.apiKey)
          setJsonPath(isOllamaSlot, workflow, slotValues.isOllama)
        },
        validate: (workflow) => {
          if (!llmConfigValid(config, needVisionModel)) {
            return '快应用 API 未配置完成'
          }
          return ''
        }
      }),
      [config]
    )

    if (!llmConfigValid(config, needVisionModel)) {
      return (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                navigate('/settings', { state: { tab: 'plugin' } })
              }}
            >
              前往设置
            </Button>
          }
        >
          {needVisionModel
            ? '这个快应用需要支持视觉的快应用 API，请先在“快应用 API”里完成配置。'
            : '这个快应用需要可用的快应用 API，请先在“快应用 API”里完成配置。'}
        </Alert>
      )
    }
    return null
  }
  QAppAutoLLMAPI.displayName = id
  return QAppAutoLLMAPI
}

export default buildExeAutoLLMAPI
