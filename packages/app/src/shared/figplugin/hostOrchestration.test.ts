import { describe, expect, it } from 'vitest'
import {
  appendFigPluginHostReceiptAudit,
  canTransitionFigPluginHostReceipt,
  createUnavailableFigPluginHostReceipt,
  prepareUnavailableFigPluginHostReceipt,
  validateFigPluginHostRequest,
  type FigPluginHostRequest
} from './hostOrchestration'

const request = (): FigPluginHostRequest => ({
  schemaVersion: 1,
  projectId: 'project_1',
  sessionId: 'session_1',
  taskId: 'task_1',
  requestId: 'request_1',
  hostId: 'figma',
  hostEpoch: 'epoch_1',
  selectionRefs: [{ kind: 'selection', id: 'selection_1', epoch: 'epoch_1' }],
  resourceRefs: [{ kind: 'document', id: 'document_1', epoch: 'epoch_1' }],
  plan: {
    schemaVersion: 1,
    mode: 'plan-only',
    selectionRevision: 'selection_revision_1',
    steps: [{ command: 'node.rename', targetId: 'node_1', name: 'New label' }]
  },
  permission: { mode: 'write', approval: 'pending', approvalId: 'approval_1' },
  cancellation: { requested: false },
  timeoutMs: 30_000
})

describe('fail-closed host orchestration contract', () => {
  it('detaches a complete request contract without granting host access', () => {
    const raw = request()
    const result = validateFigPluginHostRequest(raw)
    expect(result).toEqual({ ok: true, value: raw })
    if (!result.ok) return
    expect(result.value).not.toBe(raw)
    expect(result.value.plan).not.toBe(raw.plan)
    expect(result.value.permission).not.toBe(raw.permission)
  })

  it.each([
    ['requestId', 'bad/id'],
    ['hostEpoch', ''],
    ['hostId', 'indesign'],
    ['timeoutMs', 99],
    ['permission', { mode: 'write', approval: 'not-required' }],
    ['cancellation', { requested: true }],
    ['plan', { schemaVersion: 2 }]
  ])('rejects malformed %s before receipt creation', (key, value) => {
    const raw = request() as unknown as Record<string, unknown>
    raw[key] = value
    expect(validateFigPluginHostRequest(raw)).toMatchObject({ ok: false })
  })

  it('rejects duplicate plan targets, cross-scope refs and unknown fields', () => {
    const duplicate = request() as unknown as Record<string, any>
    duplicate.plan.steps.push({ command: 'node.rename', targetId: 'node_1', name: 'Again' })
    expect(validateFigPluginHostRequest(duplicate)).toEqual({ ok: false, code: 'INVALID_PLAN' })

    const wrongRef = request() as unknown as Record<string, any>
    wrongRef.resourceRefs = [{ kind: 'selection', id: 'wrong' }]
    expect(validateFigPluginHostRequest(wrongRef)).toEqual({
      ok: false,
      code: 'INVALID_RESOURCE_REF'
    })

    const unknown = { ...request(), extra: true }
    expect(validateFigPluginHostRequest(unknown)).toEqual({ ok: false, code: 'INVALID_REQUEST' })
  })

  it('mints only an explicit unavailable receipt with request identity and audit', () => {
    const result = validateFigPluginHostRequest(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const receipt = createUnavailableFigPluginHostReceipt(result.value, 100)
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      projectId: 'project_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      requestId: 'request_1',
      hostId: 'figma',
      hostEpoch: 'epoch_1',
      status: 'unavailable',
      availability: 'unavailable',
      synthetic: true,
      error: { code: 'HOST_UNAVAILABLE', retryable: false },
      usage: { inputBytes: 0, outputBytes: 0 },
      audit: [{ at: 100, status: 'unavailable', requestId: 'request_1' }]
    })
    expect(JSON.stringify(receipt)).not.toMatch(/dispatch|execute|token|secret/i)
  })

  it('provides one raw-input path that validates then fails closed', () => {
    const result = prepareUnavailableFigPluginHostReceipt(request(), 150)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('unavailable')
    expect(result.value.audit[0].at).toBe(150)
    expect(prepareUnavailableFigPluginHostReceipt({ ...request(), requestId: 'bad/id' })).toEqual({
      ok: false,
      code: 'INVALID_REQUEST'
    })
  })

  it('allows only declared receipt transitions and never revives terminal unavailable', () => {
    expect(canTransitionFigPluginHostReceipt('queued', 'preview-ready')).toBe(true)
    expect(canTransitionFigPluginHostReceipt('running', 'completed')).toBe(true)
    expect(canTransitionFigPluginHostReceipt('completed', 'running')).toBe(false)
    expect(canTransitionFigPluginHostReceipt('unavailable', 'running')).toBe(false)

    const result = validateFigPluginHostRequest(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const receipt = createUnavailableFigPluginHostReceipt(result.value, 100)
    expect(appendFigPluginHostReceiptAudit(receipt, 'running', 200)).toBeUndefined()
  })
})
