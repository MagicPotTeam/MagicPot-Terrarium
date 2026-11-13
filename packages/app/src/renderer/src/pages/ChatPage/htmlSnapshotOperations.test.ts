import { describe, expect, it, vi } from 'vitest'
describe('body-free HTML snapshot retry ownership', () => {
  it('canonicalizes scope and retains uncertainty but requires acknowledgement before another restore', async () => {
    vi.resetModules(); const m = await import('./htmlSnapshotOperations')
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
    const scope = JSON.stringify({ route, conversationId: 'chat', documentToken: 'old' }), tuple = ['saved-id', 1] as const
    const first = m.htmlSnapshotOperation(scope, 'restore', tuple)
    expect(m.htmlSnapshotOperation(JSON.stringify({ conversationId: 'chat', route: { threadId: 'pane', scopeId: 'project', scopeType: 'thread', channel: 'canvas' }, documentToken: 'new' }), 'restore', tuple)).toBe(first)
    expect(() => m.startAnotherHtmlRestore(scope, tuple)).toThrow('Resolve')
    m.acknowledgeHtmlRestore(scope, tuple, 'wrong'); expect(m.canStartAnotherHtmlRestore(scope, tuple)).toBe(false)
    m.acknowledgeHtmlRestore(scope, tuple, first); expect(m.canStartAnotherHtmlRestore(scope, tuple)).toBe(true)
    m.startAnotherHtmlRestore(scope, tuple); const next = m.htmlSnapshotOperation(scope, 'restore', tuple); expect(next).not.toBe(first)
    m.acknowledgeHtmlRestore(scope, tuple, first); expect(m.canStartAnotherHtmlRestore(scope, tuple)).toBe(false)
    expect(m.htmlSnapshotOperation(scope, 'restore', tuple)).toBe(next)
  })
  it('refuses exhaustion without evicting old uncertain requests', async () => {
    vi.resetModules(); const m = await import('./htmlSnapshotOperations'), scope = JSON.stringify({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' }, conversationId: 'c' })
    const first = m.htmlSnapshotOperation(scope, 'restore', ['first', 1])
    for (let i = 0; i < 511; i++) m.htmlSnapshotOperation(scope, 'save', [i])
    expect(() => m.htmlSnapshotOperation(scope, 'save', ['overflow'])).toThrow('capacity')
    expect(m.htmlSnapshotOperation(scope, 'restore', ['first', 1])).toBe(first)
  })
})
