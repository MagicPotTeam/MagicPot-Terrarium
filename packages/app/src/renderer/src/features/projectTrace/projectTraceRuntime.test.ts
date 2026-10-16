import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectTraceEventSummary } from '@shared/projectTrace'
import { createProjectRecord, PROJECTS_STORAGE_KEY } from '@renderer/pages/MainPage/projectStore'

const mockReadProjectTraceDocument = vi.fn()
const mockReadProjectTraceReferences = vi.fn()
const mockChat = vi.fn()

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcProjectTrace: {
      readProjectTraceDocument: mockReadProjectTraceDocument,
      readProjectTraceReferences: mockReadProjectTraceReferences
    },
    svcLLMProxy: {
      chat: mockChat
    }
  })
}))

vi.mock('./projectTraceProjectRef', () => ({
  resolveCanvasProjectTraceProjectRef: vi.fn(async (projectId: string, projectName?: string) => ({
    projectId,
    ...(projectName ? { projectName } : {})
  }))
}))

import {
  PROJECT_TRACE_RUNTIME_EVENT,
  PROJECT_TRACE_REALTIME_ADVICE_EVENT,
  clearActiveProjectTraceRealtime,
  clearRecentProjectTraceEvents,
  emitProjectTraceRuntimeEvent,
  extractProjectTraceMovementLimitPx,
  readActiveProjectTraceCapture,
  readActiveProjectTraceRealtime,
  readProjectTraceTargetReferenceState,
  readRecentProjectTraceEvents,
  writeActiveProjectTraceCapture,
  writeActiveProjectTraceRealtime,
  writeProjectTraceTargetReferenceState,
  writeRecentProjectTraceEvents
} from './projectTraceRuntime'

function storedEvent(overrides: Partial<ProjectTraceEventSummary> = {}): ProjectTraceEventSummary {
  return {
    id: 'event-1',
    at: new Date().toISOString(),
    scope: 'canvas',
    action: 'canvas_items_changed',
    status: 'success',
    safeSummary: 'Moved 1 item.',
    ...overrides
  }
}

describe('projectTraceRuntime', () => {
  beforeEach(() => {
    localStorage.clear()
    mockReadProjectTraceDocument.mockReset()
    mockReadProjectTraceReferences.mockReset().mockResolvedValue({ references: [] })
    mockChat.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('redacts sensitive details before dispatching and caching runtime events', () => {
    const listener = vi.fn()
    window.addEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)

    const event = emitProjectTraceRuntimeEvent({
      projectId: 'project-1',
      scope: 'agent',
      action: 'agent_message',
      label: 'owner@example.com',
      status: 'success',
      safeSummary:
        'Used Bearer abcdefghijklmnopqrstuvwxyz123456 token=secret C:\\Users\\alice\\secret.png file:///C:/tmp/a.png'
    })

    expect(event.label).toBe('[redacted]')
    expect(event.safeSummary).toContain('Used [redacted]')
    expect(event.safeSummary).toContain('token=[redacted]')
    expect(event.safeSummary).toContain('[redacted]')
    expect(event.safeSummary).not.toMatch(/C:\\|file:\/\//)
    expect(event.safeSummary).not.toMatch(/abcdefghijklmnopqrstuvwxyz|token=secret|alice|tmp\/a/)
    expect(readRecentProjectTraceEvents('project-1')[0].safeSummary).toBe(event.safeSummary)
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0].detail.event).toEqual(event)

    window.removeEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)
  })

  it('sanitizes all emitted arrays and project metadata before persistence and dispatch', () => {
    const listener = vi.fn()
    window.addEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)
    const event = emitProjectTraceRuntimeEvent({
      projectId: 'project-1',
      projectName: '/fixture-data/project',
      scope: 'canvas',
      action: 'canvas_items_changed',
      safeSummary: 'Moved 1 item.',
      inputKinds: ['text', 'owner@example.com', 'Bearer private-credential'],
      outputKinds: [
        'image',
        'C:\\Users\\fixture-data\\picture.png',
        'https://private.example/file'
      ],
      riskSignals: ['destructive_action', '/fixture-data/secret', 'sk-privatecredential'],
      movementDistancePx: 30.123,
      maxScaleChangeRatio: 2,
      maxRotationDeltaDeg: 90,
      maxLayerDelta: 2,
      canvasMutation: true
    })
    expect(event.inputKinds).toEqual(['text', '[redacted]', '[redacted]'])
    expect(event.outputKinds).toEqual(['image', '[redacted]', '[redacted]'])
    expect(event.riskSignals).toEqual(['destructive_action', '[redacted]', '[redacted]'])
    expect(event).toMatchObject({
      movementDistancePx: 30.12,
      maxScaleChangeRatio: 2,
      maxRotationDeltaDeg: 90,
      maxLayerDelta: 2,
      canvasMutation: true
    })
    const detail = listener.mock.calls[0][0].detail
    expect(detail).toEqual({ projectId: 'project-1', projectName: '[redacted]', event })
    expect(JSON.stringify(detail)).not.toMatch(/private|fixture-data|owner@example/)
    expect(JSON.parse(localStorage.getItem('projectTrace.recentEvents.project-1')!)).toEqual([
      event
    ])
    expect(readRecentProjectTraceEvents('project-1')).toEqual([event])
    window.removeEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)
  })

  it('drops corrupt, future, and expired history and keeps the newest duplicate ID', () => {
    const now = Date.now()
    const recent = storedEvent({ at: new Date(now - 1000).toISOString() })
    const newest = { ...recent, at: new Date(now).toISOString(), safeSummary: 'Latest change.' }
    localStorage.setItem(
      'projectTrace.recentEvents.project-1',
      JSON.stringify([
        null,
        {},
        { ...recent, scope: 'invalid' },
        { ...recent, at: 'not a timestamp' },
        { ...recent, id: 'old', at: new Date(now - 31 * 86400000).toISOString() },
        { ...recent, id: 'future', at: new Date(now + 86400000).toISOString() },
        recent,
        newest
      ])
    )
    expect(readRecentProjectTraceEvents('project-1')).toEqual([newest])
    expect(JSON.parse(localStorage.getItem('projectTrace.recentEvents.project-1')!)).toEqual([
      newest
    ])
  })

  it('bounds history at 120 sanitized events when writing the compatible storage key', () => {
    const now = Date.now()
    const events = Array.from({ length: 130 }, (_, index) =>
      storedEvent({
        id: `event-${index}`,
        at: new Date(now - 130 + index).toISOString(),
        safeSummary: 'owner@example.com',
        inputKinds: ['text', '/fixture-data/file'],
        riskSignals: Array(20).fill('destructive_action')
      })
    )
    writeRecentProjectTraceEvents('project-1', [...events, events[129]])
    const raw = localStorage.getItem('projectTrace.recentEvents.project-1')!
    expect(raw).not.toMatch(/owner@example|\/fixture-data/)
    const saved = JSON.parse(raw)
    expect(saved).toHaveLength(120)
    expect(saved[0].id).toBe('event-10')
    expect(saved[119].id).toBe('event-129')
    expect(saved[119].riskSignals).toHaveLength(12)
    expect(saved[119].inputKinds).toEqual(['text', '[redacted]'])
    expect(readRecentProjectTraceEvents('project-1')).toEqual(saved)
  })

  it.each(['{broken', '{}', 'null', '[null, {}, 4]', ' '.repeat(1024 * 1024 + 1)])(
    'returns no malformed or oversized raw history (%#)',
    (raw) => {
      localStorage.setItem('projectTrace.recentEvents.project-1', raw)
      expect(readRecentProjectTraceEvents('project-1')).toEqual([])
      writeRecentProjectTraceEvents('project-1', [
        null,
        {}
      ] as unknown as ProjectTraceEventSummary[])
      expect(localStorage.getItem('projectTrace.recentEvents.project-1')).toBe('[]')
    }
  )

  it.each([
    '',
    '  ',
    'x'.repeat(161),
    'C:\\Users\\fixture-data',
    '/fixture-data',
    '\\\\server\\fixture-data',
    'file:fixture-data'
  ])('rejects invalid or plaintext path project identities (%#)', (projectId) => {
    const listener = vi.fn()
    window.addEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    expect(readRecentProjectTraceEvents(projectId)).toEqual([])
    writeRecentProjectTraceEvents(projectId, [storedEvent()])
    expect(() => clearRecentProjectTraceEvents(projectId)).toThrow('Invalid project')
    emitProjectTraceRuntimeEvent({
      projectId,
      scope: 'canvas',
      action: 'move',
      safeSummary: 'Moved.'
    })
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(listener.mock.calls[0][0].detail.projectId).toBeUndefined()
    window.removeEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)
  })

  it('clears only this project local history and emits a data-free refresh', () => {
    const otherKeys = [
      'projectTrace.recentEvents.project-2',
      'projectTrace.activeCapture.project-1',
      'projectTrace.activeRealtime.project-1',
      'projectTrace.targetReferences.project-1',
      'projectTrace.comparisons.project-1',
      'qapp.currentQAppKey.project-1',
      PROJECTS_STORAGE_KEY
    ]
    otherKeys.forEach((key) => localStorage.setItem(key, 'untouched'))
    writeRecentProjectTraceEvents('project-1', [storedEvent()])
    const listener = vi.fn()
    window.addEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)

    clearRecentProjectTraceEvents('project-1')

    expect(localStorage.getItem('projectTrace.recentEvents.project-1')).toBeNull()
    otherKeys.forEach((key) => expect(localStorage.getItem(key)).toBe('untouched'))
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0].detail).toEqual({ projectId: 'project-1' })
    expect(mockReadProjectTraceReferences).not.toHaveBeenCalled()
    expect(mockChat).not.toHaveBeenCalled()
    window.removeEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)
  })

  it('does not overwrite recent history when reading the history key is unavailable', () => {
    const projectId = 'project-read-unavailable'
    const storageKey = `projectTrace.recentEvents.${projectId}`
    const previous = [storedEvent({ id: 'existing-event' })]
    const previousRaw = JSON.stringify(previous)
    localStorage.setItem(storageKey, previousRaw)

    const originalGetItem = Storage.prototype.getItem
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (key === storageKey) {
        throw new Error('storage read unavailable')
      }
      return originalGetItem.call(localStorage, key)
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    try {
      expect(() =>
        emitProjectTraceRuntimeEvent({
          projectId,
          scope: 'canvas',
          action: 'move',
          safeSummary: 'Moved.'
        })
      ).not.toThrow()
      expect(setItem.mock.calls.filter(([key]) => key === storageKey)).toHaveLength(0)
    } finally {
      getItem.mockRestore()
      expect(localStorage.getItem(storageKey)).toBe(previousRaw)
      readRecentProjectTraceEvents(projectId)
    }
  })

  it('keeps quota failures local and reports clear failure without raw storage errors', () => {
    writeRecentProjectTraceEvents('project-1', [storedEvent()])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota token=private-value /fixture-data/file')
    })
    expect(() =>
      emitProjectTraceRuntimeEvent({
        projectId: 'project-1',
        scope: 'canvas',
        action: 'move',
        safeSummary: 'Moved.'
      })
    ).not.toThrow()
    const listener = vi.fn()
    window.addEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Storage token=private-value /fixture-data/file')
    })
    expect(() => clearRecentProjectTraceEvents('project-1')).toThrow(
      new Error('Unable to clear project history')
    )
    expect(readRecentProjectTraceEvents('project-1')).toHaveLength(1)
    expect(listener).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    window.removeEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)
  })

  it('never reads references or calls a model for a new manual project with old realtime state', async () => {
    const project = createProjectRecord({
      id: 'manual-project',
      name: 'New',
      createdAt: Date.now()
    })
    expect(project.analysisMode).toBe('manual')
    const registry = JSON.stringify([project])
    localStorage.setItem(PROJECTS_STORAGE_KEY, registry)
    writeActiveProjectTraceRealtime({
      projectId: project.id,
      referenceTraceIds: ['old-trace'],
      modelProfileId: 'old-model'
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    emitProjectTraceRuntimeEvent({
      projectId: project.id,
      scope: 'canvas',
      action: 'canvas_items_changed',
      safeSummary: 'Moved 1 image.',
      movementDistancePx: 700,
      canvasMutation: true
    })
    await vi.dynamicImportSettled()
    await Promise.resolve()
    expect(mockReadProjectTraceReferences).not.toHaveBeenCalled()
    expect(mockReadProjectTraceDocument).not.toHaveBeenCalled()
    expect(mockChat).not.toHaveBeenCalled()
    expect(setItem).toHaveBeenCalledOnce()
    expect(setItem.mock.calls[0][0]).toBe('projectTrace.recentEvents.manual-project')
    expect(localStorage.getItem(PROJECTS_STORAGE_KEY)).toBe(registry)
    expect(readRecentProjectTraceEvents(project.id)).toHaveLength(1)
  })

  it('does not persist absolute project roots in active capture settings', () => {
    writeActiveProjectTraceCapture({
      projectId: 'project-1',
      projectName: 'Project',
      project: {
        projectId: 'project-1',
        projectName: 'Project',
        projectStorageDirName: '.Project__project-1',
        projectRootDir: 'C:\\Users\\alice\\Projects\\.Project__project-1'
      },
      traceId: 'trace-1'
    })

    const capture = readActiveProjectTraceCapture('project-1')
    expect(capture?.project.projectRootDir).toBeUndefined()
    expect(JSON.stringify(capture)).not.toContain('C:\\Users\\alice')
  })

  it('persists and clears the active realtime trace target', () => {
    writeActiveProjectTraceRealtime({
      projectId: 'project-1',
      projectName: 'Project',
      referenceTraceIds: ['trace-1', 'trace-2'],
      modelProfileId: 'gpt-5.5',
      modelReasoningEffort: 'high'
    })

    expect(readActiveProjectTraceRealtime('project-1')).toEqual({
      projectId: 'project-1',
      projectName: 'Project',
      referenceTraceIds: ['trace-1', 'trace-2'],
      referenceTraceId: 'trace-1',
      modelProfileId: 'gpt-5.5',
      modelReasoningEffort: 'high'
    })

    clearActiveProjectTraceRealtime('project-1')
    expect(readActiveProjectTraceRealtime('project-1')).toBeNull()
  })

  it('drops invalid realtime reasoning effort values', () => {
    localStorage.setItem(
      'projectTrace.activeRealtime.project-invalid-effort',
      JSON.stringify({
        projectId: 'project-invalid-effort',
        referenceTraceIds: ['trace-1'],
        modelProfileId: 'gpt-5.5',
        modelReasoningEffort: 'impossible'
      })
    )

    expect(readActiveProjectTraceRealtime('project-invalid-effort')).toEqual({
      projectId: 'project-invalid-effort',
      referenceTraceIds: ['trace-1'],
      referenceTraceId: 'trace-1',
      modelProfileId: 'gpt-5.5'
    })
  })

  it('keeps compatibility with legacy single realtime trace storage', () => {
    localStorage.setItem(
      'projectTrace.activeRealtime.project-legacy',
      JSON.stringify({
        projectId: 'project-legacy',
        projectName: 'Legacy Project',
        referenceTraceId: 'trace-legacy'
      })
    )

    expect(readActiveProjectTraceRealtime('project-legacy')).toEqual({
      projectId: 'project-legacy',
      projectName: 'Legacy Project',
      referenceTraceIds: ['trace-legacy'],
      referenceTraceId: 'trace-legacy'
    })
  })

  it('deduplicates and clears target trace reference state', () => {
    writeProjectTraceTargetReferenceState('project-1', ['trace-1', 'trace-1', '', 'trace-2'])

    expect(readProjectTraceTargetReferenceState('project-1')).toEqual({
      projectId: 'project-1',
      traceIds: ['trace-1', 'trace-2']
    })

    writeProjectTraceTargetReferenceState('project-1', [])
    expect(readProjectTraceTargetReferenceState('project-1')).toEqual({
      projectId: 'project-1',
      traceIds: []
    })
  })

  it('extracts movement pixel limits from realtime trace text', () => {
    expect(extractProjectTraceMovementLimitPx('该图片移动不能超过500px')).toBe(500)
    expect(extractProjectTraceMovementLimitPx('该图片移动不能超出500px')).toBe(500)
    expect(extractProjectTraceMovementLimitPx('如果移动超出 250 像素就提醒')).toBe(250)
    expect(
      extractProjectTraceMovementLimitPx(
        ['实时规则：', '- 指标：单次移动距离', '- 触发条件：> 500px', '- 反馈：提示撤回'].join('\n')
      )
    ).toBe(500)
    expect(
      extractProjectTraceMovementLimitPx('metric: movement_distance_px\ncondition: >= 640px')
    ).toBe(640)
    expect(extractProjectTraceMovementLimitPx('Move should not exceed 320 px.')).toBe(320)
    expect(extractProjectTraceMovementLimitPx('移动 1 个画布元素，最大位移 17027.1px')).toBeNull()
    expect(extractProjectTraceMovementLimitPx('只记录普通移动操作')).toBeNull()
  })

  it('does not start the next semantic model review after manual mode is chosen mid-request', async () => {
    const projectId = 'project-semantic-switch'
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([{ id: projectId, name: 'Legacy' }]))
    writeActiveProjectTraceRealtime({
      projectId,
      referenceTraceIds: ['semantic-switch'],
      modelProfileId: 'reference-only'
    })
    mockReadProjectTraceReferences.mockResolvedValue({
      references: [
        {
          id: 'semantic-switch',
          name: 'Legacy trace',
          sourceKind: 'manual',
          tags: [],
          eventCount: 1,
          updatedAt: new Date().toISOString(),
          contentPreview: 'Safe local summary',
          executableRules: {
            version: 1,
            generatedAt: new Date().toISOString(),
            rules: [],
            unsupportedNotes: [],
            semanticRules: ['first', 'second'].map((id) => ({
              id,
              requirement: 'Keep layout aligned',
              feedback: 'Review alignment',
              mode: 'model_review',
              source: 'trace_intent',
              confidence: 0.9
            }))
          }
        }
      ]
    })
    let resolveFirst!: (value: { content: string }) => void
    mockChat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    const advice = vi.fn()
    window.addEventListener(PROJECT_TRACE_REALTIME_ADVICE_EVENT, advice)
    try {
      emitProjectTraceRuntimeEvent({
        projectId,
        scope: 'canvas',
        action: 'canvas_items_changed',
        status: 'success',
        safeSummary: 'Moved one item.',
        canvasMutation: true
      })
      await vi.waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1))
      localStorage.setItem(
        PROJECTS_STORAGE_KEY,
        JSON.stringify([{ id: projectId, name: 'Legacy', analysisMode: 'manual' }])
      )
      resolveFirst({ content: JSON.stringify({ shouldFeedback: true, advice: 'Late old advice' }) })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(mockChat).toHaveBeenCalledTimes(1)
      expect(advice).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(PROJECT_TRACE_REALTIME_ADVICE_EVENT, advice)
    }
  })

  it('drops a late model review after the active realtime target is cleared', async () => {
    const projectId = 'project-cleared-late-review'
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([{ id: projectId, name: 'Legacy' }]))
    writeActiveProjectTraceRealtime({
      projectId,
      referenceTraceIds: ['cleared-late-trace'],
      modelProfileId: 'reference-only'
    })
    mockReadProjectTraceReferences.mockResolvedValue({
      references: [
        {
          id: 'cleared-late-trace',
          name: 'Cleared late review trace',
          sourceKind: 'manual',
          updatedAt: new Date().toISOString(),
          tags: [],
          eventCount: 1,
          contentPreview: 'Safe local summary',
          runtimePolicy: {
            allowRealtime: true,
            allowTargetReference: true,
            allowModelReview: true,
            allowTerminal: false
          },
          executableRules: {
            version: 1,
            generatedAt: new Date().toISOString(),
            rules: [],
            semanticRules: [
              {
                id: 'semantic-cleared-late',
                requirement: 'Keep layout aligned',
                feedback: 'Review alignment',
                mode: 'model_review',
                source: 'trace_intent',
                confidence: 0.9
              }
            ],
            unsupportedNotes: []
          }
        }
      ]
    })
    let resolveReview!: (value: { content: string }) => void
    mockChat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReview = resolve
        })
    )
    const advice = vi.fn()
    window.addEventListener(PROJECT_TRACE_REALTIME_ADVICE_EVENT, advice)
    try {
      emitProjectTraceRuntimeEvent({
        projectId,
        scope: 'canvas',
        action: 'canvas_items_changed',
        status: 'success',
        safeSummary: 'Moved one item.',
        canvasMutation: true
      })
      await vi.waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1))
      clearActiveProjectTraceRealtime(projectId)
      resolveReview({
        content: JSON.stringify({ shouldFeedback: true, advice: 'Late cleared advice' })
      })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(advice).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(PROJECT_TRACE_REALTIME_ADVICE_EVENT, advice)
    }
  })
  it('dispatches realtime feedback when a selected trace rule is hit for a legacy project', async () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([{ id: 'project-1', name: 'Legacy' }])
    )
    const adviceListener = vi.fn()
    window.addEventListener(PROJECT_TRACE_REALTIME_ADVICE_EVENT, adviceListener)
    mockReadProjectTraceDocument.mockResolvedValue({
      trace: {
        manifest: {
          version: 1,
          id: 'trace-1',
          name: 'Image movement',
          sourceKind: 'manual',
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
          tags: ['manual', 'reference-ready'],
          eventCount: 1,
          files: {
            markdown: 'document.md',
            executableRules: 'executable-rules.json',
            redactionReport: 'redaction-report.json'
          },
          redaction: {
            policyVersion: 1,
            containsSensitiveData: false,
            llmEnhanced: false
          }
        },
        markdown: '# Image movement',
        executableRules: {
          version: 1,
          generatedAt: '2026-05-03T00:00:00.000Z',
          rules: [
            {
              id: 'move-limit',
              type: 'canvas.move.distance',
              target: 'selected.image',
              condition: {
                operator: '>',
                value: 500,
                unit: 'px'
              },
              feedback: '移动超过 500px，请撤回或复核位置。',
              mode: 'software',
              source: 'trace_intent',
              confidence: 0.9
            }
          ],
          unsupportedNotes: []
        },
        redactionReport: {
          policyVersion: 1,
          generatedAt: '2026-05-03T00:00:00.000Z',
          containsSensitiveData: false,
          removedFields: [],
          replacementCount: 0,
          notes: []
        }
      }
    })

    mockReadProjectTraceReferences.mockResolvedValue({
      references: [
        {
          id: 'trace-1',
          name: 'Image movement',
          sourceKind: 'manual',
          updatedAt: '2026-05-03T00:00:00.000Z',
          tags: ['manual', 'reference-ready'],
          eventCount: 1,
          contentPreview: 'Image movement compact reference.',
          referencePack: {
            version: 1,
            generatedAt: '2026-05-03T00:00:00.000Z',
            traceId: 'trace-1',
            name: 'Image movement',
            sourceKind: 'manual',
            tags: ['manual', 'reference-ready'],
            trust: {
              level: 'local',
              origin: 'local_project',
              signatureVerified: false
            },
            runtimePolicy: {
              allowRealtime: true,
              allowTargetReference: true,
              allowModelReview: true,
              allowTerminal: false
            },
            budget: {
              maxChars: 1200,
              contentBriefChars: 33,
              softwareRuleCount: 1,
              semanticRuleCount: 0
            },
            contentBrief: 'Image movement compact reference.',
            softwareRules: [
              {
                id: 'move-limit',
                type: 'canvas.move.distance',
                target: 'selected.image',
                condition: {
                  operator: '>',
                  value: 500,
                  unit: 'px'
                },
                feedback: 'Move exceeded 500px; review position.',
                mode: 'software',
                source: 'trace_intent',
                confidence: 0.9
              }
            ],
            unsupportedNotes: [],
            safetyNotes: []
          }
        }
      ]
    })

    writeActiveProjectTraceRealtime({
      projectId: 'project-1',
      referenceTraceIds: ['trace-1']
    })
    emitProjectTraceRuntimeEvent({
      projectId: 'project-1',
      scope: 'canvas',
      action: 'canvas_items_changed',
      status: 'success',
      safeSummary: 'Moved 1 image.',
      movementDistancePx: 700
    })

    await vi.waitFor(() => expect(adviceListener).toHaveBeenCalledOnce())
    expect(mockReadProjectTraceDocument).not.toHaveBeenCalled()
    expect(adviceListener.mock.calls[0]?.[0].detail.advice.advice).toContain('500px')
    window.removeEventListener(PROJECT_TRACE_REALTIME_ADVICE_EVENT, adviceListener)
  })
})
