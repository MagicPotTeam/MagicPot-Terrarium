import { describe, expect, it } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import {
  type ChatSessionDraftModel,
  areChatComposerDraftsEqual,
  areChatSessionDraftsEqual,
  cloneChatSessionDraft,
  normalizeChatSessionDraft,
  resolvePreferredQueuedSends,
  resolvePreferredSessionDraft,
  stripSessionDraft,
  withDraftQueuedSends
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

  describe('queued sends kept with the draft', () => {
    const queued = (id: string, content = id) => ({ id, content, queuedAt: 10 })
    const composer: ChatSessionDraftModel = {
      inputValue: 'typing',
      pendingHiddenContext: '',
      pendingAttachments: [],
      updatedAt: 100
    }

    it('sees a queue change in the draft equality helper', () => {
      const one = { ...composer, queuedSends: [queued('q1')], queuedSendsUpdatedAt: 5 }
      const two = { ...composer, queuedSends: [queued('q1'), queued('q2')], queuedSendsUpdatedAt: 6 }
      expect(areChatSessionDraftsEqual(one, two)).toBe(false)
      expect(areChatSessionDraftsEqual(composer, one)).toBe(false)
      expect(areChatSessionDraftsEqual(one, { ...one, queuedSendsUpdatedAt: 7 })).toBe(true)
      expect(areChatSessionDraftsEqual(composer, { ...composer, queuedSends: [] })).toBe(true)
    })

    it('keeps a draft that holds only queued sends and clones the queue', () => {
      const draft = {
        inputValue: '',
        pendingHiddenContext: '',
        pendingAttachments: [],
        updatedAt: 0,
        queuedSends: [{ ...queued('q1'), attachments: [imageAttachment('local-media:///a.png')] }],
        queuedSendsUpdatedAt: 9
      }
      const normalized = normalizeChatSessionDraft(draft)
      expect(normalized?.queuedSends).toEqual(draft.queuedSends)
      expect(normalized?.queuedSendsUpdatedAt).toBe(9)
      const cloned = cloneChatSessionDraft(draft)
      draft.queuedSends[0].attachments![0].fileName = 'mutated.png'
      expect(normalized?.queuedSends?.[0].attachments?.[0].fileName).toBe('image.png')
      expect(cloned?.queuedSends?.[0].attachments?.[0].fileName).toBe('image.png')
    })

    it('strips only the composer part of a draft and keeps its queue', () => {
      const withQueue = { ...composer, queuedSends: [queued('q1')], queuedSendsUpdatedAt: 5 }
      const session = { id: 's1', title: 'Chat', messages: [], draft: withQueue }
      expect(stripSessionDraft(session)).toEqual({
        id: 's1',
        title: 'Chat',
        messages: [],
        draft: {
          inputValue: '',
          pendingHiddenContext: '',
          pendingAttachments: [],
          updatedAt: 0,
          queuedSends: [queued('q1')],
          queuedSendsUpdatedAt: 5
        }
      })
      // A queue-only draft has no composer part to strip: same identity, no rewrite.
      const queueOnly = stripSessionDraft(session) as typeof session
      expect(stripSessionDraft(queueOnly)).toBe(queueOnly)
    })

    it('merges the composer part of one draft with the queue part of another', () => {
      const stored = { ...composer, inputValue: 'old', queuedSends: [queued('q1')], queuedSendsUpdatedAt: 5 }
      expect(withDraftQueuedSends({ ...composer, inputValue: 'new' }, stored)).toEqual({
        ...composer,
        inputValue: 'new',
        queuedSends: [queued('q1')],
        queuedSendsUpdatedAt: 5
      })
      expect(withDraftQueuedSends(undefined, stored)).toMatchObject({
        inputValue: '',
        updatedAt: 0,
        queuedSends: [queued('q1')]
      })
      expect(withDraftQueuedSends(stored, undefined)).toEqual({ ...composer, inputValue: 'old' })
      expect(withDraftQueuedSends(undefined, composer)).toBeUndefined()
    })

    it('prefers the fresher queue copy, the backup on a tie, and honours an empty removal marker', () => {
      const sessionDraft = { ...composer, queuedSends: [queued('accepted'), queued('q2')], queuedSendsUpdatedAt: 50 }
      expect(resolvePreferredQueuedSends(sessionDraft, { queuedSends: [queued('q2')], queuedSendsUpdatedAt: 50 })).toEqual({
        queuedSends: [queued('q2')],
        queuedSendsUpdatedAt: 50
      })
      expect(resolvePreferredQueuedSends(sessionDraft, { queuedSends: [], queuedSendsUpdatedAt: 60 })).toEqual({
        queuedSends: [],
        queuedSendsUpdatedAt: 60
      })
      expect(resolvePreferredQueuedSends(sessionDraft, { queuedSends: [queued('q0')], queuedSendsUpdatedAt: 40 }).queuedSends).toEqual([
        queued('accepted'),
        queued('q2')
      ])
      expect(resolvePreferredQueuedSends(undefined, undefined)).toEqual({ queuedSends: [], queuedSendsUpdatedAt: 0 })
    })

    it('lets a newer removal marker in the session record outrank an older backup queue', () => {
      // The queue was emptied (an item accepted) but the backup write that removes it failed.
      const marker = { ...composer, queuedSends: [], queuedSendsUpdatedAt: 70 }
      const staleBackup = { queuedSends: [queued('accepted')], queuedSendsUpdatedAt: 50 }
      expect(resolvePreferredQueuedSends(marker, staleBackup)).toEqual({ queuedSends: [], queuedSendsUpdatedAt: 70 })
      // An older marker loses to a newer backup list.
      expect(resolvePreferredQueuedSends({ ...marker, queuedSendsUpdatedAt: 40 }, staleBackup).queuedSends).toEqual([
        queued('accepted')
      ])
      // A draft holding only the marker survives normalisation, stripping and merging.
      const markerOnly = { inputValue: '', pendingHiddenContext: '', pendingAttachments: [], updatedAt: 0, queuedSends: [], queuedSendsUpdatedAt: 70 }
      expect(normalizeChatSessionDraft(markerOnly)).toEqual(markerOnly)
      const session = { id: 's1', title: 'Chat', messages: [], draft: markerOnly }
      expect(stripSessionDraft(session)).toBe(session)
      expect(withDraftQueuedSends({ ...composer }, markerOnly)).toEqual({ ...composer, queuedSends: [], queuedSendsUpdatedAt: 70 })
      // A list without a timestamp is still no marker.
      expect(normalizeChatSessionDraft({ ...markerOnly, queuedSendsUpdatedAt: undefined })).toBeUndefined()
    })

    it('compares only the composer fields in the composer equality helper', () => {
      const withQueue = { ...composer, queuedSends: [queued('q1')], queuedSendsUpdatedAt: 5 }
      expect(areChatComposerDraftsEqual(composer, withQueue)).toBe(true)
      expect(areChatComposerDraftsEqual(composer, { ...withQueue, inputValue: 'other' })).toBe(false)
      // An empty composer equals no draft, whatever queue the stored draft carries.
      const queueOnly = { inputValue: '', pendingHiddenContext: '', pendingAttachments: [], updatedAt: 0, queuedSends: [], queuedSendsUpdatedAt: 9 }
      expect(areChatComposerDraftsEqual(undefined, queueOnly)).toBe(true)
      expect(areChatComposerDraftsEqual(undefined, composer)).toBe(false)
    })
  })
})
