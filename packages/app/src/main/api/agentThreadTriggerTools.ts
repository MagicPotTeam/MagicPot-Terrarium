import Ajv from 'ajv'
import { getAgentSessionKey } from '@shared/agent'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import {
  scheduleSpec,
  timerSpec,
  TRIGGER_LIMITS,
  type AgentThreadTriggers
} from './agentThreadTriggers'

/**
 * KohakuTerrarium 2.2.3 trigger tools: add_timer (TimerTrigger), add_schedule (SchedulerTrigger) and
 * delete_trigger, with KT's names, parameters, defaults and result text. watch_channel needs team
 * channels and comes with S6. Installing is for a turn of the user's own send only; any other turn
 * (thread event, team member or message, goal progress, sub-agent) can only delete.
 */
const NAME = {
  type: 'string',
  description:
    'Optional stable id for the installed trigger. If omitted, an auto-generated id like `trigger_<hex>` is returned. Pick a memorable name if you may need to delete_trigger it later.'
}
const PROMPT_LIMIT = `at most ${TRIGGER_LIMITS.promptCharacters} characters`
const FIRES =
  'It fires only while the app and this project are open; a fire missed while closed runs once when the project opens. A trigger whose last fire still waits (busy or stopped conversation) does not queue another. The fire arrives as a "Triggered by <id>" turn in this conversation; actions in that turn still need the usual approvals.'
export const TRIGGER_TOOL_DEFINITIONS = [
  {
    name: 'add_timer',
    description: `**Trigger**: Install a timer that wakes the agent every N seconds with a custom prompt. interval must be at least ${TRIGGER_LIMITS.minimumIntervalSeconds} seconds (each fire starts a model turn); a smaller value is refused, not raised. ${FIRES} Returns the trigger id; keep it (for example in the scratchpad) to delete_trigger it later.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: NAME,
        interval: {
          type: 'number',
          description: `Seconds between fires (at least ${TRIGGER_LIMITS.minimumIntervalSeconds}).`
        },
        prompt: {
          type: 'string',
          description: `Prompt injected when the timer fires (${PROMPT_LIMIT}).`
        },
        immediate: {
          type: 'boolean',
          description: 'If true, fire once right after install before waiting.',
          default: false
        }
      },
      required: ['interval', 'prompt']
    }
  },
  {
    name: 'add_schedule',
    description: `**Trigger**: Install a clock-aligned schedule: fire every N minutes, daily at HH:MM, or hourly at minute :MM. Provide exactly one of every_minutes, daily_at or hourly_at; they cannot be combined. every_minutes aligns to local midnight, so every_minutes: 30 fires at :00 and :30 of every hour. Times use this computer's local clock. ${FIRES} Returns the trigger id; keep it to delete_trigger it later.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: NAME,
        every_minutes: {
          type: 'integer',
          description: 'Fire every N minutes, aligned to midnight (1-1440).'
        },
        daily_at: { type: 'string', description: 'Fire daily at HH:MM (24h clock).' },
        hourly_at: { type: 'integer', description: 'Fire every hour at minute :MM (0-59).' },
        prompt: {
          type: 'string',
          description: `Prompt injected when the schedule fires (${PROMPT_LIMIT}).`
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'delete_trigger',
    description:
      'Stop and remove an installed trigger by id. Use it when a timer or schedule has done its job. Not for cancelling a running job - use stop_task.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        trigger_id: {
          type: 'string',
          description:
            'Trigger id returned by add_timer / add_schedule, or any id the user saw in the /triggers listing.'
        }
      },
      required: ['trigger_id']
    }
  }
] as const
const INSTALL = new Set(['add_timer', 'add_schedule'])
const ajv = new Ajv({ ownProperties: true, strict: false })
const validators = new Map(
  TRIGGER_TOOL_DEFINITIONS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)])
)

/** Only a turn of the user's own composer send may install a trigger. */
export function mayInstallTriggers(
  request: LLMChatReq,
  options: { goalProgress?: unknown } = {}
): boolean {
  return (
    request.threadEventOrigin === undefined &&
    request.threadEvent === undefined &&
    request.teamMember === undefined &&
    request.teamMessageHop === undefined &&
    request.teamMessageDelivery === undefined &&
    request.goalProgressToken === undefined &&
    options.goalProgress === undefined
  )
}

/** KT `_format_setup_summary`: Python-repr style `key=value` pairs of the given arguments. */
function summary(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([key, value]) => {
    if (typeof value === 'string') {
      const preview = value.length <= 60 ? value : `${value.slice(0, 57)}…`
      return `${key}='${preview.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    }
    if (typeof value === 'boolean') return `${key}=${value ? 'True' : 'False'}`
    return `${key}=${String(value)}`
  })
  return parts.length ? parts.join(', ') : 'no parameters'
}

export function createAgentThreadTriggerTools(options: {
  request: LLMChatReq
  triggers: Pick<AgentThreadTriggers, 'install' | 'remove'>
  assertInvocation(name: string): void
  /** False for any turn that is not the user's own send (see mayInstallTriggers). */
  installAllowed: boolean
}): AssistantRunToolProvider {
  const route = options.request.route!
  const conversationId = options.request.conversationId!
  const definitions = TRIGGER_TOOL_DEFINITIONS.filter(
    (tool) => options.installAllowed || !INSTALL.has(tool.name)
  )
  return {
    listTools: () => structuredClone(definitions) as never,
    async callTool(name, args, context) {
      context.signal?.throwIfAborted()
      if (getAgentSessionKey(context.route) !== getAgentSessionKey(route))
        throw new Error('Trigger tools are outside the active Agent thread.')
      options.assertInvocation(name)
      if (INSTALL.has(name) && !options.installAllowed)
        throw new Error("Only a turn of the user's own message can install a trigger.")
      if (!validators.get(name as never)?.(args)) throw new Error(`Invalid ${name} arguments.`)
      if (name === 'delete_trigger') {
        const triggerId = String(args.trigger_id ?? '').trim()
        if (!triggerId) throw new Error('trigger_id is required')
        if (!options.triggers.remove(route, conversationId, triggerId))
          throw new Error(`Trigger not found: ${triggerId}`)
        return {
          content: `Removed trigger: ${triggerId}`,
          metadata: { source: 'agent-thread-triggers', toolName: name, triggerId }
        }
      }
      const { name: requested, ...setup } = args as Record<string, unknown>
      const prompt = typeof setup.prompt === 'string' ? setup.prompt : ''
      if (!prompt.trim()) throw new Error(`Missing required arg(s) for ${name}: prompt`)
      const spec = name === 'add_timer' ? timerSpec(setup) : scheduleSpec(setup)
      const { triggerId, record } = options.triggers.install({
        tool: name as 'add_timer' | 'add_schedule',
        route,
        conversationId,
        name: typeof requested === 'string' ? requested : undefined,
        spec,
        prompt
      })
      return {
        content: `Trigger \`${name}\` correctly set up and running in the background with ${summary(setup)}. trigger_id=${triggerId}`,
        metadata: {
          source: 'agent-thread-triggers',
          toolName: name,
          triggerId,
          triggerClass: name === 'add_timer' ? 'TimerTrigger' : 'SchedulerTrigger',
          nextFireAt: record.nextFireAt
        }
      }
    }
  }
}
