import { describe, expect, it } from 'vitest'

import {
  applyCanvasTargetStageDraftProfileConstraints,
  createCanvasTargetStageDraft,
  resolveCanvasTargetSupportedOutputFormats
} from './canvasTargetTypes'

describe('canvasTargetTypes auxiliary model constraints', () => {
  it('leaves new llm stages without a preset responsibility', () => {
    expect(createCanvasTargetStageDraft().responsibilityType).toBeUndefined()
    expect(createCanvasTargetStageDraft().outputFormats).toEqual([])
    expect(createCanvasTargetStageDraft().outputFormat).toBeUndefined()
  })

  it('keeps llm stages unrestricted by legacy responsibility hints', () => {
    const constrained = applyCanvasTargetStageDraftProfileConstraints(
      {
        profileId: 'vision-1',
        responsibilityType: 'final_review',
        allowedInputs: ['scheme_files', 'selection_snapshot'],
        outputFormats: ['json']
      },
      {
        profileId: 'vision-1',
        executionBackend: 'llm',
        modelUse: 'multimodal'
      }
    )

    expect(constrained.responsibilityType).toBeUndefined()
    expect(constrained.allowedInputs).toEqual(['scheme_files', 'selection_snapshot'])
    expect(constrained.outputFormats).toEqual(['json'])
  })

  it('locks user-selected local model stages to image-safe target constraints', () => {
    const constrained = applyCanvasTargetStageDraftProfileConstraints(
      {
        profileId: 'agent-local:vision-1',
        responsibilityType: 'final_review',
        allowedInputs: ['scheme_files', 'selection_snapshot'],
        outputFormats: ['image']
      },
      {
        profileId: 'agent-local:vision-1',
        executionBackend: 'local_model'
      }
    )

    expect(constrained.responsibilityType).toBe('visual_analysis')
    expect(constrained.allowedInputs).toEqual(['selection_snapshot'])
    expect(constrained.outputFormats).toEqual([])
    expect(constrained.outputFormat).toBeUndefined()
  })

  it('always keeps image available as an additional output format for llm-backed stages', () => {
    expect(
      resolveCanvasTargetSupportedOutputFormats({
        profileId: 'gpt-4.1',
        executionBackend: 'llm',
        modelUse: 'chat'
      })
    ).toEqual(['plain_text', 'markdown', 'json', 'table', 'image'])
  })

  it('only adds video and 3d when the profile metadata indicates those capabilities', () => {
    expect(
      resolveCanvasTargetSupportedOutputFormats({
        profileId: 'veo-3-fast',
        executionBackend: 'llm',
        modelUse: 'chat'
      })
    ).toEqual(['plain_text', 'markdown', 'json', 'table', 'image', 'video'])

    expect(
      resolveCanvasTargetSupportedOutputFormats({
        profileId: 'tripo-v2',
        executionBackend: 'llm',
        modelUse: 'chat'
      })
    ).toEqual(['plain_text', 'markdown', 'json', 'table', 'image', 'model3d'])
  })

  it('reports local model stages as markdown/json/plain-text only', () => {
    expect(
      resolveCanvasTargetSupportedOutputFormats({
        profileId: 'agent-local:vision-1',
        executionBackend: 'local_model'
      })
    ).toEqual(['markdown', 'json', 'plain_text'])
  })
})
