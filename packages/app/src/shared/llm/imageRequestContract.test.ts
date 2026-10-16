import { describe, expect, it } from 'vitest'
import {
  assertImageRequestBodyBytes,
  assertImageRequestPermission,
  buildImageRequestContract,
  IMAGE_REQUEST_CONTRACT_SCHEMA,
  IMAGE_REQUEST_CONTRACT_VERSION,
  IMAGE_REQUEST_MAX_TIMEOUT_MS,
  IMAGE_REQUEST_MIN_TIMEOUT_MS,
  resolveImageRequestTimeoutMs,
  throwIfImageRequestCancelled,
  validateImageRequestContract,
  validateImageRequestImageDescriptors
} from './imageRequestContract'

const limits = {
  maxImages: 2,
  maxBytesPerImage: 1024,
  maxTotalBytes: 1536,
  maxRequestBodyBytes: 4096
}

const messages = (count = 1, sizeBytes: number | undefined = 512) => [
  {
    role: 'user' as const,
    content: 'draw',
    attachments: Array.from({ length: count }, (_, index) => ({
      type: 'image' as const,
      url: `data:image/png;base64,${index}`,
      ...(sizeBytes === undefined ? {} : { sizeBytes })
    }))
  }
]

const validContract = () =>
  buildImageRequestContract({
    requestId: 'req-1',
    taskId: 'task-1',
    messages: messages(),
    imageHistoryPolicy: 'all',
    history: { historyRef: 'history-1', continuationRef: 'continuation-1' },
    limits,
    permission: { images: true, externalFetch: false },
    control: { timeoutMs: 30_000 }
  })

describe('image request contract', () => {
  it('builds a versioned IPC-safe contract without URL/session fields or signals', () => {
    const contract = validContract()
    expect(contract).toMatchObject({
      version: IMAGE_REQUEST_CONTRACT_VERSION,
      schema: IMAGE_REQUEST_CONTRACT_SCHEMA,
      requestId: 'req-1',
      taskId: 'task-1',
      action: 'continue',
      history: { historyRef: 'history-1', continuationRef: 'continuation-1' },
      limits,
      permission: { images: true, externalFetch: false },
      control: { timeoutMs: 30_000 }
    })
    expect(contract.history).not.toHaveProperty('sessionUrl')
    expect(contract.history).not.toHaveProperty('conversationId')
    expect(contract.control).not.toHaveProperty('signal')
  })

  it('rejects unsupported schema, URL-like opaque refs, and unknown image sizes', () => {
    expect(() =>
      validateImageRequestContract({ ...validContract(), schema: 'wrong' as never })
    ).toThrow('schema')
    expect(() =>
      validateImageRequestContract({
        ...validContract(),
        history: { historyRef: 'https://secret.example/session' }
      })
    ).toThrow('opaque reference')
    expect(() =>
      buildImageRequestContract({
        requestId: 'req-1',
        taskId: 'task-1',
        messages: [
          {
            role: 'user',
            content: 'draw',
            attachments: [{ type: 'image', url: 'data:image/png;base64,aW1hZ2U=' }]
          }
        ],
        limits,
        permission: { images: true, externalFetch: false }
      })
    ).toThrow('Image size is required')
    expect(() => validateImageRequestImageDescriptors([{ sizeBytes: undefined }], limits)).toThrow(
      'Image size is required'
    )
  })

  it('enforces image, aggregate, body, permission, and timeout limits', () => {
    expect(() => validateImageRequestImageDescriptors([{ sizeBytes: 1025 }], limits)).toThrow(
      'Image exceeds the 1024-byte decoded limit.'
    )
    expect(() =>
      validateImageRequestImageDescriptors([{ sizeBytes: 1024 }, { sizeBytes: 513 }], limits)
    ).toThrow('aggregate')
    expect(() => assertImageRequestBodyBytes(4097, limits)).toThrow('body')
    expect(() => assertImageRequestPermission({ images: false, externalFetch: false })).toThrow(
      'generation permission'
    )
    expect(() =>
      assertImageRequestPermission(
        { images: true, externalFetch: false },
        { requiresExternalFetch: true }
      )
    ).toThrow('External image fetch permission')
    expect(() =>
      resolveImageRequestTimeoutMs({ control: { timeoutMs: IMAGE_REQUEST_MIN_TIMEOUT_MS - 1 } })
    ).toThrow('timeoutMs')
    expect(resolveImageRequestTimeoutMs({ control: { timeoutMs: 30_000 } })).toBe(30_000)
    expect(resolveImageRequestTimeoutMs({})).toBe(IMAGE_REQUEST_MAX_TIMEOUT_MS)
  })

  it('provides a local-only cancellation helper', () => {
    const controller = new AbortController()
    expect(() => throwIfImageRequestCancelled(controller.signal)).not.toThrow()
    controller.abort()
    expect(() => throwIfImageRequestCancelled(controller.signal)).toThrowError(
      expect.objectContaining({ name: 'AbortError' })
    )
  })
})
