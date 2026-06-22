import { describe, expect, it } from 'vitest'
import comfyProcessSlice, {
  addOutput,
  addOutputBatch,
  MAX_COMFY_OUTPUT_LINES
} from './comfyProcess'

describe('comfyProcessSlice output retention', () => {
  it('caps retained Comfy output when appending individual lines', () => {
    const state = comfyProcessSlice.reducer(
      {
        pid: 0,
        isRunning: false,
        output: Array.from({ length: MAX_COMFY_OUTPUT_LINES }, (_, index) => `line-${index}`)
      },
      addOutput(`line-${MAX_COMFY_OUTPUT_LINES}`)
    )

    expect(state.output).toHaveLength(MAX_COMFY_OUTPUT_LINES)
    expect(state.output[0]).toBe('line-1')
    expect(state.output.at(-1)).toBe(`line-${MAX_COMFY_OUTPUT_LINES}`)
  })

  it('caps retained Comfy output when appending 20,000 log lines in a batch', () => {
    const state = comfyProcessSlice.reducer(
      undefined,
      addOutputBatch(Array.from({ length: 20_000 }, (_, index) => `line-${index}`))
    )

    expect(state.output).toHaveLength(MAX_COMFY_OUTPUT_LINES)
    expect(state.output[0]).toBe(`line-${20_000 - MAX_COMFY_OUTPUT_LINES}`)
    expect(state.output.at(-1)).toBe('line-19999')
  })
})
