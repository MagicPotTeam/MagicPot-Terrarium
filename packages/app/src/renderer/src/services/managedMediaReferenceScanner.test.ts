import { describe, expect, it } from 'vitest'
import { scanManagedMediaReferenceIds } from './managedMediaReferenceScanner'

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
    readChatSessions: async () => [],
    readChatDrafts: async () => [],
    readCanvasItems: async () => [],
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
  it('scans chat messages, drafts, draft-backup localStorage, and canvas image media', async () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    const c = 'c'.repeat(64)
    const d = 'd'.repeat(64)
    const storage = new Map([
      ['magicpot-chat-draft:one', JSON.stringify({ attachment: { media: ref(c) } })]
    ])
    const result = await scanManagedMediaReferenceIds({
      readChatSessions: async () => [{ messages: [{ attachments: [{ media: ref(a) }] }] }],
      readChatDrafts: async () => [{ attachments: [{ media: ref(b) }] }],
      readCanvasItems: async () => [{ type: 'image', media: ref(d) }],
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

  it('returns an empty fail-closed result when any store read fails', async () => {
    const result = await scanManagedMediaReferenceIds({
      ...sources(),
      readCanvasItems: async () => {
        throw new Error('read failed')
      }
    })
    expect(result).toEqual({ ok: false, ids: [], referenceCounts: {} })
  })

  it('fails closed for malformed or invalid media references', async () => {
    const result = await scanManagedMediaReferenceIds({
      ...sources(),
      readChatSessions: async () => [
        { messages: [{ attachments: [{ media: { kind: 'managed', sha256: 'bad' } }] }] }
      ]
    })
    expect(result).toEqual({ ok: false, ids: [], referenceCounts: {} })
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
      readChatSessions: async () => [{ attachments: [{ media: ref(id) }, { media: ref(id) }] }]
    })
    expect(result).toEqual({ ok: true, ids: [id], referenceCounts: { [id]: 2 } })
  })
})
