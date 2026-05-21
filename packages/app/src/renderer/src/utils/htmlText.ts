const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

const decodeBasicHtmlEntities = (value: string): string =>
  value.replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (match, entity: string) => {
    switch (entity.toLowerCase()) {
      case 'nbsp':
        return ' '
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
      case '#39':
        return "'"
      default:
        return match
    }
  })

const stripHtmlWithoutDom = (html: string): string => {
  let text = ''
  let inTag = false

  for (const char of html) {
    if (char === '<') {
      inTag = true
      text += ' '
      continue
    }

    if (char === '>' && inTag) {
      inTag = false
      text += ' '
      continue
    }

    if (!inTag) {
      text += char
    }
  }

  return collapseWhitespace(decodeBasicHtmlEntities(text))
}

export function stripHtmlToText(html: string): string {
  const trimmed = html.trim()
  if (!trimmed) return ''

  if (typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(trimmed, 'text/html')
    document.querySelectorAll('script, style').forEach((element) => element.remove())
    return collapseWhitespace(document.body.textContent || '')
  }

  return stripHtmlWithoutDom(trimmed)
}
