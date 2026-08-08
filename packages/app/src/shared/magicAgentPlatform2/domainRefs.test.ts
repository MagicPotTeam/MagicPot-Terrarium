import { describe, expect, expectTypeOf, it } from 'vitest'
import { createSessionDomainRef as createSessionDomainRefFromPublicIndex } from './index'
import { getAgentSessionKey } from '../agent'
import {
  MAGIC_AGENT_DOMAIN_REF_DISCRIMINATOR,
  MAGIC_AGENT_DOMAIN_REF_KINDS,
  createAgentDefinitionDomainRef,
  createAgentInstanceDomainRef,
  createGraphDefinitionDomainRef,
  createGraphRunDomainRef,
  createMagicAgentDomainRef,
  createSessionDomainRef,
  parseMagicAgentDomainRef,
  parseMagicAgentExecutionRefs,
  type MagicAgentDomainRef,
  type MagicAgentExecutionRefs
} from './domainRefs'

const baseRef = (kind = 'artifact', id = 'artifact:one/path') => ({
  discriminator: MAGIC_AGENT_DOMAIN_REF_DISCRIMINATOR,
  kind,
  id
})

describe('MagicAgentDomainRef', () => {
  it('declares standard kinds and accepts future custom kinds', () => {
    expect(MAGIC_AGENT_DOMAIN_REF_KINDS).toEqual(
      expect.arrayContaining([
        'agent-definition',
        'agent-instance',
        'graph-definition',
        'graph-run'
      ])
    )
    expect(parseMagicAgentDomainRef(baseRef('future-resource')).ok).toBe(true)
  })

  it('preserves specific kinds in helper and generic creator types', () => {
    const definition = createAgentDefinitionDomainRef('same')
    const instance = createAgentInstanceDomainRef('same')
    const custom = createMagicAgentDomainRef({
      kind: 'future-resource',
      id: 'future/1',
      future: { enabled: true }
    })

    expect(definition.kind).toBe('agent-definition')
    expect(instance.kind).toBe('agent-instance')
    expectTypeOf(definition).toEqualTypeOf<MagicAgentDomainRef<'agent-definition'>>()
    expectTypeOf(instance).toEqualTypeOf<MagicAgentDomainRef<'agent-instance'>>()
    expectTypeOf(custom).toEqualTypeOf<MagicAgentDomainRef<'future-resource'>>()
  })

  it('preserves opaque identifiers and optional versions', () => {
    expect(createGraphRunDomainRef('tenant:run/42').id).toBe('tenant:run/42')
    expect(createGraphDefinitionDomainRef('graphs/a:b', ' v2 ')).toMatchObject({
      id: 'graphs/a:b',
      version: ' v2 '
    })
  })

  it('exports DomainRef helpers through the public module index', () => {
    const route = { channel: 'generic', scopeType: 'dm', scopeId: 'public-index' }
    expect(createSessionDomainRefFromPublicIndex(route).id).toBe(getAgentSessionKey(route))
  })

  it('uses the existing normalized session key exactly', () => {
    const route = {
      channel: ' telegram ',
      scopeType: 'group',
      scopeId: ' room-9 ',
      threadId: ' t/2 '
    }
    expect(createSessionDomainRef(route).id).toBe(getAgentSessionKey(route))
  })

  it('rejects ASCII control characters in identifiers', () => {
    expect(parseMagicAgentDomainRef(baseRef('artifact', 'line\nbreak')).ok).toBe(false)
    expect(
      parseMagicAgentDomainRef(baseRef('artifact', `delete${String.fromCharCode(0x7f)}`)).ok
    ).toBe(false)
    expect(parseMagicAgentDomainRef(baseRef('artifact', 'emoji/😀')).ok).toBe(true)
  })

  it('validates revisions', () => {
    expect(parseMagicAgentDomainRef({ ...baseRef(), revision: 0 }).ok).toBe(true)
    expect(parseMagicAgentDomainRef({ ...baseRef(), revision: -1 }).ok).toBe(false)
    expect(
      parseMagicAgentDomainRef({ ...baseRef(), revision: Number.MAX_SAFE_INTEGER + 1 }).ok
    ).toBe(false)
  })

  it('detaches, preserves, and deeply freezes unknown JSON-safe fields', () => {
    const input = {
      ...baseRef(),
      extensions: { nested: { enabled: true } },
      future: { values: [1, { label: 'original' }] }
    }
    const parsed = parseMagicAgentDomainRef(input)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    ;(input.future.values[1] as { label: string }).label = 'changed'
    input.extensions.nested.enabled = false
    expect(parsed.value.future).toEqual({ values: [1, { label: 'original' }] })
    expect(parsed.value.extensions).toEqual({ nested: { enabled: true } })
    expect(Object.isFrozen(parsed.value)).toBe(true)
    expect(Object.isFrozen((parsed.value.future as { values: unknown[] }).values)).toBe(true)
  })

  it('accepts null-prototype records', () => {
    const input = Object.assign(Object.create(null), baseRef(), {
      extensions: Object.assign(Object.create(null), { safe: true })
    })
    expect(parseMagicAgentDomainRef(input).ok).toBe(true)
  })

  it('rejects unsafe records/accessors and safely handles throwing proxies', () => {
    class Unsafe {}
    const getter = { ...baseRef() }
    Object.defineProperty(getter, 'future', { enumerable: true, get: () => 'nope' })
    const sparse = Array(3)
    sparse[0] = 1
    sparse[2] = 3
    const cyclic: Record<string, unknown> = { ...baseRef() }
    cyclic.self = cyclic
    const dangerous = Object.create(null) as Record<string, unknown>
    Object.assign(dangerous, baseRef())
    dangerous.__proto__ = 'bad'
    const throwingProxy = new Proxy(baseRef(), {
      getOwnPropertyDescriptor() {
        throw new Error('blocked')
      }
    })
    for (const input of [
      new Unsafe(),
      getter,
      throwingProxy,
      { ...baseRef(), future: undefined },
      { ...baseRef(), future: () => undefined },
      { ...baseRef(), future: Number.NaN },
      { ...baseRef(), future: sparse },
      cyclic,
      dangerous
    ]) {
      expect(() => parseMagicAgentDomainRef(input)).not.toThrow()
      expect(parseMagicAgentDomainRef(input).ok).toBe(false)
    }
  })

  it('creates refs through validated detached input', () => {
    const extensions = { nested: { value: 1 } }
    const created = createMagicAgentDomainRef({ kind: 'tool', id: 'tool/x:y', extensions })
    extensions.nested.value = 2
    expect(created.extensions).toEqual({ nested: { value: 1 } })
  })
})

describe('MagicAgentExecutionRefs', () => {
  it('statically associates each field with its domain kind', () => {
    const executionRefs: MagicAgentExecutionRefs = {
      session: createSessionDomainRef({ channel: 'x', scopeType: 'dm', scopeId: 'y' }),
      run: createGraphRunDomainRef('run/1'),
      graphDefinition: createGraphDefinitionDomainRef('graph/1'),
      agentDefinition: createAgentDefinitionDomainRef('agent/1'),
      agentInstance: createAgentInstanceDomainRef('instance/1')
    }
    expectTypeOf(executionRefs.run).toEqualTypeOf<MagicAgentDomainRef<'graph-run'> | undefined>()

    const session = createSessionDomainRef({ channel: 'x', scopeType: 'dm', scopeId: 'y' })
    const invalid: MagicAgentExecutionRefs = {
      // @ts-expect-error A run reference must have graph-run kind.
      run: session
    }
    expect(invalid.run?.kind).toBe('session')
  })

  it('requires at least one correctly typed ref', () => {
    expect(parseMagicAgentExecutionRefs({}).ok).toBe(false)
    expect(
      parseMagicAgentExecutionRefs({
        run: createSessionDomainRef({ channel: 'x', scopeType: 'dm', scopeId: 'y' })
      }).ok
    ).toBe(false)
    expect(
      parseMagicAgentExecutionRefs({
        run: createGraphRunDomainRef('run/1'),
        rootRun: createGraphRunDomainRef('root:1'),
        agentDefinition: createAgentDefinitionDomainRef('agent/1')
      }).ok
    ).toBe(true)
  })

  it('deep-freezes and detaches execution refs', () => {
    const run = { ...baseRef('graph-run', 'run:original'), extensions: { nested: { value: 1 } } }
    const input = { run }
    const parsed = parseMagicAgentExecutionRefs(input)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    run.id = 'changed'
    run.extensions.nested.value = 2
    expect(parsed.value.run?.id).toBe('run:original')
    expect(parsed.value.run?.extensions).toEqual({ nested: { value: 1 } })
    expect(Object.isFrozen(parsed.value.run?.extensions)).toBe(true)
  })
})
