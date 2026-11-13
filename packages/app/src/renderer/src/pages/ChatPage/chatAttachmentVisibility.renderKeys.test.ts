import { describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/llm'
import { getChatAttachmentRenderKeys } from './chatAttachmentVisibility'

describe('attachment render key serialization baseline', () => {
  it('measures eight distinct synthetic 4 KiB URLs without logging their contents', () => {
    const attachments: ChatAttachment[] = Array.from({ length: 8 }, (_, i) => ({
      type: 'image', url: `data:image/png;base64,${String(i).repeat(4096)}`
    }))
    const stringify = JSON.stringify
    const records: Array<{ chars: number; stack: string[] }> = []
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
      const output = stringify(...args)
      records.push({ chars: output.length, stack: (new Error().stack || '').split('\n').slice(1, 5) })
      return output
    })
    try {
      const keys = getChatAttachmentRenderKeys(attachments)
      expect(records).toHaveLength(8)
      expect(new Set(keys).size).toBe(8)
      console.info('synthetic-key-baseline', { calls: records.length, serializedChars: records.reduce((n, r) => n + r.chars, 0), keyChars: keys.reduce((n, key) => n + key.length, 0), stack: records[0].stack })
    } finally { spy.mockRestore() }
  })
})
