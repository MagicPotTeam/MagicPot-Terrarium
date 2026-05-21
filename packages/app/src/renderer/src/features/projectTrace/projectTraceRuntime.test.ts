import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  emitProjectTraceRuntimeEvent,
  extractProjectTraceMovementLimitPx,
  readActiveProjectTraceCapture,
  readActiveProjectTraceRealtime,
  readProjectTraceTargetReferenceState,
  readRecentProjectTraceEvents,
  writeActiveProjectTraceCapture,
  writeActiveProjectTraceRealtime,
  writeProjectTraceTargetReferenceState
} from './projectTraceRuntime'

describe('projectTraceRuntime', () => {
  beforeEach(() => {
    localStorage.clear()
    mockReadProjectTraceDocument.mockReset()
    mockReadProjectTraceReferences.mockReset()
    mockChat.mockReset()
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

    expect(event.label).toBe('[redacted-email]')
    expect(event.safeSummary).toContain('Bearer [redacted-token]')
    expect(event.safeSummary).toContain('token=[redacted]')
    expect(event.safeSummary).toContain('[redacted-local-path]')
    expect(event.safeSummary).toContain('[redacted-local-media]')
    expect(event.safeSummary).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(readRecentProjectTraceEvents('project-1')[0].safeSummary).toBe(event.safeSummary)
    expect(listener).toHaveBeenCalledOnce()

    window.removeEventListener(PROJECT_TRACE_RUNTIME_EVENT, listener)
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
      modelProfileId: 'gpt-5.5'
    })

    expect(readActiveProjectTraceRealtime('project-1')).toEqual({
      projectId: 'project-1',
      projectName: 'Project',
      referenceTraceIds: ['trace-1', 'trace-2'],
      referenceTraceId: 'trace-1',
      modelProfileId: 'gpt-5.5'
    })

    clearActiveProjectTraceRealtime('project-1')
    expect(readActiveProjectTraceRealtime('project-1')).toBeNull()
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

  it('dispatches realtime feedback when a selected trace rule is hit', async () => {
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
