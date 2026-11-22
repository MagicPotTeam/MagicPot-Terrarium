import { describe, expect, it } from 'vitest'
import { isAgentSideCommand, parseAgentSideCommand } from './agentSideCommand'
const id = '11111111-1111-4111-8111-111111111111'
describe('explicit private /btw composer grammar', () => {
  it('recognizes exact leading commands and bounded multiline questions only', () => {
    expect(parseAgentSideCommand('  /BTW   ')).toEqual({ action: 'help' })
    expect(parseAgentSideCommand('/btw private\nquestion')).toEqual({ action: 'start', question: 'private\nquestion' })
    expect(parseAgentSideCommand(`/btw --continue ${id} follow up`)).toEqual({ action: 'continue', branchId: id, question: 'follow up' })
    for (const action of ['open', 'stop'] as const) expect(parseAgentSideCommand(`/btw --${action} ${id}`)).toEqual({ action, branchId: id })
    for (const text of ['say /btw question', '/btwx question', 'ordinary']) { expect(isAgentSideCommand(text)).toBe(false); expect(parseAgentSideCommand(text)).toBeUndefined() }
  })
  it.each(['/btw --remove x', '/btw --stop', `/btw --stop ${id} ignored`, `/btw --open ${id} question`, `/btw --continue ${id}`, '/btw --open ../../other', '/btw q\0x', '/btw ' + 'x'.repeat(8001)])('rejects malformed or wider commands without a parent-message fallback: %s', text => {
    expect(isAgentSideCommand(text)).toBe(true); expect(() => parseAgentSideCommand(text)).toThrow('Invalid')
  })
})
