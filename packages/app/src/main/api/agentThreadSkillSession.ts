import { captureAgentSkillScope } from './agentThreadSkillScope'
import type { AgentSkillScope } from '@shared/api/agentThreadSkillSession'
import type { AgentSkillPreferenceReq, AgentSkillSessionList, AgentSkillPreferenceResult, AgentSkillShowReq, AgentSkillUserDetail } from '@shared/api/agentThreadSkillSession'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { getConfig, saveConfig } from '../config/config'
import { loadUserProceduralCatalog } from '../customSkill/catalog'
import { SkillPreferenceRejected, changeSkillPreference, skillPreferenceSnapshot, validateSkillPreferenceRequest } from '../customSkill/sessionPreferences'
import { createAgentThreadSkills } from './agentThreadSkills'
import { agentThreadInteractions } from './agentThreadInteractions'

const registry = () => JSON.stringify(getConfig().llm_config.proceduralSkillPackages ?? [])
const preferences = () => getConfig().llm_config.proceduralSkillSessions
let mutating = false
/** User IPC only; neither provider metadata nor a model tool can change preferences. */
export function userAgentSkillSession(scope: AgentSkillScope, invocation: ServiceInvocationContext | undefined): Promise<AgentSkillSessionList>
export function userAgentSkillSession(scope: AgentSkillScope, invocation: ServiceInvocationContext | undefined, mutation: AgentSkillPreferenceReq): Promise<AgentSkillPreferenceResult>
export async function userAgentSkillSession(scope: AgentSkillScope, invocation: ServiceInvocationContext | undefined, mutation?: AgentSkillPreferenceReq): Promise<AgentSkillPreferenceResult> {
  const method = mutation ? 'setAgentSkillPreference' : 'listAgentSessionSkills'
  const access = captureAgentSkillScope(scope, invocation, method)
  const input = structuredClone(scope)
  if (mutation && (mutation.documentToken !== input.documentToken || mutation.conversationId !== input.conversationId || JSON.stringify(mutation.route) !== JSON.stringify(input.route))) throw new Error('Skill preference mutation scope mismatch.')
  if (mutation) validateSkillPreferenceRequest(mutation)
  const request = mutation ? structuredClone(mutation) : undefined
  if (request && mutating) throw new Error('Procedural skill preference change is busy; retry the same operation.')
  const lease = agentThreadInteractions.createScoped(input, invocation!)
  if (!lease) throw new Error('Procedural skill session requires a live document.')
  if (request) mutating = true
  try {
    const before = JSON.stringify(preferences()), configRegistry = registry()
    const check = () => { access(); lease.assertLive(); if (getConfig().use_remote_llm || registry() !== configRegistry || JSON.stringify(preferences()) !== before) throw new Error('Procedural skill preferences or registration changed during the request.') }
    check()
    // Replays recover the current preference state, never repeat an old transition.
    let change: ReturnType<typeof changeSkillPreference> | undefined
    try { if (request) change = changeSkillPreference(preferences(), request) }
    catch (error) {
      if (!(error instanceof SkillPreferenceRejected) || error.reason !== 'revision-conflict' || !request) throw error
      check()
      // No config write was entered. Revision conflict means this exact retry
      // cannot execute now, not proof that a previous lost response never committed.
      return { status: 'not-applied', operationId: request.operationId, reason: 'revision-conflict', currentRevision: skillPreferenceSnapshot(preferences(), input).revision }
    }
    const reader = createAgentThreadSkills({ signal: lease.signal, assertLive: check, load: async signal => {
      check(); const result = await loadUserProceduralCatalog(getConfig(), input.route.scopeId, signal); check(); return result
    } })
    const catalog = await reader.metadata()
    check()
    if (request && change && !change.replay) {
      const removesExistingDenial = request.enabled && skillPreferenceSnapshot(preferences(), input).disabledIds.includes(request.id)
      if (!removesExistingDenial && !catalog.skills.some(skill => skill.id === request.id)) throw new Error('Procedural skill is not globally enabled for this project; refresh registrations.')
      // Guard is evaluated by the serialized config queue and after temp write,
      // immediately before its synchronous commit. No lost concurrent owner edits.
      await saveConfig({ llm_config: { proceduralSkillSessions: change.records } }, check)
      access(); lease.assertLive()
      if (getConfig().use_remote_llm || registry() !== configRegistry) throw new Error('Procedural skill registration changed after saving; refresh.')
    }
    access(); lease.assertLive()
    const current = skillPreferenceSnapshot(preferences(), input), disabled = new Set(current.disabledIds), known = new Set(catalog.skills.map(skill => skill.id))
    return { revision: current.revision, skills: catalog.skills.map(skill => ({ ...skill, enabled: !disabled.has(skill.id) })), truncated: catalog.truncated, staleDisabledIds: current.disabledIds.filter(id => !known.has(id)), grantsPermission: false }
  } finally { if (request) mutating = false; lease.dispose() }
}

/** Explicit user view may inspect a session-denied definition, never a globally unavailable one. */
export async function showAgentSessionSkill(req: AgentSkillShowReq, invocation?: ServiceInvocationContext): Promise<AgentSkillUserDetail> {
  const input = structuredClone(req), access = captureAgentSkillScope(input, invocation, 'showAgentSessionSkill')
  if (Object.keys(input).some(key => !['route', 'conversationId', 'documentToken', 'name'].includes(key)) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128) throw new Error('Invalid user skill detail request.')
  const lease = agentThreadInteractions.createScoped(input, invocation!)
  if (!lease) throw new Error('User skill detail requires a live document.')
  try {
    const before = JSON.stringify(preferences()), configRegistry = registry()
    const check = () => { access(); lease.assertLive(); if (getConfig().use_remote_llm || registry() !== configRegistry || JSON.stringify(preferences()) !== before) throw new Error('Procedural skill preferences or registration changed during the request.') }
    const reader = createAgentThreadSkills({ signal: lease.signal, assertLive: check, load: async signal => { check(); const result = await loadUserProceduralCatalog(getConfig(), input.route.scopeId, signal); check(); return result } })
    const detail = await reader.describe({ name: input.name })
    check()
    if (!('instructions' in detail)) throw new Error('User skill detail is unavailable.')
    const current = skillPreferenceSnapshot(preferences(), input)
    return { id: detail.id, name: detail.name, description: detail.description, instructions: detail.instructions, baseDirectory: detail.baseDirectory, paths: [...detail.paths], enabled: !current.disabledIds.includes(detail.id), revision: current.revision, untrustedData: true, grantsPermission: false, executed: false }
  } finally { lease.dispose() }
}
