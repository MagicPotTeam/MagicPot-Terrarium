import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_IMAGE_DROP_MAX_FILES,
  EXTERNAL_IMAGE_DROP_MAX_INPUT_BYTES,
  EXTERNAL_IMAGE_DROP_MAX_URL_BYTES,
  normalizeExternalImageFileUrl,
  parseExternalImageDrop
} from './externalImageDrop'

const first = 'file:///C:/Lark%20Shell/sdk_storage/resources/images/first.jpg'
const second = 'file:///C:/Lark%20Shell/sdk_storage/resources/images/second.png'

describe('normalizeExternalImageFileUrl', () => {
  it.each([
    ['file:///c:/Lark Shell/a.jpg', 'file:///C:/Lark%20Shell/a.jpg'],
    ['FILE:///C:/Lark%20Shell/a.JPEG', 'file:///C:/Lark%20Shell/a.JPEG'],
    [
      'file:///C:/\u56fe\u7247/\u539f\u56fe.png',
      'file:///C:/%E5%9B%BE%E7%89%87/%E5%8E%9F%E5%9B%BE.png'
    ],
    ['file:///C:/Lark Shell/100% image.webp', 'file:///C:/Lark%20Shell/100%25%20image.webp'],
    ['file:///C:/Lark%20Shell/100%25%20image.webp', 'file:///C:/Lark%20Shell/100%25%20image.webp'],
    ['file:///C:/literal%2520name.gif', 'file:///C:/literal%2520name.gif'],
    ['file:///C:/literal%252fslash.png', 'file:///C:/literal%252fslash.png'],
    ['file:///C:/literal%23hash.png', 'file:///C:/literal%23hash.png'],
    [
      "file:///C:/Lark Shell/user's (original).png",
      'file:///C:/Lark%20Shell/user%27s%20%28original%29.png'
    ],
    ['file:///Users/example/Lark Shell/first.png', 'file:///Users/example/Lark%20Shell/first.png']
  ])('canonicalizes %s without decoding filename escapes twice', (input, expected) => {
    expect(normalizeExternalImageFileUrl(input)).toBe(expected)
    expect(normalizeExternalImageFileUrl(expected)).toBe(expected)
  })

  it.each([
    undefined,
    null,
    5,
    {},
    '',
    'https://example.test/image.png',
    'http://example.test/image.jpg',
    'data:image/png;base64,AAAA',
    'blob:local/image.png',
    'local-media:///C:/image.png',
    'C:\\cache\\image.png',
    'file:/C:/image.png',
    'file://C:/image.png',
    'file://localhost/C:/image.png',
    'file://server/share/image.png',
    'file:////server/share/image.png',
    'file:///\\server/share/image.png',
    'file:///C:/image.svg',
    'file:///C:/image.bmp',
    'file:///C:/image.avif',
    'file:///C:/image.heic',
    'file:///C:/image.tiff',
    'file:///C:/notes.txt',
    'file:///C:/image.png.exe',
    'file:///C:/image.png?query=1',
    'file:///C:/image.png#fragment',
    'file:///C:/image%00.png',
    'file:///C:/image\u0000.png',
    'file:///C:/image\t.png',
    'file:///C:/image%0a.png',
    'file:///C:/image%7f.png',
    'file:///C:/image\u202e.png',
    'file:///C:/image%EF%BF%BD%FF.png',
    'file:///C:/image\ud800.png',
    'file:///C:/cache%2fimage.png',
    'file:///C:/cache%5cimage.png',
    'file:///C:/cache//image.png',
    'file:///C:/cache/../image.png',
    'file:///C:/cache/%2e%2e/image.png',
    'file:///C:/cache/./image.png',
    'file:///C:/cache./image.png',
    'file:///C:/cache%20/image.png',
    'file:///C:/image.png%20',
    'file:///C:/source.txt:image.png',
    'file:///C:/source.txt%3Aimage.png',
    'file:///C:/CON/image.png',
    'file:///C:/con.png',
    'file:///C:/NUL .jpg',
    'file:///C:/com1.png',
    'file:///C:/LPT\u00b9.png',
    'file:///C:/CONOUT$.png',
    'file:///C:/CLOCK$.png',
    'file:///C:/image?.png',
    'file:///C:/image*.png',
    'file:///C:/image%3C.png',
    'file:///C:/image%7C.png',
    'file:///dev/image.png',
    'file:///proc/image.png',
    'file:///sys/image.png'
  ])('rejects unsafe or unsupported source %s', (input) => {
    expect(normalizeExternalImageFileUrl(input)).toBeUndefined()
  })

  it('bounds raw, UTF-8 and canonical URL lengths', () => {
    const prefix = 'file:///C:/'
    const exact = `${prefix}${'a'.repeat(EXTERNAL_IMAGE_DROP_MAX_URL_BYTES - prefix.length - 4)}.png`
    expect(normalizeExternalImageFileUrl(exact)).toBe(exact)
    expect(normalizeExternalImageFileUrl(exact.replace('.png', 'a.png'))).toBeUndefined()
    expect(normalizeExternalImageFileUrl(`file:///C:/${'\u56fe'.repeat(6000)}.png`)).toBeUndefined()
    expect(normalizeExternalImageFileUrl(`file:///C:/${' '.repeat(6000)}a.png`)).toBeUndefined()
  })
})

describe('parseExternalImageDrop', () => {
  it('recognizes a Lark cache path containing raw spaces and Unicode', () => {
    expect(
      parseExternalImageDrop({
        plainText:
          'file:///C:/Users/example/AppData/Roaming/Lark Shell/sdk_storage/resources/images/\u539f\u56fe.jpg'
      })
    ).toEqual({
      fileUrls: [
        'file:///C:/Users/example/AppData/Roaming/Lark%20Shell/sdk_storage/resources/images/%E5%8E%9F%E5%9B%BE.jpg'
      ],
      text: ''
    })
  })

  it.each([
    'file:///C:/cache/report.png final.jpg',
    'file:///C:/cache/name.png folder/actual.jpg',
    "file:///C:/cache/user's photo.jpg"
  ])('keeps the exact complete raw path rather than an image-looking prefix: %s', (raw) => {
    const canonical = normalizeExternalImageFileUrl(raw)!
    expect(parseExternalImageDrop({ plainText: raw })).toEqual({ fileUrls: [canonical], text: '' })
    expect(
      parseExternalImageDrop({
        plainText: raw,
        uriList: canonical,
        html: `<img src="${canonical}">`
      })
    ).toEqual({ fileUrls: [canonical], text: '' })
  })

  it('uses structured metadata to disambiguate a raw-space path embedded in prose', () => {
    const raw = 'file:///C:/cache/report.png final.jpg'
    const canonical = normalizeExternalImageFileUrl(raw)!
    expect(
      parseExternalImageDrop({
        plainText: `Compare ${raw} carefully.`,
        uriList: canonical
      })
    ).toEqual({ fileUrls: [canonical], text: 'Compare  carefully.' })
    expect(
      parseExternalImageDrop({
        plainText: `Compare ${raw} carefully.`
      })
    ).toEqual({ fileUrls: [], text: `Compare ${raw} carefully.` })
  })

  it('recognizes multiple URI-list lines, ignores comments, and deduplicates formats', () => {
    expect(
      parseExternalImageDrop({
        uriList: `# Lark selection\r\n${first}\r\n  # comment ${second}\r${second}\n${first}`,
        plainText: `${first}\n${second}`,
        html: `<img src="${first}"><a href="${second}">preview</a>`
      })
    ).toEqual({ fileUrls: [first, second], text: '' })
  })

  it('does not interpret file references from URI-list comments', () => {
    expect(
      parseExternalImageDrop({ uriList: `# ${first}\nhttps://example.test/image.png` })
    ).toEqual({ fileUrls: [], text: 'https://example.test/image.png' })
  })

  it('keeps surrounding prose and ordinary HTTP links', () => {
    const plainText = `Please compare these.\n${first}\nKeep colors. https://example.test/image.png\n${second}`
    expect(parseExternalImageDrop({ plainText })).toEqual({
      fileUrls: [first, second],
      text: 'Please compare these.\n\nKeep colors. https://example.test/image.png'
    })
    expect(parseExternalImageDrop({ plainText: `Inspect (${first}), then continue.` })).toEqual({
      fileUrls: [first],
      text: 'Inspect (), then continue.'
    })
  })

  it('preserves non-image prose exactly, including whitespace', () => {
    const plainText = '  Keep my draft\n and indentation.\t '
    expect(parseExternalImageDrop({ plainText })).toEqual({ fileUrls: [], text: plainText })
  })

  it.each([
    'file:///C:/image.png.exe',
    'file:///C:/image.png final.txt',
    'file:///C:/image.png folder/notes.txt',
    'file:///C:/image.png trailing',
    'file:///C:/image.png?token=1',
    'file:///C:/image.png#fragment',
    'file:///C:/image.png%00.txt',
    'file:///C:/image.png\u0000.jpg',
    'file:///C:/image.png/../second.jpg',
    'file:///C:/cache%2fimage.png',
    'file://server/share/image.png',
    'file:////server/share/image.png',
    'file:///C:/NUL.png',
    'file:///C:/source.txt:image.png',
    'https://example.test/file:///C:/image.png',
    'prefixfile:///C:/image.png'
  ])('does not partially strip a malformed or unsupported reference %s', (plainText) => {
    expect(parseExternalImageDrop({ plainText })).toEqual({ fileUrls: [], text: plainText })
  })

  it('reads inert HTML img/src and a/href attributes, including entities', () => {
    expect(
      parseExternalImageDrop({
        html: [
          '<p>Compare &amp; explain.</p>',
          '<IMG alt="preview" SRC="file:///C:/Lark&#32;Shell/a&amp;b.png">',
          `<a href='${second}'>Original image</a>`,
          '<p>Keep &#x6362;&#34892; text.</p>'
        ].join('')
      })
    ).toEqual({
      fileUrls: ['file:///C:/Lark%20Shell/a%26b.png', second],
      text: 'Compare & explain.\nOriginal image\nKeep \u6362\u884c text.'
    })
  })

  it('preserves plain prose when HTML contains the image-only flavor', () => {
    expect(
      parseExternalImageDrop({
        plainText: 'Compare the original image.',
        html: `<img src="${first}" onerror="runUntrustedCode()">`
      })
    ).toEqual({ fileUrls: [first], text: 'Compare the original image.' })
  })

  it('does not execute, fetch, or extract attributes from active HTML containers', () => {
    const html = [
      `<!-- <img src="${first}"> -->`,
      ...['script', 'style', 'iframe', 'object', 'template'].map(
        (name) => `<${name}><img src="${first}"></${name}>`
      ),
      `<div data-src="${first}" style="background:url(${first})">Safe body</div>`,
      `<img src="https://example.test/image.png">`,
      `<a href="file:///C:/notes.txt">Notes</a>`,
      `<img src="${first}" src="${second}">`
    ].join('')
    expect(parseExternalImageDrop({ html })).toEqual({ fileUrls: [], text: 'Safe body\nNotes' })
  })

  it('handles malformed HTML without throwing or scanning a quoted attribute as a new tag', () => {
    expect(
      parseExternalImageDrop({ html: `<div title='<img src="${first}">'>Body</div>` })
    ).toEqual({ fileUrls: [], text: 'Body' })
    expect(parseExternalImageDrop({ html: '<img src="unterminated' })).toEqual({
      fileUrls: [],
      text: '<img src="unterminated'
    })
  })

  it('does not mistake raw-text content or a prefix closing tag for an image element', () => {
    for (const name of [
      'script',
      'style',
      'textarea',
      'title',
      'xmp',
      'noembed',
      'noframes',
      'noscript'
    ]) {
      const html = `<${name}></${name}suffix><img src="${first}"></${name}><p>Visible</p>`
      expect(parseExternalImageDrop({ html })).toEqual({ fileUrls: [], text: 'Visible' })
    }
  })

  it('does not turn malformed or escaped HTML markup into new path grants', () => {
    const malformed = `<img src="${first}`
    expect(parseExternalImageDrop({ html: malformed })).toEqual({ fileUrls: [], text: malformed })
    const escaped = `&lt;img src=&quot;${first}&quot;&gt;`
    expect(parseExternalImageDrop({ html: escaped })).toEqual({
      fileUrls: [],
      text: `<img src="${first}">`
    })
  })

  it('fails closed on excess image count without stripping the original prose', () => {
    const plainText = Array.from(
      { length: EXTERNAL_IMAGE_DROP_MAX_FILES + 1 },
      (_, index) => `file:///C:/images/${index}.png`
    ).join('\n')
    expect(parseExternalImageDrop({ plainText })).toEqual({ fileUrls: [], text: plainText })
    const accepted = plainText.split('\n').slice(0, EXTERNAL_IMAGE_DROP_MAX_FILES).join('\n')
    expect(parseExternalImageDrop({ plainText: accepted })).toEqual({
      fileUrls: accepted.split('\n'),
      text: ''
    })
  })

  it('bounds all input flavors together before parsing any of them', () => {
    const plainText = `Keep this. ${first}`
    const html = ' '.repeat(EXTERNAL_IMAGE_DROP_MAX_INPUT_BYTES - plainText.length)
    expect(parseExternalImageDrop({ plainText, html }).fileUrls).toEqual([first])
    expect(parseExternalImageDrop({ plainText, html: `${html} ` })).toEqual({
      fileUrls: [],
      text: plainText
    })
    expect(
      parseExternalImageDrop({
        plainText,
        html: '\u56fe'.repeat(EXTERNAL_IMAGE_DROP_MAX_INPUT_BYTES / 2)
      })
    ).toEqual({ fileUrls: [], text: plainText })
  })

  it('does not guess among many extension endpoints in unstructured mixed text', () => {
    const plainText = `Inspect file:///C:/cache/${'part.png '.repeat(20)}tail.jpg now.`
    expect(parseExternalImageDrop({ plainText })).toEqual({ fileUrls: [], text: plainText })
  })
})
