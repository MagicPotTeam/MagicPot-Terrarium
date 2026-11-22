import { describe, expect, it } from 'vitest'
import { createIpcInvocationContext, getIpcInvocationOrigin } from './ipcInvocationOrigin'

const url = 'file:///app/index.html#/agent-management'
const method = 'svcMagicAgentPlatform.readInstalledCatalog'

describe('MAIN-only IPC invocation origin sidechannel', () => {
  it('retains actual sender/frame identity on only the transport-created context without adding serialized authority', () => {
    const sender = { id: 42, getURL: () => url }, frame = { url, parent: null }
    const invocation = createIpcInvocationContext(method, { sender, senderFrame: frame })
    const origin = getIpcInvocationOrigin(invocation)
    expect(origin?.sender).toBe(sender); expect(origin?.frame).toBe(frame)
    expect(Object.isFrozen(origin)).toBe(true)
    expect(Object.isFrozen(invocation)).toBe(true)
    expect(invocation).toEqual({ methodName: method, senderId: 42, senderUrl: url, frameUrl: url, isMainFrame: true })
    expect(Object.getOwnPropertySymbols(invocation)).toEqual([])
    expect(JSON.stringify(invocation)).not.toContain('getURL')
    expect(getIpcInvocationOrigin({ ...invocation })).toBeUndefined()
    expect(getIpcInvocationOrigin(JSON.parse(JSON.stringify(invocation)))).toBeUndefined()
  })

  it('does not accept forged context fields, identity properties or unknown methods as an origin', () => {
    const sender = { id: 42, getURL: () => url }, frame = { url, parent: null }
    const invocation = { methodName: method, senderId: 42, senderUrl: url, frameUrl: url, isMainFrame: true, sender, frame }
    expect(getIpcInvocationOrigin(invocation)).toBeUndefined()
    expect(getIpcInvocationOrigin(undefined)).toBeUndefined()
    const original = createIpcInvocationContext(method, { sender, senderFrame: frame })
    expect(() => { original.methodName = 'svcMagicAgentPlatform.setEnabled' }).toThrow()
    expect(getIpcInvocationOrigin(original)?.sender).toBe(sender)
  })

  it.each(['sender', 'frame', 'both'] as const)('does not manufacture an origin when %s identity is absent', missing => {
    const invocation = createIpcInvocationContext(method, {
      ...(missing === 'sender' || missing === 'both' ? {} : { sender: { id: 42, getURL: () => url } }),
      ...(missing === 'frame' || missing === 'both' ? {} : { senderFrame: { url, parent: null } })
    })
    expect(getIpcInvocationOrigin(invocation)).toBeUndefined()
  })

  it('captures the Electron frame reference once so scalar fields and origin cannot describe different frames', () => {
    const sender = { id: 42, getURL: () => url }, first = { url, parent: null }, other = { url: 'file:///app/index.html#/settings', parent: {} }
    let reads = 0
    const invocation = createIpcInvocationContext(method, { sender, get senderFrame() { return ++reads === 1 ? first : other } })
    expect(reads).toBe(1)
    expect(invocation.frameUrl).toBe(url); expect(invocation.isMainFrame).toBe(true)
    expect(getIpcInvocationOrigin(invocation)?.frame).toBe(first)
  })

  it('retains call-time URL fields while the sidechannel preserves live object identity', () => {
    let currentUrl = url
    const sender = { id: 42, getURL: () => currentUrl }, frame = { get url() { return currentUrl }, parent: null }
    const original = createIpcInvocationContext(method, { sender, senderFrame: frame })
    currentUrl = 'file:///app/index.html#/settings'
    expect(original.frameUrl).toBe(url); expect(original.senderUrl).toBe(url)
    expect(getIpcInvocationOrigin(original)?.sender).toBe(sender)
    expect(getIpcInvocationOrigin(original)?.frame).toBe(frame)
    expect(frame.url).toBe(currentUrl)
  })
})
