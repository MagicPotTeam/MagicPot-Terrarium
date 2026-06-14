import { describe, expect, it } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import {
  type ChatSessionDraftModel,
  areChatSessionDraftsEqual,
  cloneChatSessionDraft,
  normalizeChatSessionDraft,
  resolvePreferredSessionDraft,
  stripSessionDraft
} from './chatDraftUtils'

const imageAttachment = (url: string): ChatAttachment => ({
  type: 'image',
  url,
  fileName: 'image.png'
})

describe('chatDraftUtils', () => {
  it('normalizes empty and partial drafts without preserving empty drafts', () => {
    expect(normalizeChatSessionDraft(null)).toBeUndefined()
    expect(
      normalizeChatSessionDraft({
        inputValue: '',
        pendingHiddenContext: '',
        pendingAttachments: []
      })
    ).toBeUndefined()

    expect(
      normalizeChatSessionDraft({
        inputValue: 'hello',
        pendingAttachments: [imageAttachment('file:///one.png')],
        updatedAt: Number.NaN
      })
    ).toMatchObject({
      inputValue: 'hello',
      pendingHiddenContext: '',
      pendingAttachments: [imageAttachment('file:///one.png')]
    })
  })

  it('clones draft attachments before returning normalized or cloned drafts', () => {
    const draft: ChatSessionDraftModel = {
      inputValue: 'hello',
      pendingHiddenContext: '',
      pendingAttachments: [imageAttachment('file:///one.png')],
      updatedAt: 100
    }

    const normalized = normalizeChatSessionDraft(draft)
    const cloned = cloneChatSessionDraft(draft)
    draft.pendingAttachments[0].fileName = 'mutated.png'

    expect(normalized?.pendingAttachments[0].fileName).toBe('image.png')
    expect(cloned?.pendingAttachments[0].fileName).toBe('image.png')
  })

  it('compares drafts by user-editable content and strips drafts from sessions', () => {
    const left: ChatSessionDraftModel = {
      inputValue: 'hello',
      pendingHiddenContext: 'hidden',
      pendingAttachments: [imageAttachment('file:///one.png')],
      updatedAt: 100
    }
    const right: ChatSessionDraftModel = { ...left, updatedAt: 200 }

    expect(areChatSessionDraftsEqual(left, right)).toBe(true)
    expect(stripSessionDraft({ id: 's1', title: 'Chat', messages: [], draft: left })).toEqual({
      id: 's1',
      title: 'Chat',
      messages: []
    })
  })

  it('chooses the freshest backup draft when one is available', () => {
    const sessionDraft: ChatSessionDraftModel = {
      inputValue: 'session draft',
      pendingHiddenContext: '',
      pendingAttachments: [],
      updatedAt: 100
    }
    const backupDraft: ChatSessionDraftModel = {
      inputValue: 'backup draft',
      pendingHiddenContext: '',
      pendingAttachments: [],
      updatedAt: 50
    }

    expect(
      resolvePreferredSessionDraft({
        sessionId: 's1',
        sessionDraft,
        storageScope: 'default',
        readSessionDraftBackup: () => ({ updatedAt: 150, draft: backupDraft })
      })
    ).toMatchObject({ inputValue: 'backup draft' })

    expect(
      resolvePreferredSessionDraft({
        sessionId: 's1',
        sessionDraft,
        storageScope: 'default',
        readSessionDraftBackup: () => ({ updatedAt: 90, draft: backupDraft })
      })
    ).toMatchObject({ inputValue: 'session draft' })
  })
})
