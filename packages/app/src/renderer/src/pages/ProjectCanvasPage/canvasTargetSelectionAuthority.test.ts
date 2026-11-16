import { describe, expect, it } from 'vitest'

import { collectCanvasTargetCanvasActionReferencedIds } from './canvasTargetCanvasActionSources'
import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import {
  authorizeCanvasTargetSourceReferences,
  canvasTargetEvidenceAllowsSelectionSnapshot,
  canvasTargetEvidenceAllowsSourceReads,
  canvasTargetSelectionHasUnverifiedCrop,
  createCanvasTargetSelectionAuthority,
  findCanvasTargetItemIdsBySourceUrl,
  isCanvasTargetSelectionUnchanged
} from './canvasTargetSelectionAuthority'
import type { CanvasImageItem, CanvasItem, CanvasModel3DItem } from './types'

const a: CanvasImageItem = { id: 'A', type: 'image', src: 'data:image/png;base64,QQ==', x: 0, y: 0, width: 100, height: 100, rotation: 0, scaleX: 1, scaleY: 1, zIndex: 1, locked: false }
const b: CanvasImageItem = { ...a, id: 'B', src: 'data:image/png;base64,Qg==', x: 200 }

const authorize = (options: Partial<Parameters<typeof authorizeCanvasTargetSourceReferences>[0]> = {}) =>
  authorizeCanvasTargetSourceReferences({
    authority: createCanvasTargetSelectionAuthority([a]),
    evidenceMode: 'selected_sources',
    referencedItemIds: ['A'],
    currentItems: [a, b],
    ...options
  })

describe('canvasTargetSelectionAuthority', () => {
  it('takes no authority from an empty or ambiguous selection', () => {
    expect(createCanvasTargetSelectionAuthority([])).toBeNull()
    expect(createCanvasTargetSelectionAuthority([a, { ...a, src: 'data:image/png;base64,Yg==' }])).toBeNull()
  })

  it('allows a selected, unchanged original in selected_sources and returns the current item', () => {
    expect(authorize()).toEqual({ allowed: true, items: [a] })
    expect(authorize({ referencedItemIds: [] })).toEqual({ allowed: true, items: [] })
  })

  it('refuses without an authority', () => {
    expect(authorize({ authority: null })).toMatchObject({ allowed: false, refusal: 'no_authority' })
  })

  it.each(['structured_only', 'selection_region'] as const)('refuses every source read in %s, even of the selected item', (mode) => {
    expect(authorize({ evidenceMode: mode })).toMatchObject({ allowed: false, refusal: 'evidence_mode' })
  })

  it('refuses an unselected item, and a mixed reference as a whole', () => {
    expect(authorize({ referencedItemIds: ['B'] })).toEqual({ allowed: false, refusal: 'not_selected', references: ['B'] })
    expect(authorize({ referencedItemIds: ['A', 'B'] })).toEqual({ allowed: false, refusal: 'not_selected', references: ['B'] })
  })

  it('refuses a selected item that is missing or duplicated on the canvas now', () => {
    expect(authorize({ currentItems: [b] })).toEqual({ allowed: false, refusal: 'missing', references: ['A'] })
    expect(authorize({ currentItems: [a, { ...a }] })).toMatchObject({ allowed: false, refusal: 'missing' })
  })

  it('refuses a selected item whose source changed after selection (edit, undo or redo)', () => {
    const replaced = { ...a, src: 'data:image/png;base64,Uw==' }
    expect(authorize({ currentItems: [replaced] })).toEqual({ allowed: false, refusal: 'changed', references: ['A'] })
    expect(authorize({ currentItems: [{ ...a, crop: { x: 0, y: 0, width: 1, height: 1 } }] })).toMatchObject({ refusal: 'changed' })
  })

  it('refuses when a reference could not be resolved to canvas items', () => {
    expect(authorize({ unresolvedReferences: ['stage-x'] })).toEqual({ allowed: false, refusal: 'unresolved', references: ['stage-x'] })
  })

  it('reports an unchanged selection only while every selected item is present, single and unchanged', () => {
    const authority = createCanvasTargetSelectionAuthority([a])
    expect(isCanvasTargetSelectionUnchanged(authority, [a, b])).toBe(true)
    expect(isCanvasTargetSelectionUnchanged(authority, [{ ...b, x: 999 }, a])).toBe(true)
    expect(isCanvasTargetSelectionUnchanged(null, [a])).toBe(false)
    expect(isCanvasTargetSelectionUnchanged(authority, [b])).toBe(false)
    expect(isCanvasTargetSelectionUnchanged(authority, [a, { ...a }])).toBe(false)
    expect(isCanvasTargetSelectionUnchanged(authority, [{ ...a, src: 'data:image/png;base64,Uw==' }])).toBe(false)
  })

  it('maps evidence modes to what they may read or render', () => {
    expect(canvasTargetEvidenceAllowsSourceReads('selected_sources')).toBe(true)
    expect(canvasTargetEvidenceAllowsSourceReads('selection_region')).toBe(false)
    expect(canvasTargetEvidenceAllowsSourceReads('structured_only')).toBe(false)
    expect(canvasTargetEvidenceAllowsSelectionSnapshot('structured_only')).toBe(false)
    expect(canvasTargetEvidenceAllowsSelectionSnapshot('selection_region')).toBe(true)
    const cropped = { ...a, crop: { x: 1, y: 1, width: 2, height: 2 } }
    expect(canvasTargetSelectionHasUnverifiedCrop('selection_region', [cropped])).toBe(true)
    expect(canvasTargetSelectionHasUnverifiedCrop('selection_region', [a])).toBe(false)
    expect(canvasTargetSelectionHasUnverifiedCrop('selected_sources', [cropped])).toBe(false)
  })

  it('finds the canvas items a model-authored URL refers to (src, texture, preview image)', () => {
    const model: CanvasModel3DItem = { ...a, id: 'M', type: 'model3d', src: 'blob:model', textures: { 'skin.png': 'blob:texture' } } as CanvasModel3DItem
    const file = { ...a, id: 'F', type: 'file', src: 'blob:file', fileName: 'f.pdf', mimeType: 'application/pdf', previewImages: [{ id: 'p', src: 'blob:preview', mimeType: 'image/png', fileName: 'p.png' }] } as unknown as CanvasItem
    const items: CanvasItem[] = [a, model, file]
    expect(findCanvasTargetItemIdsBySourceUrl(' data:image/png;base64,QQ== ', items)).toEqual(['A'])
    expect(findCanvasTargetItemIdsBySourceUrl('blob:texture', items)).toEqual(['M'])
    expect(findCanvasTargetItemIdsBySourceUrl('blob:preview', items)).toEqual(['F'])
    expect(findCanvasTargetItemIdsBySourceUrl('blob:fresh', items)).toEqual([])
    expect(findCanvasTargetItemIdsBySourceUrl('', items)).toEqual([])
  })
})

describe('collectCanvasTargetCanvasActionReferencedIds', () => {
  const state = { items: [a, b], selectedIds: new Set(['A']), nextZIndex: 3, stageCanvasItemIds: new Map([['stage-1', ['B']]]) }
  const action = (fields: Partial<CanvasTargetCanvasAction>) =>
    ({ type: 'canvas', id: 'x', action: 'extract_image_region', phase: 'before_model_stages', outputTarget: 'both', ...fields }) as CanvasTargetCanvasAction

  it('keeps ids that do not exist instead of dropping them', () => {
    expect(collectCanvasTargetCanvasActionReferencedIds(action({ source: 'item_ids', itemIds: ['A', 'ghost', 'A'] }), state)).toEqual({ ids: ['A', 'ghost'], unresolved: [] })
  })

  it('reports a stage or artifact reference that maps to no canvas item', () => {
    expect(collectCanvasTargetCanvasActionReferencedIds(action({ sourceStageIds: ['stage-1', 'stage-2'] }), state)).toEqual({ ids: ['B'], unresolved: ['stage-2'] })
    expect(collectCanvasTargetCanvasActionReferencedIds(action({ artifactId: 'art-1' }), state)).toEqual({ ids: [], unresolved: ['art-1'] })
  })

  it('expands all_canvas and current_selection to what the action would read', () => {
    expect(collectCanvasTargetCanvasActionReferencedIds(action({ source: 'all_canvas' }), state).ids).toEqual(['A', 'B'])
    expect(collectCanvasTargetCanvasActionReferencedIds(action({ source: 'current_selection' }), state).ids).toEqual(['A'])
  })
})
