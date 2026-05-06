// packages/app/src/main/screenshot/screenshotManager.ts
// ─── 截图管理器：全局快捷键 + desktopCapturer + 区域选择 + 浮窗 ───
import {
  globalShortcut,
  desktopCapturer,
  screen,
  BrowserWindow,
  ipcMain,
  nativeImage,
  app
} from 'electron'
import { normalizeShortcutForComparison } from '@shared/shortcutConflictUtils'
import { join } from 'path'
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import {
  assessTestWindowPlacement,
  readTestUiEnv,
  resolveTestArtifactPath,
  resolveTestUiPolicy,
  resolveTestWindowPlacement
} from '../testUiPolicy'
type DisplayWorkArea = {
  id: number
  workArea: {
    x: number
    y: number
    width: number
    height: number
  }
}

type AutomationWindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

const testUiPolicy = resolveTestUiPolicy(readTestUiEnv())
const testWindowNoFocus = testUiPolicy.noFocus

function shouldRefocusMainWindow(): boolean {
  return !testUiPolicy.automatedRun && testUiPolicy.showBehavior === 'show'
}
function conflictsWithReservedShortcuts(
  accelerator: string,
  reservedAccelerators: string[] = []
): boolean {
  const normalizedAccelerator = normalizeShortcutForComparison(accelerator)
  if (!normalizedAccelerator) return false

  return reservedAccelerators.some(
    (reservedShortcut) => normalizeShortcutForComparison(reservedShortcut) === normalizedAccelerator
  )
}

export function resolveScreenshotTempDir(params: {
  desktopPath: string
  tempPath: string
  automatedTestRun: boolean
  runId?: string
  artifactRootOverride?: string
}): string {
  return resolveTestArtifactPath({
    desktopPath: params.desktopPath,
    tempPath: params.tempPath,
    policy: {
      automatedRun: params.automatedTestRun,
      runId: params.runId || 'test-run',
      artifactRootOverride: params.artifactRootOverride
    },
    segments: ['screenshot']
  })
}

export function resolveAutomatedGuiWindowBounds(params: {
  width: number
  height: number
  displays: DisplayWorkArea[]
  primaryDisplayId: number
  preferSecondaryDisplay: boolean
  forceOffscreen: boolean
}): AutomationWindowBounds | null {
  const placement = resolveTestWindowPlacement({
    width: params.width,
    height: params.height,
    displays: params.displays,
    primaryDisplayId: params.primaryDisplayId,
    policy: {
      hideWindow: false,
      preferSecondaryDisplay: params.preferSecondaryDisplay,
      forceOffscreen: params.forceOffscreen
    }
  })

  return placement
    ? {
        ...placement,
        width: params.width,
        height: params.height
      }
    : null
}

function resolveCurrentAutomationWindowBounds(
  width: number,
  height: number
): AutomationWindowBounds | null {
  if (!testUiPolicy.preferSecondaryDisplay && !testUiPolicy.forceOffscreen) {
    return null
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const displays = screen.getAllDisplays().map((display) => ({
    id: display.id,
    workArea: display.workArea
  }))

  return resolveAutomatedGuiWindowBounds({
    width,
    height,
    displays,
    primaryDisplayId: primaryDisplay.id,
    preferSecondaryDisplay: testUiPolicy.preferSecondaryDisplay,
    forceOffscreen: testUiPolicy.forceOffscreen
  })
}

function listAutomationDisplays(): DisplayWorkArea[] {
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    workArea: display.workArea
  }))
}

function relocateAutomatedWindow(window: BrowserWindow): void {
  if (!testUiPolicy.automatedRun || window.isDestroyed()) {
    return
  }

  const bounds = window.getBounds()
  const placement = resolveTestWindowPlacement({
    width: bounds.width,
    height: bounds.height,
    displays: listAutomationDisplays(),
    primaryDisplayId: screen.getPrimaryDisplay().id,
    policy: testUiPolicy
  })

  if (!placement || (bounds.x === placement.x && bounds.y === placement.y)) {
    return
  }

  window.setBounds({
    ...bounds,
    x: placement.x,
    y: placement.y
  })
}

export function showWindowNonIntrusively(window: BrowserWindow): void {
  relocateAutomatedWindow(window)

  if (testUiPolicy.showBehavior === 'hidden') {
    window.hide()
    return
  }

  if (shouldHideAutomatedWindow(window)) {
    window.hide()
    return
  }

  if (testUiPolicy.showBehavior === 'show-inactive') {
    try {
      window.showInactive()
      queueAutomatedWindowPolicyEnforcement(window)
      return
    } catch {
      window.hide()
      queueAutomatedWindowPolicyEnforcement(window)
      return
    }
  }

  window.show()
  queueAutomatedWindowPolicyEnforcement(window)
}

function shouldHideAutomatedWindow(window: BrowserWindow): boolean {
  if (!testUiPolicy.automatedRun || window.isDestroyed()) {
    return false
  }

  const assessment = assessTestWindowPlacement({
    bounds: window.getBounds(),
    displays: listAutomationDisplays(),
    primaryDisplayId: screen.getPrimaryDisplay().id,
    policy: testUiPolicy
  })

  return assessment.shouldHideWindow
}

function enforceAutomatedWindowPolicy(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return
  }

  if (testUiPolicy.noFocus) {
    window.setFocusable(false)
  }
  if (testUiPolicy.suppressTaskbar) {
    window.setSkipTaskbar(true)
  }
  relocateAutomatedWindow(window)
  if (window.isFocused()) {
    window.blur()
  }
  if (shouldHideAutomatedWindow(window)) {
    window.hide()
  }
}

function queueAutomatedWindowPolicyEnforcement(window: BrowserWindow): void {
  if (!testUiPolicy.automatedRun) {
    return
  }

  setTimeout(() => {
    enforceAutomatedWindowPolicy(window)
  }, 0)
}

// ─── 临时文件目录 ───
function getTmpDir(): string {
  const dir = resolveScreenshotTempDir({
    desktopPath: app.getPath('desktop'),
    tempPath: app.getPath('temp'),
    automatedTestRun: testUiPolicy.automatedRun,
    runId: testUiPolicy.runId,
    artifactRootOverride: testUiPolicy.artifactRootOverride
  })
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// ─── 浮窗管理 ───
interface FloatingWindow {
  id: string
  win: BrowserWindow
  imageDataUrl: string
  tmpFiles: string[] // 需要清理的临时文件
}

let overlayWindow: BrowserWindow | null = null
let overlayTmpFiles: string[] = []
const floatingWindows = new Map<string, FloatingWindow>()
let mainWindow: BrowserWindow | null = null
let ipcRegistered = false
let shortcutsRegistered = false
// 保存截图的 NativeImage，裁剪时使用
let capturedImage: Electron.NativeImage | null = null
// 当前截图快捷键
let currentShortcut = '`'

// ─── 安全删除临时文件 ───
function cleanupTmpFiles(files: string[]): void {
  for (const f of files) {
    try {
      if (existsSync(f)) unlinkSync(f)
    } catch {
      /* ignore */
    }
  }
}

// ─── Overlay HTML（区域选择界面） ───
// 注意：img src 使用相对路径引用同目录下的 capture.png
function getOverlayHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; cursor: crosshair; user-select: none; background: transparent; }
  #bg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
  #overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.3); }
  #selection {
    position: absolute; border: 2px solid #6366f1;
    background: transparent; display: none;
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.35);
  }
  #sizeLabel {
    position: absolute; background: #6366f1; color: #fff;
    font-size: 11px; padding: 2px 8px; border-radius: 3px;
    font-family: system-ui; pointer-events: none; display: none;
    white-space: nowrap;
  }
  #hint {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.7); color: #fff; font-size: 13px;
    padding: 8px 20px; border-radius: 8px; font-family: system-ui;
    backdrop-filter: blur(8px); pointer-events: none;
  }
</style>
</head>
<body>
<img id="bg" src="./capture.png" />
<div id="overlay"></div>
<div id="selection"></div>
<div id="sizeLabel"></div>
<div id="hint">拖拽选择截图区域 · ESC 取消</div>
<script>
  const sel = document.getElementById('selection');
  const label = document.getElementById('sizeLabel');
  const hint = document.getElementById('hint');
  let startX = 0, startY = 0, isDrawing = false;

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    startX = e.clientX; startY = e.clientY;
    isDrawing = true;
    sel.style.display = 'block';
    hint.style.display = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    sel.style.left = x + 'px';
    sel.style.top = y + 'px';
    sel.style.width = w + 'px';
    sel.style.height = h + 'px';
    label.style.display = 'block';
    label.style.left = (x + w + 6) + 'px';
    label.style.top = (y + h + 6) + 'px';
    label.textContent = w + ' × ' + h;
  });

  document.addEventListener('mouseup', (e) => {
    if (!isDrawing) return;
    isDrawing = false;
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    if (w < 10 || h < 10) {
      sel.style.display = 'none';
      label.style.display = 'none';
      hint.style.display = 'block';
      return;
    }
    window.electron.ipcRenderer.send('screenshot:region', { x, y, w, h });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.electron.ipcRenderer.send('screenshot:cancel');
    }
  });
</script>
</body>
</html>`
}

// ─── Floating Window HTML ───
function getFloatingHTML(windowId: string, imageFileName: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
  img {
    width: 100%; height: 100%; object-fit: contain; display: block;
    -webkit-app-region: drag;
  }
  .controls {
    position: absolute; top: 4px; right: 4px;
    display: flex; gap: 3px; opacity: 0;
    transition: opacity 0.15s;
    -webkit-app-region: no-drag;
  }
  body:hover .controls { opacity: 1; }
  .btn {
    width: 24px; height: 24px; border: none; border-radius: 4px;
    background: rgba(0,0,0,0.65); color: #fff; font-size: 13px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(4px); transition: background 0.12s;
  }
  .btn:hover { background: rgba(99,102,241,0.85); }
  .btn-close:hover { background: rgba(239,68,68,0.85); }
  .opacity-slider {
    position: absolute; bottom: 4px; left: 4px; right: 4px;
    opacity: 0; transition: opacity 0.15s;
    -webkit-app-region: no-drag;
  }
  body:hover .opacity-slider { opacity: 1; }
  input[type="range"] {
    width: 100%; height: 4px; -webkit-appearance: none;
    background: rgba(255,255,255,0.2); border-radius: 2px; outline: none;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 12px; height: 12px;
    border-radius: 50%; background: #6366f1; cursor: pointer;
  }
</style>
</head>
<body>
<img id="img" src="./${imageFileName}" />
<div class="controls">
  <button class="btn" title="发送到画布" onclick="sendToCanvas()">📌</button>
  <button class="btn btn-close" title="关闭" onclick="closeThis()">✕</button>
</div>
<div class="opacity-slider">
  <input type="range" min="20" max="100" value="100"
    oninput="window.electron.ipcRenderer.send('floating:opacity', '${windowId}', this.value / 100)" />
</div>
<script>
  function closeThis() {
    window.electron.ipcRenderer.send('floating:close', '${windowId}');
  }
  function sendToCanvas() {
    window.electron.ipcRenderer.send('floating:to-canvas', '${windowId}');
  }
</script>
</body>
</html>`
}

// ─── 截图核心流程 ───
async function captureScreen(): Promise<Electron.NativeImage> {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.size
  const scaleFactor = primaryDisplay.scaleFactor

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * scaleFactor),
      height: Math.round(height * scaleFactor)
    }
  })
  if (sources.length === 0) {
    throw new Error('无法获取屏幕截图')
  }

  return sources[0].thumbnail
}

async function startScreenshotFlow(): Promise<void> {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close()
    overlayWindow = null
  }
  cleanupTmpFiles(overlayTmpFiles)
  overlayTmpFiles = []

  console.log('[Screenshot] 开始截图流程...')

  try {
    const img = await captureScreen()
    capturedImage = img

    // 保存截图到临时文件
    const tmpDir = getTmpDir()
    const capturePng = join(tmpDir, `capture.png`)
    const overlayHtml = join(tmpDir, `overlay.html`)

    writeFileSync(capturePng, img.toPNG())
    writeFileSync(overlayHtml, getOverlayHTML())
    overlayTmpFiles = [capturePng, overlayHtml]

    const primaryDisplay = screen.getPrimaryDisplay()
    const { width, height } = primaryDisplay.size
    const preloadPath = join(__dirname, '../preload/index.js')
    const automatedBounds = resolveCurrentAutomationWindowBounds(width, height)

    overlayWindow = new BrowserWindow({
      x: automatedBounds?.x ?? primaryDisplay.bounds.x,
      y: automatedBounds?.y ?? primaryDisplay.bounds.y,
      width: automatedBounds?.width ?? width,
      height: automatedBounds?.height ?? height,
      fullscreen: automatedBounds ? false : true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      focusable: !testWindowNoFocus,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      show: false, // 先隐藏，等内容加载完再显示，避免黑屏闪烁
      webPreferences: {
        preload: preloadPath,
        sandbox: false,
        contextIsolation: true
      }
    })

    overlayWindow.setAlwaysOnTop(true, 'screen-saver')

    // 内容加载完成后再显示窗口，避免黑屏闪烁
    overlayWindow.once('ready-to-show', () => {
      if (!overlayWindow) return
      showWindowNonIntrusively(overlayWindow)
      if (testUiPolicy.showBehavior === 'show') {
        overlayWindow.focus()
      }
    })

    // 通过 loadFile 加载本地 HTML 文件
    await overlayWindow.loadFile(overlayHtml)

    overlayWindow.on('closed', () => {
      overlayWindow = null
      cleanupTmpFiles(overlayTmpFiles)
      overlayTmpFiles = []
    })

    console.log('[Screenshot] Overlay 窗口已创建')
  } catch (error) {
    console.error('[Screenshot] 截图流程失败:', error)
    cleanupTmpFiles(overlayTmpFiles)
    overlayTmpFiles = []
  }
}

// ─── 创建浮动窗口 ───
function createFloatingWindow(
  croppedImage: Electron.NativeImage,
  width: number,
  height: number
): void {
  const id = `floating-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const preloadPath = join(__dirname, '../preload/index.js')

  // 保存裁剪后的图片到临时文件
  const tmpDir = getTmpDir()
  const imgFileName = `${id}.png`
  const imgPath = join(tmpDir, imgFileName)
  const htmlPath = join(tmpDir, `${id}.html`)

  writeFileSync(imgPath, croppedImage.toPNG())
  writeFileSync(htmlPath, getFloatingHTML(id, imgFileName))

  // 限制浮窗初始大小
  const maxDim = 500
  let w = width
  let h = height
  if (w > maxDim || h > maxDim) {
    const ratio = maxDim / Math.max(w, h)
    w = Math.round(w * ratio)
    h = Math.round(h * ratio)
  }
  w = Math.max(w, 100)
  h = Math.max(h, 80)

  const mousePos = screen.getCursorScreenPoint()
  const automatedBounds = resolveCurrentAutomationWindowBounds(w, h)

  const win = new BrowserWindow({
    x: automatedBounds?.x ?? mousePos.x - Math.round(w / 2),
    y: automatedBounds?.y ?? mousePos.y - Math.round(h / 2),
    width: automatedBounds?.width ?? w,
    height: automatedBounds?.height ?? h,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: !testWindowNoFocus,
    skipTaskbar: testUiPolicy.suppressTaskbar,
    resizable: true,
    minimizable: false,
    maximizable: false,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true
    }
  })

  win.setAlwaysOnTop(true, 'floating')

  // 通过 loadFile 加载（不再使用 data URL）
  win.loadFile(htmlPath)
  win.once('ready-to-show', () => {
    showWindowNonIntrusively(win)
  })

  const tmpFiles = [imgPath, htmlPath]

  win.on('closed', () => {
    floatingWindows.delete(id)
    cleanupTmpFiles(tmpFiles)
  })

  const imageDataUrl = croppedImage.toDataURL()
  floatingWindows.set(id, { id, win, imageDataUrl, tmpFiles })
  console.log(`[Screenshot] 浮窗已创建: ${id} (${w}×${h})`)
}

// ─── IPC 处理 ───
function setupIPC(): void {
  if (ipcRegistered) {
    return
  }

  // 截图区域选择完成
  ipcMain.on(
    'screenshot:region',
    async (_event, region: { x: number; y: number; w: number; h: number }) => {
      console.log(`[Screenshot] 区域选择: ${region.x},${region.y} ${region.w}×${region.h}`)

      if (!overlayWindow || overlayWindow.isDestroyed()) return
      if (!capturedImage) return

      try {
        overlayWindow.close()
        overlayWindow = null

        const scaleFactor = screen.getPrimaryDisplay().scaleFactor

        const cropped = capturedImage.crop({
          x: Math.round(region.x * scaleFactor),
          y: Math.round(region.y * scaleFactor),
          width: Math.round(region.w * scaleFactor),
          height: Math.round(region.h * scaleFactor)
        })

        // NOTE: Changed to send directly to canvas instead of floating window
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('canvas:add-image', cropped.toDataURL())
          if (shouldRefocusMainWindow()) {
            mainWindow.focus()
          }
          console.log(`[Screenshot] 截图已被直接发送至画布`)
        } else {
          // Fallback if main window is not available somehow
          createFloatingWindow(cropped, region.w, region.h)
        }

        capturedImage = null
      } catch (error) {
        console.error('[Screenshot] 裁剪失败:', error)
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.close()
          overlayWindow = null
        }

        capturedImage = null
      }
    }
  )

  // 取消截图
  ipcMain.on('screenshot:cancel', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close()
      overlayWindow = null
    }

    capturedImage = null
  })

  // 关闭浮窗
  ipcMain.on('floating:close', (_event, id: string) => {
    const fw = floatingWindows.get(id)
    if (fw) {
      fw.win.close()
      floatingWindows.delete(id)
    }
  })

  // 浮窗透明度
  ipcMain.on('floating:opacity', (_event, id: string, opacity: number) => {
    const fw = floatingWindows.get(id)
    if (fw && !fw.win.isDestroyed()) {
      fw.win.setOpacity(opacity)
    }
  })

  // 浮窗 → 画布
  ipcMain.on('floating:to-canvas', (_event, id: string) => {
    const fw = floatingWindows.get(id)
    if (fw && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('canvas:add-image', fw.imageDataUrl)
      fw.win.close()
      floatingWindows.delete(id)
      if (shouldRefocusMainWindow()) {
        mainWindow.focus()
      }
      console.log(`[Screenshot] 浮窗 ${id} 已发送到画布`)
    }
  })

  // 主渲染进程触发截图
  ipcMain.handle('screenshot:capture', async () => {
    await startScreenshotFlow()
    return { success: true }
  })

  // 设置截图快捷键
  ipcMain.handle('screenshot:getShortcut', async () => ({
    success: true,
    shortcut: currentShortcut
  }))

  ipcMain.handle(
    'screenshot:setShortcut',
    async (_event, accelerator: string, reservedAccelerators: string[] = []) => {
      if (conflictsWithReservedShortcuts(accelerator, reservedAccelerators)) {
        return {
          success: false,
          error: 'Shortcut conflicts with reserved canvas shortcuts.'
        }
      }

      try {
        globalShortcut.unregister(currentShortcut)
        const success = globalShortcut.register(accelerator, () => {
          console.log(`[Screenshot] 快捷键 ${accelerator} 被触发`)
          startScreenshotFlow()
        })
        if (success) {
          currentShortcut = accelerator
          shortcutsRegistered = true
          console.log(`[Screenshot] 快捷键已更新为 ${accelerator}`)
          return { success: true }
        } else {
          // 注册失败，恢复旧快捷键
          globalShortcut.register(currentShortcut, () => {
            startScreenshotFlow()
          })
          shortcutsRegistered = true
          console.warn(`[Screenshot] 快捷键 ${accelerator} 注册失败，已恢复原快捷键`)
          return { success: false, error: '快捷键注册失败，可能被其他程序占用' }
        }
      } catch (err) {
        console.error('[Screenshot] 设置快捷键失败:', err)
        return { success: false, error: String(err) }
      }
    }
  )

  ipcRegistered = true
}

// ─── 全局快捷键 ───
function registerGlobalShortcuts(): void {
  if (shortcutsRegistered) {
    globalShortcut.unregister(currentShortcut)
    shortcutsRegistered = false
  }

  const success = globalShortcut.register(currentShortcut, () => {
    console.log(`[Screenshot] 快捷键 ${currentShortcut} 被触发`)
    startScreenshotFlow()
  })

  if (success) {
    shortcutsRegistered = true
    console.log(`[Screenshot] 全局快捷键 ${currentShortcut} 已注册`)
  } else {
    console.warn(`[Screenshot] 全局快捷键 ${currentShortcut} 注册失败`)
  }
}

// ─── 公共 API ───
export function initScreenshotManager(mainWin: BrowserWindow): void {
  if (mainWindow && mainWindow !== mainWin) {
    cleanupScreenshotManager()
  }

  mainWindow = mainWin
  setupIPC()
  registerGlobalShortcuts()
  console.log('[Screenshot] 截图管理器已初始化')
}

export function cleanupScreenshotManager(): void {
  globalShortcut.unregisterAll()
  shortcutsRegistered = false
  mainWindow = null

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close()
  }
  overlayWindow = null
  cleanupTmpFiles(overlayTmpFiles)
  overlayTmpFiles = []
  capturedImage = null

  for (const fw of floatingWindows.values()) {
    if (!fw.win.isDestroyed()) {
      fw.win.close()
    }
  }
  floatingWindows.clear()

  console.log('[Screenshot] 截图管理器已清理')
}
