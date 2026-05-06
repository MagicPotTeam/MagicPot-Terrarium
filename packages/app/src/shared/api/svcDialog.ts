import {
  type SaveDialogOptions,
  type SaveDialogReturnValue,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'
import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

/**
 * Electron 的 Dialog API 只在 Main 进程中可用
 * 无法像 Shell API 一样往 window 上注入
 * 因此需要单独包装
 */

export type DialogSvc = {
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>
}

export const dialogSvcDef: ServiceDefSheet<DialogSvc> = {
  showOpenDialog: {
    type: 'unary'
  },
  showSaveDialog: {
    type: 'unary'
  },
  showMessageBox: {
    type: 'unary'
  }
}
