import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MagicAgentGraphFirstPartyNodeExecutionRequest } from '../magicAgentRuntime/graph/MagicAgentGraphRuntime'
import type { MagicAgentPlatformAdapter } from '../magicAgentRuntime/platformAdapter'
import type { AssistantRuntime } from '../assistantRuntime/runtime'
import { CooperativeExecutionController } from '../magicAgentPlatform2/agents/cooperativeExecutionController'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/graph-scoped-service-fixture' } }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('MAIN-only first-party graph dispatch capability forwarding', () => {
  it.each(['llm', 'comfyui-workflow', 'coding-task'] as const)(
    'forwards the captured node signal for %s, without reading a capability from graph config',
    async (operation) => {
      vi.stubEnv('MAGICPOT_MAGICAGENT_PLATFORM', '1')
      const controller = new CooperativeExecutionController(),
        nodeAbort = new AbortController(),
        forged = {
          run: vi.fn(() => {
            throw new Error('Graph config is not authority')
          })
        }
      const runAgent = vi.fn(async (_request, options) => {
        await options.cooperativeExecution.run('assistant-turn', options.signal, () => undefined)
        return { status: 'completed', content: 'local model' }
      })
      const callTool = vi.fn(async (_request, options) => ({
        ok: true,
        content: 'local tool',
        signal: options.signal
      }))
      const codingCall = vi.fn(async () => ({ ok: true, content: 'local coding tool' }))
      const adapter = { runAgent, callTool } as unknown as MagicAgentPlatformAdapter
      const assistantRuntime = {
        listTools: () => [{ name: 'fixture.coding' }],
        callTool: codingCall
      } as unknown as AssistantRuntime
      const service = new MagicAgentPlatformSvcImpl({ adapter, assistantRuntime })
      // Internal boundary only: bracket access keeps the real private implementation,
      // without adding a public testing/IPC method or invoking unrelated UI/bootstrap.
      let child: MagicAgentGraphFirstPartyNodeExecutionRequest['cooperativeExecution']
      await controller.run('graph-node', nodeAbort.signal, async (scoped) => {
        child = scoped
        await service['executeFirstPartyNode']({
          operation,
          family: operation,
          config: { operation: 'fixture.coding', cooperativeExecution: forged },
          input: 'local',
          node: { nodeId: 'node', kind: 'tool', name: 'Node', description: 'Internal fixture' },
          graph: {} as never,
          run: { runId: 'first-party-main' } as never,
          route: { channel: 'generic', scopeType: 'dm', scopeId: 'first-party-main' },
          signal: nodeAbort.signal,
          cooperativeExecution: scoped
        })
      })
      if (operation === 'llm')
        expect(runAgent).toHaveBeenCalledWith(expect.anything(), {
          signal: nodeAbort.signal,
          cooperativeExecution: child
        })
      else if (operation === 'comfyui-workflow')
        expect(callTool).toHaveBeenCalledWith(expect.anything(), {
          signal: nodeAbort.signal,
          cooperativeExecution: child
        })
      else
        expect(codingCall).toHaveBeenCalledWith(
          expect.anything(),
          'fixture.coding',
          { input: 'local' },
          { signal: nodeAbort.signal, allowedToolNames: ['fixture.coding'] }
        )
      expect(forged.run).not.toHaveBeenCalled()
      await expect(child!.run('tool-invocation', undefined, () => undefined)).rejects.toMatchObject(
        { code: 'COOPERATIVE_SCOPE_RELEASED' }
      )
    }
  )
})
