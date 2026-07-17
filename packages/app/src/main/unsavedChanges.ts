import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { UnsavedDocumentState, UnsavedSaveResult } from '@shared/utils/utilWindow'

const DEFAULT_DOCUMENT_TITLE = '未命名画布'
const SAVE_TIMEOUT_MS = 120_000

type PendingSave = {
  resolve: (result: UnsavedSaveResult) => void
  timer: NodeJS.Timeout
}

export class UnsavedChangesController {
  private readonly states = new Map<number, UnsavedDocumentState>()
  private readonly pendingSaves = new Map<string, PendingSave>()
  private requestSequence = 0
  private promptInFlight: Promise<boolean> | null = null

  registerIpc(): void {
    ipcMain.handle('win:set-unsaved-document-state', (event, state: UnsavedDocumentState) => {
      this.states.set(event.sender.id, {
        dirty: Boolean(state?.dirty),
        title: this.normalizeTitle(state?.title)
      })
    })
    ipcMain.handle('win:unsaved-save-result', (_event, result: UnsavedSaveResult) => {
      const pending = this.pendingSaves.get(result.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pendingSaves.delete(result.requestId)
      pending.resolve(result)
    })
  }

  attach(window: BrowserWindow): void {
    window.webContents.on('destroyed', () => {
      this.states.delete(window.webContents.id)
    })
    window.webContents.on('will-prevent-unload', (event) => {
      void this.confirm(window).then((shouldLeave) => {
        if (!shouldLeave || window.isDestroyed()) return
        this.states.set(window.webContents.id, { dirty: false, title: DEFAULT_DOCUMENT_TITLE })
        window.webContents.reload()
      })
      event.preventDefault()
    })
  }

  async confirm(window: BrowserWindow): Promise<boolean> {
    if (window.isDestroyed() || !this.states.get(window.webContents.id)?.dirty) return true
    if (this.promptInFlight) return this.promptInFlight

    this.promptInFlight = this.showPrompt(window).finally(() => {
      this.promptInFlight = null
    })
    return this.promptInFlight
  }

  private async showPrompt(window: BrowserWindow): Promise<boolean> {
    const state = this.states.get(window.webContents.id)
    if (!state?.dirty) return true

    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      message: `要在退出之前存储对「${this.normalizeTitle(state.title)}」的更改吗？`,
      buttons: ['是(Y)', '否(N)', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })

    if (response === 1) return true
    if (response !== 0) return false

    const result = await this.requestSave(window)
    if (result.success) {
      this.states.set(window.webContents.id, { ...state, dirty: false })
      return true
    }

    await dialog.showMessageBox(window, {
      type: 'error',
      message: '无法存储画布更改。',
      detail: result.error || '请重试，窗口将保持打开。',
      buttons: ['确定']
    })
    return false
  }

  private requestSave(window: BrowserWindow): Promise<UnsavedSaveResult> {
    const requestId = `save-before-close-${Date.now()}-${++this.requestSequence}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSaves.delete(requestId)
        resolve({ requestId, success: false, error: '等待保存响应超时。' })
      }, SAVE_TIMEOUT_MS)
      this.pendingSaves.set(requestId, { resolve, timer })
      window.webContents.send('win:request-unsaved-save', requestId)
    })
  }

  private normalizeTitle(title: string | undefined): string {
    return `${title || ''}`.trim() || DEFAULT_DOCUMENT_TITLE
  }
}

export const unsavedChangesController = new UnsavedChangesController()
