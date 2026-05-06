/**
 * Watch the qApps directory for external file changes (add/delete/rename).
 * When a change is detected, notify the renderer to refresh the quick app list.
 */

import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import path from 'path'
import { getBuildEnv } from '../config/buildEnv'
import { getConfig } from '../config/config'
import { ConfigUtils } from '@shared/config/configUtils'

let watcher: fs.FSWatcher | null = null
let debounceTimer: NodeJS.Timeout | null = null

const DEBOUNCE_MS = 500

export function startQAppWatcher(mainWindow: BrowserWindow): void {
  stopQAppWatcher()

  const config = getConfig()
  const buildEnv = getBuildEnv()
  const configUtils = new ConfigUtils(config, buildEnv, path)
  const qAppDir = configUtils.getQAppDir()

  // Ensure the directory exists before watching
  if (!fs.existsSync(qAppDir)) {
    fs.mkdirSync(qAppDir, { recursive: true })
  }

  try {
    watcher = fs.watch(qAppDir, { recursive: true }, (_eventType, _filename) => {
      // Debounce: multiple events may fire in quick succession
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
      debounceTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[QAppWatcher] 检测到 qApps 目录变更，通知界面刷新')
          mainWindow.webContents.send('qapp:dir-changed')
        }
      }, DEBOUNCE_MS)
    })
    console.log(`[QAppWatcher] 开始监视目录: ${qAppDir}`)
  } catch (err) {
    console.error('[QAppWatcher] 启动目录监视失败:', err)
  }
}

export function stopQAppWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (watcher) {
    watcher.close()
    watcher = null
    console.log('[QAppWatcher] 已停止目录监视')
  }
}
