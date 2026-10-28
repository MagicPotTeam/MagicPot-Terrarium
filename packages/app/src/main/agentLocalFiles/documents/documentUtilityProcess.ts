import { app, utilityProcess } from 'electron'
import {
  createDocumentProcessSupervisor,
  type DocumentProcessOutcome,
  type DocumentProcessSupervisor,
  type DocumentProcessTransportEvents
} from './documentProcessSupervisor'
import type { DocumentTextRequest } from './documentSchema'
import { parseDocumentTextResultFrame, serializeDocumentTextRequest } from './documentWorkerWire'
import { verifyDocumentWorkerAssets } from './documentWorkerAssets'

export type DocumentUtilityChild = {
  kill(): boolean
  postMessage(frame: string): void
  on(event: 'spawn', listener: () => void): unknown
  on(event: 'message', listener: (frame: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'error', listener: () => void): unknown
  removeListener(event: 'spawn', listener: () => void): unknown
  removeListener(event: 'message', listener: (frame: unknown) => void): unknown
  removeListener(event: 'exit', listener: (code: number) => void): unknown
  removeListener(event: 'error', listener: () => void): unknown
}
/** Trusted main-owned test dependencies only. No IPC method exposes these options. */
export type DocumentUtilityOptions = {
  appRoot?: () => string
  isReady?: () => boolean
  verifyAssets?: (root: string) => string
  fork?: (entry: string, args: string[], options: Electron.ForkOptions) => DocumentUtilityChild
}

export function documentUtilityEnvironment(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  // Electron's empty env can inherit the entire parent. Always send a nonempty allowlist.
  const env: Record<string, string> = { LANG: 'C' }
  for (const key of ['SystemRoot', 'WINDIR']) {
    if (source[key]) env[key] = source[key]!
  }
  return env
}

/** A fault-containment Node child, NOT an OS sandbox. No worker file authority or credentials.
 * Unlike supervisor.run(), this product Promise never settles a spawned child at kill request.
 * Its outer slot (and the caller's file handle) remain quarantined until native exit. */
export function createDocumentUtilityExtractor(options: DocumentUtilityOptions = {}) {
  const appRoot = options.appRoot ?? (() => app.getAppPath())
  const ready = options.isReady ?? (() => app.isReady())
  const verify = options.verifyAssets ?? verifyDocumentWorkerAssets
  const fork = options.fork ?? ((entry, args, opts) => utilityProcess.fork(entry, args, opts))
  let disposed = false
  let active: { supervisor: DocumentProcessSupervisor } | null = null

  const extract = async (
    request: DocumentTextRequest,
    signal: AbortSignal
  ): Promise<DocumentProcessOutcome> => {
    if (disposed) return { ok: false, code: 'EXECUTION_FAILED' }
    if (active) return { ok: false, code: 'LIMIT' }
    let events: DocumentProcessTransportEvents | undefined
    let child: DocumentUtilityChild | undefined
    let spawned = false
    let exited = false
    let killRequested = false
    let confirmExit!: () => void
    const nativeExit = new Promise<void>((resolve) => {
      confirmExit = resolve
    })
    const queue: string[] = []
    const identity = {
      kill: (): boolean => {
        killRequested = true
        return child?.kill() ?? false
      }
    }
    const onSpawn = (): void => {
      spawned = true
      if (killRequested) {
        // A cancel before native spawn may have returned false. Retry only the kill,
        // never mint an exit and never send a request after cancellation.
        void identity.kill()
        return
      }
      for (const frame of queue.splice(0)) {
        try {
          child!.postMessage(frame)
        } catch {
          events?.error(identity, undefined)
        }
      }
    }
    const onMessage = (frame: unknown): void => events?.data(identity, frame)
    const onError = (): void => events?.error(identity, undefined)
    const onExit = (code: number): void => {
      if (exited) return
      exited = true
      events?.exit(identity, code, null)
      confirmExit()
    }
    const supervisor = createDocumentProcessSupervisor({
      transport: {
        subscribe: (listener) => {
          events = listener
          return () => {
            events = undefined
          }
        },
        send: (frame) => {
          if (!child || exited || killRequested) throw new Error('Document transport unavailable')
          if (!spawned) queue.push(frame)
          else child.postMessage(frame)
        }
      },
      codec: {
        serialize: serializeDocumentTextRequest,
        decode: (frame, job, format) => {
          const parsed = parseDocumentTextResultFrame(frame, job, format)
          if (!parsed.ok) throw new Error('Document result unavailable')
          return parsed.result
        }
      },
      start: ({ signal: localSignal }) => {
        if (!ready() || localSignal.aborted) throw new Error('Document runtime unavailable')
        const entry = verify(appRoot())
        if (localSignal.aborted) throw new Error('Document runtime unavailable')
        child = fork(entry, [], {
          env: documentUtilityEnvironment(),
          execArgv: ['--max-old-space-size=256'],
          stdio: 'ignore',
          serviceName: 'MagicPot document text',
          allowLoadingUnsignedLibraries: false
        })
        child.on('spawn', onSpawn)
        child.on('message', onMessage)
        child.on('exit', onExit)
        child.on('error', onError)
        // Return identity synchronously so supervisor owns pre-spawn cancellation.
        // The actual native spawn flushes its queued canonical request exactly once.
        return identity
      }
    })
    active = { supervisor }
    try {
      const outcome = await supervisor.run(request, signal)
      if (child && !exited) await nativeExit
      return outcome
    } finally {
      if (child && exited) {
        child.removeListener('spawn', onSpawn)
        child.removeListener('message', onMessage)
        child.removeListener('exit', onExit)
        child.removeListener('error', onError)
      }
      supervisor.dispose()
      active = null
    }
  }
  return {
    extract,
    dispose: (): void => {
      disposed = true
      active?.supervisor.dispose()
    }
  }
}
