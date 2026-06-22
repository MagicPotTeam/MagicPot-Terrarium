const BLOCKED_URL_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:'])
const URL_ATTRIBUTES = new Set(['action', 'formaction', 'href', 'poster', 'src', 'xlink:href'])
const DISALLOWED_ELEMENTS = new Set([
  'base',
  'embed',
  'iframe',
  'link',
  'meta',
  'object',
  'script',
  'template'
])

const stripProtocolNoise = (value: string): string =>
  Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 0x20 && !(code >= 0x7f && code <= 0x9f)
    })
    .join('')

const getUrlProtocol = (value: string): string | null => {
  const withoutControlChars = stripProtocolNoise(value)

  try {
    return new URL(withoutControlChars, window.location.href).protocol.toLowerCase()
  } catch {
    const protocolMatch = withoutControlChars.match(/^([a-zA-Z][\w+.-]*):/)
    return protocolMatch?.[1] ? `${protocolMatch[1].toLowerCase()}:` : null
  }
}

export const sanitizeHtmlOverlayContent = (html: string): string => {
  if (typeof document === 'undefined') {
    // HTML overlays are renderer-only. Without the DOM parser, fail closed instead
    // of relying on regex-based sanitization that can be bypassed by malformed HTML.
    return ''
  }

  const template = document.createElement('template')
  template.innerHTML = html

  const nodes = Array.from(template.content.querySelectorAll('*'))
  for (const node of nodes) {
    const element = node as HTMLElement
    if (DISALLOWED_ELEMENTS.has(element.tagName.toLowerCase())) {
      element.remove()
      continue
    }

    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase()
      const attributeValue = attribute.value.trim()

      if (attributeName.startsWith('on')) {
        element.removeAttribute(attribute.name)
        continue
      }

      if (URL_ATTRIBUTES.has(attributeName)) {
        const protocol = getUrlProtocol(attributeValue)
        if (protocol && BLOCKED_URL_PROTOCOLS.has(protocol)) {
          element.removeAttribute(attribute.name)
        }
      }
    }
  }

  return template.innerHTML
}
