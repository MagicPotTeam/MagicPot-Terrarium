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
}>
export type TeamDispatchStatus = 'queued' | 'request_started' | 'response_received' | 'unavailable' | 'unknown'
export type TeamDispatchEntry = Readonly<{ intent: TeamMessageIntent; recipient?: string; status: TeamDispatchStatus }>
export type TeamDispatchStage = 'request_started' | 'response_received'

/** Renderer-local only. New instance per generation; reload loses all state. */
export class TeamMessageDispatcher {
  private readonly service: TeamMessageService
  private readonly records: TeamDispatchEntry[] = []
  private readonly busy = new Set<string>()
  private readonly subscriptions = new Set<string>()
  private ended = false

  constructor(
    private readonly team: Readonly<{ scope: string; thread: string; lead: string }>,
    private readonly isCurrent: () => boolean,
    private readonly isMember: (member: string) => boolean,
    initialMembers: readonly string[],
    private readonly deliver: (delivery: TeamMessageDelivery, source: TeamMessageSource, stage: (stage: TeamDispatchStage) => void, hop: 1 | 2) => Promise<void>,
    private readonly onChange: (entries: readonly TeamDispatchEntry[]) => void = () => {},
    private readonly limit = 1000,
    private readonly isRecipientBusy: (member: string) => boolean = () => false
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

  subscribe(member: string): void { this.active(); this.service.subscribe(member, 'team'); this.subscriptions.add(member) }
  unsubscribe(member: string): void { this.active(); this.service.unsubscribe(member, 'team'); this.subscriptions.delete(member) }
  isSubscribed(member: string): boolean { return this.subscriptions.has(member) }

  recordUnavailable(input: TeamMessageIntent, recipient?: string): void {
    this.active()
    if (!input || !input.source || input.source.scope !== this.team.scope || input.source.thread !== this.team.thread || input.source.lead !== this.team.lead) throw new Error('Invalid team source.')
    if (this.records.length >= this.limit || this.records.some(entry => entry.intent.id === input.id)) throw new Error('Team message activity limit reached.')
    const source = Object.freeze({ ...input.source })
    const intent = Object.freeze({ id: input.id, source, kind: input.kind, hop: input.hop, ...(input.recipient === undefined ? {} : { recipient: input.recipient }), text: input.text })
    this.records.push(Object.freeze({ intent, ...(recipient === undefined ? {} : { recipient }), status: 'unavailable' }))
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
    if (this.records.some(entry => entry.intent.id === input.id)) throw new Error('Duplicate message ID.')
    const expectedRecipients = input.kind === 'message' ? 1 : [...this.subscriptions].filter(id => this.isMember(id) && (input.source.kind === 'user' || id !== input.source.member)).length
    if (this.records.length + Math.max(1, expectedRecipients) > this.limit) throw new Error('Team message activity limit reached.')
    const source = Object.freeze({ ...input.source })
    const intent = Object.freeze({ id: input.id, source, kind: input.kind, hop: input.hop, ...(input.recipient === undefined ? {} : { recipient: input.recipient }), text: input.text })
    if (source.kind === 'user') this.service.sendUserChannel(intent.id, 'team', intent.text)
    else if (intent.kind === 'message') this.service.sendDirect(intent.id, source.member, intent.recipient!, intent.text)
    else this.service.sendChannel(intent.id, source.member, 'team', intent.text)
    const deliveries = this.service.history().filter(item => item.id === intent.id)
    if (!deliveries.length) this.records.push(Object.freeze({ intent, status: 'unavailable' }))
    else for (const item of deliveries) this.records.push(Object.freeze({ intent, recipient: item.recipient, status: 'queued' }))
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
      if (entry.status === 'queued' && (!this.isSourceCurrent(entry.intent.source) || !entry.recipient || !this.isMember(entry.recipient))) {
        this.records[i] = Object.freeze({ ...entry, status: 'unavailable' })
        changed = true
      }
    }
    if (changed) this.notify()
  }

  private isSourceCurrent(source: TeamMessageSource): boolean { return source.kind === 'user' || this.isMember(source.member) }

  /** Starts at most one delivery per member. Busy members remain queued; call again when ready. */
  pump(recipient: string): Promise<void> | undefined {
    this.active()
    if (!this.isMember(recipient)) throw new Error('Team member unavailable.')
    if (this.busy.has(recipient) || this.isRecipientBusy(recipient)) return undefined
    const index = this.records.findIndex(item => item.recipient === recipient && item.status === 'queued')
    if (index < 0) return undefined
    const record = this.records[index]
    if (!this.isSourceCurrent(record.intent.source)) { this.set(index, 'unavailable'); return undefined }
    const claimed = this.service.claim(recipient, record.intent.id)
    if (!claimed) { this.set(index, 'unavailable'); return undefined }
    this.busy.add(recipient)
    let stageOpen = true
    let admitted = false
    const stage = (value: TeamDispatchStage): void => {
      if (!stageOpen) return
      const current = this.records[index].status
      if (value === 'request_started' && !this.ended && this.isCurrent() && current === 'queued') { admitted = true; this.set(index, 'request_started') }
      if (value === 'response_received' && admitted && current === 'request_started') this.set(index, 'response_received')
    }
    return (async () => {
      try { await this.deliver(claimed, record.intent.source, stage, record.intent.hop) } catch { /* unknown after start, unavailable before */ }
      finally {
        stageOpen = false
        const current = this.records[index].status
        if (current === 'queued') this.set(index, 'unavailable')
        else if (current === 'request_started') this.set(index, 'unknown')
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
      if (this.records[i].status === 'queued') this.records[i] = Object.freeze({ ...this.records[i], status: 'unavailable' })
    }
    this.notify()
  }
}
