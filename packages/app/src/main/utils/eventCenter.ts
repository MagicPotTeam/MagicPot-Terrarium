import { AbortReceiver } from '@shared/api/apiUtils/abortHandler'
export type EventListener<T> = {
  id: string
  onEvent: (event: T) => void
  onEnd: () => void
  abortReceiver?: AbortReceiver
}

export class EventCenter<T> {
  private listeners: EventListener<T>[] = []

  isEmpty() {
    return this.listeners.length === 0
  }

  addListener(listener: EventListener<T>) {
    this.listeners.push(listener)
  }

  removeListener(id: string) {
    const listener = this.listeners.find((listener) => listener.id === id)
    listener?.onEnd()
    this.listeners = this.listeners.filter((listener) => listener.id !== id)
  }

  async cleanAllListeners() {
    this.listeners.forEach((listener) => listener.onEnd())
    this.listeners = []
  }

  async emit(event: T) {
    this.listeners.forEach((listener) => listener.onEvent(event))
  }
}
