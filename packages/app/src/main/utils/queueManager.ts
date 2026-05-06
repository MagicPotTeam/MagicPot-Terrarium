export type QueueSource<T> = {
  next: () => T | null | undefined
  done: (item: T) => void
  error: (item: T, error: unknown) => void
  queueLength: () => number
}

const summarizeQueueItemForLog = (item: unknown): unknown => {
  if (item === null || item === undefined || typeof item !== 'object') {
    return item
  }

  const record = item as Record<string, unknown>
  const summary: Record<string, unknown> = {}
  for (const key of ['id', 'type', 'prompt_id', 'client_id']) {
    const value = record[key]
    if (value !== undefined && value !== null) {
      summary[key] = value
    }
  }

  if (record.payload && typeof record.payload === 'object') {
    summary.payloadNodeCount = Object.keys(record.payload as Record<string, unknown>).length
  }

  if (record.result && typeof record.result === 'object') {
    const resultRecord = record.result as Record<string, unknown>
    const status = resultRecord.status
    const outputs = resultRecord.outputs
    if (status && typeof status === 'object') {
      const statusRecord = status as Record<string, unknown>
      if (typeof statusRecord.status_str === 'string') {
        summary.resultStatus = statusRecord.status_str
      }
      if (Array.isArray(statusRecord.messages)) {
        summary.resultMessageCount = statusRecord.messages.length
      }
    }
    if (outputs && typeof outputs === 'object') {
      summary.resultOutputCount = Object.keys(outputs as Record<string, unknown>).length
    }
  }

  if (Object.keys(summary).length > 0) {
    return summary
  }

  return '[object]'
}

const shouldLogQueueError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return true
  }

  const record = error as Record<string, unknown>
  const name = record.name
  if (name === 'AbortError' || name === 'TaskCancelledError') {
    return false
  }

  return true
}

export class QueueManager<T> {
  private intervalId: NodeJS.Timeout | null = null
  private isRunning: boolean = false
  private isExecuting: boolean = false

  constructor(
    private source: QueueSource<T>,
    private execute: (item: T) => Promise<T>,
    private intervalMs: number = 1000 // 1s
  ) {}

  private async loop(): Promise<void> {
    if (this.isExecuting) {
      return
    }

    if (!this.isRunning || this.source.queueLength() === 0) {
      return
    }

    const item = this.source.next()
    if (!item) {
      return
    }

    this.isExecuting = true

    console.log('[QueueManager] loop: processing item:', summarizeQueueItemForLog(item))
    const startAt = Date.now()
    try {
      const result = await this.execute(item)
      this.source.done(result)
    } catch (error) {
      if (shouldLogQueueError(error)) {
        console.error('[QueueManager] loop: error:', error)
      }
      this.source.error(item, error)
    } finally {
      const endAt = Date.now()
      console.log('[QueueManager] loop: time cost:', endAt - startAt, 'ms')
      this.isExecuting = false
    }
  }

  start(): void {
    if (this.isRunning) {
      console.log('[QueueManager] start: is already running')
      return
    }

    this.isRunning = true
    this.intervalId = setInterval(() => {
      void this.loop()
    }, this.intervalMs)

    console.log('[QueueManager] start: started')
  }

  stop(): void {
    if (!this.isRunning) {
      console.log('[QueueManager] stop: is not running')
      return
    }

    this.isRunning = false
    this.isExecuting = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    console.log('[QueueManager] stop: stopped')
  }

  isQueueRunning(): boolean {
    return this.isRunning
  }
}
