import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  compatibleEmbeddedRequirements,
  createEmbeddedRequirementsInput,
  validateEmbeddedAugmentationPackages
} from './embedded-requirements-compatibility.mjs'

vi.unmock('node:fs')

describe('audited embedded requirements compatibility', () => {
  const name = 'comfyui_LLM_party/requirements_fixed.txt'
  it('updates only the obsolete Accelerate pin while retaining every other fixed requirement', () => {
    const original = 'bitsandbytes==0.43.1\r\naccelerate==0.30.1\r\nmoviepy==1.0.3\r\npeft\r\n'
    expect(compatibleEmbeddedRequirements(original, name)).toBe(
      'bitsandbytes==0.43.1\naccelerate==1.15.0\nmoviepy==1.0.3\npeft\n'
    )
    expect(compatibleEmbeddedRequirements(original, name.replaceAll('/', '\\'))).toContain(
      'accelerate==1.15.0'
    )
    expect(original).toContain('accelerate==0.30.1')
  })
  it('does not rewrite any other node or requirements variant', () => {
    for (const file of ['other/requirements_fixed.txt', 'comfyui_LLM_party/requirements.txt']) {
      expect(compatibleEmbeddedRequirements('accelerate==0.30.1\r\n', file)).toBe(
        'accelerate==0.30.1\r\n'
      )
    }
  })
  it('refuses relative includes and path directives before relocating a requirements input', () => {
    for (const directive of [
      '-r more.txt',
      '--constraint other.txt',
      './local',
      'git+https://example.invalid/repo'
    ]) {
      expect(() =>
        compatibleEmbeddedRequirements(`accelerate==0.30.1\n${directive}\n`, name)
      ).toThrow('path or pip directives')
    }
  })

  it('safely retries generation without overwriting earlier outputs or changing vendor bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magicpot-compat-retry-'))
    try {
      const file = path.join(root, 'vendor-requirements.txt')
      const content = 'accelerate==0.30.1\r\nmoviepy==1.0.3\r\n'
      fs.writeFileSync(file, content)
      const first = createEmbeddedRequirementsInput(file, name, path.join(root, 'generated'))
      fs.writeFileSync(first, 'interrupted or externally changed previous output')
      const second = createEmbeddedRequirementsInput(file, name, path.join(root, 'generated'))
      const third = createEmbeddedRequirementsInput(file, name, path.join(root, 'generated'))
      expect(new Set([first, second, third]).size).toBe(3)
      expect(fs.readFileSync(first, 'utf8')).toBe(
        'interrupted or externally changed previous output'
      )
      expect(fs.readFileSync(second, 'utf8')).toBe('accelerate==1.15.0\nmoviepy==1.0.3\n')
      expect(fs.readFileSync(file, 'utf8')).toBe(content)
      fs.writeFileSync(file, 'accelerate==0.30.2\n')
      expect(() =>
        createEmbeddedRequirementsInput(file, name, path.join(root, 'generated'))
      ).toThrow('compatibility pin changed')
      expect(fs.readFileSync(second, 'utf8')).toBe('accelerate==1.15.0\nmoviepy==1.0.3\n')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  describe('ControlNet Aux image augmentation compatibility', () => {
    const controlnet = 'comfyui_controlnet_aux/requirements.txt'

    it.each(['albumentations', 'albumentationsx'])(
      'resolves the audited %s declaration to the existing single-owner runtime',
      (declaration) => {
        const original = `# dependencies\r\ntorch\r\n${declaration}\r\nrtree\r\n`
        expect(compatibleEmbeddedRequirements(original, controlnet)).toBe(
          '# dependencies\ntorch\nalbumentations==2.0.8\nrtree\n'
        )
        expect(compatibleEmbeddedRequirements(original, controlnet.replaceAll('/', '\\'))).toBe(
          '# dependencies\ntorch\nalbumentations==2.0.8\nrtree\n'
        )
      }
    )

    it.each([
      '',
      'albumentationsx>=2.5',
      'albumentationsx[headless]',
      'albumentationsx; python_version >= "3.13"',
      'albumentationsx\nalbumentations',
      'albumentationsx\nalbumentationsx',
      'AlbumentationsX',
      'albumentationsx @ https://example.invalid/package.whl'
    ])('requires review instead of silently changing upstream constraints: %s', (input) => {
      expect(() => compatibleEmbeddedRequirements(input, controlnet)).toThrow(
        'compatibility declaration changed'
      )
    })

    it('does not rename dependencies belonging to other nodes or fixed-file variants', () => {
      const original = 'albumentationsx\r\n'
      for (const file of [
        'other/requirements.txt',
        'comfyui_controlnet_aux/requirements_fixed.txt'
      ]) {
        expect(compatibleEmbeddedRequirements(original, file)).toBe(original)
      }
    })

    it.each(['-r nested.txt', '--index-url https://example.invalid', './local', 'C:\\local'])(
      'refuses relocation that would change requirement semantics: %s',
      (directive) => {
        expect(() =>
          compatibleEmbeddedRequirements(`albumentationsx\n${directive}`, controlnet)
        ).toThrow('path or pip directives')
      }
    )

    it('writes a fresh compatible input without changing the plugin checkout', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magicpot-controlnet-compat-'))
      try {
        const file = path.join(root, 'requirements.txt')
        const original = 'torch\r\nalbumentationsx\r\nrtree\r\n'
        fs.writeFileSync(file, original)
        const first = createEmbeddedRequirementsInput(
          file,
          controlnet,
          path.join(root, 'generated')
        )
        const second = createEmbeddedRequirementsInput(
          file,
          controlnet,
          path.join(root, 'generated')
        )
        expect(first).not.toBe(second)
        expect(fs.readFileSync(first, 'utf8')).toBe('torch\nalbumentations==2.0.8\nrtree\n')
        expect(fs.readFileSync(second, 'utf8')).toBe(fs.readFileSync(first, 'utf8'))
        expect(fs.readFileSync(file, 'utf8')).toBe(original)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })

  describe('installed augmentation namespace guard', () => {
    const valid = [
      { name: 'albumentations', version: '2.0.8' },
      { name: 'albucore', version: '0.0.24' }
    ]

    it('accepts only the tested pair and permits unrelated packages', () => {
      expect(
        validateEmbeddedAugmentationPackages([...valid, { name: 'numpy', version: '2.4.6' }])
      ).toEqual({
        albumentations: '2.0.8',
        albucore: '0.0.24'
      })
    })

    it.each(['albumentationsx', 'AlbumentationsX'])(
      'rejects a shared-namespace owner even if pip check considers metadata satisfied: %s',
      (name) => {
        expect(() =>
          validateEmbeddedAugmentationPackages([...valid, { name, version: '2.5.1' }])
        ).toThrow('cannot share')
      }
    )

    it.each([
      { packages: [] },
      { packages: [valid[0]] },
      { packages: [valid[1]] },
      { packages: [...valid, valid[0]] },
      { packages: [{ name: 'albumentations', version: '1.4.15' }, valid[1]] },
      { packages: [valid[0], { name: 'albucore', version: '0.2.21' }] }
    ])(
      'rejects missing, duplicate, or resolver-backtracked distributions: $packages',
      ({ packages }) => {
        expect(() => validateEmbeddedAugmentationPackages(packages)).toThrow('Expected exactly one')
      }
    )

    it.each([null, {}, [null], [{ name: 'albumentations' }]].map((packages) => ({ packages })))(
      'rejects malformed inventory: $packages',
      ({ packages }) => {
        expect(() => validateEmbeddedAugmentationPackages(packages)).toThrow('Invalid embedded')
      }
    )

    it('runs after dependency resolution and before the existing strict ComfyUI smoke test', () => {
      const source = fs.readFileSync(
        new URL('./prepare-embedded-python.mjs', import.meta.url),
        'utf8'
      )
      const gate = source.indexOf(
        "runPhase('verify-augmentation-packages', verifyAugmentationPackages)"
      )
      expect(gate).toBeGreaterThan(source.indexOf("runPhase('verify-final-dependencies'"))
      expect(gate).toBeLessThan(source.indexOf("runPhase('comfy-quick-test'"))
      expect(source).toContain('validateEmbeddedAugmentationPackages(packages)')
    })
  })

  it('fails closed when the audited upstream pin changes or is ambiguous', () => {
    for (const text of ['', 'accelerate==0.30.2\n', 'accelerate==0.30.1\naccelerate==0.30.1\n']) {
      expect(() => compatibleEmbeddedRequirements(text, name)).toThrow('compatibility pin changed')
    }
  })
})
