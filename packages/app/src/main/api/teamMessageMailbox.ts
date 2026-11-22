/**
 * An in-memory delivery primitive, not an IPC boundary. The host must supply
 * authoritative current membership and authenticate every caller before use.
 * Messages disappear on restart; enqueueing does not run an agent.
 */
export type TeamEnvelope = Readonly<{
  from: string
  to: string
  text: string
  channel?: string
}>

export class TeamMessageMailbox {
  private readonly queues = new Map<string, TeamEnvelope[]>()
  private readonly subscriptions = new Map<string, Set<string>>()

  constructor(private readonly isCurrentMember: (member: string) => boolean, private readonly limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid mailbox limit.')
  }

  private member(id: string): void {
    if (!id || !this.isCurrentMember(id)) throw new Error('Team member unavailable.')
  }

  subscribe(member: string, channel: string): void {
    this.member(member)
    this.validateChannel(channel)
    const members = this.subscriptions.get(channel) ?? new Set<string>()
    members.add(member)
    this.subscriptions.set(channel, members)
  }

  unsubscribe(member: string, channel: string): void {
    this.member(member)
    this.validateChannel(channel)
    const members = this.subscriptions.get(channel)
    members?.delete(member)
    if (!members?.size) this.subscriptions.delete(channel)
  }

  sendMessage(from: string, to: string, text: string): void {
    this.member(from)
    this.member(to)
    this.validateText(text)
    this.enqueue([{ from, to, text }])
  }

  sendChannel(from: string, channel: string, text: string): number {
    this.member(from)
    this.validateChannel(channel)
    this.validateText(text)
    const recipients = [...(this.subscriptions.get(channel) ?? [])].filter(id => this.isCurrentMember(id))
    this.enqueue(recipients.map(to => ({ from, to, text, channel })))
    return recipients.length
  }

  /** Removes and returns pending messages; not an acknowledgement of execution. */
  take(member: string): TeamEnvelope[] {
    this.member(member)
    const queue = this.queues.get(member) ?? []
    this.queues.delete(member)
    return queue
  }

  /** Host must call on removal or generation change, before reusing an ID. */
  removeMember(member: string): void {
    this.queues.delete(member)
    for (const [channel, members] of this.subscriptions) {
      members.delete(member)
      if (!members.size) this.subscriptions.delete(channel)
    }
  }

  private enqueue(messages: TeamEnvelope[]): void {
    // Preflight all recipients so a full inbox cannot partially broadcast.
    for (const message of messages) {
      if ((this.queues.get(message.to)?.length ?? 0) >= this.limit) throw new Error('Team mailbox full.')
    }
    for (const message of messages) {
      const queue = this.queues.get(message.to) ?? []
      queue.push(Object.freeze(message))
      this.queues.set(message.to, queue)
    }
  }

  private validateChannel(channel: string): void {
    if (typeof channel !== 'string' || !/^[\p{L}\p{N}_-]{1,64}$/u.test(channel)) throw new Error('Invalid team channel.')
  }

  private validateText(text: string): void {
    if (typeof text !== 'string' || !text.trim() || text.length > 16_384) throw new Error('Invalid team message.')
  }
}
