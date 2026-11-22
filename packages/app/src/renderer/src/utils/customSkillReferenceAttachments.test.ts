import { describe, expect, it } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { SkillReferenceAttachment } from '@shared/config/config'
import { mergeChatAttachmentsWithSkillReferenceAttachments } from './customSkillReferenceAttachments'

const userImage = (fileName = 'same.png'): ChatAttachment => ({
  type: 'image',
  url: 'local-media:///fixture/same.png',
  fileName,
  mimeType: 'image/png'
})

const reference = (url: string, fileName: string): SkillReferenceAttachment => ({
  type: 'image',
  url,
  fileName,
  mimeType: 'image/png'
})

describe('mergeChatAttachmentsWithSkillReferenceAttachments', () => {
  it('keeps two identical user attachments as two occurrences, in order', () => {
    const first = userImage()
    const second = userImage()
    const merged = mergeChatAttachmentsWithSkillReferenceAttachments([first, second], undefined)
    expect(merged).toHaveLength(2)
    expect(merged?.[0]).toBe(first)
    expect(merged?.[1]).toBe(second)
  })

  it('adds a skill reference equal to a user attachment no more than once, and keeps every user attachment', () => {
    const first = userImage()
    const second = userImage()
    const equalToUser = reference(first.url, first.fileName!)
    const other = reference('file:///skills/style.png', 'style.png')
    const merged = mergeChatAttachmentsWithSkillReferenceAttachments(
      [first, second],
      [equalToUser, other, { ...other }]
    )
    // The user's two occurrences stay; the reference equal to them is not added again and the
    // repeated reference is added once, hidden from the chat view.
    expect(merged).toEqual([first, second, { ...other, hiddenFromChatView: true }])
  })

  it('keeps one user attachment once when the skill reference equals it', () => {
    const only = userImage()
    expect(
      mergeChatAttachmentsWithSkillReferenceAttachments(
        [only],
        [reference(only.url, only.fileName!)]
      )
    ).toEqual([only])
  })

  it('adds a skill reference that equals no user attachment once, after the user attachments', () => {
    const only = reference('file:///skills/style.png', 'style.png')
    expect(
      mergeChatAttachmentsWithSkillReferenceAttachments(undefined, [only, { ...only }])
    ).toEqual([{ ...only, hiddenFromChatView: true }])
    expect(mergeChatAttachmentsWithSkillReferenceAttachments([], [])).toBeUndefined()
  })
})
