import type { CanvasTargetCanvasActionCapability } from './canvasTargetCapabilityTypes'

export const CANVAS_TARGET_CAPABILITY_CATALOG_VERSION = 'canvas-target-tools-v2'

export const CANVAS_TARGET_CANVAS_ACTIONS: CanvasTargetCanvasActionCapability[] = [
  {
    action: 'add_text',
    label: 'Add text',
    description:
      'Create a text block on the current canvas, optionally positioned relative to a resolved source item.',
    requiredFields: ['text', 'x/y or source/sourceStageId'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'add_annotation',
    label: 'Add annotation',
    description:
      'Create a canvas annotation shape such as a rectangle, arrow, line, ellipse, or text annotation.',
    requiredFields: ['x/y/width/height or source/sourceStageId', 'annotationShape'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'add_image',
    label: 'Add image',
    description: 'Add an existing image URL/object URL/data URL to the current canvas.',
    requiredFields: ['sourceUrl'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'add_video',
    label: 'Add video',
    description: 'Add an existing video URL/object URL/data URL to the current canvas.',
    requiredFields: ['sourceUrl'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'add_model3d',
    label: 'Add 3D model',
    description: 'Add an existing 3D model URL/object URL/data URL to the current canvas.',
    requiredFields: ['sourceUrl'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'select_items',
    label: 'Select items',
    description:
      'Select existing canvas items by source, sourceStageId, or itemIds for later actions.',
    requiredFields: ['source or itemIds'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'duplicate_items',
    label: 'Duplicate items',
    description:
      'Clone existing canvas items, including items just placed by a QuickApp or canvas action.',
    requiredFields: ['source or itemIds', 'count'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'arrange_items',
    label: 'Arrange items',
    description: 'Arrange existing canvas items into a grid, row, or column.',
    requiredFields: ['source or itemIds', 'arrangement'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'transform_items',
    label: 'Transform items',
    description: 'Move, resize, rotate, or scale existing canvas items.',
    requiredFields: ['source or itemIds', 'x/y or deltaX/deltaY or size/rotation/scale'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'set_z_order',
    label: 'Set z order',
    description: 'Move existing canvas items forward, backward, to front, or to back.',
    requiredFields: ['source or itemIds', 'zOrder'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'delete_items',
    label: 'Delete items',
    description: 'Delete selected or resolved canvas items and prune affected groups.',
    requiredFields: ['source or itemIds'],
    surface: 'selection_toolbar',
    executionMode: 'direct',
    destructive: true
  },
  {
    action: 'clear_canvas',
    label: 'Clear canvas',
    description: 'Remove all canvas items and groups when the user explicitly asks to clear/reset.',
    requiredFields: ['explicitUserIntent'],
    surface: 'top_toolbar',
    executionMode: 'direct',
    destructive: true
  },
  {
    action: 'flip_items',
    label: 'Flip items',
    description: 'Flip resolved canvas items horizontally or vertically while preserving center.',
    requiredFields: ['source or itemIds', 'flipAxis'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'crop_image',
    label: 'Crop image',
    description: 'Apply a crop rectangle to one or more image items.',
    requiredFields: ['source or itemIds', 'coordinateSpace', 'cropX/cropY/cropWidth/cropHeight'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'extract_image_region',
    label: 'Extract image region',
    description:
      'Extract a transparent PNG canvas item from an image item using the supplied source-pixel, display-local, or normalized crop rectangle.',
    requiredFields: ['source or itemIds', 'coordinateSpace', 'cropX/cropY/cropWidth/cropHeight'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'update_text',
    label: 'Update text',
    description: 'Edit selected text items, including content, color, font size, and weight.',
    requiredFields: ['source or itemIds', 'text or style fields'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'update_annotation',
    label: 'Update annotation',
    description: 'Edit selected annotation items, including shape text, stroke, fill, and width.',
    requiredFields: ['source or itemIds', 'annotation/style fields'],
    surface: 'annotation_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'set_media_playback',
    label: 'Set media playback',
    description: 'Set video playback, mute, and volume state on canvas video items.',
    requiredFields: ['source or itemIds', 'playing/muted/volume'],
    surface: 'selection_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'create_group',
    label: 'Create group',
    description:
      'Create a canvas group from resolved items and remove overlapping group conflicts.',
    requiredFields: ['source or itemIds'],
    surface: 'group_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'delete_group',
    label: 'Delete group',
    description:
      'Delete a canvas group by id, name, or source item overlap without deleting items.',
    requiredFields: ['groupId/groupName or source'],
    surface: 'group_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'rename_group',
    label: 'Rename group',
    description: 'Rename a canvas group by id, name, or source item overlap.',
    requiredFields: ['groupId/groupName or source', 'groupName'],
    surface: 'group_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'focus_items',
    label: 'Focus items',
    description: 'Select resolved items so the canvas can focus or continue operating on them.',
    requiredFields: ['source or itemIds'],
    surface: 'canvas',
    executionMode: 'direct'
  },
  {
    action: 'set_canvas_background',
    label: 'Set background',
    description: 'Set the canvas background color.',
    requiredFields: ['bgColor'],
    surface: 'top_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'set_grid_visibility',
    label: 'Set grid visibility',
    description: 'Show or hide the canvas grid.',
    requiredFields: ['showGrid'],
    surface: 'top_toolbar',
    executionMode: 'direct'
  },
  {
    action: 'set_canvas_tool',
    label: 'Set canvas tool',
    description: 'Switch the active canvas tool and annotation defaults.',
    requiredFields: ['tool or annotationShape'],
    surface: 'top_toolbar',
    executionMode: 'direct'
  }
]
