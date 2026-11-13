import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerIpcServer } from './registerIpcServer'
import { IpcServiceError } from '../apiUtils/unaryIpcResult'
import { ProviderJsonBudgetError, serializeProviderJsonWithBudget } from '../../llm/providerJsonBudget'

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, on: vi.fn() }, MessagePortMain: class {} }))
const reserved = 'PROVIDER_JSON_BUDGET_EXCEEDED'
const message = 'Provider request exceeds the size limit. Remove some attachments or send fewer images per message.'

type Api = { svcLLMProxy: { chat(req: unknown): Promise<unknown> }; svcOther: { chat(req: unknown): Promise<unknown> } }
const defs = { svcLLMProxy: { chat: { type: 'unary', ipcResult: 'service-error' } }, svcOther: { chat: { type: 'unary', ipcResult: 'service-error' } } } as const

function setup(error: unknown, otherError: unknown = error) {
  registerIpcServer<Api>(defs, { svcLLMProxy: { chat: async () => { throw error } }, svcOther: { chat: async () => { throw otherError } } })
  const call = (name: string) => handle.mock.calls.find(([channel]) => channel === name)![1]({}, {})
  return { chat: () => call('svcLLMProxy.chat'), other: () => call('svcOther.chat') }
}

describe('chat unary budget error projection', () => {
  beforeEach(() => { handle.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}) })
  it('projects the private brand made by the real serializer', async () => {
    let error: unknown
    try { serializeProviderJsonWithBudget({ x: 'large' }, 0) } catch (caught) { error = caught }
    expect(await setup(error).chat()).toEqual({ ok: false, error: { message, code: reserved } })
  })
  it('removes only the reserved code of unbranded errors, retaining normal codes and other endpoints', async () => {
    for (const fake of [Object.assign(new Error('fake'), { code: reserved }), new ProviderJsonBudgetError(), { message: 'fake', code: reserved }]) {
      handle.mockReset()
      expect((await setup(fake).chat()).error.code).toBeUndefined()
    }
    handle.mockReset()
    const calls = setup(Object.assign(new Error('ordinary'), { code: 'ORDINARY' }), Object.assign(new Error('other'), { code: reserved }))
    expect(await calls.chat()).toEqual({ ok: false, error: { message: 'ordinary', code: 'ORDINARY' } })
    expect(await calls.other()).toEqual({ ok: false, error: { message: 'other', code: reserved } })
  })
  it('does not invoke proxy traps or error accessors in the projection', async () => {
    const hook = vi.fn(() => { throw Error('must not execute') })
    const proxy = new Proxy({}, { get: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook })
    expect(await setup(proxy).chat()).toEqual({ ok: false, error: { message: 'Unknown error' } })
    handle.mockReset()
    const accessor = Object.defineProperties({}, { message: { get: hook }, code: { get: hook } })
    expect(await setup(accessor).chat()).toEqual({ ok: false, error: { message: 'Unknown error' } })
    expect(hook).not.toHaveBeenCalled()
  })
  it('retains the IpcServiceError receipt when its code collides', async () => {
    const payload = { kind: 'agent-tool-failure/v1', receiptOmitted: true } as const
    const error = new IpcServiceError('tool failed', { code: reserved, payload })
    expect(await setup(error).chat()).toEqual({ ok: false, error: { message: 'tool failed', payload } })
  })
})
