import { describe, expect, it } from 'vitest'
import { isAgentConfigurationCommand, parseAgentConfigurationCommand } from './agentConfigurationCommand'

describe('user configuration handoff grammar', () => {
  it('accepts exact plugin/module or configure and rejects mutation arguments without model fallback', () => {
    for (const text of ['/plugin', ' /PLUGIN configure ']) expect(parseAgentConfigurationCommand(text)).toBe('plugin')
    for (const text of ['/module', '/Module CONFIGURE']) expect(parseAgentConfigurationCommand(text)).toBe('module')
    for (const text of ['/plugins', '/modulex', 'quote /plugin']) {
      expect(isAgentConfigurationCommand(text)).toBe(false)
      expect(parseAgentConfigurationCommand(text)).toBeUndefined()
    }
    for (const text of ['/plugin enable x', '/module disable bash', '/module set token secret']) {
      expect(isAgentConfigurationCommand(text)).toBe(true)
      expect(() => parseAgentConfigurationCommand(text)).toThrow('Change switches and parameters in the existing editor.')
    }
  })
})
