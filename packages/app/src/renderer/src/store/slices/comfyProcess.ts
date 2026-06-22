import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export const MAX_COMFY_OUTPUT_LINES = 1000

export interface ComfyProcessState {
  pid: number
  isRunning: boolean
  output: string[]
}

const initialState: ComfyProcessState = {
  pid: 0,
  isRunning: false,
  output: []
}

function capOutput(output: string[]): void {
  const overflow = output.length - MAX_COMFY_OUTPUT_LINES
  if (overflow > 0) {
    output.splice(0, overflow)
  }
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
    addOutput: (state, action: PayloadAction<string>) => {
      state.output.push(action.payload)
      capOutput(state.output)
    },
    addOutputBatch: (state, action: PayloadAction<string[]>) => {
      if (action.payload.length === 0) {
        return
      }
      if (action.payload.length >= MAX_COMFY_OUTPUT_LINES) {
        state.output = action.payload.slice(-MAX_COMFY_OUTPUT_LINES)
        return
      }
      state.output.push(...action.payload)
      capOutput(state.output)
    },
    clearOutput: (state) => {
      state.output = []
    }
  }
})

export const { setPid, setIsRunning, addOutput, addOutputBatch, clearOutput } =
  comfyProcessSlice.actions
export default comfyProcessSlice
