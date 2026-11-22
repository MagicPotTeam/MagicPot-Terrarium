import { normalizedSessionsEqual, type ChatSession } from './chatStorage'

interface LineageNode {
  readonly scope: string
  readonly id: string
  readonly session: ChatSession
  readonly snapshot: ChatSession
  readonly expectedSession: ChatSession | null
  readonly parent?: LineageNode
}

/**
 * Isolated synchronous lineage primitive; it is not currently wired to ChatPage or storage.
 *
 * The caller must independently authorize every origin: a verified load, commit or explicit new
 * record. A caller can still misuse `adopt` or derive stale external fields. A lineage is not a
 * storage CAS, cross-window freshness proof, IPC boundary or permission to dispatch effects.
 */
export class ChatSessionLineage {
  private current = new Map<string, Map<string, LineageNode>>()
  private nodes = new WeakMap<ChatSession, Map<string, LineageNode>>()

  private scopeKey(scope: string): string {
    return scope || 'default'
  }

  private same(node: LineageNode, session: ChatSession): boolean {
    return session.id === node.id && normalizedSessionsEqual(session, node.snapshot, node.scope)
  }

  private getCurrent(scope: string, id: string): LineageNode | undefined {
    return this.current.get(this.scopeKey(scope))?.get(id)
  }

  private register(node: LineageNode): void {
    const scoped = this.current.get(node.scope) ?? new Map<string, LineageNode>()
    scoped.set(node.id, node)
    this.current.set(node.scope, scoped)
    const attached = this.nodes.get(node.session) ?? new Map<string, LineageNode>()
    attached.set(node.scope, node)
    this.nodes.set(node.session, attached)
  }

  private requireCurrent(scope: string, session: ChatSession): LineageNode {
    const node = this.getCurrent(scope, session.id)
    if (!node || node.session !== session || !this.same(node, session)) {
      throw new Error('Session snapshot is not current')
    }
    return node
  }

  /** Authorize one externally validated origin and invalidate the preceding lineage for this key. */
  adopt(scope: string, session: ChatSession, expectedSession: ChatSession | null): void {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id ||
      (expectedSession !== null && expectedSession.id !== session.id)) {
      throw new Error('Invalid session lineage origin')
    }
    const node: LineageNode = {
      scope: this.scopeKey(scope),
      id: session.id,
      session,
      snapshot: structuredClone(session),
      expectedSession: expectedSession === null ? null : structuredClone(expectedSession)
    }
    this.register(node)
  }

  /** Apply a synchronous, trusted transformation to a copy of the exact current parent. */
  derive(scope: string, parent: ChatSession, update: (parent: ChatSession) => ChatSession): ChatSession {
    const previous = this.requireCurrent(scope, parent)
    const next = update(structuredClone(previous.snapshot))
    // Do not let a nested reset, adoption, update, or parent mutation make a late result current.
    if (this.getCurrent(scope, previous.id) !== previous || !this.same(previous, parent)) {
      throw new Error('Session lineage changed during update')
    }
    if (!next || typeof next !== 'object' || typeof next.id !== 'string' || next.id !== previous.id) {
      throw new Error('Invalid session lineage update')
    }
    const node: LineageNode = {
      scope: previous.scope,
      id: previous.id,
      session: next,
      snapshot: structuredClone(next),
      expectedSession: previous.expectedSession === null ? null : structuredClone(previous.expectedSession),
      parent: previous
    }
    this.register(node)
    return next
  }

  /** Return defensive copies; capture does not certify that IndexedDB still contains the record. */
  capture(scope: string, session: ChatSession): {payload: ChatSession; expectedSession: ChatSession | null} {
    const node = this.requireCurrent(scope, session)
    return {
      payload: structuredClone(node.snapshot),
      expectedSession: node.expectedSession === null ? null : structuredClone(node.expectedSession)
    }
  }

  isCurrent(scope: string, session: ChatSession): boolean {
    const node = this.getCurrent(scope, session.id)
    return !!node && node.session === session && this.same(node, session)
  }

  /** Prove exact object ancestry within the currently adopted origin, not cross-writer freshness. */
  isDescendant(scope: string, session: ChatSession, ancestor: ChatSession): boolean {
    const node = this.getCurrent(scope, session.id)
    if (!node || node.session !== session || !this.same(node, session)) return false
    const ancestorNode = this.nodes.get(ancestor)?.get(this.scopeKey(scope))
    if (!ancestorNode || ancestorNode.id !== node.id || !this.same(ancestorNode, ancestor)) return false
    let cursor = node.parent
    while (cursor) {
      if (cursor === ancestorNode) return true
      cursor = cursor.parent
    }
    return false
  }

  release(scope: string, sessionId: string): void {
    const normalized = this.scopeKey(scope)
    const scoped = this.current.get(normalized)
    scoped?.delete(sessionId)
    if (scoped?.size === 0) this.current.delete(normalized)
  }

  reset(): void {
    this.current.clear()
  }
}
