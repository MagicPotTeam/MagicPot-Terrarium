import { describe, expect, it } from 'vitest'
import comfyProcessSlice, {
  addOutput,
  addOutputBatch,
  clearOutput,
  MAX_COMFY_OUTPUT_LINES
} from './comfyProcess'
import {
  MAX_LOG_CHARACTERS,
  MAX_LOG_ENTRY_LINES,
  MAX_LOG_LINE_CHARACTERS
} from '@renderer/utils/logText'

const reducer = comfyProcessSlice.reducer

describe('comfyProcessSlice output retention', () => {
  it('caps retained Comfy output when appending individual lines', () => {
    const state = reducer(
      {
        pid: 0,
        isRunning: false,
        isManaged: false,
        output: Array.from({ length: MAX_COMFY_OUTPUT_LINES }, (_, index) => `line-${index}`)
      },
      addOutput(`line-${MAX_COMFY_OUTPUT_LINES}`)
    )
    expect(state.output).toHaveLength(MAX_COMFY_OUTPUT_LINES)
    expect(state.output[0]).toBe('line-1')
    expect(state.output.at(-1)).toBe(`line-${MAX_COMFY_OUTPUT_LINES}`)
    expect(state.outputStart).toBe(1)
  })

  it('caps retained Comfy output when appending 20,000 log lines in a batch', () => {
    const state = reducer(
      undefined,
      addOutputBatch(Array.from({ length: 20_000 }, (_, index) => `line-${index}`))
    )
    expect(state.output).toHaveLength(MAX_COMFY_OUTPUT_LINES)
    expect(state.output[0]).toBe(`line-${20_000 - MAX_COMFY_OUTPUT_LINES}`)
    expect(state.output.at(-1)).toBe('line-19999')
  })

  it('does not allow direct single or batch actions to bypass normalization', () => {
    for (const action of [
      addOutput(`before data:image/png;base64,${'A'.repeat(1_000_000)}; ERROR after`),
      addOutputBatch([`before ${'Ab+/'.repeat(100_000)}; ERROR after`])
    ]) {
      const state = reducer(undefined, action)
      expect(state.output.join('\n')).toContain('before')
      expect(state.output.join('\n')).toContain('ERROR after')
      expect(state.output.join('\n')).not.toContain('A'.repeat(256))
      expect(state.output.join('\n')).not.toContain('Ab+/'.repeat(64))
      expect(state.output.every((line) => line.length <= MAX_LOG_LINE_CHARACTERS)).toBe(true)
    }
  })

  it('enforces total characters for repeated appends and batches, with stable eviction offsets', () => {
    let state = reducer(undefined, addOutputBatch(Array(1000).fill('field: '.repeat(300))))
    for (let index = 0; index < 20; index += 1)
      state = reducer(state, addOutput('field: '.repeat(300)))
    expect(state.output.reduce((sum, line) => sum + line.length + 1, 0)).toBeLessThanOrEqual(
      MAX_LOG_CHARACTERS
    )
    expect(state.output.length).toBeLessThan(MAX_COMFY_OUTPUT_LINES)
    expect(state.outputStart).toBeGreaterThan(0)
    state = reducer(state, clearOutput())
    expect(state.output).toEqual([])
    expect(state.outputStart).toBe(0)
    expect(state.outputGeneration).toBe(1)
    state = reducer(state, addOutput('new\nentry'))
    expect(state.output).toEqual(['new', 'entry'])
  })

  it('bounds multiline entries and repairs pre-fix HMR state', () => {
    const state = reducer(
      { pid: 0, isManaged: false, isRunning: false, output: ['A'.repeat(1_000_000)] },
      addOutput('line\n'.repeat(100_000))
    )
    expect(state.output.length).toBeLessThanOrEqual(MAX_LOG_ENTRY_LINES + 4)
    expect(state.output.join('\n')).toContain('truncated')
    expect(state.output.join('\n')).not.toContain('A'.repeat(256))
    expect(reducer(state, addOutputBatch([]))).toBe(state)
  })
})
