import Ajv from 'ajv'
import { createHash } from 'node:crypto'
import { applyDispatchLedger, DISPATCH_LEDGER_LIMITS as L, emptyDispatchLedger, validateDispatchLedger, type DispatchLedgerBinding, type DispatchLedgerCommand, type DispatchLedgerDocument, type DispatchLedgerOperationReceipt } from './providerDispatchLedgerPolicy'
import type { ProviderDispatchReceipt } from './providerDispatchFetch'

/** Pure v2 DATA policy, not an execution adapter. The version-aware store may
 * persist/inspect it; the production factory exposes NO v2 writes or automatic
 * upgrade, and no model/tool invocation capability is supplied here. Same owner,
 * envelope and database; reads MUST NOT migrate. Legacy usage is unmeasured. */
export type InvocationUnit = 'modelStep' | 'toolInvocation' | 'providerDispatch'
export type InvocationOutcome = { state: 'not-started' | 'completed' | 'failed' | 'unknown'; charged: true; grantsPermission: false }
export type InvocationLimits = { maxModelSteps: number; maxToolInvocations: number; maxProviderDispatches: number }
export type InvocationRecord = { id: string; unit: InvocationUnit; parentId?: string; reservedAt: number; settledAt?: number; outcome?: InvocationOutcome | ProviderDispatchReceipt }
export type InvocationRun = {
  id: string; binding: DispatchLedgerBinding; status: 'active' | 'finished' | 'unknown'
  startedAt: number; updatedAt: number; deadlineAt: number; limits: InvocationLimits
  charged: Record<InvocationUnit, number>; units: InvocationRecord[]
}
export type InvocationCommand = { operationId: string; expectedRevision: number; runId: string } & (
  | { action: 'begin-v2'; binding: DispatchLedgerBinding; limits: InvocationLimits; maxWalltimeMs: number }
  | { action: 'reserve-unit'; unitId: string; unit: InvocationUnit; parentId?: string }
  | { action: 'settle-unit'; unitId: string; outcome: InvocationOutcome | ProviderDispatchReceipt }
  | { action: 'finish-v2' | 'orphan-v2' }
)
export type InvocationUpgradeCommand = { action: 'upgrade-v2'; operationId: string; expectedRevision: number }
type UpgradeReceipt = { action: 'upgrade-v2'; operationHash: string; digest: string; revision: number; at: number }
type InvocationReceipt = { action: InvocationCommand['action']; operationHash: string; digest: string; revision: number; at: number; runId: string; unitId?: string; unit?: InvocationUnit; parentId?: string; begin?: { binding: DispatchLedgerBinding; limits: InvocationLimits; maxWalltimeMs: number }; outcome?: InvocationOutcome | ProviderDispatchReceipt }
export type InvocationLedgerDocument = {
  version: 2; ownerHash: string; revision: number
  /** Retained verbatim: original runs, operation digests, receipts and counters. */
  legacy: DispatchLedgerDocument; upgrade?: UpgradeReceipt
  runs: InvocationRun[]; receipts: InvocationReceipt[]
}
export type InvocationLedgerCommand = InvocationCommand | InvocationUpgradeCommand | DispatchLedgerCommand
export type InvocationLedgerResult = { document: InvocationLedgerDocument; receipt: InvocationReceipt | UpgradeReceipt | DispatchLedgerOperationReceipt; replay: boolean; grantsPermission: false }
const fail = (why: string): never => { throw new Error(`Invocation ledger ${why}.`) }
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  return value
}
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
// v2 commits independently retained bounded payloads, not mutable final records.
// The operation ID stays private: its owner-bound hash is part of the commitment.
// This detects inconsistent corruption, not hostile rehashing or old-DB rollback.
const digestV2 = (command: InvocationCommand | InvocationUpgradeCommand, operationHash: string, at: number) => {
  const { operationId: _operationId, ...payload } = command
  return sha(canonical({ operationHash, at, payload }))
}
const receiptCommand = (item: InvocationReceipt): InvocationCommand => ({ action: item.action, operationId: '00000000-0000-4000-8000-000000000000', expectedRevision: item.revision - 1, runId: item.runId, ...(item.begin ?? {}), ...(item.unitId ? { unitId: item.unitId } : {}), ...(item.unit ? { unit: item.unit } : {}), ...(item.parentId ? { parentId: item.parentId } : {}), ...(item.outcome ? { outcome: item.outcome } : {}) } as InvocationCommand)
const plainSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum: min, maximum: max })
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' }, hash = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const unit = { enum: ['modelStep', 'toolInvocation', 'providerDispatch'] }
const binding = object({ goalId: uuid, generation: integer(1), profileHash: hash })
const limits = object({ maxModelSteps: integer(1, 32), maxToolInvocations: integer(0, 32), maxProviderDispatches: integer(1, 32) })
const invocationOutcome = object({ state: { enum: ['not-started', 'completed', 'failed', 'unknown'] }, charged: { const: true }, grantsPermission: { const: false } })
const dispatchOutcome = { oneOf: [object({ state: { enum: ['not-dispatched', 'unknown'] }, charged: { const: true }, grantsPermission: { const: false } }), object({ state: { const: 'response-complete' }, status: integer(200, 599), responseBytes: integer(0, L.responseBytes), charged: { const: true }, grantsPermission: { const: false } })] }
const outcome = { anyOf: [invocationOutcome, dispatchOutcome] }
const record = object({ id: uuid, unit, parentId: uuid, reservedAt: integer(), settledAt: integer(), outcome }, ['id', 'unit', 'reservedAt'])
const run = object({ id: uuid, binding, status: { enum: ['active', 'finished', 'unknown'] }, startedAt: integer(), updatedAt: integer(), deadlineAt: integer(), limits, charged: object({ modelStep: integer(0, 32), toolInvocation: integer(0, 32), providerDispatch: integer(0, 32) }), units: { type: 'array', maxItems: 96, items: record } })
const receipt = object({ action: { enum: ['begin-v2', 'reserve-unit', 'settle-unit', 'finish-v2', 'orphan-v2'] }, operationHash: hash, digest: hash, revision: integer(1, L.receipts), at: integer(), runId: uuid, unitId: uuid, unit, parentId: uuid, begin: object({ binding, limits, maxWalltimeMs: integer(1, L.maxWalltimeMs) }), outcome }, ['action', 'operationHash', 'digest', 'revision', 'at', 'runId'])
const upgradeReceipt = object({ action: { const: 'upgrade-v2' }, operationHash: hash, digest: hash, revision: integer(1, L.receipts), at: integer() })
const ajv = new Ajv({ strict: true, ownProperties: true })
const documentSchema = ajv.compile(object({ version: { const: 2 }, ownerHash: hash, revision: integer(0, L.receipts), legacy: { type: 'object' }, upgrade: upgradeReceipt, runs: { type: 'array', maxItems: L.runs, items: run }, receipts: { type: 'array', maxItems: L.receipts, items: receipt } }, ['version', 'ownerHash', 'revision', 'legacy', 'runs', 'receipts']))
const invocationValid = ajv.compile(invocationOutcome), dispatchValid = ajv.compile(dispatchOutcome)
const upgradeValid = ajv.compile(object({ action: { const: 'upgrade-v2' }, operationId: uuid, expectedRevision: integer(0, L.receipts - 1) }))
const properties = { 'begin-v2': { binding, limits, maxWalltimeMs: integer(1, L.maxWalltimeMs) }, 'reserve-unit': { unitId: uuid, unit, parentId: uuid }, 'settle-unit': { unitId: uuid, outcome }, 'finish-v2': {}, 'orphan-v2': {} }
const commands = new Map(Object.entries(properties).map(([action, fields]) => [action, ajv.compile(object({ action: { const: action }, operationId: uuid, expectedRevision: integer(0, L.receipts - 1), runId: uuid, ...fields }, ['action', 'operationId', 'expectedRevision', 'runId', ...Object.keys(fields).filter(key => key !== 'parentId')]))]))
const pending = (run: InvocationRun) => run.units.filter(item => !item.outcome)
const ceiling = (run: InvocationRun, kind: InvocationUnit) => run.limits[kind === 'modelStep' ? 'maxModelSteps' : kind === 'toolInvocation' ? 'maxToolInvocations' : 'maxProviderDispatches']
const lastTime = (document: InvocationLedgerDocument) => document.receipts.at(-1)?.at ?? document.upgrade?.at ?? document.legacy.runs.at(-1)?.updatedAt ?? 0
const usedIds = (document: InvocationLedgerDocument) => new Set([...document.legacy.runs.flatMap(item => [item.id, ...item.attempts.map(attempt => attempt.id)]), ...document.runs.flatMap(item => [item.id, ...item.units.map(unit => unit.id)])])
function reserve(run: InvocationRun, command: Extract<InvocationCommand, { action: 'reserve-unit' }>, at: number): void {
  if (at >= run.deadlineAt || run.charged[command.unit] >= ceiling(run, command.unit)) fail('deadline or unit budget exhausted')
  const active = pending(run), lastModel = run.units.findLast(item => item.unit === 'modelStep')
  if (command.unit === 'modelStep') { if (active.length || command.parentId) fail('model admission overlaps a pending unit or has a parent') }
  else if (command.unit === 'providerDispatch') {
    if (active.length !== 1 || active[0].unit !== 'modelStep' || command.parentId !== active[0].id) fail('dispatch must be the sole child of the exact pending model')
  } else if (active.length || !lastModel || lastModel.outcome?.state !== 'completed' || command.parentId !== lastModel.id) fail('tool requires an exact completed model and no pending unit')
  run.units.push({ id: command.unitId, unit: command.unit, ...(command.parentId ? { parentId: command.parentId } : {}), reservedAt: at }); run.charged[command.unit]++; run.updatedAt = at
}
function settle(run: InvocationRun, id: string, outcome: InvocationOutcome | ProviderDispatchReceipt, at: number): void {
  const current = run.units.find(item => item.id === id)
  if (!current || current.outcome) fail('unit is not pending')
  const record = current!
  if (!(record.unit === 'providerDispatch' ? dispatchValid(outcome) : invocationValid(outcome)) || outcome.state === 'response-complete' && outcome.status >= 300 && outcome.status < 400) fail('outcome does not match its unit or redirects are unsupported')
  if (record.unit === 'modelStep' && outcome.state !== 'unknown' && pending(run).some(item => item.id !== id)) fail('model cannot settle before its child')
  if (outcome.state === 'not-started' && run.units.some(item => item.parentId === id)) fail('model with child dispatches cannot be called not-started')
  if (outcome.state === 'unknown') {
    // One atomic receipt closes BOTH child and parent. Later parent cleanup must
    // recognize this exact state as data, never issue another settlement/permit.
    for (const item of pending(run)) { item.outcome = { state: 'unknown', charged: true, grantsPermission: false }; item.settledAt = at }
    run.status = 'unknown'
  } else { record.outcome = structuredClone(outcome); record.settledAt = at }
  run.updatedAt = at
}
function close(run: InvocationRun, orphan: boolean, at: number): void {
  if (!orphan && pending(run).length) fail('pending units prevent finish')
  if (orphan) for (const item of pending(run)) { item.outcome = { state: 'unknown', charged: true, grantsPermission: false }; item.settledAt = at }
  run.status = orphan ? 'unknown' : 'finished'; run.updatedAt = at
}
export function emptyInvocationLedger(ownerHash: string): InvocationLedgerDocument {
  const document: InvocationLedgerDocument = { version: 2, ownerHash, revision: 0, legacy: emptyDispatchLedger(ownerHash), runs: [], receipts: [] }
  validateInvocationLedger(document); return document
}
export function validateInvocationLedger(value: unknown): asserts value is InvocationLedgerDocument {
  if (!documentSchema(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > L.plainBytes) fail('schema or byte capacity invalid')
  const doc = value as InvocationLedgerDocument
  validateDispatchLedger(doc.legacy)
  if (doc.legacy.ownerHash !== doc.ownerHash || doc.legacy.runs.some(item => item.status !== 'finished') || doc.legacy.runs.length + doc.runs.length > L.runs) fail('legacy owner, uncertainty or retained run limit invalid')
  if (doc.upgrade ? doc.upgrade.revision !== doc.legacy.revision + 1 || doc.upgrade.at < (doc.legacy.runs.at(-1)?.updatedAt ?? 0) : doc.legacy.revision !== 0 || doc.legacy.runs.length !== 0) fail('explicit upgrade history missing or invalid')
  if (doc.upgrade && doc.upgrade.digest !== digestV2({ action: 'upgrade-v2', expectedRevision: doc.legacy.revision, operationId: '' }, doc.upgrade.operationHash, doc.upgrade.at)) fail('upgrade payload commitment invalid')
  const base = doc.legacy.revision + (doc.upgrade ? 1 : 0), hashes = [...doc.legacy.receipts.map(item => item.operationHash), ...(doc.upgrade ? [doc.upgrade.operationHash] : []), ...doc.receipts.map(item => item.operationHash)]
  if (doc.revision !== base + doc.receipts.length || new Set(hashes).size !== hashes.length || hashes.length !== doc.revision) fail('receipt history or operation identity invalid')
  const allIds = [...doc.legacy.runs.flatMap(item => [item.id, ...item.attempts.map(attempt => attempt.id)]), ...doc.runs.flatMap(item => [item.id, ...item.units.map(unit => unit.id)])]
  if (new Set(allIds).size !== allIds.length) fail('retained run/unit identity reused')
  const reconstructed: InvocationRun[] = []
  let active: InvocationRun | undefined, fenced = false, time = doc.upgrade?.at ?? doc.legacy.runs.at(-1)?.updatedAt ?? 0
  for (const [index, item] of doc.receipts.entries()) {
    const original = receiptCommand(item)
    if (!commands.get(original.action)?.(original) || Boolean(item.begin) !== (item.action === 'begin-v2') || Boolean(item.outcome) !== (item.action === 'settle-unit') || item.digest !== digestV2(original, item.operationHash, item.at)) fail('receipt payload commitment invalid')
    if (item.revision !== base + index + 1 || item.at < time) fail('receipt chronology invalid')
    time = item.at
    if (item.action === 'begin-v2') {
      if (active || fenced || reconstructed.some(run => run.id === item.runId) || item.unitId || item.unit || item.parentId) fail('overlapping, uncertain or malformed begin')
      const admitted = item.begin!
      if (item.at > Number.MAX_SAFE_INTEGER - admitted.maxWalltimeMs) fail('original deadline overflow')
      const total = admitted.limits.maxModelSteps + admitted.limits.maxToolInvocations + admitted.limits.maxProviderDispatches
      if (item.revision - 1 + 2 + 2 * total > L.receipts) fail('begin receipt admits limits beyond retained capacity')
      active = { id: item.runId, binding: structuredClone(admitted.binding), status: 'active', startedAt: item.at, updatedAt: item.at, deadlineAt: item.at + admitted.maxWalltimeMs, limits: structuredClone(admitted.limits), charged: { modelStep: 0, toolInvocation: 0, providerDispatch: 0 }, units: [] }; reconstructed.push(active)
    } else {
      if (!active || active.id !== item.runId || active.status !== 'active') fail('receipt before begin or after terminal')
      const current = active!
      if (item.action === 'reserve-unit') {
        if (!item.unitId || !item.unit) fail('reserve identity missing')
        reserve(current, { action: 'reserve-unit', operationId: '', expectedRevision: item.revision - 1, runId: item.runId, unitId: item.unitId!, unit: item.unit!, ...(item.parentId ? { parentId: item.parentId } : {}) }, item.at)
      } else if (item.action === 'settle-unit') {
        if (!item.unitId || item.unit || item.parentId) fail('settle identity invalid')
        settle(current, item.unitId!, item.outcome!, item.at)
      } else { if (item.unitId || item.unit || item.parentId) fail('closure identity invalid'); close(current, item.action === 'orphan-v2', item.at) }
      if (current.status !== 'active') { fenced = current.status === 'unknown'; active = undefined }
    }
    if (active && item.revision + pending(active).length + 1 > L.receipts) fail('historical pending settlement headroom invalid')
    const bytes = plainSize({ ...doc, revision: item.revision, runs: reconstructed, receipts: doc.receipts.slice(0, index + 1) })
    // Admission reserves 16 KiB. Known settlements may consume it while leaving
    // 2 KiB per remaining frame plus 1 KiB for closure (bounded payloads only).
    const headroom = ['begin-v2', 'reserve-unit'].includes(item.action) ? L.settlementHeadroom : active ? pending(active).length * 2048 + 1024 : 0
    if (bytes > L.plainBytes - headroom) fail('historical admission/settlement byte headroom invalid')
  }
  if (!equal(reconstructed, doc.runs)) fail('records do not match retained transition receipts')
}
/** Explicit conversion data only. No automatic-on-read upgrade, history rewrite,
 * owner acquisition or permit. Full/uncertain v1 documents cannot be reset here. */
export function upgradeInvocationLedger(source: DispatchLedgerDocument, input: InvocationUpgradeCommand, now: number): InvocationLedgerResult {
  const legacy = structuredClone(source), command = structuredClone(input)
  validateDispatchLedger(legacy)
  if (!upgradeValid(command) || command.expectedRevision !== legacy.revision || !Number.isSafeInteger(now) || now < (legacy.runs.at(-1)?.updatedAt ?? 0) || legacy.runs.some(run => run.status !== 'finished') || legacy.revision >= L.receipts) fail('explicit upgrade is unavailable')
  const document: InvocationLedgerDocument = { version: 2, ownerHash: legacy.ownerHash, revision: legacy.revision + 1, legacy: structuredClone(legacy), upgrade: { action: 'upgrade-v2', operationHash: sha([legacy.ownerHash, command.operationId]), digest: digestV2(command, sha([legacy.ownerHash, command.operationId]), now), revision: legacy.revision + 1, at: now }, runs: [], receipts: [] }
  validateInvocationLedger(document)
  return { document, receipt: structuredClone(document.upgrade!), replay: false, grantsPermission: false }
}
/** All output is accounting DATA. An exact replay never means execute again. */
export function applyInvocationLedger(source: InvocationLedgerDocument, input: InvocationLedgerCommand, now: number): InvocationLedgerResult {
  const document = structuredClone(source), command = structuredClone(input)
  validateInvocationLedger(document)
  if (['begin', 'reserve', 'settle', 'finish', 'orphan'].includes(command?.action)) {
    // Retained v1 receipts keep their exact original digest and revision. No new
    // v1 operations may write into the upgraded history, even after old finish.
    const old = applyDispatchLedger(document.legacy, command as DispatchLedgerCommand, now)
    if (!old.replay) fail('fresh legacy operation is forbidden after upgrade')
    return { document: structuredClone(document), receipt: old.receipt, replay: true, grantsPermission: false }
  }
  if (command?.action === 'upgrade-v2') {
    if (!upgradeValid(command) || !document.upgrade || document.upgrade.operationHash !== sha([document.ownerHash, command.operationId]) || document.upgrade.digest !== digestV2(command, document.upgrade.operationHash, document.upgrade.at) || document.upgrade.revision !== command.expectedRevision + 1) fail('upgrade replay conflict')
    return { document: structuredClone(document), receipt: structuredClone(document.upgrade!), replay: true, grantsPermission: false }
  }
  const request = command as InvocationCommand
  if (!commands.get(request?.action)?.(request)) fail('command invalid')
  const operationHash = sha([document.ownerHash, request.operationId]), prior = document.receipts.find(item => item.operationHash === operationHash)
  const digest = digestV2(request, operationHash, prior?.at ?? now)
  if (prior) {
    if (prior.digest !== digest || prior.revision !== request.expectedRevision + 1 || prior.action !== request.action || prior.runId !== request.runId || prior.unitId !== ('unitId' in request ? request.unitId : undefined) || prior.unit !== (request.action === 'reserve-unit' ? request.unit : undefined) || prior.parentId !== (request.action === 'reserve-unit' ? request.parentId : undefined)) fail('operation replay conflict')
    return { document: structuredClone(document), receipt: structuredClone(prior), replay: true, grantsPermission: false }
  }
  if (document.legacy.receipts.some(item => item.operationHash === operationHash) || document.upgrade?.operationHash === operationHash) fail('operation identity conflicts with retained legacy or upgrade history')
  if (request.expectedRevision !== document.revision || !Number.isSafeInteger(now) || now < lastTime(document) || document.revision >= L.receipts) fail('clock, revision or receipt capacity invalid')
  const next = structuredClone(document)
  let current = next.runs.find(item => item.id === request.runId)
  if (request.action === 'begin-v2') {
    if (usedIds(next).has(request.runId) || next.runs.some(run => run.status !== 'finished') || next.legacy.runs.length + next.runs.length >= L.runs || now > Number.MAX_SAFE_INTEGER - request.maxWalltimeMs) fail('run is unavailable or lifetime capacity exhausted')
    const total = request.limits.maxProviderDispatches + request.limits.maxModelSteps + request.limits.maxToolInvocations
    if (next.revision + 2 + 2 * total > L.receipts) fail('requested units exceed retained receipt capacity')
    current = { id: request.runId, binding: structuredClone(request.binding), status: 'active', startedAt: now, updatedAt: now, deadlineAt: now + request.maxWalltimeMs, limits: structuredClone(request.limits), charged: { modelStep: 0, toolInvocation: 0, providerDispatch: 0 }, units: [] }; next.runs.push(current)
  } else {
    if (!current || current.status !== 'active') fail('run is unavailable or uncertain')
    if (request.action === 'reserve-unit') { if (usedIds(next).has(request.unitId)) fail('unit identity reused'); reserve(current!, request, now) }
    else if (request.action === 'settle-unit') settle(current!, request.unitId, request.outcome, now)
    else close(current!, request.action === 'orphan-v2', now)
  }
  next.revision++
  const receipt: InvocationReceipt = { action: request.action, operationHash, digest, revision: next.revision, at: now, runId: request.runId, ...('unitId' in request ? { unitId: request.unitId } : {}), ...(request.action === 'reserve-unit' ? { unit: request.unit, ...(request.parentId ? { parentId: request.parentId } : {}) } : {}), ...(request.action === 'begin-v2' ? { begin: { binding: structuredClone(request.binding), limits: structuredClone(request.limits), maxWalltimeMs: request.maxWalltimeMs } } : {}), ...(request.action === 'settle-unit' ? { outcome: structuredClone(request.outcome) } : {}) }
  next.receipts.push(receipt); validateInvocationLedger(next)
  return { document: next, receipt: structuredClone(receipt), replay: false, grantsPermission: false }
}
