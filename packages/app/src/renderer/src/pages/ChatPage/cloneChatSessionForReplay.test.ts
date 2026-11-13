import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment, ChatMessage } from '@shared/llm'
import type { ChatSession } from './chatStorage'
import { cloneChatSessionForReplay } from './cloneChatSessionForReplay'
import { planReplay } from './replayUserCommand'

const realStructuredClone = globalThis.structuredClone
const imageUrls = Array.from(
  { length: 8 },
  (_, index) => 'data:image/png;base64,' + String.fromCharCode(65 + index).repeat(4096)
)

const makeSession = (): ChatSession => ({
  id: 'source-session',
  title: 'Source conversation',
  profileId: 'base-model',
  storageScope: 'synthetic-scope',
  createdAt: 123,
  messages: imageUrls.map((url, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'message-' + index,
    attachments: [{ type: 'image', url, fileName: 'synthetic-' + index + '.png' }]
  }))
})

// Same two clone expressions as the previous page call site, exercised here as a pure function.
const cloneLikePreviousCallsite = (
  session: ChatSession,
  messages?: ChatSession['messages']
): ChatSession => {
  const copy = structuredClone(session)
  return { ...copy, messages: structuredClone(messages ?? copy.messages) }
}

const messageUrlCharacters = (messages: readonly ChatMessage[]): number =>
  messages.reduce(
    (total, message) =>
      total +
      (message.attachments?.reduce((sum, attachment) => sum + attachment.url.length, 0) ?? 0),
    0
  )

const measureClones = (run: () => ChatSession) => {
  let projectedMessageUrlCharacters = 0
  const spy = vi
    .spyOn(globalThis, 'structuredClone')
    .mockImplementation(<T>(value: T, options?: StructuredSerializeOptions): T => {
      const messages = Array.isArray(value)
        ? (value as ChatMessage[])
        : ((value as Partial<ChatSession> | null)?.messages ?? [])
      projectedMessageUrlCharacters += messageUrlCharacters(messages)
      return realStructuredClone(value, options)
    })
  try {
    const result = run()
    return { result, cloneCalls: spy.mock.calls.length, projectedMessageUrlCharacters }
  } finally {
    spy.mockRestore()
  }
}

const managedMedia = (): NonNullable<ChatAttachment['media']> => ({
  version: 1,
  kind: 'managed',
  relativePath: 'assets/original.png',
  sha256: 'a'.repeat(64),
  sizeBytes: 128,
  mimeType: 'image/png',
  originalFileName: 'original.png',
  mediaId: 'synthetic-media',
  width: 32,
  height: 32,
  status: 'ready',
  derivatives: [
    {
      maxEdge: 256,
      relativePath: 'assets/original-preview.png',
      mimeType: 'image/png',
      sizeBytes: 64,
      width: 32,
      height: 32,
      sha256: 'b'.repeat(64)
    }
  ]
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cloneChatSessionForReplay', () => {
  it.each(['all', 'first-two', 'empty'] as const)(
    'preserves %s history while cloning only the selected message URLs',
    (selection) => {
      const source = makeSession()
      const before = realStructuredClone(source)
      const messages =
        selection === 'all'
          ? undefined
          : source.messages.slice(0, selection === 'first-two' ? 2 : 0)
      const selected = messages ?? source.messages
      const sourceCharacters = messageUrlCharacters(source.messages)
      const selectedCharacters = messageUrlCharacters(selected)

      const previous = measureClones(() => cloneLikePreviousCallsite(source, messages))
      const next = measureClones(() => cloneChatSessionForReplay(source, messages))

      expect(next.result).toEqual(previous.result)
      expect(next.result.messages).toEqual(selected)
      expect(next.result).not.toBe(source)
      expect(next.result.messages).not.toBe(selected)
      expect(source).toEqual(before)
      expect(
        source.messages.flatMap((message) =>
          message.attachments!.map((attachment) => attachment.url)
        )
      ).toEqual(imageUrls)
      if (selected.length) {
        expect(next.result.messages[0]).not.toBe(selected[0])
        expect(next.result.messages[0].attachments).not.toBe(selected[0].attachments)
        expect(next.result.messages[0].attachments![0]).not.toBe(selected[0].attachments![0])
      }
      console.info('replay-clone-observation', {
        selection,
        sourceCharacters,
        selectedCharacters,
        previousCloneCalls: previous.cloneCalls,
        nextCloneCalls: next.cloneCalls,
        previousProjectedMessageUrlCharacters: previous.projectedMessageUrlCharacters,
        nextProjectedMessageUrlCharacters: next.projectedMessageUrlCharacters
      })
      // This projects input message URL characters; it does not measure allocated bytes or heap size.
      expect(previous.cloneCalls).toBe(2)
      expect(next.cloneCalls).toBe(2)
      expect(previous.projectedMessageUrlCharacters).toBe(sourceCharacters + selectedCharacters)
      expect(next.projectedMessageUrlCharacters).toBe(selectedCharacters)
    }
  )

  it('preserves metadata and managed fields with bidirectional isolation across separate calls', () => {
    const source: ChatSession = {
      ...makeSession(),
      skillId: 'selected-skill',
      pinned: true,
      archived: false,
      sessionUrl: 'session:continuation',
      sessionProfileId: 'base-model',
      sessionRouteFingerprint: 'synthetic-route',
      memberModelChoice: { version: 1, profileId: 'member-model' },
      teamGeneration: 2,
      teamLifecycleRevision: 3,
      teamSettings: { maxMembers: 4, defaultModel: 'base-model', autoCleanup: false },
      teamTasks: [
        { id: 'task', title: 'Local task', ownerId: 'member', status: 'pending', dependsOn: [] }
      ],
      teamChannel: [{ id: 'entry', senderId: 'lead', text: 'Local note', createdAt: 124 }],
      compactedMessages: [{ role: 'assistant', content: 'Preserved compacted history' }],
      draft: {
        inputValue: 'Unsent draft',
        pendingAttachments: [
          { type: 'image', url: 'data:image/png;base64,QQ==', fileName: 'draft.png' }
        ],
        pendingHiddenContext: 'Draft context',
        updatedAt: 125
      }
    }
    source.messages[0].attachments![0].media = managedMedia()
    const before = realStructuredClone(source)
    const previous = cloneLikePreviousCallsite(source)
    const first = cloneChatSessionForReplay(source)
    const second = cloneChatSessionForReplay(source)

    expect(first).toEqual(previous)
    expect(second).toEqual(previous)
    expect(source).toEqual(before)
    expect(first.messages[0].attachments![0].media).toEqual(
      before.messages[0].attachments![0].media
    )
    expect(first.teamTasks).not.toBe(source.teamTasks)
    expect(first.draft!.pendingAttachments).not.toBe(source.draft!.pendingAttachments)
    expect(first.compactedMessages).not.toBe(source.compactedMessages)
    expect(first.messages[0].attachments![0].media).not.toBe(
      source.messages[0].attachments![0].media
    )
    expect(first.messages[0].attachments![0].media!.derivatives).not.toBe(
      source.messages[0].attachments![0].media!.derivatives
    )
    expect(first).not.toBe(second)
    expect(first.messages).not.toBe(second.messages)
    expect(first.teamTasks).not.toBe(second.teamTasks)

    source.teamTasks![0].dependsOn.push('source-only-dependency')
    source.draft!.pendingHiddenContext = 'Later caller context'
    source.messages[0].attachments![0].media!.derivatives![0].relativePath =
      'assets/source-later.png'
    expect(first).toEqual(before)
    expect(second).toEqual(before)
    const afterCallerMutation = realStructuredClone(source)

    first.teamTasks![0].dependsOn.push('copy-only-dependency')
    first.draft!.pendingAttachments[0].url = 'data:image/png;base64,Qg=='
    first.messages[0].attachments![0].media!.sha256 = 'c'.repeat(64)
    first.compactedMessages![0].content = 'Copy-only compacted edit'
    expect(source).toEqual(afterCallerMutation)
    expect(second).toEqual(before)
    const later = cloneChatSessionForReplay(source)
    expect(later).toEqual(afterCallerMutation)
    expect(later).not.toBe(first)
    expect(later.messages).not.toBe(second.messages)
  })

  it('keeps metadata and message attachments independent when they shared the same source object', () => {
    const source = makeSession()
    const shared = source.messages[0].attachments![0]
    shared.media = managedMedia()
    source.draft = {
      inputValue: '',
      pendingAttachments: [shared],
      pendingHiddenContext: '',
      updatedAt: 126
    }
    const before = realStructuredClone(source)
    const previous = cloneLikePreviousCallsite(source)
    const next = cloneChatSessionForReplay(source)

    expect(next).toEqual(previous)
    expect(source.draft.pendingAttachments[0]).toBe(shared)
    for (const result of [previous, next]) {
      const metadataAttachment = result.draft!.pendingAttachments[0]
      const messageAttachment = result.messages[0].attachments![0]
      expect(metadataAttachment).not.toBe(messageAttachment)
      expect(metadataAttachment.media).not.toBe(messageAttachment.media)
      expect(metadataAttachment).not.toBe(shared)
      expect(messageAttachment).not.toBe(shared)

      metadataAttachment.url = 'data:image/png;base64,Qw=='
      metadataAttachment.media!.relativePath = 'assets/metadata-only.png'
      expect(messageAttachment.url).toBe(shared.url)
      expect(messageAttachment.media!.relativePath).toBe(shared.media.relativePath)
      messageAttachment.fileName = 'message-only.png'
      messageAttachment.media!.sha256 = 'd'.repeat(64)
      expect(metadataAttachment.fileName).toBe(shared.fileName)
      expect(metadataAttachment.media!.sha256).toBe(shared.media.sha256)
    }
    expect(source).toEqual(before)
  })

  it('accepts a real replay plan subset without mutating its original history or sharing its attachments', () => {
    const source = makeSession()
    source.messages.splice(2, 0, { role: 'user', content: 'Original plain prompt' })
    const before = realStructuredClone(source)
    const plan = planReplay(source.messages, {
      kind: 'edit',
      index: 2,
      text: 'Revised plain prompt'
    })

    expect(plan.content).toBe('Revised plain prompt')
    expect(plan.baseMessages).toEqual(source.messages.slice(0, 2))
    const next = cloneChatSessionForReplay(source, plan.baseMessages)
    expect(next).toEqual(cloneLikePreviousCallsite(source, plan.baseMessages))
    expect(next.messages).toHaveLength(2)
    expect(next.messages).not.toBe(plan.baseMessages)
    expect(next.messages[0].attachments![0]).not.toBe(plan.baseMessages[0].attachments![0])

    next.messages[0].attachments![0].url = 'data:image/png;base64,RA=='
    expect(plan.baseMessages[0].attachments![0].url).toBe(imageUrls[0])
    expect(plan.originalMessages).toEqual(before.messages)
    expect(source).toEqual(before)
  })
})
