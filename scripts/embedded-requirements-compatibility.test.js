import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  compatibleEmbeddedRequirements,
  createEmbeddedRequirementsInput
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

  it('fails closed when the audited upstream pin changes or is ambiguous', () => {
    for (const text of ['', 'accelerate==0.30.2\n', 'accelerate==0.30.1\naccelerate==0.30.1\n']) {
      expect(() => compatibleEmbeddedRequirements(text, name)).toThrow('compatibility pin changed')
    }
  })
})
