import { createHash } from 'node:crypto'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import { AGENT_SIDE_LIMITS as LIMITS, type AgentSideReq, type AgentSideStartReq, type AgentSideContinueReq, type AgentSideMutationReq, type AgentSideSummary, type AgentSideOpen } from '@shared/api/agentThreadSide'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { authorizeAgentThreadScope } from './agentThreadScope'
import { agentThreadInteractions, type AgentThreadInteractionChannel } from './agentThreadInteractions'
import { getAgentThreadSideStore, type AgentThreadSideStore, type AgentSideDocument } from './agentThreadSideStore'
import { runAgentSideTurn, type SideRunnerDependencies } from './agentThreadSideRunner'

export type SideProfile = SideRunnerDependencies & { profileId: string; profileDigest: string; modelLabel: string; assertCurrent(): void }
export type SideProfileFactory = (profileId: string, scope: AgentThreadInteractionScope, invocation: ServiceInvocationContext, assertLive: () => void) => SideProfile
const identity = (scope: AgentThreadInteractionScope) => JSON.stringify([getAgentSessionKey(normalizeAgentRoute(scope.route)), scope.conversationId])
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validId = (id: unknown) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)
const question = (text: unknown): string => { if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.questionCharacters || text.includes('\0')) throw new Error('Invalid side question.'); return text.trim() }
const operation = (value: unknown): string => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid side operation identity.'); return value }
type ActiveSide = { key: string; sender: number; scope: AgentThreadInteractionScope; doc: AgentSideDocument; controller: AbortController; lease: AgentThreadInteractionChannel; done: Promise<void>; finish(): void; timer: ReturnType<typeof setTimeout> }
/** User-audience only. Never exposed through the parent model's tools or background-job registry. */
export class AgentThreadSides {
  private readonly active = new Map<string, ActiveSide>()
  constructor(private readonly store: () => Promise<AgentThreadSideStore> = getAgentThreadSideStore) {}
  private lease(scope: AgentThreadInteractionScope, invocation: ServiceInvocationContext | undefined, method: string) {
    authorizeAgentThreadScope(scope, invocation, method)
    const lease = agentThreadInteractions.createScoped(scope, invocation!)
    if (!lease) throw new Error('A live trusted document is required for private side conversations.')
    return lease
  }
  private key(scope: AgentThreadInteractionScope, id: string) { if (!validId(id)) throw new Error('Invalid side identity.'); return `${identity(scope)}:${id}` }
  private ownedActive(scope: AgentThreadInteractionScope, id: string, sender: number) {
    const entry = this.active.get(this.key(scope, id))
    if (entry && (entry.sender !== sender || entry.lease.signal.aborted)) throw new Error('This side conversation is busy in another or revoked document.')
    return entry
  }
  private summary(doc: AgentSideDocument, busy: boolean): AgentSideSummary {
    const { id, revision, generation, status, title, createdAt, updatedAt, turns, modelSteps, toolCalls, snapshotTruncated, profileId, modelLabel } = doc
    return { id, revision, generation, status, title, createdAt, updatedAt, turns, modelSteps, toolCalls, snapshotTruncated, profileId, modelLabel, busy,
      canContinue: !busy && turns < LIMITS.turns && modelSteps < LIMITS.stepsPerBranch && toolCalls < LIMITS.readsPerBranch && doc.messages.length + 3 < LIMITS.transcriptMessages && Buffer.byteLength(JSON.stringify(doc.messages)) < LIMITS.transcriptBytes - 40000 }
  }
  private recover(store: AgentThreadSideStore, scope: AgentThreadInteractionScope, doc: AgentSideDocument): AgentSideDocument {
    if (doc.status !== 'running' || this.active.has(this.key(scope, doc.id))) return doc
    // Saved work is history, never authority or automatic resumption after restart.
    return store.save(scope, { ...doc, revision: doc.revision + 1, updatedAt: Date.now(), status: 'interrupted' }, doc.revision)
  }
  async list(scope: AgentThreadInteractionScope, invocation?: ServiceInvocationContext) {
    const lease = this.lease(scope, invocation, 'listAgentSides')
    try {
      const store = await this.store(); lease.assertLive()
      const rows = store.list(scope).flatMap((doc) => {
        const running = this.active.get(this.key(scope, doc.id))
        if (running && (running.sender !== invocation!.senderId || running.lease.signal.aborted)) return []
        return [this.summary(this.recover(store, scope, doc), Boolean(running))]
      })
      lease.assertLive(); return { branches: rows }
    } finally { lease.dispose() }
  }
  async open(req: AgentSideReq, invocation?: ServiceInvocationContext): Promise<AgentSideOpen> {
    const lease = this.lease(req, invocation, 'openAgentSide')
    try {
      const store = await this.store(); lease.assertLive()
      const busy = this.ownedActive(req, req.branchId, invocation!.senderId!), saved = store.read(req, req.branchId)
      if (!saved) throw new Error('Side conversation is unavailable in this conversation.')
      const doc = this.recover(store, req, saved)
      lease.assertLive()
      return { branch: this.summary(doc, Boolean(busy)), messages: structuredClone(doc.messages.filter((message) => ['question', 'answer', 'notice'].includes(message.kind))), snapshotCharacters: doc.snapshot.reduce((sum, message) => sum + message.content.length, 0), untrustedData: true }
    } finally { lease.dispose() }
  }
  async start(req: AgentSideStartReq, invocation: ServiceInvocationContext | undefined, factory: SideProfileFactory): Promise<{ branch: AgentSideSummary }> {
    const lease = this.lease(req, invocation, 'startAgentSide')
    let transferred = false
    try {
      const key = this.key(req, req.branchId), task = question(req.question), op = operation(req.operationId)
      if (typeof req.profileId !== 'string' || !req.profileId.trim() || req.profileId.length > 2048 || !Array.isArray(req.snapshot) || req.snapshot.length > LIMITS.snapshotMessages || req.snapshot.some((m) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > LIMITS.messageCharacters) || req.snapshot.reduce((n, m) => n + m.content.length, 0) > LIMITS.snapshotCharacters) throw new Error('Invalid bounded parent text snapshot or profile.')
      const snapshot = req.snapshot.map((m) => ({ role: m.role, content: m.content })), digest = hash(['start', task, req.profileId, snapshot])
      const store = await this.store(); lease.assertLive()
      this.ownedActive(req, req.branchId, invocation!.senderId!)
      const prior = store.read(req, req.branchId)
      if (prior) {
        const receipt = prior.receipts.find((r) => r.operationId === op)
        if (!receipt || receipt.digest !== digest) throw new Error('Side start replay conflict.')
        return { branch: this.summary(this.recover(store, req, prior), this.active.has(key)) }
      }
      this.capacity(req)
      const profile = factory(req.profileId, req, invocation!, () => lease.assertLive()); profile.assertCurrent(); lease.assertLive()
      const now = Date.now()
      const doc: AgentSideDocument = { version: 1, id: req.branchId, revision: 1, generation: 1, status: 'running', createdAt: now, updatedAt: now, title: task.replace(/\s+/g, ' ').slice(0, 100),
        profileId: profile.profileId, profileDigest: profile.profileDigest, modelLabel: profile.modelLabel, snapshot, snapshotTruncated: true,
        messages: [{ role: 'user', kind: 'question', content: task }], turns: 1, modelSteps: 0, toolCalls: 0, receipts: [{ operationId: op, digest, generation: 1 }] }
      store.save(req, doc, 0)
      this.run(store, req, invocation!.senderId!, doc, lease, profile); transferred = true
      return { branch: this.summary(doc, true) }
    } finally { if (!transferred) lease.dispose() }
  }
  async continue(req: AgentSideContinueReq, invocation: ServiceInvocationContext | undefined, factory: SideProfileFactory): Promise<{ branch: AgentSideSummary }> {
    const lease = this.lease(req, invocation, 'continueAgentSide')
    let transferred = false
    try {
      const task = question(req.question), op = operation(req.operationId), key = this.key(req, req.branchId)
      if (!Number.isSafeInteger(req.expectedRevision) || req.expectedRevision < 1) throw new Error('Invalid side revision.')
      const digest = hash(['continue', task, req.expectedRevision]), store = await this.store(); lease.assertLive()
      const busy = this.ownedActive(req, req.branchId, invocation!.senderId!), prior = store.read(req, req.branchId)
      if (!prior) throw new Error('Side conversation is unavailable.')
      const receipt = prior.receipts.find((r) => r.operationId === op)
      if (receipt) { if (receipt.digest !== digest) throw new Error('Side continuation replay conflict.'); return { branch: this.summary(this.recover(store, req, prior), Boolean(busy)) } }
      if (busy) throw new Error('Side conversation is still running or draining; wait before continuing.')
      if (prior.revision !== req.expectedRevision) throw new Error('Side revision conflict; reopen before continuing.')
      if (!this.summary(prior, false).canContinue) throw new Error('Side lifetime budget exhausted; start a new branch explicitly.')
      this.capacity(req)
      const profile = factory(prior.profileId, req, invocation!, () => lease.assertLive()); profile.assertCurrent(); lease.assertLive()
      if (profile.profileDigest !== prior.profileDigest || profile.profileId !== prior.profileId) throw new Error('Saved side profile changed; start a new branch explicitly.')
      const doc: AgentSideDocument = { ...prior, status: 'running', revision: prior.revision + 1, generation: prior.generation + 1, turns: prior.turns + 1, updatedAt: Date.now(), messages: [...prior.messages, { role: 'user', kind: 'question', content: task }], receipts: [...prior.receipts, { operationId: op, digest, generation: prior.generation + 1 }].slice(-LIMITS.receipts) }
      store.save(req, doc, prior.revision)
      this.run(store, req, invocation!.senderId!, doc, lease, profile); transferred = true
      return { branch: this.summary(doc, this.active.has(key)) }
    } finally { if (!transferred) lease.dispose() }
  }
  private capacity(scope: AgentThreadInteractionScope) {
    if (this.active.size >= LIMITS.activeGlobal || [...this.active.values()].filter((entry) => identity(entry.scope) === identity(scope)).length >= LIMITS.activePerScope) throw new Error('Private side conversation concurrency limit reached.')
  }
  private run(store: AgentThreadSideStore, scope: AgentThreadInteractionScope, sender: number, doc: AgentSideDocument, lease: AgentThreadInteractionChannel, profile: SideProfile) {
    const key = this.key(scope, doc.id), controller = new AbortController(), signal = AbortSignal.any([controller.signal, lease.signal])
    let finish!: () => void
    const entry: ActiveSide = { key, sender, scope: structuredClone(scope), doc, lease, controller, done: new Promise<void>((resolve) => { finish = resolve }), finish: () => finish(), timer: setTimeout(() => controller.abort(new Error('Side time limit exceeded.')), LIMITS.timeoutMs) }
    this.active.set(key, entry)
    const checkpoint = (next: AgentSideDocument) => {
      if (this.active.get(key) !== entry || next.generation !== entry.doc.generation) throw new Error('Stale side generation.')
      const expected = entry.doc.revision
      next.revision = expected + 1; next.updatedAt = Date.now()
      try { store.save(scope, next, expected); entry.doc = next }
      catch (error) { next.revision = expected; controller.abort(new Error('Side checkpoint failed.')); throw error }
    }
    // Always observe late rejections; do not free active slots merely because abort was requested.
    void (async () => {
      try { await runAgentSideTurn(doc, { ...profile, signal, assertLive: () => { lease.assertLive(); profile.assertCurrent() }, checkpoint }) }
      catch { doc.status = signal.aborted ? 'stopped' : 'failed'; try { checkpoint(doc) } catch { /* Recovery exposes interrupted, never successful. */ } }
      finally { clearTimeout(entry.timer); if (this.active.get(key) === entry) this.active.delete(key); entry.finish(); lease.dispose() }
    })()
  }
  async stop(req: AgentSideMutationReq, invocation?: ServiceInvocationContext) {
    const lease = this.lease(req, invocation, 'stopAgentSide')
    try {
      const store = await this.store(); lease.assertLive()
      const active = this.ownedActive(req, req.branchId, invocation!.senderId!), doc = store.read(req, req.branchId)
      if (!doc || doc.revision !== req.expectedRevision) throw new Error('Side revision conflict; reopen before stopping.')
      if (active) active.controller.abort(new Error('User stopped private side turn.'))
      const current = active ? { ...active.doc, status: 'stopped' as const } : this.recover(store, req, doc)
      return { branch: this.summary(current, Boolean(active)) }
    } finally { lease.dispose() }
  }
  async delete(req: AgentSideMutationReq, invocation?: ServiceInvocationContext): Promise<void> {
    const lease = this.lease(req, invocation, 'deleteAgentSide')
    try { const store = await this.store(); lease.assertLive(); if (this.ownedActive(req, req.branchId, invocation!.senderId!)) throw new Error('Stop and wait for the side turn to settle before deleting.'); store.delete(req, req.branchId, req.expectedRevision) }
    finally { lease.dispose() }
  }
  async dispose() { const active = [...this.active.values()]; for (const entry of active) entry.controller.abort(); await Promise.all(active.map((entry) => entry.done)) }
}
export const agentThreadSides = new AgentThreadSides()
