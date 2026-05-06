import { describe, expect, it } from 'vitest'
import type { CustomSkill } from '@shared/config/config'
import {
  NO_SKILL_VALUE,
  buildCustomSkillCategories,
  findCustomSkillById,
  getCustomSkillCategory,
  getCustomSkillName,
  getSkillCategoryForSkillId,
  getSkillsForCategory,
  normalizeProfileIdForSkill,
  resolveCustomSkillId
} from './chatSkillUtils'

const skills: CustomSkill[] = [
  {
    id: 'art-normal',
    category: 'Art',
    skillName: 'Storyboard',
    prompt: 'Turn this into storyboard beats.',
    type: 'normal'
  },
  {
    id: 'ops-agent',
    category: 'Ops',
    skillName: 'Pipeline Agent',
    prompt: 'Focus on operational execution steps.',
    type: 'agent',
    apiAddress: 'https://example.com/api/chat'
  },
  {
    id: 'uncategorized',
    category: '   ',
    skillName: '   ',
    prompt: 'Fallback skill.',
    type: 'normal'
  }
]

describe('chatSkillUtils', () => {
  it('normalizes skill labels and categories for display', () => {
    expect(getCustomSkillCategory(skills[2])).toBe('Uncategorized')
    expect(getCustomSkillName(skills[2])).toBe('Untitled skill')
  })

  it('builds unique sorted category options', () => {
    expect(buildCustomSkillCategories(skills)).toEqual(['Art', 'Ops', 'Uncategorized'])
  })

  it('filters skills by category and resolves ids safely', () => {
    expect(getSkillsForCategory(skills, 'Art').map((skill) => skill.id)).toEqual(['art-normal'])
    expect(findCustomSkillById(skills, 'ops-agent')?.skillName).toBe('Pipeline Agent')
    expect(resolveCustomSkillId(skills, 'missing-skill')).toBeNull()
  })

  it('returns the explicit no-skill category when nothing is selected', () => {
    expect(getSkillCategoryForSkillId(skills, null)).toBe(NO_SKILL_VALUE)
    expect(getSkillCategoryForSkillId(skills, 'ops-agent')).toBe('Ops')
  })

  it('drops built-in profile bindings for agent skills', () => {
    expect(normalizeProfileIdForSkill(skills, 'ops-agent', 'gpt-4o')).toBeNull()
    expect(normalizeProfileIdForSkill(skills, 'art-normal', 'gpt-4o')).toBe('gpt-4o')
    expect(normalizeProfileIdForSkill(skills, null, 'gpt-4o')).toBe('gpt-4o')
  })
})
