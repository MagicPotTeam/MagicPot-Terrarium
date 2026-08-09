import {
  MAX_LAUNCH_ATTEMPT,
  isValidBuildId,
  isValidRuntimeId
} from '../../shared/appUpdate/launcherProtocol'
import {
  createLauncherStateStore,
  type LauncherStateFileSystem,
  type LauncherStateStore
} from './launcherStateStore'

export const LAUNCHER_HEALTH_SCHEMA = 1 as const
export const MAX_LAUNCH_TOKEN_LENGTH = 256

export interface PendingLauncherHealthV1 {
  buildId: string
  runtimeId: string
  launchToken: string
  attemptCount: number
  startedAt: string
  deadline: string
}

export interface LauncherHealthConfirmationV1 {
  buildId: string
  runtimeId: string
  launchToken: string
  confirmedAt: string
}

export interface LauncherHealthStateV1 {
  schema: 1
  failedAttemptCount: number
  pending?: PendingLauncherHealthV1
  lastHealthy?: LauncherHealthConfirmationV1
}

export interface LauncherHealthOptions {
  filePath: string
  rollbackThreshold: number
  fileSystem?: LauncherStateFileSystem
  now?: () => Date
  uniqueId?: () => string
  withLock?: <T>(operation: () => Promise<T>) => Promise<T>
}

export interface BeginPendingLaunchInput {
  buildId: string
  runtimeId: string
  launchToken: string
  deadline: Date | string
}

export interface PendingLaunchIdentity {
  buildId: string
  runtimeId: string
  launchToken: string
}

export interface RecordFailedOrExpiredInput extends PendingLaunchIdentity {
  reason: 'failed' | 'expired'
}

export interface LauncherHealthMutationResult {
  accepted: boolean
  shouldRollback: boolean
  state: LauncherHealthStateV1
}

const operationQueues = new Map<string, Promise<void>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

function isAttemptCount(value: unknown, allowZero: boolean): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= (allowZero ? 0 : 1) &&
    (value as number) <= MAX_LAUNCH_ATTEMPT
  )
}

function isUtcIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

export function isValidLaunchToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LAUNCH_TOKEN_LENGTH &&
    value.trim().length > 0
  )
}

export function isLauncherHealthStateV1(value: unknown): value is LauncherHealthStateV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['schema', 'failedAttemptCount'], ['pending', 'lastHealthy']) ||
    value.schema !== LAUNCHER_HEALTH_SCHEMA ||
    !isAttemptCount(value.failedAttemptCount, true)
  )
    return false
  if (value.lastHealthy !== undefined) {
    if (
      !isRecord(value.lastHealthy) ||
      !hasOnlyKeys(value.lastHealthy, ['buildId', 'runtimeId', 'launchToken', 'confirmedAt']) ||
      !isValidBuildId(value.lastHealthy.buildId) ||
      !isValidRuntimeId(value.lastHealthy.runtimeId) ||
      !isValidLaunchToken(value.lastHealthy.launchToken) ||
      !isUtcIsoTimestamp(value.lastHealthy.confirmedAt)
    )
      return false
  }
  if (value.pending === undefined) return true
  if (
    !isRecord(value.pending) ||
    !hasOnlyKeys(value.pending, [
      'buildId',
      'runtimeId',
      'launchToken',
      'attemptCount',
      'startedAt',
      'deadline'
    ])
  )
    return false
  return (
    isValidBuildId(value.pending.buildId) &&
    isValidRuntimeId(value.pending.runtimeId) &&
    isValidLaunchToken(value.pending.launchToken) &&
    isAttemptCount(value.pending.attemptCount, false) &&
    value.pending.attemptCount === value.failedAttemptCount + 1 &&
    isUtcIsoTimestamp(value.pending.startedAt) &&
    isUtcIsoTimestamp(value.pending.deadline) &&
    Date.parse(value.pending.deadline) > Date.parse(value.pending.startedAt)
  )
}

export function parseLauncherHealthState(text: string): LauncherHealthStateV1 {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new TypeError(
      `launcher health state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isLauncherHealthStateV1(value))
    throw new TypeError('launcher health state does not match schema 1')
  return value
}

export function serializeLauncherHealthState(value: LauncherHealthStateV1): string {
  const serialized = JSON.stringify(value, (_key, item) => (item === null ? undefined : item), 2)
  const normalized: unknown = JSON.parse(serialized)
  if (!isLauncherHealthStateV1(normalized))
    throw new TypeError('launcher health state does not match schema 1')
  return `${serialized}\n`
}

function emptyState(): LauncherHealthStateV1 {
  return { schema: LAUNCHER_HEALTH_SCHEMA, failedAttemptCount: 0 }
}

export class LauncherHealth {
  readonly filePath: string
  private readonly rollbackThreshold: number
  private readonly now: () => Date
  private readonly store: LauncherStateStore<LauncherHealthStateV1>
  private readonly withLock: <T>(operation: () => Promise<T>) => Promise<T>

  constructor(options: LauncherHealthOptions) {
    if (
      !Number.isSafeInteger(options.rollbackThreshold) ||
      options.rollbackThreshold < 1 ||
      options.rollbackThreshold > MAX_LAUNCH_ATTEMPT
    )
      throw new TypeError('Launcher health rollbackThreshold is invalid')
    this.rollbackThreshold = options.rollbackThreshold
    this.now = options.now ?? (() => new Date())
    this.withLock = options.withLock ?? (async (operation) => operation())
    this.store = createLauncherStateStore({
      filePath: options.filePath,
      parse: parseLauncherHealthState,
      serialize: serializeLauncherHealthState,
      fileSystem: options.fileSystem,
      now: this.now,
      uniqueId: options.uniqueId
    })
    this.filePath = this.store.filePath
  }

  load(): Promise<LauncherHealthStateV1> {
    return this.enqueue(() => this.store.load(emptyState()))
  }

  reset(): Promise<LauncherHealthStateV1> {
    return this.enqueue(async () => {
      const state = emptyState()
      await this.store.save(state)
      return state
    })
  }

  beginPendingLaunch(input: BeginPendingLaunchInput): Promise<LauncherHealthStateV1> {
    return this.enqueue(async () => {
      if (!isValidBuildId(input.buildId)) throw new TypeError('Invalid launcher build ID')
      if (!isValidRuntimeId(input.runtimeId)) throw new TypeError('Invalid launcher runtime ID')
      if (!isValidLaunchToken(input.launchToken))
        throw new TypeError('Invalid launcher launch token')
      const startedAt = this.now().toISOString()
      const deadline = this.toDeadline(input.deadline)
      if (Date.parse(deadline) <= Date.parse(startedAt))
        throw new TypeError('Launcher health deadline must be after startedAt')
      const current = await this.store.load(emptyState())
      if (current.pending && Date.parse(current.pending.deadline) > this.now().getTime())
        throw new Error('Another launcher health check is already pending')
      if (current.failedAttemptCount >= MAX_LAUNCH_ATTEMPT)
        throw new RangeError('Launcher health attempt count limit reached')
      const state: LauncherHealthStateV1 = {
        schema: LAUNCHER_HEALTH_SCHEMA,
        failedAttemptCount: current.failedAttemptCount,
        pending: {
          buildId: input.buildId,
          runtimeId: input.runtimeId,
          launchToken: input.launchToken,
          attemptCount: current.failedAttemptCount + 1,
          startedAt,
          deadline
        }
      }
      await this.store.save(state)
      return state
    })
  }

  confirmHealthy(input: PendingLaunchIdentity): Promise<LauncherHealthMutationResult> {
    return this.enqueue(async () => {
      this.validateIdentity(input)
      const current = await this.store.load(emptyState())
      const confirmedAt = this.now().toISOString()
      if (
        !this.matches(current, input) ||
        Date.parse(confirmedAt) < Date.parse(current.pending!.startedAt) ||
        Date.parse(confirmedAt) >= Date.parse(current.pending!.deadline)
      )
        return this.result(false, current)
      const state: LauncherHealthStateV1 = {
        schema: LAUNCHER_HEALTH_SCHEMA,
        failedAttemptCount: 0,
        lastHealthy: {
          buildId: current.pending!.buildId,
          runtimeId: current.pending!.runtimeId,
          launchToken: current.pending!.launchToken,
          confirmedAt
        }
      }
      await this.store.save(state)
      return this.result(true, state)
    })
  }

  recordFailedOrExpired(input: RecordFailedOrExpiredInput): Promise<LauncherHealthMutationResult> {
    return this.enqueue(async () => {
      this.validateIdentity(input)
      const current = await this.store.load(emptyState())
      if (!this.matches(current, input)) return this.result(false, current)
      if (
        input.reason === 'expired' &&
        this.now().getTime() < Date.parse(current.pending!.deadline)
      )
        return this.result(false, current)
      const state: LauncherHealthStateV1 = {
        schema: LAUNCHER_HEALTH_SCHEMA,
        failedAttemptCount: current.pending!.attemptCount
      }
      await this.store.save(state)
      return this.result(true, state)
    })
  }

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const previous = operationQueues.get(this.filePath) ?? Promise.resolve()
    const lockedOperation = () => this.withLock(operation)
    const result = previous.then(lockedOperation)
    const next = result.then(
      () => undefined,
      () => undefined
    )
    operationQueues.set(this.filePath, next)
    void next.finally(() => {
      if (operationQueues.get(this.filePath) === next) operationQueues.delete(this.filePath)
    })
    return result
  }

  private toDeadline(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) throw new TypeError('Invalid launcher health deadline')
    return date.toISOString()
  }

  private validateIdentity(input: PendingLaunchIdentity): void {
    if (!isValidBuildId(input.buildId)) throw new TypeError('Invalid launcher build ID')
    if (!isValidRuntimeId(input.runtimeId)) throw new TypeError('Invalid launcher runtime ID')
    if (!isValidLaunchToken(input.launchToken)) throw new TypeError('Invalid launcher launch token')
  }

  private matches(state: LauncherHealthStateV1, input: PendingLaunchIdentity): boolean {
    return (
      state.pending?.buildId === input.buildId &&
      state.pending.runtimeId === input.runtimeId &&
      state.pending.launchToken === input.launchToken
    )
  }

  private result(accepted: boolean, state: LauncherHealthStateV1): LauncherHealthMutationResult {
    return {
      accepted,
      shouldRollback: state.failedAttemptCount >= this.rollbackThreshold,
      state
    }
  }
}

export function createLauncherHealth(options: LauncherHealthOptions): LauncherHealth {
  return new LauncherHealth(options)
}
