import type { CustomSkill } from '@shared/config/config'

export const NO_SKILL_VALUE = ''
export const UNCATEGORIZED_SKILL_LABEL = 'Uncategorized'

const normalize = (value: string | null | undefined): string => value?.trim() || ''

export const getCustomSkillCategory = (skill: Pick<CustomSkill, 'category'>): string =>
  normalize(skill.category) || UNCATEGORIZED_SKILL_LABEL

export const getCustomSkillName = (skill: Pick<CustomSkill, 'skillName'>): string =>
  normalize(skill.skillName) || 'Untitled skill'

export const buildCustomSkillCategories = (skills: CustomSkill[] | undefined): string[] =>
  [...new Set((skills || []).map((skill) => getCustomSkillCategory(skill)))].sort((left, right) =>
    left.localeCompare(right)
  )

export const getSkillsForCategory = (
  skills: CustomSkill[] | undefined,
  category: string | null | undefined
): CustomSkill[] => {
  const normalizedCategory = normalize(category)
  if (!normalizedCategory) {
    return []
  }

  return (skills || []).filter((skill) => getCustomSkillCategory(skill) === normalizedCategory)
}

export const findCustomSkillById = (
  skills: CustomSkill[] | undefined,
  skillId: string | null | undefined
): CustomSkill | null => {
  if (!skillId) {
    return null
  }

  return (skills || []).find((skill) => skill.id === skillId) || null
}

export const isAgentSkill = (skill: Pick<CustomSkill, 'type'> | null | undefined): boolean =>
  skill?.type === 'agent'

export const resolveCustomSkillId = (
  skills: CustomSkill[] | undefined,
  skillId: string | null | undefined
): string | null => (findCustomSkillById(skills, skillId)?.id ? skillId || null : null)

export const normalizeProfileIdForSkill = (
  skills: CustomSkill[] | undefined,
  skillId: string | null | undefined,
  profileId: string | null | undefined
): string | null => (isAgentSkill(findCustomSkillById(skills, skillId)) ? null : profileId || null)

export const getSkillCategoryForSkillId = (
  skills: CustomSkill[] | undefined,
  skillId: string | null | undefined
): string => findCustomSkillById(skills, skillId)?.category?.trim() || NO_SKILL_VALUE
