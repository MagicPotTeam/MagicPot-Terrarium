import { afterEach, describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { ComfyInstanceRegistry } from './instanceRegistry'

const stores: MagicAgentEventStore[] = []
const open = () => {
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('ComfyInstanceRegistry', () => {
  it('creates, replays idempotently, updates health and removes an instance', () => {
    const registry = new ComfyInstanceRegistry(open())
    const input = {
      id: 'gpu-a',
      name: 'GPU A',
      origin: 'http://127.0.0.1:8188/',
      kind: 'local' as const,
      tags: ['flux'],
      createdAt: 100,
      idempotencyKey: 'create-1'
    }
    const created = registry.create(input)
    expect(created.state.origin).toBe('http://127.0.0.1:8188/')
    expect(registry.create(input)).toEqual(created)
    const healthy = registry.updateHealth({
      id: 'gpu-a',
      expectedRevision: created.revision,
      status: 'online',
      checkedAt: 101,
      idempotencyKey: 'health-1'
    })
    expect(healthy.state.health.status).toBe('online')
    const removed = registry.remove({
      id: 'gpu-a',
      expectedRevision: healthy.revision,
      removedAt: 102,
      idempotencyKey: 'remove-1'
    })
    expect(removed.deleted).toBe(true)
  })
  it.each(['file:///tmp/comfy', 'ftp://host:8188', 'http://user:pass@host:8188/'])(
    'rejects unsafe origin %s',
    (origin) => {
      const registry = new ComfyInstanceRegistry(open())
      expect(() =>
        registry.create({ id: 'x', name: 'X', origin, createdAt: 1, idempotencyKey: 'x' })
      ).toThrow('Invalid ComfyUI origin')
    }
  )
  it.each([
    'http://0.0.0.0:8188',
    'http://10.0.0.1:8188',
    'http://100.64.0.1:8188',
    'http://127.0.0.1:8188',
    'http://169.254.169.254:8188',
    'http://172.16.0.1:8188',
    'http://192.88.99.1:8188',
    'http://192.168.1.1:8188',
    'http://224.0.0.1:8188',
    'http://[::]:8188',
    'http://[::1]:8188',
    'http://[::8.8.8.8]:8188',
    'http://[64:ff9b::7f00:1]:8188',
    'http://[2001::1]:8188',
    'http://[2002:7f00:1::]:8188',
    'http://[3fff::1]:8188',
    'http://[fc00::1]:8188',
    'http://[fec0::1]:8188',
    'http://[fe80::1]:8188',
    'http://[ff02::1]:8188',
    'http://[::ffff:10.0.0.1]:8188',
    'http://[::ffff:127.0.0.1]:8188',
    'http://[::ffff:169.254.169.254]:8188',
    'http://[::ffff:192.88.99.1]:8188',
    'http://[::ffff:192.168.1.1]:8188'
  ])('rejects unsafe literal IP destination %s', (origin) => {
    const registry = new ComfyInstanceRegistry(open())
    expect(() =>
      registry.create({ id: 'x', name: 'X', origin, createdAt: 1, idempotencyKey: origin })
    ).toThrow('Unsafe ComfyUI literal IP destination')
  })
  it('uses optimistic revisions and detects idempotency conflicts', () => {
    const registry = new ComfyInstanceRegistry(open())
    const created = registry.create({
      id: 'gpu-a',
      name: 'A',
      origin: 'http://a:8188',
      createdAt: 1,
      idempotencyKey: 'x'
    })
    expect(() =>
      registry.update({
        id: 'gpu-a',
        expectedRevision: 9,
        updatedAt: 2,
        idempotencyKey: 'u',
        patch: { enabled: false }
      })
    ).toThrow('revision conflict')
    expect(() =>
      registry.create({
        id: 'gpu-a',
        name: 'Other',
        origin: 'http://a:8188',
        createdAt: 1,
        idempotencyKey: 'x'
      })
    ).toThrow('idempotency conflict')
    expect(created.revision).toBe(0)
  })
})
