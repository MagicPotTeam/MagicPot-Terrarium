import {
  resolveCustomSkillContextMessageLimit,
  type Config,
  type CustomSkill,
  type CustomSkillContextMessageLimit
} from '@shared/config/config'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { isBuiltInTaggingSkillId } from './builtInSkills'
import { resolveSkillRuntimeSpec } from './chatSkillRuntime'

const resolveSkillId = (skill: string | CustomSkill | null | undefined): string | undefined =>
  typeof skill === 'string' ? skill : skill?.id

const resolveIsolatedExecution = (skill: string | CustomSkill | null | undefined): boolean => {
  if (skill && typeof skill !== 'string') {
    return resolveCustomSkillContextMessageLimit(skill.execution) === 0
  }

  return isBuiltInTaggingSkillId(resolveSkillId(skill))
}

const resolveContextMessageLimit = (
  skill: string | CustomSkill | null | undefined
): CustomSkillContextMessageLimit => {
  if (skill && typeof skill !== 'string') {
    return resolveCustomSkillContextMessageLimit(skill.execution)
  }

  return isBuiltInTaggingSkillId(resolveSkillId(skill)) ? 0 : 'all'
}

const resolveShouldPersistSessionUrl = (
  skill: CustomSkill | null | undefined,
  config?: Config | null
): boolean => {
  const contextMessageLimit = resolveCustomSkillContextMessageLimit(skill?.execution)
  if (contextMessageLimit !== 'all') {
    return false
  }

  if (!skill || !config) {
    return !resolveIsolatedExecution(skill?.id)
  }

  const runtime = resolveSkillRuntimeSpec(skill, config)
  return runtime.execution.persistSessionUrl
}

const applyContextMessageLimit = (
  messages: ChatMessage[],
  limit: CustomSkillContextMessageLimit
): ChatMessage[] => {
  if (limit === 'all') return messages
  if (limit === 0) return []
  return messages.slice(-limit)
}

export const shouldIsolateSkillExecution = (
  skill: string | CustomSkill | null | undefined,
  _config?: Config | null
): boolean => resolveIsolatedExecution(skill)

export const resolveSkillExecutionContext = (options: {
  skillId?: string | null | undefined
  skill?: CustomSkill | null | undefined
  config?: Config | null
  sessionMessages: ChatMessage[]
  overrideBaseMessages?: ChatMessage[]
  sessionUrl?: string
}): {
  historyMessages: ChatMessage[]
  sessionUrl?: string
  shouldPersistSessionUrl: boolean
} => {
  const isolatedExecution = resolveIsolatedExecution(options.skill || options.skillId)
  const contextMessageLimit = resolveContextMessageLimit(options.skill || options.skillId)
  const shouldPersistSessionUrl = resolveShouldPersistSessionUrl(options.skill, options.config)

  if (isolatedExecution) {
    return {
      historyMessages: [],
      sessionUrl: undefined,
      shouldPersistSessionUrl: false
    }
  }

  return {
    historyMessages: applyContextMessageLimit(
      options.overrideBaseMessages ?? options.sessionMessages,
      contextMessageLimit
    ),
    sessionUrl: shouldPersistSessionUrl ? options.sessionUrl : undefined,
    shouldPersistSessionUrl
  }
}
