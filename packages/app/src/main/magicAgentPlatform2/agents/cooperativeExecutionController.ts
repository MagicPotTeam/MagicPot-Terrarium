export type CooperativeExecutionKind =
  | 'assistant-turn'
  | 'llm-inference'
  | 'tool-invocation'
  | 'scheduled-task'
  | 'graph-node'

export interface CooperativeExecutionGate {
  checkpoint(kind: CooperativeExecutionKind): Promise<void>
  enter(kind: CooperativeExecutionKind): () => void
}

type Waiter = () => void

export class CooperativeExecutionController implements CooperativeExecutionGate {
  private paused = false
  private readonly active = new Map<CooperativeExecutionKind, number>()
  private readonly resumeWaiters = new Set<Waiter>()
  private readonly quiescenceWaiters = new Set<Waiter>()

  async checkpoint(_kind: CooperativeExecutionKind, signal?: AbortSignal): Promise<void> {
    if (!this.paused) return
    if (signal?.aborted) throw signal.reason
    await new Promise<void>((resolve, reject) => {
      const resume = (): void => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = (): void => {
        this.resumeWaiters.delete(resume)
        reject(signal?.reason)
      }
      this.resumeWaiters.add(resume)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  enter(kind: CooperativeExecutionKind): () => void {
    this.active.set(kind, (this.active.get(kind) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const next = (this.active.get(kind) ?? 1) - 1
      if (next > 0) this.active.set(kind, next)
      else this.active.delete(kind)
      if (this.active.size === 0) {
        for (const resolve of this.quiescenceWaiters) resolve()
        this.quiescenceWaiters.clear()
      }
    }
  }

  async requestPause(): Promise<void> {
    this.paused = true
    if (this.active.size === 0) return
    await new Promise<void>((resolve) => this.quiescenceWaiters.add(resolve))
  }

  resume(): void {
    this.paused = false
    for (const resolve of this.resumeWaiters) resolve()
    this.resumeWaiters.clear()
  }

  isPaused(): boolean {
    return this.paused
  }

  isQuiescent(): boolean {
    return this.active.size === 0
  }
}
