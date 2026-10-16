import { describe, expect, it } from 'vitest'
import {
  readLocalFileResponseSchema,
  type ReadLocalFileResponse
} from '@shared/api/svcAgentLocalFiles'
import { appendLocalFileToDraft } from './localFileDraft'

const spreadsheet = (cell: string): ReadLocalFileResponse => ({
  name: 'owned.xlsx',
  relativePath: '',
  content: 'WORKSHEET-UNIQUE',
  encoding: 'utf-8',
  sizeBytes: 2048,
  returnedBytes: 16,
  truncated: false,
  document: {
    format: 'xlsx',
    sourceSha256: 'c'.repeat(64),
    warnings: [],
    segments: [{ text: 'WORKSHEET-UNIQUE', locator: { kind: 'xlsx-cell', sheet: 2, cell } }]
  }
})

describe('XLSX source locations at the response and draft boundary', () => {
  it.each(['A1', 'Z1048576', 'AA1', 'XFC1048576', 'XFD1048576'])(
    'preserves valid cell %s without changing text or provenance',
    (cell) => {
      const file = spreadsheet(cell)
      expect(readLocalFileResponseSchema.parse(file)).toEqual(file)
      const draft = appendLocalFileToDraft('Summarize the worksheet', file)!
      expect(draft).not.toBeNull()
      const reference = JSON.parse(draft.slice(draft.indexOf('{')))
      expect(reference).toMatchObject({
        text: file.content,
        sourceSha256: file.document!.sourceSha256,
        segments: [{ text: file.content, locator: { kind: 'xlsx-cell', sheet: 2, cell } }]
      })
      expect(draft).not.toMatch(/grantId|senderId|absolutePath/)
    }
  )

  it.each(['XFE1', 'A1048577', 'ZZZ1', 'XFD9999999', 'A0', 'a1', 'A01', 'A1\n'])(
    'rejects impossible or malformed cell %j instead of attaching a misleading source location',
    (cell) => {
      const file = spreadsheet(cell)
      expect(readLocalFileResponseSchema.safeParse(file).success).toBe(false)
      expect(appendLocalFileToDraft('Keep my existing draft', file)).toBeNull()
    }
  )
})
