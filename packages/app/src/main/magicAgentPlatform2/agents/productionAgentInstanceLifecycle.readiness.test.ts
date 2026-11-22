import { describe, expect, it, vi } from 'vitest'
import type { PersistentAgentInstanceStore } from './persistentAgentInstanceStore'
import type { MagicAgentPolicyAuthorizationService } from '../policy'
import { ProductionAgentInstanceLifecycleService } from './productionAgentInstanceLifecycle'

/** Real service with unused throwing dependencies; never constructs EventStore or reads a DB. */
const fixture = () => {
  const touched = vi.fn((): never => { throw new Error('Dependency access forbidden') })
  const dependency = new Proxy({}, { get: touched, ownKeys: touched, getPrototypeOf: touched })
  const run = vi.fn((): never => { throw new Error('Run forbidden') })
  const now = vi.fn((): never => { throw new Error('Clock forbidden') })
  const service = new ProductionAgentInstanceLifecycleService(
    dependency as PersistentAgentInstanceStore,
    dependency as MagicAgentPolicyAuthorizationService,
    run, now
  )
  return { service, touched, run, now }
}

describe('real service scalar closing observation, no initialization or work', () => {
  it('is false initially without touching stores, policy, run or clock', () => {
    const f = fixture()
    for (let i = 0; i < 4; i++) expect(f.service.isClosing()).toBe(false)
    expect(f.touched).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled(); expect(f.now).not.toHaveBeenCalled()
  })
  it('becomes permanently true synchronously on empty close and preserves the exact close join', async () => {
    const f = fixture()
    expect(f.service.isClosing()).toBe(false)
    const first = f.service.close()
    expect(f.service.isClosing()).toBe(true); expect(f.service.close()).toBe(first)
    await first
    expect(f.service.isClosing()).toBe(true); expect(f.service.close()).toBe(first)
    expect(f.touched).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled(); expect(f.now).not.toHaveBeenCalled()
  })
})
