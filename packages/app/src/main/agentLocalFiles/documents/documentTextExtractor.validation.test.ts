import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DOCUMENT_TEXT_LIMITS,
  DOCUMENT_TEXT_PROTOCOL,
  checkDocumentTextResult
} from './documentSchema'

const parsers = vi.hoisted(() => ({ pdf: vi.fn(), office: vi.fn() }))
vi.mock('./pdfTextExtractor', () => ({ extractPdfText: parsers.pdf }))
vi.mock('./ooxmlTextExtractor', () => ({ extractOoxmlText: parsers.office }))
import { extractDocumentText } from './documentTextExtractor'

const JOB = '0123456789abcdef0123456789abcdef'
const success = () => ({
  protocol: DOCUMENT_TEXT_PROTOCOL,
  jobId: JOB,
  format: 'pdf',
  ok: true,
  segments: [{ text: '正文🙂', locator: { kind: 'pdf-item', page: 1, item: 0 } }],
  truncated: false,
  warnings: ['reading-order-unverified']
})
const request = (format = 'pdf') => ({
  protocol: DOCUMENT_TEXT_PROTOCOL,
  jobId: JOB,
  format,
  bytes: new Uint8Array(format === 'pdf' ? Buffer.from('%PDF-1.7') : [0x50, 0x4b, 3, 4])
})
const failure = (code: string, format = 'pdf') => ({
  protocol: DOCUMENT_TEXT_PROTOCOL,
  jobId: JOB,
  format,
  ok: false,
  code
})

afterEach(() => vi.resetAllMocks())

describe('dispatch boundary with explicit parser-contract adapters, not real parsing', () => {
  it('passes only detached ingress and the separate trusted runtime to the PDF parser', async () => {
    const value = request()
    const runtime = undefined
    const output = success()
    parsers.pdf.mockResolvedValue(output)
    const result = await extractDocumentText(value, {}, runtime)
    expect(parsers.pdf).toHaveBeenCalledTimes(1)
    expect(parsers.pdf).toHaveBeenCalledWith(value.bytes, JOB, {}, runtime)
    const bytes = parsers.pdf.mock.calls[0][0]
    expect(bytes).not.toBe(value.bytes)
    value.bytes.fill(0)
    expect(Buffer.from(bytes).toString()).toBe('%PDF-1.7')
    expect(result).toEqual(success())
    expect(result).not.toBe(output)
    expect(parsers.office).not.toHaveBeenCalled()
  })

  it('does not call a parser or inspect options/runtime on invalid ingress', async () => {
    const hook = vi.fn(() => {
      throw new Error('caller hook')
    })
    const options = Object.defineProperty({}, 'signal', { get: hook, enumerable: true })
    await expect(extractDocumentText({}, options)).resolves.toEqual({
      ok: false,
      code: 'INVALID'
    })
    expect(hook).not.toHaveBeenCalled()
    expect(parsers.pdf).not.toHaveBeenCalled()
    expect(parsers.office).not.toHaveBeenCalled()
  })

  it.each(['docx', 'xlsx', 'pptx'])(
    'does not route %s to the PDF runtime or derive package order itself',
    async (format) => {
      parsers.office.mockResolvedValue(failure('NO_TEXT', format))
      const value = request(format)
      const result = await extractDocumentText(value)
      expect(parsers.office).toHaveBeenCalledWith(value.bytes, JOB, format, {})
      expect(parsers.pdf).not.toHaveBeenCalled()
      expect(result).toStrictEqual(failure('NO_TEXT', format))
    }
  )

  it.each([
    { ...success(), jobId: 'f'.repeat(32) },
    { ...success(), format: 'docx' },
    {
      ...success(),
      segments: [{ text: 'text', locator: { kind: 'pdf-item', page: 0, item: 0 } }]
    },
    { ...success(), path: '/fixture-data/document.pdf' },
    { ...success(), warnings: ['output-truncated'] },
    {
      ...success(),
      segments: [{ text: '\ud800', locator: { kind: 'pdf-item', page: 1, item: 0 } }]
    },
    { ok: false, code: 'LIMIT' },
    null
  ])('post-validates malformed parser outputs without partial success %#', async (output) => {
    parsers.pdf.mockResolvedValue(output)
    const result = await extractDocumentText(request())
    expect(result).toStrictEqual(failure('INVALID'))
    expect(checkDocumentTextResult(result, JOB, 'pdf').ok).toBe(true)
  })

  it('bounds the full escaped JSON output and all locator metadata, not just text length', async () => {
    const output = success()
    output.segments[0].text = '\u0000'.repeat(
      Math.floor(DOCUMENT_TEXT_LIMITS.envelopeBytes / 6) + 1
    )
    expect(output.segments[0].text.length).toBeLessThan(DOCUMENT_TEXT_LIMITS.envelopeBytes)
    parsers.pdf.mockResolvedValue(output)
    const result = await extractDocumentText(request())
    expect(result).toStrictEqual(failure('LIMIT'))
    expect(JSON.stringify(result)).not.toContain('\u0000')
  })

  it('post-validation rejects Proxy/accessor/toJSON output without invoking validation hooks', async () => {
    const hook = vi.fn(() => {
      throw new Error('private output hook')
    })
    const proxy = new Proxy(success(), {
      // Trusted async parser delivery necessarily assimilates `then` before dispatch
      // can validate. Permit only that operation; the validator must not read fields.
      get: (_target, key) => {
        if (key === 'then') return undefined
        return hook()
      },
      getPrototypeOf: hook,
      ownKeys: hook,
      getOwnPropertyDescriptor: hook
    })
    // This is a parser-contract test, not a sandbox against malicious parser code.
    for (const output of [
      proxy,
      Object.defineProperty(success(), 'segments', { get: hook, enumerable: true }),
      { ...success(), toJSON: hook }
    ]) {
      parsers.pdf.mockResolvedValue(output)
      const result = await extractDocumentText(request())
      expect(result).toStrictEqual(failure('INVALID'))
    }
    expect(hook).not.toHaveBeenCalled()
  })

  it('reduces thrown/rejected exceptions to a fixed failure without reading diagnostics', async () => {
    const hook = vi.fn(() => {
      throw new Error('private exception property')
    })
    const error = Object.defineProperties(
      {},
      { message: { get: hook }, stack: { get: hook }, cause: { get: hook }, name: { get: hook } }
    )
    for (const parser of [
      () => {
        throw error
      },
      () => Promise.reject(error)
    ]) {
      parsers.pdf.mockImplementation(parser)
      const result = await extractDocumentText(request())
      expect(result).toStrictEqual(failure('EXECUTION_FAILED'))
      expect(JSON.stringify(result)).not.toContain('private')
    }
    expect(hook).not.toHaveBeenCalled()
  })

  it.each(['NO_TEXT', 'UNSUPPORTED', 'LIMIT', 'CANCELLED', 'TIMEOUT', 'EXECUTION_FAILED'])(
    'preserves a valid correlated %s failure',
    async (code) => {
      parsers.pdf.mockResolvedValue(failure(code))
      expect(await extractDocumentText(request())).toStrictEqual(failure(code))
    }
  )
})
