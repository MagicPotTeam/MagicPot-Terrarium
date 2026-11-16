import { describe, expect, it } from 'vitest'

import { collectCanvasTargetCanvasActionReferencedIds } from './canvasTargetCanvasActionSources'
import type { CanvasTargetCanvasAction } from './canvasTargetCapabilityTypes'
import {
  authorizeCanvasTargetMediaPlacementUrl,
  authorizeCanvasTargetSourceReferences,
  canvasTargetMediaUrlKey,
  collectCanvasTargetCanvasBlobUrlKeys,
  canvasTargetEvidenceAllowsSelectionSnapshot,
  canvasTargetEvidenceAllowsSourceReads,
  canvasTargetSelectionHasUnverifiedCrop,
  createCanvasTargetSelectionAuthority,
  findCanvasTargetItemIdsBySourceUrl,
  isCanvasTargetSelectionUnchanged,
  recordCanvasTargetRunOutputUrl
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

describe('canvasTargetSelectionAuthority media placement URLs', () => {
  const selected: CanvasImageItem = { ...a, id: 'S', src: 'blob:http://localhost/selected' }
  const other: CanvasImageItem = { ...a, id: 'U', src: 'blob:http://localhost/unselected', x: 200 }
  const place = (url: string, overrides: Partial<Parameters<typeof authorizeCanvasTargetMediaPlacementUrl>[0]> = {}) => {
    const currentItems = overrides.currentItems || [selected, other]
    return authorizeCanvasTargetMediaPlacementUrl({
      url,
      authority: createCanvasTargetSelectionAuthority([selected]),
      evidenceMode: 'selected_sources',
      currentItems,
      knownCanvasUrlKeys: collectCanvasTargetCanvasBlobUrlKeys([selected, other], new Set()),
      runOutputUrls: new Map(),
      ...overrides
    })
  }

  it('gives every spelling that resolves to one blob the same key', () => {
    const key = canvasTargetMediaUrlKey('blob:http://localhost/unselected')
    expect(key).toBe('blob:http://localhost/unselected')
    for (const variant of ['blob:http://localhost/unselected#x', 'BLOB:http://localhost/unselected', ' \u0001blob:http://localhost/unselected ', 'blob:http://local\thost/unselected', 'blob:http://localhost/%75nselected', 'blob:HTTP://LOCALHOST/unselected', 'blob:http://localhost/unselected%00']) {
      expect(canvasTargetMediaUrlKey(variant)).toBe(key)
    }
    expect(canvasTargetMediaUrlKey('not a url')).toBeNull()
    expect(canvasTargetMediaUrlKey('blob:http://localhost/%E0%A4%A')).toBeNull()
  })

  it('refuses an unselected item\'s URL in any spelling, and a selected one outside selected_sources', () => {
    for (const url of ['blob:http://localhost/unselected', 'blob:http://localhost/unselected#x', 'BLOB:http://localhost/unselected']) {
      expect(place(url)).toEqual({ allowed: false, refusal: 'not_selected', references: ['U'] })
    }
    expect(place('blob:http://localhost/selected', { evidenceMode: 'structured_only' })).toMatchObject({ allowed: false, refusal: 'evidence_mode' })
    expect(place('blob:http://localhost/selected', { authority: null })).toMatchObject({ allowed: false, refusal: 'no_authority' })
  })

  it('places a selected, unchanged source as its canonical URL', () => {
    expect(place('blob:http://localhost/selected#frag')).toEqual({ allowed: true, url: 'blob:http://localhost/selected' })
    expect(place('blob:http://localhost/selected', { currentItems: [{ ...selected, x: 5 }, other] })).toMatchObject({ allowed: false, refusal: 'changed' })
  })

  it('refuses the URL of an item that left the canvas during the run, even if the run also produced it', () => {
    const runOutputUrls = new Map<string, string>()
    recordCanvasTargetRunOutputUrl('blob:http://localhost/unselected', runOutputUrls)
    expect(place('blob:http://localhost/unselected', { currentItems: [selected], runOutputUrls })).toEqual({ allowed: false, refusal: 'missing', references: [] })
  })

  it('places a blob this run produced, and refuses unknown, unparseable or non-blob URLs', () => {
    const runOutputUrls = new Map<string, string>()
    recordCanvasTargetRunOutputUrl('blob:http://localhost/output', runOutputUrls)
    recordCanvasTargetRunOutputUrl('data:image/png;base64,QQ==', runOutputUrls)
    expect(runOutputUrls.size).toBe(1)
    expect(place('blob:http://localhost/output#x', { runOutputUrls })).toEqual({ allowed: true, url: 'blob:http://localhost/output' })
    expect(place('blob:http://localhost/unknown', { runOutputUrls })).toMatchObject({ allowed: false, refusal: 'not_run_output' })
    expect(place('blob:http://localhost/%E0%A4%A', { runOutputUrls })).toMatchObject({ allowed: false, refusal: 'not_run_output' })
    expect(place('data:image/png;base64,QQ==', { runOutputUrls })).toMatchObject({ allowed: false, refusal: 'not_run_output' })
  })

  it('collects the blob URLs carried by src, textures and preview images, not data: URLs', () => {
    const model = { ...a, id: 'M', type: 'model3d', src: 'blob:model', textures: { 'skin.png': 'BLOB:texture#t' } } as unknown as CanvasItem
    const file = { ...a, id: 'F', type: 'file', src: 'blob:file', fileName: 'f.pdf', mimeType: 'application/pdf', previewImages: [{ id: 'p', src: 'blob:preview', mimeType: 'image/png', fileName: 'p.png' }] } as unknown as CanvasItem
    expect([...collectCanvasTargetCanvasBlobUrlKeys([a, model, file], new Set())].sort()).toEqual(['blob:file', 'blob:model', 'blob:preview', 'blob:texture'])
  })

  it('counts a replaced texture or preview image URL as a changed source', () => {
    const model = { ...a, id: 'M', type: 'model3d', src: 'blob:model', textures: { 'skin.png': 'blob:texture-1' } } as unknown as CanvasItem
    const file = { ...a, id: 'F', type: 'file', src: 'blob:file', fileName: 'f.pdf', mimeType: 'application/pdf', previewImages: [{ id: 'p', src: 'blob:preview-1', mimeType: 'image/png', fileName: 'p.png' }] } as unknown as CanvasItem
    const authority = createCanvasTargetSelectionAuthority([model, file])
    expect(isCanvasTargetSelectionUnchanged(authority, [model, file])).toBe(true)
    expect(isCanvasTargetSelectionUnchanged(authority, [{ ...model, textures: { 'skin.png': 'blob:texture-2' } } as unknown as CanvasItem, file])).toBe(false)
    expect(isCanvasTargetSelectionUnchanged(authority, [model, { ...file, previewImages: [{ id: 'p', src: 'blob:preview-2', mimeType: 'image/png', fileName: 'p.png' }] } as unknown as CanvasItem])).toBe(false)
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
