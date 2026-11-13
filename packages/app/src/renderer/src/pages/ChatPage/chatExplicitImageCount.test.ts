import { describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/llm'
import { assertExplicitUserImageCount } from './chatExplicitImageCount'

const image = (): ChatAttachment => ({ type: 'image', fileName: 'image.png', url: 'blob:fixture' })

describe('explicit user image count', () => {
  it('accepts empty and 50 images and rejects 51 with a fixed message', () => {
    expect(() => assertExplicitUserImageCount(undefined)).not.toThrow()
    expect(() => assertExplicitUserImageCount([])).not.toThrow()
    expect(() => assertExplicitUserImageCount(Array.from({ length: 50 }, image))).not.toThrow()
    expect(() => assertExplicitUserImageCount(Array.from({ length: 51 }, image))).toThrow('本次图片数量超过限制，请分批发送')
  })

  it('ignores non-images and bundle metadata without changing its input', () => {
    const attachments = [
      { type: 'file', fileName: 'report', url: 'fixture', reportBundleImageCount: 10000 },
      image()
    ] as ChatAttachment[]
    const before = structuredClone(attachments)
    expect(() => assertExplicitUserImageCount(attachments)).not.toThrow()
    expect(attachments).toEqual(before)
  })

  it('does not read attachment URLs even when rejecting', () => {
    const getter = vi.fn(() => { throw new Error('URL must not be accessed') })
    const attachments = Array.from({ length: 51 }, () => ({ type: 'image', get url() { return getter() } })) as ChatAttachment[]
    expect(() => assertExplicitUserImageCount(attachments)).toThrow('本次图片数量超过限制，请分批发送')
    expect(getter).not.toHaveBeenCalled()
  })
})
