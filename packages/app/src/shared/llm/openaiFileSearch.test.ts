import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAIFileSearchSession } from './openaiFileSearch'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('createOpenAIFileSearchSession', () => {
  it('uses the injected fetch implementation for file-search network operations', async () => {
    const injectedFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'file-injected' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'vs-injected' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'vs-file-injected' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ file_id: 'file-injected', status: 'completed' }]
        })
      })

    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)

    const session = await createOpenAIFileSearchSession({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      messages: [
        {
          role: 'user',
          content: 'Analyze this file.',
          attachments: [
            {
              type: 'file',
              url: 'data:text/plain;base64,aGVsbG8=',
              fileName: 'note.txt',
              mimeType: 'text/plain'
            }
          ]
        }
      ],
      fetchImpl: injectedFetch as typeof fetch
    })

    expect(session?.vectorStoreIds).toEqual(['vs-injected'])
    expect(injectedFetch).toHaveBeenCalledTimes(4)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('cleans up uploaded resources even after the caller aborts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'file-1' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'vs-1' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'vs-file-1' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ file_id: 'file-1', status: 'completed' }]
        })
      })
      .mockResolvedValueOnce({
        ok: true
      })
      .mockResolvedValueOnce({
        ok: true
      })

    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    const session = await createOpenAIFileSearchSession({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      messages: [
        {
          role: 'user',
          content: 'Analyze this file.',
          attachments: [
            {
              type: 'file',
              url: 'data:text/plain;base64,aGVsbG8=',
              fileName: 'note.txt',
              mimeType: 'text/plain'
            }
          ]
        }
      ],
      signal: controller.signal
    })

    expect(session).not.toBeNull()

    controller.abort('user cancelled')
    await session?.cleanup()

    expect(fetchMock).toHaveBeenNthCalledWith(5, 'https://api.openai.com/v1/vector_stores/vs-1', {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer sk-test'
      }
    })
    expect(fetchMock).toHaveBeenNthCalledWith(6, 'https://api.openai.com/v1/files/file-1', {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer sk-test'
      }
    })
  })
})
