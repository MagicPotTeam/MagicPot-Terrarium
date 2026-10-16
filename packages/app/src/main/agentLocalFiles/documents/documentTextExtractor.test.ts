import { describe, expect, it, vi } from 'vitest'
import {
  DOCUMENT_TEXT_LIMITS,
  DOCUMENT_TEXT_PROTOCOL,
  checkDocumentTextResult,
  type DocumentTextFormat
} from './documentSchema'
import { extractDocumentText } from './documentTextExtractor'
import { makeZip } from './__fixtures__/documentFixtures'

const JOB_ID = '0123456789abcdef0123456789abcdef'
const PDF_BYTES = new Uint8Array(Buffer.from('%PDF-1.7\n(decoy) Tj'))
const request = (format: DocumentTextFormat = 'pdf', bytes: Uint8Array = PDF_BYTES) => ({
  protocol: DOCUMENT_TEXT_PROTOCOL,
  jobId: JOB_ID,
  format,
  bytes
})

function docx(text: string): Uint8Array {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    },
    {
      name: '_rels/.rels',
      data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    },
    {
      name: 'word/document.xml',
      data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      compression: 'deflate'
    }
  ])
}

describe('bytes-only document dispatch', () => {
  it.each(['format', 'jobId', 'bytes', 'protocol'])(
    'does not execute a request %s getter or echo partial correlation',
    async (key) => {
      const hook = vi.fn(() => {
        throw new Error('private getter must never run')
      })
      const value = Object.defineProperty(request(), key, { get: hook, enumerable: true })
      await expect(extractDocumentText(value)).resolves.toEqual({ ok: false, code: 'INVALID' })
      expect(hook).not.toHaveBeenCalled()
    }
  )

  it('rejects proxies (including revoked proxies) without traps', async () => {
    const hook = vi.fn(() => {
      throw new Error('private trap must never run')
    })
    const value = new Proxy(request(), {
      get: hook,
      has: hook,
      ownKeys: hook,
      getPrototypeOf: hook,
      getOwnPropertyDescriptor: hook
    })
    await expect(extractDocumentText(value)).resolves.toEqual({ ok: false, code: 'INVALID' })
    const revoked = Proxy.revocable(request(), {})
    revoked.revoke()
    await expect(extractDocumentText(revoked.proxy)).resolves.toEqual({
      ok: false,
      code: 'INVALID'
    })
    expect(hook).not.toHaveBeenCalled()
  })

  it.each([
    null,
    undefined,
    [],
    Object.create(request()),
    { ...request(), path: '/fixture-data/document.pdf' },
    { ...request(), runtime: {} },
    { ...request(), jobId: `${JOB_ID}\n` },
    { ...request(), jobId: 'private-secret'.repeat(10000) },
    { ...request(), format: 'private-unknown-format' },
    { ...request(), bytes: Buffer.from('not a document') }
  ])('returns only a short validation failure for malformed ingress %#', async (value) => {
    await expect(extractDocumentText(value)).resolves.toEqual({ ok: false, code: 'INVALID' })
  })

  it('preserves the input LIMIT code instead of relabeling it INVALID', async () => {
    const bytes = new Uint8Array(DOCUMENT_TEXT_LIMITS.inputBytes + 1)
    bytes.set(PDF_BYTES)
    await expect(extractDocumentText(request('pdf', bytes))).resolves.toEqual({
      ok: false,
      code: 'LIMIT'
    })
  })

  it('does not coerce an object-valued job or format, including then and toJSON hooks', async () => {
    const hook = vi.fn(() => {
      throw new Error('must not coerce')
    })
    const hostile = Object.defineProperties(
      {},
      { then: { get: hook }, toJSON: { get: hook }, [Symbol.toPrimitive]: { get: hook } }
    )
    for (const key of ['jobId', 'format']) {
      await expect(extractDocumentText({ ...request(), [key]: hostile })).resolves.toEqual({
        ok: false,
        code: 'INVALID'
      })
    }
    expect(hook).not.toHaveBeenCalled()
  })

  it('copies intrinsic byte views without caller buffer/length/iterator hooks', async () => {
    const bytes = new Uint8Array(PDF_BYTES)
    const hook = vi.fn(() => {
      throw new Error('must not call')
    })
    for (const key of ['buffer', 'byteLength', 'byteOffset', Symbol.iterator])
      Object.defineProperty(bytes, key, { get: hook })
    const result = await extractDocumentText(request('pdf', bytes))
    expect(result).toStrictEqual({
      protocol: DOCUMENT_TEXT_PROTOCOL,
      jobId: JOB_ID,
      format: 'pdf',
      ok: false,
      code: 'EXECUTION_FAILED'
    })
    expect(hook).not.toHaveBeenCalled()
  })

  it('does not pretend to parse PDFs when a trusted runtime is absent', async () => {
    const result = await extractDocumentText(request())
    expect(result).toEqual({
      protocol: DOCUMENT_TEXT_PROTOCOL,
      jobId: JOB_ID,
      format: 'pdf',
      ok: false,
      code: 'EXECUTION_FAILED'
    })
    expect(checkDocumentTextResult(result, JOB_ID, 'pdf').ok).toBe(true)
  })

  it('routes real owned DOCX bytes and validates the returned correlation and envelope', async () => {
    const result = await extractDocumentText(request('docx', docx('本地🙂 &amp; text')))
    expect(result).toMatchObject({
      ok: true,
      jobId: JOB_ID,
      format: 'docx',
      segments: [
        {
          text: '本地🙂 & text',
          locator: { kind: 'docx-paragraph', part: 'word/document.xml', paragraph: 0 }
        }
      ]
    })
    expect(checkDocumentTextResult(result, JOB_ID, 'docx').ok).toBe(true)
  })

  it('rejects wrong package format without reinterpreting it as plain text', async () => {
    const result = await extractDocumentText(request('xlsx', docx('not a worksheet')))
    expect(result).toMatchObject({ ok: false, format: 'xlsx' })
    expect(checkDocumentTextResult(result, JOB_ID, 'xlsx').ok).toBe(true)
  })

  it('handles cancellation and does not inspect options until ingress is valid', async () => {
    const hook = vi.fn(() => {
      throw new Error('option accessor')
    })
    const options = Object.defineProperty({}, 'signal', { get: hook, enumerable: true })
    await expect(extractDocumentText(null, options)).resolves.toEqual({
      ok: false,
      code: 'INVALID'
    })
    const controller = new AbortController()
    controller.abort()
    for (const value of [request(), request('docx', docx('cancelled'))]) {
      const result = await extractDocumentText(value, { signal: controller.signal })
      expect(result).toMatchObject({ ok: false, code: 'CANCELLED' })
      expect(checkDocumentTextResult(result, JOB_ID, value.format).ok).toBe(true)
    }
    expect(hook).not.toHaveBeenCalled()
  })
})
