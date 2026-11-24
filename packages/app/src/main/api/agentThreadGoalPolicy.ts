import Ajv from 'ajv'
import {
  AGENT_GOAL_LIMITS as LIMITS,
  type AgentGoalBinding, type AgentGoalCollection,
  type AgentGoalMutation, type AgentGoalSpec, type AgentGoalStatus, type AgentModelGoalMutation
} from '@shared/api/agentThreadGoal'

const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum })
const text = (maximum: number) => ({ type: 'string', minLength: 1, maxLength: maximum, pattern: '^[^\\u0000]*$' })
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })
const id = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' }
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const strings = { type: 'array', maxItems: LIMITS.listItems, items: text(LIMITS.listItem) }
const budgets = object({ maxTurns: integer(1, LIMITS.maxTurns), maxToolCalls: integer(1, LIMITS.maxToolCalls), maxWalltimeSeconds: integer(1, LIMITS.maxWalltimeSeconds) })
const specSchema = object({ objective: text(LIMITS.objective), successCriteria: strings, constraints: strings, autonomy: { enum: ['manual', 'continue_when_ready'] }, completionPolicy: { enum: ['user_confirm', 'self_propose', 'verifier'] }, budgets })
const statuses: AgentGoalStatus[] = ['draft', 'active', 'waiting', 'blocked', 'paused', 'cancelled', 'completed', 'failed']
const terminal = (status: AgentGoalStatus) => ['cancelled', 'completed', 'failed'].includes(status)
const report = { summary: text(LIMITS.summary), evidence: strings }
const goalSchema = object({ id, generation: integer(1), title: text(LIMITS.title), spec: specSchema, status: { enum: statuses }, createdAt: integer(), updatedAt: integer(), reason: { type: 'string', maxLength: LIMITS.reason, pattern: '^[^\\u0000]*$' },
  progress: object({ ...report, reportedAt: integer() }), proposal: object({ ...report, outcome: { enum: ['completed', 'failed'] }, proposedAt: integer() })
}, ['id', 'generation', 'title', 'spec', 'status', 'createdAt', 'updatedAt', 'reason'])
const ajv = new Ajv({ strict: true, ownProperties: true })
const validSpec = ajv.compile(specSchema)
const validCollection = ajv.compile(object({ version: { const: 1 }, revision: integer(), goals: { type: 'array', maxItems: LIMITS.goals, items: goalSchema }, retiredIds: { type: 'array', maxItems: LIMITS.retiredIds, uniqueItems: true, items: id }, receipts: { type: 'array', maxItems: LIMITS.receipts, items: object({ operationHash: hash, digest: hash }) } }))
const fields = {
  create: { title: text(LIMITS.title), spec: specSchema }, update: { title: text(LIMITS.title), spec: specSchema },
  control: { status: { enum: statuses.filter(value => !['completed', 'failed'].includes(value)) }, reason: text(LIMITS.reason) },
  report, propose: { ...report, outcome: { enum: ['completed', 'failed'] } },
  confirm: { outcome: { enum: ['completed', 'failed'] } }, 'reject-proposal': {}, delete: {}
}
const commands = new Map(Object.entries(fields).map(([action, properties]) => [action, ajv.compile(object({ action: { const: action }, goalId: id, ...properties, ...(action === 'create' ? {} : { expectedGeneration: integer(1) }), expectedRevision: integer(0, Number.MAX_SAFE_INTEGER - 1), operationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } }))]))
const transitions: Record<AgentGoalStatus, AgentGoalStatus[]> = {
  draft: ['active', 'cancelled'], active: ['waiting', 'blocked', 'paused', 'cancelled'],
  waiting: ['active', 'blocked', 'paused', 'cancelled'], blocked: ['active', 'paused', 'cancelled'],
  paused: ['active', 'cancelled'], cancelled: [], completed: [], failed: []
}
const nonblank = (value: string) => Boolean(value.trim())
const checkSpecText = (spec: AgentGoalSpec) => nonblank(spec.objective) && [...spec.constraints, ...spec.successCriteria].every(nonblank)

/** Unsupported autonomy/completion policies fail, never silently downgrade. */
export function normalizeAgentGoalSpec(value: unknown): AgentGoalSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['objective', 'successCriteria', 'constraints', 'autonomy', 'completionPolicy', 'budgets'].includes(key))) throw new Error('Invalid manual goal specification.')
  const source = value as Partial<AgentGoalSpec>
  // A self-advancing goal never runs on a default budget: its max_turns is the user's own number.
  if (source.autonomy === 'continue_when_ready' && (!source.budgets || typeof source.budgets !== 'object' || !Number.isSafeInteger((source.budgets as { maxTurns?: unknown }).maxTurns))) throw new Error('A goal that continues by itself needs a max turns budget.')
  const spec = { ...source, successCriteria: source.successCriteria === undefined ? [] : source.successCriteria, constraints: source.constraints === undefined ? [] : source.constraints, autonomy: source.autonomy === undefined ? 'manual' : source.autonomy, completionPolicy: source.completionPolicy === undefined ? 'user_confirm' : source.completionPolicy, budgets: source.budgets === undefined ? { maxTurns: 5, maxToolCalls: 50, maxWalltimeSeconds: 300 } : source.budgets }
  if (!validSpec(spec) || !checkSpecText(spec as AgentGoalSpec)) throw new Error('Invalid or unsupported manual goal specification.')
  return { ...structuredClone(spec) as AgentGoalSpec, objective: spec.objective!.trim(), constraints: spec.constraints.map(item => item.trim()), successCriteria: spec.successCriteria.map(item => item.trim()) }
}
export function validateAgentGoalMutation(value: unknown): asserts value is AgentGoalMutation {
  const action = (value as { action?: string } | null)?.action
  if (!action || !commands.get(action)?.(value)) throw new Error('Invalid goal mutation.')
  const req = value as AgentGoalMutation
  if ((req.action === 'create' || req.action === 'update') && (!nonblank(req.title) || !checkSpecText(req.spec)) || req.action === 'control' && !nonblank(req.reason) || (req.action === 'report' || req.action === 'propose') && (!nonblank(req.summary) || !req.evidence.every(nonblank))) throw new Error('Invalid goal mutation text.')
}
export function validateAgentGoalCollection(value: unknown): asserts value is AgentGoalCollection {
  if (!validCollection(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMITS.plainBytes) throw new Error('Invalid bounded goal checkpoint.')
  const doc = value as AgentGoalCollection
  const ids = doc.goals.map(goal => goal.id)
  if (new Set(ids).size !== ids.length || ids.some(value => doc.retiredIds.includes(value)) || new Set(doc.receipts.map(receipt => receipt.operationHash)).size !== doc.receipts.length || (doc.revision === 0 && (doc.goals.length || doc.retiredIds.length || doc.receipts.length)) || (doc.revision > 0 && !doc.receipts.length)) throw new Error('Invalid goal checkpoint identities or receipts.')
  for (const goal of doc.goals) {
    if (!nonblank(goal.title) || !checkSpecText(goal.spec) || goal.updatedAt < goal.createdAt || goal.progress && (!nonblank(goal.progress.summary) || !goal.progress.evidence.every(nonblank) || goal.progress.reportedAt < goal.createdAt || goal.progress.reportedAt > goal.updatedAt) || goal.proposal && (!nonblank(goal.proposal.summary) || !goal.proposal.evidence.length || !goal.proposal.evidence.every(nonblank) || goal.proposal.proposedAt < goal.createdAt || goal.proposal.proposedAt > goal.updatedAt) || ['draft', 'cancelled'].includes(goal.status) && goal.proposal || ['completed', 'failed'].includes(goal.status) && goal.proposal?.outcome !== goal.status) throw new Error('Invalid goal checkpoint semantics.')
  }
}
export const emptyAgentGoalCollection = (): AgentGoalCollection => ({ version: 1, revision: 0, goals: [], retiredIds: [], receipts: [] })

export class AgentGoalRevisionConflict extends Error {
  constructor(readonly currentRevision: number) { super('Goal revision conflict; refresh before a new action.'); this.name = 'AgentGoalRevisionConflict' }
}

/** Internal reducer; role is selected by distinct main APIs, never by a request field. */
function reduce(document: AgentGoalCollection, req: AgentGoalMutation, now: number): AgentGoalCollection {
  validateAgentGoalMutation(req); validateAgentGoalCollection(document)
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid goal clock.')
  if (document.revision !== req.expectedRevision) throw new AgentGoalRevisionConflict(document.revision)
  const next = structuredClone(document), goal = next.goals.find(item => item.id === req.goalId)
  if (req.action === 'create') {
    if (goal || next.retiredIds.includes(req.goalId)) throw new Error('Goal identity already exists or is retired.')
    if (next.goals.length >= LIMITS.goals) throw new Error('Goal capacity reached.')
    next.goals.push({ id: req.goalId, generation: 1, title: req.title.trim(), spec: normalizeAgentGoalSpec(req.spec), status: 'draft', createdAt: now, updatedAt: now, reason: '' })
  } else {
    if (!goal || goal.generation !== req.expectedGeneration) throw new Error('Goal generation conflict or unavailable goal.')
    const timestamp = Math.max(now, goal.updatedAt)
    if (req.action === 'delete') {
      if (!terminal(goal.status) && !['draft', 'paused'].includes(goal.status)) throw new Error('Pause the goal before deleting it.')
      if (next.retiredIds.length >= LIMITS.retiredIds) throw new Error('Goal retirement capacity reached; replay fences were not discarded.')
      next.goals = next.goals.filter(item => item !== goal); next.retiredIds.push(goal.id)
    } else {
      if (terminal(goal.status)) throw new Error('Terminal goal cannot be mutated.')
      if (goal.generation >= Number.MAX_SAFE_INTEGER) throw new Error('Goal generation exhausted.')
      if (req.action === 'update') {
        const spec = normalizeAgentGoalSpec(req.spec), title = req.title.trim()
        // Only autonomy, completion policy or budgets changed (the user's settings): the goal's
        // progress and proposal stay. A new objective, title or criteria starts them over.
        const settingsOnly = title === goal.title && JSON.stringify([spec.objective, spec.successCriteria, spec.constraints]) === JSON.stringify([goal.spec.objective, goal.spec.successCriteria, goal.spec.constraints])
        Object.assign(goal, { title, spec, generation: goal.generation + 1, reason: '' })
        if (!settingsOnly) { delete goal.proposal; delete goal.progress }
      } else if (req.action === 'control') {
        if (!transitions[goal.status].includes(req.status)) throw new Error('Invalid goal state transition.')
        goal.status = req.status; goal.reason = req.reason.trim(); goal.generation++; delete goal.proposal
      } else if (req.action === 'report' || req.action === 'propose') {
        if (!['active', 'waiting', 'blocked'].includes(goal.status)) throw new Error('Goal is not accepting model progress.')
        if (req.action === 'report') goal.progress = { summary: req.summary.trim(), evidence: req.evidence.map(item => item.trim()), reportedAt: timestamp }
        else {
          if (!req.evidence.length) throw new Error('Goal proposal requires evidence, not an assertion.')
          goal.proposal = { outcome: req.outcome, summary: req.summary.trim(), evidence: req.evidence.map(item => item.trim()), proposedAt: timestamp }
          // KohakuTerrarium verify_terminal: self_propose accepts the proposal; verifier accepts it
          // when it carries evidence. user_confirm (the default) waits for the user's confirm.
          const policy = goal.spec.completionPolicy
          if (policy === 'self_propose' || policy === 'verifier' && goal.proposal.evidence.length) {
            goal.status = req.outcome; goal.generation++
            goal.reason = policy === 'self_propose' ? 'Accepted by the self_propose completion policy.' : 'Accepted by the verifier completion policy (evidence present).'
          }
        }
      } else if (req.action === 'confirm') {
        if (goal.proposal?.outcome !== req.outcome) throw new Error('Goal confirmation does not match the current proposal.')
        goal.status = req.outcome; goal.reason = 'User confirmed the current proposal.'; goal.generation++
      } else if (req.action === 'reject-proposal') {
        if (!goal.proposal) throw new Error('Goal has no current proposal.')
        delete goal.proposal; goal.generation++
      }
      goal.updatedAt = timestamp
    }
  }
  // Receipt append/validation is atomic in the store. Leave lifecycle headroom.
  next.revision++
  // Full future receipt growth + all 8 bounded reasons + integer growth fit here.
  // Confirmation retains proposal evidence without duplicating its summary.
  if (['create', 'update', 'report', 'propose'].includes(req.action) && Buffer.byteLength(JSON.stringify(next), 'utf8') > LIMITS.plainBytes - LIMITS.contentHeadroomBytes) throw new Error('Goal content budget reached; lifecycle headroom retained.')
  return next
}
export const applyUserGoalMutation = (document: AgentGoalCollection, req: AgentGoalMutation, now: number): AgentGoalCollection => reduce(document, req, now)
/** MAIN's goal driver only (never a model or renderer request): an active goal is paused (the
 * user stopped its step, like KT's user-interrupt pause) or blocked (its steps kept failing). */
export type AgentSystemGoalMutation = Extract<AgentGoalMutation, { action: 'control' }> & { status: 'paused' | 'blocked' }
export function applySystemGoalMutation(document: AgentGoalCollection, req: AgentSystemGoalMutation, now: number): AgentGoalCollection {
  validateAgentGoalMutation(req)
  if (req.action !== 'control' || !['paused', 'blocked'].includes(req.status)) throw new Error('System goal mutation may only pause or block a goal.')
  const goal = document.goals.find(item => item.id === req.goalId)
  if (goal?.status !== 'active') throw new Error('System goal mutation applies only to an active goal.')
  return reduce(document, req, now)
}
export function applyModelGoalMutation(document: AgentGoalCollection, req: AgentModelGoalMutation, binding: AgentGoalBinding, now: number): AgentGoalCollection {
  validateAgentGoalMutation(req)
  if (!['report', 'propose'].includes(req.action) || !binding || req.goalId !== binding.goalId || req.expectedGeneration !== binding.generation) throw new Error('Model goal mutation is outside its current main-owned binding.')
  return reduce(document, req, now)
}
