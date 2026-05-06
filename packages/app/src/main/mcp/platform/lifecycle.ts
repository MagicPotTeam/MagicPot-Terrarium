import { EventEmitter } from 'node:events'
import { type McpLifecycleState } from '@shared/agent/mcpPlatform'

export type McpLifecycleTransition = {
  from: McpLifecycleState
  to: McpLifecycleState
  at: string
  reason?: string
}

export class McpPlatformLifecycle extends EventEmitter {
  private state: McpLifecycleState = 'created'
  private readonly transitions: McpLifecycleTransition[] = []

  getState(): McpLifecycleState {
    return this.state
  }

  listTransitions(): McpLifecycleTransition[] {
    return [...this.transitions]
  }

  transition(to: McpLifecycleState, reason?: string): McpLifecycleTransition {
    const transition: McpLifecycleTransition = {
      from: this.state,
      to,
      at: new Date().toISOString(),
      ...(reason ? { reason } : {})
    }
    this.state = to
    this.transitions.push(transition)
    this.emit('transition', transition)
    return transition
  }
}
