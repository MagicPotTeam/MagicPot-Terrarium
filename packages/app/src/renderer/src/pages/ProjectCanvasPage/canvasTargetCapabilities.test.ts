import { describe, expect, it } from 'vitest'

import * as canvasTargetCapabilitiesApi from './canvasTargetCapabilities'
import {
  CANVAS_TARGET_ACTION_PHASES,
  CANVAS_TARGET_CANVAS_ACTIONS,
  CANVAS_TARGET_CAPABILITY_CATALOG_VERSION,
  CANVAS_TARGET_OUTPUT_TARGETS,
  formatCanvasTargetCapabilitiesForPrompt,
  normalizeCanvasTargetCapabilityActions,
  type CanvasTargetCapabilityCatalog
} from './canvasTargetCapabilities'

function createSelectedCatalog(): CanvasTargetCapabilityCatalog {
  return {
    quickApps: [
      {
        key: 'retouch-helper',
        name: 'Retouch Helper',
        path: ['Image Tools'],
        mustFollow: 'Only process selected assets.',
        forbiddenActions: 'Do not invent extra source images.',
        inputs: [],
        autoInputs: []
      }
    ],
    canvasActions: []
  }
}

describe('canvasTargetCapabilities', () => {
  it('keeps the legacy runtime barrel exports available', () => {
    expect(Object.keys(canvasTargetCapabilitiesApi).sort()).toEqual([
      'CANVAS_TARGET_ACTION_PHASES',
      'CANVAS_TARGET_CANVAS_ACTIONS',
      'CANVAS_TARGET_CAPABILITY_CATALOG_VERSION',
      'CANVAS_TARGET_OUTPUT_TARGETS',
      'formatCanvasTargetCapabilitiesForPrompt',
      'loadCanvasTargetCapabilityCatalog',
      'normalizeCanvasTargetCapabilityActions',
      'normalizeCanvasTargetFinalPresentation'
    ])
    expect(CANVAS_TARGET_OUTPUT_TARGETS).toEqual(['auto', 'agent', 'canvas', 'both'])
    expect(CANVAS_TARGET_ACTION_PHASES).toEqual([
      'before_model_stages',
      'before_stage',
      'after_stage',
      'after_model_stages',
      'after_summary'
    ])
  })

  it('describes only the selected QuickApps and preserves user-authored constraints', () => {
    const prompt = formatCanvasTargetCapabilitiesForPrompt(createSelectedCatalog())

    expect(prompt).toContain('only QuickApps explicitly selected for this target are listed')
    expect(prompt).toContain('"key": "retouch-helper"')
    expect(prompt).toContain('"mustFollow": "Only process selected assets."')
    expect(prompt).toContain('"forbiddenActions": "Do not invent extra source images."')
  })

  it('rejects QuickApp actions whose key is not in the selected catalog', () => {
    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'quick_app',
          id: 'allowed',
          qAppKey: 'retouch-helper',
          phase: 'after_summary',
          outputTarget: 'canvas'
        },
        {
          type: 'quick_app',
          id: 'blocked',
          qAppKey: 'unselected-helper',
          phase: 'after_summary',
          outputTarget: 'canvas'
        }
      ],
      createSelectedCatalog()
    )

    expect(actions).toEqual([
      expect.objectContaining({
        id: 'allowed',
        qAppKey: 'retouch-helper'
      })
    ])
  })

  it('preserves exact QuickApp input references for runtime media binding', () => {
    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'quick_app',
          id: 'run-rembg',
          qAppKey: 'retouch-helper',
          phase: 'after_model_stages',
          outputTarget: 'canvas',
          inputAssignments: [
            {
              slot: '$.12.inputs.image',
              sourceStageId: 'stage-split-elements',
              artifactId: 'split-artifact',
              itemIds: ['img-split'],
              source: 'first_upstream_image'
            },
            {
              label: 'image',
              value: 'sourceStageId=stage-from-value'
            }
          ]
        }
      ],
      createSelectedCatalog()
    )

    expect(actions[0]).toMatchObject({
      type: 'quick_app',
      id: 'run-rembg',
      inputAssignments: [
        expect.objectContaining({
          slot: '$.12.inputs.image',
          sourceStageId: 'stage-split-elements',
          artifactId: 'split-artifact',
          itemIds: ['img-split'],
          source: 'first_upstream_image'
        }),
        expect.objectContaining({
          label: 'image',
          sourceStageId: 'stage-from-value'
        })
      ]
    })
  })

  it('does not preserve untrusted model-provided media source URLs', () => {
    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'canvas',
          id: 'unsafe-file-media',
          action: 'add_image',
          phase: 'after_summary',
          outputTarget: 'canvas',
          sourceUrl: 'file:///Users/demo/secret.png'
        },
        {
          type: 'canvas',
          id: 'safe-blob-media',
          action: 'add_image',
          phase: 'after_summary',
          outputTarget: 'canvas',
          sourceUrl: 'blob:generated-image'
        }
      ],
      {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    )

    expect(actions).toHaveLength(2)
    expect(actions[0]).toMatchObject({ id: 'unsafe-file-media' })
    expect(actions[0]).not.toHaveProperty('sourceUrl')
    expect(actions[1]).toMatchObject({
      id: 'safe-blob-media',
      sourceUrl: 'blob:generated-image'
    })
  })

  it('does not expose the legacy add_from_ai action to target plans', () => {
    expect(CANVAS_TARGET_CANVAS_ACTIONS.map((entry) => String(entry.action))).not.toContain(
      'add_from_ai'
    )

    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'canvas',
          id: 'legacy-ai-add',
          action: 'add_from_ai',
          phase: 'after_summary',
          outputTarget: 'canvas',
          images: ['blob://image-output']
        }
      ],
      {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    )

    expect(actions).toEqual([])
  })

  it('does not expose controlled or interactive host UI actions to target plans', () => {
    const exposedActions = CANVAS_TARGET_CANVAS_ACTIONS.map((entry) => String(entry.action))
    expect(exposedActions).not.toEqual(
      expect.arrayContaining([
        'save_canvas',
        'export_canvas',
        'copy_items_as_image',
        'download_items_as_image',
        'send_items_to_agent',
        'request_generation_from_items',
        'open_media_caption',
        'open_model3d_viewer',
        'open_file_editor',
        'open_texture_import',
        'send_items_to_dcc',
        'sync_figma'
      ])
    )

    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'canvas',
          id: 'blocked-export',
          action: 'export_canvas',
          phase: 'after_summary',
          outputTarget: 'canvas',
          explicitUserIntent: true
        }
      ],
      {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    )

    expect(actions).toEqual([])
  })

  it('exposes image region extraction as an explicit canvas tool', () => {
    expect(CANVAS_TARGET_CANVAS_ACTIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'extract_image_region',
          executionMode: 'direct',
          requiredFields: expect.arrayContaining(['source or itemIds'])
        })
      ])
    )

    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'canvas',
          id: 'extract-returned-media',
          action: 'extract_image_region',
          phase: 'after_stage',
          sourceStageId: 'stage-media-output',
          coordinateSpace: 'source_item_normalized',
          cropX: 0.1,
          cropY: 0.2,
          cropWidth: 0.3,
          cropHeight: 0.4,
          outputTarget: 'canvas'
        }
      ],
      {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    )

    expect(actions).toEqual([
      expect.objectContaining({
        action: 'extract_image_region',
        sourceStageId: 'stage-media-output',
        cropWidth: 0.3
      })
    ])
  })

  it('accepts standard tool-call shaped canvas actions without treating type=function as a blocker', () => {
    const actions = normalizeCanvasTargetCapabilityActions(
      [
        {
          type: 'function',
          function: {
            name: 'extract_image_region',
            arguments: JSON.stringify({
              id: 'extract-from-sheet',
              source: 'selected:image-sheet-1',
              coordinateSpace: 'sourceImagePixels',
              cropX: 10,
              cropY: 20,
              cropWidth: 300,
              cropHeight: 200,
              outputTarget: 'canvas'
            })
          }
        }
      ],
      {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    )

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'canvas',
        id: 'extract-from-sheet',
        action: 'extract_image_region',
        itemIds: ['image-sheet-1'],
        coordinateSpace: 'source_image_pixels',
        cropX: 10,
        cropY: 20,
        cropWidth: 300,
        cropHeight: 200
      })
    ])
  })

  it('uses a compact versioned canvas tool catalog in the prompt', () => {
    const prompt = formatCanvasTargetCapabilitiesForPrompt({
      quickApps: [],
      canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
    })

    expect(prompt).toContain(CANVAS_TARGET_CAPABILITY_CATALOG_VERSION)
    expect(prompt).toContain('magicpot://canvas-target/tools/extract_image_region')
    expect(prompt).toContain('canvasActionFieldGroups')
    expect(prompt).toContain('The runtime executes capabilityActions in the exact order')
    expect(prompt).toContain('Each capabilityAction is a direct command')
    expect(prompt).toContain('Available canvas operation groups')
    expect(prompt).toContain('set_canvas_tool with extract-select only switches the UI tool')
  })
})
