import type { AbortReceiver } from '@shared/api/apiUtils/abortHandler'

export type EventListener<T> = {
  id: string
  onEvent: (event: T) => void | Promise<void>
  onEnd: () => void | Promise<void>
  abortReceiver?: AbortReceiver
}

export class EventCenter<T> {
  private listeners: EventListener<T>[] = []

  isEmpty() {
    return this.listeners.length === 0
  }

  addListener(listener: EventListener<T>) {
    this.listeners.push(listener)
    listener.abortReceiver?.onAbort(() => this.removeListener(listener.id))
  }

  removeListener(id: string) {
    const removed = this.listeners.filter((listener) => listener.id === id)
    if (removed.length === 0) return
    this.listeners = this.listeners.filter((listener) => listener.id !== id)
    for (const listener of removed) listener.onEnd()
  }

  async cleanAllListeners() {
    const removed = this.listeners
    this.listeners = []
    for (const listener of removed) listener.onEnd()
  }

  async emit(event: T) {
    const pending: Promise<void>[] = []
    for (const listener of [...this.listeners]) {
      if (!this.listeners.includes(listener)) continue
      try {
        pending.push(Promise.resolve(listener.onEvent(event)))
      } catch (error) {
        pending.push(Promise.reject(error))
      }
    }
    await Promise.all(pending)
  }
}
