import type { PolicyActorRef } from './policy'

export type MagicAgentConfigContent = Readonly<{
  version: string
  definitionId: string
  model: Readonly<{ profileId: string }>
  systemPrompt: string
  inference: Readonly<{ temperature?: number; maxTokens?: number; maxToolIterations?: number }>
  tools: Readonly<{ allowedToolNames: readonly string[] }>
  memory: Readonly<{
    allowHistory: boolean
    contextMessageLimit: number
    scope: 'instance' | 'session' | 'workspace'
  }>
  policy: Readonly<{ policyIds: readonly string[]; workspaceRoots: readonly string[] }>
  channels: Readonly<{ channelIds: readonly string[] }>
  budgets: Readonly<{
    maxRuntimeMs: number
    maxTurns?: number
    maxTokens?: number
    maxToolCalls?: number
  }>
  createdAt: number
  createdBy: PolicyActorRef
  contentDigest: string
}>

export type MagicAgentConfigPrivilegeChange = 'reduction' | 'equivalent' | 'expansion'

const added = (before: readonly string[], after: readonly string[]) =>
  after.some((value) => !before.includes(value))
const increased = (before: number | undefined, after: number | undefined) =>
  before === undefined ? false : after === undefined || after > before

export const classifyMagicAgentConfigPrivilegeChange = (
  before: MagicAgentConfigContent,
  after: MagicAgentConfigContent
): MagicAgentConfigPrivilegeChange => {
  if (
    added(before.tools.allowedToolNames, after.tools.allowedToolNames) ||
    added(before.policy.policyIds, after.policy.policyIds) ||
    added(before.policy.workspaceRoots, after.policy.workspaceRoots) ||
    added(before.channels.channelIds, after.channels.channelIds) ||
    (!before.memory.allowHistory && after.memory.allowHistory) ||
    after.memory.contextMessageLimit > before.memory.contextMessageLimit ||
    (before.memory.scope === 'instance' && after.memory.scope !== 'instance') ||
    (before.memory.scope === 'session' && after.memory.scope === 'workspace') ||
    increased(before.budgets.maxRuntimeMs, after.budgets.maxRuntimeMs) ||
    increased(before.budgets.maxTurns, after.budgets.maxTurns) ||
    increased(before.budgets.maxTokens, after.budgets.maxTokens) ||
    increased(before.budgets.maxToolCalls, after.budgets.maxToolCalls)
  )
    return 'expansion'

  if (
    added(after.tools.allowedToolNames, before.tools.allowedToolNames) ||
    added(after.policy.policyIds, before.policy.policyIds) ||
    added(after.policy.workspaceRoots, before.policy.workspaceRoots) ||
    added(after.channels.channelIds, before.channels.channelIds) ||
    (before.memory.allowHistory && !after.memory.allowHistory) ||
    after.memory.contextMessageLimit < before.memory.contextMessageLimit ||
    increased(after.budgets.maxRuntimeMs, before.budgets.maxRuntimeMs) ||
    increased(after.budgets.maxTurns, before.budgets.maxTurns) ||
    increased(after.budgets.maxTokens, before.budgets.maxTokens) ||
    increased(after.budgets.maxToolCalls, before.budgets.maxToolCalls)
  )
    return 'reduction'
  return 'equivalent'
}
