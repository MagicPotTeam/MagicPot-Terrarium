import { describe, expect, it } from 'vitest'
import { accountChatImageOmissions } from './chatImageOmissionAccounting'
import { limitChatImageCount } from './chatImageCountLimit'
import type { ChatAttachment, ChatMessage } from './types'

const image: ChatAttachment = { type: 'image', url: 'image' }
const file: ChatAttachment = { type: 'file', url: 'file' }
const message = (role: ChatMessage['role'], content: string, attachments: ChatAttachment[] = []): ChatMessage => ({ role, content, attachments })

describe('accountChatImageOmissions', () => {
  it('counts occurrences after latest policy, separately excluding system, without mutation', () => {
    const input = [message('system', 's', [image]), message('user', 'old', [image, image, file]), message('assistant', 'answer', [image]), message('user', 'new', [image])]
    const result = accountChatImageOmissions(input)
    expect(result).toMatchObject({ policyOmitted: 3, countLimitOmitted: 0, systemPolicyExcluded: 1 })
    expect(result.messages[1].attachments).toEqual([file])
    expect(result.messages[3].content).toContain('3 张图片')
    expect(input[1].attachments).toEqual([image, image, file])
    expect(input[3].content).toBe('new')
  })
  it('applies all before the count limit, counts occurrences, and preserves system semantics', () => {
    const input = [message('system', 's', [image]), message('user', 'old', [image, image]), message('assistant', 'a', [image]), message('user', 'new', [image])]
    const result = accountChatImageOmissions(input, 'all', 2)
    expect(result).toMatchObject({ policyOmitted: 0, countLimitOmitted: 2, systemPolicyExcluded: 1 })
    expect(result.messages[1].attachments).toEqual([])
    expect(result.messages[2].attachments).toEqual([image])
    expect(result.messages[3].content).toContain('2 张较早图片')
  })
  it('allows 50 and rejects 51 in the last user message', () => {
    expect(accountChatImageOmissions([message('user', 'hi', Array(50).fill(image))], 'all').countLimitOmitted).toBe(0)
    expect(() => accountChatImageOmissions([message('user', 'hi', Array(51).fill(image))], 'all')).toThrow()
    expect(accountChatImageOmissions([message('user', 'old', [image]), message('user', 'hi', Array(50).fill(image))], 'all').countLimitOmitted).toBe(1)
  })
  it('fails closed for missing or empty disclosure user and unsafe later images', () => {
    expect(() => accountChatImageOmissions([message('assistant', 'a', [image])])).toThrow()
    expect(() => accountChatImageOmissions([message('user', 'old', [image]), message('user', ' ', [])])).toThrow()
    expect(() => accountChatImageOmissions([message('user', 'hi'), message('assistant', 'later', [image])])).toThrow()
    expect(() => accountChatImageOmissions([message('user', 'hi'), message('assistant', 'later', [image])], 'all', 0)).toThrow()
  })
  it('does not infer a run identity or remove prior notices on repeated calls', () => {
    const input = [message('user', 'old', [image]), message('user', 'new')]
    const first = accountChatImageOmissions(input)
    const second = accountChatImageOmissions(first.messages)
    expect(second.policyOmitted).toBe(0)
    expect(second.messages[1].content).toEqual(first.messages[1].content)
    const changed = [...first.messages, message('user', 'third')]
    const twice = accountChatImageOmissions(changed)
    expect(twice.messages[1].content).toEqual(first.messages[1].content)
    const legacy = limitChatImageCount([message('user', 'old', [image, image]), message('user', 'new', [image])], 1)
    expect(() => accountChatImageOmissions(legacy, 'all', 0)).toThrow()
    // An existing legacy notice is ordinary text: a caller that reuses it with
    // newly added history can generate another notice. No run deduplication exists.
    const reused = [message('user', 'added history', [image]), ...legacy]
    const again = accountChatImageOmissions(reused, 'all', 1)
    expect(again.messages.at(-1)?.content).toContain('较早图片本次未发送')
    expect(again.messages.at(-1)?.content).toContain('图片数量限制移除了')
  })
})
