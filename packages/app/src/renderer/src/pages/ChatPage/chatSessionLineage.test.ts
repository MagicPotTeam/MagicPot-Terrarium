import { describe, expect, it } from 'vitest'
import { ChatSessionLineage } from './chatSessionLineage'
import type { ChatSession } from './chatStorage'

const makeSession = (id = 's'): ChatSession => ({
  id,
  title: 'original',
  messages: [{role: 'user', content: 'question'}]
})

describe('ChatSessionLineage (isolated, not wired to persistence)', () => {
  it('binds an exact loaded object and its captured expected record', () => {
    const lineage = new ChatSessionLineage()
    const loaded = makeSession()
    lineage.adopt('scope', loaded, loaded)
    expect(lineage.isCurrent('scope', loaded)).toBe(true)
    const receipt = lineage.capture('scope', loaded)
    expect(receipt.expectedSession).toEqual(loaded)
    expect(receipt.payload).toEqual(loaded)
    expect(receipt.payload).not.toBe(loaded)
    receipt.payload.title = 'tampered copy'
    expect(lineage.capture('scope', loaded).payload.title).toBe('original')
  })

  it('only derives from the exact current object, not an identical or stale clone', () => {
    const lineage = new ChatSessionLineage()
    const original = makeSession()
    lineage.adopt('scope', original, original)
    expect(() => lineage.derive('scope', structuredClone(original), parent => ({...parent,title:'bad'}))).toThrow()
    const next = lineage.derive('scope', original, parent => ({...parent,title:'new'}))
    expect(lineage.isCurrent('scope', original)).toBe(false)
    expect(lineage.isCurrent('scope', next)).toBe(true)
    expect(lineage.isDescendant('scope', next, original)).toBe(true)
    expect(() => lineage.derive('scope', original, parent => ({...parent,title:'late'}))).toThrow()
  })

  it('tracks multi-generation non-append updates without trusting a value-prefix branch', () => {
    const lineage = new ChatSessionLineage()
    const original = makeSession()
    lineage.adopt('scope', original, original)
    const placeholder = lineage.derive('scope', original, parent => ({...parent,messages:[...parent.messages,{role:'assistant',content:''}]}))
    const finished = lineage.derive('scope', placeholder, parent => ({...parent,messages:[...parent.messages.slice(0,-1),{role:'assistant',content:'reply'}]}))
    const independent = {...structuredClone(original),messages:[...original.messages,{role:'assistant' as const,content:'reply'}]}
    expect(lineage.isDescendant('scope', finished, original)).toBe(true)
    expect(lineage.isDescendant('scope', finished, placeholder)).toBe(true)
    expect(lineage.isDescendant('scope', independent, placeholder)).toBe(false)
    expect(() => lineage.capture('scope', independent)).toThrow()
  })

  it('binds scope and id without ambiguous delimiter collisions', () => {
    const lineage = new ChatSessionLineage()
    const first = makeSession('b\u0000c')
    const second = makeSession('c')
    lineage.adopt('a', first, first)
    lineage.adopt('a\u0000b', second, second)
    expect(lineage.isCurrent('a', first)).toBe(true)
    expect(lineage.isCurrent('a\u0000b', second)).toBe(true)
    expect(lineage.isCurrent('a\u0000b', first)).toBe(false)
    expect(() => lineage.capture('wrong-scope', first)).toThrow()
  })

  it('fails closed after object mutation, but permits changing a copy during derivation', () => {
    const lineage = new ChatSessionLineage()
    const original = makeSession()
    lineage.adopt('scope', original, original)
    const next = lineage.derive('scope', original, parent => {
      parent.messages[0].content = 'edited'
      return {...parent,title:'renamed'}
    })
    expect(original.messages[0].content).toBe('question')
    expect(next.messages[0].content).toBe('edited')
    next.messages[0].content = 'mutated outside update'
    expect(lineage.isCurrent('scope', next)).toBe(false)
    expect(() => lineage.capture('scope', next)).toThrow()
  })

  it('rejects reentrant adoption during a derivation and preserves the newly adopted state', () => {
    const lineage = new ChatSessionLineage()
    const old = makeSession()
    const external = {...old,title:'external'}
    lineage.adopt('scope', old, old)
    expect(() => lineage.derive('scope', old, parent => {
      lineage.adopt('scope', external, external)
      return {...parent,title:'late result'}
    })).toThrow()
    expect(lineage.isCurrent('scope', external)).toBe(true)
    expect(lineage.capture('scope', external).expectedSession).toEqual(external)
  })

  it('rejects an asynchronous updater without adopting its late result', async () => {
    const lineage = new ChatSessionLineage()
    const original = makeSession()
    lineage.adopt('scope', original, original)
    expect(() => lineage.derive('scope', original, (async parent => ({...parent,title:'later'})) as unknown as (parent: ChatSession) => ChatSession)).toThrow()
    await Promise.resolve()
    expect(lineage.isCurrent('scope', original)).toBe(true)
  })

  it('does not permit a derive operation to change the identity', () => {
    const lineage = new ChatSessionLineage()
    const original = makeSession()
    lineage.adopt('scope', original, original)
    expect(() => lineage.derive('scope', original, parent => ({...parent,id:'other'}))).toThrow()
    expect(lineage.isCurrent('scope', original)).toBe(true)
  })

  it('invalidates old nodes on adopt, release and reset without affecting other keys', () => {
    const lineage = new ChatSessionLineage()
    const original = makeSession('one')
    const other = makeSession('two')
    lineage.adopt('scope', original, original)
    lineage.adopt('scope', other, other)
    const next = lineage.derive('scope', original, parent => ({...parent,title:'local'}))
    const replacement = {...original,title:'loaded'}
    lineage.adopt('scope', replacement, replacement)
    expect(lineage.isDescendant('scope', next, original)).toBe(false)
    expect(() => lineage.capture('scope', next)).toThrow()
    expect(lineage.isCurrent('scope', other)).toBe(true)
    lineage.release('scope', replacement.id)
    expect(lineage.isCurrent('scope', replacement)).toBe(false)
    lineage.reset()
    expect(lineage.isCurrent('scope', other)).toBe(false)
  })

  it('supports a distinct explicit new-session origin with an absent-record expectation', () => {
    const lineage = new ChatSessionLineage()
    const created = makeSession('new')
    lineage.adopt('scope', created, null)
    const next = lineage.derive('scope', created, parent => ({...parent,title:'edited before create'}))
    expect(lineage.capture('scope', next).expectedSession).toBeNull()
    expect(() => lineage.adopt('scope', makeSession('wrong'), makeSession('different'))).toThrow()
  })

  it('keeps old captured payloads immutable across later descendants', () => {
    const lineage = new ChatSessionLineage()
    const original = makeSession()
    lineage.adopt('scope', original, original)
    const first = lineage.derive('scope', original, parent => ({...parent,title:'first'}))
    const firstReceipt = lineage.capture('scope', first)
    lineage.derive('scope', first, parent => ({...parent,title:'second'}))
    expect(firstReceipt.payload.title).toBe('first')
    expect(firstReceipt.expectedSession?.title).toBe('original')
  })
})
