import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'

const state = vi.hoisted(() => ({
  ready: true,
  root: 'C:/owned-app',
  fork: vi.fn()
}))
vi.mock('electron', () => ({
  app: { isReady: () => state.ready, getAppPath: () => state.root },
  utilityProcess: { fork: state.fork }
}))

import {
  createFigPluginBridgeChildLauncher,
  figPluginBridgeChildEnvironment,
  FIGPLUGIN_BRIDGE_CHILD_ENTRY
} from './bridgeChildLauncher'

const child = () => {
  const postMessage = vi.fn()
  const kill = vi.fn(() => true)
  const once = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'spawn') listener()
  })
  return { postMessage, kill, once, off: vi.fn() }
}

describe('bridge child launcher', () => {
  it('uses only the fixed entry and sanitized utility-process options', () => {
    const processChild = child()
    state.fork.mockReturnValueOnce(processChild)
    const launch = createFigPluginBridgeChildLauncher({
      appRoot: () => state.root,
      isReady: () => true,
      verifyAssets: (root) => path.join(root, FIGPLUGIN_BRIDGE_CHILD_ENTRY)
    })
    const port = launch({ origin: 'http://127.0.0.1:41234', protocol: 1, nonce: 'a'.repeat(32) })
    expect(state.fork).toHaveBeenCalledWith(
      path.join(state.root, FIGPLUGIN_BRIDGE_CHILD_ENTRY),
      [],
      expect.objectContaining({
        env: expect.objectContaining({ LANG: 'C' }),
        execArgv: [],
        stdio: 'ignore',
        allowLoadingUnsignedLibraries: false
      })
    )
    port.send('frame')
    expect(processChild.postMessage).toHaveBeenCalledWith('frame')
    expect(port.kill()).toBeUndefined()
    expect(processChild.kill).toHaveBeenCalledOnce()
  })

  it('fails closed before Electron readiness and strips secret environment values', () => {
    const launch = createFigPluginBridgeChildLauncher({ isReady: () => false })
    expect(() =>
      launch({ origin: 'http://127.0.0.1:41234', protocol: 1, nonce: 'a'.repeat(32) })
    ).toThrow()
    expect(
      figPluginBridgeChildEnvironment({
        LANG: 'injected',
        PATH: 'injected',
        NODE_OPTIONS: '--require evil',
        OPENAI_API_KEY: 'secret',
        SystemRoot: 'C:/Windows'
      })
    ).toEqual({ LANG: 'C', SystemRoot: 'C:/Windows' })
  })

  it('queues frames and retries a pre-spawn kill without flushing after cancellation', () => {
    let spawn!: () => void
    const processChild = {
      postMessage: vi.fn(),
      kill: vi.fn(() => true),
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'spawn') spawn = listener
      }),
      off: vi.fn()
    }
    state.fork.mockReturnValueOnce(processChild)
    const launch = createFigPluginBridgeChildLauncher({
      appRoot: () => state.root,
      isReady: () => true,
      verifyAssets: (root) => path.join(root, FIGPLUGIN_BRIDGE_CHILD_ENTRY)
    })
    const port = launch({ origin: 'http://127.0.0.1:41234', protocol: 1, nonce: 'a'.repeat(32) })
    port.send('queued-frame')
    expect(processChild.postMessage).not.toHaveBeenCalled()
    port.kill()
    spawn()
    expect(processChild.postMessage).not.toHaveBeenCalled()
    expect(processChild.kill).toHaveBeenCalledOnce()
  })
})
