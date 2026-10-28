/**
 * Owns the lifecycle of the loopback Bridge transport.
 *
 * This is deliberately an in-process supervisor: it gives the Desktop/Main
 * boundary an explicit lifecycle contract without pretending that the current
 * HTTP server is already an independently supervised OS process. A future
 * child-process transport can implement the same start/stop surface.
 */

export type FigPluginBridgeServer = {
  origin: string
  close(): Promise<void>
  /** Optional process-level crash signal. In-process servers do not need it. */
  onCrash?: (listener: () => void) => () => void
}

export type FigPluginBridgeTransportKind = 'in-process' | 'child-process'

export type FigPluginBridgeTransport<TInput extends { origin: string }> = {
  readonly kind: FigPluginBridgeTransportKind
  start(input: TInput): Promise<FigPluginBridgeServer>
}

export type FigPluginBridgeSupervisorState =
  'stopped' | 'starting' | 'ready' | 'stopping' | 'failed'

export type FigPluginBridgeSupervisorFailureCode =
  | 'PORT_IN_USE'
  | 'START_FAILED'
  | 'ORIGIN_MISMATCH'
  | 'STOPPED_DURING_START'
  | 'STOP_FAILED'
  | 'CHILD_CRASHED'
  | 'IPC_HANDSHAKE_FAILED'
  | 'IPC_TIMEOUT'
  | 'IPC_SEND_FAILED'

/**
 * Lifecycle triggers are explicit rather than inferred from every failed
 * start. In particular, config changes and version upgrades may request one
 * bounded restart, while a child crash is surfaced for the caller to decide
 * whether a retry is appropriate.
 */
export type FigPluginBridgeSupervisorLifecycleReason =
  'child-crash' | 'config-change' | 'user-stop' | 'version-upgrade'

export type FigPluginBridgeSupervisorFailure = {
  code: FigPluginBridgeSupervisorFailureCode
  at: number
}

export type FigPluginBridgeSupervisorSnapshot = {
  state: FigPluginBridgeSupervisorState
  transport: FigPluginBridgeTransportKind
  origin?: string
  generation: number
  changedAt: number
  lifecycleReason?: FigPluginBridgeSupervisorLifecycleReason
  failure?: FigPluginBridgeSupervisorFailure
}

export class FigPluginBridgeSupervisorError extends Error {
  readonly code: FigPluginBridgeSupervisorFailureCode

  constructor(code: FigPluginBridgeSupervisorFailureCode) {
    super(`Bridge supervisor ${code.toLowerCase().replaceAll('_', ' ')}.`)
    this.name = 'FigPluginBridgeSupervisorError'
    this.code = code
  }
}

type StartInput = { origin: string }
type Options<TInput extends StartInput> = {
  start?: (input: TInput) => Promise<FigPluginBridgeServer>
  transport?: FigPluginBridgeTransport<TInput>
  now?: () => number
  /** Called after a ready child transport reports a crash. */
  onCrash?: () => void
}

export function createInProcessBridgeTransport<TInput extends StartInput>(
  start: (input: TInput) => Promise<FigPluginBridgeServer>
): FigPluginBridgeTransport<TInput> {
  return { kind: 'in-process', start }
}

const failureCode = (error: unknown): FigPluginBridgeSupervisorFailureCode => {
  if (error instanceof FigPluginBridgeSupervisorError) return error.code
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (code === 'EADDRINUSE') return 'PORT_IN_USE'
    if (
      code === 'CHILD_CRASHED' ||
      code === 'IPC_HANDSHAKE_FAILED' ||
      code === 'IPC_TIMEOUT' ||
      code === 'IPC_SEND_FAILED'
    )
      return code
  }
  return 'START_FAILED'
}

/**
 * Serializes start/stop and records bounded lifecycle diagnostics. The
 * supervisor never exposes the underlying error message: start failures may
 * contain paths, URLs or credentials from a lower transport layer.
 */
export class FigPluginBridgeSupervisor<TInput extends StartInput> {
  readonly #start: NonNullable<Options<TInput>['start']>
  readonly #transportKind: FigPluginBridgeTransportKind
  readonly #now: () => number
  readonly #onCrash?: () => void
  #state: FigPluginBridgeSupervisorState = 'stopped'
  #origin?: string
  #server?: FigPluginBridgeServer
  #starting?: Promise<FigPluginBridgeServer>
  #stopping?: Promise<void>
  #stopRequested = false
  #generation = 0
  #changedAt: number
  #failure?: FigPluginBridgeSupervisorFailure
  #lifecycleReason?: FigPluginBridgeSupervisorLifecycleReason
  #detachCrash?: () => void

  constructor(options: Options<TInput>) {
    if (!options.start && !options.transport) {
      throw new TypeError('Bridge supervisor requires a transport start function.')
    }
    this.#start = options.transport?.start ?? options.start!
    this.#transportKind = options.transport?.kind ?? 'in-process'
    this.#now = options.now ?? Date.now
    this.#onCrash = options.onCrash
    this.#changedAt = this.#now()
  }

  snapshot(): FigPluginBridgeSupervisorSnapshot {
    return {
      state: this.#state,
      transport: this.#transportKind,
      ...(this.#origin ? { origin: this.#origin } : {}),
      generation: this.#generation,
      changedAt: this.#changedAt,
      ...(this.#lifecycleReason ? { lifecycleReason: this.#lifecycleReason } : {}),
      ...(this.#failure ? { failure: { ...this.#failure } } : {})
    }
  }

  start(input: TInput): Promise<FigPluginBridgeServer> {
    const origin = input.origin
    if (this.#origin !== undefined && this.#origin !== origin) {
      const error = new FigPluginBridgeSupervisorError('ORIGIN_MISMATCH')
      this.recordFailure(error.code)
      return Promise.reject(error)
    }
    if (this.#state === 'stopping' || this.#stopping) {
      return Promise.reject(new FigPluginBridgeSupervisorError('STOPPED_DURING_START'))
    }
    // A failed close may leave the old listener alive. Do not launch a second
    // transport until a later stop() retry has actually closed it.
    if (this.#state === 'failed' && this.#server) {
      return Promise.reject(new FigPluginBridgeSupervisorError('STOP_FAILED'))
    }
    if (this.#state === 'ready' && this.#server) return Promise.resolve(this.#server)
    if (this.#state === 'starting' && this.#starting) return this.#starting

    // Pin the origin for the lifetime of this supervisor. A failed bind may
    // be retried on the same signed origin, but never switches ports silently.
    this.#origin ??= origin
    this.#stopRequested = false
    this.#failure = undefined
    this.transition('starting')
    this.#generation += 1
    const pending = Promise.resolve()
      .then(() => this.#start(input))
      .then(async (server) => {
        if (!server || server.origin !== origin) {
          return this.closeForStartup(server, 'ORIGIN_MISMATCH')
        }
        if (this.#stopRequested || this.#state === 'stopping') {
          return this.closeForStartup(server, 'STOPPED_DURING_START')
        }
        this.#server = server
        this.#detachCrash = server.onCrash?.(() => this.markCrashed(server))
        this.transition('ready')
        return server
      })
      .catch((error: unknown) => {
        this.#detachCrash?.()
        this.#detachCrash = undefined
        const stopping = this.#stopRequested || this.#state === 'stopping'
        const retainedServer = this.#server
        const code = retainedServer
          ? 'STOP_FAILED'
          : stopping
            ? 'STOPPED_DURING_START'
            : failureCode(error)
        this.#failure = { code, at: this.#now() }
        if (stopping && !retainedServer) {
          this.transition('stopped')
          throw new FigPluginBridgeSupervisorError(code)
        } else {
          this.transition('failed')
        }
        throw error
      })
      .finally(() => {
        this.#starting = undefined
      })
    this.#starting = pending
    return pending
  }

  /**
   * Stop the current transport. This never starts a replacement. Callers may
   * record why the stop happened so diagnostics distinguish a user stop from
   * a configuration or version transition.
   */
  stop(reason: FigPluginBridgeSupervisorLifecycleReason = 'user-stop'): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.#lifecycleReason = reason
    if (this.#state === 'stopped' && !this.#starting && !this.#server) return Promise.resolve()
    this.#stopRequested = true
    this.transition('stopping')
    const pending = this.#starting
    this.#stopping = (async () => {
      let server = this.#server
      if (pending) {
        try {
          server = await pending
        } catch {
          // A failed startup close may retain the listener for a safe retry.
          server = this.#server
        }
      }
      if (server) await server.close()
      this.#detachCrash?.()
      this.#detachCrash = undefined
      this.#server = undefined
      this.transition('stopped')
    })()
      .catch((error: unknown) => {
        this.#failure = { code: 'STOP_FAILED', at: this.#now() }
        this.transition('failed')
        throw error
      })
      .finally(() => {
        this.#stopping = undefined
      })
    return this.#stopping
  }

  /**
   * Explicitly replace a transport after a lifecycle transition. Restart is
   * intentionally opt-in and serialized through stop/start; there is no
   * crash-looping background retry policy.
   */
  async restart(
    input: TInput,
    reason: Exclude<FigPluginBridgeSupervisorLifecycleReason, 'user-stop'>
  ): Promise<FigPluginBridgeServer> {
    // Never take down a healthy signed listener for a request that would be
    // rejected by the lifetime origin pin anyway.
    if (this.#origin !== undefined && this.#origin !== input.origin) {
      this.recordFailure('ORIGIN_MISMATCH')
      throw new FigPluginBridgeSupervisorError('ORIGIN_MISMATCH')
    }
    if (this.#starting || this.#state === 'starting' || this.#state === 'stopping') {
      throw new FigPluginBridgeSupervisorError('STOPPED_DURING_START')
    }
    this.#lifecycleReason = reason
    await this.stop(reason)
    return this.start(input)
  }

  private transition(state: FigPluginBridgeSupervisorState): void {
    this.#state = state
    this.#changedAt = this.#now()
  }

  private markCrashed(server: FigPluginBridgeServer): void {
    if (this.#server !== server || this.#state !== 'ready') return
    this.#detachCrash?.()
    this.#detachCrash = undefined
    // Retain the server handle until an explicit stop observes native exit.
    // IPC errors can precede process exit; dropping it here would allow a
    // replacement listener while the old child is still alive.
    this.#lifecycleReason = 'child-crash'
    this.#failure = { code: 'CHILD_CRASHED', at: this.#now() }
    this.transition('failed')
    // Revocation is a security boundary, not a restart policy. A callback is
    // deliberately best-effort so a cleanup failure cannot escape an IPC
    // event handler and turn into an unhandled process error.
    try {
      this.#onCrash?.()
    } catch {
      // The supervisor remains failed; callers must explicitly restart it.
    }
  }

  private recordFailure(code: FigPluginBridgeSupervisorFailureCode): void {
    this.#failure = { code, at: this.#now() }
    // A rejected origin is an attempted transition, not a transport failure.
    // Keep a healthy ready/stopping state usable while retaining the bounded
    // diagnostic for the caller that supplied the wrong origin.
    this.#changedAt = this.#failure.at
  }

  private async closeForStartup(
    server: FigPluginBridgeServer | undefined,
    code: 'ORIGIN_MISMATCH' | 'STOPPED_DURING_START'
  ): Promise<never> {
    if (!server) throw new FigPluginBridgeSupervisorError(code)
    try {
      await server.close()
    } catch {
      // Retain an unclosed listener and force a later stop retry before any
      // new transport can be launched.
      this.#server = server
      throw new FigPluginBridgeSupervisorError('STOP_FAILED')
    }
    throw new FigPluginBridgeSupervisorError(code)
  }
}
