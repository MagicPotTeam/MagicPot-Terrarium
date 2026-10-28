import { app, utilityProcess } from 'electron'
import type { FigPluginBridgeProcessPort } from './bridgeTransport'
import { FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL } from './bridgeChildProtocol'
import { FIGPLUGIN_BRIDGE_CHILD_ENTRY, verifyFigPluginBridgeChildAssets } from './bridgeChildAssets'

/** Fixed build output; never selected from a request, profile, or environment. */
export { FIGPLUGIN_BRIDGE_CHILD_ENTRY }

type UtilityChild = {
  postMessage(value: string): void
  kill(): boolean
  on(event: 'message', listener: (...args: unknown[]) => void): unknown
  once(
    event: 'spawn' | 'message' | 'exit' | 'error',
    listener: (...args: unknown[]) => void
  ): unknown
  off(
    event: 'spawn' | 'message' | 'exit' | 'error',
    listener: (...args: unknown[]) => void
  ): unknown
}

export type FigPluginBridgeChildLauncherOptions = {
  appRoot?: () => string
  isReady?: () => boolean
  verifyAssets?: (root: string) => string
  fork?: (entry: string, args: string[], options: Electron.ForkOptions) => UtilityChild
}
type BridgeChildLaunchInput = {
  origin: string
  protocol: typeof FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL
  nonce: string
}

/** Keep child startup independent of provider credentials and executable PATH. */
export function figPluginBridgeChildEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = { LANG: 'C' }
  for (const key of ['SystemRoot', 'WINDIR']) {
    if (source[key]) env[key] = source[key]!
  }
  return env
}

export function resolveFigPluginBridgeChildEntry(appRoot: string): string {
  return verifyFigPluginBridgeChildAssets(appRoot)
}

/**
 * Creates the production launcher for the bounded child protocol. The child
 * is an isolation endpoint only; no Bridge runtime or credentials are moved.
 */
export function createFigPluginBridgeChildLauncher(
  options: FigPluginBridgeChildLauncherOptions = {}
): (input: BridgeChildLaunchInput) => FigPluginBridgeProcessPort {
  const appRoot = options.appRoot ?? (() => app.getAppPath())
  const ready = options.isReady ?? (() => app.isReady())
  const verify = options.verifyAssets ?? verifyFigPluginBridgeChildAssets
  const fork =
    options.fork ??
    ((entry, args, forkOptions) => utilityProcess.fork(entry, args, forkOptions) as UtilityChild)

  return () => {
    if (!ready()) throw new Error('Bridge child unavailable before Electron readiness')
    const child = fork(verify(appRoot()), [], {
      env: figPluginBridgeChildEnvironment(),
      execArgv: [],
      stdio: 'ignore',
      serviceName: 'MagicPot Bridge isolation child',
      allowLoadingUnsignedLibraries: false
    })
    let spawned = false
    let exited = false
    let killRequested = false
    const queue: string[] = []
    const onSpawn = (): void => {
      spawned = true
      if (killRequested) {
        // A pre-spawn kill may return false; retry only the native kill once
        // spawn is observable. Never flush a frame after cancellation.
        void child.kill()
        return
      }
      for (const frame of queue.splice(0)) child.postMessage(frame)
    }
    const onExit = (): void => {
      exited = true
      queue.length = 0
    }
    child.once('spawn', onSpawn)
    child.once('exit', onExit)
    return {
      send(frame: string): void {
        if (exited || killRequested) throw new Error('Bridge child unavailable')
        if (spawned) child.postMessage(frame)
        else queue.push(frame)
      },
      on(event: 'message', listener: (...args: unknown[]) => void): void {
        child.on(event, listener)
      },
      kill(): void {
        killRequested = true
        queue.length = 0
        if (spawned) void child.kill()
      },
      once(event, listener): void {
        child.once(event, listener)
      },
      off(event, listener): void {
        child.off(event, listener)
      }
    }
  }
}
