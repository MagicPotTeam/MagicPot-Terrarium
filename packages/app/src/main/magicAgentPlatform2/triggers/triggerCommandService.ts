import {
  parseCalendarInstant,
  parseCronSchedule
} from '../../../shared/magicAgentPlatform2/cronSchedule'
import {
  validateMagicAgentTriggerSpec,
  type MagicAgentTriggerSpec
} from '@shared/magicAgent/triggers'
import type { StoredResource } from '../persistence'
import type {
  PersistentTriggerSchedule,
  PersistentTriggerState,
  PersistentTriggerStore
} from './persistentTriggerStore'
import type { ProductionTriggerRuntime } from './productionTriggerRuntime'
import type { TriggerOccurrenceState } from './triggerOccurrenceStore'

export type TriggerCommandServiceRuntime = Pick<ProductionTriggerRuntime, 'store' | 'occurrences'>
export type TriggerControlCommand = Readonly<{
  triggerId: string
  expectedTriggerRevision: number
  idempotencyKey: string
  requestedAt: number
}>

export type TriggerCreateCommand = Readonly<{
  trigger: unknown
  schedule?: unknown
  nextFireAt?: number
  createdAt: number
  idempotencyKey: string
}>
export type TriggerUpdateCommand = Readonly<{
  triggerId: string
  expectedTriggerRevision: number
  idempotencyKey: string
  requestedAt: number
  patch: Readonly<{ title?: string; enabled?: boolean; config?: Record<string, unknown> }>
}>

export type ManualFireCommand = Readonly<{
  triggerId: string
  expectedTriggerRevision: number
  occurrenceId: string
  requestedAt: number
  scheduledAt?: number
  idempotencyKey: string
  payloadDigest?: string
}>

export class TriggerCommandError extends Error {
  constructor(
    readonly code: 'not-found' | 'revision-conflict' | 'invalid-state' | 'invalid-command',
    message: string
  ) {
    super(message)
    this.name = 'TriggerCommandError'
  }
}
const keys = new Set([
  'triggerId',
  'expectedTriggerRevision',
  'occurrenceId',
  'requestedAt',
  'scheduledAt',
  'idempotencyKey',
  'payloadDigest'
])
const required = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TriggerCommandError('invalid-command', `${name} must be non-empty.`)
  return value
}
const finite = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TriggerCommandError('invalid-command', `${name} must be finite.`)
  return value
}
const nonnegative = (value: number, name: string): number => {
  if (value < 0) throw new TriggerCommandError('invalid-command', `${name} must be non-negative.`)
  return value
}
const plain = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TriggerCommandError('invalid-command', `${name} must be a plain object.`)
  return value as Record<string, unknown>
}
const allowed = (value: Record<string, unknown>, allowlist: ReadonlySet<string>): void => {
  for (const field of Object.keys(value))
    if (!allowlist.has(field))
      throw new TriggerCommandError('invalid-command', `Unknown command field: ${field}.`)
}

const validateCreateSchedule = (value: unknown): PersistentTriggerSchedule => {
  const schedule = plain(value, 'schedule')
  allowed(schedule, new Set(['type', 'intervalMs', 'missedRunPolicy', 'maxCatchUpRuns']))
  if (schedule.type !== 'interval')
    throw new TriggerCommandError('invalid-command', 'schedule.type must be interval.')
  const intervalMs = finite(schedule.intervalMs, 'schedule.intervalMs')
  if (!Number.isInteger(intervalMs) || intervalMs <= 0)
    throw new TriggerCommandError(
      'invalid-command',
      'schedule.intervalMs must be a positive integer.'
    )
  const missedRunPolicy = schedule.missedRunPolicy
  if (
    missedRunPolicy !== undefined &&
    missedRunPolicy !== 'skip' &&
    missedRunPolicy !== 'run-once' &&
    missedRunPolicy !== 'catch-up'
  )
    throw new TriggerCommandError('invalid-command', 'schedule.missedRunPolicy is invalid.')
  if (missedRunPolicy === 'catch-up') {
    if (!Number.isInteger(schedule.maxCatchUpRuns) || Number(schedule.maxCatchUpRuns) <= 0)
      throw new TriggerCommandError(
        'invalid-command',
        'schedule.maxCatchUpRuns must be a positive integer.'
      )
  } else if (schedule.maxCatchUpRuns !== undefined) {
    throw new TriggerCommandError(
      'invalid-command',
      'schedule.maxCatchUpRuns is only valid for catch-up.'
    )
  }
  return {
    type: 'interval',
    intervalMs,
    ...(missedRunPolicy === undefined ? {} : { missedRunPolicy }),
    ...(schedule.maxCatchUpRuns === undefined
      ? {}
      : { maxCatchUpRuns: Number(schedule.maxCatchUpRuns) })
  }
}

const validateCreateCommand = (
  input: TriggerCreateCommand
): Readonly<{
  trigger: MagicAgentTriggerSpec
  schedule?: PersistentTriggerSchedule
  nextFireAt?: number
  createdAt: number
  idempotencyKey: string
}> => {
  const command = plain(input, 'command')
  allowed(command, new Set(['trigger', 'schedule', 'nextFireAt', 'createdAt', 'idempotencyKey']))
  const validated = validateMagicAgentTriggerSpec(command.trigger)
  if (!validated.ok) throw new TriggerCommandError('invalid-command', 'trigger is invalid.')
  if (
    validated.value.type !== 'schedule' &&
    validated.value.type !== 'startup' &&
    validated.value.type !== 'message' &&
    validated.value.type !== 'event'
  )
    throw new TriggerCommandError(
      'invalid-command',
      'trigger.type must be schedule, startup, message, or event.'
    )
  const createdAt = nonnegative(finite(command.createdAt, 'createdAt'), 'createdAt')
  if (validated.value.type !== 'schedule') {
    if (command.schedule !== undefined || command.nextFireAt !== undefined)
      throw new TriggerCommandError(
        'invalid-command',
        'source Trigger must not define schedule or nextFireAt.'
      )
    if (validated.value.type === 'event') {
      const config = validated.value.config ?? {}
      if (config['sourceKind'] === 'calendar') {
        if (typeof config['startAt'] !== 'string')
          throw new TriggerCommandError('invalid-command', 'calendar startAt is required.')
        try {
          parseCalendarInstant(config['startAt'])
        } catch (error) {
          throw new TriggerCommandError('invalid-command', String(error))
        }
      } else if (config['sourceKind'] === 'cron') {
        if (typeof config['cron'] !== 'string')
          throw new TriggerCommandError('invalid-command', 'cron expression is required.')
        if (
          config['maxCatchUpRuns'] !== undefined &&
          (!Number.isInteger(config['maxCatchUpRuns']) || Number(config['maxCatchUpRuns']) <= 0)
        )
          throw new TriggerCommandError(
            'invalid-command',
            'maxCatchUpRuns must be a positive integer.'
          )
        try {
          parseCronSchedule(
            config['cron'],
            typeof config['timeZone'] === 'string' ? config['timeZone'] : 'UTC'
          )
          if (config['startAt'] !== undefined) {
            if (typeof config['startAt'] !== 'string')
              throw new Error('cron startAt must be a string.')
            parseCalendarInstant(config['startAt'])
          }
        } catch (error) {
          throw new TriggerCommandError('invalid-command', String(error))
        }
      } else if (config['sourceKind'] === 'drive-state') {
        if (
          config['driveId'] !== undefined &&
          (typeof config['driveId'] !== 'string' || !config['driveId'].trim())
        )
          throw new TriggerCommandError('invalid-command', 'drive-state driveId must be non-empty.')
        const statuses = new Set([
          'draft',
          'active',
          'waiting',
          'paused',
          'completed',
          'failed',
          'cancelled'
        ])
        if (config['status'] !== undefined && !statuses.has(String(config['status'])))
          throw new TriggerCommandError('invalid-command', 'drive-state status is invalid.')
        if (config['driveId'] === undefined && config['status'] === undefined)
          throw new TriggerCommandError(
            'invalid-command',
            'drive-state requires driveId or status.'
          )
      }
    }
    return {
      trigger: validated.value,
      createdAt,
      idempotencyKey: required(command.idempotencyKey, 'idempotencyKey')
    }
  }
  if (command.schedule === undefined || command.nextFireAt === undefined)
    throw new TriggerCommandError(
      'invalid-command',
      'schedule Trigger requires schedule and nextFireAt.'
    )
  const nextFireAt = nonnegative(finite(command.nextFireAt, 'nextFireAt'), 'nextFireAt')
  if (nextFireAt < createdAt)
    throw new TriggerCommandError('invalid-command', 'nextFireAt must not precede createdAt.')
  return {
    trigger: validated.value,
    schedule: validateCreateSchedule(command.schedule),
    nextFireAt,
    createdAt,
    idempotencyKey: required(command.idempotencyKey, 'idempotencyKey')
  }
}

export class TriggerCommandService {
  constructor(private readonly runtime: TriggerCommandServiceRuntime) {}
  listTriggers(): readonly StoredResource<PersistentTriggerState>[] {
    return this.runtime.store.list()
  }
  getTrigger(triggerId: string): StoredResource<PersistentTriggerState> | undefined {
    return this.runtime.store.get(triggerId)
  }

  enable(input: TriggerControlCommand): StoredResource<PersistentTriggerState> {
    return this.control(input, 'enabled', true)
  }
  disable(input: TriggerControlCommand): StoredResource<PersistentTriggerState> {
    return this.control(input, 'enabled', false)
  }
  pause(input: TriggerControlCommand): StoredResource<PersistentTriggerState> {
    return this.control(input, 'paused', true)
  }
  resume(input: TriggerControlCommand): StoredResource<PersistentTriggerState> {
    return this.control(input, 'paused', false)
  }
  createTrigger(input: TriggerCreateCommand): StoredResource<PersistentTriggerState> {
    const command = validateCreateCommand(input)
    let state: PersistentTriggerState
    if (command.trigger.type === 'schedule') {
      state = {
        ...command.trigger,
        type: 'schedule',
        schedule: command.schedule!,
        nextFireAt: command.nextFireAt!,
        paused: false
      }
    } else if (command.trigger.type === 'startup') {
      state = { ...command.trigger, type: 'startup', paused: false }
    } else if (command.trigger.type === 'message') {
      state = { ...command.trigger, type: 'message', paused: false }
    } else {
      state = { ...command.trigger, type: 'event', paused: false }
    }
    try {
      return this.runtime.store.create(state, command.createdAt, command.idempotencyKey)
    } catch (error) {
      throw this.mapStoreError(error)
    }
  }
  update(input: TriggerUpdateCommand): StoredResource<PersistentTriggerState> {
    this.validateUpdate(input)
    try {
      return this.runtime.store.update({
        triggerId: input.triggerId,
        expectedRevision: input.expectedTriggerRevision,
        idempotencyKey: input.idempotencyKey,
        updatedAt: input.requestedAt,
        patch: input.patch
      })
    } catch (error) {
      throw this.mapStoreError(error)
    }
  }
  retry(input: TriggerControlCommand): StoredResource<PersistentTriggerState> {
    return this.invoke(input, (command) =>
      this.runtime.store.retry({
        triggerId: command.triggerId,
        expectedRevision: command.expectedTriggerRevision,
        idempotencyKey: command.idempotencyKey,
        requestedAt: command.requestedAt
      })
    )
  }
  private control(
    input: TriggerControlCommand,
    field: 'enabled' | 'paused',
    value: boolean
  ): StoredResource<PersistentTriggerState> {
    return this.invoke(input, (command) =>
      field === 'enabled'
        ? this.runtime.store.setEnabled({
            triggerId: command.triggerId,
            enabled: value,
            expectedRevision: command.expectedTriggerRevision,
            idempotencyKey: command.idempotencyKey,
            changedAt: command.requestedAt
          })
        : this.runtime.store.setPaused({
            triggerId: command.triggerId,
            paused: value,
            expectedRevision: command.expectedTriggerRevision,
            idempotencyKey: command.idempotencyKey,
            changedAt: command.requestedAt
          })
    )
  }
  private invoke<T>(
    input: TriggerControlCommand,
    operation: (command: TriggerControlCommand) => T
  ): T {
    this.validateControl(input)
    try {
      return operation(input)
    } catch (error) {
      throw this.mapStoreError(error)
    }
  }
  private validateUpdate(input: TriggerUpdateCommand): void {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      throw new TriggerCommandError('invalid-command', 'Update command must be an object.')
    const allowed = new Set([
      'triggerId',
      'expectedTriggerRevision',
      'idempotencyKey',
      'requestedAt',
      'patch'
    ])
    for (const key of Object.keys(input as object))
      if (!allowed.has(key))
        throw new TriggerCommandError('invalid-command', `Unknown command field: ${key}`)
    required(input.triggerId, 'triggerId')
    required(input.idempotencyKey, 'idempotencyKey')
    const revision = finite(input.expectedTriggerRevision, 'expectedTriggerRevision')
    if (!Number.isInteger(revision) || revision < 0)
      throw new TriggerCommandError('invalid-command', 'Revision must be a nonnegative integer.')
    const requestedAt = finite(input.requestedAt, 'requestedAt')
    if (requestedAt < 0)
      throw new TriggerCommandError('invalid-command', 'requestedAt must be nonnegative.')
    if (input.patch === null || typeof input.patch !== 'object' || Array.isArray(input.patch))
      throw new TriggerCommandError('invalid-command', 'Update patch must be an object.')
    const patch = input.patch as Record<string, unknown>
    const patchKeys = new Set(['title', 'enabled', 'config'])
    if (Object.keys(patch).length === 0)
      throw new TriggerCommandError('invalid-command', 'Update patch must not be empty.')
    for (const key of Object.keys(patch))
      if (!patchKeys.has(key))
        throw new TriggerCommandError('invalid-command', `Unknown update field: ${key}`)
    if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim() === ''))
      throw new TriggerCommandError('invalid-command', 'title must be non-empty.')
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
      throw new TriggerCommandError('invalid-command', 'enabled must be boolean.')
    if (
      patch.config !== undefined &&
      (patch.config === null || typeof patch.config !== 'object' || Array.isArray(patch.config))
    )
      throw new TriggerCommandError('invalid-command', 'config must be an object.')
  }
  private validateControl(input: TriggerControlCommand): void {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      throw new TriggerCommandError('invalid-command', 'Control command must be an object.')
    for (const key of Object.keys(input as object))
      if (
        !new Set(['triggerId', 'expectedTriggerRevision', 'idempotencyKey', 'requestedAt']).has(key)
      )
        throw new TriggerCommandError('invalid-command', `Unknown command field: ${key}`)
    required(input.triggerId, 'triggerId')
    required(input.idempotencyKey, 'idempotencyKey')
    const revision = finite(input.expectedTriggerRevision, 'expectedTriggerRevision')
    if (!Number.isInteger(revision) || revision < 0)
      throw new TriggerCommandError('invalid-command', 'Revision must be a nonnegative integer.')
    const requestedAt = finite(input.requestedAt, 'requestedAt')
    if (requestedAt < 0)
      throw new TriggerCommandError('invalid-command', 'requestedAt must be nonnegative.')
  }
  private mapStoreError(error: unknown): TriggerCommandError {
    const message = error instanceof Error ? error.message : String(error)
    if (/not found/i.test(message)) return new TriggerCommandError('not-found', message)
    if (/revision conflict/i.test(message))
      return new TriggerCommandError('revision-conflict', message)
    if (/no failure|active.*claim/i.test(message))
      return new TriggerCommandError('invalid-state', message)
    return new TriggerCommandError('invalid-command', message)
  }

  manualFire(input: ManualFireCommand): StoredResource<TriggerOccurrenceState> {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      throw new TriggerCommandError('invalid-command', 'Manual fire command must be an object.')
    const candidate = input as unknown as Record<string, unknown>
    for (const key of Object.keys(candidate))
      if (!keys.has(key))
        throw new TriggerCommandError('invalid-command', `Unknown command field: ${key}`)
    const expectedRevision = finite(input.expectedTriggerRevision, 'expectedTriggerRevision')
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
      throw new TriggerCommandError(
        'invalid-command',
        'expectedTriggerRevision must be a nonnegative integer.'
      )
    const triggerId = required(input.triggerId, 'triggerId')
    const trigger = this.runtime.store.get(triggerId)
    if (!trigger) throw new TriggerCommandError('not-found', `Trigger not found: ${triggerId}`)
    if (trigger.revision !== expectedRevision)
      throw new TriggerCommandError('revision-conflict', 'Trigger revision does not match.')
    if (!trigger.state.enabled)
      throw new TriggerCommandError('invalid-state', 'Disabled triggers cannot be manually fired.')
    const occurrenceId = required(input.occurrenceId, 'occurrenceId')
    const idempotencyKey = required(input.idempotencyKey, 'idempotencyKey')
    const requestedAt = finite(input.requestedAt, 'requestedAt')
    if (input.requestedAt < 0)
      throw new TriggerCommandError('invalid-command', 'requestedAt must be nonnegative.')
    const scheduledAt =
      input.scheduledAt === undefined ? requestedAt : finite(input.scheduledAt, 'scheduledAt')
    if (scheduledAt < 0)
      throw new TriggerCommandError('invalid-command', 'scheduledAt must be nonnegative.')
    if (
      input.payloadDigest !== undefined &&
      !/^[a-f0-9]{64}$/i.test(required(input.payloadDigest, 'payloadDigest'))
    )
      throw new TriggerCommandError(
        'invalid-command',
        'payloadDigest must be non-empty hexadecimal.'
      )
    return this.runtime.occurrences.enqueueManual({
      triggerId,
      occurrenceId,
      requestedAt,
      scheduledAt,
      idempotencyKey,
      ...(input.payloadDigest === undefined ? {} : { payloadDigest: input.payloadDigest })
    })
  }
}
