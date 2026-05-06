import { describe, expect, it } from 'vitest'
import { BUILT_IN_TAGGING_SKILL_ID } from './builtInSkills'
import {
  resolveSkillExecutionContext,
  shouldIsolateSkillExecution
} from './chatTaggingExecutionUtils'

describe('chatTaggingExecutionUtils', () => {
  it('isolates the built-in tagging skill from ordinary session history', () => {
    const context = resolveSkillExecutionContext({
      skillId: BUILT_IN_TAGGING_SKILL_ID,
      sessionMessages: [{ role: 'user', content: 'history' }],
      sessionUrl: 'session-1'
    })

    expect(shouldIsolateSkillExecution(BUILT_IN_TAGGING_SKILL_ID)).toBe(true)
    expect(context).toEqual({
      historyMessages: [],
      sessionUrl: undefined,
      shouldPersistSessionUrl: false
    })
  })

  it('keeps ordinary chat skills on the default session-history path', () => {
    const context = resolveSkillExecutionContext({
      skillId: 'design-critic',
      sessionMessages: [{ role: 'user', content: 'history' }],
      sessionUrl: 'session-2'
    })

    expect(context).toEqual({
      historyMessages: [{ role: 'user', content: 'history' }],
      sessionUrl: 'session-2',
      shouldPersistSessionUrl: true
    })
  })

  it('limits custom skill context to the configured recent message count', () => {
    const context = resolveSkillExecutionContext({
      skill: {
        id: 'design-critic',
        category: 'Review',
        skillName: 'Design Critic',
        prompt: 'Review the latest work.',
        type: 'normal',
        execution: {
          mode: 'inherit',
          allowHistory: true,
          contextMessageLimit: 3,
          persistSessionUrl: true
        }
      },
      sessionMessages: [
        { role: 'user', content: 'm1' },
        { role: 'assistant', content: 'm2' },
        { role: 'user', content: 'm3' },
        { role: 'assistant', content: 'm4' },
        { role: 'user', content: 'm5' }
      ],
      sessionUrl: 'session-3'
    })

    expect(context).toEqual({
      historyMessages: [
        { role: 'user', content: 'm3' },
        { role: 'assistant', content: 'm4' },
        { role: 'user', content: 'm5' }
      ],
      sessionUrl: undefined,
      shouldPersistSessionUrl: false
    })
  })
})
