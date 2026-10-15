import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  FIGPLUGIN_BRIDGE_PROTOCOL,
  FigPluginBridgeError,
  figPluginBridgePrepareRequestSchema,
  figPluginBridgeStatusResponseSchema,
  figPluginPairRequestSchema,
  figPluginRuntimeBindingSchema,
  parseFigPluginBridgeValue,
  type FigPluginBridgePrepareRequest,
  type FigPluginBridgePrepareResponse,
  type FigPluginBridgePreview,
  type FigPluginBridgeStatusResponse,
  type FigPluginPairRequest,
  type FigPluginPairResponse,
  type FigPluginRuntimeBinding
} from '@shared/figplugin/bridge'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'

const TICKET_TTL = 120_000
const SESSION_TTL = 600_000
const IDLE_TTL = 120_000
const CALL_TTL = 120_000
const MAX_CALL_TIMEOUT = 90_000
const FAILURE_WINDOW = 60_000
const dummySecret = '0'.repeat(64)
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 32 && /^[a-f0-9]{32}$/.test(value)

// Even missing IDs and malformed credentials perform a fixed-size comparison.
const secretEquals = (value: unknown, expected: string | undefined): boolean => {
  const valid = typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value)
  const equal = timingSafeEqual(
    Buffer.from(valid ? value : dummySecret, 'hex'),
    Buffer.from(expected || dummySecret, 'hex')
  )
  return valid && expected !== undefined && expected !== '' && equal
}
const resultSchema = figPluginBridgeStatusResponseSchema.options[2].pick({
  content: true,
  reportedTotalTokens: true
})

type Options = {
  validateBinding: (binding: FigPluginRuntimeBinding) => Promise<boolean>
  invoke: (
    binding: FigPluginRuntimeBinding,
    preview: FigPluginBridgePreview,
    signal: AbortSignal
  ) => Promise<{ content: string; reportedTotalTokens?: number }>
  now?: () => number
  callTimeoutMs?: number
}
type Ticket = {
  binding: FigPluginRuntimeBinding
  secret: string
  expiresAt: number
  failures: number
  state: 'issuing' | 'ready' | 'redeeming'
}
type Receipt = {
  sequence: number
  digest: string
  response: FigPluginBridgePrepareResponse
}
type Session = {
  id: string
  token: string
  binding: FigPluginRuntimeBinding
  expiresAt: number
  idleAt: number
  highWater: number
  requests: Map<string, Receipt>
  preparing: number
  validation?: Promise<boolean>
}
type Call = {
  session: Session
  receipt: Receipt
  status: FigPluginBridgeStatusResponse
  preview?: FigPluginBridgePreview
  controller?: AbortController
  deadline?: number
}
type TerminalCode =
  'DENIED' | 'EXPIRED' | 'CONFIGURATION_CHANGED' | 'CANCELLED' | 'TIMEOUT' | 'UPSTREAM_FAILED'
const active = (call: Call): boolean =>
  call.status.status === 'awaiting-approval' || call.status.status === 'running'

/** Memory-only main-process authority. Never expose createPairing/approve/deny to the host.
 * The caller supplies trusted native consent and validates the entire current store binding.
 */
export class FigPluginBridgeRuntime {
  private readonly tickets = new Map<string, Ticket>()
  private readonly sessions = new Map<string, Session>()
  private readonly calls = new Map<string, Call>()
  private readonly validateBinding: Options['validateBinding']
  private readonly invoke: Options['invoke']
  private readonly clock: () => number
  private readonly callTimeout: number
  private failures: number[] = []
  private timer?: ReturnType<typeof setTimeout>
  private preparing = 0
  private executing = 0
  private closed = false

  constructor(options: Options) {
    this.validateBinding = options.validateBinding
    this.invoke = options.invoke
    this.clock = options.now ?? Date.now
    this.callTimeout = Number.isFinite(options.callTimeoutMs)
      ? Math.max(1, Math.min(MAX_CALL_TIMEOUT, Math.floor(options.callTimeoutMs!)))
      : MAX_CALL_TIMEOUT
  }

  async createPairing(binding: FigPluginRuntimeBinding): Promise<{
    ticketId: string
    pairingSecret: string
    expiresAt: number
    bridgeOrigin: string
    pluginId: string
    host: FigPluginRuntimeBinding['host']
    artifactSha256: string
  }> {
    this.enter()
    const snapshot = Object.freeze(
      parseFigPluginBridgeValue(figPluginRuntimeBindingSchema, binding)
    )
    if (this.tickets.size >= 32) throw new FigPluginBridgeError('BUSY')
    const ticketId = randomBytes(16).toString('hex')
    const ticket: Ticket = {
      binding: snapshot,
      secret: randomBytes(32).toString('hex'),
      expiresAt: this.clock() + TICKET_TTL,
      failures: 0,
      state: 'issuing'
    }
    // Reservation identity is a lifetime epoch: revoke/expiry/dispose removes it,
    // so an outstanding validator can never resurrect an old installation.
    this.tickets.set(ticketId, ticket)
    this.scheduleCleanup()
    const valid = await this.validate(snapshot)
    this.prune()
    if (this.closed || this.tickets.get(ticketId) !== ticket) {
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    if (!valid) {
      this.removeTicket(ticketId, ticket)
      this.scheduleCleanup()
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    ticket.state = 'ready'
    return {
      ticketId,
      pairingSecret: ticket.secret,
      expiresAt: ticket.expiresAt,
      bridgeOrigin: snapshot.bridgeOrigin,
      pluginId: snapshot.pluginId,
      host: snapshot.host,
      artifactSha256: snapshot.artifactSha256
    }
  }

  /** Main-only rollback for a ticket whose native-consent operation could not deliver it. */
  discardPairing(ticketId: string): void {
    if (this.closed) return
    const ticket = this.tickets.get(ticketId)
    if (ticket) this.removeTicket(ticketId, ticket)
    this.scheduleCleanup()
  }

  async redeem(input: FigPluginPairRequest): Promise<FigPluginPairResponse> {
    this.enter()
    let request: FigPluginPairRequest | undefined
    let ticket: Ticket | undefined
    try {
      // Count malformed secrets against a known ticket, without revealing its existence.
      if (isId(input?.ticketId)) ticket = this.tickets.get(input.ticketId)
      request = parseFigPluginBridgeValue(figPluginPairRequestSchema, input)
    } catch {
      // Authentication, schema failures and unknown IDs share one public error.
    }
    const matches = secretEquals(request?.pairingSecret, ticket?.secret)
    const authorized =
      request &&
      ticket &&
      ticket.state === 'ready' &&
      matches &&
      request.pluginId === ticket.binding.pluginId &&
      request.host === ticket.binding.host &&
      request.artifactSha256 === ticket.binding.artifactSha256
    if (this.failures.length >= 20 || !authorized || !ticket || !request) {
      if (this.failures.length < 20) this.failures.push(this.clock())
      if (!authorized && ticket?.state === 'ready' && ++ticket.failures >= 5) {
        // Locate by identity even if parsing the untrusted envelope failed.
        for (const [id, current] of this.tickets) {
          if (current === ticket) this.removeTicket(id, ticket)
        }
      }
      this.scheduleCleanup()
      throw new FigPluginBridgeError('UNAUTHORIZED')
    }
    const pending = [...this.tickets.values()].filter((item) => item.state === 'redeeming').length
    if (this.sessions.size + pending >= 16) throw new FigPluginBridgeError('BUSY')
    // Consume and reserve a session slot synchronously, before the first await.
    ticket.state = 'redeeming'
    const valid = await this.validate(ticket.binding)
    this.prune()
    if (this.closed || this.tickets.get(request.ticketId) !== ticket) {
      throw new FigPluginBridgeError('UNAUTHORIZED')
    }
    this.removeTicket(request.ticketId, ticket)
    if (!valid) {
      this.scheduleCleanup()
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
    const now = this.clock()
    const session: Session = {
      id: randomBytes(16).toString('hex'),
      token: randomBytes(32).toString('hex'),
      binding: ticket.binding,
      expiresAt: now + SESSION_TTL,
      idleAt: now + IDLE_TTL,
      highWater: 0,
      requests: new Map(),
      preparing: 0
    }
    this.sessions.set(session.id, session)
    this.scheduleCleanup()
    return {
      protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
      sessionId: session.id,
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      idleTimeoutMs: IDLE_TTL
    }
  }

  async prepare(
    sessionId: string,
    sessionToken: string,
    input: FigPluginBridgePrepareRequest
  ): Promise<FigPluginBridgePrepareResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    if (this.preparing >= 16 || session.preparing >= 2) throw new FigPluginBridgeError('BUSY')
    // Bound retained inputs and coalesced validation waiters before parsing/stringifying.
    this.preparing += 1
    session.preparing += 1
    try {
      const request = parseFigPluginBridgeValue(figPluginBridgePrepareRequestSchema, input)
      let canonical: string
      try {
        canonical = canonicalFigPluginJson({
          binding: session.binding,
          prompt: request.prompt,
          context: request.context
        })
      } catch {
        throw new FigPluginBridgeError('INVALID_REQUEST')
      }
      const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
      await this.checkSession(session)
      this.requireCurrentSession(session)
      // All replay, ordering and admission decisions are atomic AFTER validation.
      const previous = session.requests.get(request.requestId)
      if (previous) {
        if (previous.sequence !== request.sequence || previous.digest !== digest) {
          throw new FigPluginBridgeError('INVALID_REQUEST')
        }
        // Replay the original prepare receipt; status() owns the current outcome.
        return { ...previous.response }
      }
      if (request.sequence <= session.highWater) throw new FigPluginBridgeError('INVALID_REQUEST')
      const receiptCount = [...this.sessions.values()].reduce(
        (sum, item) => sum + item.requests.size,
        0
      )
      if (
        session.requests.size >= 64 ||
        receiptCount >= 256 ||
        this.calls.size >= 32 ||
        [...this.calls.values()].some((call) => call.session === session && active(call))
      ) {
        throw new FigPluginBridgeError('BUSY')
      }
      const callId = randomBytes(16).toString('hex')
      const expiresAt = Math.min(this.clock() + CALL_TTL, session.expiresAt)
      const response: FigPluginBridgePrepareResponse = {
        protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
        callId,
        status: 'awaiting-approval',
        expiresAt
      }
      const receipt: Receipt = { sequence: request.sequence, digest, response }
      const preview: FigPluginBridgePreview = {
        callId,
        pluginId: session.binding.pluginId,
        host: session.binding.host,
        projectId: session.binding.projectId,
        profileId: session.binding.profileId,
        profileRevision: session.binding.profileRevision,
        context: request.context,
        prompt: request.prompt,
        expiresAt,
        payloadSha256: digest,
        estimatedInputTokens: Math.ceil(Buffer.byteLength(canonical, 'utf8') / 4)
      }
      this.calls.set(callId, {
        session,
        receipt,
        preview,
        status: { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'awaiting-approval' }
      })
      session.requests.set(request.requestId, receipt)
      session.highWater = request.sequence
      this.scheduleCleanup()
      return { ...response }
    } finally {
      // Revocation/expiry cannot free capacity while the old validation is still pending.
      session.preparing -= 1
      this.preparing -= 1
    }
  }

  async status(
    sessionId: string,
    sessionToken: string,
    callId: string
  ): Promise<FigPluginBridgeStatusResponse> {
    const session = this.authenticate(sessionId, sessionToken)
    this.ownedReceipt(session, callId)
    await this.checkSession(session)
    this.requireCurrentSession(session)
    this.ownedReceipt(session, callId)
    const call = this.calls.get(callId)
    return call
      ? { ...call.status }
      : { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'failed', errorCode: 'EXPIRED' }
  }

  async cancel(sessionId: string, sessionToken: string, callId: string): Promise<void> {
    const session = this.authenticate(sessionId, sessionToken)
    this.ownedReceipt(session, callId)
    const call = this.calls.get(callId)
    if (call && active(call)) this.terminate(call, 'CANCELLED')
    this.scheduleCleanup()
  }

  closeSession(sessionId: string, sessionToken: string): void {
    const session = this.authenticate(sessionId, sessionToken)
    this.removeSession(session, 'CANCELLED')
    this.scheduleCleanup()
  }

  listPreviews(): FigPluginBridgePreview[] {
    this.enter()
    return [...this.calls.values()]
      .filter((call) => call.status.status === 'awaiting-approval' && call.preview)
      .map((call) => structuredClone(call.preview!))
  }

  async approve(callId: string, payloadSha256: string): Promise<void> {
    this.enter()
    const call = this.mainCall(callId)
    this.checkApproval(call, payloadSha256)
    await this.checkSession(call.session)
    this.requireCurrentSession(call.session)
    this.checkApproval(call, payloadSha256)
    if (this.executing >= 8) throw new FigPluginBridgeError('BUSY')
    const preview = structuredClone(call.preview!)
    const controller = new AbortController()
    call.controller = controller
    call.deadline = this.clock() + this.callTimeout
    call.status = { protocol: FIGPLUGIN_BRIDGE_PROTOCOL, callId, status: 'running' }
    this.executing += 1
    this.scheduleCleanup()
    // No await between the last lifetime/state check, single-use transition and invoke.
    void this.execute(call, preview, controller)
  }

  deny(callId: string): void {
    this.enter()
    const call = this.mainCall(callId)
    if (active(call)) this.terminate(call, 'DENIED')
    this.scheduleCleanup()
  }

  revokePlugin(pluginId: string): void {
    this.enter()
    for (const [id, ticket] of this.tickets) {
      if (ticket.binding.pluginId === pluginId) this.removeTicket(id, ticket)
    }
    for (const session of this.sessions.values()) {
      if (session.binding.pluginId === pluginId)
        this.removeSession(session, 'CONFIGURATION_CHANGED')
    }
    this.scheduleCleanup()
  }

  /** Synchronous authority notification: no polling, metadata discovery or provider await. */
  revokeInvalidBindings(isCurrent: (binding: FigPluginRuntimeBinding) => boolean): void {
    this.enter()
    const valid = (binding: FigPluginRuntimeBinding): boolean => {
      try {
        return isCurrent(Object.freeze({ ...binding })) === true
      } catch {
        return false
      }
    }
    for (const [id, ticket] of this.tickets) {
      if (!valid(ticket.binding)) this.removeTicket(id, ticket)
    }
    for (const session of this.sessions.values()) {
      if (!valid(session.binding)) this.removeSession(session, 'CONFIGURATION_CHANGED')
    }
    this.scheduleCleanup()
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const [id, ticket] of this.tickets) this.removeTicket(id, ticket)
    for (const session of this.sessions.values()) this.removeSession(session, 'CANCELLED')
    this.failures = []
  }

  listSessions(): Array<{
    sessionId: string
    pluginId: string
    host: FigPluginRuntimeBinding['host']
    projectId: string
    expiresAt: number
    activeCalls: number
  }> {
    this.enter()
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      pluginId: session.binding.pluginId,
      host: session.binding.host,
      projectId: session.binding.projectId,
      expiresAt: session.expiresAt,
      activeCalls: [...this.calls.values()].filter(
        (call) => call.session === session && active(call)
      ).length
    }))
  }

  private enter(): void {
    if (this.closed) throw new FigPluginBridgeError('UNAUTHORIZED')
    this.prune()
  }

  private authenticate(id: string, token: string): Session {
    this.enter()
    const session = isId(id) ? this.sessions.get(id) : undefined
    const matches = secretEquals(token, session?.token)
    if (!session || !matches) throw new FigPluginBridgeError('UNAUTHORIZED')
    session.idleAt = this.clock() + IDLE_TTL
    this.scheduleCleanup()
    return session
  }

  private requireCurrentSession(session: Session): void {
    this.enter()
    if (this.sessions.get(session.id) !== session) throw new FigPluginBridgeError('UNAUTHORIZED')
  }

  private async validate(binding: FigPluginRuntimeBinding): Promise<boolean> {
    try {
      return (await this.validateBinding(Object.freeze({ ...binding }))) === true
    } catch {
      return false
    }
  }

  private async checkSession(session: Session): Promise<void> {
    // Coalesce concurrent checks without allowing a result to outlive its session epoch.
    const validation = session.validation ?? this.validate(session.binding)
    session.validation = validation
    const valid = await validation
    if (session.validation === validation) session.validation = undefined
    this.requireCurrentSession(session)
    if (!valid) {
      this.removeSession(session, 'CONFIGURATION_CHANGED')
      this.scheduleCleanup()
      throw new FigPluginBridgeError('CONFIGURATION_CHANGED')
    }
  }

  private ownedReceipt(session: Session, callId: string): Receipt {
    if (isId(callId)) {
      for (const receipt of session.requests.values()) {
        if (receipt.response.callId === callId) return receipt
      }
    }
    throw new FigPluginBridgeError('UNAUTHORIZED')
  }

  private mainCall(callId: string): Call {
    const call = isId(callId) ? this.calls.get(callId) : undefined
    if (call) return call
    for (const session of this.sessions.values()) {
      for (const receipt of session.requests.values()) {
        if (receipt.response.callId === callId) throw new FigPluginBridgeError('EXPIRED')
      }
    }
    throw new FigPluginBridgeError('INVALID_REQUEST')
  }

  private checkApproval(call: Call, digest: string): void {
    const matches = secretEquals(digest, call.receipt.digest)
    if (this.calls.get(call.receipt.response.callId) !== call)
      throw new FigPluginBridgeError('EXPIRED')
    if (call.status.status !== 'awaiting-approval' || !call.preview || !matches) {
      throw new FigPluginBridgeError('INVALID_REQUEST')
    }
  }

  private running(call: Call): boolean {
    this.prune()
    return (
      !this.closed &&
      this.sessions.get(call.session.id) === call.session &&
      this.calls.get(call.receipt.response.callId) === call &&
      call.status.status === 'running'
    )
  }

  private async execute(
    call: Call,
    preview: FigPluginBridgePreview,
    controller: AbortController
  ): Promise<void> {
    try {
      const value = await this.invoke(
        Object.freeze({ ...call.session.binding }),
        preview,
        controller.signal
      )
      if (!this.running(call)) return
      const result = parseFigPluginBridgeValue(resultSchema, value)
      // A provider/profile change while invoking also invalidates an otherwise good result.
      await this.checkSession(call.session)
      if (!this.running(call)) return
      call.status = {
        protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
        callId: call.receipt.response.callId,
        status: 'completed',
        ...result
      }
      call.preview = undefined
      call.controller = undefined
      call.deadline = undefined
      this.scheduleCleanup()
    } catch (error) {
      const reason =
        error instanceof FigPluginBridgeError &&
        ['TIMEOUT', 'CANCELLED', 'CONFIGURATION_CHANGED'].includes(error.code)
          ? (error.code as 'TIMEOUT' | 'CANCELLED' | 'CONFIGURATION_CHANGED')
          : 'UPSTREAM_FAILED'
      if (this.running(call)) this.terminate(call, reason)
      this.scheduleCleanup()
    } finally {
      // An invoker ignoring abort still occupies a slot until it settles. Releasing
      // on cancellation/timeout would permit unbounded outstanding provider work.
      this.executing -= 1
    }
  }

  private terminate(call: Call, code: TerminalCode): void {
    const controller = call.controller
    call.status = {
      protocol: FIGPLUGIN_BRIDGE_PROTOCOL,
      callId: call.receipt.response.callId,
      status: code === 'CANCELLED' || code === 'DENIED' ? 'cancelled' : 'failed',
      errorCode: code
    }
    call.preview = undefined
    call.controller = undefined
    call.deadline = undefined
    controller?.abort()
  }

  private removeTicket(id: string, ticket: Ticket): void {
    this.tickets.delete(id)
    ticket.secret = ''
  }

  private removeSession(session: Session, code: TerminalCode): void {
    this.sessions.delete(session.id)
    session.token = ''
    session.requests.clear()
    session.validation = undefined
    for (const [id, call] of this.calls) {
      if (call.session === session) {
        this.calls.delete(id)
        this.terminate(call, code)
      }
    }
  }

  private prune(): void {
    if (this.closed) return
    const now = this.clock()
    this.failures = this.failures.filter((time) => time + FAILURE_WINDOW > now)
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.removeTicket(id, ticket)
    }
    for (const session of this.sessions.values()) {
      if (Math.min(session.expiresAt, session.idleAt) <= now) this.removeSession(session, 'EXPIRED')
    }
    for (const [id, call] of this.calls) {
      if (call.receipt.response.expiresAt <= now) {
        this.calls.delete(id)
        this.terminate(call, 'EXPIRED')
      } else if (call.deadline !== undefined && call.deadline <= now) {
        this.terminate(call, 'TIMEOUT')
      }
    }
    this.scheduleCleanup()
  }

  private scheduleCleanup(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.closed) return
    let next = Infinity
    for (const ticket of this.tickets.values()) next = Math.min(next, ticket.expiresAt)
    for (const session of this.sessions.values())
      next = Math.min(next, session.expiresAt, session.idleAt)
    for (const call of this.calls.values())
      next = Math.min(next, call.receipt.response.expiresAt, call.deadline ?? Infinity)
    if (this.failures.length) next = Math.min(next, this.failures[0] + FAILURE_WINDOW)
    if (next === Infinity) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.prune()
      },
      Math.max(1, next - this.clock())
    )
    this.timer.unref()
  }
}
