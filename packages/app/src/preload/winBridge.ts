// packages/app/src/preload/winBridge.ts
import { ipcRenderer } from 'electron'
import type { WinBridge } from '@shared/utils/utilWindow'

export const winBridge: WinBridge = {
  minimize: () => ipcRenderer.invoke('win:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  close: () => ipcRenderer.invoke('win:close'),
  setUnsavedDocumentState: (state) => ipcRenderer.invoke('win:set-unsaved-document-state', state),
  reportUnsavedSaveResult: (result) => ipcRenderer.invoke('win:unsaved-save-result', result),
  onRequestUnsavedSave: (cb) => {
    const listener = (_e: unknown, requestId: string) => cb(requestId)
    ipcRenderer.on('win:request-unsaved-save', listener)
    return () => ipcRenderer.removeListener('win:request-unsaved-save', listener)
  },
  onMaximizeChanged: (cb) => {
    const listener = (_e: unknown, isMax: boolean) => cb(isMax)
    ipcRenderer.on('win:maximize-changed', listener)
    return () => ipcRenderer.removeListener('win:maximize-changed', listener)
  }
}
