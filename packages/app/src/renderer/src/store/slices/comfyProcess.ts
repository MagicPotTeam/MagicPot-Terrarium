import { createSlice, PayloadAction } from '@reduxjs/toolkit'

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
    },
    clearOutput: (state) => {
      state.output = []
    }
  }
})

export const { setPid, setIsRunning, addOutput, clearOutput } = comfyProcessSlice.actions
export default comfyProcessSlice
