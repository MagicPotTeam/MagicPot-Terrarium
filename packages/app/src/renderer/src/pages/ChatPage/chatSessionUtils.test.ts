import { describe, expect, it, vi } from 'vitest'
import {
  appendAssistantDeltaToSession,
  appendAssistantPlaceholderToSession,
  applyUserMessageToSession,
  collectAssistantImageUrls,
  createChatSession,
  filterVisibleSessions,
  mergeLoadedSessionsWithLocal,
  normalizeRestoredSkillSelection,
  removeTrailingEmptyAssistantMessage,
  replaceLastMessageInSession,
  replaceLastMessageWithMessagesInSession,
  sortSessionsByRecencyDesc,
  updateSessionUrl
} from './chatSessionUtils'
import type { ChatSession } from './chatStorage'
import { NO_SKILL_VALUE } from './chatSkillUtils'

describe('createChatSession', () => {
  it('builds a new empty session with safe defaults', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(123)
    const session = createChatSession('New conversation', 'foo', 'art-skill')

    expect(session.title).toBe('New conversation')
    expect(session.profileId).toBe('foo')
    expect(session.skillId).toBe('art-skill')
    expect(session.messages).toEqual([])
    expect(session.pinned).toBe(false)
    expect(session.archived).toBe(false)
    expect(session.createdAt).toBe(123)

    now.mockRestore()
  })

  it('normalizes legacy composite profile ids to their base id', () => {
    const session = createChatSession(
      'New conversation',
      'hunyuan3d-pro::SubmitHunyuanTo3DProJob::3.1::LowPoly'
    )

    expect(session.profileId).toBe('hunyuan3d-pro')
  })
})

describe('chatSessionUtils collections', () => {
  it('collects assistant image urls only', () => {
    const session: ChatSession = {
      id: '1',
      title: 'Test',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: '',
          attachments: [
            { type: 'image', url: 'https://example.com/a.png' },
            { type: 'model3d', url: 'https://example.com/a.glb' }
          ]
        }
      ]
    }

    expect(collectAssistantImageUrls(session)).toEqual(['https://example.com/a.png'])
  })

  it('filters by keyword and can keep archived sessions at the end when requested', () => {
    const sessions: ChatSession[] = [
      { id: '1', title: 'Alpha', messages: [] },
      { id: '2', title: 'Beta', messages: [], archived: true },
      { id: '3', title: 'Another Alpha', messages: [] }
    ]

    expect(filterVisibleSessions(sessions, 'alpha').map((session) => session.id)).toEqual([
      '1',
      '3'
    ])
    expect(filterVisibleSessions(sessions, '').map((session) => session.id)).toEqual(['1', '3'])
    expect(
      filterVisibleSessions(sessions, '', { includeArchived: true }).map((session) => session.id)
    ).toEqual(['1', '3', '2'])
  })

  it('sorts sessions so the newest conversation stays first in UI state', () => {
    const sessions: ChatSession[] = [
      { id: 'older', title: 'Older', messages: [], createdAt: 100 },
      { id: 'newer', title: 'Newer', messages: [], createdAt: 200 },
      { id: 'missing', title: 'Missing timestamp', messages: [] }
    ]

    expect(sortSessionsByRecencyDesc(sessions).map((session) => session.id)).toEqual([
      'newer',
      'older',
      'missing'
    ])
  })

  it('keeps a pending local session when storage reloads before it is persisted', () => {
    const loadedSessions: ChatSession[] = [
      { id: 'older', title: 'Older', messages: [], createdAt: 100 }
    ]
    const localSessions: ChatSession[] = [
      {
        id: 'pending',
        title: 'Pending',
        messages: [{ role: 'user', content: '检查图片规范' }],
        createdAt: 200
      },
      loadedSessions[0]
    ]

    expect(
      mergeLoadedSessionsWithLocal(loadedSessions, localSessions, ['pending']).map(
        (session) => session.id
      )
    ).toEqual(['pending', 'older'])
  })

  it('does not resurrect unrelated missing local sessions during reloads', () => {
    const loadedSessions: ChatSession[] = [
      { id: 'older', title: 'Older', messages: [], createdAt: 100 }
    ]
    const localSessions: ChatSession[] = [
      { id: 'stale', title: 'Stale', messages: [], createdAt: 200 },
      loadedSessions[0]
    ]

    expect(
      mergeLoadedSessionsWithLocal(loadedSessions, localSessions).map((session) => session.id)
    ).toEqual(['older'])
  })
})

describe('normalizeRestoredSkillSelection', () => {
  const skills = [
    {
      id: 'art-normal',
      category: 'Art',
      skillName: 'Storyboard',
      prompt: 'Turn this into storyboard beats.',
      type: 'normal' as const
    },
    {
      id: 'ops-agent',
      category: 'Ops',
      skillName: 'Pipeline Agent',
      prompt: 'Focus on operational execution steps.',
      type: 'agent' as const,
      apiAddress: 'https://example.com/api/chat'
    }
  ]

  it('restores the persisted skill category after reopening a session', () => {
    expect(normalizeRestoredSkillSelection(skills, 'ops-agent')).toEqual({
      skillId: 'ops-agent',
      skillCategory: 'Ops'
    })
  })

  it('drops stale skill ids back to the no-skill state safely', () => {
    expect(normalizeRestoredSkillSelection(skills, 'missing-skill')).toEqual({
      skillId: null,
      skillCategory: NO_SKILL_VALUE
    })
  })
})

describe('chatSessionUtils session updaters', () => {
  const baseSessions: ChatSession[] = [
    {
      id: '1',
      title: 'Untitled',
      messages: []
    },
    {
      id: '2',
      title: 'Keep me',
      messages: [{ role: 'user', content: 'hello' }],
      sessionUrl: 'https://example.com/old'
    }
  ]

  it('applies a user message and derives the first title from the prompt', () => {
    const updated = applyUserMessageToSession(baseSessions, {
      sessionId: '1',
      userMessage: { role: 'user', content: 'Ask something important' },
      titleSource: 'Ask something important'
    })

    expect(updated[0].messages).toEqual([{ role: 'user', content: 'Ask something important' }])
    expect(updated[0].title).toBe('Ask something important')
    expect(updated[1]).toEqual(baseSessions[1])
  })

  it('clears any persisted draft once the user message is committed', () => {
    const sessionsWithDraft: ChatSession[] = [
      {
        id: '1',
        title: 'Untitled',
        messages: [],
        draft: {
          inputValue: 'unfinished prompt',
          pendingAttachments: [
            { type: 'file', url: 'file:///C:/draft.txt', fileName: 'draft.txt' }
          ],
          pendingHiddenContext: 'hidden',
          updatedAt: 123
        }
      }
    ]

    const updated = applyUserMessageToSession(sessionsWithDraft, {
      sessionId: '1',
      userMessage: { role: 'user', content: 'Send it now' },
      titleSource: 'Send it now'
    })

    expect(updated[0].draft).toBeUndefined()
    expect(updated[0].messages).toEqual([{ role: 'user', content: 'Send it now' }])
  })

  it('respects provided base messages when rebuilding an edited conversation', () => {
    const updated = applyUserMessageToSession(baseSessions, {
      sessionId: '2',
      baseMessages: [{ role: 'assistant', content: 'previous answer' }],
      userMessage: { role: 'user', content: 'rewrite it' },
      titleSource: 'rewrite it'
    })

    expect(updated[1].messages).toEqual([
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'rewrite it' }
    ])
    expect(updated[1].title).toBe('Keep me')
  })

  it('appends and removes an empty assistant placeholder', () => {
    const withPlaceholder = appendAssistantPlaceholderToSession(baseSessions, '2')

    expect(withPlaceholder[1].messages[withPlaceholder[1].messages.length - 1]).toEqual({
      role: 'assistant',
      content: ''
    })

    const cleaned = removeTrailingEmptyAssistantMessage(withPlaceholder, '2')
    expect(cleaned[1].messages).toEqual(baseSessions[1].messages)
  })

  it('appends streamed assistant deltas onto the placeholder message', () => {
    const withPlaceholder = appendAssistantPlaceholderToSession(baseSessions, '2')
    const withDelta = appendAssistantDeltaToSession(withPlaceholder, {
      sessionId: '2',
      delta: 'partial reply'
    })

    expect(withDelta[1].messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial reply' }
    ])
  })

  it('preserves the responding model on streamed assistant placeholders', () => {
    const withPlaceholder = appendAssistantPlaceholderToSession(baseSessions, '2', 'GPT-4o')
    const withDelta = appendAssistantDeltaToSession(withPlaceholder, {
      sessionId: '2',
      delta: 'partial reply'
    })

    expect(withDelta[1].messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial reply', modelName: 'GPT-4o' }
    ])
  })

  it('replaces the last message and keeps the session url in sync', () => {
    const withPlaceholder = appendAssistantPlaceholderToSession(baseSessions, '2')
    const updated = replaceLastMessageInSession(withPlaceholder, {
      sessionId: '2',
      message: { role: 'assistant', content: 'final answer' },
      sessionUrl: 'https://example.com/new'
    })

    expect(updated[1].messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'final answer' }
    ])
    expect(updated[1].sessionUrl).toBe('https://example.com/new')
  })

  it('clears the session url when a response explicitly disables continuation', () => {
    const withPlaceholder = appendAssistantPlaceholderToSession(baseSessions, '2')
    const updated = replaceLastMessageInSession(withPlaceholder, {
      sessionId: '2',
      message: { role: 'assistant', content: 'isolated answer' },
      sessionUrl: null
    })

    expect(updated[1].sessionUrl).toBeUndefined()
  })

  it('replaces the last placeholder with multiple assistant messages for batched replies', () => {
    const withPlaceholder = appendAssistantPlaceholderToSession(baseSessions, '2')
    const updated = replaceLastMessageWithMessagesInSession(withPlaceholder, {
      sessionId: '2',
      messages: [
        { role: 'assistant', content: 'reply A', preferredDownloadBaseName: 'a' },
        { role: 'assistant', content: 'reply B', preferredDownloadBaseName: 'b' }
      ],
      sessionUrl: 'https://example.com/batch'
    })

    expect(updated[1].messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'reply A', preferredDownloadBaseName: 'a' },
      { role: 'assistant', content: 'reply B', preferredDownloadBaseName: 'b' }
    ])
    expect(updated[1].sessionUrl).toBe('https://example.com/batch')
  })

  it('updates the session url without touching messages', () => {
    const updated = updateSessionUrl(baseSessions, '2', 'https://example.com/next')

    expect(updated[1].sessionUrl).toBe('https://example.com/next')
    expect(updated[1].messages).toEqual(baseSessions[1].messages)
  })
})
