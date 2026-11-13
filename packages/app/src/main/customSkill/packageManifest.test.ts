import { describe, expect, it } from 'vitest'
import { isPackageSkillRelativePath, parseSkillPackageManifest } from './packageManifest'

describe('passive local package manifest declarations', () => {
  it('reads only declared procedural skills and ignores executable package slots as data', () => {
    expect(parseSkillPackageManifest(`name: untrusted-package
version: '1.0'
python_dependencies: [do-not-install]
tools: [{name: do-not-register, module: malicious, class: Run}]
plugins: [{name: do-not-load, module: malicious}]
commands: [{name: do-not-add, module: malicious}]
skills:
  - name: first
    path: skills/first
    description: Fallback description
  - name: second
    path: documentation/second.md
`)).toEqual([{ name: 'first', path: 'skills/first', description: 'Fallback description' }, { name: 'second', path: 'documentation/second.md', description: '' }])
    expect(parseSkillPackageManifest('name: empty-package')).toEqual([])
    expect(parseSkillPackageManifest('skills: null')).toEqual([])
    expect(parseSkillPackageManifest('\uFEFFskills: []\r\n')).toEqual([])
  })
  it.each(['skills: &a []', 'skills: *a', 'skills: !!seq []', 'skills: []\nskills: []', 'skills: []\n---\nskills: []', '- skills', 'skills: {name: bad}', 'skills: [false]', 'skills: [{name: bad}]', 'skills: [{name: bad, path: one, _root: /outside}]', 'skills: [{name: bad, path: one, enabled: true}]', '__proto__: {}\nskills: []', 'constructor: x\nskills: []', 'skills: [{name: bad, path: one, description: 3}]', 'skills: [{name: bad, path: one, description: "\\0"}]'])('rejects unsafe/ambiguous YAML or declarations: %s', source => {
    expect(() => parseSkillPackageManifest(source)).toThrow('Procedural skill manifest')
  })
  it.each(['../outside', '/absolute', 'C:/outside', '//server/share', 'one/../two', 'one/./two', 'one//two', 'one/', 'one\\two', 'one:stream', 'NUL', 'con.md', 'x/COM1.md', 'x/Lpt9', 'x/ending.', 'x/ending ', 'x/*', 'x/?', 'x/pipe|name', 'x/\0name', 'x/'.repeat(17)+'a', 'a'.repeat(513)])('rejects non-contained or nonportable path %s', candidate => {
    expect(isPackageSkillRelativePath(candidate)).toBe(false)
    expect(() => parseSkillPackageManifest(JSON.stringify({ skills: [{ name: 'bad', path: candidate }] }))).toThrow('declaration')
  })
  it('accepts bounded explicit nested Unicode paths without scanning globs', () => {
    expect(isPackageSkillRelativePath('文档/测试 skill/SKILL.md')).toBe(true)
    expect(isPackageSkillRelativePath('skills/review.v1')).toBe(true)
  })
  it('rejects duplicates and bounded YAML depth, entries and byte excess', () => {
    for (const skills of [
      [{ name: 'same', path: 'one' }, { name: 'same', path: 'two' }],
      [{ name: 'one', path: 'One/Skill.md' }, { name: 'two', path: 'one/skill.md' }],
      Array.from({ length: 101 }, (_, i) => ({ name: `n${i}`, path: `p${i}` }))
    ]) expect(() => parseSkillPackageManifest(JSON.stringify({ skills }))).toThrow()
    expect(() => parseSkillPackageManifest(JSON.stringify({ skills: [{ name: 'a'.repeat(129), path: 'one' }] }))).toThrow('declaration')
    expect(() => parseSkillPackageManifest(JSON.stringify({ skills: [{ name: 'one', path: 'one', description: 'a'.repeat(1001) }] }))).toThrow('declaration')
    expect(() => parseSkillPackageManifest('name: ' + 'a'.repeat(65536))).toThrow('limits')
    expect(() => parseSkillPackageManifest('ignored: ' + '['.repeat(20) + '0' + ']'.repeat(20) + '\nskills: []')).toThrow()
    expect(() => parseSkillPackageManifest(JSON.stringify({ ignored: Array.from({ length: 257 }, () => 0), skills: [] }))).toThrow()
  })
})
