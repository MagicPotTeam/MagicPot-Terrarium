import React, { createRef, useState } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { BuildEnv } from '@shared/config/buildEnv'
import type { ExeInputRef } from './types'
import buildExeInputLLMAPI from './exeInputLLMAPI'

vi.mock('../../components/QAppContext', () => ({ useQAppInputState: (_slot: string, initial: string) => useState(initial) }))
vi.mock('@renderer/components/inputs/InputSelect', () => ({ default: ({ items }: { items: Array<{ value: string }> }) => <div>{items.map((item) => <span key={item.value}>{item.value}</span>)}</div> }))

describe('manual QuickApp LLM selection after browser-provider removal', () => {
  it('does not offer or export a retired profile even if it has ordinary API-shaped values', () => {
    const retired = { id: 'retired', call_type: ['chat', 'gpt', '-web'].join(''), model_name: 'legacy-browser-model', base_url: 'https://old.test/v1', api_key: 'old-key' }
    const config = { ...DEFAULT_CONFIG, plugin_config: { ...DEFAULT_CONFIG.plugin_config!, api_profiles: [retired] } }
    const ref = createRef<ExeInputRef>()
    const Input = buildExeInputLLMAPI({ component: 'InputLLMAPI', label: 'Model', seperateSlots: true, modelNameSlot: 'node.inputs.model_name', baseUrlSlot: 'node.inputs.base_url', apiKeySlot: 'node.inputs.api_key', isOllamaSlot: 'node.inputs.is_ollama' }, {})
    render(<Input config={config} objectInfos={{}} buildEnv={{} as BuildEnv} ref={ref} />)
    expect(screen.queryByText('legacy-browser-model')).not.toBeInTheDocument()
    const workflow = {}
    expect(ref.current!.validate(workflow)).not.toBe('')
    ref.current!.modifyWorkflow(workflow)
    expect(workflow).toEqual({})
    expect(config.plugin_config.api_profiles[0]).toBe(retired)
  })
})
