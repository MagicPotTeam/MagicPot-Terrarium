import { BrowserWindow, screen } from 'electron'
import {
  assessTestWindowPlacement,
  readTestUiEnv,
  resolveTestUiPolicy,
  resolveTestWindowOverride,
  resolveTestWindowPlacement,
  type TestUiDisplayLike,
  type TestUiPolicy
} from './testUiPolicy'

const testUiPolicy = resolveTestUiPolicy(readTestUiEnv())
const testWindowX = Number.parseInt(process.env['MAGICPOT_TEST_WINDOW_X'] ?? '', 10)
const testWindowY = Number.parseInt(process.env['MAGICPOT_TEST_WINDOW_Y'] ?? '', 10)
export const TEST_WINDOW_RUNTIME_SKIP_TASKBAR_STATE_KEY = 'magicpot.testWindowRuntime.skipTaskbar'

const TEST_WINDOW_RUNTIME_SKIP_TASKBAR_STATE = Symbol.for(
  TEST_WINDOW_RUNTIME_SKIP_TASKBAR_STATE_KEY
)

type TestWindowRuntimePolicyState = BrowserWindow & {
  [key: symbol]: boolean | undefined
}

const listDisplays = (): TestUiDisplayLike[] =>
  screen.getAllDisplays().map((display) => ({
    id: display.id,
    workArea: display.workArea
  }))

function relocateAutomatedWindow(window: BrowserWindow): void {
  if (!testUiPolicy.automatedRun || window.isDestroyed()) {
    return
  }

  const bounds = window.getBounds()
  const placement = resolveTestWindowPlacement({
    width: bounds.width,
    height: bounds.height,
    displays: listDisplays(),
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

export function getTestWindowPolicy(): TestUiPolicy {
  return testUiPolicy
}

export function resolveConfiguredTestWindowPlacement(
  windowWidth: number,
  windowHeight: number
): { x: number; y: number } | null {
  const manualOverride = resolveTestWindowOverride({
    x: testWindowX,
    y: testWindowY,
    policy: testUiPolicy
  })
  if (manualOverride) {
    return manualOverride
  }

  return resolveTestWindowPlacement({
    width: windowWidth,
    height: windowHeight,
    displays: listDisplays(),
    primaryDisplayId: screen.getPrimaryDisplay().id,
    policy: testUiPolicy
  })
}

export function shouldHideCurrentTestWindow(window: BrowserWindow): boolean {
  if (!testUiPolicy.automatedRun || window.isDestroyed()) {
    return false
  }

  return assessTestWindowPlacement({
    bounds: window.getBounds(),
    displays: listDisplays(),
    primaryDisplayId: screen.getPrimaryDisplay().id,
    policy: testUiPolicy
  }).shouldHideWindow
}

export function readAppliedTestWindowSkipTaskbarState(window: BrowserWindow): boolean | null {
  const value = (window as TestWindowRuntimePolicyState)[TEST_WINDOW_RUNTIME_SKIP_TASKBAR_STATE]
  return typeof value === 'boolean' ? value : null
}

export function showWindowForTestPolicy(window: BrowserWindow): void {
  applyPreShowAutomatedWindowPolicy(window)

  if (testUiPolicy.showBehavior === 'hidden' || shouldHideCurrentTestWindow(window)) {
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

function recordAppliedTestWindowSkipTaskbarState(window: BrowserWindow, value: boolean): void {
  ;(window as TestWindowRuntimePolicyState)[TEST_WINDOW_RUNTIME_SKIP_TASKBAR_STATE] = value
}

function applyPreShowAutomatedWindowPolicy(window: BrowserWindow): void {
  if (!testUiPolicy.automatedRun || window.isDestroyed()) {
    return
  }

  relocateAutomatedWindow(window)

  if (testUiPolicy.noFocus) {
    window.setFocusable(false)
  }
  if (testUiPolicy.suppressTaskbar) {
    window.setSkipTaskbar(true)
    recordAppliedTestWindowSkipTaskbarState(window, true)
  }
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
    recordAppliedTestWindowSkipTaskbarState(window, true)
  }
  relocateAutomatedWindow(window)
  if (window.isFocused()) {
    window.blur()
  }
  if (shouldHideCurrentTestWindow(window)) {
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
