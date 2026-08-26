import { describe, expect, it } from 'vitest'
import type { MagicAgentPlatformAgentDefinition } from '@shared/api/svcMagicAgentPlatform'
import path from 'node:path'
import {
  assertPackagePathApproved,
  composeSystemPrompt,
  isPathLikePackageIdentifier,
  mergeAgentDefinitions,
  redactLocalPathFragments,
  resolvePackageAgentAllowedToolNames
} from './magicAgentPlatformUtils'

const agent = (
  id: string,
  overrides: Partial<MagicAgentPlatformAgentDefinition> = {}
): MagicAgentPlatformAgentDefinition => ({
  id,
  name: id,
  ...overrides
})

describe('magic agent platform utilities', () => {
  it('composes agent and request prompts without duplicating identical text', () => {
    expect(composeSystemPrompt('  Agent prompt  ', ' Request prompt ')).toBe(
      'Agent prompt\n\nRequest prompt'
    )
    expect(composeSystemPrompt('Agent prompt', ' Agent prompt ')).toBe('Agent prompt')
    expect(composeSystemPrompt(undefined, ' Request prompt ')).toBe('Request prompt')
  })

  it('merges runtime and package agents in stable id order and rejects duplicates', () => {
    expect(mergeAgentDefinitions([agent('z-runtime')], [agent('a-package')])).toEqual([
      agent('a-package'),
      agent('z-runtime')
    ])
    expect(() => mergeAgentDefinitions([agent('same')], [agent('same')])).toThrow(
      'Duplicate MagicAgent id from installed package: same'
    )
  })

  it('limits requested tools to normalized package tools and removes denied tools', () => {
    expect(
      resolvePackageAgentAllowedToolNames(
        [' Read.File ', 'terminal.run', 'read.file', 'missing'],
        ['read.file', 'terminal.run']
      )
    ).toEqual(['read.file'])
  })

  it('redacts local paths while preserving validation message text', () => {
    expect(redactLocalPathFragments('Failed at C:\\secret\\package.json; /tmp/package.json')).toBe(
      'Failed at [redacted path]; [redacted path]'
    )
  })

  it('recognizes package identifiers that can escape the package id namespace', () => {
    expect(isPathLikePackageIdentifier('../local-package')).toBe(true)
    expect(isPathLikePackageIdentifier('C:\\packages\\local-package')).toBe(true)
    expect(isPathLikePackageIdentifier('demo.package')).toBe(false)
  })

  it('allows package paths only inside the configured package root', () => {
    const packageRoot = path.join(process.cwd(), 'package-root')
    const packageStore = { getPackageRoot: () => packageRoot }

    expect(assertPackagePathApproved(packageStore, path.join(packageRoot, 'demo'))).toBe(
      path.join(packageRoot, 'demo')
    )
    expect(() =>
      assertPackagePathApproved(packageStore, path.join(packageRoot, '..', 'outside'))
    ).toThrow('MagicAgent package paths must be under the configured package root.')
  })
})
