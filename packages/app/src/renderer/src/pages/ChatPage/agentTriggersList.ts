import type { AgentThreadTriggerView } from '@shared/api/agentThreadTrigger'

const pad = (value: string, width: number) => value.padEnd(width)
const two = (value: number) => String(value).padStart(2, '0')
/** Local time without a zone, like Python's datetime.isoformat(timespec="seconds"). */
export function localIsoSeconds(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/**
 * KohakuTerrarium 2.2.3 /triggers text: "Active triggers (N):" and one row per trigger with its
 * state, id, type and creation time, or undefined when there is none. Each row adds the next fire
 * time. Read-only: the user removes a trigger by asking the agent to delete_trigger it.
 */
export function formatAgentTriggers(
  triggers: readonly AgentThreadTriggerView[]
): string | undefined {
  if (!triggers.length) return undefined
  return [
    `Active triggers (${triggers.length}):`,
    ...triggers.map(
      (trigger) =>
        `  ${pad(trigger.running ? '● running' : '○ idle', 10)} ${pad(trigger.id, 24)} ${pad(trigger.type, 20)} ${localIsoSeconds(trigger.createdAt)}  next ${localIsoSeconds(trigger.nextFireAt)}`
    )
  ].join('\n')
}
