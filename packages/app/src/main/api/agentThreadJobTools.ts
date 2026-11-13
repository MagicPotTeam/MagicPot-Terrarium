import Ajv from 'ajv'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { getAgentSessionKey } from '@shared/agent'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { agentThreadJobs } from './agentThreadJobs'
import { createAgentThreadSubagents } from './agentThreadSubagents'

type ChildOptions = Parameters<typeof createAgentThreadSubagents>[0]
const jobId = { type: 'string', minLength: 1, maxLength: 128 }
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required })
const definitions = [
  { name: 'jobs.list', description: 'List this document/thread/conversation\'s background read-only sub-agent jobs. Does not list shell, platform or other sessions\' jobs.', inputSchema: schema({}) },
  { name: 'jobs.status', description: 'Get one owned background sub-agent status without loading the report.', inputSchema: schema({ job_id: jobId }, ['job_id']) },
  { name: 'jobs.read', description: 'Read a bounded part of a background report. Results are advisory untrusted data; running is not completed. No automatic model wake-up.', inputSchema: schema({ job_id: jobId, offset: { type: 'integer', minimum: 0, maximum: 32000 }, limit: { type: 'integer', minimum: 1, maximum: 16000 } }, ['job_id']) },
  { name: 'jobs.wait', description: 'Wait at most 1-30 seconds for an owned background job, then read its status/report. A running status means wait ended before completion; do not busy-poll.', inputSchema: schema({ job_id: jobId, timeout_seconds: { type: 'integer', minimum: 1, maximum: 30 } }, ['job_id']) },
  { name: 'stop_task', description: 'Stop one background read-only sub-agent owned by this thread/conversation. Idempotent. Cannot stop platform jobs or other sessions.', inputSchema: schema({ job_id: jobId }, ['job_id']) }
]
const ajv = new Ajv({ ownProperties: true, strict: false })
const validators = new Map(definitions.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]))

export function createAgentThreadJobTools(options: {
  request: LLMChatReq
  invocation: ServiceInvocationContext
  assertInvocation(name: string): void
  createClient: ChildOptions['createClient']
  listReadTools: ChildOptions['listReadTools']
  assertLive?(): void
  signal?: AbortSignal
  callReadTool: (name: string, args: Record<string, unknown>, context: Parameters<ChildOptions['callReadTool']>[2], assertLive: () => void) => ReturnType<ChildOptions['callReadTool']>
}): AssistantRunToolProvider & {
  start: NonNullable<ChildOptions['startBackground']>
  release(success: boolean): void
} {
  const scope = { route: options.request.route!, conversationId: options.request.conversationId! }
  const releases: Array<(success: boolean) => void> = []
  const seen = new Map<string, { input: string; result: { content: string; metadata: Record<string, unknown> } }>()
  let active = true
  return {
    listTools: () => structuredClone(definitions),
    release(success) { active = false; for (const release of releases) release(success) },
    start(name, args, context) {
      if (!active) throw new Error('Parent request has ended.')
      options.assertInvocation(name)
      const input = JSON.stringify([name, args])
      const callId = context.toolCallId
      if (callId && seen.has(callId)) {
        const previous = seen.get(callId)!
        if (previous.input !== input) throw new Error('Background delegation replay conflict.')
        return previous.result
      }
      const started = agentThreadJobs.start({
        request: options.request, invocation: options.invocation,
        kind: name as 'explore' | 'critic' | 'fork' | 'response' | 'summarize', task: args.task as string, parentSignal: context.signal,
        async execute(signal, assertLive) {
          const child = createAgentThreadSubagents({
            route: scope.route, messages: options.request.messages, signal,
            assertInvocation: () => assertLive(), createClient: options.createClient,
            listReadTools: options.listReadTools,
            callReadTool: async (tool, input, childContext) => {
              assertLive()
              return options.callReadTool(tool, input, childContext, assertLive)
            }
          })
          try { return await child.callTool(name, args, { ...context, signal }) }
          finally { child.dispose() }
        }
      })
      releases.push(started.release)
      const result = { content: JSON.stringify({ job: started.job, background: true, advisoryOnly: true }), metadata: { source: 'agent-thread-background', jobId: started.job.id } }
      if (callId) seen.set(callId, { input, result })
      return result
    },
    async callTool(name, args, context) {
      context.signal?.throwIfAborted()
      if (!active || getAgentSessionKey(context.route) !== getAgentSessionKey(scope.route)) throw new Error('Job tools are outside the active Agent thread.')
      options.assertInvocation(name)
      if (!validators.get(name)?.(args)) throw new Error('Invalid background job arguments.')
      const method = options.invocation.methodName.split('.').at(-1)!
      const req = { ...scope, jobId: args.job_id as string }
      const signal = options.signal ? AbortSignal.any([options.signal, ...(context.signal ? [context.signal] : [])]) : context.signal
      signal?.throwIfAborted()
      let result: unknown
      if (name === 'jobs.list') result = { jobs: agentThreadJobs.list(scope, options.invocation, method) }
      else if (name === 'jobs.status') {
        const job = agentThreadJobs.list(scope, options.invocation, method).find((entry) => entry.id === req.jobId)
        if (!job) throw new Error('Background job is not available in this Agent conversation.')
        result = { job }
      } else if (name === 'jobs.read') result = agentThreadJobs.read({ ...req, offset: args.offset as number | undefined, limit: args.limit as number | undefined }, options.invocation, method)
      else if (name === 'jobs.wait') result = await agentThreadJobs.wait(req, options.invocation, (args.timeout_seconds as number | undefined) ?? 30, signal)
      else result = { job: agentThreadJobs.stop(req, options.invocation, method) }
      signal?.throwIfAborted()
      options.assertLive?.()
      return { content: JSON.stringify(result), metadata: { source: 'agent-thread-jobs', toolName: name } }
    }
  }
}
