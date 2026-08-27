import { describe, expect, it } from 'vitest'
import { getComfyProfileStatusLabel } from './comfyBatchProfileDisplay'

describe('Comfy batch profile status label', () => {
  it('formats successful probe latency for the startup switch', () => {
    expect(getComfyProfileStatusLabel({ ok: true, latencyMs: 7 })).toBe('7 ms')
  })

  it('does not show a status label before a successful probe', () => {
    expect(getComfyProfileStatusLabel()).toBe('')
    expect(getComfyProfileStatusLabel({ ok: false, latencyMs: 0 })).toBe('')
  })

  it('shows probe errors beside the startup switch', () => {
    expect(getComfyProfileStatusLabel({ ok: false, latencyMs: 0, error: 'fetch failed' })).toBe(
      'fetch failed'
    )
  })
})
