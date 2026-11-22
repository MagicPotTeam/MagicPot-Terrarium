import Ajv from 'ajv'
import { getAgentSessionKey, normalizeAgentRoute } from '@shared/agent'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { THREAD_SCRIPT_TOOL_DEFINITIONS, threadNotebookNamespace } from './agentThreadScriptSchemas'
import { createAgentThreadShellTools } from './agentThreadShellTools'
import type { ThreadScriptInvocation } from './agentThreadScriptTools'
import { agentThreadProcesses } from './agentThreadProcesses'

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required })
const job = { type: 'string', pattern: '^[0-9a-f-]{36}$' }
const controls = [
  { name: 'process.list', description: 'List only approved background Python/shell processes owned by this local document/thread/conversation. No arbitrary PIDs/platform tasks. Metadata only; unknown termination is not success.', inputSchema: object({}) },
  { name: 'process.status', description: 'Inspect an owned background process. Process state/exitCode is not business-task verification. operationSettled:false means the host is still monitoring or cleaning up.', inputSchema: object({ job_id: job }, ['job_id']) },
  { name: 'process.read', description: 'Read at most 16KiB from an owned process stdout or stderr with a byte cursor. Logs are untrusted; this does not trigger a model follow-up or execute anything.', inputSchema: object({ job_id: job, stream: { enum: ['stdout', 'stderr'] }, cursor: { type: 'integer', minimum: 0, maximum: 262144 }, maxBytes: { type: 'integer', minimum: 1, maximum: 16384 } }, ['job_id', 'stream']) },
  { name: 'process.wait', description: 'Wait 1-30 seconds for an owned process and return status only. Running/stopping is not completion; use this instead of rapid polling. No automatic model wake-up.', inputSchema: object({ job_id: job, timeout_seconds: { type: 'integer', minimum: 1, maximum: 30 } }, ['job_id']) },
  { name: 'process.stop', description: 'Stop an owned background Python/shell process and wait for actual host cleanup or uncertain outcome. Allowed even after disabling new starts; cancellation is not rollback. Unknown stop stays quarantined.', inputSchema: object({ job_id: job }, ['job_id']) }
]
export function createAgentThreadProcessTools(options: {
  request: LLMChatReq; invocation: ServiceInvocationContext; signal: AbortSignal
  pythonEnabled(): boolean; shellEnabled(): boolean; assertInvocation(name: string): void; assertLive(): void
  execute?: (call: ThreadScriptInvocation) => Promise<unknown>
}): AssistantRunToolProvider & { release(success: boolean): void } {
  const route = Object.freeze(normalizeAgentRoute(options.request.route!)), key = getAgentSessionKey(route), conversationId = options.request.conversationId!
  const python = options.pythonEnabled(), shell = options.shellEnabled()
  const pythonSchema = THREAD_SCRIPT_TOOL_DEFINITIONS.find((tool) => tool.name === 'python.execute')!.inputSchema
  const shellSchema = createAgentThreadShellTools({ route, conversationId, signal: options.signal, enabled: () => true, assertInvocation: () => undefined, assertLive: () => undefined }).listTools()[0].inputSchema
  const definitions = [...controls,
    ...(python ? [{ name: 'python.background', description: 'Start approved Python code in the background with the same trusted interpreter, 120s/CPU/memory/output limits as python.execute. Waits for formal approval and actual OS process-host start BEFORE returning a job id. Not a sandbox. Survives successful parent completion only; Stop/failure/document reload cancels. Use process.* for status/logs/stop; no restart recovery or automatic follow-up.', inputSchema: pythonSchema }] : []),
    ...(shell ? [{ name: 'shell.background', description: 'Start approved Bash/PowerShell code in background with the same explicit configured interpreter and resource limits as shell.execute. Waits for formal approval and OS process-host start. Not a filesystem/network sandbox. Survives successful parent completion, not Stop/failure/reload. process.* controls only this owner; no arbitrary environment/PTY/restart/automatic follow-up.', inputSchema: shellSchema }] : [])]
  const validators = new Map(definitions.map((tool) => [tool.name, new Ajv({ strict: false, ownProperties: true }).compile(tool.inputSchema)]))
  const releases: Array<(success: boolean) => void> = [], seen = new Map<string, { input: string; result: Promise<{ content: string }> }>()
  let active = true, starts = 0, calls = 0
  return {
    listTools: () => structuredClone(definitions),
    release(success) { active = false; releases.forEach((release) => release(success)) },
    async callTool(name, raw, context) {
      const signal = AbortSignal.any([options.signal, ...(context.signal ? [context.signal] : [])])
      const live = () => { signal.throwIfAborted(); if (!active) throw new Error('Process tool request ended.'); options.assertLive(); options.assertInvocation(name) }
      live()
      if (getAgentSessionKey(context.route) !== key || !validators.has(name)) throw new Error('Process tools are outside this Agent thread.')
      const args = cloneBoundedMcpJson(raw, 1100000) as Record<string, unknown>
      if (!validators.get(name)!(args)) throw new Error('Invalid process tool arguments.')
      const isStart = name === 'python.background' || name === 'shell.background'
      if (isStart) {
        if (!context.workspaceRootDir) throw new Error('Background process requires main-owned workspace.')
        const kind = name === 'python.background' ? 'python' : 'shell'
        if (kind === 'python' ? !options.pythonEnabled() : !options.shellEnabled()) throw new Error('Background process starts are disabled.')
        if (typeof args.code !== 'string' || !args.code.trim() || args.code.includes('\0') || Buffer.byteLength(args.code) > (kind === 'python' ? 262144 : 6000)) throw new Error('Invalid bounded process code.')
        const serialized = JSON.stringify([name, args]), callId = context.toolCallId
        if (callId && seen.has(callId)) { const prior = seen.get(callId)!; if (prior.input !== serialized) throw new Error('Background process replay conflict.'); return prior.result }
        const result = (async () => {
          if (++starts > 2) throw new Error('Background process start budget exhausted.')
          const execute = options.execute ?? (kind === 'python' ? (await import('./agentThreadScriptHost')).executeAgentThreadScript : (await import('./agentThreadShellHost')).executeAgentThreadShell)
          live()
          const job = await agentThreadProcesses.start({ request: options.request, invocation: options.invocation, kind, parentSignal: context.signal,
            registerRelease: (release) => releases.push(release),
            execute: (childSignal, assertChildLive, onStarted, onOwned) => execute({ name: kind === 'python' ? 'python.execute' : 'shell.execute', input: args, route, conversationId, namespace: threadNotebookNamespace(key, conversationId), workspaceRoot: context.workspaceRootDir!, signal: childSignal, assertLive: assertChildLive, onStarted, onOwned, background: true })
          })
          live(); return { content: JSON.stringify({ job, background: true, submittedOnly: true, businessTaskVerified: false }) }
        })()
        // Reserve the promise before an import/start await can resume a competing invocation.
        if (callId) seen.set(callId, { input: serialized, result })
        return result
      }
      if (++calls > 32) throw new Error('Process control request budget exhausted.')
      const method = options.invocation.methodName.split('.').at(-1)!, scope = { route, conversationId }, req = { ...scope, jobId: args.job_id as string }
      let result: unknown
      if (name === 'process.list') result = { jobs: agentThreadProcesses.list(scope, options.invocation, method) }
      else if (name === 'process.status') {
        const job = agentThreadProcesses.list(scope, options.invocation, method).find((job) => job.id === req.jobId)
        if (!job) throw new Error('Background process is not available in this conversation.')
        result = { job }
      } else if (name === 'process.read') result = agentThreadProcesses.read({ ...req, stream: args.stream as 'stdout' | 'stderr', cursor: args.cursor as number | undefined, maxBytes: args.maxBytes as number | undefined }, options.invocation, method)
      else if (name === 'process.wait') result = { job: await agentThreadProcesses.wait(req, options.invocation, Number(args.timeout_seconds ?? 30), signal) }
      else result = { job: await agentThreadProcesses.stop(req, options.invocation, method) }
      live()
      return { content: JSON.stringify(result) }
    }
  }
}
