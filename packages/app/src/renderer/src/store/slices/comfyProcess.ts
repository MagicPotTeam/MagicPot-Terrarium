import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { MAX_LOG_LINES, normalizeLogBatch, retainLogLines } from '@renderer/utils/logText'

export const MAX_COMFY_OUTPUT_LINES = MAX_LOG_LINES

export interface ComfyProcessState {
  pid: number
  isRunning: boolean
  isManaged: boolean
  output: string[]
  // Optional for existing persisted/HMR state. Absolute row offsets keep repeated
  // log messages anchored correctly when retention evicts rows from the front.
  outputStart?: number
  outputGeneration?: number
}

const initialState: ComfyProcessState = {
  pid: 0,
  isRunning: false,
  isManaged: false,
  output: [],
  outputStart: 0,
  outputGeneration: 0
}

function appendOutput(state: ComfyProcessState, messages: string[]): void {
  if (messages.length === 0) return
  const incoming = normalizeLogBatch(messages)
  const previous = state.outputStart === undefined ? normalizeLogBatch(state.output) : state.output
  const { lines, removed } = retainLogLines(previous, incoming)
  state.output = lines
  state.outputStart = (state.outputStart ?? 0) + removed
}

const comfyProcessSlice = createSlice({
  name: 'comfyProcess',
  initialState,
  reducers: {
    setPid: (state, action: PayloadAction<number>) => {
      state.pid = action.payload
    },
    setIsRunning: (state, action: PayloadAction<boolean>) => {
      state.isRunning = action.payload
    },
    setIsManaged: (state, action: PayloadAction<boolean>) => {
      state.isManaged = action.payload
    },
    addOutput: (state, action: PayloadAction<string>) => {
      appendOutput(state, [action.payload])
    },
    addOutputBatch: (state, action: PayloadAction<string[]>) => {
      appendOutput(state, action.payload)
    },
    clearOutput: (state) => {
      state.output = []
      state.outputStart = 0
      state.outputGeneration = (state.outputGeneration ?? 0) + 1
    }
  }
})

export const { setPid, setIsRunning, setIsManaged, addOutput, addOutputBatch, clearOutput } =
  comfyProcessSlice.actions
export default comfyProcessSlice
