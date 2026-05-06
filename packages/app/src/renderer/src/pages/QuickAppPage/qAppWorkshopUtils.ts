import type { CustomSkill } from '@shared/config/config'
import type { QAppMenuItem } from '@shared/api/svcQApp'

const normalizeText = (value: string | null | undefined): string => value?.trim() || ''

export const getResolvedCustomSkillSystemPrompt = (
  skill: Pick<CustomSkill, 'prompt' | 'instructions'>
): string => normalizeText(skill.instructions?.systemPrompt) || normalizeText(skill.prompt)

export const getResolvedCustomSkillUserPrompt = (
  skill: Pick<CustomSkill, 'instructions'>
): string => normalizeText(skill.instructions?.userPrompt)

export const getResolvedCustomSkillPromptMirror = (
  skill: Pick<CustomSkill, 'prompt' | 'instructions'>
): string =>
  [getResolvedCustomSkillSystemPrompt(skill), getResolvedCustomSkillUserPrompt(skill)]
    .filter(Boolean)
    .join('\n\n')

export const getCustomSkillCategoryLabel = (
  skill: Pick<CustomSkill, 'category'>,
  emptyLabel: string
): string => normalizeText(skill.category) || emptyLabel

export const listCustomSkillCategories = (skills: CustomSkill[], emptyLabel: string): string[] =>
  [
    ...new Set(
      skills.map((skill) => getCustomSkillCategoryLabel(skill, emptyLabel)).filter(Boolean)
    )
  ].sort((left, right) => left.localeCompare(right))

export const getCustomSkillsForCategory = (
  skills: CustomSkill[],
  category: string,
  emptyLabel: string
): CustomSkill[] => {
  const normalizedCategory = normalizeText(category)
  if (!normalizedCategory) {
    return []
  }

  return skills.filter(
    (skill) => getCustomSkillCategoryLabel(skill, emptyLabel) === normalizedCategory
  )
}

export const buildUniqueCustomSkillCategoryName = (
  skills: CustomSkill[],
  baseName: string,
  emptyLabel: string
): string => {
  const existing = new Set(listCustomSkillCategories(skills, emptyLabel))
  if (!existing.has(baseName)) {
    return baseName
  }

  let index = 2
  while (existing.has(`${baseName} ${index}`)) {
    index += 1
  }

  return `${baseName} ${index}`
}

export const buildUniqueCustomSkillName = (
  skills: CustomSkill[],
  category: string,
  baseName: string,
  emptyLabel: string
): string => {
  const existing = new Set(
    getCustomSkillsForCategory(skills, category, emptyLabel).map((skill) =>
      normalizeText(skill.skillName)
    )
  )

  if (!existing.has(baseName)) {
    return baseName
  }

  let index = 2
  while (existing.has(`${baseName} ${index}`)) {
    index += 1
  }

  return `${baseName} ${index}`
}

export const getCustomSkillValidationIssues = (
  skill: CustomSkill,
  t?: (key: string, options?: Record<string, unknown>) => string
): string[] => {
  const issues: string[] = []

  const getMsg = (key: string, defaultMsg: string) =>
    t ? t(key, { defaultValue: defaultMsg }) : defaultMsg

  if (!normalizeText(skill.skillName)) {
    issues.push(getMsg('custom_workshop.error_skill_name_required', 'Skill name is required.'))
  }
  if (!getResolvedCustomSkillSystemPrompt(skill) && !getResolvedCustomSkillUserPrompt(skill)) {
    issues.push(getMsg('custom_workshop.error_prompt_required', 'Prompt is required.'))
  }
  if (skill.type === 'agent' && !normalizeText(skill.apiAddress)) {
    issues.push(
      getMsg('custom_workshop.error_api_address_required', 'Agent type requires an API address.')
    )
  }

  return issues
}

export type CustomSkillOverview = {
  totalCount: number
  categoryCount: number
  agentCount: number
  readyCount: number
  needsAttentionCount: number
  topCategories: string[]
}

export type CustomSkillAttentionItem = {
  skill: CustomSkill
  issues: string[]
}

export const summarizeCustomSkills = (skills: CustomSkill[]): CustomSkillOverview => {
  const categoryCounts = new Map<string, number>()
  let agentCount = 0
  let readyCount = 0

  for (const skill of skills) {
    const category = normalizeText(skill.category)
    if (category) {
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1)
    }

    if (skill.type === 'agent') {
      agentCount += 1
    }

    if (getCustomSkillValidationIssues(skill).length === 0) {
      readyCount += 1
    }
  }

  const topCategories = [...categoryCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category]) => category)
    .slice(0, 3)

  return {
    totalCount: skills.length,
    categoryCount: categoryCounts.size,
    agentCount,
    readyCount,
    needsAttentionCount: skills.length - readyCount,
    topCategories
  }
}

export const getCustomSkillsNeedingAttention = (
  skills: CustomSkill[],
  t?: (key: string, options?: Record<string, unknown>) => string
): CustomSkillAttentionItem[] =>
  skills
    .map((skill) => ({
      skill,
      issues: getCustomSkillValidationIssues(skill, t)
    }))
    .filter(({ issues }) => issues.length > 0)

export type WorkshopMenuItemKind = 'directory' | 'app'

export const getWorkshopMenuItems = (
  items: QAppMenuItem[] | undefined,
  targetType: WorkshopMenuItemKind
): QAppMenuItem[] =>
  (items || []).filter((item) =>
    targetType === 'directory' ? Boolean(item.isDirectory) : !item.isDirectory
  )
