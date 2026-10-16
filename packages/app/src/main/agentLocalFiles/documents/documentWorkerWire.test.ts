import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_REQUEST_BASE64_CHARS,
  DOCUMENT_REQUEST_DECODED_BYTES,
  DOCUMENT_REQUEST_FRAME_BYTES,
  DOCUMENT_RESULT_FRAME_BYTES,
  parseDocumentTextRequestFrame,
  parseDocumentTextResultFrame,
  serializeDocumentTextRequest,
  serializeDocumentTextResult
} from './documentWorkerWire'
import { DOCUMENT_TEXT_PROTOCOL } from './documentSchema'

const JOB_ID = '0123456789abcdef0123456789abcdef'
const OTHER_JOB_ID = 'fedcba9876543210fedcba9876543210'
const formats = ['pdf', 'docx', 'xlsx', 'pptx'] as const

type Format = (typeof formats)[number]

function syntheticBytes(format: Format, length = 16): Uint8Array {
  const bytes = new Uint8Array(length)
  if (format === 'pdf') {
    bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d])
  } else {
    bytes.set([0x50, 0x4b, 0x03, 0x04])
  }
  for (let index = 5; index < bytes.length; index += 1) bytes[index] = index & 0xff
  return bytes
}

function request(format: Format, bytes = syntheticBytes(format)) {
  return {
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId: JOB_ID,
    format,
    bytes
  }
}

function success(text = 'worker text', format: Format = 'pdf') {
  return {
    protocol: DOCUMENT_TEXT_PROTOCOL,
    jobId: JOB_ID,
    ok: true as const,
    format,
    segments: [
      {
        text,
        locator:
          format === 'pdf'
            ? { kind: 'pdf-item' as const, page: 1, item: 0 }
            : format === 'docx'
              ? {
                  kind: 'docx-paragraph' as const,
                  part: 'word/document.xml' as const,
                  paragraph: 0
                }
              : format === 'xlsx'
                ? { kind: 'xlsx-cell' as const, sheet: 1, cell: 'A1' }
                : { kind: 'pptx-shape' as const, slide: 1, shape: 0, paragraph: 0 }
      }
    ],
    truncated: false,
    warnings: [] as const
  }
}

function expectInvalid(value: unknown): void {
  expect(value).toEqual({ ok: false, code: 'INVALID' })
}

function expectLimit(value: unknown): void {
  expect(value).toEqual({ ok: false, code: 'LIMIT' })
}

describe('document worker raw-string request wire', () => {
  it('round-trips all four schema formats with synthetic magic bytes', () => {
    for (const format of formats) {
      const frame = serializeDocumentTextRequest(request(format))
      const parsed = parseDocumentTextRequestFrame(frame)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.request.protocol).toBe(DOCUMENT_TEXT_PROTOCOL)
      expect(parsed.request.jobId).toBe(JOB_ID)
      expect(parsed.request.format).toBe(format)
      expect(Array.from(parsed.request.bytes)).toEqual(Array.from(syntheticBytes(format)))
    }
  })

  it('copies aliased input bytes before encoding and returns an ordinary detached Uint8Array', () => {
    const backing = new Uint8Array([0, 0x25, 0x50, 0x44, 0x46, 0x2d, 0x33, 0x44])
    const aliased = backing.subarray(1)
    const frame = serializeDocumentTextRequest(request('pdf', aliased))
    backing.fill(0)
    const parsed = parseDocumentTextRequestFrame(frame)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.request.bytes).not.toBe(aliased)
    expect(Object.getPrototypeOf(parsed.request.bytes)).toBe(Uint8Array.prototype)
    expect(Array.from(parsed.request.bytes)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0x33, 0x44])
  })

  it('accepts an actual one MiB payload and enforces the exact decoded and frame budgets', () => {
    const bytes = syntheticBytes('pdf', DOCUMENT_REQUEST_DECODED_BYTES)
    const frame = serializeDocumentTextRequest(request('pdf', bytes))
    expect(Buffer.byteLength(frame, 'utf8')).toBeLessThanOrEqual(DOCUMENT_REQUEST_FRAME_BYTES)
    expect(frame).toContain(`"bytes":"${Buffer.from(bytes).toString('base64')}"`)
    const parsed = parseDocumentTextRequestFrame(frame)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.request.bytes.byteLength).toBe(DOCUMENT_REQUEST_DECODED_BYTES)

    const tooLarge = syntheticBytes('pdf', DOCUMENT_REQUEST_DECODED_BYTES + 1)
    expect(() => serializeDocumentTextRequest(request('pdf', tooLarge))).toThrow(
      'Document worker wire limit exceeded'
    )
    const oversizedFrame = JSON.stringify({
      protocol: DOCUMENT_TEXT_PROTOCOL,
      jobId: JOB_ID,
      format: 'pdf',
      bytes: Buffer.from(tooLarge).toString('base64')
    })
    expectLimit(parseDocumentTextRequestFrame(oversizedFrame))
  })

  it('rejects noncanonical alphabet, padding, NUL, newline, and trailing base64 data', () => {
    const valid = Buffer.from(syntheticBytes('pdf')).toString('base64')
    const badValues = [
      valid.slice(0, -1),
      `${valid.slice(0, -1)}$`,
      `${valid}\u0000`,
      `${valid}\n`,
      `${valid}A`
    ]
    for (const bytes of badValues) {
      const frame = JSON.stringify({
        protocol: DOCUMENT_TEXT_PROTOCOL,
        jobId: JOB_ID,
        format: 'pdf',
        bytes
      })
      expectInvalid(parseDocumentTextRequestFrame(frame))
    }
    expect(DOCUMENT_REQUEST_BASE64_CHARS).toBe(1_398_104)
  })

  it('rejects duplicate keys, whitespace, reordered keys, escaped keys, and trailing input', () => {
    const frame = serializeDocumentTextRequest(request('pdf'))
    expectInvalid(parseDocumentTextRequestFrame(`${frame}\n`))
    expectInvalid(parseDocumentTextRequestFrame(frame.replace('{', '{ ')))
    expectInvalid(
      parseDocumentTextRequestFrame(
        `{"jobId":"${JOB_ID}","protocol":"${DOCUMENT_TEXT_PROTOCOL}","format":"pdf","bytes":"${Buffer.from(syntheticBytes('pdf')).toString('base64')}"}`
      )
    )
    expectInvalid(parseDocumentTextRequestFrame(frame.replace('"protocol"', '\\u0070rotocol')))
    const duplicate = frame.replace('"bytes":', '"bytes":"JVBERi0zNDU2Nzg5","bytes":')
    expectInvalid(parseDocumentTextRequestFrame(duplicate))
  })

  it('rejects unsupported authority-like keys, protocol values, and newline-bearing job ids', () => {
    const base = {
      protocol: DOCUMENT_TEXT_PROTOCOL,
      jobId: JOB_ID,
      format: 'pdf',
      bytes: Buffer.from(syntheticBytes('pdf')).toString('base64')
    }
    for (const key of ['path', 'args', 'password', 'grantPolicy', 'filename']) {
      expectInvalid(parseDocumentTextRequestFrame(JSON.stringify({ ...base, [key]: 'secret' })))
    }
    expectInvalid(parseDocumentTextRequestFrame(JSON.stringify({ ...base, protocol: 'other/v1' })))
    expectInvalid(
      parseDocumentTextRequestFrame(JSON.stringify({ ...base, jobId: `${JOB_ID.slice(0, 31)}\n` }))
    )
  })

  it('does not coerce raw objects, invoke proxy traps, or invoke throwing request getters', () => {
    let trapCalls = 0
    const proxied = new Proxy(request('pdf'), {
      get() {
        trapCalls += 1
        throw new Error('proxy get')
      },
      getPrototypeOf() {
        trapCalls += 1
        throw new Error('proxy prototype')
      },
      ownKeys() {
        trapCalls += 1
        throw new Error('proxy keys')
      }
    })
    expect(() => serializeDocumentTextRequest(proxied)).toThrow(
      'Invalid document worker wire value'
    )
    expect(trapCalls).toBe(0)

    let getterCalls = 0
    const withGetter = request('pdf') as Record<string, unknown>
    Object.defineProperty(withGetter, 'bytes', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('bytes getter')
      }
    })
    expect(() => serializeDocumentTextRequest(withGetter)).toThrow(
      'Invalid document worker wire value'
    )
    expect(getterCalls).toBe(0)

    const rawObject = {
      toString() {
        trapCalls += 1
        throw new Error('coercion')
      }
    }
    expectInvalid(parseDocumentTextRequestFrame(rawObject))
    expect(trapCalls).toBe(0)
  })
})

describe('document worker raw-string result wire', () => {
  it('serializes and parses a canonical success result with exact correlation', () => {
    const frame = serializeDocumentTextResult(success(), JOB_ID, 'pdf')
    expect(frame).toBe(JSON.stringify(success()))
    const parsed = parseDocumentTextResultFrame(frame, JOB_ID, 'pdf')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.result.ok).toBe(true)
      expect(parsed.result.jobId).toBe(JOB_ID)
      expect(parsed.result.format).toBe('pdf')
    }
  })

  it('measures generated escaped JSON at the exact 64 KiB frame boundary', () => {
    const escapedPrefix = '"\\\n'
    const prefixFrame = serializeDocumentTextResult(success(escapedPrefix), JOB_ID, 'pdf')
    const remaining = DOCUMENT_RESULT_FRAME_BYTES - Buffer.byteLength(prefixFrame, 'utf8')
    expect(remaining).toBeGreaterThan(0)
    const text = `${escapedPrefix}${'a'.repeat(remaining)}`
    const frame = serializeDocumentTextResult(success(text), JOB_ID, 'pdf')
    expect(Buffer.byteLength(frame, 'utf8')).toBe(DOCUMENT_RESULT_FRAME_BYTES)
    const parsed = parseDocumentTextResultFrame(frame, JOB_ID, 'pdf')
    expect(parsed.ok).toBe(true)

    expect(() => serializeDocumentTextResult(success(`${text}a`), JOB_ID, 'pdf')).toThrow(
      'Document worker wire limit exceeded'
    )
    expectLimit(parseDocumentTextResultFrame(`${frame}a`, JOB_ID, 'pdf'))
  })

  it('requires format on every failure and binds failure format to expected correlation', () => {
    const failure = {
      protocol: DOCUMENT_TEXT_PROTOCOL,
      jobId: JOB_ID,
      ok: false as const,
      format: 'pdf' as const,
      code: 'LIMIT' as const
    }
    const frame = serializeDocumentTextResult(failure, JOB_ID, 'pdf')
    expect(frame).toBe(JSON.stringify(failure))
    const parsed = parseDocumentTextResultFrame(frame, JOB_ID, 'pdf')
    expect(parsed).toEqual({ ok: true, result: failure })
    expect(() => serializeDocumentTextResult(failure, JOB_ID, 'docx')).toThrow(
      'Invalid document worker wire value'
    )
    expectInvalid(parseDocumentTextResultFrame(frame, JOB_ID, 'docx'))
    expectInvalid(
      parseDocumentTextResultFrame(JSON.stringify({ ...failure, format: 'docx' }), JOB_ID, 'pdf')
    )
  })

  it('rejects partial, extra, secret-bearing, and unknown failure fields without leaking them', () => {
    const partial = {
      protocol: DOCUMENT_TEXT_PROTOCOL,
      jobId: JOB_ID,
      ok: false,
      code: 'INVALID'
    }
    expect(() => serializeDocumentTextResult(partial, JOB_ID, 'pdf')).toThrow(
      'Invalid document worker wire value'
    )
    const malicious = {
      protocol: DOCUMENT_TEXT_PROTOCOL,
      jobId: JOB_ID,
      ok: false,
      format: 'pdf',
      code: 'EXECUTION_FAILED',
      stack: 'raw-secret-stack',
      filename: 'private.docx'
    }
    try {
      serializeDocumentTextResult(malicious, JOB_ID, 'pdf')
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID' })
      expect(error).not.toMatchObject({ message: expect.stringContaining('raw-secret-stack') })
    }
    expectInvalid(parseDocumentTextResultFrame(JSON.stringify(malicious), JOB_ID, 'pdf'))
  })

  it('rejects result duplicate keys, noncanonical whitespace/order, malformed JSON, and unknown keys', () => {
    const frame = serializeDocumentTextResult(success(), JOB_ID, 'pdf')
    expectInvalid(parseDocumentTextResultFrame(`${frame} `, JOB_ID, 'pdf'))
    expectInvalid(parseDocumentTextResultFrame(frame.replace('{', '{ '), JOB_ID, 'pdf'))
    expectInvalid(
      parseDocumentTextResultFrame(
        `{"jobId":"${JOB_ID}","protocol":"${DOCUMENT_TEXT_PROTOCOL}","ok":true,"format":"pdf","segments":[],"truncated":false,"warnings":[]}`,
        JOB_ID,
        'pdf'
      )
    )
    expectInvalid(
      parseDocumentTextResultFrame(frame.replace('"ok":true', '"ok":true,"ok":true'), JOB_ID, 'pdf')
    )
    expectInvalid(
      parseDocumentTextResultFrame(`${frame.slice(0, -1)},"stack":"secret"}`, JOB_ID, 'pdf')
    )
    expectInvalid(parseDocumentTextResultFrame('{"secret":"do not report', JOB_ID, 'pdf'))
  })

  it('never grants a mismatched job, including failure results', () => {
    const successFrame = serializeDocumentTextResult(success(), JOB_ID, 'pdf')
    const failureFrame = serializeDocumentTextResult(
      {
        protocol: DOCUMENT_TEXT_PROTOCOL,
        jobId: JOB_ID,
        ok: false,
        format: 'pdf',
        code: 'CANCELLED'
      },
      JOB_ID,
      'pdf'
    )
    expectInvalid(parseDocumentTextResultFrame(successFrame, OTHER_JOB_ID, 'pdf'))
    expectInvalid(parseDocumentTextResultFrame(failureFrame, OTHER_JOB_ID, 'pdf'))
  })

  it('does not invoke a throwing result getter or proxy while rejecting it', () => {
    let getterCalls = 0
    const withGetter = {
      get ok() {
        getterCalls += 1
        throw new Error('result getter')
      }
    }
    expect(() => serializeDocumentTextResult(withGetter, JOB_ID, 'pdf')).toThrow(
      'Invalid document worker wire value'
    )
    expect(getterCalls).toBe(0)

    let trapCalls = 0
    const proxied = new Proxy(success(), {
      get() {
        trapCalls += 1
        throw new Error('result proxy get')
      },
      getPrototypeOf() {
        trapCalls += 1
        throw new Error('result proxy prototype')
      }
    })
    expect(() => serializeDocumentTextResult(proxied, JOB_ID, 'pdf')).toThrow(
      'Invalid document worker wire value'
    )
    expect(trapCalls).toBe(0)
  })
})
