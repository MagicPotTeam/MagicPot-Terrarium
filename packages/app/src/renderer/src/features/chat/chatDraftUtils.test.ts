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

  it('keeps the identity of a session without a draft so stripping it never rewrites the session', () => {
    const messages = [{ role: 'user', content: 'hello' }]
    const session: {
      id: string
      title: string
      messages: typeof messages
      draft?: ChatSessionDraftModel
    } = {
      id: 's1',
      title: 'Chat',
      messages
    }
    expect(stripSessionDraft(session)).toBe(session)
  })

  it('returns a new session without the draft key when a draft exists, leaving the input untouched', () => {
    const draft: ChatSessionDraftModel = {
      inputValue: 'hello',
      pendingHiddenContext: '',
      pendingAttachments: [],
      updatedAt: 100
    }
    const messages = [{ role: 'user', content: 'hello' }]
    const withDraft = { id: 's1', title: 'Chat', messages, draft }
    const stripped = stripSessionDraft(withDraft)
    expect(stripped).not.toBe(withDraft)
    expect(Object.hasOwn(stripped, 'draft')).toBe(false)
    expect(stripped).toEqual({ id: 's1', title: 'Chat', messages })
    expect(stripped.messages).toBe(messages)
    expect(withDraft.draft).toBe(draft)

    // An own key holding undefined is still a key: it is removed too.
    const withUndefinedDraft = { id: 's2', title: 'Chat', messages, draft: undefined }
    const strippedUndefined = stripSessionDraft(withUndefinedDraft)
    expect(strippedUndefined).not.toBe(withUndefinedDraft)
    expect(Object.hasOwn(strippedUndefined, 'draft')).toBe(false)
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
