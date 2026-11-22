import { describe, expect, it } from 'vitest'
import { parseSkillMarkdown } from './markdown'
describe('passive bounded SKILL.md parser', () => {
  it('loads UTF8/BOM/CRLF folder or flat Markdown and preserves body without executing anything', () => {
    const source = '\uFEFF---\r\nname: tests-first\r\ndescription: >\r\n  Test before editing.\r\npaths: ["*.ts", "src/**/*.tsx"]\r\nallowed-tools: [bash, write]\r\nhooks: {pre: "$(never execute)"}\r\n---\r\n# Instructions\r\nDo not execute ${text} automatically.'
    expect(parseSkillMarkdown(source, 'fallback')).toEqual({ name: 'tests-first', description: 'Test before editing.\n', paths: ['*.ts', 'src/**/*.tsx'], instructions: '# Instructions\nDo not execute ${text} automatically.', disableModelInvocation: false, metadataFields: ['allowed-tools', 'hooks'] })
    expect(parseSkillMarkdown('# Flat\n\nRead only.', 'flat')).toMatchObject({ name: 'flat', paths: [], instructions: '# Flat\n\nRead only.' })
  })
  it('applies bounded manifest description only when frontmatter does not supply one', () => {
    expect(parseSkillMarkdown('# Body', 'fallback', 'Manifest')).toMatchObject({ name: 'fallback', description: 'Manifest' })
    expect(parseSkillMarkdown('---\ndescription: ""\n---\nBody', 'fallback', 'Manifest')).toMatchObject({ description: '' })
    expect(parseSkillMarkdown('---\ndescription: Frontmatter\n---\nBody', 'fallback', 'Manifest')).toMatchObject({ description: 'Frontmatter' })
    expect(() => parseSkillMarkdown('# Body', 'fallback', 'a'.repeat(1001))).toThrow('metadata')
  })
  it('normalizes scalar path filters, respects model-hint suppression as data, and gives no grants', () => {
    const result = parseSkillMarkdown('---\npaths: "*.py, **/*.ts"\ndisable-model-invocation: true\nshell: bash\n---\nReview files.', 'review')
    expect(result).toMatchObject({ paths: ['*.py', '**/*.ts'], disableModelInvocation: true, metadataFields: ['shell'] })
    expect(result).not.toHaveProperty('shell'); expect(result).not.toHaveProperty('allowedTools')
  })
  it.each([
    '---\nname: first\nname: duplicate\n---\nbody',
    '---\nname: !!str custom\n---\nbody',
    '---\na: &a [1]\nb: *a\n---\nbody',
    '---\n__proto__: {polluted: true}\n---\nbody',
    '---\npaths: ["../secret"]\n---\nbody',
    '---\npaths: [42]\n---\nbody',
    '---\ndisable-model-invocation: "false"\n---\nbody',
    '---\nname: [not,a,name]\n---\nbody',
    '---\n[not,a,mapping]\n---\nbody',
    '---\nname: broken\nbody',
    '---\nname: local\n---\n',
    'body\0secret'
  ])('rejects invalid or authority-like malformed YAML %s', source => {
    expect(() => parseSkillMarkdown(source, 'fallback')).toThrow('Procedural skill')
  })
  it('bounds file/body/header size and YAML node depth without alias expansion', () => {
    expect(() => parseSkillMarkdown('x'.repeat(65537), 'large')).toThrow('limits')
    expect(() => parseSkillMarkdown('x'.repeat(24001), 'large')).toThrow('body')
    expect(() => parseSkillMarkdown('---\nmetadata: ' + '['.repeat(14) + '0' + ']'.repeat(14) + '\n---\nbody', 'deep')).toThrow('unsupported')
    expect(() => parseSkillMarkdown('---\n#' + '界'.repeat(3000) + '\n---\nbody', 'header')).toThrow('byte limits')
    expect(() => parseSkillMarkdown('---\n#' + 'x'.repeat(8192) + '\n---\nbody', 'header')).toThrow('limits')
  })
})
