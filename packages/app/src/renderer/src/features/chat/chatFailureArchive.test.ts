import { describe, expect, it } from 'vitest'
import {
  buildChatFailureArchivePayload,
  formatChatFailureMessage,
  readChatFailureArchiveRootDir,
  resolveChatFailureArchiveDir,
  resolveChatFailureArchiveRootDir,
  sanitizeChatFailureArchiveRunId
} from './chatFailureArchive'

describe('chatFailureArchive', () => {
  it('formats user-visible failure messages without changing blank messages', () => {
    expect(formatChatFailureMessage(' Failed ', 'run-1')).toBe('Failed (Run: run-1)')
    expect(formatChatFailureMessage('   ', 'run-1')).toBe('   ')
    expect(formatChatFailureMessage('Failed', null)).toBe('Failed')
    expect(formatChatFailureMessage('Failed', '../run/1')).toBe('Failed (Run: run-1)')
  })

  it('sanitizes archive run ids for filesystem path segments', () => {
    expect(sanitizeChatFailureArchiveRunId('../run/1:*?')).toBe('run-1')
    expect(sanitizeChatFailureArchiveRunId('   ')).toBe('unknown-run')
  })

  it('resolves archive roots with explicit input precedence', () => {
    expect(
      resolveChatFailureArchiveRootDir({
        localStorageOverride: ' D:/Downloads ',
        configDownloadDir: 'C:/Config',
        buildDataDir: 'C:/Build'
      })
    ).toBe('D:/Downloads')
    expect(
      resolveChatFailureArchiveRootDir({ configDownloadDir: '', buildDataDir: ' C:/Build ' })
    ).toBe('C:/Build')
    expect(resolveChatFailureArchiveRootDir({ configDownloadDir: '', buildDataDir: '' })).toBeNull()
  })

  it('reads archive roots defensively from local storage overrides', () => {
    expect(
      readChatFailureArchiveRootDir({
        configDownloadDir: 'C:/Config',
        storage: { getItem: () => 'E:/Override' }
      })
    ).toBe('C:/Config')
    expect(
      readChatFailureArchiveRootDir({
        configDownloadDir: 'C:/Config',
        storage: {
          getItem: () => {
            throw new Error('blocked')
          }
        }
      })
    ).toBe('C:/Config')
  })

  it('builds archive directories with injected path join or portable fallback', () => {
    expect(
      resolveChatFailureArchiveDir({
        baseDir: 'C:/Downloads/',
        runId: 'run-1'
      })
    ).toBe('C:/Downloads/chat-failures/run-1')
    expect(
      resolveChatFailureArchiveDir({
        baseDir: 'C:/Downloads',
        runId: '../run-1:*?',
        pathJoin: (...parts) => parts.join('\\')
      })
    ).toBe('C:/Downloads\\chat-failures\\run-1')
  })

  it('builds compact archive payloads with only persisted attachment metadata', () => {
    expect(
      buildChatFailureArchivePayload({
        sessionId: 'session-1',
        profileId: 'profile-1',
        skillId: 'skill-1',
        error: 'failed',
        timestamp: Date.UTC(2024, 0, 2, 3, 4, 5),
        userMessage: {
          role: 'user',
          content: 'hello',
          hiddenContext: 'secret',
          attachments: [
            {
              type: 'image',
              url: 'file:///image.png',
              fileName: 'image.png',
              mimeType: 'image/png',
              sizeBytes: 123,
              sourceWidth: 10,
              sourceHeight: 20,
              metadata: { omitted: true }
            }
          ]
        }
      })
    ).toEqual({
      runId: 'session-1',
      profileId: 'profile-1',
      skillId: 'skill-1',
      error: 'failed',
      createdAt: '2024-01-02T03:04:05.000Z',
      userMessage: {
        role: 'user',
        content: 'hello',
        attachments: [
          {
            type: 'image',
            url: '[redacted:local-file-url]',
            fileName: 'image.png',
            mimeType: 'image/png',
            sizeBytes: 123,
            sourceWidth: 10,
            sourceHeight: 20
          }
        ]
      }
    })
  })
})
