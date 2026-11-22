import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerStreaming } from '../apiUtils/streaming'
import { serializeProviderJsonWithBudget } from '../../llm/providerJsonBudget'
import { registerIpcServer } from './registerIpcServer'

const { on } = vi.hoisted(() => ({ on: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on }, MessagePortMain: class {} }))
const message = 'Provider request exceeds the size limit. Remove some attachments or send fewer images per message.'
const code = 'PROVIDER_JSON_BUDGET_EXCEEDED'
type Api = { svcLLMProxy: { chatStream(req: unknown, resp: ServerStreaming<unknown>): Promise<void> }; svcOther: { watch(req: unknown, resp: ServerStreaming<unknown>): Promise<void> } }
const def = { svcLLMProxy: { chatStream: { type: 'serverStreaming' } }, svcOther: { watch: { type: 'serverStreaming' } } } as const
class Port extends EventEmitter {
  postMessage = vi.fn()
  start = vi.fn()
  close = vi.fn()
}
function setup(handler: Api['svcLLMProxy']['chatStream']) {
  registerIpcServer<Api>(def, { svcLLMProxy: { chatStream: handler }, svcOther: { watch: handler } })
  return (name: string, port = new Port()) => {
    const listener = on.mock.calls.find(([channel]) => channel === name)![1] as (event: { ports: Port[] }, req: unknown) => Promise<void>
    return { port, running: listener({ ports: [port] }, {}) }
  }
}
beforeEach(() => { on.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())

describe('chat stream escaped transport errors', () => {
  it('projects a genuine branded exception using fixed fields', async () => {
    let branded: unknown
    try { serializeProviderJsonWithBudget({ x: 'synthetic' }, 0) } catch (error) { branded = error }
    const { port, running } = setup(async () => { throw branded })('svcLLMProxy.chatStream')
    await running
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ error: { message, code } })
    expect(port.close).toHaveBeenCalledOnce()
  })
  it('does not inspect or propagate an untrusted error, reserved code, payload or getters', async () => {
    const hook = vi.fn(() => { throw new Error('unexpected hook') })
    for (const failure of [
      { message: 'secret', code, payload: { code } },
      new Proxy({}, { get: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook }),
      Object.defineProperties({}, { message: { get: hook }, code: { get: hook } })
    ]) {
      on.mockReset()
      const { port, running } = setup(async () => { throw failure })('svcLLMProxy.chatStream')
      await running
      expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ error: { message: 'Unable to complete the chat request.', code: 'INTERNAL_ERROR' } })
      expect(port.close).toHaveBeenCalledOnce()
    }
    expect(hook).not.toHaveBeenCalled()
  })
  it('preserves normal structured serialization for unrelated endpoints', async () => {
    const { port, running } = setup(async () => { throw { message: 'fixture', code } })('svcOther.watch')
    await running
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ error: { message: 'fixture', code, payload: { message: 'fixture', code } } })
  })
  it('does not send even a genuine budget error after cancellation', async () => {
    let reject!: (error: unknown) => void
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise })
    const { port, running } = setup(() => pending)('svcLLMProxy.chatStream')
    port.emit('message')
    let branded: unknown
    try { serializeProviderJsonWithBudget({ x: 'synthetic' }, 0) } catch (error) { branded = error }
    reject(branded)
    await running
    expect(port.postMessage).not.toHaveBeenCalled()
    expect(port.close).toHaveBeenCalledOnce()
  })
})
