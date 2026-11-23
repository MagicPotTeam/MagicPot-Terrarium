import type { AgentThreadEventView } from '@shared/api/agentThreadInbox'

/** A claimed event whose turn never went out waits this long before it is claimed again. */
export const THREAD_EVENT_REFUSED_RETRY_MS = 60_000

/**
 * ready: the session may start an event turn now. wait: not now (busy, queued sends, held by a
 * manual stop). removed / unavailable: the session was removed, archived or cannot take an event
 * turn: its waiting events expire, and the session is never re-created or reopened.
 */
export type ThreadEventSessionState = 'ready' | 'wait' | 'removed' | 'unavailable'
/**
 * dispatched: the request went to MAIN (MAIN admitted or refused the lease). queued: the send waits
 * in the session's own send queue and presents the lease when it runs. refused: it never went out.
 */
export type ThreadEventRunOutcome = 'dispatched' | 'queued' | 'refused'

export type ThreadEventPumpHost = Readonly<{
  /** The page, its storage scope and its loaded session list are still the ones the pump began with. */
  isCurrent(): boolean
  sessionState(conversationId: string): ThreadEventSessionState
  /** Queued events of this thread route and storage scope, oldest first (MAIN). */
  list(): Promise<AgentThreadEventView[]>
  claim(id: string, conversationId: string): Promise<AgentThreadEventView | undefined>
  release(id: string, conversationId: string, lease: string): Promise<boolean>
  expire(conversationId: string, reason: 'session-removed' | 'session-unavailable'): Promise<void>
  /** Runs the event as one turn of its session; resolves when the turn has ended. Never throws. */
  run(event: AgentThreadEventView & { lease: string }): Promise<ThreadEventRunOutcome>
  /** A turn ended: poll again now. */
  wake?(): void
}>

/**
 * Renderer wake pump of the thread event inbox (D7 plan A). Each poll lists MAIN's queued events
 * (oldest first) and, per session, takes only the oldest one: one event turn at a time per
 * session, carried-over events included (they run by themselves, oldest first). A hidden pane
 * claims and runs like a visible one; only the poll cadence differs (the host's poller).
 * The pump never enqueues and never creates a session.
 */
export class ThreadEventPump {
  private polling = false
  private ended = false
  /** Sessions with an event turn in flight. */
  private readonly running = new Set<string>()
  /** Event id -> when it may be claimed again (its turn never went out). */
  private readonly deferred = new Map<string, number>()

  constructor(
    private readonly host: ThreadEventPumpHost,
    private readonly now: () => number = Date.now
  ) {}

  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId)
  }

  end(): void {
    this.ended = true
  }

  private live(): boolean {
    return !this.ended && this.host.isCurrent()
  }

  async tick(): Promise<void> {
    if (this.polling || !this.live()) return
    this.polling = true
    try {
      const events = await this.host.list()
      const seen = new Set<string>()
      for (const event of events) {
        if (!this.live()) break
        const session = event.conversationId
        // One at a time per session, oldest first: a later event waits for the oldest one.
        if (seen.has(session)) continue
        seen.add(session)
        if (this.running.has(session)) continue
        const state = this.host.sessionState(session)
        if (state === 'removed' || state === 'unavailable') {
          await this.host.expire(
            session,
            state === 'removed' ? 'session-removed' : 'session-unavailable'
          )
          continue
        }
        if (state !== 'ready' || (this.deferred.get(event.id) ?? 0) > this.now()) continue
        const claimed = await this.host.claim(event.id, session)
        if (!claimed?.lease) continue
        const lease = claimed.lease
        if (!this.live() || this.host.sessionState(session) !== 'ready') {
          await this.host.release(claimed.id, session, lease)
          continue
        }
        this.running.add(session)
        void this.runOne({ ...claimed, lease })
      }
    } catch {
      /* IPC unavailable or the scope changed: nothing is claimed by a failed poll. */
    } finally {
      this.polling = false
    }
  }

  private async runOne(event: AgentThreadEventView & { lease: string }): Promise<void> {
    let outcome: ThreadEventRunOutcome = 'refused'
    try {
      outcome = await this.host.run(event)
    } catch {
      outcome = 'refused'
    }
    try {
      // A queued send keeps the claim: it presents the lease when it runs. Otherwise release: a no-op
      // for an event MAIN admitted (its lease is gone), and a queued-again event for one that never
      // went out, which then waits before it is claimed again.
      if (outcome !== 'queued') {
        const released = await this.host.release(event.id, event.conversationId, event.lease)
        if (released) this.deferred.set(event.id, this.now() + THREAD_EVENT_REFUSED_RETRY_MS)
      }
    } catch {
      /* The claim ends with the document (MAIN queues it again). */
    } finally {
      this.running.delete(event.conversationId)
      for (const [id, at] of this.deferred) if (at <= this.now()) this.deferred.delete(id)
      if (!this.ended) this.host.wake?.()
    }
  }
}
