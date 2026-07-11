import {
  CANVAS_TARGET_CANVAS_ACTIONS,
  CANVAS_TARGET_CAPABILITY_CATALOG_VERSION
} from './canvasTargetCanvasActionCatalog'
import type {
  CanvasTargetCanvasActionCapability,
  CanvasTargetCapabilityCatalog,
  CanvasTargetQAppCapability
} from './canvasTargetCapabilityTypes'

const truncateText = (value: string | undefined, maxLength = 120): string | undefined => {
  const normalized = value?.trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function summarizeCanvasActionsForPrompt(actions: CanvasTargetCanvasActionCapability[]) {
  return actions.map((entry) => ({
    action: entry.action,
    mode: entry.executionMode,
    surface: entry.surface,
    required: entry.requiredFields,
    destructive: entry.destructive || undefined,
    schemaRef: `magicpot://canvas-target/tools/${entry.action}`,
    description: truncateText(entry.description, 140)
  }))
}

function summarizeQuickAppsForPrompt(quickApps: CanvasTargetQAppCapability[]) {
  return quickApps.map((qApp) => ({
    key: qApp.key,
    name: qApp.name,
    path: qApp.path.join(' / '),
    category: qApp.category,
    mustFollow: qApp.mustFollow || undefined,
    forbiddenActions: qApp.forbiddenActions || undefined,
    inputs: qApp.inputs.slice(0, 16).map((input) => ({
      label: truncateText(input.label, 80),
      component: input.component,
      slot: input.slot
    })),
    autoInputs: qApp.autoInputs.map((input) => ({
      label: truncateText(input.label, 80),
      component: input.component
    })),
    outputNodeIds: qApp.outputNodeIds,
    detailUnavailable: qApp.detailUnavailable || undefined
  }))
}

export function formatCanvasTargetCapabilitiesForPrompt(
  catalog: CanvasTargetCapabilityCatalog | undefined
): string {
  if (!catalog || (catalog.quickApps.length === 0 && catalog.canvasActions.length === 0)) {
    return 'Runtime capability catalog: no QuickApp or canvas actions are currently available.'
  }

  const quickAppsForPrompt = summarizeQuickAppsForPrompt(catalog.quickApps)
  const canvasActionsForPrompt = summarizeCanvasActionsForPrompt(catalog.canvasActions)

  return [
    'Runtime capability catalog:',
    'You may request capabilityActions when they are genuinely useful for the user intent.',
    'QuickApp actions run ComfyUI workflows; only QuickApps explicitly selected for this target are listed. If quickApps is empty, do not request quick_app capabilityActions.',
    'QuickApp mustFollow and forbiddenActions are user-authored constraints. Do not infer fixed software-defined purposes beyond the user rules, the visible workflow inputs, and the main user intent.',
    'Canvas actions are limited to the listed registry entries; do not invent internal UI operations.',
    'Direct canvas actions can be executed by the target runtime. Host UI commands and interactive-only tools are outside this target capability catalog.',
    'Capability actions must not override selected auxiliary models or user-authored constraints.',
    'The runtime executes capabilityActions in the exact order you return for each phase; it does not reorder them by dependency or reinterpret your semantic intent.',
    'Each capabilityAction is a direct command. The runtime only normalizes aliases, validates required fields, resolves referenced media, then calls the matching executor.',
    'Available execution families: model stages for understanding/generation/reporting, quick_app for selected ComfyUI workflows, canvas for deterministic canvas edits.',
    'Available canvas operation groups: add media/text/annotation, select/duplicate/arrange/transform, crop/extract image region, group, z-order, media playback, canvas background/grid/tool.',
    'For QuickApp inputAssignments, prefer slot when known; otherwise label may be used. For image/video inputs, bind the exact main-model-selected source with sourceStageId/sourceStageIds, artifactId/artifactIds, or itemIds. Use source only for generic inputs: user_intent, selection_snapshot, first_source_image, first_source_video, first_source_asset, first_upstream_image, first_upstream_video, or first_upstream_asset.',
    'For canvas item actions, prefer explicit artifactId/artifactIds or itemIds. source=current_selection is allowed only when you intentionally mean the current user selection. source=all_canvas is allowed only for explicit whole-canvas operations. Do not rely on implicit latest-output state.',
    'Use sourceStageId to target items placed or produced by a specific prior capability action; use sourceStageIds to target the ordered union of several prior capability action outputs.',
    'Model and QuickApp media outputs are automatically placed on the canvas and registered under their producing stage id. Do not request a separate canvas action just to add that same AI result again. Use add_image/add_video/add_model3d only for explicit already-known URLs, not for future model outputs. To crop, split, move, arrange, label, or annotate returned media, reference the producing stage with sourceStageId/sourceStageIds.',
    'Source-consuming canvas actions return a structured execution failure when their source cannot be resolved. Do not rely on implicit current selection after model or QuickApp media output; cite the producing stage id explicitly.',
    'For variant workflows, create separate duplicate_items actions with count 1 when different later edits must target different copies. A duplicate action stage output refers to the newly created copy or copies. Use one arrange_items action with sourceStageIds and explicit x/y/gap to align the variant root copies before adding source-relative labels or annotations. Do not create a separate raw duplicate unless the user explicitly asks for a raw/unmodified copy as one of the final deliverables.',
    'Use phase before_stage or after_stage with stageId to insert capability actions immediately around a specific model stage in long goals. The stageId must match a stageInstructions id.',
    'For duplicate_items, count means the number of new copies to create. Use arrangement grid/row/column for arrange_items; x/y on arrange_items is the top-left start anchor for the arranged set. Use zOrder front/back/forward/backward for set_z_order. Use cropX/cropY/cropWidth/cropHeight for crop_image and extract_image_region.',
    'crop_image mutates an existing image crop. extract_image_region creates new transparent PNG canvas item(s) and registered artifacts from explicit image regions. set_canvas_tool with extract-select only switches the UI tool; it does not perform automated extraction.',
    'Canvas geometry uses canvas coordinates by default. For add_text/add_annotation, set coordinateSpace to source_item for display-local coordinates inside the resolved source item, or source_item_normalized for 0..1 coordinates inside that source item. When add_text/add_annotation targets sourceStageId/sourceStageIds and coordinateSpace is omitted, the runtime treats the rectangle as source-local for safety. For crop_image/extract_image_region, coordinateSpace is required: source_item uses display-local coordinates inside the resolved item, canvas uses absolute canvas coordinates, source_item_normalized lets cropX/cropY/cropWidth/cropHeight express fractions of the current visible source crop, and source_image_pixels uses the original source image pixel grid.',
    'Do not place target reports, execution logs, stage summaries, or final explanatory text on the canvas. Keep final text in the Agent conversation or generated markdown files. Use add_text only for literal user-requested canvas labels or text objects, such as adding the exact label "123". Use add_annotation, not add_text, for box selection, bounding boxes, frames, and callout rectangles.',
    'For finalPresentation, choose canvas/both only for media outputs that genuinely belong on the canvas.',
    JSON.stringify(
      {
        capabilityCatalogVersion: CANVAS_TARGET_CAPABILITY_CATALOG_VERSION,
        quickApps: quickAppsForPrompt,
        canvasActions: canvasActionsForPrompt,
        canvasActionFieldGroups: {
          routing: [
            'type',
            'id',
            'action',
            'phase',
            'stageId',
            'beforeStageId',
            'afterStageId',
            'outputTarget'
          ],
          sources: [
            'artifactId',
            'artifactIds',
            'sourceStageId',
            'sourceStageIds',
            'itemIds',
            'source'
          ],
          geometry: [
            'x',
            'y',
            'width',
            'height',
            'coordinateSpace',
            'deltaX',
            'deltaY',
            'scaleX',
            'scaleY',
            'rotation'
          ],
          cropOrExtract: ['cropX', 'cropY', 'cropWidth', 'cropHeight'],
          duplicationAndLayout: [
            'count',
            'offsetX',
            'offsetY',
            'arrangement',
            'columns',
            'gapX',
            'gapY'
          ],
          mediaImport: ['sourceUrl', 'fileName'],
          textAndAnnotation: [
            'text',
            'annotationShape',
            'color',
            'stroke',
            'fill',
            'strokeWidth',
            'fillOpacity',
            'fontSize',
            'fontWeight',
            'itemLabel'
          ],
          state: [
            'zOrder',
            'flipAxis',
            'groupId',
            'groupName',
            'bgColor',
            'showGrid',
            'tool',
            'playing',
            'muted',
            'volume',
            'explicitUserIntent',
            'selectResult'
          ]
        },
        capabilityActionShape: {
          quick_app: {
            type: 'quick_app',
            id: 'action-id',
            qAppKey: 'listed-qapp-key',
            label: 'short label',
            reason: 'why this action is needed',
            phase:
              'before_model_stages | before_stage | after_stage | after_model_stages | after_summary',
            stageId: 'required when phase is before_stage or after_stage',
            beforeStageId: 'optional alias for before_stage anchoring',
            afterStageId: 'optional alias for after_stage anchoring',
            outputTarget: 'auto | agent | canvas | both',
            inputAssignments: [
              {
                slot: 'workflow.json.path',
                label: 'input label',
                value: 'literal value',
                source:
                  'user_intent | selection_snapshot | first_source_image | first_source_video | first_source_asset | first_upstream_image | first_upstream_video | first_upstream_asset',
                sourceStageId: 'prior-stage-id-that-produced-the-input-media',
                artifactId: 'prior-artifact-id-that-produced-the-input-media',
                itemIds: ['canvas-item-id-to-send-to-quickapp']
              }
            ]
          },
          canvas: {
            type: 'canvas',
            id: 'action-id',
            action: CANVAS_TARGET_CANVAS_ACTIONS.map((entry) => entry.action).join(' | '),
            label: 'short label',
            reason: 'why this canvas action is needed',
            phase:
              'before_model_stages | before_stage | after_stage | after_model_stages | after_summary',
            stageId: 'required when phase is before_stage or after_stage',
            beforeStageId: 'optional alias for before_stage anchoring',
            afterStageId: 'optional alias for after_stage anchoring',
            outputTarget: 'canvas | both | agent',
            text: 'text for add_text',
            sourceUrl: 'url for add_image/add_video/add_model3d',
            fileName: 'optional file name',
            artifactId: 'optional explicit Artifact Graph id',
            artifactIds: ['optional explicit Artifact Graph ids'],
            source: 'current_selection | all_canvas | item_ids',
            sourceStageId: 'optional prior capability action id',
            sourceStageIds:
              'optional ordered prior capability action ids; resolves the union of their outputs',
            itemIds: ['optional explicit canvas item ids'],
            count: 10,
            offsetX: 36,
            offsetY: 36,
            arrangement: 'grid | row | column',
            columns: 5,
            gapX: 24,
            gapY: 24,
            x: 100,
            y: 120,
            coordinateSpace: 'canvas | source_item | source_item_normalized | source_image_pixels',
            deltaX: 40,
            deltaY: 0,
            width: 512,
            height: 512,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            zOrder: 'front | back | forward | backward',
            flipAxis: 'horizontal | vertical',
            cropX: 0,
            cropY: 0,
            cropWidth: 512,
            cropHeight: 512,
            color: '#ffffff',
            stroke: '#ef4444',
            fill: '#ffffff',
            strokeWidth: 2,
            fillOpacity: 0.18,
            fontSize: 28,
            fontWeight: 'normal | bold',
            itemLabel:
              'visible label only for text-anno; omit for normal rect/ellipse/box annotations',
            groupId: 'optional group id',
            groupName: 'optional group name',
            bgColor: '#ffffff',
            showGrid: true,
            tool: 'select | hand | annotate | export-select | crop-select | extract-select | target-select',
            annotationShape:
              'rect | ellipse | circle | arrow | line | freedraw | text-anno | rhombus | parallelogram | double-line-rect | document | cylinder | rounded-rect',
            playing: false,
            muted: true,
            volume: 0.5,
            explicitUserIntent: true,
            selectResult: true
          }
        },
        finalPresentationShape: {
          target: 'auto | agent | canvas | both',
          reason: 'why this final output belongs there',
          addMediaToCanvas: true
        }
      },
      null,
      2
    )
  ].join('\n')
}
