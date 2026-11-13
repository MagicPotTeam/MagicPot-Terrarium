import type { HtmlCheckpoint } from './agentThreadHtmlStore'
import { createHash, randomUUID } from 'node:crypto'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import type { AgentHtmlApp, AgentHtmlReq, AgentHtmlSaveReq, AgentHtmlSaved, AgentHtmlSavedReq, AgentHtmlRestoreReq, AgentHtmlScope } from '@shared/api/agentThreadHtml'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { getAgentSessionKey } from '@shared/agent'
import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import { agentThreadInteractions, type AgentThreadInteractionChannel } from './agentThreadInteractions'
import { captureAgentHtmlScope } from './agentThreadHtmlScope'
import { authorizeAgentThreadScope } from './agentThreadScope'
import { openHtmlProcess, type IsolatedHtmlProcess } from './agentThreadHtmlProcess'
import { validateHtmlHostDocument, type HtmlAppDocument, type HtmlAppEvent, type HtmlAppState } from './agentThreadHtmlHost'
const key = (scope: AgentThreadInteractionScope) => JSON.stringify([getAgentSessionKey(scope.route), scope.conversationId])
type Entry = { scope: AgentThreadInteractionScope; sender: number; view: AgentHtmlApp; document: HtmlAppDocument; lease: AgentThreadInteractionChannel; controller: AbortController; process?: IsolatedHtmlProcess; operation?: Promise<unknown>; timer: ReturnType<typeof setTimeout>; events: HtmlAppEvent[]; droppedEvents: number; reportedDrops: number; waiters: Set<() => void>; seen: Map<object, number>; closing?: Promise<void>; pendingRevision?: number; waiting?: object; lastState?: HtmlAppState }
const sha = (html: string) => createHash('sha256').update(html).digest('hex')
const checkpointView = (document: HtmlCheckpoint): AgentHtmlSaved => ({ id: document.id, title: document.title, storageRevision: document.storageRevision, documentRevision: document.documentRevision, createdAt: document.createdAt, updatedAt: document.updatedAt, sha256: sha(document.html), htmlBytes: Buffer.byteLength(document.html), surface: document.surface })
const ownerHash = (scope: AgentThreadInteractionScope) => createHash('sha256').update(key(scope)).digest('hex')
const savedReq = (req: AgentHtmlSavedReq) => { if (!req || typeof req.savedId !== 'string' || !/^[a-f0-9-]{36}$/.test(req.savedId) || !Number.isSafeInteger(req.expectedStorageRevision) || req.expectedStorageRevision < 1) throw new Error('Invalid saved HTML request.') }
/** Documents live in main memory, never as model HTML in the privileged chat renderer. */
export class AgentThreadHtmlApps {
  private readonly entries = new Map<string, Entry>()
  private readonly restoreReceipts = new Map<string, { digest: string; appId: string }>()
  constructor(private readonly launch?: typeof openHtmlProcess) {}
  private owned(scope: AgentThreadInteractionScope, invocation: ServiceInvocationContext, method: string): Entry[] {
    const sender = authorizeAgentThreadScope(scope, invocation, method)
    return [...this.entries.values()].filter(entry => {
      if (entry.sender !== sender || key(entry.scope) !== key(scope)) return false
      try { entry.lease.assertLive(); return true } catch { return false }
    })
  }
  private find(req: AgentThreadInteractionScope & { appId: string }, invocation: ServiceInvocationContext, method: string) {
    const entry = this.owned(req, invocation, method).find(entry => entry.view.id === req.appId)
    if (!entry) throw new Error('HTML app is unavailable in this document/thread/conversation.')
    return entry
  }
  private notify(entry: Entry) { for (const wake of [...entry.waiters]) wake() }
  async invoke(input: Record<string, unknown>, request: LLMChatReq, invocation: ServiceInvocationContext, owner: object, signal: AbortSignal, assertLive: () => void, retain: (release: (success: boolean) => void) => void): Promise<unknown> {
    assertLive(); signal.throwIfAborted()
    const scope = { route: request.route!, conversationId: request.conversationId! }, method = invocation.methodName.split('.').at(-1)!
    authorizeAgentThreadScope(scope, invocation, method)
    if (input.read !== undefined) {
      if (Object.keys(input).some(name => name !== 'read')) throw new Error('HTML read cannot be combined with another operation.')
      const entry = this.find({ ...scope, appId: String(input.read) }, invocation, method)
      if (Date.now() >= entry.view.expiresAt) throw new Error('HTML document expired; only unresolved process metadata is retained.')
      retain(() => entry.seen.delete(owner))
      entry.seen.set(owner, entry.view.revision)
      return { app: structuredClone(entry.view), html: entry.document.html, data: entry.document.data ?? {}, state: entry.document.state ?? {}, untrustedData: true, grantsPermission: false }
    }
    let entry: Entry
    if (input.update !== undefined) {
      entry = this.find({ ...scope, appId: String(input.update) }, invocation, method)
      if (Date.now() >= entry.view.expiresAt || entry.operation || entry.controller.signal.aborted || ['closed', 'failed', 'unknown'].includes(entry.view.status)) throw new Error('HTML app is closed or busy.')
      const modifying = ['html', 'title', 'data', 'patch'].some(name => input[name] !== undefined)
      if ((input.expectedRevision !== undefined && input.expectedRevision !== entry.view.revision) || (modifying && input.expectedRevision === undefined && entry.seen.get(owner) !== entry.view.revision)) throw new Error('Read the current app before updating; revision conflict.')
      if (input.surface !== undefined) throw new Error('HTML surface cannot be changed.')
      if (input.wait_for && entry.waiting) throw new Error('HTML app already has an event waiter.')
      if (input.patch && entry.seen.get(owner) !== entry.view.revision) throw new Error('Read the current app before patching.')
      if (modifying) {
      let html = typeof input.html === 'string' ? input.html : entry.document.html
      if (input.patch) {
        if (input.html !== undefined) throw new Error('Use html or patch, not both.')
        for (const edit of input.patch as Array<{find:string;replace:string}>) {
          const first = html.indexOf(edit.find)
          if (first < 0 || html.indexOf(edit.find, first + 1) >= 0) throw new Error('HTML patch find must occur exactly once.')
          html = html.slice(0, first) + edit.replace + html.slice(first + edit.find.length)
          if (Buffer.byteLength(html) > 262144) throw new Error('HTML patch exceeds document budget.')
        }
      }
      const next = { title: typeof input.title === 'string' ? input.title : entry.document.title, html, data: input.data !== undefined ? cloneBoundedMcpJson(input.data, 65536) as Record<string, unknown> : entry.document.data, state: entry.document.state, revision: entry.view.revision + 1 }
      validateHtmlHostDocument(next)
      const parentAbort = () => { void this.stopEntry(entry) }
      signal.addEventListener('abort', parentAbort, { once: true })
      retain(success => { signal.removeEventListener('abort', parentAbort); entry.seen.delete(owner); if (!success) void this.stopEntry(entry) })
      if (signal.aborted) { parentAbort(); signal.throwIfAborted() }
      if (entry.process) {
        entry.events = []; entry.droppedEvents = 0; entry.reportedDrops = 0
        const pending = (async () => {
          // kt.state.set is acknowledged by the trusted shell before the next
          // coalesced poll. Freeze/capture that authoritative state first.
          if (entry.process!.captureState) {
            const snapshot = await entry.process!.captureState()
            assertLive(); signal.throwIfAborted(); entry.lease.assertLive(); entry.controller.signal.throwIfAborted()
            if (snapshot.revision !== entry.view.revision) throw new Error('HTML update state revision conflict.')
            next.state = cloneBoundedMcpJson(snapshot.value, 65536) as Record<string, unknown>
          }
          entry.pendingRevision = next.revision
          await entry.process!.update(next)
        })(); entry.operation = pending
        try { await pending; assertLive(); signal.throwIfAborted(); entry.lease.assertLive(); entry.controller.signal.throwIfAborted(); if (entry.process.closed) throw new Error('HTML process closed during update.') }
        catch (error) { void this.stopEntry(entry); throw error }
        finally { if (entry.operation === pending) entry.operation = undefined; entry.pendingRevision = undefined }
      }
      if (entry.lastState?.revision === next.revision) next.state = entry.lastState.value
      entry.document = next; entry.view.revision = next.revision; entry.view.title = next.title; entry.view.sha256 = sha(next.html); entry.seen.set(owner, next.revision)
      this.notify(entry)
      }
    } else {
      if (input.expectedRevision !== undefined || input.patch) throw new Error('New HTML app cannot specify revision or patch.')
      const document = { title: input.title as string, html: input.html as string, ...(input.data !== undefined ? { data: cloneBoundedMcpJson(input.data, 65536) as Record<string, unknown> } : {}), revision: 1 }
      validateHtmlHostDocument(document)
      entry = this.prepare(scope, invocation, document, input.surface === 'chat' ? 'chat' : 'canvas')
      entry.seen.set(owner, 1)
      const parentAbort = () => { void this.stopEntry(entry) }
      signal.addEventListener('abort', parentAbort, { once: true })
      retain(success => { signal.removeEventListener('abort', parentAbort); entry.seen.delete(owner); if (!success) void this.stopEntry(entry) })
    }
    if (input.wait_for) {
      const waitOwner = {}, waitRevision = entry.view.revision
      entry.waiting = waitOwner
      const parentAbort = () => { void this.stopEntry(entry) }
      signal.addEventListener('abort', parentAbort, { once: true })
      retain(success => { signal.removeEventListener('abort', parentAbort); if (!success) void this.stopEntry(entry) })
      const names = input.wait_for as string[], expires = Date.now() + Number(input.timeout_s ?? 300) * 1000
      try {
      for (;;) {
        assertLive(); signal.throwIfAborted(); entry.lease.assertLive()
        if (entry.view.revision !== waitRevision || entry.pendingRevision !== undefined) return { app: structuredClone(entry.view), superseded: true, untrustedData: true, grantsPermission: false }
        const index = entry.events.findIndex(event => names.includes(event.name) || event.name === '__error__' || event.name === '__overflow__')
        if (index >= 0) { entry.reportedDrops = entry.droppedEvents; return { app: structuredClone(entry.view), event: entry.events.splice(index, 1)[0], droppedEvents: entry.droppedEvents, untrustedData: true, grantsPermission: false } }
        if (entry.droppedEvents > entry.reportedDrops) { entry.reportedDrops = entry.droppedEvents; return { app: structuredClone(entry.view), eventQueueOverflow: true, droppedEvents: entry.droppedEvents, untrustedData: true, grantsPermission: false } }
        if (Date.now() >= expires) return { app: structuredClone(entry.view), timedOut: true, untrustedData: true, grantsPermission: false }
        if (['closed', 'failed', 'unknown'].includes(entry.view.status)) break
        await new Promise<void>(resolve => {
          const wake = () => { clearTimeout(timer); signal.removeEventListener('abort', wake); entry.waiters.delete(wake); resolve() }
          const timer = setTimeout(wake, Math.min(1000, expires - Date.now()))
          entry.waiters.add(wake); signal.addEventListener('abort', wake, { once: true }); if (signal.aborted) wake()
        })
      }
      } finally { if (entry.waiting === waitOwner) entry.waiting = undefined }
    }
    return { app: structuredClone(entry.view), shown: entry.view.status === 'open', awaitingUserOpen: entry.view.status === 'ready', untrustedData: true, grantsPermission: false }
  }
  list(scope: AgentThreadInteractionScope, invocation: ServiceInvocationContext) { return { apps: this.owned(scope, invocation, 'listAgentHtmlApps').map(entry => structuredClone(entry.view)) } }
  async open(req: AgentHtmlReq, invocation: ServiceInvocationContext, enabled: () => boolean): Promise<{app: AgentHtmlApp}> {
    const entry = this.find(req, invocation, 'openAgentHtmlApp')
    if (!enabled() || Date.now() >= entry.view.expiresAt || req.expectedRevision !== entry.view.revision || entry.operation || entry.view.status !== 'ready') throw new Error('HTML app is disabled, stale, already open or busy.')
    entry.view.status = 'opening'; entry.view.snapshotReady = false
    const signal = AbortSignal.any([entry.controller.signal, entry.lease.signal]), assertLive = () => { signal.throwIfAborted(); entry.lease.assertLive(); if (!enabled()) throw new Error('HTML execution disabled.') }
    const configWatch = setInterval(() => { if (!enabled()) void this.stopEntry(entry) }, 500)
    let storagePreflightPending = !this.launch
    const launch: typeof openHtmlProcess = this.launch ?? (async (document, options) => {
      const runtime = await (await import('./agentThreadHtmlRuntime')).getAgentThreadHtmlRuntime()
      assertLive(); runtime.assertReady(); storagePreflightPending = false
      const assertSavedCurrent = () => {
        assertLive()
        if (entry.view.savedId) {
          const saved = runtime.checkpoints().read(entry.scope, entry.view.savedId)
          if (!saved || saved.storageRevision !== entry.view.savedRevision) throw new Error('Saved HTML changed or was deleted; restore the current snapshot again.')
        }
      }
      assertSavedCurrent()
      return runtime.launch(document, { ...options, assertLive: assertSavedCurrent }, ownerHash(entry.scope), entry.view.savedId)
    })
    entry.operation = launch(entry.document, { signal, assertLive, onState: state => {
      if (signal.aborted || state.revision !== (entry.pendingRevision ?? entry.view.revision) || entry.lastState?.revision === state.revision && entry.lastState.stateRevision >= state.stateRevision) return
      const value = cloneBoundedMcpJson(state.value, 65536) as Record<string, unknown>
      entry.lastState = { ...state, value }
      if (state.revision === entry.document.revision) entry.document.state = value
    }, onEvent: event => {
      if (signal.aborted || event.revision !== (entry.pendingRevision ?? entry.view.revision)) return
      const bounded = cloneBoundedMcpJson(event, 16384) as unknown as HtmlAppEvent
      if (entry.events.length >= 16) { entry.events.shift(); entry.droppedEvents++ }
      entry.events.push(bounded); this.notify(entry)
    }, onClosed: confirmed => { clearInterval(configWatch); entry.view.status = confirmed ? 'closed' : 'unknown'; this.notify(entry) } })
    try { entry.process = await entry.operation as IsolatedHtmlProcess; assertLive(); if (entry.process.closed) throw new Error('HTML process already closed.'); entry.view.status = 'open'; return { app: structuredClone(entry.view) } }
    catch (error) {
      if (entry.process) await this.stopEntry(entry)
      else if ((entry.view.status as AgentHtmlApp['status']) !== 'unknown') {
        // Runtime acquisition/ledger verification cannot have spawned anything.
        // Retrying is safe only here, not after calling the launch composition.
        let retryable = false
        try { assertLive(); retryable = storagePreflightPending && Date.now() < entry.view.expiresAt } catch { /* Revoked documents never reopen. */ }
        entry.view.status = retryable ? 'ready' : 'failed'
        if (retryable) entry.view.snapshotReady = true
      }
      this.notify(entry); clearInterval(configWatch); throw error
    }
    finally { entry.operation = undefined }
  }
  async close(req: AgentHtmlReq, invocation: ServiceInvocationContext) {
    const entry = this.find(req, invocation, 'closeAgentHtmlApp')
    if (req.expectedRevision !== entry.view.revision) throw new Error('HTML close revision conflict; refresh before stopping the current document.')
    if (entry.process?.captureState && !entry.process.closed && !entry.controller.signal.aborted && !entry.operation && req.expectedRevision === entry.view.revision) {
      entry.view.status = 'stopping'; this.notify(entry)
      const pending = entry.process.captureState()
      entry.operation = pending
      try {
        const snapshot = await pending
        this.find(req, invocation, 'closeAgentHtmlApp'); entry.controller.signal.throwIfAborted()
        if (snapshot.revision !== entry.view.revision) throw new Error('HTML state snapshot revision changed.')
        entry.document.state = cloneBoundedMcpJson(snapshot.value, 65536) as Record<string, unknown>
        entry.view.snapshotReady = true
      } catch { entry.view.snapshotReady = false }
      finally { if (entry.operation === pending) entry.operation = undefined }
    }
    await this.stopEntry(entry)
    this.find(req, invocation, 'closeAgentHtmlApp')
    return { app: structuredClone(entry.view) }
  }
  private prepare(scope: AgentThreadInteractionScope, invocation: ServiceInvocationContext, document: HtmlAppDocument, surface: 'canvas' | 'chat'): Entry {
    const method = invocation.methodName.split('.').at(-1)!
    if (this.owned(scope, invocation, method).length >= 4 || this.entries.size >= 32) throw new Error('HTML app retention capacity reached.')
    validateHtmlHostDocument(document)
    const lease = agentThreadInteractions.createScoped(scope, invocation)
    if (!lease) throw new Error('HTML app requires a live trusted document.')
    const controller = new AbortController(), now = Date.now(), id = randomUUID()
    const entry: Entry = { scope: { route: structuredClone(scope.route), conversationId: scope.conversationId }, sender: invocation.senderId!, lease, controller, document: structuredClone(document), view: { id, title: document.title, revision: document.revision, sha256: sha(document.html), status: 'ready', createdAt: now, expiresAt: now + 900000, surface }, events: [], droppedEvents: 0, reportedDrops: 0, waiters: new Set(), seen: new Map(), timer: setTimeout(() => { void this.stopEntry(entry).finally(() => { if (entry.view.status !== 'unknown') this.remove(entry); else this.clearDocument(entry) }) }, 900000) }
    this.entries.set(id, entry)
    lease.signal.addEventListener('abort', () => { void this.stopEntry(entry).finally(() => { if (entry.view.status !== 'unknown') this.remove(entry); else this.clearDocument(entry) }) }, { once: true })
    return entry
  }
  async save(req: AgentHtmlSaveReq, invocation: ServiceInvocationContext, enabled: () => boolean): Promise<{ app: AgentHtmlApp; saved: AgentHtmlSaved }> {
    const assertScope = captureAgentHtmlScope(req, invocation, 'saveAgentHtmlApp')
    const entry = this.find(req, invocation, 'saveAgentHtmlApp')
    if (!enabled() || !req || !Number.isSafeInteger(req.expectedStorageRevision) || req.expectedStorageRevision < 0 || typeof req.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(req.operationId)) throw new Error('HTML snapshot saving disabled or invalid request.')
    const check = () => { assertScope(); this.find(req, invocation, 'saveAgentHtmlApp'); if (!enabled() || entry.view.revision !== req.expectedRevision || Date.now() >= entry.view.expiresAt || !['ready', 'closed'].includes(entry.view.status) || entry.view.snapshotReady === false || entry.waiting) throw new Error('Save only a current idle or confirmed-closed app; refresh its revision first.') }
    if (entry.operation) throw new Error('HTML app is busy.')
    check()
    const snapshot = structuredClone(entry.document), savedId = entry.view.savedId ?? entry.view.id
    const pending = (async () => {
      const runtime = await (await import('./agentThreadHtmlRuntime')).getAgentThreadHtmlRuntime()
      check()
      const document = runtime.withSavedIdle(ownerHash(entry.scope), savedId, () => {
        check()
        return runtime.checkpoints().save(entry.scope, { id: savedId, operationId: req.operationId, expectedRevision: req.expectedStorageRevision, content: { title: snapshot.title, html: snapshot.html, data: snapshot.data ?? {}, state: snapshot.state ?? {}, documentRevision: snapshot.revision, surface: entry.view.surface } })
      })
      if (JSON.stringify([document.title, document.html, document.data, document.state, document.documentRevision, document.surface]) !== JSON.stringify([snapshot.title, snapshot.html, snapshot.data ?? {}, snapshot.state ?? {}, snapshot.revision, entry.view.surface])) throw new Error('Saved HTML advanced after this operation; refresh and restore its current snapshot instead of rebinding stale content.')
      check(); entry.view.savedId = document.id; entry.view.savedRevision = document.storageRevision
      return { app: structuredClone(entry.view), saved: checkpointView(document) }
    })()
    entry.operation = pending
    try { return await pending } finally { if (entry.operation === pending) entry.operation = undefined }
  }
  private async savedAccess(scope: AgentHtmlScope, invocation: ServiceInvocationContext, method: string, enabled: () => boolean) {
    const assertScope = captureAgentHtmlScope(scope, invocation, method)
    const lease = agentThreadInteractions.createScoped(scope, invocation)
    if (!lease) throw new Error('Saved HTML requires a live trusted document.')
    const check = () => { assertScope(); lease.assertLive(); authorizeAgentThreadScope(scope, invocation, method); if (!enabled()) throw new Error('Encrypted HTML snapshot access disabled.') }
    try { check(); const runtime = await (await import('./agentThreadHtmlRuntime')).getAgentThreadHtmlRuntime(); check(); return { runtime, lease, check } }
    catch (error) { lease.dispose(); throw error }
  }
  async listSaved(scope: AgentHtmlScope, invocation: ServiceInvocationContext, enabled: () => boolean): Promise<{ apps: AgentHtmlSaved[] }> {
    const access = await this.savedAccess(scope, invocation, 'listSavedAgentHtmlApps', enabled)
    try { access.check(); const apps = access.runtime.checkpoints().list(scope).map(checkpointView); access.check(); return { apps } } finally { access.lease.dispose() }
  }
  async restore(req: AgentHtmlRestoreReq, invocation: ServiceInvocationContext, enabled: () => boolean): Promise<{ app: AgentHtmlApp }> {
    savedReq(req)
    if (typeof req.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(req.operationId)) throw new Error('Invalid HTML restoration operation.')
    const access = await this.savedAccess(req, invocation, 'restoreAgentHtmlApp', enabled)
    try {
      access.check()
      const receiptKey = JSON.stringify([invocation.senderId, key(req), req.operationId]), digest = sha(JSON.stringify([req.savedId, req.expectedStorageRevision]))
      const previous = this.restoreReceipts.get(receiptKey)
      if (previous) { if (previous.digest !== digest) throw new Error('HTML restore replay conflict.'); return { app: structuredClone(this.find({ ...req, appId: previous.appId }, invocation, 'restoreAgentHtmlApp').view) } }
      if (this.restoreReceipts.size >= 256) throw new Error('HTML restoration receipt capacity reached; restart before more restores.')
      const document = access.runtime.checkpoints().read(req, req.savedId)
      if (!document || document.storageRevision !== req.expectedStorageRevision) throw new Error('Saved HTML revision conflict; refresh before restoring.')
      access.runtime.assertSavedIdle(ownerHash(req), req.savedId); access.check()
      const entry = this.prepare(req, invocation, { title: document.title, html: document.html, data: document.data, state: document.state, revision: document.documentRevision }, document.surface)
      entry.view.savedId = document.id; entry.view.savedRevision = document.storageRevision
      this.restoreReceipts.set(receiptKey, { digest, appId: entry.view.id })
      // Keep a body-free replay fence even after expiry/removal. A delayed
      // restore retry must not silently recreate a card with a fresh lifetime.
      return { app: structuredClone(entry.view) }
    } finally { access.lease.dispose() }
  }
  async deleteSaved(req: AgentHtmlSavedReq, invocation: ServiceInvocationContext, enabled: () => boolean): Promise<void> {
    savedReq(req)
    const access = await this.savedAccess(req, invocation, 'deleteSavedAgentHtmlApp', enabled)
    try {
      access.check()
      if ([...this.entries.values()].some(entry => key(entry.scope) === key(req) && entry.view.savedId === req.savedId && (entry.operation || ['opening', 'open', 'stopping', 'unknown'].includes(entry.view.status)))) throw new Error('Saved HTML is busy or termination unconfirmed.')
      access.runtime.withSavedIdle(ownerHash(req), req.savedId, () => { access.check(); access.runtime.checkpoints().delete(req, req.savedId, req.expectedStorageRevision) })
      for (const entry of this.entries.values()) if (key(entry.scope) === key(req) && entry.view.savedId === req.savedId) void this.stopEntry(entry)
    } finally { access.lease.dispose() }
  }
  private stopEntry(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing
    if (entry.view.status !== 'unknown' && entry.view.status !== 'closed') entry.view.status = 'stopping'
    entry.controller.abort(); this.notify(entry)
    entry.closing = (async () => {
      if (!entry.process && entry.operation) try { await entry.operation } catch { /* launch failed */ }
      if (entry.process) { const result = await entry.process.close(); entry.view.status = result.confirmed ? 'closed' : 'unknown' }
      else if (entry.view.status !== 'unknown') entry.view.status = 'closed'
      this.notify(entry)
    })().catch(() => { entry.view.status = 'unknown'; this.notify(entry) })
    return entry.closing
  }
  private clearDocument(entry: Entry) { entry.document = { title: entry.document.title, revision: entry.document.revision, html: '' }; entry.lastState = undefined; entry.events = []; entry.seen.clear() }
  private remove(entry: Entry) { if (!this.entries.delete(entry.view.id)) return; clearTimeout(entry.timer); entry.lease.dispose(); entry.events = []; entry.droppedEvents = 0; entry.seen.clear() }
  async dispose() { for (const entry of this.entries.values()) { await this.stopEntry(entry); if (entry.view.status !== 'unknown') this.remove(entry); else this.clearDocument(entry) } }
}
export const agentThreadHtmlApps = new AgentThreadHtmlApps()
