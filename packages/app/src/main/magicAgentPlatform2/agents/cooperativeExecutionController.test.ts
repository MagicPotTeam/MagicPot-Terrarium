import { describe, expect, it, vi } from 'vitest'
import { CooperativeExecutionController } from './cooperativeExecutionController'

describe('CooperativeExecutionController', () => {
  it('waits for active work before acknowledging pause and blocks new checkpoints', async () => {
    const controller = new CooperativeExecutionController()
    const leave = controller.enter('llm-inference')
    let paused = false
    const pause = controller.requestPause().then(() => {
      paused = true
    })
    await Promise.resolve()
    expect(paused).toBe(false)
    leave()
    await pause
    expect(controller.isPaused()).toBe(true)
    expect(controller.isQuiescent()).toBe(true)
    let crossed = false
    const checkpoint = controller.checkpoint('assistant-turn').then(() => {
      crossed = true
    })
    await Promise.resolve()
    expect(crossed).toBe(false)
    controller.resume()
    await checkpoint
    expect(crossed).toBe(true)
  })

  it('tracks nested operation kinds and ignores duplicate release', async () => {
    const controller = new CooperativeExecutionController()
    const leaveTurn = controller.enter('assistant-turn')
    const leaveTool = controller.enter('tool-invocation')
    const pause = controller.requestPause()
    leaveTurn()
    leaveTurn()
    await Promise.resolve()
    expect(controller.isQuiescent()).toBe(false)
    leaveTool()
    await pause
    expect(controller.isQuiescent()).toBe(true)
  })
})

it('supports graph-node admission and aborts a paused checkpoint', async () => {
  const controller = new CooperativeExecutionController()
  await controller.requestPause()
  const abort = new AbortController()
  const checkpoint = controller.checkpoint('graph-node', abort.signal)
  abort.abort(new Error('cancelled'))
  await expect(checkpoint).rejects.toThrow('cancelled')
})
