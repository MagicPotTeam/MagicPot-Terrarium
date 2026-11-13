import { describe, expect, it, vi } from 'vitest'
import {
  CooperativeExecutionController,
  type CooperativeExecutionKind,
  type CooperativeOperationGate
} from './cooperativeExecutionController'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function microtasks() {
  for (let i = 0; i < 24; i++) await Promise.resolve()
}
const kinds: readonly CooperativeExecutionKind[] = [
  'assistant-turn',
  'llm-inference',
  'tool-invocation',
  'scheduled-task',
  'graph-node'
]

describe('legacy enter cannot bypass paused callback admission (not raw-effect drainage)', () => {
  it.each(kinds)(
    'rejects paused legacy %s before registration without changing the current ticket',
    async (kind) => {
      const execution = new CooperativeExecutionController()
      const ticket = await execution.requestPause()
      let release: (() => void) | undefined
      try {
        expect(() => {
          release = execution.enter(kind)
        }).toThrow(expect.objectContaining({ code: 'COOPERATIVE_EXECUTION_PAUSED' }))
        expect(execution.isPaused()).toBe(true)
        expect(execution.isQuiescent()).toBe(true)
        expect(execution.isPauseCurrent(ticket)).toBe(true)
        expect(await execution.requestPause()).toBe(ticket)
      } finally {
        release?.()
        execution.resume()
      }
    }
  )

  it('cannot use a completed checkpoint when pause wins before its enter continuation', async () => {
    const execution = new CooperativeExecutionController()
    const checkpoint = execution.checkpoint('assistant-turn')
    const ticket = await execution.requestPause()
    let release: (() => void) | undefined
    try {
      await checkpoint
      expect(() => {
        release = execution.enter('assistant-turn')
      }).toThrow(expect.objectContaining({ code: 'COOPERATIVE_EXECUTION_PAUSED' }))
      expect(execution.isPauseCurrent(ticket)).toBe(true)
      expect(execution.isQuiescent()).toBe(true)
    } finally {
      release?.()
      execution.resume()
    }
  })

  it('a resume wakeup followed by re-pause cannot authorize the old split continuation', async () => {
    const execution = new CooperativeExecutionController()
    await execution.requestPause()
    const callback = vi.fn()
    let release: (() => void) | undefined
    const continuation = execution.checkpoint('tool-invocation').then(() => {
      release = execution.enter('tool-invocation')
      callback()
    })
    const observed = continuation.catch((error) => error)
    execution.resume()
    const ticket = await execution.requestPause()
    try {
      expect(await observed).toMatchObject({ code: 'COOPERATIVE_EXECUTION_PAUSED' })
      expect(callback).not.toHaveBeenCalled()
      expect(execution.isPauseCurrent(ticket)).toBe(true)
      expect(execution.isQuiescent()).toBe(true)
    } finally {
      release?.()
      execution.resume()
      await observed
    }
  })

  it('rejects even apparent nested legacy entry while an actual callback child still drains during pause', async () => {
    const execution = new CooperativeExecutionController(),
      finish = deferred()
    let child!: CooperativeOperationGate, legacyRelease: (() => void) | undefined
    const running = execution.run('assistant-turn', undefined, (scope) => {
      child = scope
      return finish.promise
    })
    let acknowledged = false
    const paused = execution.requestPause().then((ticket) => {
      acknowledged = true
      return ticket
    })
    try {
      expect(() => {
        legacyRelease = execution.enter('tool-invocation')
      }).toThrow(expect.objectContaining({ code: 'COOPERATIVE_EXECUTION_PAUSED' }))
      const callback = vi.fn()
      await child.run('tool-invocation', undefined, callback)
      expect(callback).toHaveBeenCalledOnce()
      await microtasks()
      expect(acknowledged).toBe(false)
      expect(execution.isQuiescent()).toBe(false)
      finish.resolve()
      await running
      const ticket = await paused
      expect(execution.isPauseCurrent(ticket)).toBe(true)
      await expect(child.run('tool-invocation', undefined, callback)).rejects.toMatchObject({
        code: 'COOPERATIVE_SCOPE_RELEASED'
      })
      expect(callback).toHaveBeenCalledOnce()
    } finally {
      legacyRelease?.()
      finish.resolve()
      await running
      await paused
      execution.resume()
    }
  })

  it('retains running legacy registration, duplicate release and explicit resume compatibility', async () => {
    const execution = new CooperativeExecutionController()
    const leave = execution.enter('graph-node')
    const paused = execution.requestPause()
    expect(execution.isQuiescent()).toBe(false)
    leave()
    leave()
    const old = await paused
    expect(execution.isPauseCurrent(old)).toBe(true)
    execution.resume()
    const next = execution.enter('scheduled-task')
    try {
      expect(execution.isPauseCurrent(old)).toBe(false)
      expect(execution.isQuiescent()).toBe(false)
    } finally {
      next()
    }
    expect(execution.isQuiescent()).toBe(true)
  })
})
