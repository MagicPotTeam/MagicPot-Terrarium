import { DialogSvc } from '@shared/api/svcDialog'
import {
  BrowserWindow,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  dialog
} from 'electron'

export class DialogSvcImpl implements DialogSvc {
  private getDialogParentWindow(): BrowserWindow | null {
    return BrowserWindow.getFocusedWindow()
  }

  showOpenDialog = async (options: OpenDialogOptions): Promise<OpenDialogReturnValue> => {
    return dialog.showOpenDialog(options)
  }
  showSaveDialog = async (options: SaveDialogOptions): Promise<SaveDialogReturnValue> => {
    return dialog.showSaveDialog(options)
  }
  showMessageBox = async (options: MessageBoxOptions): Promise<MessageBoxReturnValue> => {
    const parentWindow = this.getDialogParentWindow()
    if (parentWindow) {
      return dialog.showMessageBox(parentWindow, options)
    }
    return dialog.showMessageBox(options)
  }
}
