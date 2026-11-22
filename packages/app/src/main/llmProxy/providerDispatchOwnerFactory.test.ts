import { afterEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ available: vi.fn(() => false) }))
vi.mock('../figplugin/checkpointEncryption', () => ({ checkpointCodec: { available: h.available } }))
vi.mock('../figplugin/checkpointBinaryCodec', () => ({ createCheckpointBinaryCodec: vi.fn() }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: vi.fn() }))
afterEach(() => { vi.resetModules(); vi.restoreAllMocks() })
describe('production owner shutdown is a permanent no-open fence for this process', () => {
  it('retirement while lazy imports are pending rejects initialization before codec use or filesystem selection', async () => {
    vi.resetModules(); h.available.mockClear()
    const value = await import('./providerDispatchOwner'), pending = value.getProviderDispatchOwner()
    const observed = pending.catch(error => error), shutdown = value.shutdownProviderDispatchOwner().catch(error => error)
    expect(await observed).toMatchObject({ message: expect.stringContaining('retired during initialization') })
    expect(await shutdown).toBeInstanceOf(Error)
    expect(h.available).not.toHaveBeenCalled()
    await expect(value.getProviderDispatchOwner()).rejects.toThrow('retired for application shutdown')
  })
  it('retires an unopened lazy factory without initializing OS encryption or storage', async () => {
    const value = await import('./providerDispatchOwner')
    await value.shutdownProviderDispatchOwner()
    await expect(value.getProviderDispatchOwner()).rejects.toThrow('retired for application shutdown')
    await value.shutdownProviderDispatchOwner()
  })
})
