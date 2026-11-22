import { describe, expect, it } from 'vitest'
import { formatToolSearchExcerpt } from './toolSearchExcerpt'

describe('source-coordinate tool search redaction', () => {
  it('keeps Basic/header credential prefixes outside the excerpt in redaction context', () => {
    const source = 'Authorization: Basic ' + 'PRIVATE'.repeat(100) + '\nmatching receipt'
    const start = source.indexOf('matching') - 100
    expect(formatToolSearchExcerpt(source, start).text).not.toContain('PRIVATE')
    expect(formatToolSearchExcerpt(source, start).text).toContain('matching receipt')
  })
  it('masks a quoted secret through a cropped right edge, including spaces and escaped quotes', () => {
    const source = '{"password":"alpha beta ' + 'PRIVATE \\" CONTINUED '.repeat(100) + '"}'
    const result = formatToolSearchExcerpt(source, 0)
    expect(result.text).not.toMatch(/alpha|beta|PRIVATE|CONTINUED/)
    expect(result.text.length).toBeLessThanOrEqual(500)
    expect(source).toContain('PRIVATE')
  })
  it('omits unknown left context and nested sensitive containers instead of leaking a suffix', () => {
    expect(formatToolSearchExcerpt('Authorization: Basic ' + 'PRIVATE'.repeat(2000), 10000)).toMatchObject({ omitted: true })
    expect(formatToolSearchExcerpt('{"credentials":{"nested":"PRIVATE"}}', 0)).toMatchObject({ omitted: true })
  })
  it('omits nested or escaped JSON credentials even when the sensitive parent key is on a previous line', () => {
    const source = '{"credentials": {\n"publicLookingKey": "PRIVATE_NESTED"\n}}'
    expect(formatToolSearchExcerpt(source, source.indexOf('PRIVATE'))).toMatchObject({ omitted: true })
    expect(formatToolSearchExcerpt('{"\\u0070assword":"PRIVATE_ESCAPED"}', 0)).toMatchObject({ omitted: true })
    expect(formatToolSearchExcerpt('{"safe":"' + 'x'.repeat(70000) + '"}', 40000)).toMatchObject({ omitted: true })
  })
  it('masks URL credentials even when their trailing at-sign is beyond the right context', () => {
    const source = 'https://user:' + 'PRIVATE'.repeat(500) + '@example.com'
    expect(formatToolSearchExcerpt(source, 0).text).not.toContain('PRIVATE')
  })
  it('masks a trailing escape at the right context boundary and never falls back to the first word', () => {
    const source = 'password="prefix ' + 'a'.repeat(183) + 'EXPOSED' + 'a'.repeat(1004) + '\\"tail"'
    expect(formatToolSearchExcerpt(source, 200, 500).text).not.toContain('EXPOSED')
    const escaped = 'password="alpha \\" PRIVATE_AFTER_QUOTE"\npublic'
    expect(formatToolSearchExcerpt(escaped, 0).text).not.toContain('PRIVATE_AFTER_QUOTE')
    expect(formatToolSearchExcerpt(escaped, 0).text).toContain('public')
  })
  it('omits excessive leading whitespace and credentials in escaped JSON string values', () => {
    expect(formatToolSearchExcerpt(' '.repeat(1025) + '{"password":"PRIVATE"}', 1025).omitted).toBe(true)
    expect(formatToolSearchExcerpt('{"safe":"https:\\/\\/user:PRIVATE@example.com"}', 0).text).not.toContain('PRIVATE')
  })
  it('keeps known URL/cookie/key forms masked and safe text intact', () => {
    const source = 'Cookie: one=PRIVATE; two=PRIVATE\nhttps://user:PRIVATE@example.com?token=PRIVATE&safe=ok\napi_key="PRIVATE more"\npublic receipt'
    const result = formatToolSearchExcerpt(source, 0)
    expect(result.text).not.toContain('PRIVATE'); expect(result.text).toContain('public receipt')
    expect(formatToolSearchExcerpt('safe plain result', 0)).toEqual({ text: 'safe plain result', omitted: false })
  })
})
