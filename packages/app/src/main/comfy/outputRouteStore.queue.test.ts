import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComfyHistory, Workflow } from '@shared/comfy/types'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'

const mocks = vi.hoisted(() => {
  const client = {
    objectInfo: vi.fn(),
    uploadImage: vi.fn(),
    uploadMask: vi.fn(),
    prompt: vi.fn(),
    history: vi.fn(),
    historyAll: vi.fn(),
    interrupt: vi.fn(),
    cancel: vi.fn(),
    getQueue: vi.fn(),
    isRemoteComfyUI: vi.fn(() => true),
    freeMemory: vi.fn()
  }
  return {
    client,
    release: vi.fn(),
    capture: vi.fn(),
    acquireComfyInstance: vi.fn()
  }
})

vi.mock('./instancePool', () => ({
  acquireComfyInstance: mocks.acquireComfyInstance,
  getComfyInstanceClient: vi.fn(() => mocks.client),
  getComfyInstanceRegistry: vi.fn(() => ({ get: vi.fn(), list: vi.fn() }))
}))

vi.mock('./http', () => ({
  COMFY_PROCESS_TRANSPORT_CLIENT_ID: 'magicpot-main-process',
  ComfyHttpCli: vi.fn(function ComfyHttpCli() {
    return mocks.client
  })
}))

vi.mock('./outputRouteStore', () => ({
  getComfyOutputRouteStore: vi.fn(() => ({
    capture: mocks.capture,
    get: vi.fn()
  }))
}))

import { addTask, getTask, initTaskQueue, stopTaskQueue } from '../queue/taskQueue'

const workflow: Workflow = {
  '1': { class_type: 'SaveImage', inputs: { images: ['0', 0] } }
}

const successfulHistory = (promptId: string): ComfyHistory => ({
  prompt: [0, promptId, workflow, { client_id: 'transport' }, []],
  outputs: { '1': { images: [{ filename: 'result.png', type: 'output' }] } },
  status: { status_str: 'success', completed: true, messages: [] }
})

const enqueue = (): string =>
  addTask({
    id: '',
    type: 'comfy_prompt',
    client_id: 'renderer',
    created_at: Date.now(),
    prompt_id: null,
    payload: structuredClone(workflow),
    result: null
  })

const waitForStatus = async (id: string, expected: 'completed' | 'error') => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const [status, task] = getTask(id)
    if (status === expected && task) return task
    await vi.advanceTimersByTimeAsync(5)
  }
  throw new Error(`Timed out waiting for ${id}: ${getTask(id)[0]}`)
}

describe('task output route capture ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.acquireComfyInstance.mockResolvedValue({
      state: {
        id: 'gpu-route',
        origin: 'https://gpu-route.example/',
        kind: 'remote',
        enabled: true,
        maxConcurrency: 1,
        tags: [],
        capabilities: { tags: [], models: [], customNodes: [] },
        health: { status: 'online' }
      },
      cli: mocks.client,
      release: mocks.release
    })
    mocks.client.objectInfo.mockResolvedValue({})
    mocks.client.historyAll.mockResolvedValue({})
    mocks.client.getQueue.mockResolvedValue({ queue_running: [], queue_pending: [] })
    mocks.client.history.mockImplementation(async (promptId: string) => ({
      [promptId]: successfulHistory(promptId)
    }))
  })

  afterEach(async () => {
    await stopTaskQueue()
    vi.useRealTimers()
  })

  it('commits the captured route before calling the leased client prompt', async () => {
    let routeCommitted = false
    mocks.capture.mockImplementation(() => {
      routeCommitted = true
      return {
        routeId: 'route-durable',
        instanceId: 'gpu-route',
        origin: 'https://gpu-route.example/',
        kind: 'remote',
        createdAt: Date.now()
      }
    })
    mocks.client.prompt.mockImplementation(async () => {
      expect(routeCommitted).toBe(true)
      return { prompt_id: 'prompt-after-route' }
    })

    await initTaskQueue({ eventStore: new MagicAgentEventStore(':memory:') })
    const id = enqueue()
    await vi.advanceTimersByTimeAsync(1_100)
    const task = await waitForStatus(id, 'completed')

    expect(mocks.capture).toHaveBeenCalledTimes(1)
    expect(mocks.client.prompt).toHaveBeenCalledTimes(1)
    expect(task.instanceRouteId).toBe('route-durable')
  })

  it('sends zero prompt requests when durable route capture fails', async () => {
    mocks.capture.mockImplementation(() => {
      throw new Error('route persistence failed')
    })

    await initTaskQueue({ eventStore: new MagicAgentEventStore(':memory:') })
    const id = enqueue()
    await vi.advanceTimersByTimeAsync(1_100)
    await waitForStatus(id, 'error')
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1))

    expect(mocks.capture).toHaveBeenCalledTimes(1)
    expect(mocks.client.objectInfo).not.toHaveBeenCalled()
    expect(mocks.client.uploadImage).not.toHaveBeenCalled()
    expect(mocks.client.uploadMask).not.toHaveBeenCalled()
    expect(mocks.client.prompt).not.toHaveBeenCalled()
  })
})
