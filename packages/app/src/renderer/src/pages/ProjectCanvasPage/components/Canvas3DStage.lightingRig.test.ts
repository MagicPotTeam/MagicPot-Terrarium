import { describe, expect, it } from 'vitest'

import { resolveStageDecorationDirectionalLights } from './Canvas3DStage'

describe('resolveStageDecorationDirectionalLights', () => {
  it('keeps a key light even in the flat preset used for dense scenes', () => {
    expect(resolveStageDecorationDirectionalLights('flat')).toEqual([
      { position: [4, 6, 7], intensity: 0.34 },
      { position: [-2.5, 3, -1.5], intensity: 0.14 }
    ])
  })

  it('preserves the richer rigs for balanced and full presets', () => {
    expect(resolveStageDecorationDirectionalLights('balanced')).toEqual([
      { position: [4, 6, 7], intensity: 0.62 }
    ])
    expect(resolveStageDecorationDirectionalLights('full')).toEqual([
      { position: [4, 6, 7], intensity: 0.72 },
      { position: [-3, 4, -2], intensity: 0.28 },
      { position: [0, 2, 8], intensity: 0.12 }
    ])
  })
})
