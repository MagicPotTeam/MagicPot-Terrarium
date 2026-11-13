import Ajv from 'ajv'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { threadNotebookNamespace } from './agentThreadScriptSchemas'
import type { ThreadScriptInvocation } from './agentThreadScriptTools'

const definition = {
  name: 'shell.execute',
  description: 'Run reviewed general shell code synchronously using the user-configured absolute Bash or PowerShell executable, only after explicit environment opt-in and fresh formal approval. General host code can read/write files, access network, install software or change Git state; this is NOT a filesystem/network sandbox. Requires OS memory/CPU confinement. Fixed argv, no model-selected executable/env/login profile/PTY/background. cwd is relative to this thread workspace, but the code itself is not confined there. Default 30s/max120s, bounded stdout/stderr. Stop waits for termination; unknown outcomes must not be blindly retried. A zero exit code is process evidence, not proof that the business task succeeded.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['code'], properties: {
    code: { type: 'string', minLength: 1, maxLength: 6000 }, cwd: { type: 'string', minLength: 1, maxLength: 512 },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 }, maxOutputBytes: { type: 'integer', minimum: 512, maximum: 262144 }
  } }
}
const validate = new Ajv({ strict: false, ownProperties: true }).compile(definition.inputSchema)
export function createAgentThreadShellTools(options: {
  route: AgentRouteLike; conversationId: string; signal: AbortSignal
  enabled(): boolean; assertInvocation(name: string): void; assertLive(): void
  execute?: (call: ThreadScriptInvocation) => Promise<unknown>
}): AssistantRunToolProvider {
  const route = Object.freeze(normalizeAgentRoute(options.route)), key = getAgentSessionKey(route)
  const exposed = options.enabled()
  let calls = 0
  return {
    listTools: () => exposed ? [structuredClone(definition)] : [],
    async callTool(name, raw, context) {
      const signal = AbortSignal.any([options.signal, ...(context.signal ? [context.signal] : [])])
      const assertLive = () => { signal.throwIfAborted(); options.assertLive(); options.assertInvocation(name); if (!options.enabled()) throw new Error('General shell execution is disabled.') }
      assertLive()
      if (!exposed || name !== definition.name || getAgentSessionKey(context.route) !== key || !context.workspaceRootDir) throw new Error('Shell tool is outside this local Agent thread.')
      const input = cloneBoundedMcpJson(raw, 24576) as Record<string, unknown>
      if (!validate(input) || !(input.code as string).trim() || (input.code as string).includes('\0') || Buffer.byteLength(input.code as string, 'utf8') > 6000) throw new Error('Invalid bounded shell arguments.')
      if (++calls > 2) throw new Error('Per-request shell execution budget exhausted.')
      const execute = options.execute ?? (await import('./agentThreadShellHost')).executeAgentThreadShell
      assertLive()
      const result = await execute({ name, input, route, conversationId: options.conversationId, namespace: threadNotebookNamespace(key, options.conversationId), workspaceRoot: context.workspaceRootDir, signal, assertLive })
      assertLive()
      return { content: JSON.stringify(result), metadata: { source: 'agent-thread-shell' } }
    }
  }
}
