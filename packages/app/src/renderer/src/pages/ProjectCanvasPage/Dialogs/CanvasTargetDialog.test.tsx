import React, { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { describe, expect, it, vi } from 'vitest'

import type { CanvasTargetReport } from '@shared/canvasTarget'
import type { TargetHistoryEntry } from '@shared/targetHistory'
import type { TargetScheme } from '@shared/targetScheme'
import CanvasTargetDialog from './CanvasTargetDialog'
import {
  createCanvasTargetQuickAppDraft,
  createCanvasTargetStageDraft,
  type CanvasTargetQuickAppDraft
} from '../canvasTargetTypes'

function buildSchemes(): TargetScheme[] {
  return [
    {
      id: 'scheme-1',
      name: 'Scheme 1',
      description: 'Unique scheme description for tooltip testing.',
      enabled: true,
      files: [
        {
          id: 'rule-1',
          name: 'rules.md',
          language: 'markdown',
          content: 'Inspect the selected layout.'
        }
      ],
      createdAt: '2026-04-08T10:00:00.000Z',
      updatedAt: '2026-04-08T10:00:00.000Z'
    }
  ]
}

function buildReport(): CanvasTargetReport {
  return {
    id: 'report-1',
    contextPackId: 'context-1',
    generatedAt: '2026-04-08T10:00:00.000Z',
    modelId: 'control-1',
    summary: 'Completed.',
    overview: 'Overview',
    findings: [],
    stages: [
      {
        id: 'stage-1',
        kind: 'model-check',
        label: 'Vision Stage',
        status: 'success',
        modelId: 'vision-1',
        summary: 'Vision output',
        overview: '',
        findings: []
      },
      {
        id: 'stage-2',
        kind: 'control-summary',
        label: 'Fallback Stage',
        status: 'fallback',
        summary: 'Fallback output',
        overview: '',
        findings: []
      }
    ]
  }
}

function buildHistoryTargets(): TargetHistoryEntry[] {
  return [
    {
      id: 'history-1',
      name: 'Visual audit',
      schemeId: 'scheme-1',
      controlProfileId: 'control-1',
      userIntent: 'Inspect hierarchy and CTA contrast',
      stageProfiles: [
        {
          profileId: 'vision-1',
          mustFollow: 'Preserve raw output first.',
          forbiddenActions: 'Do not invent missing text.',
          allowedInputs: ['source_assets', 'selection_snapshot'],
          outputFormats: ['json']
        }
      ],
      createdAt: '2026-04-08T10:00:00.000Z',
      updatedAt: '2026-04-08T10:00:00.000Z',
      lastRunAt: '2026-04-09T10:00:00.000Z'
    }
  ]
}

function renderDialog(overrides?: Partial<React.ComponentProps<typeof CanvasTargetDialog>>) {
  return render(
    <ThemeProvider theme={createTheme()}>
      <CanvasTargetDialog
        open
        isChineseUi={false}
        loading={false}
        error={null}
        schemes={buildSchemes()}
        historyTargets={buildHistoryTargets()}
        selectedHistoryTargetId={null}
        evidenceMode="selection_region"
        selectedSchemeId="scheme-1"
        targetItemCount={1}
        targetName=""
        userIntent="Inspect this region"
        controlProfileId="control-1"
        stageProfiles={[
          createCanvasTargetStageDraft({
            profileId: 'vision-1',
            mustFollow: 'Only extract visible text.',
            forbiddenActions: 'Do not summarize.',
            outputFormat: 'json'
          })
        ]}
        profileOptions={[
          { id: 'control-1', label: 'Control Model' },
          { id: 'vision-1', label: 'Vision Model' }
        ]}
        report={buildReport()}
        onTargetNameChange={vi.fn()}
        onSelectedSchemeIdChange={vi.fn()}
        onUserIntentChange={vi.fn()}
        onControlProfileIdChange={vi.fn()}
        onStageProfilesChange={vi.fn()}
        onApplyHistoryTarget={vi.fn()}
        onDeleteHistoryTarget={vi.fn()}
        onRenameHistoryTarget={vi.fn()}
        onEvidenceModeChange={vi.fn()}
        onRun={vi.fn()}
        onClose={vi.fn()}
        {...overrides}
      />
    </ThemeProvider>
  )
}

function renderStatefulQuickAppDialog(
  onQuickAppsChangeSpy?: (value: CanvasTargetQuickAppDraft[]) => void
) {
  function StatefulDialog() {
    const [quickApps, setQuickApps] = useState([
      createCanvasTargetQuickAppDraft({ qAppKey: 'retouch-helper' })
    ])

    const handleQuickAppsChange = (value: CanvasTargetQuickAppDraft[]) => {
      onQuickAppsChangeSpy?.(value)
      setQuickApps(value)
    }

    return (
      <CanvasTargetDialog
        open
        isChineseUi={false}
        loading={false}
        error={null}
        schemes={buildSchemes()}
        historyTargets={buildHistoryTargets()}
        selectedHistoryTargetId={null}
        evidenceMode="selection_region"
        selectedSchemeId="scheme-1"
        targetItemCount={1}
        targetName=""
        userIntent="Inspect this region"
        controlProfileId="control-1"
        stageProfiles={[
          createCanvasTargetStageDraft({
            profileId: 'vision-1',
            mustFollow: 'Only extract visible text.',
            forbiddenActions: 'Do not summarize.',
            outputFormat: 'json'
          })
        ]}
        quickApps={quickApps}
        profileOptions={[
          { id: 'control-1', label: 'Control Model' },
          { id: 'vision-1', label: 'Vision Model' }
        ]}
        quickAppOptions={[
          {
            key: 'retouch-helper',
            name: 'Retouch Helper',
            path: ['Image Tools'],
            inputs: [],
            autoInputs: []
          }
        ]}
        report={null}
        onTargetNameChange={vi.fn()}
        onSelectedSchemeIdChange={vi.fn()}
        onUserIntentChange={vi.fn()}
        onControlProfileIdChange={vi.fn()}
        onStageProfilesChange={vi.fn()}
        onQuickAppsChange={handleQuickAppsChange}
        onApplyHistoryTarget={vi.fn()}
        onDeleteHistoryTarget={vi.fn()}
        onRenameHistoryTarget={vi.fn()}
        onEvidenceModeChange={vi.fn()}
        onRun={vi.fn()}
        onClose={vi.fn()}
      />
    )
  }

  return render(
    <ThemeProvider theme={createTheme()}>
      <StatefulDialog />
    </ThemeProvider>
  )
}

describe('CanvasTargetDialog', () => {
  it('stays renderable when runtime props still carry missing arrays', () => {
    expect(() =>
      renderDialog({
        schemes: undefined as unknown as TargetScheme[],
        stageProfiles: undefined as unknown as React.ComponentProps<
          typeof CanvasTargetDialog
        >['stageProfiles'],
        profileOptions: undefined as unknown as React.ComponentProps<
          typeof CanvasTargetDialog
        >['profileOptions'],
        report: {
          ...buildReport(),
          findings: undefined as unknown as CanvasTargetReport['findings'],
          stages: undefined as unknown as CanvasTargetReport['stages']
        }
      })
    ).not.toThrow()

    expect(
      screen.getByText(
        'No enabled target scheme is available yet. Create one in the custom target workshop first.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Must follow 1')).not.toBeInTheDocument()
  })

  it('shows and changes the control model reasoning effort when supported', async () => {
    const onControlReasoningEffortChange = vi.fn()
    renderDialog({
      controlReasoningEffort: 'high',
      availableControlReasoningEfforts: ['low', 'high'],
      onControlReasoningEffortChange
    })

    const selector = screen.getByLabelText('Reasoning effort')
    expect(selector).toBeInTheDocument()
    await userEvent.click(selector)
    await userEvent.click(screen.getByRole('option', { name: 'Low' }))
    expect(onControlReasoningEffortChange).toHaveBeenCalledWith('low')
  })

  it('hides the reasoning effort selector for models without reasoning support', () => {
    renderDialog({ availableControlReasoningEfforts: [] })
    expect(screen.queryByLabelText('Reasoning effort')).not.toBeInTheDocument()
  })

  it('starts without auxiliary models until the user explicitly adds one', async () => {
    const user = userEvent.setup()
    const onStageProfilesChange = vi.fn()

    renderDialog({
      report: null,
      stageProfiles: [],
      onStageProfilesChange
    })

    expect(screen.queryByLabelText('Auxiliary model 1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start target' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Add auxiliary model' }))

    expect(onStageProfilesChange).toHaveBeenCalledWith([
      expect.objectContaining({
        profileId: 'control-1'
      })
    ])
  })

  it('shows the source model or MagicPot built-in capability for each stage', () => {
    renderDialog()

    expect(screen.getByText('Source: Vision Model')).toBeInTheDocument()
    expect(screen.getByText('Source: MagicPot built-in capability')).toBeInTheDocument()
  })

  it('moves scheme and control hints into hover tooltips', async () => {
    const user = userEvent.setup()
    renderDialog({ report: null })

    expect(
      screen.queryByText('Unique scheme description for tooltip testing.')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('A multimodal model is recommended for the control model.')
    ).not.toBeInTheDocument()

    await user.hover(screen.getByLabelText('Show target scheme details'))
    expect(await screen.findByText('Unique scheme description for tooltip testing.')).toBeVisible()

    await user.unhover(screen.getByLabelText('Show target scheme details'))
    await user.hover(screen.getByRole('button', { name: 'Show control model guidance' }))
    expect(
      await screen.findByText('A multimodal model is recommended for the control model.')
    ).toBeVisible()
  })

  it('lets users choose the target evidence mode for execution accuracy', async () => {
    const user = userEvent.setup()
    const onEvidenceModeChange = vi.fn()
    renderDialog({
      report: null,
      onEvidenceModeChange
    })

    expect(screen.getByText('Enhance execution accuracy')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Selection evidence' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(
      screen.getByText(
        'Sends the target selection crop plus structured data; outside content is not sent as a visual attachment.'
      )
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Full source assets' }))

    expect(onEvidenceModeChange).toHaveBeenCalledWith('selected_sources')
  })

  it('opens target history and applies a saved target draft', async () => {
    const user = userEvent.setup()
    const onApplyHistoryTarget = vi.fn()

    renderDialog({
      report: null,
      onApplyHistoryTarget
    })

    await user.click(screen.getByRole('button', { name: 'Target history' }))

    expect(await screen.findByDisplayValue('Visual audit')).toBeInTheDocument()
    expect(screen.getByText(/Last run:/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Fill' }))

    expect(onApplyHistoryTarget).toHaveBeenCalledWith('history-1')
  })

  it('deletes a saved target from target history', async () => {
    const user = userEvent.setup()
    const onDeleteHistoryTarget = vi.fn()

    renderDialog({
      report: null,
      onDeleteHistoryTarget
    })

    await user.click(screen.getByRole('button', { name: 'Target history' }))
    await user.click(screen.getByRole('button', { name: 'Delete target history Visual audit' }))

    expect(onDeleteHistoryTarget).toHaveBeenCalledWith('history-1')
  })

  it('renders a structured contract for each auxiliary model', () => {
    renderDialog({
      report: null,
      stageProfiles: [
        createCanvasTargetStageDraft({
          profileId: 'vision-1',
          mustFollow: 'Only extract visible text.',
          forbiddenActions: 'Do not summarize.',
          outputFormat: 'json'
        }),
        createCanvasTargetStageDraft({
          profileId: 'vision-1',
          mustFollow: 'Summarize hierarchy after OCR.',
          forbiddenActions: 'Do not re-read the image.',
          outputFormat: 'markdown'
        })
      ]
    })

    expect(screen.getByLabelText('Must follow 1')).toHaveValue('Only extract visible text.')
    expect(screen.getByLabelText('Forbidden actions 1')).toHaveValue('Do not summarize.')
    expect(screen.queryByLabelText('Auxiliary responsibility 1')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Additional output formats 1')).toHaveTextContent('JSON')
    expect(screen.getByLabelText('Must follow 2')).toHaveValue('Summarize hierarchy after OCR.')
    expect(screen.getByLabelText('Forbidden actions 2')).toHaveValue('Do not re-read the image.')
    expect(screen.getByLabelText('Additional output formats 2')).toHaveTextContent('Markdown')
  })

  it('lets users explicitly add an auxiliary QuickApp without software role presets', async () => {
    const user = userEvent.setup()
    const onQuickAppsChange = vi.fn()

    renderDialog({
      report: null,
      quickApps: [],
      quickAppOptions: [
        {
          key: 'retouch-helper',
          name: 'Retouch Helper',
          path: ['Image Tools'],
          inputs: [],
          autoInputs: []
        }
      ],
      onQuickAppsChange
    })

    expect(screen.getByText('Auxiliary QuickApps')).toBeInTheDocument()
    expect(
      screen.getByText(
        'The control model can only call QuickApps selected here. If none are selected, this target run cannot use QuickApps. Their purpose is decided by your must-follow/forbidden rules and the control model.'
      )
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add auxiliary QuickApp' }))

    expect(onQuickAppsChange).toHaveBeenCalledWith([
      {
        qAppKey: 'retouch-helper',
        mustFollow: '',
        forbiddenActions: ''
      }
    ])
  })

  it('lets users type explicit rules for auxiliary QuickApps', async () => {
    const user = userEvent.setup()
    renderStatefulQuickAppDialog()

    const quickAppMustFollowInput = screen.getByLabelText('QuickApp must follow 1')
    const quickAppForbiddenActionsInput = screen.getByLabelText('QuickApp forbidden actions 1')

    for (const input of [quickAppMustFollowInput, quickAppForbiddenActionsInput]) {
      const formControl = input.closest('.MuiFormControl-root')

      expect(input.tagName).toBe('TEXTAREA')
      expect(input).toHaveAttribute('data-ime-stable-textarea', 'true')
      expect(formControl?.querySelectorAll('textarea')).toHaveLength(1)
    }

    await user.type(quickAppMustFollowInput, 'A')
    await user.type(quickAppForbiddenActionsInput, 'B')

    expect(quickAppMustFollowInput).toHaveValue('A')
    expect(quickAppForbiddenActionsInput).toHaveValue('B')
  })

  it('does not rewrite auxiliary QuickApp rules while IME composition is active', () => {
    const onQuickAppsChange = vi.fn()
    const composedText = ' \u4f60'
    renderStatefulQuickAppDialog(onQuickAppsChange)

    const quickAppMustFollowInput = screen.getByLabelText('QuickApp must follow 1')

    fireEvent.compositionStart(quickAppMustFollowInput)
    fireEvent.change(quickAppMustFollowInput, {
      target: { value: ' ni' },
      nativeEvent: { isComposing: true }
    })
    fireEvent.change(quickAppMustFollowInput, {
      target: { value: composedText },
      nativeEvent: { isComposing: true }
    })

    expect(quickAppMustFollowInput).toHaveValue(composedText)
    expect(onQuickAppsChange).not.toHaveBeenCalled()

    fireEvent.compositionEnd(quickAppMustFollowInput, { data: '\u4f60' })

    expect(onQuickAppsChange).toHaveBeenCalledTimes(1)
    expect(onQuickAppsChange).toHaveBeenLastCalledWith([
      {
        qAppKey: 'retouch-helper',
        mustFollow: composedText,
        forbiddenActions: ''
      }
    ])
    expect(quickAppMustFollowInput).toHaveValue(composedText)
  })

  it('keeps locally configured LLM profiles selectable for control and auxiliary stages', () => {
    renderDialog({
      report: null,
      controlProfileId: 'local-control',
      stageProfiles: [
        createCanvasTargetStageDraft({
          profileId: 'local-vision',
          outputFormat: 'markdown'
        })
      ],
      profileOptions: [
        {
          id: 'local-control',
          label: 'Local Control Vision',
          sourceType: 'local',
          isVisionModel: true
        },
        {
          id: 'local-vision',
          label: 'Local Stage Vision',
          sourceType: 'local',
          isVisionModel: true
        },
        { id: 'cloud-text', label: 'Cloud Text', sourceType: 'api' }
      ]
    })

    expect(screen.getByText('Local Control Vision')).toBeInTheDocument()
    expect(screen.getByText('Local Stage Vision')).toBeInTheDocument()
    expect(screen.getAllByText('Local').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps user-selected local model backends available for auxiliary stages only', () => {
    renderDialog({
      report: null,
      stageProfiles: [
        createCanvasTargetStageDraft({
          profileId: 'agent-local:vision-1',
          allowedInputs: ['scheme_files', 'selection_snapshot'],
          outputFormats: ['image']
        })
      ],
      profileOptions: [
        { id: 'control-1', label: 'Control Model', sourceType: 'api', executionBackend: 'llm' },
        {
          id: 'agent-local:vision-1',
          label: 'Local ONNX Vision',
          sourceType: 'local',
          executionBackend: 'local_model',
          isVisionModel: true
        }
      ],
      controlProfileOptions: [
        { id: 'control-1', label: 'Control Model', sourceType: 'api', executionBackend: 'llm' }
      ],
      controlProfileId: 'control-1'
    })

    expect(
      screen.getByText(
        'This local model backend is available as an explicitly selected auxiliary execution unit. The current built-in implementation uses duplicateCheck.runVisualAnalysis, and it is not a control planner.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Local ONNX Vision')).toBeInTheDocument()
    expect(screen.getByLabelText('Additional output formats 1')).toHaveTextContent('None')
    expect(screen.getByRole('checkbox', { name: 'Scheme files' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Selection snapshot' })).toBeChecked()
  })

  it('renders multiple selected output formats for an auxiliary model', () => {
    renderDialog({
      report: null,
      stageProfiles: [
        createCanvasTargetStageDraft({
          profileId: 'vision-1',
          outputFormats: ['json', 'table', 'plain_text']
        })
      ],
      profileOptions: [
        { id: 'control-1', label: 'Control Model' },
        { id: 'vision-1', label: 'gpt-image-2-vip', modelUse: 'multimodal' }
      ]
    })

    expect(screen.getByLabelText('Additional output formats 1')).toHaveTextContent('JSON')
    expect(screen.getByLabelText('Additional output formats 1')).toHaveTextContent('Table')
    expect(screen.getByLabelText('Additional output formats 1')).toHaveTextContent('Plain text')
  })

  it('renders selected output formats in the current UI language', () => {
    renderDialog({
      report: null,
      isChineseUi: true,
      stageProfiles: [
        createCanvasTargetStageDraft({
          profileId: 'vision-1',
          outputFormats: ['json', 'table', 'plain_text']
        })
      ],
      profileOptions: [
        { id: 'control-1', label: 'Control Model' },
        { id: 'vision-1', label: 'gpt-image-2-vip', modelUse: 'multimodal' }
      ]
    })

    expect(screen.getByLabelText('增加输出格式 1')).toHaveTextContent('JSON')
    expect(screen.getByLabelText('增加输出格式 1')).toHaveTextContent('表格')
    expect(screen.getByLabelText('增加输出格式 1')).toHaveTextContent('纯文本')
  })

  it('asks for confirmation before deleting an auxiliary model', async () => {
    const user = userEvent.setup()
    const onStageProfilesChange = vi.fn()

    renderDialog({
      report: null,
      stageProfiles: [
        createCanvasTargetStageDraft({
          profileId: 'vision-1',
          mustFollow: 'Only extract visible text.',
          forbiddenActions: 'Do not summarize.',
          outputFormat: 'json'
        }),
        createCanvasTargetStageDraft({
          profileId: 'vision-1',
          mustFollow: 'Summarize hierarchy after OCR.',
          forbiddenActions: 'Do not re-read the image.',
          outputFormat: 'markdown'
        })
      ],
      onStageProfilesChange
    })

    await user.click(screen.getAllByRole('button', { name: 'Delete auxiliary model 2' })[0])

    expect(onStageProfilesChange).not.toHaveBeenCalled()
    expect(screen.getByText('Confirm auxiliary model deletion')).toBeInTheDocument()
    expect(screen.getByText('Auxiliary model 2 (Vision Model)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(onStageProfilesChange).toHaveBeenCalledWith([
      expect.objectContaining({
        profileId: 'vision-1',
        mustFollow: 'Only extract visible text.',
        forbiddenActions: 'Do not summarize.',
        outputFormat: 'json',
        outputFormats: ['json']
      })
    ])
  })

  it('allows deleting the last auxiliary model', async () => {
    const user = userEvent.setup()
    const onStageProfilesChange = vi.fn()

    renderDialog({
      report: null,
      stageProfiles: [
        createCanvasTargetStageDraft({
          profileId: 'vision-1'
        })
      ],
      onStageProfilesChange
    })

    await user.click(screen.getByRole('button', { name: 'Delete auxiliary model 1' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(onStageProfilesChange).toHaveBeenCalledWith([])
  })

  it('drops unsupported output formats when the auxiliary model changes', async () => {
    const user = userEvent.setup()
    const onStageProfilesChange = vi.fn()

    renderDialog({
      report: null,
      stageProfiles: [
        createCanvasTargetStageDraft({
          profileId: 'vision-1',
          outputFormats: ['json', 'image']
        })
      ],
      profileOptions: [
        { id: 'control-1', label: 'Control Model' },
        { id: 'vision-1', label: 'gpt-image-2-vip', modelUse: 'multimodal' },
        { id: 'text-1', label: 'gpt-4.1', modelUse: 'chat' }
      ],
      onStageProfilesChange
    })

    await user.click(screen.getByLabelText('Auxiliary model 1'))
    await user.click(await screen.findByRole('option', { name: /gpt-4\.1/i }))

    expect(onStageProfilesChange).toHaveBeenCalledWith([
      expect.objectContaining({
        profileId: 'text-1',
        outputFormats: ['json', 'image'],
        outputFormat: 'json'
      })
    ])
  })
})
