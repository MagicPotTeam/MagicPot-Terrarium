export const EXTERNAL_IMAGE_DROP_MAX_FILES = 8
export const EXTERNAL_IMAGE_DROP_MAX_URL_BYTES = 16 * 1024
export const EXTERNAL_IMAGE_DROP_MAX_INPUT_BYTES = 128 * 1024

export type ExternalImageDropInput = {
  plainText?: string
  uriList?: string
  html?: string
}
export type ExternalImageDropContent = { fileUrls: string[]; text: string }

const imageExtension = /\.(?:png|jpe?g|webp|gif)$/i
// eslint-disable-next-line no-control-regex -- Reject controls in untrusted path metadata.
const unsafeCharacter = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/
const utf8Bytes = (text: string): number => {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
  }
  return bytes
}

/** Pure syntax recognition only. Neither a URL nor an extension grants file access. */
export function normalizeExternalImageFileUrl(input: unknown): string | undefined {
  if (
    typeof input !== 'string' ||
    !input ||
    input.length > EXTERNAL_IMAGE_DROP_MAX_URL_BYTES ||
    utf8Bytes(input) > EXTERNAL_IMAGE_DROP_MAX_URL_BYTES ||
    unsafeCharacter.test(input) ||
    !/^file:\/\/\/(?!\/)/i.test(input) ||
    /[\\?#]/.test(input) ||
    /%(?:2f|5c)/i.test(input)
  )
    return undefined
  let pathname: string
  try {
    // Escape literal percent signs, then decode exactly once. "%2520" remains
    // a literal "%20" filename component rather than becoming a space later.
    pathname = decodeURIComponent(
      input.slice('file://'.length).replace(/%(?![a-f0-9]{2})/gi, '%25')
    )
  } catch {
    return undefined
  }
  if (unsafeCharacter.test(pathname) || /[\\<>"|?*]/.test(pathname) || pathname.includes('//'))
    return undefined
  const segments = pathname.slice(1).split('/')
  const windows = /^[a-z]:$/i.test(segments[0])
  if (
    !segments.length ||
    segments.some(
      (segment, index) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[. ]$/.test(segment) ||
        (segment.includes(':') && !(windows && index === 0)) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:[ .]|$)/i.test(
          segment
        )
    )
  )
    return undefined
  if (!windows && /^(?:dev|proc|sys)$/i.test(segments[0])) return undefined
  if (!imageExtension.test(segments.at(-1)!)) return undefined
  if (windows) segments[0] = segments[0].toUpperCase()
  const encode = (segment: string) =>
    encodeURIComponent(segment).replace(
      /[!'()*]/g,
      (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase()
    )
  try {
    const canonical =
      'file:///' +
      segments
        .map((segment, index) => (windows && index === 0 ? segment : encode(segment)))
        .join('/')
    return utf8Bytes(canonical) <= EXTERNAL_IMAGE_DROP_MAX_URL_BYTES ? canonical : undefined
  } catch {
    return undefined
  }
}

const decodeHtml = (text: string): string =>
  text.replace(
    /&(?:#(\d{1,7})|#x([a-f0-9]{1,6})|(amp|quot|apos|lt|gt|nbsp));/gi,
    (
      all,
      decimal: string | undefined,
      hexadecimal: string | undefined,
      named: string | undefined
    ) => {
      if (named)
        return (
          { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' } as Record<
            string,
            string
          >
        )[named.toLowerCase()]
      const code = Number.parseInt(decimal ?? hexadecimal!, decimal ? 10 : 16)
      return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : all
    }
  )

function readHtml(html: string, add: (url: string) => void): string {
  let cursor = 0
  let body = ''
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor)
    if (start < 0) {
      body += html.slice(cursor)
      break
    }
    body += html.slice(cursor, start)
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4)
      cursor = end < 0 ? html.length : end + 3
      continue
    }
    let end = start + 1
    let quote = ''
    for (; end < html.length; end++) {
      const char = html[end]
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    if (end === html.length) {
      body += html.slice(start)
      break
    }
    const tag = html.slice(start, end + 1)
    cursor = end + 1
    const head = /^<\s*(\/?)\s*([a-z][a-z0-9-]*)\b/i.exec(tag)
    if (!head) {
      body += tag
      continue
    }
    const name = head[2].toLowerCase()
    if (
      !head[1] &&
      [
        'script',
        'style',
        'iframe',
        'object',
        'template',
        'textarea',
        'title',
        'xmp',
        'noembed',
        'noframes',
        'noscript'
      ].includes(name)
    ) {
      const closingTag = new RegExp(`</${name}(?=[\\s/>])[^>]*>`, 'gi')
      closingTag.lastIndex = cursor
      const close = closingTag.exec(html)
      cursor = close ? close.index + close[0].length : html.length
      continue
    }
    if (!head[1] && (name === 'img' || name === 'a')) {
      const wanted = name === 'img' ? 'src' : 'href'
      const attributes = tag.slice(head[0].length, -1)
      const attribute = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
      const matches: string[] = []
      for (const match of attributes.matchAll(attribute)) {
        if (match[1].toLowerCase() === wanted) matches.push(match[2] ?? match[3] ?? match[4] ?? '')
      }
      if (matches.length === 1) {
        const url = normalizeExternalImageFileUrl(decodeHtml(matches[0]))
        if (url) add(url)
      }
    }
    if (['br', 'p', 'div', 'li', 'tr'].includes(name)) body += '\n'
  }
  return decodeHtml(body)
}

function stripLocalImageReferences(
  text: string,
  structuredUrls: ReadonlySet<string>,
  add: (url: string) => void,
  allowUnstructured: boolean
): string {
  let removed = false
  const output = text.replace(/[^\r\n]+/g, (line) => {
    // A raw Lark path may contain both spaces and image extensions in directory
    // or file names. Never authorize a shorter prefix of that complete path.
    const whole = normalizeExternalImageFileUrl(line.trim())
    if (whole && (allowUnstructured || structuredUrls.has(whole))) {
      removed = true
      add(whole)
      return ''
    }
    const starts = [...line.matchAll(/file:\/\/\//gi)]
    let cursor = 0
    let result = ''
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index].index!
      if (start > 0 && !/[\s"'(<[{\uFF1A]/.test(line[start - 1])) continue
      const next = starts[index + 1]?.index ?? line.length
      const tail = line.slice(start, Math.min(next, start + EXTERNAL_IMAGE_DROP_MAX_URL_BYTES + 1))
      const stop = tail.search(/[\t<>"'`]/)
      const span = stop < 0 ? tail : tail.slice(0, stop)
      const endings =
        /\.(?:png|jpe?g|webp|gif)(?=$|[\s),;\]}\u3002\uff0c\uff1b\uff09]|\.(?![a-z0-9]))/gi
      const candidates: { url: string; end: number }[] = []
      let checked = 0
      for (const ending of span.matchAll(endings)) {
        if (++checked > 16) break
        const end = ending.index! + ending[0].length
        if (end === span.length && stop < 0 && start + end < next) continue
        const url = normalizeExternalImageFileUrl(span.slice(0, end))
        if (url) candidates.push({ url, end })
      }
      if (checked > 16) continue
      // Structured drop metadata can disambiguate an embedded raw-space path;
      // otherwise refuse multiple plausible endpoints rather than guess a file.
      const known = candidates.filter(({ url }) => structuredUrls.has(url))
      const wholeLineReference = starts.length === 1 && /^\s*file:\/\/\//i.test(line)
      const chosen =
        known.at(-1) ??
        (allowUnstructured && !wholeLineReference && candidates.length === 1
          ? candidates[0]
          : undefined)
      if (!chosen) continue
      add(chosen.url)
      removed = true
      result += line.slice(cursor, start)
      cursor = start + chosen.end
    }
    return result + line.slice(cursor)
  })
  return removed ? output.trim() : output
}

/** Bounded, inert drop metadata parsing; preserve text whenever recognition is refused. */
export function parseExternalImageDrop(input: ExternalImageDropInput): ExternalImageDropContent {
  const plainText = typeof input?.plainText === 'string' ? input.plainText : ''
  const uriList = typeof input?.uriList === 'string' ? input.uriList : ''
  const html = typeof input?.html === 'string' ? input.html : ''
  const fields = [plainText, uriList, html]
  if (
    fields.reduce((sum, text) => sum + text.length, 0) > EXTERNAL_IMAGE_DROP_MAX_INPUT_BYTES ||
    fields.reduce((sum, text) => sum + utf8Bytes(text), 0) > EXTERNAL_IMAGE_DROP_MAX_INPUT_BYTES
  )
    return { fileUrls: [], text: plainText || uriList || html }
  const urls = new Set<string>()
  let overflow = false
  const add = (url: string) => {
    if (!urls.has(url) && urls.size === EXTERNAL_IMAGE_DROP_MAX_FILES) overflow = true
    else urls.add(url)
  }
  const htmlText = readHtml(html, add).trim()
  const uriText = uriList
    .split(/\r\n?|\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  for (const line of uriText.split('\n')) {
    const url = normalizeExternalImageFileUrl(line.trim())
    if (url) add(url)
  }
  const originalText = plainText || htmlText || uriText
  const text = stripLocalImageReferences(originalText, new Set(urls), add, Boolean(plainText))
  if (overflow) return { fileUrls: [], text: originalText }
  return { fileUrls: [...urls], text }
}
