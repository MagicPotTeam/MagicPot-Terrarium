import { describe, expect, it } from 'vitest'
import {
  classifyMagicAgentConfigPrivilegeChange,
  type MagicAgentConfigContent
} from './agentConfig'

const config = (overrides: Partial<MagicAgentConfigContent> = {}): MagicAgentConfigContent => ({
  version: 'v1',
  definitionId: 'agent',
  model: { profileId: 'default' },
  systemPrompt: 'safe',
  inference: {},
  tools: { allowedToolNames: ['read'] },
  memory: { allowHistory: false, contextMessageLimit: 10, scope: 'instance' },
  policy: { policyIds: ['base'], workspaceRoots: ['/workspace'] },
  channels: { channelIds: ['private'] },
  budgets: { maxRuntimeMs: 1000, maxTurns: 10, maxTokens: 1000, maxToolCalls: 5 },
  createdAt: 1,
  createdBy: { kind: 'user', id: 'owner' },
  contentDigest: 'a'.repeat(64),
  ...overrides
})

describe('classifyMagicAgentConfigPrivilegeChange', () => {
  it('classifies added tools/channels and increased budgets as expansion', () => {
    expect(
      classifyMagicAgentConfigPrivilegeChange(
        config(),
        config({
          tools: { allowedToolNames: ['read', 'write'] }
        })
      )
    ).toBe('expansion')
    expect(
      classifyMagicAgentConfigPrivilegeChange(
        config(),
        config({
          budgets: { ...config().budgets, maxRuntimeMs: 2000 }
        })
      )
    ).toBe('expansion')
  })

  it('classifies removal and lower budgets as reduction', () => {
    expect(
      classifyMagicAgentConfigPrivilegeChange(
        config(),
        config({
          tools: { allowedToolNames: [] },
          budgets: { ...config().budgets, maxRuntimeMs: 500 }
        })
      )
    ).toBe('reduction')
  })

  it('treats prompt/model changes without authority change as equivalent', () => {
    expect(
      classifyMagicAgentConfigPrivilegeChange(
        config(),
        config({
          systemPrompt: 'updated',
          model: { profileId: 'other' }
        })
      )
    ).toBe('equivalent')
  })
})
