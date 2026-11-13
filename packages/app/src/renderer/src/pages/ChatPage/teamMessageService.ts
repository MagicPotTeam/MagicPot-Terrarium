/**
 * Temporary renderer-local delivery queue. Nothing survives a reload or process
 * exit. Member IDs and teamKey are caller-provided, not authenticated identity
 * or an IPC/security boundary. The host must use a new instance for each team
 * generation and supply current membership; End is a functional guard only.
 * Enqueue and acknowledgement do not mean that an agent processed a message.
 */
export type TeamMessageDelivery = Readonly<{
  id: string
  teamKey: string
  sender: string | null
  recipient: string
  text: string
  channel?: string
  status: 'queued' | 'claimed' | 'acknowledged'
}>

export class TeamMessageService {
  private readonly ids = new Set<string>()
  private readonly deliveries: TeamMessageDelivery[] = []
  private readonly subscriptions = new Map<string, Set<string>>()
  private ended = false

  constructor(
    readonly teamKey: string,
    private readonly isCurrentMember: (id: string) => boolean,
    private readonly maxDeliveries = 1000,
    private readonly maxTextLength = 16_384
  ) {
    this.validateId(teamKey)
    if (!Number.isSafeInteger(maxDeliveries) || maxDeliveries < 1 || !Number.isSafeInteger(maxTextLength) || maxTextLength < 1) {
      throw new Error('Invalid team message limits.')
    }
  }

  private validateId(value: string): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid identifier.')
  }

  private member(id: string): void {
    this.validateId(id)
    if (!this.isCurrentMember(id)) throw new Error('Team member unavailable.')
  }

  private active(): void {
    if (this.ended) throw new Error('Team has ended.')
  }

  private validateMessage(id: string, sender: string | null, text: string): void {
    this.active()
    this.validateId(id)
    if (sender !== null) this.member(sender)
    if (this.ids.has(id)) throw new Error('Duplicate message ID.')
    if (typeof text !== 'string' || !text.trim() || text.length > this.maxTextLength) throw new Error('Invalid message text.')
  }

  subscribe(member: string, channel: string): void {
    this.active()
    this.member(member)
    this.validateId(channel)
    const members = this.subscriptions.get(channel) ?? new Set<string>()
    // Bound subscription storage independently from the delivery queue.
    if (!members.has(member) && [...this.subscriptions.values()].reduce((sum, entries) => sum + entries.size, 0) >= this.maxDeliveries) {
      throw new Error('Subscription limit reached.')
    }
    members.add(member)
    this.subscriptions.set(channel, members)
  }

  unsubscribe(member: string, channel: string): void {
    this.active()
    this.member(member)
    this.validateId(channel)
    const members = this.subscriptions.get(channel)
    members?.delete(member)
    if (!members?.size) this.subscriptions.delete(channel)
  }

  sendDirect(id: string, sender: string, recipient: string, text: string): void {
    this.validateMessage(id, sender, text)
    this.member(recipient)
    this.enqueue(id, sender, [recipient], text)
  }

  /** Snapshots current subscribers, excluding the sender; all-or-nothing on capacity. */
  sendChannel(id: string, sender: string, channel: string, text: string): number {
    this.validateMessage(id, sender, text)
    this.validateId(channel)
    const recipients = [...(this.subscriptions.get(channel) ?? [])].filter(member => member !== sender && this.isCurrentMember(member))
    this.enqueue(id, sender, recipients, text, channel)
    return recipients.length
  }

  /** Explicit user origin; no synthetic member identity and no sender exclusion. */
  sendUserChannel(id: string, channel: string, text: string): number {
    this.validateMessage(id, null, text)
    this.validateId(channel)
    const recipients = [...(this.subscriptions.get(channel) ?? [])].filter(member => this.isCurrentMember(member))
    this.enqueue(id, null, recipients, text, channel)
    return recipients.length
  }

  private enqueue(id: string, sender: string | null, recipients: string[], text: string, channel?: string): void {
    // Keep acknowledged deliveries and IDs too: both memory and deduplication are bounded.
    if (this.ids.size >= this.maxDeliveries || this.deliveries.length + recipients.length > this.maxDeliveries) {
      throw new Error('Team message queue full.')
    }
    this.ids.add(id)
    for (const recipient of recipients) {
      this.deliveries.push(Object.freeze({ id, teamKey: this.teamKey, sender, recipient, text, ...(channel === undefined ? {} : { channel }), status: 'queued' }))
    }
  }

  /** Non-destructive; callers may retry after an unsuccessful delivery. */
  peek(recipient: string): readonly TeamMessageDelivery[] {
    this.active()
    this.member(recipient)
    return this.deliveries.filter(delivery => delivery.recipient === recipient && delivery.status === 'queued')
  }

  /** Atomically reserve a queued delivery within this instance; not receipt. */
  claim(recipient: string, id: string): TeamMessageDelivery | undefined {
    this.active()
    this.member(recipient)
    this.validateId(id)
    const index = this.deliveries.findIndex(item => item.recipient === recipient && item.id === id && item.status === 'queued')
    if (index < 0) return undefined
    const claimed = Object.freeze({ ...this.deliveries[index], status: 'claimed' as const })
    this.deliveries[index] = claimed
    return claimed
  }

  /** Call only after explicit receipt; not an execution/processing acknowledgement. */
  ack(recipient: string, id: string): boolean {
    this.member(recipient)
    this.validateId(id)
    const index = this.deliveries.findIndex(delivery => delivery.recipient === recipient && delivery.id === id)
    if (index < 0) return false
    const delivery = this.deliveries[index]
    if (delivery.status !== 'acknowledged') this.deliveries[index] = Object.freeze({ ...delivery, status: 'acknowledged' })
    return true
  }

  /** Read-only status, including acknowledgements; does not initiate delivery. */
  history(): readonly TeamMessageDelivery[] {
    return this.deliveries.slice()
  }

  /** Existing peeks may be handled by the caller; ack remains available. */
  end(): void {
    this.ended = true
  }
}
