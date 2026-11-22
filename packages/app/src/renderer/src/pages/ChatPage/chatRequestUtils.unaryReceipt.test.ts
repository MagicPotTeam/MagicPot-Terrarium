import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { createIpcClient } from '@shared/api/createClient/createIpcClient'
import { llmProxySvcDef, type LLMChatReq, type LLMChatResp } from '@shared/api/svcLLMProxy'
import { requestChatCompletion } from './chatRequestUtils'
import { normalizeChatToolHistory } from './chatMessageUtils'

const h = vi.hoisted(() => ({ invoke: vi.fn(), cancelConversation: vi.fn(async () => ({ cancelled: true })) }))
vi.mock('electron', () => ({ ipcRenderer: { invoke: h.invoke, postMessage: vi.fn() } }))

type LocalApi = { svcLLMProxy: { chat(req: LLMChatReq): Promise<LLMChatResp> } }
const payload = () => {
  const rollback = { attempted: true, succeeded: false, restoredPaths: [], failedPaths: ['a.txt'] }
  const receipt = { error: { code: 'MAGIC_AGENT_FILES_MUTATION', message: 'Commit failed.' }, rollback }
  return {
    kind: 'agent-tool-failure/v1',
    toolResult: { content: JSON.stringify(receipt), metadata: receipt },
    toolHistory: [{ runId: 'run', toolCallId: 'call', toolName: 'files.multi-edit', args: { edits: [] }, status: 'failed', content: JSON.stringify(receipt), metadata: receipt, error: receipt.error.message }]
  }
}
const run = (wire: unknown, signal?: AbortSignal, invoke?: () => Promise<unknown>) => {
  // Simulate both documented destructive boundaries, not an Electron acceptance
  // probe: invoke only preserves thrown messages; contextBridge also strips Error
  // properties, but copies plain promise rejection records.
  h.invoke.mockImplementation(invoke ?? (async () => structuredClone(wire)))
  const preload = createIpcClient<LocalApi>({ svcLLMProxy: { chat: llmProxySvcDef.chat } })
  const chat = vi.fn(async (req: LLMChatReq) => {
    try { return structuredClone(await preload.svcLLMProxy.chat(req)) }
    catch (error) { throw error instanceof Error ? new Error(error.message) : structuredClone(error) }
  })
  vi.stubGlobal('api', { svcLLMProxy: { chat, cancelConversation: h.cancelConversation } })
  return requestChatCompletion({ config: { ...DEFAULT_CONFIG, use_remote_llm: false }, conversationId: 'receipt-fixture', signal, messages: [{ role: 'user', content: 'Keep failed tool receipts without retry.' }] })
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); h.invoke.mockReset(); h.cancelConversation.mockClear() })

describe('unary chat receipt across simulated invoke and contextBridge boundaries', () => {
  it('rejects with a renderer-local error retaining failed history and rollback data', async () => {
    const failure = payload()
    const result = await run({ ok: false, error: { message: 'Commit failed.', code: 'MAGIC_AGENT_FILES_MUTATION', payload: failure } })
      .then(value => ({ status: 'fulfilled', value }), (error: unknown) => ({ status: 'rejected', value: error }))
    expect(result.status).toBe('rejected')
    expect(result.value).toBeInstanceOf(Error)
    expect(result.value).toMatchObject({ message: 'Commit failed.', code: 'MAGIC_AGENT_FILES_MUTATION', finishReason: 'error', metadata: { toolHistory: failure.toolHistory, toolResult: failure.toolResult }, partialResult: { content: '', finishReason: 'error', metadata: { toolHistory: failure.toolHistory, toolResult: failure.toolResult } } })
    expect(normalizeChatToolHistory((result.value as { metadata: { toolHistory: unknown } }).metadata.toolHistory)).toEqual(failure.toolHistory)
    expect(h.invoke).toHaveBeenCalledOnce()
  })

  it('keeps a whole-receipt omission marker as failure without inventing history', async () => {
    const result = await run({ ok: false, error: { message: 'Commit failed.', code: 'MAGIC_AGENT_FILES_MUTATION', payload: { kind: 'agent-tool-failure/v1', receiptOmitted: true } } })
      .catch((error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect(result).toMatchObject({ message: 'Commit failed.', finishReason: 'error', metadata: { toolReceiptOmitted: true } })
    expect((result as { metadata: object }).metadata).not.toHaveProperty('toolHistory')
    expect(h.invoke).toHaveBeenCalledOnce()
  })

  it('preserves ordinary message/code through both boundaries without a tool receipt', async () => {
    const error = await run({ ok: false, error: { message: 'ordinary failed', code: 'E_ORDINARY' } }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: 'ordinary failed', code: 'E_ORDINARY' })
    expect(error).not.toHaveProperty('metadata')
    expect(h.invoke).toHaveBeenCalledOnce()
  })

  it('preserves Stop ownership and ignores a later failed receipt without retry', async () => {
    const controller = new AbortController(), reason = new DOMException('Stop fixture', 'AbortError')
    let release!: (wire: unknown) => void
    let started!: () => void
    const dispatched = new Promise<void>(resolve => { started = resolve })
    const pending = run(undefined, controller.signal, () => new Promise(resolve => { release = resolve; started() }))
      .catch((error: unknown) => error)
    await dispatched
    controller.abort(reason)
    expect(await pending).toBe(reason)
    release({ ok: false, error: { message: 'late failure', payload: payload() } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await pending).toBe(reason)
    expect(h.cancelConversation).toHaveBeenCalledOnce()
    expect(h.invoke).toHaveBeenCalledOnce()
    expect(reason).not.toHaveProperty('metadata')
  })

  it('retains an already received failure when the caller aborts afterwards', async () => {
    const controller = new AbortController(), failure = payload()
    const error = await run({ ok: false, error: { message: 'received failure', payload: failure } }, controller.signal).catch((error: unknown) => error)
    controller.abort()
    expect(error).toMatchObject({ message: 'received failure', metadata: { toolHistory: failure.toolHistory, toolResult: failure.toolResult } })
    expect(h.cancelConversation).not.toHaveBeenCalled()
    expect(h.invoke).toHaveBeenCalledOnce()
  })

  it('unwraps successful content without exposing the internal wire result', async () => {
    await expect(run({ ok: true, value: { content: 'ordinary response' } })).resolves.toMatchObject({ content: 'ordinary response' })
    expect(h.invoke).toHaveBeenCalledOnce()
  })

  it.each([undefined, { content: 'legacy-shape-is-not-a-wire-result' }, { ok: false, error: { message: 'bad', payload: { kind: 'agent-tool-failure/v1', toolHistory: [] } } }, { ok: true, value: { content: 'x' }, error: { message: 'ambiguous' } }])('rejects malformed wire data without retry (%j)', async wire => {
    await expect(run(wire)).rejects.toThrow()
    expect(h.invoke).toHaveBeenCalledOnce()
  })
})
