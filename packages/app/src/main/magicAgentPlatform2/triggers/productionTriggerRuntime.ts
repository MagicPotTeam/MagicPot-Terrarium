import type { PolicyJsonRecord, PolicyRequest } from '../../../shared/magicAgentPlatform2/policy'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import type { MagicAgentEventStore } from '../persistence/eventStore'
import { WorkflowCompletionTriggerSource } from './workflowCompletionTriggerSource'
import { ChannelMessageTriggerSource } from './channelMessageTriggerSource'
import { DriveStateTriggerSource } from './driveStateTriggerSource'
import { ExternalEventTriggerSource } from './externalEventTriggerSource'
import { CalendarCronTriggerSource } from './calendarCronTriggerSource'
import { ProductionTriggerExecutor } from './productionTriggerExecutor'
import { PersistentTriggerScheduler } from './persistentTriggerScheduler'
import { PersistentTriggerStore } from './persistentTriggerStore'
import { StartupTriggerSource } from './startupTriggerSource'
import { TriggerOccurrenceScheduler } from './triggerOccurrenceScheduler'
import { TriggerOccurrenceStore } from './triggerOccurrenceStore'
import { TriggerExecutionOutcomeStore } from './executionOutcomeStore'
import type {
  TriggerAgentDispatchInput,
  TriggerGraphDispatchInput
} from './productionTriggerExecutor'

export type ProductionTriggerRuntimeOptions<TResult> = Readonly<{
  eventStore: MagicAgentEventStore
  authorization: MagicAgentPolicyAuthorizationService
  service: Readonly<{
    runAgent: (input: TriggerAgentDispatchInput) => TResult | Promise<TResult>
    runGraph: (input: TriggerGraphDispatchInput) => TResult | Promise<TResult>
  }>
  grantProvider: (
    request: PolicyRequest
  ) =>
    | { grantId: string; expectedGrantUseCount?: number }
    | undefined
    | Promise<{ grantId: string; expectedGrantUseCount?: number } | undefined>
  routeResolver: (trigger: Parameters<ProductionTriggerExecutor['execute']>[0]) => PolicyJsonRecord
  now?: () => number
  pollInterval?: number
  bootId?: string
}>

export class ProductionTriggerRuntime<TResult = unknown> {
  readonly store: PersistentTriggerStore
  readonly executor: ProductionTriggerExecutor<TResult>
  readonly scheduler: PersistentTriggerScheduler
  readonly outcomes: TriggerExecutionOutcomeStore
  readonly occurrences: TriggerOccurrenceStore
  readonly occurrenceScheduler: TriggerOccurrenceScheduler
  readonly startupSource: StartupTriggerSource
  readonly channelMessageSource: ChannelMessageTriggerSource
  readonly workflowCompletionSource: WorkflowCompletionTriggerSource
  readonly driveStateSource: DriveStateTriggerSource
  readonly calendarCronSource: CalendarCronTriggerSource
  readonly externalEventSource: ExternalEventTriggerSource
  private readonly now: () => number
  private readonly calendarCronPollInterval: number
  private calendarCronTimer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private stopping: Promise<void> | undefined

  constructor(private readonly options: ProductionTriggerRuntimeOptions<TResult>) {
    this.now = options.now ?? Date.now
    this.calendarCronPollInterval = Math.max(1_000, options.pollInterval ?? 1_000)
    this.store = new PersistentTriggerStore(options.eventStore)
    this.outcomes = new TriggerExecutionOutcomeStore(options.eventStore)
    this.occurrences = new TriggerOccurrenceStore(options.eventStore)
    this.startupSource = new StartupTriggerSource(
      this.store,
      this.occurrences,
      options.bootId ?? `runtime:${Date.now()}`,
      options.now
    )
    this.channelMessageSource = new ChannelMessageTriggerSource(this.store, this.occurrences)
    this.workflowCompletionSource = new WorkflowCompletionTriggerSource(
      this.store,
      this.occurrences
    )
    this.driveStateSource = new DriveStateTriggerSource(this.store, this.occurrences)
    this.calendarCronSource = new CalendarCronTriggerSource(this.store, this.occurrences)
    this.externalEventSource = new ExternalEventTriggerSource(this.store, this.occurrences)
    this.executor = new ProductionTriggerExecutor({
      authorizationService: options.authorization,
      grantProvider: options.grantProvider,
      resolveTrustedRoute: options.routeResolver,
      outcomes: this.outcomes,
      dispatch: {
        runAgent: (input) => options.service.runAgent(input),
        runGraph: (input) => options.service.runGraph(input)
      },
      now: options.now
    })
    this.occurrenceScheduler = new TriggerOccurrenceScheduler({
      occurrences: this.occurrences,
      triggers: this.store,
      execute: async (trigger, occurrence) => {
        await this.executor.executeOccurrence(trigger, occurrence)
      },
      pollIntervalMs: options.pollInterval,
      now: options.now
    })
    this.scheduler = new PersistentTriggerScheduler({
      store: this.store,
      execute: async (trigger) => {
        await this.executor.execute(trigger)
      },
      pollIntervalMs: options.pollInterval,
      now: options.now
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.startupSource.enqueue()
    this.calendarCronSource.tick(this.now())
    this.scheduleCalendarCronTick()
    this.scheduler.start()
    this.occurrenceScheduler.start()
  }

  private scheduleCalendarCronTick(): void {
    if (!this.started) return
    this.calendarCronTimer = setTimeout(() => {
      this.calendarCronTimer = undefined
      if (!this.started) return
      this.calendarCronSource.tick(this.now())
      this.scheduleCalendarCronTick()
    }, this.calendarCronPollInterval)
    this.calendarCronTimer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    if (!this.started) return
    this.started = false
    if (this.calendarCronTimer) clearTimeout(this.calendarCronTimer)
    this.calendarCronTimer = undefined
    this.stopping = Promise.all([this.scheduler.stop(), this.occurrenceScheduler.stop()])
      .then(() => undefined)
      .finally(() => {
        this.stopping = undefined
      })
    return this.stopping
  }
}

export const createProductionTriggerRuntime = <TResult>(
  options: ProductionTriggerRuntimeOptions<TResult>
): ProductionTriggerRuntime<TResult> => new ProductionTriggerRuntime(options)
