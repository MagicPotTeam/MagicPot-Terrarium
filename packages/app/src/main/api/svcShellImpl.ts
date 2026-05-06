import { ShellSvc } from '@shared/api/svcShell'
import { shell } from 'electron'
import fs from 'fs'
import os from 'os'

function isLocallyAvailable(filePath: string): boolean {
  try {
    fs.statSync(filePath)
    return true
  } catch {
    return false
  }
}

export class ShellSvcImpl implements ShellSvc {
  openPath = async (path: string): Promise<string> => {
    return shell.openPath(path)
  }
  showItemInFolder = async (path: string): Promise<void> => {
    return shell.showItemInFolder(path)
  }
  openExternal = async (url: string): Promise<void> => {
    return shell.openExternal(url)
  }
  getHomeDir = async (): Promise<string> => {
    return os.homedir()
  }
  fileExists = async (filePath: string): Promise<boolean> => {
    return isLocallyAvailable(filePath)
  }
  fileExistsBatch = async (paths: string[]): Promise<boolean[]> => {
    return paths.map((p) => isLocallyAvailable(p))
  }
}
