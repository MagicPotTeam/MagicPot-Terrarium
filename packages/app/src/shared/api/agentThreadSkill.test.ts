import { describe, expect, it } from 'vitest'
import { isThreadSkillPattern, matchesThreadSkillPath } from './agentThreadSkill'

describe('bounded procedural skill path matching', () => {
  it.each([
    ['*.ts', 'src/app.ts', true], ['*.ts', 'app.js', false], ['**/*.pdf', 'one.pdf', true], ['**/*.pdf', 'dir/sub/file.pdf', true],
    ['src/*.ts', 'src/sub/app.ts', false], ['src/**/a?.ts', 'src/sub/a1.ts', true], ['src/**/a?.ts', 'src/a2.ts', true],
    ['𠮷.ts', '𠮷.ts', true], ['?.ts', '𠮷.ts', true], ['??.ts', '𠮷.ts', false], ['文档/**/𠮷*.ts', '文档/深层/𠮷郎.ts', true],
    ['文档/*.md', '文档/说明.md', true], ['todo.md', 'docs/todo.md', true], ['*.md', 'README.MD', false],
    ['../*.ts', 'a.ts', false], ['*.ts', '../a.ts', false], ['*.ts', '/a.ts', false], ['*.ts', 'C:/a.ts', false], ['*.ts', 'x\\a.ts', false]
  ])('%s against %s is %s', (pattern, path, expected) => expect(matchesThreadSkillPath(pattern, path)).toBe(expected))
  it.each(['', '/a', '../a', 'x/../a', 'C:/a', 'a\\b', '[ab]', '{a,b}', 'a'.repeat(129)])('rejects unsupported pattern %s', (pattern) => expect(isThreadSkillPattern(pattern)).toBe(false))
  it('shares a deterministic work budget rather than accepting adversarial regex expansion', () => {
    expect(() => matchesThreadSkillPath('*a'.repeat(60), 'a'.repeat(500), { remaining: 10 })).toThrow('budget')
    expect(matchesThreadSkillPath('*a'.repeat(60), 'a'.repeat(500))).toBe(true)
  })
})
