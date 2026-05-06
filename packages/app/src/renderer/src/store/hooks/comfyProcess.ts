import { useAppDispatch, useAppSelector } from '@renderer/store'
import { useCallback } from 'react'
import { setPid, setIsRunning, addOutput, clearOutput } from '../slices/comfyProcess'

export const useComfyProcess = () => {
  const state = useAppSelector((state) => state.comfyProcess)
  const dispatch = useAppDispatch()

  return {
    state,
    setPid: useCallback((pid: number) => dispatch(setPid(pid)), [dispatch]),
    setIsRunning: useCallback(
      (isRunning: boolean) => dispatch(setIsRunning(isRunning)),
      [dispatch]
    ),
    addOutput: useCallback((output: string) => dispatch(addOutput(output)), [dispatch]),
    clearOutput: useCallback(() => dispatch(clearOutput()), [dispatch])
  }
}
