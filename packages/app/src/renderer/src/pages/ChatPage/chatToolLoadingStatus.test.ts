import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import type { LLMToolStatus } from '@shared/llm/types'
import { getChatToolLoadingStatus } from './chatToolLoadingStatus'

const t = ((_key: string, options: { defaultValue: string }) =>
  options.defaultValue) as unknown as TFunction
const event = (toolName: string, status: LLMToolStatus['status'] = 'running'): LLMToolStatus => ({
  runId: 'run',
  toolCallId: 'call',
  toolName,
  status
})

describe('observed tool activity labels', () => {
  it.each([
    ['web_search', 'Searching the web'],
    ['web_fetch', 'Reading a web page'],
    ['files.read', 'Running a tool']
  ])('labels %s without inventing numeric progress', (name, label) => {
    expect(getChatToolLoadingStatus(event(name), t)).toEqual({ label, detail: name })
  })

  it.each([
    ['completed', 'Tool returned; waiting for the model to continue'],
    ['failed', 'Tool failed'],
    ['cancelled', 'Tool cancelled']
  ] as const)('reports %s for the tool, not the whole task', (status, label) => {
    expect(getChatToolLoadingStatus(event('web_search', status), t)).toEqual({
      label,
      detail: 'web_search'
    })
  })

  it('bounds tool labels and never includes arguments or result bodies', () => {
    const value = {
      ...event('x'.repeat(1000) + '\n\u001b[31m'),
      args: { token: 'PRIVATE' },
      content: 'PRIVATE'
    }
    const result = getChatToolLoadingStatus(value, t)
    expect(result.detail).toHaveLength(128)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(result).not.toHaveProperty('step')
    expect(result).not.toHaveProperty('totalSteps')
  })
})
