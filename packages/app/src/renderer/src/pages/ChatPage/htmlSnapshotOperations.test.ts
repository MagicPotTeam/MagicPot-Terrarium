import { describe, expect, it, vi } from 'vitest'
describe('body-free HTML snapshot retry ownership', () => {
  it('canonicalizes scope and retries an unanswered restore with its own operation', async () => {
    vi.resetModules(); const m = await import('./htmlSnapshotOperations')
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' }
    const scope = JSON.stringify({ route, conversationId: 'chat', documentToken: 'old' }), tuple = ['saved-id', 1] as const
    const first = m.htmlSnapshotOperation(scope, 'restore', tuple)
    expect(m.htmlSnapshotOperation(JSON.stringify({ conversationId: 'chat', route: { threadId: 'pane', scopeId: 'project', scopeType: 'thread', channel: 'canvas' }, documentToken: 'new' }), 'restore', tuple)).toBe(first)
    // An acknowledgement of another operation leaves this one unanswered.
    m.acknowledgeHtmlRestore(scope, tuple, 'wrong'); expect(m.htmlSnapshotOperation(scope, 'restore', tuple)).toBe(first)
    // Another snapshot revision is another restore.
    expect(m.htmlSnapshotOperation(scope, 'restore', ['saved-id', 2])).not.toBe(first)
  })
  it('makes every restore after an acknowledged one a new operation', async () => {
    vi.resetModules(); const m = await import('./htmlSnapshotOperations')
    const scope = JSON.stringify({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' }, conversationId: 'c' }), tuple = ['saved-id', 3] as const
    const first = m.htmlSnapshotOperation(scope, 'restore', tuple)
    m.acknowledgeHtmlRestore(scope, tuple, first)
    const second = m.htmlSnapshotOperation(scope, 'restore', tuple); expect(second).not.toBe(first)
    // Until main answers it, the second restore keeps its own operation; a late acknowledgement of the
    // first one changes nothing.
    m.acknowledgeHtmlRestore(scope, tuple, first); expect(m.htmlSnapshotOperation(scope, 'restore', tuple)).toBe(second)
    m.acknowledgeHtmlRestore(scope, tuple, second)
    const third = m.htmlSnapshotOperation(scope, 'restore', tuple); expect([first, second]).not.toContain(third)
  })
  it('keeps a save operation for the same app revision', async () => {
    vi.resetModules(); const m = await import('./htmlSnapshotOperations')
    const scope = JSON.stringify({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' }, conversationId: 'c' })
    const save = m.htmlSnapshotOperation(scope, 'save', ['app', 1, 0])
    expect(m.htmlSnapshotOperation(scope, 'save', ['app', 1, 0])).toBe(save)
    expect(m.htmlSnapshotOperation(scope, 'save', ['app', 2, 1])).not.toBe(save)
  })
  it('refuses exhaustion without evicting old uncertain requests', async () => {
    vi.resetModules(); const m = await import('./htmlSnapshotOperations'), scope = JSON.stringify({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' }, conversationId: 'c' })
    const first = m.htmlSnapshotOperation(scope, 'restore', ['first', 1])
    for (let i = 0; i < 511; i++) m.htmlSnapshotOperation(scope, 'save', [i])
    expect(() => m.htmlSnapshotOperation(scope, 'save', ['overflow'])).toThrow('capacity')
    expect(m.htmlSnapshotOperation(scope, 'restore', ['first', 1])).toBe(first)
  })
})
