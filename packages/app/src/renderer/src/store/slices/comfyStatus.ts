import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { ComfyHistory, ObjectInfoMap } from '@shared/comfy/types'
import { ResultItem } from '@shared/qApp/resultTypes'
export interface ComfyStatusState {
  isConnected: boolean // 是否连接到 ComfyUI 服务器
  objectInfos: ObjectInfoMap
  isRunning: boolean // 有正在运行的任务
  results: ResultItem[]
  errorPromptStatus: Record<string, ComfyHistory['status']> // map<prompt_id, status>
}

const initialState: ComfyStatusState = {
  isConnected: false,
  objectInfos: {},
  isRunning: false,
  results: [],
  errorPromptStatus: {}
}

const MAX_RESULTS = 20

const comfyStatusSlice = createSlice({
  name: 'comfyStatus',
  initialState,
  reducers: {
    setIsConnected: (state, action: PayloadAction<boolean>) => {
      state.isConnected = action.payload
    },
    setObjectInfos: (state, action: PayloadAction<ObjectInfoMap>) => {
      state.objectInfos = action.payload
    },
    setIsRunning: (state, action: PayloadAction<boolean>) => {
      state.isRunning = action.payload
    },
    appendResults: (state, action: PayloadAction<ResultItem[]>) => {
      // 从前面 append
      state.results.unshift(...action.payload)
      if (state.results.length > MAX_RESULTS) {
        state.results.splice(MAX_RESULTS, state.results.length - MAX_RESULTS)
      }
    },
    deleteResult: (state, action: PayloadAction<string>) => {
      state.results = state.results.filter((result) => result.id !== action.payload)
    },
    clearResults: (state) => {
      state.results = []
    },
    setErrorPromptStatus: (state, action: PayloadAction<[string, ComfyHistory['status']]>) => {
      state.errorPromptStatus[action.payload[0]] = action.payload[1]
    }
  }
})

export const {
  setIsConnected,
  setObjectInfos,
  setIsRunning,
  appendResults,
  deleteResult,
  clearResults,
  setErrorPromptStatus
} = comfyStatusSlice.actions
export default comfyStatusSlice
