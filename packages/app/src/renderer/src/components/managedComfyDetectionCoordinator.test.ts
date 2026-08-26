import { describe, expect, it, vi } from 'vitest'
import { detectManagedComfyProcess } from './managedComfyDetectionCoordinator'

describe('detectManagedComfyProcess', () => {
  it('shares one in-flight managed ComfyUI port detection', async () => {
    let resolveDetection: ((value: { pid: number }) => void) | undefined
    const detect = vi.fn(
      () =>
        new Promise<{ pid: number }>((resolve) => {
          resolveDetection = resolve
        })
    )

    const first = detectManagedComfyProcess(detect)
    const second = detectManagedComfyProcess(detect)

    expect(detect).toHaveBeenCalledTimes(1)
    resolveDetection?.({ pid: 4321 })
    await expect(Promise.all([first, second])).resolves.toEqual([{ pid: 4321 }, { pid: 4321 }])
  })
})
