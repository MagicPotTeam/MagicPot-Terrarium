import { describe, expect, it } from 'vitest'

import type { TargetHistoryEntry } from '@shared/targetHistory'
import type { CanvasTargetStageDraft } from './canvasTargetTypes'
import {
  buildCanvasTargetHistoryTargetRecord,
  materializeCanvasTargetStageProfilesForOptions,
  resolveCanvasTargetHistoryTargetDraft,
  serializeCanvasTargetStageProfilesForHistory,
  upsertCanvasTargetHistoryTargets
} from './canvasTargetHistoryTargets'

describe('canvasTargetHistoryTargets', () => {
  it('keeps stage profiles compatible with the currently available model options', () => {
    expect(
      materializeCanvasTargetStageProfilesForOptions(
        [
          {
            profileId: 'missing-model',
            outputFormats: ['json', 'video']
          }
        ],
        [{ id: 'gpt-4.1', modelUse: 'chat', executionBackend: 'llm' }],
        'gpt-4.1'
      )
    ).toEqual([
      expect.objectContaining({
        profileId: 'gpt-4.1',
        outputFormats: ['json']
      })
    ])
  })

  it('does not materialize an auxiliary model when none was selected', () => {
    expect(
      materializeCanvasTargetStageProfilesForOptions(
        [],
        [{ id: 'gpt-4.1', modelUse: 'chat', executionBackend: 'llm' }],
        'gpt-4.1'
      )
    ).toEqual([])
  })

  it('restores a saved history target into the current dialog draft', () => {
    const target: TargetHistoryEntry = {
      id: 'history-1',
      name: 'Visual audit',
      schemeId: 'scheme-1',
      controlProfileId: 'control-1',
      userIntent: 'Inspect title and CTA hierarchy',
      stageProfiles: [
        {
          profileId: 'gpt-image-2-vip',
          mustFollow: 'Preserve the raw model answer first.',
          forbiddenActions: 'Do not rewrite the scene.',
          allowedInputs: ['source_assets', 'selection_snapshot'],
          outputFormats: ['json', 'image']
        }
      ],
      createdAt: '2026-04-12T00:00:00.000Z',
      updatedAt: '2026-04-12T00:00:00.000Z',
      lastRunAt: '2026-04-12T00:00:00.000Z'
    }

    expect(
      resolveCanvasTargetHistoryTargetDraft({
        target,
        schemes: [{ id: 'scheme-1' }],
        controlOptions: [{ id: 'control-1', executionBackend: 'llm' }],
        stageOptions: [{ id: 'gpt-image-2-vip', modelUse: 'multimodal', executionBackend: 'llm' }],
        fallbackControlProfileId: 'control-1'
      })
    ).toEqual({
      targetName: 'Visual audit',
      selectedSchemeId: 'scheme-1',
      controlProfileId: 'control-1',
      evidenceMode: 'selection_region',
      userIntent: 'Inspect title and CTA hierarchy',
      quickApps: [],
      stageProfiles: [
        expect.objectContaining({
          profileId: 'gpt-image-2-vip',
          mustFollow: 'Preserve the raw model answer first.',
          forbiddenActions: 'Do not rewrite the scene.',
          outputFormats: ['json', 'image']
        })
      ]
    })
  })

  it('persists and restores explicitly selected QuickApps without assigning software roles', () => {
    const target: TargetHistoryEntry = {
      id: 'history-quick-app',
      name: 'Retouch target',
      schemeId: 'scheme-1',
      controlProfileId: 'control-1',
      userIntent: 'Run the selected retouch helper only when useful.',
      stageProfiles: [],
      quickApps: [
        {
          qAppKey: 'retouch-helper',
          mustFollow: 'Only process the selected source image.',
          forbiddenActions: 'Do not use unselected assets.'
        },
        {
          qAppKey: 'missing-helper',
          mustFollow: '',
          forbiddenActions: ''
        }
      ],
      createdAt: '2026-04-12T00:00:00.000Z',
      updatedAt: '2026-04-12T00:00:00.000Z',
      lastRunAt: '2026-04-12T00:00:00.000Z'
    }

    const restored = resolveCanvasTargetHistoryTargetDraft({
      target,
      schemes: [{ id: 'scheme-1' }],
      controlOptions: [{ id: 'control-1', executionBackend: 'llm' }],
      stageOptions: [{ id: 'control-1', executionBackend: 'llm' }],
      quickAppOptions: [{ key: 'retouch-helper' }],
      fallbackControlProfileId: 'control-1'
    })

    expect(restored.quickApps).toEqual([
      {
        qAppKey: 'retouch-helper',
        mustFollow: 'Only process the selected source image.',
        forbiddenActions: 'Do not use unselected assets.'
      }
    ])
    expect(restored.stageProfiles).toEqual([])

    const nextRecord = buildCanvasTargetHistoryTargetRecord({
      historyTargets: [],
      targetName: 'Retouch target',
      schemeId: 'scheme-1',
      controlProfileId: 'control-1',
      userIntent: 'Run selected helper.',
      stageProfiles: [],
      quickApps: restored.quickApps,
      untitledName: 'Untitled target',
      now: '2026-04-12T10:00:00.000Z'
    })

    expect(nextRecord.quickApps).toEqual(restored.quickApps)
  })

  it('builds and upserts history target records by selected id or matching name', () => {
    const existing: TargetHistoryEntry = {
      id: 'history-1',
      name: 'Visual audit',
      schemeId: 'scheme-1',
      controlProfileId: 'control-1',
      userIntent: 'Old intent',
      stageProfiles: [],
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
      lastRunAt: '2026-04-10T00:00:00.000Z'
    }
    const nextStageProfiles = [
      {
        profileId: 'gpt-4.1',
        mustFollow: '',
        forbiddenActions: '',
        allowedInputs: ['source_assets'],
        outputFormats: ['json']
      }
    ] as CanvasTargetStageDraft[]

    const nextRecord = buildCanvasTargetHistoryTargetRecord({
      historyTargets: [existing],
      targetName: 'Visual audit',
      schemeId: 'scheme-2',
      schemeName: 'Scheme 2',
      controlProfileId: 'control-2',
      evidenceMode: 'selection_region',
      userIntent: 'New intent',
      stageProfiles: nextStageProfiles,
      untitledName: 'Untitled target',
      now: '2026-04-12T10:00:00.000Z'
    })

    expect(nextRecord).toEqual({
      id: 'history-1',
      name: 'Visual audit',
      schemeId: 'scheme-2',
      controlProfileId: 'control-2',
      evidenceMode: 'selection_region',
      userIntent: 'New intent',
      stageProfiles: serializeCanvasTargetStageProfilesForHistory(nextStageProfiles),
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-12T10:00:00.000Z',
      lastRunAt: '2026-04-12T10:00:00.000Z'
    })

    expect(upsertCanvasTargetHistoryTargets([existing], nextRecord)).toEqual([nextRecord])
  })
})
