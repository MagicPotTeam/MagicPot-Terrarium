import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  areCanvasPersistenceSignaturesEqual,
  buildCanvasPersistenceSignature,
  serializeCanvasItems
} from './canvasItemSerialization'
import type { CanvasGroup, CanvasItem } from './types'

function imageItem(id: string, overrides: Record<string, unknown> = {}): CanvasItem {
  return {
    id,
    type: 'image',
    src: `blob:${id}`,
    fileName: `${id}.png`,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  } as unknown as CanvasItem
}

const signatureOf = (items: CanvasItem[], groups: CanvasGroup[] = []) =>
  buildCanvasPersistenceSignature(items, groups, [], null)

describe('canvas persistence signature', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ignores every field a save does not persist', () => {
    const base = imageItem('a')
    const before = signatureOf([base])
    const variants: CanvasItem[] = [
      { ...base, thumbnailSet: { levels: [{ size: 256 }] } } as unknown as CanvasItem,
      { ...base, image: { width: 1 } } as unknown as CanvasItem,
      { ...base, sourceFile: new Blob(['x']) } as unknown as CanvasItem,
      { ...base, sourceIdentity: { kind: 'session', id: 's-1' } } as unknown as CanvasItem,
      {
        ...base,
        assetKey: `b-${'a'.repeat(40)}`,
        assetKeySource: 'blob:a'
      } as unknown as CanvasItem
    ]
    for (const variant of variants) {
      expect(areCanvasPersistenceSignaturesEqual(before, signatureOf([variant]))).toBe(true)
    }
    const model = { ...imageItem('m'), type: 'model3d' } as unknown as CanvasItem
    expect(
      areCanvasPersistenceSignaturesEqual(
        signatureOf([model]),
        signatureOf([{ ...model, deferRender: true } as unknown as CanvasItem])
      )
    ).toBe(true)
  })

  it('changes with every persisted change', () => {
    const a = imageItem('a')
    const b = imageItem('b')
    const before = signatureOf([a, b])
    const changed: Array<[string, ReturnType<typeof signatureOf>]> = [
      ['moved', signatureOf([{ ...a, x: 1 } as CanvasItem, b])],
      ['source replaced', signatureOf([{ ...a, src: 'blob:other' } as CanvasItem, b])],
      ['caption', signatureOf([{ ...a, caption: 'hi' } as unknown as CanvasItem, b])],
      ['crop', signatureOf([{ ...a, crop: { x: 0, y: 0, width: 5, height: 5 } } as CanvasItem, b])],
      [
        'local file identity',
        signatureOf([
          {
            ...a,
            sourceIdentity: {
              kind: 'local-file',
              canonicalPath: '/a.png',
              sizeBytes: 1,
              lastModifiedMs: 2
            }
          } as unknown as CanvasItem,
          b
        ])
      ],
      ['reordered', signatureOf([b, a])],
      ['removed', signatureOf([a])],
      ['added', signatureOf([a, b, imageItem('c')])],
      ['group', signatureOf([a, b], [{ id: 'g', itemIds: ['a'] } as unknown as CanvasGroup])],
      ['figma binding', buildCanvasPersistenceSignature([a, b], [], [], { fileKey: 'f' } as never)]
    ]
    for (const [label, signature] of changed) {
      expect(areCanvasPersistenceSignaturesEqual(before, signature), label).toBe(false)
    }
    expect(areCanvasPersistenceSignaturesEqual(before, signatureOf([a, b]))).toBe(true)
    expect(areCanvasPersistenceSignaturesEqual(before, null)).toBe(false)
    expect(areCanvasPersistenceSignaturesEqual(null, null)).toBe(true)
  })

  it('matches what serializeCanvasItems persists, item by item', () => {
    const items = [
      imageItem('a', { thumbnailSet: { levels: [] }, sourceIdentity: { kind: 'session', id: 's' } }),
      imageItem('b', { caption: 'kept' })
    ]
    expect(signatureOf(items).items).toEqual(
      serializeCanvasItems(items).map((item) => JSON.stringify(item))
    )
  })

  it('serialises only the items an edit replaced: one of 2000 in well under a millisecond', () => {
    const items = Array.from({ length: 2000 }, (_, index) =>
      imageItem(`item-${index}`, { x: index, caption: 'x'.repeat(200) })
    )
    const first = signatureOf(items)

    const stringify = vi.spyOn(JSON, 'stringify')
    const edited = items.slice()
    edited[1000] = { ...items[1000], x: -1 } as CanvasItem
    let next = signatureOf(edited)
    // One item, plus the groups / branches / binding record.
    expect(stringify).toHaveBeenCalledTimes(2)
    stringify.mockRestore()

    expect(areCanvasPersistenceSignaturesEqual(first, next)).toBe(false)
    expect(next.items[999]).toBe(first.items[999])

    const rounds = 50
    const startedAt = performance.now()
    for (let round = 0; round < rounds; round += 1) {
      const copy = edited.slice()
      copy[round] = { ...edited[round], y: round + 1 } as CanvasItem
      next = signatureOf(copy)
      areCanvasPersistenceSignaturesEqual(first, next)
    }
    const perEditMs = (performance.now() - startedAt) / rounds
    // Measured about 0.05 ms here; the bound leaves room for a loaded machine.
    expect(perEditMs).toBeLessThan(1)
  })
})
