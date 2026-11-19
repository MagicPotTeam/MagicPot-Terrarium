import { describe, expect, it } from 'vitest'
import { normalizeMediaReference } from '../../../shared/mediaReference'
import {
  ManagedMediaScanSourceError,
  scanManagedMediaReferenceIds
} from './managedMediaReferenceScanner'

const ref = (sha256: string) => ({
  version: 1,
  kind: 'managed',
  relativePath: `media/${sha256}.bin`,
  sha256,
  sizeBytes: 1,
  mimeType: 'application/octet-stream',
  originalFileName: `${sha256}.bin`
})

function sources(overrides: Partial<Parameters<typeof scanManagedMediaReferenceIds>[0]> = {}) {
  const storage = new Map<string, string>()
  return {
    visitChatRecords: async () => undefined,
    visitCanvasItems: async () => undefined,
    localStorage: {
      get length() {
        return storage.size
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null
    },
    ...overrides
  }
}

describe('managed media reference scanner', () => {
  it('scans chat records with their drafts, draft-backup localStorage, and canvas image media', async () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    const c = 'c'.repeat(64)
    const d = 'd'.repeat(64)
    const storage = new Map([
      ['magicpot-chat-draft:one', JSON.stringify({ attachment: { media: ref(c) } })]
    ])
    const result = await scanManagedMediaReferenceIds({
      visitChatRecords: async (visit) => {
        visit({ messages: [{ attachments: [{ media: ref(a) }] }] })
        visit({ draft: { pendingAttachments: [{ media: ref(b) }] } })
      },
      visitCanvasItems: async (visit) => visit([{ type: 'image', media: ref(d) }]),
      localStorage: {
        get length() {
          return storage.size
        },
        key: (index) => [...storage.keys()][index] ?? null,
        getItem: (key) => storage.get(key) ?? null
      }
    })
    expect(result).toEqual({
      ok: true,
      ids: [a, b, c, d],
      referenceCounts: { [a]: 1, [b]: 1, [c]: 1, [d]: 1 }
    })
  })

  it('tracks compacted-only references so retention is not mistaken for unreferenced media', async () => {
    const id = 'a'.repeat(64)
    expect(
      await scanManagedMediaReferenceIds({
        ...sources(),
        visitChatRecords: async (visit) =>
          visit({
            messages: [],
            compactedMessages: [{ role: 'user', attachments: [{ media: ref(id) }] }]
          })
      })
    ).toEqual({ ok: true, ids: [id], referenceCounts: { [id]: 1 } })
  })

  it('drops what it already found when the chat read fails part way', async () => {
    const result = await scanManagedMediaReferenceIds({
      ...sources(),
      visitChatRecords: async (visit) => {
        visit({ messages: [{ attachments: [{ media: ref('a'.repeat(64)) }] }] })
        throw new Error('cursor failed')
      }
    })
    expect(result).toEqual({
      ok: false,
      ids: [],
      referenceCounts: {},
      failure: { source: 'chat-store' }
    })
  })

  it('fails closed on a draft backup it cannot parse', async () => {
    const storage = new Map([['magicpot-chat-draft:project-a.agent-1:s', '{not json']])
    const result = await scanManagedMediaReferenceIds({
      ...sources(),
      localStorage: {
        get length() {
          return storage.size
        },
        key: (index) => [...storage.keys()][index] ?? null,
        getItem: (key) => storage.get(key) ?? null
      }
    })
    expect(result).toEqual({
      ok: false,
      ids: [],
      referenceCounts: {},
      failure: { source: 'draft-backup', context: 'project-a.agent-1' }
    })
  })

  it('returns an empty fail-closed result when any store read fails', async () => {
    const result = await scanManagedMediaReferenceIds({
      ...sources(),
      visitCanvasItems: async () => {
        throw new Error('read failed')
      }
    })
    expect(result).toEqual({
      ok: false,
      ids: [],
      referenceCounts: {},
      failure: { source: 'canvas-board' }
    })
  })

  it('skips a media value that names no managed media, and reports it, instead of failing', async () => {
    const id = 'a'.repeat(64)
    const result = await scanManagedMediaReferenceIds({
      ...sources(),
      visitChatRecords: async (visit) => {
        visit({
          storageScope: 'project-a.agent-1',
          messages: [
            { attachments: [{ media: { kind: 'managed', sha256: 'bad' } }] },
            {
              role: 'assistant',
              // A tool whose arguments include a parameter named media (stored verbatim).
              toolHistory: [{ toolName: 'post', args: { media: ['https://example.com/a.png'] } }]
            },
            { toolHistory: [{ toolName: 'count', args: { media: 3 } }] }
          ]
        })
        visit({ storageScope: 'default', messages: [{ attachments: [{ media: ref(id) }] }] })
      }
    })
    expect(result).toEqual({
      ok: true,
      ids: [id],
      referenceCounts: { [id]: 1 },
      skipped: [{ source: 'chat-media', context: 'project-a.agent-1', count: 3 }]
    })
  })

  it('keeps every id a malformed or foreign media value can name', async () => {
    const id = (n: number) => n.toString(16).padStart(2, '0').repeat(32)
    // No id in its path or name: each variant below names its file through its sha256 field alone.
    const valid = {
      ...ref(id(1)),
      relativePath: 'originals/00/image.png',
      originalFileName: 'image.png'
    }
    const values: unknown[] = [
      // One broken field each: none of these normalizes, every one still names its file.
      { ...valid, sha256: id(2), mimeType: 'not a type' },
      { ...valid, sha256: id(3), sizeBytes: 0 },
      { ...valid, sha256: id(4), originalFileName: 'a/b.png' },
      { ...valid, sha256: id(5), version: 2 },
      { ...valid, sha256: id(6), kind: 'project-asset' },
      { ...valid, sha256: id(7).toUpperCase() + 'x' },
      // No sha256 field: the id in the path of the original, in an URL, in a plain string.
      { version: 1, kind: 'managed', relativePath: `originals/08/${id(8)}.png` },
      { originalUrl: `local-media:///home/u/.chat_media/originals/09/${id(9)}.png` },
      `local-media:///home/u/.chat_media/originals/0a/${id(10)}.png`,
      [{ derivatives: [{ sha256: id(11) }] }]
    ]
    const result = await scanManagedMediaReferenceIds({
      ...sources(),
      visitCanvasItems: async (visit) =>
        visit(
          values.map((media) => ({ type: 'image', media })),
          'board-1'
        )
    })
    expect(result.ok).toBe(true)
    // id(7) has a trailing x: its sha256 field is not a 64-digit run of its own, still found.
    expect(result.ids).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => id(n)))
    expect(result.ok && result.skipped).toBeUndefined()
  })

  it('names at least the id the strict reading named, for every value it accepted', async () => {
    // The reading before skips existed: a managed reference names its id, anything else fails.
    const strictIds = (media: unknown): string[] | 'fails' => {
      const reference = normalizeMediaReference(media)
      return reference?.kind === 'managed' && reference.sha256 ? [reference.sha256] : 'fails'
    }
    const sha = 'Ab'.repeat(32)
    const base = ref(sha)
    const derivative = {
      maxEdge: 512,
      relativePath: `derivatives/ab/${sha}/512.webp`,
      mimeType: 'image/webp',
      sizeBytes: 9,
      width: 4,
      height: 4,
      sha256: 'c'.repeat(64)
    }
    const values: unknown[] = [
      base,
      { ...base, relativePath: 'originals/00/image.png', originalFileName: 'image.png' },
      { ...base, derivatives: [derivative], width: 4, height: 4, status: 'ready' },
      { ...base, mediaId: 'm-1', originalUrl: 'https://example.com/a.png' },
      { ...base, kind: 'project-asset' },
      { ...base, sha256: undefined },
      { media: base },
      'text',
      7,
      true,
      []
    ]
    for (const media of values) {
      const strict = strictIds(media)
      const result = await scanManagedMediaReferenceIds({
        ...sources(),
        visitChatRecords: async (visit) => visit({ media })
      })
      expect(result.ok).toBe(true)
      if (strict !== 'fails') expect(result.ids).toEqual(expect.arrayContaining(strict))
    }
  })

  it('names the source that failed the scan', async () => {
    const failureOf = async (
      overrides: Partial<Parameters<typeof scanManagedMediaReferenceIds>[0]>
    ) => {
      const result = await scanManagedMediaReferenceIds({ ...sources(), ...overrides })
      return result.ok ? undefined : result.failure
    }
    // A value the walk cannot finish (a cycle) fails the scan under its board.
    const cyclic: Record<string, unknown> = { type: 'image' }
    cyclic.self = cyclic
    expect(
      await failureOf({ visitCanvasItems: async (visit) => visit([cyclic], 'board-7') })
    ).toEqual({ source: 'canvas-media', context: 'board-7' })
    expect(
      await failureOf({
        visitCanvasItems: async () => {
          throw new ManagedMediaScanSourceError({ source: 'canvas-file', context: 'board-8' })
        }
      })
    ).toEqual({ source: 'canvas-file', context: 'board-8' })
    expect(
      await failureOf({ localStorage: { length: 1, key: () => null, getItem: () => null } })
    ).toEqual({ source: 'local-storage' })
  })

  it('keeps a reference that leaves a draft backup while the chat store is read', async () => {
    const leaving = 'a'.repeat(64)
    const arriving = 'b'.repeat(64)
    const storage = new Map([
      ['magicpot-chat-draft:project-a.agent-1:s', JSON.stringify({ media: ref(leaving) })]
    ])
    const result = await scanManagedMediaReferenceIds({
      ...sources(),
      // A send clears the draft before its message reaches the store.
      visitChatRecords: async () => {
        storage.delete('magicpot-chat-draft:project-a.agent-1:s')
        storage.set('magicpot-chat-draft:default:t', JSON.stringify({ media: ref(arriving) }))
      },
      localStorage: {
        get length() {
          return storage.size
        },
        key: (index) => [...storage.keys()][index] ?? null,
        getItem: (key) => storage.get(key) ?? null
      }
    })
    expect(result).toEqual({
      ok: true,
      ids: [leaving, arriving],
      referenceCounts: { [leaving]: 1, [arriving]: 1 }
    })
  })

  it('ignores unrelated localStorage keys', async () => {
    const id = 'e'.repeat(64)
    const storage = new Map([
      ['other-key', JSON.stringify({ media: ref('f'.repeat(64)) })],
      ['magicpot-chat-draft:one', JSON.stringify({ media: ref(id) })]
    ])
    const result = await scanManagedMediaReferenceIds({
      ...sources(),
      localStorage: {
        get length() {
          return storage.size
        },
        key: (index) => [...storage.keys()][index] ?? null,
        getItem: (key) => storage.get(key) ?? null
      }
    })
    expect(result).toEqual({ ok: true, ids: [id], referenceCounts: { [id]: 1 } })
  })

  it('counts repeated references instead of only recording set membership', async () => {
    const id = 'f'.repeat(64)
    const result = await scanManagedMediaReferenceIds({
      ...sources(),
      visitChatRecords: async (visit) =>
        visit({ attachments: [{ media: ref(id) }, { media: ref(id) }] })
    })
    expect(result).toEqual({ ok: true, ids: [id], referenceCounts: { [id]: 2 } })
  })
})
