import { describe, expect, it } from 'vitest'
import { compatibleEmbeddedRequirements } from './embedded-requirements-compatibility.mjs'

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

  it('fails closed when the audited upstream pin changes or is ambiguous', () => {
    for (const text of ['', 'accelerate==0.30.2\n', 'accelerate==0.30.1\naccelerate==0.30.1\n']) {
      expect(() => compatibleEmbeddedRequirements(text, name)).toThrow('compatibility pin changed')
    }
  })
})
