import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const logger = vi.hoisted(() => {
  const consoleTransport = {}
  const hooks: Array<(message: unknown, transport: unknown) => unknown> = []
  const emit = (level: string, data: unknown[]): void => {
    let message: unknown = { level, data }
    for (const hook of hooks) message = hook(message, consoleTransport)
  }
  const makeWriter = (level: string) =>
    vi.fn((...args: unknown[]) => {
      emit(level, args)
    })

  return {
    consoleTransport,
    hooks,
    log: makeWriter('info'),
    debug: makeWriter('debug'),
    info: makeWriter('info'),
    warn: makeWriter('warn'),
    error: makeWriter('error'),
    initialize: vi.fn(),
    transports: { console: consoleTransport, file: { resolvePathFn: undefined } }
  }
})

vi.mock('electron-log/main', () => ({ default: logger }))
vi.mock('../config/portablePaths', () => ({
  resolveEarlyPortableUserDataDirectory: () => 'C:/magicpot-logging-override-test'
}))

describe('loggingOverride listener lifecycle', () => {
  const originalConsole = {
    log: console.log,
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error
  }
  let addLogListener: typeof import('./loggingOverride').addLogListener

  beforeAll(async () => {
    ;({ addLogListener } = await import('./loggingOverride'))
  })

  afterAll(() => {
    console.log = originalConsole.log
    console.debug = originalConsole.debug
    console.info = originalConsole.info
    console.warn = originalConsole.warn
    console.error = originalConsole.error
  })

  it('removes a failing listener without recursively logging its failure', () => {
    const broken = vi.fn(() => {
      throw new Error('closed stream')
    })
    const healthy = vi.fn()
    const removeBroken = addLogListener(broken)
    const removeHealthy = addLogListener(healthy)

    logger.info('first')

    expect(broken).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledTimes(1)

    const healthyCallsAfterFailure = healthy.mock.calls.length
    logger.info('second')

    expect(broken).toHaveBeenCalledTimes(1)
    expect(healthy.mock.calls.length).toBeGreaterThan(healthyCallsAfterFailure)
    expect(logger.error).toHaveBeenCalledTimes(1)

    removeBroken()
    removeHealthy()
  })

  it('does not retain a listener that fails while replaying history', () => {
    logger.info('history entry')
    const broken = vi.fn(() => {
      throw new Error('replay stream closed')
    })

    addLogListener(broken)
    const callsAfterReplay = broken.mock.calls.length
    logger.info('after replay')

    expect(callsAfterReplay).toBeGreaterThan(0)
    expect(broken).toHaveBeenCalledTimes(callsAfterReplay)
  })
})
