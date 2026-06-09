import React, { createRef } from 'react'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { QAppCfgAutoLLMAPI } from '@shared/qApp/cfgTypes'
import buildExeAutoLLMAPI from './exeAutoLLMAPI'
import type { ExeAutoRef } from './types'

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: []
  },
  local_llm_server_config: {
    ...DEFAULT_CONFIG.local_llm_server_config
  },
  remote_llm_server_config: {
    ...DEFAULT_CONFIG.remote_llm_server_config
  }
})

const renderAutoLLMAPI = (config: Config) => {
  const cfg: QAppCfgAutoLLMAPI = {
    component: 'AutoLLMAPI',
    label: 'Remote LLM',
    seperateSlots: true,
    modelNameSlot: '1.inputs.model_name',
    baseUrlSlot: '1.inputs.base_url',
    apiKeySlot: '1.inputs.api_key',
    isOllamaSlot: '1.inputs.is_ollama',
    needVisionModel: true
  }
  const workflow = {
    '1': {
      class_type: 'LLMLoader',
      inputs: {
        model_name: '',
        base_url: '',
        api_key: '',
        is_ollama: true
      }
    }
  }
  const AutoLLMAPI = buildExeAutoLLMAPI(cfg, workflow)
  const ref = createRef<ExeAutoRef>()

  render(
    <MemoryRouter>
      <AutoLLMAPI objectInfos={{}} buildEnv={DEFAULT_BUILD_ENV} config={config} ref={ref} />
    </MemoryRouter>
  )

  if (!ref.current) {
    throw new Error('Expected AutoLLMAPI ref to be registered')
  }

  return { autoRef: ref.current, workflow }
}

describe('buildExeAutoLLMAPI', () => {
  it('writes a remote OpenAI-compatible profile with the configured access token', () => {
    const config = createConfig()
    config.use_remote_llm = true
    config.remote_llm_server_config.server_origin = 'http://remote.example:3721/'
    config.remote_llm_server_config.access_token = 'proxy-secret'

    const { autoRef, workflow } = renderAutoLLMAPI(config)

    expect(autoRef.validate(workflow)).toBe('')
    autoRef.modifyWorkflow(workflow)

    expect(workflow['1'].inputs).toEqual({
      model_name: 'remote',
      base_url: 'http://remote.example:3721/v1',
      api_key: 'proxy-secret',
      is_ollama: false
    })
  })
})
