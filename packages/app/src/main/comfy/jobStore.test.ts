import { afterEach, describe, expect, it } from 'vitest'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { ComfyJobStore, MAX_COMFY_JOB_WORKFLOW_BYTES } from './jobStore'

const stores: MagicAgentEventStore[] = []
const open = () => {
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
const workflow = {
  '1': { class_type: 'EmptyLatentImage', inputs: { width: 64, height: 64, batch_size: 1 } }
}
const result = {
  prompt: [0, 'remote-prompt', workflow, { client_id: 'job-client' }, []] as [
    number,
    string,
    typeof workflow,
    { client_id: string },
    string[]
  ],
  outputs: {},
  status: { status_str: 'success' as const, completed: true, messages: [] }
}

describe('ComfyJobStore', () => {
  it('persists a stable job and its instance/prompt/result lifecycle', () => {
    const jobs = new ComfyJobStore(open())
    const created = jobs.create({
      jobId: 'job-1',
      workflow,
      clientId: 'job-client',
      target: { mode: 'auto' },
      maxAttempts: 2,
      createdAt: 1,
      idempotencyKey: 'create-1'
    })
    expect(
      jobs.create({
        jobId: 'job-1',
        workflow,
        clientId: 'job-client',
        target: { mode: 'auto' },
        maxAttempts: 2,
        createdAt: 1,
        idempotencyKey: 'create-1'
      })
    ).toEqual(created)
    const leased = jobs.assign({
      jobId: 'job-1',
      expectedRevision: 0,
      instanceId: 'gpu-a',
      instanceRouteId: 'route-gpu-a',
      instanceOrigin: 'https://gpu.example/',
      instanceKind: 'remote',
      leaseOwner: 'worker-a',
      leaseExpiresAt: 20,
      at: 2,
      idempotencyKey: 'lease-1'
    })
    const prepared = jobs.prepare({
      jobId: 'job-1',
      expectedRevision: leased.revision,
      submissionToken: 'job-1',
      promptWorkflow: workflow,
      historyWorkflow: workflow,
      at: 3,
      idempotencyKey: 'prepare-1'
    })
    const submitting = jobs.markSubmitting({
      jobId: 'job-1',
      expectedRevision: prepared.revision,
      at: 4,
      idempotencyKey: 'submitting-1'
    })
    const submitted = jobs.bindPrompt({
      jobId: 'job-1',
      expectedRevision: submitting.revision,
      promptId: 'remote-prompt',
      at: 5,
      idempotencyKey: 'prompt-1'
    })
    const running = jobs.markRunning({
      jobId: 'job-1',
      expectedRevision: submitted.revision,
      at: 5,
      idempotencyKey: 'running-1'
    })
    const done = jobs.complete({
      jobId: 'job-1',
      expectedRevision: running.revision,
      result,
      at: 5,
      idempotencyKey: 'done-1'
    })
    expect(done.state).toMatchObject({
      status: 'succeeded',
      instanceId: 'gpu-a',
      promptId: 'remote-prompt'
    })
    expect(done.state.leaseOwner).toBeUndefined()
  })
  it('enforces transitions, retry limits and unknown reconciliation', () => {
    const jobs = new ComfyJobStore(open())
    const created = jobs.create({
      jobId: 'job-1',
      workflow,
      clientId: 'c',
      maxAttempts: 1,
      createdAt: 1,
      idempotencyKey: 'c'
    })
    expect(() =>
      jobs.complete({
        jobId: 'job-1',
        expectedRevision: created.revision,
        result,
        at: 2,
        idempotencyKey: 'bad'
      })
    ).toThrow('Invalid Comfy job transition')
    const leased = jobs.assign({
      jobId: 'job-1',
      expectedRevision: created.revision,
      instanceId: 'gpu-a',
      instanceRouteId: 'route-gpu-a',
      instanceOrigin: 'https://gpu.example/',
      instanceKind: 'remote',
      leaseOwner: 'worker-a',
      leaseExpiresAt: 20,
      at: 2,
      idempotencyKey: 'lease-for-unknown'
    })
    const unknown = jobs.markUnknown({
      jobId: 'job-1',
      expectedRevision: leased.revision,
      code: 'SUBMIT_UNKNOWN',
      message: 'response lost',
      at: 3,
      idempotencyKey: 'unknown'
    })
    expect(unknown.state.status).toBe('unknown')
    expect(unknown.state.instanceRouteId).toBe('route-gpu-a')
    expect(unknown.state.submissionToken).toBeUndefined()
    expect(() =>
      jobs.retry({
        jobId: 'job-1',
        expectedRevision: unknown.revision,
        retryAt: 3,
        at: 3,
        idempotencyKey: 'retry-1'
      })
    ).toThrow('explicit manual resolution')
  })
  it('rejects backwards transition timestamps', () => {
    const jobs = new ComfyJobStore(open())
    const created = jobs.create({
      jobId: 'job-time',
      workflow,
      clientId: 'c',
      createdAt: 10,
      idempotencyKey: 'time-create'
    })
    expect(() =>
      jobs.assign({
        jobId: 'job-time',
        expectedRevision: created.revision,
        instanceId: 'gpu-a',
        instanceRouteId: 'route-a',
        instanceOrigin: 'https://gpu.example/',
        instanceKind: 'remote',
        leaseOwner: 'worker-a',
        leaseExpiresAt: 20,
        at: 9,
        idempotencyKey: 'time-backwards'
      })
    ).toThrow('cannot move backwards')
  })
  it('rejects oversized workflows and conflicting idempotency commands', () => {
    const jobs = new ComfyJobStore(open())
    expect(() =>
      jobs.create({
        jobId: 'big',
        workflow: {
          '1': { class_type: 'X', inputs: { data: 'x'.repeat(MAX_COMFY_JOB_WORKFLOW_BYTES + 1) } }
        },
        clientId: 'c',
        createdAt: 1,
        idempotencyKey: 'big'
      })
    ).toThrow('exceeds')
    jobs.create({ jobId: 'job-1', workflow, clientId: 'c', createdAt: 1, idempotencyKey: 'same' })
    expect(() =>
      jobs.create({
        jobId: 'job-1',
        workflow: { ...workflow, '2': workflow['1'] },
        clientId: 'c',
        createdAt: 1,
        idempotencyKey: 'same'
      })
    ).toThrow('idempotency conflict')
  })
})
