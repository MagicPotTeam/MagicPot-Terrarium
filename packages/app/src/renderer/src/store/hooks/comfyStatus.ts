import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  appendResults,
  setIsConnected,
  setObjectInfos,
  setIsRunning,
  setErrorPromptStatus,
  deleteResult,
  clearResults
} from '../slices/comfyStatus'
import { useCallback } from 'react'
import { ComfyHistory, ObjectInfoMap } from '@shared/comfy/types'
import { ResultItem } from '@shared/qApp/resultTypes'

export const useComfyStatus = () => {
  const state = useAppSelector((state) => state.comfyStatus)
  const dispatch = useAppDispatch()

  return {
    state,
    setIsConnected: useCallback(
      (isConnected: boolean) => dispatch(setIsConnected(isConnected)),
      [dispatch]
    ),
    setObjectInfos: useCallback(
      (objectInfos: ObjectInfoMap) => dispatch(setObjectInfos(objectInfos)),
      [dispatch]
    ),
    setIsRunning: useCallback(
      (isRunning: boolean) => dispatch(setIsRunning(isRunning)),
      [dispatch]
    ),
    appendResults: useCallback(
      (results: ResultItem[]) => dispatch(appendResults(results)),
      [dispatch]
    ),
    deleteResult: useCallback((id: string) => dispatch(deleteResult(id)), [dispatch]),
    clearResults: useCallback(() => dispatch(clearResults()), [dispatch]),
    setErrorPromptStatus: useCallback(
      (promptId: string, status: ComfyHistory['status']) =>
        dispatch(setErrorPromptStatus([promptId, status])),
      [dispatch]
    )
  }
}
