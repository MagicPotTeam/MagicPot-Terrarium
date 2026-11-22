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
  let capLogHistoryMessage: typeof import('./loggingOverride').capLogHistoryMessage
  let MAX_LOG_HISTORY_ENTRY_CHARACTERS: number

  beforeAll(async () => {
    ;({ addLogListener, capLogHistoryMessage, MAX_LOG_HISTORY_ENTRY_CHARACTERS } =
      await import('./loggingOverride'))
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

  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

  it('caps an oversized entry in the live stream and in the replayed history, keeping head and tail', () => {
    const live = vi.fn()
    const removeLive = addLogListener(live)
    const payload = `HEAD-${'A'.repeat(2 * 1024 * 1024)}-TAIL`
    logger.info('[Request]', payload)
    removeLive()

    const [liveEntry] = live.mock.calls.at(-1) as [{ message: string }]
    expect(liveEntry.message.length).toBeLessThanOrEqual(MAX_LOG_HISTORY_ENTRY_CHARACTERS)
    expect(liveEntry.message.startsWith('[Request] HEAD-')).toBe(true)
    expect(liveEntry.message.endsWith('-TAIL')).toBe(true)
    expect(liveEntry.message).toContain('[log truncated]')

    const replay = vi.fn()
    const removeReplay = addLogListener(replay)
    removeReplay()
    const replayed = replay.mock.calls.map(([entry]) => (entry as { message: string }).message)
    expect(replayed).toContain(liveEntry.message)
    expect(Math.max(...replayed.map((message) => message.length))).toBeLessThanOrEqual(
      MAX_LOG_HISTORY_ENTRY_CHARACTERS
    )
  })

  it('keeps short entries unchanged', () => {
    const live = vi.fn()
    const remove = addLogListener(live)
    logger.warn('short 魔壶 entry 🧪', { ok: true })
    remove()
    expect((live.mock.calls.at(-1) as [{ message: string }])[0].message).toBe(
      'short 魔壶 entry 🧪 {"ok":true}'
    )
    expect(capLogHistoryMessage('x'.repeat(64), 64)).toBe('x'.repeat(64))
  })

  it.each([0, 1])('never cuts a surrogate pair in half (emoji offset %i)', (offset) => {
    // With an odd or even prefix the cut points land on both halves of a pair.
    const message = 'a'.repeat(offset) + '🧪'.repeat(40_000) + 'b'.repeat(offset)
    for (const limit of [1000, 1001, 1002, 1003, MAX_LOG_HISTORY_ENTRY_CHARACTERS]) {
      const capped = capLogHistoryMessage(message, limit)
      expect(capped.length).toBeLessThanOrEqual(limit)
      expect(capped).not.toMatch(loneSurrogate)
      expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped)
      expect(capped).toContain('[log truncated]')
    }
  })

  it('keeps Chinese text intact at the cut points', () => {
    const capped = capLogHistoryMessage('开始' + '魔'.repeat(100_000) + '结束', 1000)
    expect(capped.length).toBeLessThanOrEqual(1000)
    expect(capped.startsWith('开始魔')).toBe(true)
    expect(capped.endsWith('魔结束')).toBe(true)
    expect(capped).not.toMatch(loneSurrogate)
  })
})
