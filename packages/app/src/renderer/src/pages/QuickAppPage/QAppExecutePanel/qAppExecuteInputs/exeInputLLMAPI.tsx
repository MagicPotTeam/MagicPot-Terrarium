import React, { useCallback, useEffect, useImperativeHandle, useMemo } from 'react'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { ExeInputBuilder, ExeInputProps } from './types'
import { valueIsJsonDict } from '@shared/utils/utilTypes'
import { Config, LLMAPIProfile } from '@shared/config/config'
import { isVisionCapableApiProfile } from '@shared/config/apiProfileSelectors'
import InputSelect from '@renderer/components/inputs/InputSelect'
import { useQAppInputState } from '../../components/QAppContext'
import { getQAppApiProfiles } from './qAppApiProfiles'
import {
  isQAppLlmProfileUsableInWorkflow,
  resolveQAppLlmProfileSlotValues
} from './qAppLlmProfileSlots'

const llmProfiles = (config: Config, needVisionModel?: boolean) => {
  const profiles = getQAppApiProfiles(config)
  if (profiles.length === 0) {
    return []
  }
  return profiles
    .filter((profile) => !!profile.model_name)
    .filter((profile) => {
      if (needVisionModel) {
        return isVisionCapableApiProfile(profile)
      }
      return true
    })
}

const llmConfigValid = (config: Config, apiProfile: LLMAPIProfile, needVisionModel?: boolean) => {
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

const buildExeInputLLMAPI: ExeInputBuilder<'InputLLMAPI'> = (cfg, workflow) => {
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

  const id = `QAppInputLLMAPI-${label}`
  const QAppInputLLMAPI: React.FC<ExeInputProps> = ({ objectInfos, config, ref }) => {
    const validProfiles = useMemo(() => llmProfiles(config, needVisionModel), [config])
    const defaultProfile = validProfiles[0] || null
    const defaultValue = defaultProfile?.model_name || ''
    const [value, setValue] = useQAppInputState<string>(modelNameSlot, defaultValue)

    const findProfile = useCallback(
      (value: string) => {
        return validProfiles.find((profile) => profile.model_name === value)
      },
      [validProfiles]
    )

    useEffect(() => {
      if (!value) {
        if (defaultValue) {
          setValue(defaultValue)
        }
        return
      }
      const matched = findProfile(value)
      if (!matched && defaultValue) {
        setValue(defaultValue)
      }
    }, [value, defaultValue, findProfile, setValue])

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (workflow) => {
          const profile = findProfile(value)
          if (!profile) {
            return
          }
          const slotValues = resolveQAppLlmProfileSlotValues(config, profile)
          setJsonPath(modelNameSlot, workflow, slotValues.modelName)
          setJsonPath(baseUrlSlot, workflow, slotValues.baseUrl)
          setJsonPath(apiKeySlot, workflow, slotValues.apiKey)
          setJsonPath(isOllamaSlot, workflow, slotValues.isOllama)
        },
        validate: (workflow) => {
          const profile = findProfile(value)
          if (!profile) {
            return '快应用 API 未选择'
          }
          if (!llmConfigValid(config, profile, needVisionModel)) {
            return '快应用 API 未配置完成'
          }
          return ''
        }
      }),
      [config, value, findProfile]
    )

    return (
      <InputSelect
        label={label}
        value={value}
        onChange={(v) => setValue(v)}
        items={validProfiles.map((profile) => ({
          label: profile.model_name,
          value: profile.model_name
        }))}
        tooltip={needVisionModel ? '必须为视觉模型' : undefined}
      />
    )
  }

  QAppInputLLMAPI.displayName = id
  return QAppInputLLMAPI
}

export default buildExeInputLLMAPI
