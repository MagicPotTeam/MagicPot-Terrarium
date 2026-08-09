import { describe, expect, it } from 'vitest'
import { selectProviderAttachmentTransport } from './attachmentTransport'
import { resolveChatProfileCapabilities } from './profileCapabilities'

describe('provider attachment transport capabilities', () => {
  it('defaults to no transport and never infers a Data URL fallback', () => {
    const capabilities = resolveChatProfileCapabilities({ provider: 'openai' })

    expect(capabilities.attachmentTransports).toEqual([])
    expect(
      selectProviderAttachmentTransport(capabilities, {
        available: { 'request-data-url': true }
      })
    ).toBeUndefined()
  })

  it('normalizes explicit declarations and ignores unknown or invalid preferences', () => {
    const capabilities = resolveChatProfileCapabilities({
      attachment_transports: ['MULTIPART', 'file-id', 'multipart', 'base64'],
      preferred_attachment_transport: 'request-data-url'
    })

    expect(capabilities.attachmentTransports).toEqual(['multipart', 'file-id'])
    expect(capabilities.preferredAttachmentTransport).toBeUndefined()
  })

  it('selects file ID then multipart then accessible URL deterministically', () => {
    const capabilities = resolveChatProfileCapabilities({
      attachmentTransports: ['accessible-url', 'multipart', 'file-id']
    })

    expect(
      selectProviderAttachmentTransport(capabilities, {
        available: { 'file-id': true, multipart: true, 'accessible-url': true }
      })
    ).toBe('file-id')
    expect(
      selectProviderAttachmentTransport(capabilities, {
        available: { multipart: true, 'accessible-url': true }
      })
    ).toBe('multipart')
    expect(
      selectProviderAttachmentTransport(capabilities, {
        available: { 'accessible-url': true }
      })
    ).toBe('accessible-url')
  })

  it('uses an explicitly declared preference before standard priority', () => {
    const capabilities = resolveChatProfileCapabilities({
      attachment_transports: ['file-id', 'accessible-url'],
      preferred_attachment_transport: 'accessible-url'
    })

    expect(
      selectProviderAttachmentTransport(capabilities, {
        available: { 'file-id': true, 'accessible-url': true }
      })
    ).toBe('accessible-url')
  })

  it('does not fall back when an explicitly requested transport is unavailable', () => {
    const capabilities = resolveChatProfileCapabilities({
      attachment_transports: ['file-id', 'request-data-url']
    })

    expect(
      selectProviderAttachmentTransport(capabilities, {
        requested: 'file-id',
        available: {
          'file-id': false,
          'request-data-url': true
        }
      })
    ).toBeUndefined()
  })

  it('allows request-scoped Data URLs only when declared, available, and selected', () => {
    const capabilities = resolveChatProfileCapabilities({
      attachment_transports: ['request-data-url']
    })

    expect(
      selectProviderAttachmentTransport(capabilities, {
        available: { 'request-data-url': false }
      })
    ).toBeUndefined()
    expect(
      selectProviderAttachmentTransport(capabilities, {
        available: { 'request-data-url': true },
        requested: 'request-data-url'
      })
    ).toBe('request-data-url')
  })

  it('does not silently fall back when a requested mode is unusable', () => {
    const capabilities = resolveChatProfileCapabilities({
      attachment_transports: ['file-id', 'multipart']
    })

    expect(
      selectProviderAttachmentTransport(capabilities, {
        available: { 'file-id': true },
        requested: 'multipart'
      })
    ).toBeUndefined()
  })
})
