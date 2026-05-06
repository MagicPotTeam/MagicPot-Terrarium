// packages/app/src/main/winControls.ts
import { BrowserWindow, ipcMain } from 'electron'

class WinController {
  private mainWindow: BrowserWindow | null = null

  registerWindow(mainWindow: BrowserWindow) {
    // 广播最大化状态变化（给渲染层同步按钮 UI）
    const sendMaxState = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('win:maximize-changed', mainWindow.isMaximized())
    }
    mainWindow.on('maximize', sendMaxState)
    mainWindow.on('unmaximize', sendMaxState)

    this.mainWindow = mainWindow
  }

  initIpc() {
    // 窗口控制 IPC
    ipcMain.handle('win:minimize', () => {
      if (!this.mainWindow?.isDestroyed()) this.mainWindow?.minimize()
    })
    ipcMain.handle('win:toggleMaximize', () => {
      if (this.mainWindow?.isDestroyed()) return
      if (this.mainWindow?.isMaximized()) this.mainWindow?.unmaximize()
      else this.mainWindow?.maximize()
    })
    ipcMain.handle('win:isMaximized', () => {
      return !this.mainWindow?.isDestroyed() && this.mainWindow?.isMaximized()
    })
    ipcMain.handle('win:close', () => {
      if (!this.mainWindow?.isDestroyed()) this.mainWindow?.close()
    })
  }
}

export const winController = new WinController()
