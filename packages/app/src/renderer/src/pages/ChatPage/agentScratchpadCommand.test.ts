import { describe, expect, it } from 'vitest'
import { isAgentScratchpadCommand, parseAgentScratchpadCommand, formatAgentScratchpad } from './agentScratchpadCommand'

describe('user-only read-only /scratchpad and /pad grammar/projection', () => {
  it('recognizes only exact command tokens, no quoted/prose/provider-style fallback', () => {
    for (const text of ['/scratchpad', ' /PAD ', '/ScratchPad\t']) {
      expect(isAgentScratchpadCommand(text)).toBe(true)
      expect(parseAgentScratchpadCommand(text)).toEqual({ action: 'view' })
    }
    for (const text of ['/scratchpadx', '/padx', 'quote /pad', 'normal', '```\n/pad\n```']) {
      expect(isAgentScratchpadCommand(text)).toBe(false)
      expect(parseAgentScratchpadCommand(text)).toBeUndefined()
    }
  })
  it.each(['/pad set x value', '/scratchpad clear', '/pad get x', '/pad\nset x value', '/scratchpad \0'])('rejects recognized mutation/arguments instead of falling through: %j', text => {
    expect(isAgentScratchpadCommand(text)).toBe(true)
    expect(() => parseAgentScratchpadCommand(text)).toThrow('Invalid')
  })
  it('shows a read-only bounded visible snapshot, never renderer-executable HTML', () => {
    expect(formatAgentScratchpad({ revision: 2, notes: [{ key: 'design', value: '<script>untrusted</script>\nline2', updatedAt: 1 }] })).toEqual({ revision: 2, text: 'design: <script>untrusted</script>\nline2', truncated: false })
    expect(formatAgentScratchpad({ revision: 0, notes: [] })).toEqual({ revision: 0, text: '', truncated: false })
    const result = formatAgentScratchpad({ revision: 3, notes: [{ key: 'many', value: Array.from({ length: 70 }, (_, i) => `line${i}`).join('\n'), updatedAt: 1 }] })
    expect(result.text.split('\n')).toHaveLength(50); expect(result.truncated).toBe(true); expect(result.text).not.toContain('line50')
    expect(result.revision).toBe(3)
  })
  it.each([
    { revision: -1, notes: [] }, { revision: 1.5, notes: [] }, { revision: 0, notes: null },
    { revision: 0, notes: [{ key: '__private__', value: 'private', updatedAt: 1 }] },
    { revision: 0, notes: [{ key: 'x', value: 7, updatedAt: 1 }] },
    { revision: 0, notes: [{ key: 'x', value: 'a', updatedAt: 1 }, { key: 'x', value: 'b', updatedAt: 2 }] }
  ])('rejects invalid IPC snapshots without manufacturing successful empty notes: %j', value => {
    expect(() => formatAgentScratchpad(value)).toThrow('Invalid')
  })
})
