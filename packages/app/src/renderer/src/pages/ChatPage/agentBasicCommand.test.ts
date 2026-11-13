import { describe, expect, it } from 'vitest'
import { isAgentBasicCommand, parseAgentBasicCommand } from './agentBasicCommand'

describe('basic user commands', () => {
  it('accepts exact commands and rejects arguments without matching prefixes', () => {
    for (const command of ['status', 'jobs', 'compact', 'video_gen'] as const) {
      expect(parseAgentBasicCommand(` /${command.toUpperCase()} `)).toBe(command)
      expect(() => parseAgentBasicCommand(`/${command} extra`)).toThrow()
      expect(isAgentBasicCommand(`/${command}x`)).toBe(false)
    }
  })
})
