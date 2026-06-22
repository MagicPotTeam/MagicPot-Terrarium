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
import { rememberTrustedLocalFileSelections } from './trustedFileSelection'

export class DialogSvcImpl implements DialogSvc {
  private getDialogParentWindow(): BrowserWindow | null {
    return BrowserWindow.getFocusedWindow()
  }

  showOpenDialog = async (options: OpenDialogOptions): Promise<OpenDialogReturnValue> => {
    const result = await dialog.showOpenDialog(options)
    const properties = options.properties || []
    const selectedFiles = properties.includes('openFile') && !properties.includes('openDirectory')
    if (selectedFiles && !result.canceled && result.filePaths?.length) {
      rememberTrustedLocalFileSelections(result.filePaths)
    }
    return result
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
