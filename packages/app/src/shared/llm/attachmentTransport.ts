import type { ChatProfileCapabilities, ProviderAttachmentTransport } from './profileCapabilities'

export type AttachmentTransportAvailability = Partial<Record<ProviderAttachmentTransport, boolean>>

export type SelectAttachmentTransportOptions = {
  available: AttachmentTransportAvailability
  requested?: ProviderAttachmentTransport
}

const ATTACHMENT_TRANSPORT_PRIORITY: readonly ProviderAttachmentTransport[] = [
  'file-id',
  'multipart',
  'accessible-url',
  'request-data-url'
]

export const selectProviderAttachmentTransport = (
  capabilities: Pick<
    ChatProfileCapabilities,
    'attachmentTransports' | 'preferredAttachmentTransport'
  >,
  options: SelectAttachmentTransportOptions
): ProviderAttachmentTransport | undefined => {
  const supported = new Set(capabilities.attachmentTransports)
  const canUse = (transport: ProviderAttachmentTransport): boolean =>
    supported.has(transport) && options.available[transport] === true

  if (options.requested) {
    return canUse(options.requested) ? options.requested : undefined
  }

  if (
    capabilities.preferredAttachmentTransport &&
    canUse(capabilities.preferredAttachmentTransport)
  ) {
    return capabilities.preferredAttachmentTransport
  }

  return ATTACHMENT_TRANSPORT_PRIORITY.find(canUse)
}
