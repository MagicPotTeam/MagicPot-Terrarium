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

// 自动保存 layout 状态到 localStorage
store.subscribe(() => {
  saveState(store.getState().layout)
  saveProjectConfigState(store.getState().projectConfig)
})

export default store

export type AppStore = typeof store
export type AppDispatch = AppStore['dispatch']
export type RootState = ReturnType<AppStore['getState']>

export const useAppDispatch: () => AppDispatch = useDispatch
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
