import { describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_IMAGE_COUNT_LIMIT, limitChatImageCount } from './chatImageCountLimit'
import type { ChatAttachment, ChatMessage } from './types'

const image = (url: string): ChatAttachment => ({ type: 'image', url })
const file = (url: string): ChatAttachment => ({ type: 'file', url })

describe('limitChatImageCount', () => {
  it('keeps the latest provider-bound images across messages and preserves all other data', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system', attachments: [image('system')] },
      { role: 'user', content: 'first', attachments: [image('1'), file('file'), image('2')], modelName: 'model' },
      { role: 'assistant', content: 'answer', attachments: [image('3'), image('4')] },
      { role: 'user', content: 'last', attachments: [image('5'), file('last-file')] }
    ]
    const before = structuredClone(messages)
    const result = limitChatImageCount(messages, 3)
    expect(result.map(m => m.attachments?.map(a => a.url))).toEqual([['system'], ['file'], ['3', '4'], ['5', 'last-file']])
    expect(result[3].content).toBe('last\n\n2 张较早图片本次未发送，如需请分批重新提供')
    expect(result[1].modelName).toBe('model')
    expect(messages).toEqual(before)
  })

  it('leaves at or below the default limit unchanged and never adds a notice', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello', attachments: Array.from({ length: DEFAULT_CHAT_IMAGE_COUNT_LIMIT }, (_, i) => image(String(i))) }]
    expect(limitChatImageCount(messages)).toEqual(messages)
    expect(limitChatImageCount([{ role: 'assistant', content: 'no pictures' }])).toEqual([{ role: 'assistant', content: 'no pictures' }])
    const many: ChatMessage[] = [{ role: 'user', content: 'old', attachments: [image('old')] }, { role: 'user', content: '', attachments: Array.from({ length: 50 }, (_, i) => image(String(i))) }]
    const result = limitChatImageCount(many)
    expect(result[1].attachments?.[0].url).toBe('0')
    expect(result[1].content).toBe('1 张较早图片本次未发送，如需请分批重新提供')
  })

  it('handles zero and rejects invalid limits without mutation', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'old', attachments: [image('1'), file('f')] }, { role: 'user', content: 'x' }]
    expect(limitChatImageCount(messages, 0)).toMatchObject([{ attachments: [file('f')] }, { content: 'x\n\n1 张较早图片本次未发送，如需请分批重新提供' }])
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => limitChatImageCount(messages, value)).toThrow(RangeError)
    expect(messages[0].attachments).toEqual([image('1'), file('f')])
  })

  it('rejects more than 50 current images and preserves exactly 50 while omitting history, ignoring system images', () => {
    const current = Array.from({ length: 51 }, (_, i) => image(`current-${i}`))
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system', attachments: [image('system')] },
      { role: 'user', content: 'history', attachments: [image('old'), file('old-file')] },
      { role: 'user', content: 'now', attachments: current }
    ]
    const before = structuredClone(messages)
    expect(() => limitChatImageCount(messages)).toThrow('本次图片数量超过限制，请分批发送')
    expect(messages).toEqual(before)
    const eligible = [...messages.slice(0, 2), { ...messages[2], attachments: current.slice(0, 50) }]
    const result = limitChatImageCount(eligible)
    expect(result[0].attachments).toEqual([image('system')])
    expect(result[1].attachments).toEqual([file('old-file')])
    expect(result[2].attachments).toEqual(current.slice(0, 50))
    expect(result[2].content).toBe('now\n\n1 张较早图片本次未发送，如需请分批重新提供')
  })

  it('rejects rather than calling post-user assistant images earlier history', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'current', attachments: Array.from({ length: 50 }, (_, i) => image(String(i))) },
      { role: 'assistant', content: 'later', attachments: [image('later')] }
    ]
    const before = structuredClone(messages)
    expect(() => limitChatImageCount(messages)).toThrow('无法安全省略本轮后续图片，请分批发送')
    expect(messages).toEqual(before)
    const withHistory: ChatMessage[] = [{ role: 'user', content: 'old', attachments: [image('old')] }, ...messages]
    const result = limitChatImageCount(withHistory, 51)
    expect(result[0].attachments).toEqual([])
    expect(result[2].attachments).toEqual([image('later')])
    expect(result[1].attachments).toHaveLength(50)
  })

  it('fails closed when images must be omitted without a user message', () => {
    expect(() => limitChatImageCount([{ role: 'assistant', content: 'x', attachments: [image('a')] }], 0)).toThrow(/user message/)
  })

  it('counts only present images, not bundle metadata; caller must have expanded once and must not expand the result', () => {
    const primary: ChatAttachment = { type: 'file', url: 'report', reportBundleRole: 'primary-report', reportBundleId: 'r', reportBundleImageCount: 2 }
    const missingCount: ChatAttachment = { type: 'file', url: 'other-report', reportBundleRole: 'primary-report', reportBundleId: 'r' }
    const zero: ChatAttachment = { type: 'file', url: 'zero', reportBundleRole: 'primary-report', reportBundleId: 'zero', reportBundleImageCount: 0 }
    const ri = (url: string): ChatAttachment => ({ ...image(url), reportBundleRole: 'report-image', reportBundleId: 'r' })
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'old', attachments: [primary, ri('a'), missingCount, ri('b'), zero, file('ordinary')] }, { role: 'user', content: 'x' }]
    const before = structuredClone(messages)
    const result = limitChatImageCount(messages, 1)
    expect(result[0].attachments).toEqual([primary, missingCount, ri('b'), zero, file('ordinary')])
    expect(result[1].content).toBe('x\n\n1 张较早图片本次未发送，如需请分批重新提供')
    expect(messages).toEqual(before)
    // Incomplete metadata/payload is accepted: no inference can prove expansion here.
    expect(limitChatImageCount([{ role: 'user', content: '', attachments: [primary, missingCount, zero] }], 0)[0].attachments).toEqual([primary, missingCount, zero])
  })
})
