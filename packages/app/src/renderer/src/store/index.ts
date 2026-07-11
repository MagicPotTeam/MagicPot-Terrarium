import { configureStore } from '@reduxjs/toolkit'
import comfyProcessSlice from './slices/comfyProcess'
import { useDispatch, useSelector, TypedUseSelectorHook } from 'react-redux'
import comfyStatusSlice from './slices/comfyStatus'
import layoutSlice, { saveState } from './slices/layoutSlice'
import projectConfigSlice, { saveProjectConfigState } from './slices/projectConfigSlice'

const store = configureStore({
  reducer: {
    [comfyProcessSlice.name]: comfyProcessSlice.reducer,
    [comfyStatusSlice.name]: comfyStatusSlice.reducer,
    [layoutSlice.name]: layoutSlice.reducer,
    [projectConfigSlice.name]: projectConfigSlice.reducer
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false,
      immutableCheck: false
    })
})

// 仅在对应 slice 引用变化时写入 localStorage，避免 Comfy 队列和结果流更新触发无关序列化。
let previousLayoutState = store.getState().layout
let previousProjectConfigState = store.getState().projectConfig
store.subscribe(() => {
  const state = store.getState()
  if (state.layout !== previousLayoutState) {
    previousLayoutState = state.layout
    saveState(state.layout)
  }
  if (state.projectConfig !== previousProjectConfigState) {
    previousProjectConfigState = state.projectConfig
    saveProjectConfigState(state.projectConfig)
  }
})

export default store

export type AppStore = typeof store
export type AppDispatch = AppStore['dispatch']
export type RootState = ReturnType<AppStore['getState']>

export const useAppDispatch: () => AppDispatch = useDispatch
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
