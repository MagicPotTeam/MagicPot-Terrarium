import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { installEmbeddedRequirements } from './install-embedded-requirements.mjs'

vi.unmock('node:fs')

describe('embedded runtime requirements resolution', () => {
  const options = {
    requirementFiles: [
      'ComfyUI/requirements.txt',
      'nodes/inspyrenet/requirements.txt',
      'nodes/rmbg/requirements.txt'
    ],
    constraintsPath: 'constraints.txt',
    indexArgs: ['--extra-index-url', 'https://packages.example.invalid/torch']
  }

  it('resolves every selected node together so Hydra and OmegaConf constraints coexist', () => {
    const calls = []
    installEmbeddedRequirements({ ...options, pip: (args) => calls.push(args) })
    expect(calls).toEqual([
      [
        'install',
        '--upgrade',
        '--prefer-binary',
        '-r',
        options.requirementFiles[0],
        '-r',
        options.requirementFiles[1],
        '-r',
        options.requirementFiles[2],
        '-c',
        options.constraintsPath,
        ...options.indexArgs
      ],
      ['check']
    ])
    expect(calls[0]).not.toContain('--no-deps')
  })

  it('does not turn a resolver conflict into success or continue installing other nodes', () => {
    const calls = []
    const failure = new Error('ResolutionImpossible: incompatible dependencies')
    expect(() =>
      installEmbeddedRequirements({
        ...options,
        pip: (args) => {
          calls.push(args)
          throw failure
        }
      })
    ).toThrow(failure)
    expect(calls).toHaveLength(1)
  })

  it('retains a mandatory pip check and propagates installed-runtime inconsistencies', () => {
    const failure = new Error('hydra-core requires omegaconf<2.4')
    expect(() =>
      installEmbeddedRequirements({
        ...options,
        pip: (args) => {
          if (args[0] === 'check') throw failure
        }
      })
    ).toThrow(failure)
  })

  it('the real preparation path resolves all selected files and checks again after smoke extras', () => {
    const source = fs.readFileSync(
      new URL('./prepare-embedded-python.mjs', import.meta.url),
      'utf8'
    )
    expect(source).toContain(
      'const requirementFiles = [comfyRequirements, ...customRequirementFiles]'
    )
    expect(source).toMatch(
      /installEmbeddedRequirements\(\{\s*requirementFiles,\s*constraintsPath,\s*indexArgs: extraIndexArgs\(\),\s*pip\s*\}\)/
    )
    const extras = source.indexOf("runPhase('install-smoke-extras'")
    const wheel = source.indexOf("runPhase('install-verified-llama-cpp'")
    const check = source.indexOf("runPhase('verify-final-dependencies', () => pip(['check']))")
    const smoke = source.indexOf("runPhase('comfy-quick-test'")
    expect(extras).toBeGreaterThan(-1)
    expect(wheel).toBeGreaterThan(extras)
    expect(check).toBeGreaterThan(wheel)
    expect(smoke).toBeGreaterThan(check)
  })

  it('rejects an empty requirement set rather than silently reducing the embedded runtime', () => {
    expect(() =>
      installEmbeddedRequirements({
        ...options,
        requirementFiles: [],
        pip: () => {
          throw new Error('must not execute')
        }
      })
    ).toThrow('Embedded requirements must be nonempty')
  })
})
