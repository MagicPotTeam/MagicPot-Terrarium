import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackgroundRemovalDispatcher, type BackgroundRemovalTask } from './dispatcher'
import type {
  LocalComfyCapabilityLease,
  LocalComfyCapabilityRegistry
} from './localComfyCapability'

type MutableCapabilityRegistry = {
  -readonly [Key in keyof LocalComfyCapabilityRegistry]: LocalComfyCapabilityRegistry[Key]
}

const capability: MutableCapabilityRegistry = {
  status: vi.fn<LocalComfyCapabilityRegistry['status']>(),
  acquire: vi.fn<LocalComfyCapabilityRegistry['acquire']>(),
  isCurrent: vi.fn<LocalComfyCapabilityRegistry['isCurrent']>(),
  revoke: vi.fn<LocalComfyCapabilityRegistry['revoke']>(),
  dispose: vi.fn<LocalComfyCapabilityRegistry['dispose']>()
}

function leaseFixture(): LocalComfyCapabilityLease {
  return {
    id: 'lease-1',
    reference: 'local-comfy-rembg:cutout',
    configurationRevision: 'config-1',
    epoch: 0,
    manifestDigest: 'a'.repeat(64),
    expiresAt: Date.now() + 10_000,
    monotonicDeadline: performance.now() + 10_000,
    signal: new AbortController().signal
  }
}

const task = (): BackgroundRemovalTask => ({
  task: 'background-removal',
  requestId: 'request-1',
  capabilityRef: 'local-comfy-rembg:cutout',
  runtimeRef: 'runtime-1',
  modelRef: 'model-1',
  permission: 'background-removal.execute',
  source: {
    mediaRef: 'media-1',
    sha256: 'a'.repeat(64),
    format: 'png',
    width: 2,
    height: 1
  },
  deadline: {
    expiresAt: Date.now() + 10_000,
    monotonicDeadline: performance.now() + 10_000
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  capability.status = vi.fn<LocalComfyCapabilityRegistry['status']>(() => ({
    status: 'configured-but-unattested',
    ready: false
  }))
  capability.acquire = vi.fn<LocalComfyCapabilityRegistry['acquire']>(async () => ({
    status: 'lease',
    lease: leaseFixture()
  }))
  capability.isCurrent = vi.fn<LocalComfyCapabilityRegistry['isCurrent']>(() => true)
})

describe('background-removal dispatcher', () => {
  it('discovers configured capability without claiming readiness or refs', () => {
    const dispatcher = createBackgroundRemovalDispatcher({ capability })
    expect(dispatcher.discover('local-comfy-rembg:cutout')).toEqual({
      capabilityRef: 'local-comfy-rembg:cutout',
      status: { status: 'configured-but-unattested', ready: false },
      ready: false,
      runtimeRef: null,
      modelRef: null
    })
  })

  it('fails closed without a reader or executor and never creates fake tensor/model data', async () => {
    const audit = vi.fn()
    const dispatcher = createBackgroundRemovalDispatcher({ capability, audit })
    await expect(dispatcher.dispatch(task())).resolves.toEqual({
      status: 'unavailable',
      error: 'INPUT_UNAVAILABLE'
    })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'failed', error: 'INPUT_UNAVAILABLE' })
    )
  })

  it('enforces explicit permission before input materialization', async () => {
    const read = vi.fn()
    const dispatcher = createBackgroundRemovalDispatcher({ capability, readManagedMedia: read })
    const denied = { ...task(), permission: 'managed-media-read' as const }
    await expect(dispatcher.dispatch(denied)).resolves.toEqual({
      status: 'unavailable',
      error: 'PERMISSION_DENIED'
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('relays cancellation and does not publish late executor data', async () => {
    const controller = new AbortController()
    const read = vi.fn(async () => Buffer.from('input'))
    const execute = vi.fn(
      async (_task: BackgroundRemovalTask, _input: Buffer, signal: AbortSignal) => {
        controller.abort()
        expect(signal.aborted).toBe(true)
        return Buffer.from('late')
      }
    )
    const dispatcher = createBackgroundRemovalDispatcher({
      capability,
      readManagedMedia: read,
      execute
    })
    await expect(dispatcher.dispatch(task(), controller.signal)).resolves.toEqual({
      status: 'unavailable',
      error: 'CANCELLED'
    })
  })

  it('requires positive bounded deadlines', async () => {
    const dispatcher = createBackgroundRemovalDispatcher({ capability })
    await expect(
      dispatcher.dispatch({ ...task(), deadline: { expiresAt: 0, monotonicDeadline: 0 } })
    ).resolves.toEqual({
      status: 'unavailable',
      error: 'INVALID_REQUEST'
    })
  })
})
