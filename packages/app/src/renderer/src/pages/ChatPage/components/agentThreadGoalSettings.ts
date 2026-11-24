import {
  AGENT_GOAL_LIMITS,
  type AgentGoalAutonomy,
  type AgentGoalCompletionPolicy,
  type AgentGoalSpec
} from '@shared/api/agentThreadGoal'

/** The user's own goal settings (KohakuTerrarium 2.2.3 goal spec): only the user edits them. */
export type AgentThreadGoalSettings = {
  autonomy: AgentGoalAutonomy
  completionPolicy: AgentGoalCompletionPolicy
  /** Form text, checked by goalSettingsBudgets. */
  maxTurns: string
  maxToolCalls: string
  maxWalltimeMinutes: string
}

/** A new goal: manual, confirmed by the user, max turns 10 (the user changes it). */
export const defaultGoalSettings = (): AgentThreadGoalSettings => ({
  autonomy: 'manual',
  completionPolicy: 'user_confirm',
  maxTurns: '10',
  maxToolCalls: '50',
  maxWalltimeMinutes: '60'
})

export const goalSettingsOf = (spec: AgentGoalSpec): AgentThreadGoalSettings => ({
  autonomy: spec.autonomy,
  completionPolicy: spec.completionPolicy,
  maxTurns: String(spec.budgets.maxTurns),
  maxToolCalls: String(spec.budgets.maxToolCalls),
  maxWalltimeMinutes: String(Math.max(1, Math.round(spec.budgets.maxWalltimeSeconds / 60)))
})

export const goalSettingNumber = (value: string, max: number): number | undefined => {
  if (!/^\d{1,7}$/.test(value.trim())) return undefined
  const number = Number(value.trim())
  return number >= 1 && number <= max ? number : undefined
}

/** The budgets the settings ask for, or undefined while one is missing or out of range. */
export function goalSettingsBudgets(
  settings: AgentThreadGoalSettings
): AgentGoalSpec['budgets'] | undefined {
  const maxTurns = goalSettingNumber(settings.maxTurns, AGENT_GOAL_LIMITS.maxTurns)
  const maxToolCalls = goalSettingNumber(settings.maxToolCalls, AGENT_GOAL_LIMITS.maxToolCalls)
  const minutes = goalSettingNumber(
    settings.maxWalltimeMinutes,
    Math.floor(AGENT_GOAL_LIMITS.maxWalltimeSeconds / 60)
  )
  if (maxTurns === undefined || maxToolCalls === undefined || minutes === undefined)
    return undefined
  return { maxTurns, maxToolCalls, maxWalltimeSeconds: minutes * 60 }
}
