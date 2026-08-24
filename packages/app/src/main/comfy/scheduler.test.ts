import { describe, expect, it } from 'vitest'
import { ComfyLeastUtilizationScheduler, getWorkflowRequiredNodeClasses } from './scheduler'
import type { ComfyInstanceState } from '@shared/comfy/dispatch'

const instance = (id: string, maxConcurrency = 2): ComfyInstanceState => ({
  id,
  name: id,
  origin: `http://${id}:8188/`,
  kind: 'remote',
  enabled: true,
  maxConcurrency,
  tags: [],
  capabilities: { tags: [], models: [], customNodes: ['LoadImage', 'SaveImage'] },
  health: { status: 'online' }
})

describe('ComfyLeastUtilizationScheduler', () => {
  it('chooses least utilization then round-robins ties', () => {
    const scheduler = new ComfyLeastUtilizationScheduler()
    const candidates = [
      { state: instance('a'), active: 1, pending: 0 },
      { state: instance('b'), active: 0, pending: 0 },
      { state: instance('c'), active: 0, pending: 0 }
    ]
    expect(
      scheduler.select(candidates, { mode: 'auto' }, { customNodes: ['LoadImage'] })?.state.id
    ).toBe('b')
    expect(
      scheduler.select(candidates, { mode: 'auto' }, { customNodes: ['LoadImage'] })?.state.id
    ).toBe('c')
  })

  it('filters incompatible, full and excluded instances', () => {
    const scheduler = new ComfyLeastUtilizationScheduler()
    expect(
      scheduler.select(
        [
          { state: instance('full', 1), active: 1, pending: 0 },
          { state: instance('ok'), active: 0, pending: 0 }
        ],
        { mode: 'auto' },
        { customNodes: ['SaveImage'] },
        new Set(['ok'])
      )
    ).toBeUndefined()
  })

  it('treats queued server work as consumed capacity', () => {
    const scheduler = new ComfyLeastUtilizationScheduler()
    expect(
      scheduler.select(
        [{ state: instance('queued', 1), active: 0, pending: 1 }],
        { mode: 'auto' },
        { customNodes: ['LoadImage'] }
      )
    ).toBeUndefined()
  })

  it('derives workflow class requirements without mutating the workflow', () => {
    const workflow = { '2': { class_type: 'SaveImage' }, '1': { class_type: 'LoadImage' } }
    expect(getWorkflowRequiredNodeClasses(workflow)).toEqual(['LoadImage', 'SaveImage'])
    expect(workflow['1'].class_type).toBe('LoadImage')
  })
})
