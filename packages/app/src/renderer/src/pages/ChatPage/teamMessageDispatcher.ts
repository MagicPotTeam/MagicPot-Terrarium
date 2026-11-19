import { TeamMessageService, type TeamMessageDelivery } from './teamMessageService'

/** All identity and generation checks are host-provided functional guards, not security. */
export type TeamMessageSource = Readonly<{ scope: string; thread: string; lead: string } & ({ kind: 'member'; member: string } | { kind: 'user' })>
export type TeamMessageIntent = Readonly<{
  id: string
  source: TeamMessageSource
  kind: 'message' | 'channel'
  hop: 1 | 2
  recipient?: string
  text: string
  /** The claim's lease from MAIN (member messages only); the delivery request presents it. */
  lease?: string
}>
/** 'held': waits for a stopped member until the user resumes it (see hold/release). */
export type TeamDispatchStatus = 'queued' | 'held' | 'request_started' | 'response_received' | 'unavailable' | 'unknown'
export type TeamDispatchEntry = Readonly<{ intent: TeamMessageIntent; recipient?: string; status: TeamDispatchStatus }>
export type TeamDispatchStage = 'request_started' | 'response_received'
/** A delivery that has ended one way or another: its record may be dropped when the log is full. */
const SETTLED: ReadonlySet<TeamDispatchStatus> = new Set(['response_received', 'unavailable', 'unknown'])

/** Delivery bookkeeping is renderer-local per generation; durable user-channel pending intents live on ChatSession. */
export class TeamMessageDispatcher {
  private readonly service: TeamMessageService
  private readonly records: TeamDispatchEntry[] = []
  /** Stable identity of each record (same index as records): pruning settled records shifts indexes. */
  private readonly recordIds: number[] = []
  private nextRecordId = 0
  /** IDs of pruned messages, still refused as duplicates (bounded, oldest forgotten first). */
  private readonly prunedIds = new Set<string>()
  private readonly busy = new Set<string>()
  private readonly subscriptions = new Set<string>()
  private readonly held = new Set<string>()
  /** Record IDs of claimed records whose delivery has not settled: hold and pruning never touch them. */
  private readonly claimed = new Set<number>()
  private ended = false

  constructor(
    private readonly team: Readonly<{ scope: string; thread: string; lead: string }>,
    private readonly isCurrent: () => boolean,
    private readonly isMember: (member: string) => boolean,
    initialMembers: readonly string[],
    private readonly deliver: (delivery: TeamMessageDelivery, source: TeamMessageSource, stage: (stage: TeamDispatchStage) => void, hop: 1 | 2, lease?: string) => Promise<void>,
    private readonly onChange: (entries: readonly TeamDispatchEntry[]) => void = () => {},
    private readonly limit = 1000,
    private readonly isRecipientBusy: (member: string) => boolean = () => false,
    /** False while the host cannot start a delivery (a hidden pane): records stay queued, nothing is claimed. */
    private readonly canDeliver: () => boolean = () => true
  ) {
    if (![team.scope, team.thread, team.lead].every(value => typeof value === 'string' && value.trim() && value.length <= 256)) throw new Error('Invalid team.')
    this.team = Object.freeze({ ...team })
    this.service = new TeamMessageService(JSON.stringify([team.scope, team.thread, team.lead]), isMember, limit)
    for (const member of initialMembers) this.subscribe(member)
  }

  private active(): void {
    if (this.ended || !this.isCurrent()) throw new Error('Team unavailable.')
  }

  entries(): readonly TeamDispatchEntry[] { return this.records.slice() }
  private notify(): void { try { this.onChange(this.entries()) } catch { /* observers must not alter dispatch */ } }
  private set(index: number, status: TeamDispatchStatus): void {
    this.records[index] = Object.freeze({ ...this.records[index], status })
    this.notify()
  }
  private push(entry: TeamDispatchEntry): void {
    this.records.push(entry)
    this.recordIds.push(this.nextRecordId++)
  }
  private isClaimed(index: number): boolean { return this.claimed.has(this.recordIds[index]) }
  private isKnownId(id: string): boolean { return this.prunedIds.has(id) || this.records.some(entry => entry.intent.id === id) }

  /**
   * Makes room for `count` new records by dropping the oldest messages whose records are all
   * settled (response_received, unavailable, unknown) and unclaimed. Queued, held, started or
   * claimed records are never dropped. Drops nothing and returns false when that is not enough.
   */
  private makeRoom(count: number): boolean {
    const excess = this.records.length + count - this.limit
    if (excess <= 0) return true
    const blocked = new Set<string>()
    this.records.forEach((entry, index) => { if (!SETTLED.has(entry.status) || this.isClaimed(index)) blocked.add(entry.intent.id) })
    const drop: string[] = []
    const seen = new Set<string>()
    let freed = 0
    for (const entry of this.records) {
      const id = entry.intent.id
      if (seen.has(id)) continue
      seen.add(id)
      if (blocked.has(id)) continue
      drop.push(id)
      freed += this.records.filter(item => item.intent.id === id).length
      if (freed >= excess) break
    }
    if (freed < excess) return false
    const dropped = new Set(drop)
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (dropped.has(this.records[i].intent.id)) { this.records.splice(i, 1); this.recordIds.splice(i, 1) }
    }
    for (const id of drop) {
      this.service.forget(id)
      this.prunedIds.add(id)
    }
    for (const id of this.prunedIds) {
      if (this.prunedIds.size <= this.limit * 4) break
      this.prunedIds.delete(id)
    }
    return true
  }

  subscribe(member: string): void { this.active(); this.service.subscribe(member, 'team'); this.subscriptions.add(member) }
  unsubscribe(member: string): void { this.active(); this.service.unsubscribe(member, 'team'); this.subscriptions.delete(member) }
  isSubscribed(member: string): boolean { return this.subscriptions.has(member) }

  recordUnavailable(input: TeamMessageIntent, recipient?: string): void {
    this.active()
    if (!input || !input.source || input.source.scope !== this.team.scope || input.source.thread !== this.team.thread || input.source.lead !== this.team.lead) throw new Error('Invalid team source.')
    if (this.isKnownId(input.id) || !this.makeRoom(1)) throw new Error('Team message activity limit reached.')
    const source = Object.freeze({ ...input.source })
    const intent = Object.freeze({ id: input.id, source, kind: input.kind, hop: input.hop, ...(input.recipient === undefined ? {} : { recipient: input.recipient }), text: input.text })
    this.push(Object.freeze({ intent, ...(recipient === undefined ? {} : { recipient }), status: 'unavailable' }))
    this.notify()
  }

  /** Rejects duplicates, including repeats with different content; no implicit retry. */
  enqueue(input: TeamMessageIntent): number {
    this.active()
    if (!input || !input.source || input.source.scope !== this.team.scope || input.source.thread !== this.team.thread || input.source.lead !== this.team.lead) throw new Error('Invalid team source.')
    if (input.source.kind !== 'member' && input.source.kind !== 'user') throw new Error('Invalid message source.')
    if (input.source.kind === 'user' && (input.kind !== 'channel' || input.hop !== 1 || 'member' in input.source)) throw new Error('Invalid user broadcast.')
    if (input.kind !== 'message' && input.kind !== 'channel') throw new Error('Invalid message kind.')
    if (input.hop !== 1 && input.hop !== 2) throw new Error('Invalid message hop.')
    if (input.kind === 'message' && !input.recipient) throw new Error('Recipient required.')
    if (input.kind === 'channel' && input.recipient !== undefined) throw new Error('Invalid channel recipient.')
    if (this.isKnownId(input.id)) throw new Error('Duplicate message ID.')
    const expectedRecipients = input.kind === 'message' ? 1 : [...this.subscriptions].filter(id => this.isMember(id) && (input.source.kind === 'user' || id !== input.source.member)).length
    if (!this.makeRoom(Math.max(1, expectedRecipients))) throw new Error('Team message activity limit reached.')
    const source = Object.freeze({ ...input.source })
    // The lease belongs to this record's intent (not to an index, which pruning shifts); a user broadcast has none.
    const lease = source.kind === 'member' && typeof input.lease === 'string' && input.lease ? { lease: input.lease } : {}
    const intent = Object.freeze({ id: input.id, source, kind: input.kind, hop: input.hop, ...(input.recipient === undefined ? {} : { recipient: input.recipient }), text: input.text, ...lease })
    if (source.kind === 'user') this.service.sendUserChannel(intent.id, 'team', intent.text)
    else if (intent.kind === 'message') this.service.sendDirect(intent.id, source.member, intent.recipient!, intent.text)
    else this.service.sendChannel(intent.id, source.member, 'team', intent.text)
    const deliveries = this.service.history().filter(item => item.id === intent.id)
    if (!deliveries.length) this.push(Object.freeze({ intent, status: 'unavailable' }))
    else for (const item of deliveries) this.push(Object.freeze({ intent, recipient: item.recipient, status: this.held.has(item.recipient) ? 'held' : 'queued' }))
    this.notify()
    return deliveries.length
  }

  enqueueUserChannel(input: Readonly<{ id: string; source: Extract<TeamMessageSource, { kind: 'user' }>; text: string }>): { queued: number } {
    const queued = this.enqueue({ ...input, kind: 'channel', hop: 1 })
    return { queued }
  }

  /** Reconcile queued snapshots after member removal; started requests are not recalled. */
  reconcileMembers(): void {
    if (this.ended || !this.isCurrent()) return
    let changed = false
    for (let i = 0; i < this.records.length; i++) {
      const entry = this.records[i]
      if ((entry.status === 'queued' || entry.status === 'held') && (!this.isSourceCurrent(entry.intent.source) || !entry.recipient || !this.isMember(entry.recipient))) {
        this.records[i] = Object.freeze({ ...entry, status: 'unavailable' })
        changed = true
      }
    }
    if (changed) this.notify()
  }

  private isSourceCurrent(source: TeamMessageSource): boolean { return source.kind === 'user' || this.isMember(source.member) }

  /**
   * A stopped member gets no team delivery until the user resumes it: its waiting records, and
   * every record for it that arrives later, are held. A delivery already claimed is not recalled
   * (the host's stop cancels it). Never throws: a stop must not fail on an ended team.
   */
  hold(member: string): void {
    if (this.ended) return
    this.held.add(member)
    let changed = false
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].recipient === member && this.records[i].status === 'queued' && !this.isClaimed(i)) {
        this.records[i] = Object.freeze({ ...this.records[i], status: 'held' })
        changed = true
      }
    }
    if (changed) this.notify()
  }

  /** The user resumed the member (their own send to it was accepted): held records wait again, in order. */
  release(member: string): void {
    if (this.ended || !this.held.delete(member)) return
    let changed = false
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].recipient === member && this.records[i].status === 'held') {
        this.records[i] = Object.freeze({ ...this.records[i], status: 'queued' })
        changed = true
      }
    }
    if (changed) this.notify()
  }

  isHeld(member: string): boolean { return this.held.has(member) }

  /** The members that records of this message are for. */
  recipientsOf(id: string): string[] {
    return [...new Set(this.records.flatMap(entry => entry.intent.id === id && entry.recipient ? [entry.recipient] : []))]
  }

  /** A record for this member still waits for its delivery (queued and not claimed). */
  hasQueued(member: string): boolean {
    return this.records.some((entry, index) => entry.recipient === member && entry.status === 'queued' && !this.isClaimed(index))
  }

  /** Starts at most one delivery per member. Busy, held or undeliverable members remain queued; call again when ready. */
  pump(recipient: string): Promise<void> | undefined {
    this.active()
    if (!this.isMember(recipient)) throw new Error('Team member unavailable.')
    if (this.held.has(recipient) || !this.canDeliver() || this.busy.has(recipient) || this.isRecipientBusy(recipient)) return undefined
    const index = this.records.findIndex(item => item.recipient === recipient && item.status === 'queued')
    if (index < 0) return undefined
    const record = this.records[index]
    if (!this.isSourceCurrent(record.intent.source)) { this.set(index, 'unavailable'); return undefined }
    const claimed = this.service.claim(recipient, record.intent.id)
    if (!claimed) { this.set(index, 'unavailable'); return undefined }
    this.busy.add(recipient)
    // A claimed record is never pruned, so its current index is always found by its record ID.
    const recordId = this.recordIds[index]
    this.claimed.add(recordId)
    const at = (): number => this.recordIds.indexOf(recordId)
    let stageOpen = true
    let admitted = false
    const stage = (value: TeamDispatchStage): void => {
      if (!stageOpen) return
      const current = this.records[at()].status
      if (value === 'request_started' && !this.ended && this.isCurrent() && current === 'queued') { admitted = true; this.set(at(), 'request_started') }
      if (value === 'response_received' && admitted && current === 'request_started') this.set(at(), 'response_received')
    }
    return (async () => {
      try { await this.deliver(claimed, record.intent.source, stage, record.intent.hop, record.intent.lease) } catch { /* unknown after start, unavailable before */ }
      finally {
        stageOpen = false
        const current = this.records[at()].status
        if (current === 'queued') this.set(at(), 'unavailable')
        else if (current === 'request_started') this.set(at(), 'unknown')
        this.claimed.delete(recordId)
        this.busy.delete(recipient)
      }
    })()
  }

  /** Prevents new work; already claimed work follows host cancellation policy. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.service.end()
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].status === 'queued' || this.records[i].status === 'held') this.records[i] = Object.freeze({ ...this.records[i], status: 'unavailable' })
    }
    this.notify()
  }
}
