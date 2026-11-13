import { describe, expect, it } from 'vitest'
import { isAgentSkillCommand, parseAgentSkillCommand } from './agentSkillCommand'
describe('user-only /skill grammar', () => {
  it('parses exact aliases, list and bounded exact names including spaces', () => {
    for (const text of ['/skill', ' /skills ', '/SKILL list']) expect(parseAgentSkillCommand(text)).toEqual({ action: 'list' })
    for (const action of ['show', 'enable', 'disable', 'toggle'] as const) expect(parseAgentSkillCommand(`/skill ${action} name with spaces`)).toEqual({ action, name: 'name with spaces' })
    for (const text of ['/skillx list', 'quote /skill list', 'normal']) { expect(isAgentSkillCommand(text)).toBe(false); expect(parseAgentSkillCommand(text)).toBeUndefined() }
  })
  it.each(['/skill delete one', '/skills toggle', '/skill list extra', '/skill show one\ntwo', '/skill enable bad\0key', '/skill show ' + 'x'.repeat(129)])('rejects %s without a parent fallback', text => {
    expect(isAgentSkillCommand(text)).toBe(true); expect(() => parseAgentSkillCommand(text)).toThrow('Invalid')
  })
})
